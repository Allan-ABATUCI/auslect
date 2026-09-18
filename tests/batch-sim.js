// Mesure de l'ordonnanceur de lecture par lots, sur horloge virtuelle.
//
// Ce qu'on veut savoir avant de croire au gain : combien de temps avant le
// premier son, combien de fois le fichier est republié, et à quel moment a lieu
// la dernière republication — car c'est à partir de là que <audio> tient
// l'article entier et que plus aucun code n'a besoin d'être réveillé. Écran
// éteint, sur Android, c'est cette dernière date qui compte.
//
// Le moteur réel n'est pas sollicité : seule la chronologie est simulée, à
// partir du RTF déjà mesuré. La fréquence d'échantillonnage est abaissée à
// 1 kHz (les durées sont inchangées, la mémoire devient négligeable) et les
// segments sont rendus directement en PCM 16 bits.
//
//   node tests/batch-sim.js [rtf...]
import { AudioPlayer } from "../src/player/AudioPlayer.js";
import { ENGINE_MODE } from "../src/tts/TTSEngine.js";

const SAMPLE_RATE = 1000;

// Profil du chapitre déjà mesuré : 5 968 mots, 369 segments, 28:35 d'audio.
// Les respirations ajoutées par le lecteur (~87 s au total) sont déduites pour
// retomber sur cette durée.
const SEGMENT_COUNT = 369;
const SEGMENT_SAMPLES = 4410; // 4,41 s de parole par segment
const SENTENCES_PER_BLOCK = 2;

function formatTime(seconds) {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function segments() {
  return Array.from({ length: SEGMENT_COUNT }, (_, i) => ({
    text: `Segment ${i}`,
    blockIndex: Math.floor(i / SENTENCES_PER_BLOCK),
    isHeading: false,
  }));
}

/** Élément <audio> et horloge virtuelle : le temps n'avance que sur demande. */
function createWorld(rtf) {
  const blobs = [];
  const listeners = new Map();
  let now = 0; // secondes écoulées depuis le lancement
  let lastTick = 0;

  const audio = {
    currentTime: 0,
    duration: NaN,
    readyState: 1, // on ne simule pas le chargement du blob
    paused: true,
    _src: "",

    get src() {
      return this._src;
    },
    set src(value) {
      this._src = value;
      this.currentTime = 0;
      this.paused = true;
      const blob = blobs[Number(value.slice("blob:".length))];
      this.duration = blob ? (blob.size - 44) / 2 / SAMPLE_RATE : NaN;
    },

    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    load() {},
    removeAttribute() {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    emit(type) {
      for (const handler of [...(listeners.get(type) ?? [])]) handler();
    },
  };

  globalThis.Audio = function Audio() {
    return audio;
  };
  globalThis.document = { body: { append() {} } };
  globalThis.URL.createObjectURL = (blob) => `blob:${blobs.push(blob) - 1}`;
  globalThis.URL.revokeObjectURL = () => {};
  // Le lecteur chronomètre avec performance.now() : on lui donne l'horloge virtuelle.
  globalThis.performance = { now: () => now * 1000 };

  /** Fait avancer le temps, et avec lui la tête de lecture. */
  function advance(seconds) {
    now += seconds;
    const delta = now - lastTick;
    lastTick = now;

    if (audio.paused || !Number.isFinite(audio.duration)) return;

    audio.currentTime = Math.min(audio.currentTime + delta, audio.duration);
    audio.emit("timeupdate");
    if (audio.currentTime >= audio.duration - 1e-9) {
      audio.paused = true; // le fichier est consommé : plus rien à jouer
      audio.emit("ended");
    }
  }

  const engine = {
    mode: ENGINE_MODE.SYNTHESIZE,
    calls: 0,
    async synthesize() {
      this.calls += 1;
      advance((SEGMENT_SAMPLES / SAMPLE_RATE) * rtf);
      await new Promise((resolve) => setImmediate(resolve));
      return { samples: new Int16Array(SEGMENT_SAMPLES), sampleRate: SAMPLE_RATE };
    },
    stop() {},
  };

  return { audio, engine, at: () => now };
}

async function simulate(rtf) {
  const world = createWorld(rtf);
  const player = new AudioPlayer(world.engine);
  const publications = [];
  let summary = null;

  player.onEvent((event) => {
    if (event.type === "batch-ready") {
      publications.push({
        at: world.at(),
        position: world.audio.currentTime,
        published: event.seconds,
        complete: event.complete,
      });
    }
    if (event.type === "generation-done") summary = event;
  });

  player.load(segments(), { title: "Simulation" });
  await player.play();
  while (!summary) await new Promise((resolve) => setImmediate(resolve));

  return { publications, summary, audioSeconds: summary.audioSeconds };
}

const rtfs = process.argv.slice(2).map(Number).filter(Number.isFinite);
const cases = rtfs.length > 0 ? rtfs : [0.22, 0.05, 1.2];

console.log(
  `Chapitre simulé : ${SEGMENT_COUNT} segments, ` +
    `${formatTime((SEGMENT_COUNT * SEGMENT_SAMPLES) / SAMPLE_RATE)} de parole.\n`,
);

for (const rtf of cases) {
  const { publications, summary } = await simulate(rtf);
  const last = publications.at(-1);

  console.log(`RTF ${rtf.toFixed(2)}`);
  console.log(`  attente avant le premier son : ${formatTime(summary.timeToFirstAudio)}`);
  console.log(`  génération complète en       : ${formatTime(summary.elapsed)}`);
  console.log(`  audio total                  : ${formatTime(summary.audioSeconds)}`);
  console.log(`  publications du fichier      : ${publications.length}`);
  for (const p of publications) {
    console.log(
      `    à ${formatTime(p.at).padStart(6)} (lecture ${formatTime(p.position).padStart(6)})` +
        ` → fichier de ${formatTime(p.published)}${p.complete ? "  [article complet]" : ""}`,
    );
  }
  console.log(`  coupures (lecture rattrapée) : ${summary.underruns}`);
  console.log(
    `  autonome à partir de         : ${formatTime(last.at)}` +
      `, soit ${formatTime(summary.audioSeconds - last.position)} d'écoute sans JS\n`,
  );
}
