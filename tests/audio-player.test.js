// La machine à états est le point où les bugs de pause/reprise apparaissaient :
// ces tests vérifient qu'un segment n'est jamais sauté ni rejoué, dans les deux
// modes de rendu, et que les transitions interdites échouent bruyamment.
//
// S'y ajoute la lecture par lots : le son doit sortir avant la fin de la
// génération, le fichier s'allonger sans perdre la position, et une génération
// plus lente que le temps réel se signaler au lieu de terminer l'article.
import test from "node:test";
import assert from "node:assert/strict";
import { AudioPlayer } from "../src/player/AudioPlayer.js";
import { ENGINE_MODE } from "../src/tts/TTSEngine.js";

const { STATES } = AudioPlayer;

// Fréquence des faux moteurs : 100 Hz, pour que 1 échantillon = 10 ms et que les
// durées attendues se lisent à l'œil nu.
const RATE = 100;

function segments(count) {
  return Array.from({ length: count }, (_, i) => ({
    text: `Phrase ${i}.`,
    blockIndex: i,
    isHeading: false,
  }));
}

/** Durée utile d'un WAV produit par l'encodeur, entête déduit. */
function durationOf(blob) {
  return (blob.size - 44) / 2 / RATE;
}

/** Moteur parlant dont on déclenche la fin de segment à la main. */
class FakeSpeakEngine {
  mode = ENGINE_MODE.SPEAK;
  spoken = [];
  #callbacks = null;

  speak(text, { onEnd, onError }) {
    this.spoken.push(text);
    this.#callbacks = { onEnd, onError };
  }

  // stop() n'oublie volontairement pas les callbacks : speechSynthesis.cancel()
  // est synchrone, mais l'événement de fin du segment en cours arrive après coup.
  // C'est ce décalage que le lecteur doit neutraliser lui-même.
  stop() {}

  finishSegment() {
    this.#callbacks?.onEnd();
  }

  failSegment(error) {
    this.#callbacks?.onError(error);
  }
}

class FakeSynthesizeEngine {
  mode = ENGINE_MODE.SYNTHESIZE;
  calls = [];

  constructor(sampleRate = RATE, samplesPerSegment = 100, delayMs = 0) {
    this.sampleRate = sampleRate;
    this.samplesPerSegment = samplesPerSegment;
    this.delayMs = delayMs;
  }

  async synthesize(text) {
    this.calls.push(text);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { samples: new Float32Array(this.samplesPerSegment), sampleRate: this.sampleRate };
  }

  stop() {}
}

/**
 * Élément <audio> minimal : la lecture réelle n'est pas testable hors navigateur.
 * Il imite ce qui compte ici — donner une nouvelle source remet la position à
 * zéro, arrête la lecture et rend la durée inconnue jusqu'aux métadonnées. Sans
 * cette fidélité-là, la restauration de position ne serait pas testée du tout.
 */
function installBrowserStubs() {
  const blobs = [];
  const listeners = new Map();

  const audio = {
    currentTime: 0,
    duration: NaN,
    readyState: 0,
    paused: true,
    _src: "",

    get src() {
      return this._src;
    },
    set src(value) {
      this._src = value;
      this.currentTime = 0;
      this.paused = true;
      this.readyState = 0;

      const blob = blobs[Number(value.slice("blob:".length))];
      queueMicrotask(() => {
        if (this._src !== value) return;
        this.duration = blob ? durationOf(blob) : NaN;
        this.readyState = 1;
        this.emit("loadedmetadata");
      });
    },

    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    load() {},
    removeAttribute() {
      this._src = "";
      this.readyState = 0;
    },
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

  const previous = {
    Audio: globalThis.Audio,
    document: globalThis.document,
    createObjectURL: globalThis.URL.createObjectURL,
    revokeObjectURL: globalThis.URL.revokeObjectURL,
  };

  globalThis.Audio = function Audio() {
    return audio;
  };
  globalThis.document = { body: { append() {} } };
  globalThis.URL.createObjectURL = (blob) => `blob:${blobs.push(blob) - 1}`;
  globalThis.URL.revokeObjectURL = () => {};

  return {
    audio,
    blobs,
    restore() {
      globalThis.Audio = previous.Audio;
      globalThis.document = previous.document;
      globalThis.URL.createObjectURL = previous.createObjectURL;
      globalThis.URL.revokeObjectURL = previous.revokeObjectURL;
    },
  };
}

function record(player) {
  const events = [];
  player.onEvent((event) => events.push(event));
  return events;
}

/** Première occurrence d'un événement, pour synchroniser sur la génération de fond. */
function waitFor(player, type) {
  return new Promise((resolve) => {
    const off = player.onEvent((event) => {
      if (event.type !== type) return;
      off();
      resolve(event);
    });
  });
}

test("mode parlé : les segments s'enchaînent un par un", async () => {
  const engine = new FakeSpeakEngine();
  const player = new AudioPlayer(engine);
  player.load(segments(3));

  await player.play();
  assert.equal(player.state, STATES.PLAYING);
  assert.deepEqual(engine.spoken, ["Phrase 0."]);

  engine.finishSegment();
  engine.finishSegment();
  assert.deepEqual(engine.spoken, ["Phrase 0.", "Phrase 1.", "Phrase 2."]);

  engine.finishSegment();
  assert.equal(player.state, STATES.ENDED, "la fin du dernier segment termine la lecture");
});

test("mode parlé : pause puis reprise rejoue le segment courant, sans en sauter", async () => {
  const engine = new FakeSpeakEngine();
  const player = new AudioPlayer(engine);
  player.load(segments(3));

  await player.play();
  engine.finishSegment(); // on est maintenant sur "Phrase 1."
  assert.deepEqual(engine.spoken, ["Phrase 0.", "Phrase 1."]);

  player.pause();
  assert.equal(player.state, STATES.PAUSED);

  // Le moteur peut signaler la fin après coup (cancel()) : ne pas enchaîner.
  engine.finishSegment();
  assert.deepEqual(engine.spoken, ["Phrase 0.", "Phrase 1."], "aucun segment ne doit démarrer en pause");

  player.resume();
  assert.deepEqual(engine.spoken, ["Phrase 0.", "Phrase 1.", "Phrase 1."], "on reprend au segment interrompu");
});

test("mode parlé : une erreur pendant une pause n'est pas remontée à l'UI", async () => {
  const engine = new FakeSpeakEngine();
  const player = new AudioPlayer(engine);
  player.load(segments(2));
  const events = record(player);

  await player.play();
  player.pause();
  engine.failSegment("canceled"); // conséquence attendue de speechSynthesis.cancel()

  assert.equal(events.filter((e) => e.type === "error").length, 0);
});

test("stop remet le lecteur à zéro depuis n'importe quel état", async () => {
  const engine = new FakeSpeakEngine();
  const player = new AudioPlayer(engine);
  player.load(segments(3));

  await player.play();
  engine.finishSegment();
  player.stop();

  assert.equal(player.state, STATES.IDLE);
  assert.equal(player.index, 0);

  await player.play();
  assert.deepEqual(engine.spoken.at(-1), "Phrase 0.", "on repart du début");
});

test("les commandes hors état sont ignorées plutôt que de casser la machine", async () => {
  const engine = new FakeSpeakEngine();
  const player = new AudioPlayer(engine);
  player.load(segments(2));

  player.pause(); // idle
  player.resume(); // idle
  assert.equal(player.state, STATES.IDLE);

  await player.play();
  player.resume(); // déjà en lecture
  assert.equal(player.state, STATES.PLAYING);
});

test("mode synthèse : un article court tient dans un seul fichier", async () => {
  const stubs = installBrowserStubs();
  try {
    const engine = new FakeSynthesizeEngine();
    const player = new AudioPlayer(engine);
    player.load(segments(3)); // 3 s d'audio : bien en deçà du seuil de mise en lecture
    const events = record(player);

    await player.play();

    assert.deepEqual(engine.calls, ["Phrase 0.", "Phrase 1.", "Phrase 2."]);
    assert.equal(stubs.blobs.length, 1, "aucune republication inutile sur un article court");
    assert.deepEqual(
      events.filter((e) => e.type === "generation-progress").map((e) => `${e.done}/${e.total}`),
      ["1/3", "2/3", "3/3"],
      "la progression doit permettre d'afficher une barre honnête",
    );

    const states = events.filter((e) => e.type === "state-change").map((e) => e.state);
    assert.deepEqual(states, [STATES.GENERATING, STATES.PLAYING]);
  } finally {
    stubs.restore();
  }
});

test("mode synthèse : la position dans l'audio retrouve le bon segment", async () => {
  const stubs = installBrowserStubs();
  try {
    // 100 échantillons à 100 Hz = 1 s par segment, plus la respiration entre blocs.
    const engine = new FakeSynthesizeEngine(RATE, 100);
    const player = new AudioPlayer(engine);
    player.load(segments(3));

    await player.play();
    const events = record(player);

    stubs.audio.currentTime = 1.5; // dans le second segment
    stubs.audio.emit("timeupdate");

    const started = events.filter((e) => e.type === "segment-start");
    assert.equal(started.at(-1).index, 1);
    assert.equal(started.at(-1).text, "Phrase 1.");
  } finally {
    stubs.restore();
  }
});

test("mode synthèse : la pause utilise le contrôle natif de l'élément audio", async () => {
  const stubs = installBrowserStubs();
  try {
    const player = new AudioPlayer(new FakeSynthesizeEngine());
    player.load(segments(2));
    await player.play();

    assert.equal(stubs.audio.paused, false);

    player.pause();
    assert.equal(player.state, STATES.PAUSED);
    assert.equal(stubs.audio.paused, true);

    player.resume();
    assert.equal(player.state, STATES.PLAYING);
    assert.equal(stubs.audio.paused, false);
  } finally {
    stubs.restore();
  }
});

test("la génération est chronométrée pour donner un RTF exploitable", async () => {
  const stubs = installBrowserStubs();
  try {
    // 100 échantillons à 100 Hz = 1 s d'audio par segment, produite en ~20 ms.
    const player = new AudioPlayer(new FakeSynthesizeEngine(RATE, 100, 20));
    player.load(segments(3));
    const events = record(player);

    await player.play();

    const done = events.find((e) => e.type === "generation-done");
    assert.ok(done, "la mesure doit être émise même si le popup est fermé");
    assert.equal(done.audioSeconds, 3, "les silences ajoutés ne comptent pas dans le RTF");
    assert.ok(done.elapsed > 0, "le temps de synthèse doit être mesuré");
    assert.ok(done.rtf > 0 && done.rtf < 1, `RTF hors plage attendue : ${done.rtf}`);
    // Ici la synthèse est ~50× plus rapide que le temps réel.
    assert.ok(Math.abs(done.rtf - done.elapsed / 3) < 1e-9, "RTF = temps / audio produit");
  } finally {
    stubs.restore();
  }
});

test("l'estimation du temps restant décroît jusqu'à zéro", async () => {
  const stubs = installBrowserStubs();
  try {
    const player = new AudioPlayer(new FakeSynthesizeEngine(RATE, 100, 10));
    player.load(segments(4));
    const events = record(player);

    await player.play();

    const eta = events.filter((e) => e.type === "generation-progress").map((e) => e.remainingSeconds);
    assert.equal(eta.length, 4);
    assert.ok(eta[0] > 0, "une estimation doit être disponible dès le premier segment");
    assert.equal(eta.at(-1), 0, "plus rien à générer à la fin");
    assert.ok(eta[0] > eta.at(-1), "l'estimation doit décroître");
  } finally {
    stubs.restore();
  }
});

test("changer de moteur invalide l'audio déjà généré", async () => {
  const stubs = installBrowserStubs();
  try {
    const first = new FakeSynthesizeEngine();
    const player = new AudioPlayer(first);
    player.load(segments(2));
    await player.play();

    const second = new FakeSynthesizeEngine();
    player.setEngine(second);
    assert.equal(player.state, STATES.IDLE);

    await player.play();
    assert.deepEqual(second.calls, ["Phrase 0.", "Phrase 1."], "le nouveau moteur doit tout regénérer");
  } finally {
    stubs.restore();
  }
});

// --- Lecture par lots -------------------------------------------------------
//
// Les segments font ici 25 s (2500 échantillons à 100 Hz) : deux suffisent à
// franchir la réserve de 45 s, les quatre suivants sont générés pendant l'écoute.

const LONG_SEGMENT_SAMPLES = 2500;

function longArticle(count, delayMs = 5) {
  return new FakeSynthesizeEngine(RATE, LONG_SEGMENT_SAMPLES, delayMs);
}

test("la lecture démarre avant que tout l'article soit généré", async () => {
  const stubs = installBrowserStubs();
  try {
    const engine = longArticle(6);
    const player = new AudioPlayer(engine);
    player.load(segments(6)); // ~150 s d'audio
    const finished = waitFor(player, "generation-done");

    await player.play();

    assert.equal(player.state, STATES.PLAYING, "le son doit sortir sans attendre la fin");
    assert.equal(stubs.audio.paused, false);
    // Le point de la lecture par lots : c'est cette inégalité qui tombe si l'on
    // revient à « tout générer, puis jouer ».
    assert.ok(
      engine.calls.length < 6,
      `la génération ne doit pas être terminée au démarrage (${engine.calls.length}/6 segments)`,
    );
    assert.ok(engine.calls.length >= 2, "il faut tout de même 45 s d'avance avant de lancer le son");

    const done = await finished;
    assert.equal(engine.calls.length, 6, "la génération se poursuit pendant la lecture");
    assert.equal(done.underruns, 0, "la synthèse est ici bien plus rapide que la lecture");
    assert.ok(done.timeToFirstAudio > 0 && done.timeToFirstAudio < done.elapsed);
  } finally {
    stubs.restore();
  }
});

test("le fichier est republié allongé, sans perdre la position de lecture", async () => {
  const stubs = installBrowserStubs();
  try {
    const engine = longArticle(6);
    const player = new AudioPlayer(engine);
    player.load(segments(6));

    await player.play();
    const firstBlob = stubs.blobs.at(-1);
    // 2 segments de 25 s + 2 respirations de 0,35 s.
    assert.ok(Math.abs(durationOf(firstBlob) - 50.7) < 1e-6, `durée initiale : ${durationOf(firstBlob)}`);

    await waitFor(player, "generation-progress"); // 3e segment synthétisé

    const republished = waitFor(player, "batch-ready");
    stubs.audio.currentTime = 45; // moins de 10 s de marge devant la tête de lecture
    stubs.audio.emit("timeupdate");
    await republished;

    assert.ok(stubs.blobs.length > 1, "un fichier plus long doit avoir été publié");
    assert.ok(
      durationOf(stubs.blobs.at(-1)) > durationOf(firstBlob),
      "le nouveau fichier doit contenir le précédent, plus la suite",
    );
    assert.equal(stubs.audio.currentTime, 45, "la position doit être restaurée après l'échange de source");
    assert.equal(stubs.audio.paused, false, "la lecture doit repartir toute seule");
  } finally {
    stubs.restore();
  }
});

test("la lecture qui rattrape la génération attend au lieu de terminer l'article", async () => {
  const stubs = installBrowserStubs();
  try {
    const engine = longArticle(4, 20);
    const player = new AudioPlayer(engine);
    player.load(segments(4));
    const finished = waitFor(player, "generation-done");
    const events = record(player);

    await player.play();

    // Fin du fichier publié alors qu'il reste des segments à synthétiser.
    stubs.audio.currentTime = durationOf(stubs.blobs.at(-1));
    stubs.audio.emit("ended");

    assert.equal(player.state, STATES.PLAYING, "l'article n'est pas fini : on ne doit pas passer à ENDED");
    assert.equal(events.filter((e) => e.type === "waiting").length, 1, "la coupure doit être signalée à l'UI");

    const done = await finished;
    assert.equal(done.underruns, 1, "la coupure doit être comptée dans la mesure");
    assert.equal(stubs.audio.paused, false, "la lecture repart dès que la suite est prête");
  } finally {
    stubs.restore();
  }
});

test("la fin du dernier fichier termine bien la lecture", async () => {
  const stubs = installBrowserStubs();
  try {
    const player = new AudioPlayer(longArticle(3));
    player.load(segments(3));
    const finished = waitFor(player, "generation-done");

    await player.play();
    await finished; // le fichier attaché couvre désormais tout l'article

    stubs.audio.currentTime = durationOf(stubs.blobs.at(-1));
    stubs.audio.emit("ended");

    assert.equal(player.state, STATES.ENDED);
  } finally {
    stubs.restore();
  }
});

test("une pause n'arrête pas la génération de fond et n'est pas levée par une republication", async () => {
  const stubs = installBrowserStubs();
  try {
    const engine = longArticle(6);
    const player = new AudioPlayer(engine);
    player.load(segments(6));
    const finished = waitFor(player, "generation-done");

    await player.play();
    const generatedAtPause = engine.calls.length;
    player.pause();

    await finished;

    assert.equal(engine.calls.length, 6, "la génération doit continuer pendant la pause");
    assert.ok(engine.calls.length > generatedAtPause, "…et progresser réellement");
    assert.equal(player.state, STATES.PAUSED, "une republication ne doit pas relancer la lecture");
    assert.equal(stubs.audio.paused, true);
  } finally {
    stubs.restore();
  }
});

test("stop pendant la génération de fond libère play() et annule la suite", async () => {
  const stubs = installBrowserStubs();
  try {
    const engine = longArticle(6, 10);
    const player = new AudioPlayer(engine);
    player.load(segments(6));

    await player.play();
    const generatedAtStop = engine.calls.length;
    player.stop();

    assert.equal(player.state, STATES.IDLE);

    // Laisser le temps à la génération annulée de se manifester si elle survit.
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(
      engine.calls.length <= generatedAtStop + 1,
      `la génération doit s'arrêter au segment en cours (${generatedAtStop} → ${engine.calls.length})`,
    );
  } finally {
    stubs.restore();
  }
});

test("une republication n'a pas lieu pour quelques secondes de neuf", async () => {
  // Reecrire tout le fichier coute proportionnellement a sa taille : republier
  // segment par segment rendrait le cout quadratique sur un appareil lent.
  // tests/batch-sim.js mesure l'effet : 331 publications sans ce garde-fou, 15 avec.
  const stubs = installBrowserStubs();
  try {
    const player = new AudioPlayer(longArticle(6));
    player.load(segments(6));

    await player.play(); // fichier de 50,7 s
    assert.equal(stubs.blobs.length, 1);

    await waitFor(player, "generation-progress"); // 3e segment : +25,35 s, sous le seuil
    stubs.audio.currentTime = 45;
    stubs.audio.emit("timeupdate");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(stubs.blobs.length, 1, "25 s de neuf ne justifient pas de reecrire 50 s");

    await waitFor(player, "generation-progress"); // 4e segment : +50,7 s, au-dessus
    const republished = waitFor(player, "batch-ready");
    stubs.audio.emit("timeupdate");
    await republished;
    assert.equal(stubs.blobs.length, 2, "au-dela du seuil, la publication doit avoir lieu");
  } finally {
    stubs.restore();
  }
});
