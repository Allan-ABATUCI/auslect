// Choisit le moteur de synthèse (pattern Factory).
// Le repli en cas d'échec ou de langue non supportée est géré par TTSService.
import { WebSpeechEngine } from "./engines/WebSpeechEngine.js";
import { PiperEngine } from "./engines/PiperEngine.js";

export const ENGINE_IDS = Object.freeze({
  WEB_SPEECH: "webspeech",
  PIPER: "piper",
});

export const TTSEngineFactory = {
  create(engineId, options = {}) {
    if (engineId === ENGINE_IDS.PIPER) return new PiperEngine(options);
    return new WebSpeechEngine(options);
  },
};
