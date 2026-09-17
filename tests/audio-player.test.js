// La machine à états est le point où les bugs de pause/reprise apparaissaient :
// ces tests vérifient qu'un segment n'est jamais sauté ni rejoué, dans les deux
// modes de rendu, et que les transitions interdites échouent bruyamment.
import test from "node:test";
import assert from "node:assert/strict";
import { AudioPlayer } from "../src/player/AudioPlayer.js";
import { ENGINE_MODE } from "../src/tts/TTSEngine.js";

const { STATES } = AudioPlayer;

function segments(count) {
  return Array.from({ length: count }, (_, i) => ({
    text: `Phrase ${i}.`,
    blockIndex: i,
    isHeading: false,
  }));
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

  constructor(sampleRate = 100, samplesPerSegment = 100, delayMs = 0) {
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

/** Élément <audio> minimal : la lecture réelle n'est pas testable hors navigateur. */
function installBrowserStubs() {
  const listeners = new Map();
  const audio = {
    currentTime: 0,
    duration: 10,
    paused: true,
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
      listeners.set(type, handler);
    },
    emit(type) {
      listeners.get(type)?.();
    },
  };

  const previous = {
    Audio: globalThis.Audio,
    document: globalThis.document,
    URL: globalThis.URL.createObjectURL,
  };

  globalThis.Audio = function Audio() {
    return audio;
  };
  globalThis.document = { body: { append() {} } };
  globalThis.URL.createObjectURL = () => "blob:stub";
  globalThis.URL.revokeObjectURL = () => {};

  return {
    audio,
    restore() {
      globalThis.Audio = previous.Audio;
      globalThis.document = previous.document;
      globalThis.URL.createObjectURL = previous.URL;
    },
  };
}

function record(player) {
  const events = [];
  player.onEvent((event) => events.push(event));
  return events;
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

test("mode synthèse : tout l'article est généré avant la lecture", async () => {
  const stubs = installBrowserStubs();
  try {
    const engine = new FakeSynthesizeEngine();
    const player = new AudioPlayer(engine);
    player.load(segments(3));
    const events = record(player);

    await player.play();

    assert.deepEqual(engine.calls, ["Phrase 0.", "Phrase 1.", "Phrase 2."]);
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
    const engine = new FakeSynthesizeEngine(100, 100);
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
    const player = new AudioPlayer(new FakeSynthesizeEngine(100, 100, 20));
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
    const player = new AudioPlayer(new FakeSynthesizeEngine(100, 100, 10));
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
