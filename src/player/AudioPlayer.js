// Machine à états qui pilote la lecture (pattern State) et émet les événements
// auxquels s'abonne l'UI (pattern Observer).
//
// Deux chemins de rendu selon le mode du moteur :
//  - SPEAK      : segment par segment via engine.speak(). Le pause/resume natif de
//                 speechSynthesis étant instable, "pause" = on n'enchaîne pas sur
//                 le segment suivant, "resume" = on repart au même index.
//  - SYNTHESIZE : tous les segments sont pré-générés puis concaténés en un seul
//                 fichier audio joué par <audio>. Pré-générer entièrement est
//                 imposé par Android : le JS est gelé écran éteint, donc rien ne
//                 doit dépendre du JS une fois la lecture lancée.
import { ENGINE_MODE } from "../tts/TTSEngine.js";
import { encodeWav, silence } from "../lib/wav.js";
import {
  bindMediaSession,
  setMediaSessionMetadata,
  setMediaSessionPlaybackState,
  setMediaSessionPosition,
} from "./mediaSession.js";

const STATES = Object.freeze({
  IDLE: "idle",
  GENERATING: "generating",
  PLAYING: "playing",
  PAUSED: "paused",
  ENDED: "ended",
});

const ALLOWED_TRANSITIONS = {
  [STATES.IDLE]: [STATES.GENERATING, STATES.PLAYING],
  [STATES.GENERATING]: [STATES.PLAYING, STATES.IDLE],
  [STATES.PLAYING]: [STATES.PAUSED, STATES.ENDED, STATES.IDLE],
  [STATES.PAUSED]: [STATES.PLAYING, STATES.IDLE],
  [STATES.ENDED]: [STATES.GENERATING, STATES.PLAYING, STATES.IDLE],
};

const GAP_AFTER_HEADING = 0.5;
const GAP_AFTER_BLOCK = 0.35;
const GAP_AFTER_SENTENCE = 0.12;
const SEEK_STEP = 10;

export class AudioPlayer {
  #engine;
  #segments = [];
  #index = 0;
  #state = STATES.IDLE;
  #listeners = new Set();
  #options = {};

  #audio = null;
  #objectUrl = null;
  #bounds = [];
  #generationToken = 0;
  #lastEmittedSecond = -1;

  constructor(engine) {
    this.#engine = engine;
  }

  static get STATES() {
    return STATES;
  }

  get state() {
    return this.#state;
  }

  get index() {
    return this.#index;
  }

  get total() {
    return this.#segments.length;
  }

  /** Remplace le moteur courant : tout audio déjà généré devient caduc. */
  setEngine(engine) {
    if (engine === this.#engine) return;
    this.stop();
    this.#engine = engine;
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Charge de nouveaux segments et remet le lecteur à zéro. */
  load(segments, options = {}) {
    this.stop();
    this.#segments = segments;
    this.#options = options;
    setMediaSessionMetadata({ title: options.title });
  }

  async play() {
    if (this.#segments.length === 0) return;
    // Déjà en cours : un second appel (double-clic, commande média) ne doit pas
    // relancer une génération par-dessus celle qui tourne.
    if (this.#state === STATES.PLAYING || this.#state === STATES.GENERATING) return;
    if (this.#state === STATES.ENDED) this.#index = 0; // relecture depuis le début

    if (this.#engine.mode === ENGINE_MODE.SPEAK) {
      this.#setState(STATES.PLAYING);
      this.#speakCurrentSegment();
      return;
    }

    // Audio déjà généré (relecture après la fin) : on rejoue depuis le début.
    if (this.#objectUrl) {
      this.#setState(STATES.PLAYING);
      await this.#startAudioElement(0);
      return;
    }

    const token = ++this.#generationToken;
    this.#setState(STATES.GENERATING);

    try {
      const { blob, bounds } = await this.#generateAll(token);
      if (token !== this.#generationToken) return; // stop() est passé entre-temps

      this.#bounds = bounds;
      this.#attachAudio(blob);
      this.#setState(STATES.PLAYING);
      await this.#startAudioElement(0);
    } catch (error) {
      if (token !== this.#generationToken) return;
      this.#emit("error", { message: String(error?.message ?? error) });
      this.#setState(STATES.IDLE);
    }
  }

  pause() {
    if (this.#state !== STATES.PLAYING) return;

    if (this.#isSynthesizeMode) this.#audio?.pause();
    else this.#engine.stop();

    this.#setState(STATES.PAUSED);
    setMediaSessionPlaybackState("paused");
  }

  resume() {
    if (this.#state !== STATES.PAUSED) return;
    this.#setState(STATES.PLAYING);
    setMediaSessionPlaybackState("playing");

    if (this.#isSynthesizeMode) this.#audio?.play().catch((error) => this.#onPlaybackRejected(error));
    else this.#speakCurrentSegment();
  }

  stop() {
    this.#generationToken += 1; // annule une génération en cours
    this.#engine.stop();

    if (this.#audio) {
      this.#audio.pause();
      this.#audio.removeAttribute("src");
      this.#audio.load();
    }
    this.#releaseObjectUrl();
    this.#bounds = [];
    this.#index = 0;
    this.#lastEmittedSecond = -1;
    setMediaSessionPlaybackState("none");

    if (this.#state !== STATES.IDLE) this.#setState(STATES.IDLE);
  }

  /** Saute au début du bloc (paragraphe) situé `delta` blocs plus loin. */
  skipBlock(delta) {
    if (!this.#isSynthesizeMode || this.#bounds.length === 0) return;

    const currentBlock = this.#segments[this.#index]?.blockIndex ?? 0;
    const targetBlock = currentBlock + delta;
    const target = this.#segments.findIndex((segment) => segment.blockIndex === targetBlock);
    if (target === -1) return;

    this.#seekTo(this.#bounds[target].start);
  }

  seekBy(seconds) {
    if (!this.#isSynthesizeMode || !this.#audio) return;
    this.#seekTo(this.#audio.currentTime + seconds);
  }

  get #isSynthesizeMode() {
    return this.#engine.mode === ENGINE_MODE.SYNTHESIZE;
  }

  // --- Mode SPEAK ---------------------------------------------------------

  #speakCurrentSegment() {
    const segment = this.#segments[this.#index];
    if (!segment) {
      this.#setState(STATES.ENDED);
      return;
    }

    this.#emit("segment-start", {
      index: this.#index,
      total: this.#segments.length,
      text: segment.text,
    });

    this.#engine.speak(segment.text, {
      lang: this.#options.lang,
      onEnd: () => {
        // Si pause()/stop() est passé entre-temps, on ne doit pas enchaîner.
        if (this.#state !== STATES.PLAYING) return;
        this.#index += 1;
        this.#speakCurrentSegment();
      },
      onError: (error) => {
        if (this.#state !== STATES.PLAYING) return; // annulation volontaire
        this.#emit("error", { message: String(error) });
      },
    });
  }

  // --- Mode SYNTHESIZE ----------------------------------------------------

  async #generateAll(token) {
    const chunks = [];
    const bounds = [];
    let sampleRate = 24000;
    let cursor = 0; // position courante, en échantillons

    // Le temps de génération suit la quantité de texte : on estime le reste à
    // partir du coût par caractère déjà observé, les segments ayant des
    // longueurs très inégales.
    const charsTotal = this.#segments.reduce((n, s) => n + s.text.length, 0);
    let charsDone = 0;
    let elapsed = 0; // secondes passées à synthétiser
    let audioSeconds = 0; // secondes d'audio produites, hors silences ajoutés

    for (const [i, segment] of this.#segments.entries()) {
      const startedAt = performance.now();
      const result = await this.#engine.synthesize(segment.text, {
        lang: this.#options.lang,
        voice: this.#options.voice,
      });
      elapsed += (performance.now() - startedAt) / 1000;
      if (token !== this.#generationToken) throw new Error("Génération annulée.");

      sampleRate = result.sampleRate;
      const start = cursor;
      chunks.push(result.samples);
      cursor += result.samples.length;
      bounds.push({ start: start / sampleRate, end: cursor / sampleRate });

      const gap = silence(this.#gapAfter(i), sampleRate);
      chunks.push(gap);
      cursor += gap.length;

      charsDone += segment.text.length;
      audioSeconds += result.samples.length / sampleRate;

      this.#emit("generation-progress", {
        done: i + 1,
        total: this.#segments.length,
        elapsed,
        rtf: audioSeconds > 0 ? elapsed / audioSeconds : 0,
        remainingSeconds: charsDone > 0 ? (elapsed / charsDone) * (charsTotal - charsDone) : 0,
      });
    }

    // RTF < 1 signifie que la synthèse va plus vite que la lecture : c'est la
    // condition qui rendrait une génération au fil de l'eau possible.
    this.#emit("generation-done", {
      elapsed,
      audioSeconds,
      rtf: audioSeconds > 0 ? elapsed / audioSeconds : 0,
    });

    return { blob: encodeWav(chunks, sampleRate), bounds };
  }

  /** Respiration après un segment, selon qu'il termine un titre, un bloc ou une phrase. */
  #gapAfter(index) {
    const segment = this.#segments[index];
    const next = this.#segments[index + 1];
    if (segment.isHeading) return GAP_AFTER_HEADING;
    if (!next || next.blockIndex !== segment.blockIndex) return GAP_AFTER_BLOCK;
    return GAP_AFTER_SENTENCE;
  }

  #attachAudio(blob) {
    this.#releaseObjectUrl();
    this.#objectUrl = URL.createObjectURL(blob);
    this.#ensureAudioElement().src = this.#objectUrl;
  }

  #ensureAudioElement() {
    if (this.#audio) return this.#audio;

    const audio = new Audio();
    audio.preload = "auto";
    // Attaché au document : Firefox tient alors mieux compte de l'élément pour
    // la session média (et donc les contrôles système).
    document.body?.append(audio);

    audio.addEventListener("timeupdate", () => this.#onTimeUpdate());
    audio.addEventListener("ended", () => {
      if (this.#state === STATES.PLAYING) this.#setState(STATES.ENDED);
      setMediaSessionPlaybackState("none");
    });
    audio.addEventListener("error", () => {
      if (this.#state === STATES.PLAYING || this.#state === STATES.GENERATING) {
        this.#emit("error", { message: "Lecture audio impossible." });
      }
    });

    this.#bindMediaControls({ seekable: true });

    this.#audio = audio;
    return audio;
  }

  /**
   * Branche les contrôles système (casque, écran verrouillé).
   * Les deux sorties acceptent play/pause/stop ; le déplacement dans la piste
   * n'a de sens que sur l'audio complet, la lecture progressive ayant déjà
   * programmé ses segments sur l'horloge audio.
   */
  #bindMediaControls({ seekable }) {
    bindMediaSession({
      onPlay: () => this.resume(),
      onPause: () => this.pause(),
      onStop: () => this.stop(),
      onPrevious: seekable ? () => this.skipBlock(-1) : null,
      onNext: seekable ? () => this.skipBlock(1) : null,
      onSeekBackward: seekable ? () => this.seekBy(-SEEK_STEP) : null,
      onSeekForward: seekable ? () => this.seekBy(SEEK_STEP) : null,
      onSeekTo: seekable ? (details) => this.#seekTo(details.seekTime ?? 0) : null,
    });
  }

  async #startAudioElement(position) {
    const audio = this.#ensureAudioElement();
    audio.currentTime = position;
    try {
      await audio.play();
      setMediaSessionPlaybackState("playing");
    } catch (error) {
      this.#onPlaybackRejected(error);
    }
  }

  #onPlaybackRejected(error) {
    // Typiquement NotAllowedError : Firefox a bloqué la lecture automatique.
    this.#emit("error", {
      message: `Lecture refusée par le navigateur (${error?.name ?? "erreur"}). Autorisez la lecture automatique pour l'extension.`,
    });
    if (this.#state === STATES.PLAYING) this.#setState(STATES.IDLE);
  }

  #seekTo(time) {
    if (!this.#audio) return;
    const duration = this.#audio.duration;
    this.#audio.currentTime = Math.min(Math.max(time, 0), Number.isFinite(duration) ? duration : time);
    this.#onTimeUpdate();
  }

  #onTimeUpdate() {
    if (!this.#audio) return;
    this.#syncPosition(this.#audio.currentTime, this.#audio.duration);
  }

  /** Commun aux deux sorties : segment courant, session média et progression. */
  #syncPosition(current, duration) {
    const index = this.#bounds.findIndex((bound) => current < bound.end);
    if (index !== -1 && index !== this.#index) {
      this.#index = index;
      this.#emit("segment-start", {
        index,
        total: this.#segments.length,
        text: this.#segments[index]?.text ?? "",
      });
    }

    setMediaSessionPosition({ duration, position: current });

    // Les mises à jour arrivent ~4 fois par seconde : on n'informe l'UI qu'une
    // fois par seconde.
    const second = Math.floor(current);
    if (second !== this.#lastEmittedSecond) {
      this.#lastEmittedSecond = second;
      this.#emit("progress", { position: current, duration });
    }
  }

  #releaseObjectUrl() {
    if (!this.#objectUrl) return;
    URL.revokeObjectURL(this.#objectUrl);
    this.#objectUrl = null;
  }

  // --- Machine à états ----------------------------------------------------

  #setState(next) {
    if (next === this.#state) return;

    const allowed = ALLOWED_TRANSITIONS[this.#state] ?? [];
    if (!allowed.includes(next)) {
      throw new Error(`Transition d'état invalide : ${this.#state} → ${next}`);
    }

    this.#state = next;
    this.#emit("state-change", { state: next });
  }

  #emit(type, data = {}) {
    for (const listener of this.#listeners) listener({ type, ...data });
  }
}
