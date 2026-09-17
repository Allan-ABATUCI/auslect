// Point d'entrée unique pour piloter la synthèse vocale (pattern Facade + Singleton).
// Cache le choix du moteur, son chargement, les replis et la machine à états.
import { TTSEngineFactory, ENGINE_IDS } from "./TTSEngineFactory.js";
import { AudioPlayer } from "../player/AudioPlayer.js";

let instance = null;

export class TTSService {
  #player;
  #engines = new Map(); // moteurs instanciés, gardés en cache (le modèle pèse lourd)
  #initialized = new Set(); // ids dont l'init() a réussi
  #preferredEngineId = ENGINE_IDS.WEB_SPEECH;
  #activeEngineId = ENGINE_IDS.WEB_SPEECH;
  #listeners = new Set();
  #title = "";
  #factory;

  /** La fabrique est injectable pour pouvoir tester l'arbitrage hors navigateur. */
  constructor(engineFactory = TTSEngineFactory) {
    this.#factory = engineFactory;
    const engine = this.#factory.create(ENGINE_IDS.WEB_SPEECH);
    this.#engines.set(ENGINE_IDS.WEB_SPEECH, engine);
    this.#player = new AudioPlayer(engine);
    this.#player.onEvent((event) => this.#emit(event));
  }

  static getInstance() {
    if (!instance) instance = new TTSService();
    return instance;
  }

  get preferredEngineId() {
    return this.#preferredEngineId;
  }

  /** Moteur souhaité par l'utilisateur ; le moteur réellement utilisé peut différer. */
  setPreferredEngine(engineId) {
    this.#preferredEngineId = engineId;
  }

  /**
   * Charge un article : choisit le moteur adapté, le prépare, puis segmente.
   * @param {Array<{text: string, blockIndex: number, isHeading: boolean}>} segments
   */
  async load(segments, { lang, title } = {}) {
    this.#title = title ?? "";
    const engine = await this.#resolveEngine(lang);

    this.#player.setEngine(engine);
    this.#player.load(segments, { lang, title });
  }

  async speak() {
    await this.#player.play();
  }

  pause() {
    this.#player.pause();
  }

  resume() {
    this.#player.resume();
  }

  stop() {
    this.#player.stop();
  }

  getSnapshot() {
    return {
      state: this.#player.state,
      preferredEngineId: this.#preferredEngineId,
      activeEngineId: this.#activeEngineId,
      title: this.#title,
      index: this.#player.index,
      total: this.#player.total,
    };
  }

  onEvent(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Décide du moteur à utiliser pour cet article et le prépare.
   * Deux replis possibles vers la voix du navigateur : langue non supportée par
   * le modèle, ou échec de chargement (réseau, WASM, mémoire).
   */
  async #resolveEngine(lang) {
    const wantedId = this.#preferredEngineId;
    if (wantedId === ENGINE_IDS.WEB_SPEECH) return this.#useEngine(ENGINE_IDS.WEB_SPEECH);

    const candidate = this.#getEngine(wantedId);
    if (lang && !candidate.supportsLanguage(lang)) {
      this.#emit({
        type: "engine-fallback",
        reason: `${candidate.label} ne propose que des voix anglaises : lecture avec la voix du navigateur.`,
      });
      return this.#useEngine(ENGINE_IDS.WEB_SPEECH);
    }

    try {
      return await this.#useEngine(wantedId);
    } catch (error) {
      this.#emit({
        type: "engine-fallback",
        reason: `Moteur neuronal indisponible (${String(error?.message ?? error)}) : lecture avec la voix du navigateur.`,
      });
      this.#engines.delete(wantedId); // repartir d'un moteur neuf au prochain essai
      return this.#useEngine(ENGINE_IDS.WEB_SPEECH);
    }
  }

  async #useEngine(engineId) {
    const engine = this.#getEngine(engineId);

    // C'est la façade qui garde les moteurs en cache, donc c'est à elle de
    // n'initialiser qu'une fois — plutôt que de compter sur un init() idempotent
    // dans chaque moteur, ce qu'un nouveau moteur pourrait oublier.
    if (!this.#initialized.has(engineId)) {
      await engine.init((info) => {
        // Progression de téléchargement du modèle (~86 Mo au premier lancement).
        if (info?.status === "progress" && info.total) {
          this.#emit({
            type: "model-progress",
            file: info.file,
            loaded: info.loaded,
            total: info.total,
          });
        }
      });
      this.#initialized.add(engineId);
    }

    if (this.#activeEngineId !== engineId) {
      this.#activeEngineId = engineId;
      this.#emit({ type: "engine-change", engineId, label: engine.label });
    }
    return engine;
  }

  #getEngine(engineId) {
    if (!this.#engines.has(engineId)) {
      this.#engines.set(engineId, this.#factory.create(engineId));
    }
    return this.#engines.get(engineId);
  }

  #emit(event) {
    for (const listener of this.#listeners) listener(event);
  }
}
