// La fabrique décide quel moteur rend le son, et surtout dans quel mode : seul
// le mode SYNTHESIZE produit un fichier audio, donc une session média.
import test from "node:test";
import assert from "node:assert/strict";
import { TTSEngineFactory, ENGINE_IDS } from "../src/tts/TTSEngineFactory.js";
import { WebSpeechEngine } from "../src/tts/engines/WebSpeechEngine.js";
import { PiperEngine } from "../src/tts/engines/PiperEngine.js";
import { ENGINE_MODE } from "../src/tts/TTSEngine.js";

test("le moteur neuronal est Piper, avec une voix par défaut", () => {
  const engine = TTSEngineFactory.create(ENGINE_IDS.PIPER);

  assert.ok(engine instanceof PiperEngine);
  assert.match(engine.voice, /^en_US-/, "voix anglaise, seule langue phonémisable embarquée");
});

test("la voix du navigateur est le moteur par défaut et le repli", () => {
  for (const id of [ENGINE_IDS.WEB_SPEECH, "moteur-inconnu", undefined]) {
    assert.ok(TTSEngineFactory.create(id) instanceof WebSpeechEngine, `id=${id}`);
  }
});

test("seul Piper produit un fichier audio, donc une session média", () => {
  // C'est toute la raison d'être du moteur neuronal ici : speechSynthesis parle
  // sans créer d'élément média, donc sans contrôles système.
  assert.equal(TTSEngineFactory.create(ENGINE_IDS.WEB_SPEECH).mode, ENGINE_MODE.SPEAK);
  assert.equal(TTSEngineFactory.create(ENGINE_IDS.PIPER).mode, ENGINE_MODE.SYNTHESIZE);
});

test("seul le moteur neuronal restreint les langues", () => {
  const webSpeech = TTSEngineFactory.create(ENGINE_IDS.WEB_SPEECH);
  const piper = TTSEngineFactory.create(ENGINE_IDS.PIPER);

  assert.equal(webSpeech.supportsLanguage("fr"), true);
  assert.equal(webSpeech.supportsLanguage("en-US"), true);

  assert.equal(piper.supportsLanguage("en"), true);
  assert.equal(piper.supportsLanguage("en-GB"), true, "le sous-tag régional ne doit pas gêner");
  assert.equal(piper.supportsLanguage("fr"), false);
  assert.equal(piper.supportsLanguage("fr-CA"), false);
});

test("la voix peut être imposée à la création", () => {
  const engine = TTSEngineFactory.create(ENGINE_IDS.PIPER, { voice: "en_GB-alan-medium" });
  assert.equal(engine.voice, "en_GB-alan-medium");
});
