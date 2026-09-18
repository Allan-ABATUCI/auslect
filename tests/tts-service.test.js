// La façade décide quel moteur lit quel article. C'est la logique qui doit
// avertir l'utilisateur au lieu de le laisser devant un résultat inutilisable :
// langue non supportée par le modèle, ou modèle impossible à charger.
import test from "node:test";
import assert from "node:assert/strict";
import { TTSService } from "../src/tts/TTSService.js";
import { ENGINE_IDS } from "../src/tts/TTSEngineFactory.js";
import { TTSEngine, ENGINE_MODE } from "../src/tts/TTSEngine.js";

// Hérite de TTSEngine pour utiliser la vraie logique de supportsLanguage().
class FakeEngine extends TTSEngine {
  initCalls = 0;
  spoken = [];
  spokenOptions = [];

  constructor(id, { languages = null, failInit = false } = {}) {
    super();
    this._id = id;
    this.languages = languages;
    this.failInit = failInit;
  }

  get id() {
    return this._id;
  }

  get label() {
    return this._id === ENGINE_IDS.PIPER ? "Voix neuronale (Piper)" : "Voix du navigateur";
  }

  get mode() {
    return ENGINE_MODE.SPEAK;
  }

  get supportedLanguages() {
    return this.languages;
  }

  async init(onProgress) {
    this.initCalls += 1;
    this.onProgress = onProgress;
    if (this.failInit) throw new Error("modèle indisponible");
  }

  speak(text, options) {
    this.spoken.push(text);
    this.spokenOptions.push(options);
    this.onEnd = options.onEnd;
  }

  stop() {}
}

/** Fabrique de test : compte les créations et permet de piloter les échecs. */
function fakeFactory({ piperFailsInit = false } = {}) {
  const created = [];
  return {
    created,
    create(engineId) {
      const engine =
        engineId === ENGINE_IDS.PIPER
          ? new FakeEngine(ENGINE_IDS.PIPER, { languages: ["en"], failInit: piperFailsInit })
          : new FakeEngine(ENGINE_IDS.WEB_SPEECH);
      created.push(engine);
      return engine;
    },
    last(id) {
      return created.filter((e) => e.id === id).at(-1);
    },
    countOf(id) {
      return created.filter((e) => e.id === id).length;
    },
  };
}

const segments = [{ text: "Bonjour.", blockIndex: 0, isHeading: false }];

function makeService(options) {
  const factory = fakeFactory(options);
  const service = new TTSService(factory);
  const events = [];
  service.onEvent((event) => events.push(event));
  return { service, factory, events };
}

test("sans préférence, la voix du navigateur est utilisée sans rien charger d'autre", async () => {
  const { service, factory, events } = makeService();

  await service.load(segments, { lang: "fr", title: "Un article" });

  assert.equal(service.getSnapshot().activeEngineId, ENGINE_IDS.WEB_SPEECH);
  assert.equal(factory.countOf(ENGINE_IDS.PIPER), 0, "le modèle ne doit pas être instancié inutilement");
  assert.equal(events.filter((e) => e.type === "engine-fallback").length, 0);
});

test("un article anglais utilise bien le moteur neuronal demandé", async () => {
  const { service, factory, events } = makeService();
  service.setPreferredEngine(ENGINE_IDS.PIPER);

  await service.load(segments, { lang: "en-US" });

  assert.equal(service.getSnapshot().activeEngineId, ENGINE_IDS.PIPER);
  assert.equal(factory.last(ENGINE_IDS.PIPER).initCalls, 1);
  assert.equal(
    events.filter((e) => e.type === "engine-fallback").length,
    0,
    "aucun repli ne doit être annoncé quand le moteur demandé convient",
  );
});

test("un article français bascule sur la voix du navigateur et l'explique", async () => {
  const { service, events } = makeService();
  service.setPreferredEngine(ENGINE_IDS.PIPER);

  await service.load(segments, { lang: "fr" });

  const fallback = events.find((e) => e.type === "engine-fallback");
  assert.ok(fallback, "l'utilisateur doit être averti, pas laissé avec un résultat inutilisable");
  assert.match(fallback.reason, /anglaises/i);
  assert.equal(service.getSnapshot().activeEngineId, ENGINE_IDS.WEB_SPEECH);
});

test("la langue non supportée n'entraîne aucun téléchargement de modèle", async () => {
  const { service, factory } = makeService();
  service.setPreferredEngine(ENGINE_IDS.PIPER);

  await service.load(segments, { lang: "fr" });

  assert.equal(factory.last(ENGINE_IDS.PIPER).initCalls, 0, "inutile de télécharger le modèle pour rien");
});

test("un modèle qui refuse de se charger bascule sur la voix du navigateur", async () => {
  const { service, events } = makeService({ piperFailsInit: true });
  service.setPreferredEngine(ENGINE_IDS.PIPER);

  await service.load(segments, { lang: "en" });

  const fallback = events.find((e) => e.type === "engine-fallback");
  assert.ok(fallback);
  assert.match(fallback.reason, /indisponible/i);
  assert.equal(service.getSnapshot().activeEngineId, ENGINE_IDS.WEB_SPEECH);
});

test("après un échec, le moteur est reconstruit au lieu d'être réutilisé en l'état", async () => {
  const { service, factory } = makeService({ piperFailsInit: true });
  service.setPreferredEngine(ENGINE_IDS.PIPER);

  await service.load(segments, { lang: "en" });
  await service.load(segments, { lang: "en" });

  assert.equal(factory.countOf(ENGINE_IDS.PIPER), 2, "un moteur en échec ne doit pas être mis en cache");
});

test("un moteur déjà chargé n'est pas rechargé à chaque article", async () => {
  const { service, factory } = makeService();
  service.setPreferredEngine(ENGINE_IDS.PIPER);

  await service.load(segments, { lang: "en" });
  await service.load(segments, { lang: "en" });

  assert.equal(factory.countOf(ENGINE_IDS.PIPER), 1);
  assert.equal(factory.last(ENGINE_IDS.PIPER).initCalls, 1, "le modèle reste en mémoire entre deux articles");
});

test("la progression de téléchargement du modèle est relayée à l'UI", async () => {
  const { service, factory, events } = makeService();
  service.setPreferredEngine(ENGINE_IDS.PIPER);
  await service.load(segments, { lang: "en" });

  factory.last(ENGINE_IDS.PIPER).onProgress({
    status: "progress",
    file: "en_US-lessac-medium.onnx",
    loaded: 43,
    total: 86,
  });

  const progress = events.find((e) => e.type === "model-progress");
  assert.equal(progress.loaded, 43);
  assert.equal(progress.total, 86);
});

test("les événements du lecteur remontent à travers la façade", async () => {
  const { service, events } = makeService();
  await service.load(segments, { lang: "fr" });
  await service.speak();

  const states = events.filter((e) => e.type === "state-change").map((e) => e.state);
  assert.ok(states.includes("playing"), "l'UI doit voir passer les changements d'état");
});

test("l'instantané ne contient que ce qui est réellement lu", async () => {
  // Le popup n'affiche que le titre et l'état ; activeEngineId reste le seul
  // point d'observation de l'arbitrage des replis. Le deepEqual est ce qui
  // empêchera l'instantané de se remettre à charrier des champs sans lecteur.
  const { service } = makeService();
  service.setPreferredEngine(ENGINE_IDS.PIPER);

  await service.load(segments, { lang: "fr", title: "Mon article" });

  assert.deepEqual(service.getSnapshot(), {
    state: "idle",
    activeEngineId: ENGINE_IDS.WEB_SPEECH,
    title: "Mon article",
  });
});

test("la vitesse demandée traverse la façade jusqu'au moteur", async () => {
  const { service, factory } = makeService();

  await service.load(segments, { lang: "fr", speed: 1.25 });
  await service.speak();

  assert.equal(factory.last(ENGINE_IDS.WEB_SPEECH).spokenOptions[0].rate, 1.25);
});

test("sans vitesse demandée, le moteur en reçoit une quand même", async () => {
  // Le défaut doit venir de la façade, pas du moteur : un moteur qui oublierait
  // sa valeur par défaut lirait alors à une vitesse indéterminée.
  const { service, factory } = makeService();

  await service.load(segments, { lang: "fr" });
  await service.speak();

  assert.equal(factory.last(ENGINE_IDS.WEB_SPEECH).spokenOptions[0].rate, 1);
});
