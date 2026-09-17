// Interface commune à tous les moteurs de synthèse (pattern Strategy).
//
// Deux modes, car les moteurs ne produisent pas le son de la même façon :
//  - SPEAK      : le moteur parle lui-même (Web Speech). Rien à jouer côté lecteur,
//                 mais impossible de survivre à l'écran éteint.
//  - SYNTHESIZE : le moteur rend du PCM ; c'est le lecteur qui assemble et joue
//                 dans un <audio>, ce qui débloque la lecture en arrière-plan.
export const ENGINE_MODE = Object.freeze({
  SPEAK: "speak",
  SYNTHESIZE: "synthesize",
});

export class TTSEngine {
  /** Identifiant stable, utilisé par la fabrique et l'UI. */
  get id() {
    throw new Error("TTSEngine.id doit être implémenté par le moteur concret.");
  }

  /** Libellé affichable dans l'UI. */
  get label() {
    return this.id;
  }

  /** Un des ENGINE_MODE. */
  get mode() {
    throw new Error("TTSEngine.mode doit être implémenté par le moteur concret.");
  }

  /** Préfixes BCP-47 supportés, ou null si le moteur accepte toutes les langues. */
  get supportedLanguages() {
    return null;
  }

  /**
   * Prépare le moteur (téléchargement de modèle, compilation WASM...).
   * @param {(info: { loaded?: number, total?: number, file?: string }) => void} [onProgress]
   */
  async init(onProgress) {}

  /**
   * Mode SYNTHESIZE : rend un segment en PCM mono.
   * @returns {Promise<{ samples: Float32Array, sampleRate: number }>}
   */
  async synthesize(text, options) {
    throw new Error(`Le moteur "${this.id}" ne sait pas synthétiser.`);
  }

  /**
   * Mode SPEAK : prononce un segment, puis appelle onEnd() (ou onError()).
   * @param {string} text
   * @param {{ lang?: string, rate?: number, onEnd: () => void, onError: (e: unknown) => void }} options
   */
  speak(text, options) {
    throw new Error(`Le moteur "${this.id}" ne sait pas parler directement.`);
  }

  /** Interrompt le travail en cours (parole ou synthèse). */
  stop() {}

  /** Libère les ressources lourdes (worker, modèle en mémoire). */
  async dispose() {}

  /** Vrai si le moteur peut lire du contenu dans cette langue. */
  supportsLanguage(lang) {
    const supported = this.supportedLanguages;
    if (!supported) return true;
    const prefix = String(lang || "").toLowerCase().split("-")[0];
    return supported.includes(prefix);
  }
}
