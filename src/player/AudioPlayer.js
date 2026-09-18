// Machine à états qui pilote la lecture (pattern State) et émet les événements
// auxquels s'abonne l'UI (pattern Observer).
//
// Deux chemins de rendu selon le mode du moteur :
//  - SPEAK      : segment par segment via engine.speak(). Le pause/resume natif de
//                 speechSynthesis étant instable, "pause" = on n'enchaîne pas sur
//                 le segment suivant, "resume" = on repart au même index.
//  - SYNTHESIZE : la génération et la lecture se recouvrent. Dès qu'il y a de quoi
//                 écouter (FIRST_BATCH_SECONDS), <audio> démarre ; la génération
//                 continue derrière et le fichier est republié, allongé, quand la
//                 tête de lecture s'en approche.
//
// Pourquoi republier UN fichier qui grandit plutôt qu'enchaîner des lots
// indépendants : sur Android le JS est gelé écran éteint, donc rien ne doit
// dépendre de lui une fois la lecture lancée. Le moteur génère ~4,5x plus vite
// que le temps réel, si bien que les republications se concentrent dans les
// premières minutes ; la dernière contient l'article entier et <audio> le joue
// jusqu'au bout sans qu'aucun code ne soit réveillé. Des lots enchaînés sur
// "ended" auraient exigé le contraire, à chaque frontière.
import { ENGINE_MODE } from "../tts/TTSEngine.js";
import { encodeWav, silence, toPcm16 } from "../lib/wav.js";
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

// Audio à avoir en réserve avant de lancer la lecture. Assez pour couvrir la
// génération du lot suivant (RTF mesuré : 0,22 sur émulateur), assez court pour
// que l'attente initiale reste de l'ordre de la dizaine de secondes.
const FIRST_BATCH_SECONDS = 45;
// On republie quand il reste moins que ça devant la tête de lecture, plutôt
// qu'en attendant "ended" : l'élément <audio> ne s'arrête jamais, donc la
// session média ne clignote pas sur la notification Android.
const PREFETCH_MARGIN_SECONDS = 10;
// Une publication réencode tout le fichier, pas seulement la nouveauté. Sans
// garde-fou, une synthèse plus lente que la lecture republie à chaque segment et
// le coût devient quadratique — sur l'appareil qui peinait déjà. Exiger une part
// croissante de l'existant ramène le nombre de publications à une poignée, quel
// que soit le RTF, et le travail d'encodage total à quelques fois la taille
// finale (mesuré par tests/batch-sim.js).
const MIN_NEW_SECONDS = 30;
const MIN_NEW_RATIO = 0.25;
const METADATA_TIMEOUT_MS = 5000;
const DEFAULT_SAMPLE_RATE = 24000;

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

  // --- État de la génération incrémentale ---
  #pcm = []; // morceaux PCM 16 bits déjà synthétisés, dans l'ordre
  #sampleRate = DEFAULT_SAMPLE_RATE;
  #generatedSamples = 0; // tout ce qui est synthétisé
  #publishedSamples = 0; // ce que contient le fichier actuellement attaché
  #complete = false; // le fichier attaché couvre l'article entier
  #publishing = false;
  #waiting = false; // la lecture a rattrapé la génération
  #underruns = 0;
  #generationStartedAt = 0;
  #timeToFirstAudio = 0;
  #startSignal = null; // libère play() dès que le son sort

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

  /**
   * Démarre la lecture. En mode SYNTHESIZE, la promesse est tenue dès que le son
   * sort — pas quand tout l'article est généré : la suite se fait en fond.
   */
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

    // Article déjà entièrement généré (relecture après la fin) : on rejoue sans
    // repasser par le moteur.
    if (this.#objectUrl && this.#complete) {
      this.#setState(STATES.PLAYING);
      await this.#startAudioElement(0);
      return;
    }

    const token = ++this.#generationToken;
    this.#resetGeneration();
    this.#setState(STATES.GENERATING);

    // La promesse est tenue par #publish au premier lot, et par #runGeneration
    // en dernier recours si la génération s'achève sans avoir rien produit.
    const started = deferred();
    this.#startSignal = started;
    this.#runGeneration(token, started); // volontairement non attendu
    await started.promise;
  }

  pause() {
    if (this.#state !== STATES.PLAYING) return;

    // La génération, elle, continue : on veut garder l'avance acquise.
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
    this.#resetGeneration();
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
    if (target === -1 || target >= this.#bounds.length) return;

    // Le bloc visé peut être synthétisé sans être encore dans le fichier attaché.
    const start = this.#bounds[target].start;
    if (start >= this.#publishedSeconds) return;

    this.#seekTo(start);
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
      rate: this.#options.speed,
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

  #resetGeneration() {
    this.#releaseObjectUrl();
    this.#pcm = [];
    this.#bounds = [];
    this.#sampleRate = DEFAULT_SAMPLE_RATE;
    this.#generatedSamples = 0;
    this.#publishedSamples = 0;
    this.#complete = false;
    this.#publishing = false;
    this.#waiting = false;
    this.#underruns = 0;
    this.#timeToFirstAudio = 0;
  }

  get #generatedSeconds() {
    return this.#generatedSamples / this.#sampleRate;
  }

  get #publishedSeconds() {
    return this.#publishedSamples / this.#sampleRate;
  }

  /**
   * Enveloppe la génération : elle tourne en fond, donc c'est ici que toute
   * erreur doit être rattrapée, et ici que play() est libéré quoi qu'il arrive.
   */
  async #runGeneration(token, started) {
    try {
      await this.#generate(token);
    } catch (error) {
      if (token !== this.#generationToken) return; // stop() est passé par là
      this.#emit("error", { message: String(error?.message ?? error) });

      if (this.#state === STATES.GENERATING) this.#setState(STATES.IDLE);
      // La lecture a déjà commencé : mieux vaut jouer jusqu'au bout de ce qui
      // est synthétisé que de tout jeter parce qu'un segment a échoué.
      else await this.#publish(token, { final: true }).catch(() => {});
    } finally {
      started.resolve();
    }
  }

  async #generate(token) {
    this.#generationStartedAt = performance.now();

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
        speed: this.#options.speed,
      });
      elapsed += (performance.now() - startedAt) / 1000;
      if (token !== this.#generationToken) throw new Error("Génération annulée.");

      this.#sampleRate = result.sampleRate;
      const start = this.#generatedSamples;
      this.#append(toPcm16(result.samples));
      this.#bounds.push({
        start: start / this.#sampleRate,
        end: this.#generatedSamples / this.#sampleRate,
      });

      this.#append(silence(this.#gapAfter(i), this.#sampleRate));

      charsDone += segment.text.length;
      audioSeconds += result.samples.length / this.#sampleRate;

      this.#emit("generation-progress", {
        done: i + 1,
        total: this.#segments.length,
        elapsed,
        rtf: audioSeconds > 0 ? elapsed / audioSeconds : 0,
        remainingSeconds: charsDone > 0 ? (elapsed / charsDone) * (charsTotal - charsDone) : 0,
      });

      if (this.#shouldPublishNow()) await this.#publish(token);
    }

    await this.#publish(token, { final: true });

    // RTF < 1 signifie que la synthèse va plus vite que la lecture : c'est la
    // condition qui rend la lecture par lots tenable.
    this.#emit("generation-done", {
      elapsed,
      audioSeconds,
      rtf: audioSeconds > 0 ? elapsed / audioSeconds : 0,
      underruns: this.#underruns,
      timeToFirstAudio: this.#timeToFirstAudio,
    });
  }

  #append(pcm) {
    this.#pcm.push(pcm);
    this.#generatedSamples += pcm.length;
  }

  /**
   * Depuis la boucle de génération, on ne republie que dans deux cas : au tout
   * début, et quand la lecture est à l'arrêt faute d'audio. Le cas normal — la
   * tête de lecture qui approche de la fin du fichier — est déclenché par
   * timeupdate, avant que le son ne s'interrompe.
   */
  #shouldPublishNow() {
    if (this.#publishedSamples === 0) return this.#generatedSeconds >= FIRST_BATCH_SECONDS;
    // À l'arrêt faute d'audio, on se reconstitue une réserve avant de repartir
    // plutôt que de redémarrer pour quelques secondes et se recouper aussitôt.
    return this.#waiting && this.#hasEnoughNewAudio();
  }

  /** Assez de nouveauté pour que réécrire tout le fichier en vaille la peine. */
  #hasEnoughNewAudio() {
    const fresh = this.#generatedSeconds - this.#publishedSeconds;
    return fresh >= Math.max(MIN_NEW_SECONDS, this.#publishedSeconds * MIN_NEW_RATIO);
  }

  /** Réencode tout ce qui est généré et le donne à <audio>, sans perdre la position. */
  async #publish(token, { final = false } = {}) {
    if (token !== this.#generationToken) return;
    if (this.#publishing) return;

    if (this.#publishedSamples === this.#generatedSamples) {
      // Rien de neuf à encoder : seul le drapeau « complet » peut changer.
      if (!final) return;
      this.#complete = true;
      if (this.#waiting) {
        this.#waiting = false;
        this.#finish();
      }
      return;
    }

    this.#publishing = true;
    try {
      const first = this.#publishedSamples === 0;
      const position = first ? 0 : (this.#audio?.currentTime ?? 0);
      const blob = encodeWav(this.#pcm, this.#sampleRate);

      this.#publishedSamples = this.#generatedSamples;
      this.#complete = final;
      this.#waiting = false;

      if (first) {
        this.#timeToFirstAudio = (performance.now() - this.#generationStartedAt) / 1000;
        this.#setState(STATES.PLAYING);
      }

      // En pause, on remplace quand même le fichier : resume() repartira de la
      // bonne position, avec la suite déjà en place.
      await this.#swapAudio(blob, position, this.#state === STATES.PLAYING);

      // Émis après l'échange, pas avant : « prêt » doit vouloir dire que le son
      // est réellement en place, sans quoi l'événement ne prouve rien.
      this.#emit("batch-ready", {
        seconds: this.#publishedSeconds,
        segments: this.#bounds.length,
        complete: this.#complete,
      });
      if (first) this.#startSignal?.resolve();
    } finally {
      this.#publishing = false;
    }
  }

  /** Respiration après un segment, selon qu'il termine un titre, un bloc ou une phrase. */
  #gapAfter(index) {
    const segment = this.#segments[index];
    const next = this.#segments[index + 1];
    if (segment.isHeading) return GAP_AFTER_HEADING;
    if (!next || next.blockIndex !== segment.blockIndex) return GAP_AFTER_BLOCK;
    return GAP_AFTER_SENTENCE;
  }

  async #swapAudio(blob, position, shouldPlay) {
    const audio = this.#ensureAudioElement();
    const previous = this.#objectUrl;

    this.#objectUrl = URL.createObjectURL(blob);
    audio.src = this.#objectUrl;
    // L'élément ne référence plus l'ancien fichier : il peut être libéré.
    if (previous) URL.revokeObjectURL(previous);

    if (position > 0) {
      // currentTime n'est réglable qu'une fois la durée du nouveau fichier connue.
      await whenMetadataReady(audio);
      try {
        audio.currentTime = position;
      } catch {
        // Métadonnées absentes malgré l'attente : mieux vaut reprendre au début
        // du fichier que de laisser l'exception interrompre la lecture.
      }
    }

    if (!shouldPlay) return;
    try {
      await audio.play();
      setMediaSessionPlaybackState("playing");
    } catch (error) {
      this.#onPlaybackRejected(error);
    }
  }

  #ensureAudioElement() {
    if (this.#audio) return this.#audio;

    const audio = new Audio();
    audio.preload = "auto";
    // Attaché au document : Firefox tient alors mieux compte de l'élément pour
    // la session média (et donc les contrôles système).
    document.body?.append(audio);

    audio.addEventListener("timeupdate", () => this.#onTimeUpdate());
    audio.addEventListener("ended", () => this.#onEnded());
    audio.addEventListener("error", () => {
      if (this.#state === STATES.PLAYING || this.#state === STATES.GENERATING) {
        this.#emit("error", { message: "Lecture audio impossible." });
      }
    });

    this.#bindMediaControls();

    this.#audio = audio;
    return audio;
  }

  #onEnded() {
    if (this.#state !== STATES.PLAYING) return;

    if (this.#isSynthesizeMode && !this.#complete) {
      // La lecture a rattrapé la génération : l'article n'est pas fini, on
      // attend la suite. Sur un appareil trop lent (RTF > 1) c'est ici que ça
      // s'entend, d'où le comptage remonté à l'UI.
      this.#waiting = true;
      this.#underruns += 1;
      this.#emit("waiting", { position: this.#publishedSeconds });
      return;
    }

    this.#finish();
  }

  #finish() {
    if (this.#state !== STATES.PLAYING) return;
    this.#setState(STATES.ENDED);
    setMediaSessionPlaybackState("none");
  }

  /**
   * Branche les contrôles système (casque, écran verrouillé).
   * Appelé depuis #ensureAudioElement, donc seulement en mode SYNTHESIZE : le
   * mode parlé ne crée aucun élément média, donc aucune session à contrôler.
   */
  #bindMediaControls() {
    bindMediaSession({
      onPlay: () => this.resume(),
      onPause: () => this.pause(),
      onStop: () => this.stop(),
      onPrevious: () => this.skipBlock(-1),
      onNext: () => this.skipBlock(1),
      onSeekBackward: () => this.seekBy(-SEEK_STEP),
      onSeekForward: () => this.seekBy(SEEK_STEP),
      onSeekTo: (details) => this.#seekTo(details.seekTime ?? 0),
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
    this.#maybePublishAhead();
  }

  /**
   * Allonge le fichier avant que la tête de lecture n'en atteigne la fin. C'est
   * le chemin normal : l'élément <audio> ne s'arrête pas, donc la notification
   * Android ne perd jamais sa session.
   */
  #maybePublishAhead() {
    if (!this.#isSynthesizeMode || this.#complete || this.#publishing) return;
    if (this.#publishedSeconds - this.#audio.currentTime > PREFETCH_MARGIN_SECONDS) return;
    // Pas assez de neuf : on laisse la lecture atteindre la fin du fichier et on
    // repartira sur une vraie réserve (#shouldPublishNow), au prix d'une coupure.
    if (!this.#hasEnoughNewAudio()) return;

    this.#publish(this.#generationToken).catch((error) => {
      this.#emit("error", { message: String(error?.message ?? error) });
    });
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
      // `complete` dit à l'UI si la durée affichée est définitive : tant que la
      // génération tourne, le total montre le fichier publié, pas l'article.
      this.#emit("progress", { position: current, duration, complete: this.#complete });
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

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Attend que <audio> connaisse la durée du fichier qu'on vient de lui donner. */
function whenMetadataReady(audio) {
  if (audio.readyState >= 1) return Promise.resolve();

  return new Promise((resolve) => {
    // Un fichier qui ne charge pas ne doit pas geler la lecture indéfiniment.
    const timer = setTimeout(done, METADATA_TIMEOUT_MS);

    function done() {
      clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", done);
      audio.removeEventListener("error", done);
      resolve();
    }

    audio.addEventListener("loadedmetadata", done);
    audio.addEventListener("error", done);
  });
}
