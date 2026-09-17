// Adapte le worker Piper à l'interface TTSEngine.
// Mode SYNTHESIZE : rend du PCM que le lecteur assemble en un fichier audio,
// seule façon d'obtenir une session média (contrôles système, écran verrouillé).
import { TTSEngine, ENGINE_MODE } from "../TTSEngine.js";

// eSpeak n'est embarqué qu'avec ses données anglaises : les autres langues
// demanderaient piper_phonemize et ses ~19 Mo de données.
const DEFAULT_VOICE = "en_US-lessac-medium";

export class PiperEngine extends TTSEngine {
  #worker = null;
  #pending = new Map();
  #nextRequestId = 0;
  #voice;
  #readyResolvers = null;

  constructor({ voice = DEFAULT_VOICE } = {}) {
    super();
    this.#voice = voice;
  }

  get id() {
    return "piper";
  }

  get label() {
    return "Voix neuronale (Piper)";
  }

  get mode() {
    return ENGINE_MODE.SYNTHESIZE;
  }

  get supportedLanguages() {
    return ["en"];
  }

  get voice() {
    return this.#voice;
  }

  async init(onProgress) {
    if (this.#worker) return;

    this.#worker = new Worker(browser.runtime.getURL("piper-worker.js"), { type: "module" });
    this.#worker.onmessage = ({ data }) => this.#handleWorkerMessage(data, onProgress);
    this.#worker.onerror = (event) => this.#failAll(event.message || "Erreur du worker Piper.");

    const ready = new Promise((resolve, reject) => {
      this.#readyResolvers = { resolve, reject };
    });

    this.#worker.postMessage({
      type: "init",
      voice: this.#voice,
      wasmPath: browser.runtime.getURL("ort/"),
    });

    await ready;
  }

  async synthesize(text, { speed = 1 } = {}) {
    if (!this.#worker) throw new Error("Moteur Piper non initialisé.");

    const requestId = this.#nextRequestId++;
    const result = new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
    });

    this.#worker.postMessage({ type: "synthesize", requestId, text, speed });
    return result;
  }

  stop() {
    // L'inférence en cours n'est pas interruptible : on abandonne les promesses,
    // le lecteur ignorera les résultats tardifs.
    this.#failAll("Synthèse annulée.");
  }

  async dispose() {
    this.#failAll("Moteur arrêté.");
    this.#worker?.terminate();
    this.#worker = null;
  }

  #handleWorkerMessage(data, onProgress) {
    switch (data.type) {
      case "progress":
        onProgress?.({ status: "progress", loaded: data.loaded, total: data.total });
        break;

      case "ready":
        this.#readyResolvers?.resolve();
        this.#readyResolvers = null;
        break;

      case "audio": {
        const pending = this.#pending.get(data.requestId);
        this.#pending.delete(data.requestId);
        pending?.resolve({ samples: data.samples, sampleRate: data.sampleRate });
        break;
      }

      case "error": {
        const error = new Error(data.message);
        if (data.requestId !== undefined && this.#pending.has(data.requestId)) {
          this.#pending.get(data.requestId).reject(error);
          this.#pending.delete(data.requestId);
        } else {
          this.#readyResolvers?.reject(error);
          this.#readyResolvers = null;
          this.#failAll(data.message);
        }
        break;
      }

      default:
        break;
    }
  }

  #failAll(message) {
    for (const { reject } of this.#pending.values()) reject(new Error(message));
    this.#pending.clear();
  }
}
