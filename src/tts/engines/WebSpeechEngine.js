// Adapte la Web Speech API (speechSynthesis) à l'interface TTSEngine.
// Mode SPEAK : le navigateur parle lui-même, sans fichier audio exploitable —
// donc pas de lecture en arrière-plan possible avec ce moteur.
import { TTSEngine, ENGINE_MODE } from "../TTSEngine.js";

export class WebSpeechEngine extends TTSEngine {
  get id() {
    return "webspeech";
  }

  get label() {
    return "Voix du navigateur";
  }

  get mode() {
    return ENGINE_MODE.SPEAK;
  }

  async init() {
    // Rien à charger : le moteur est fourni par le navigateur.
  }

  speak(text, { lang, rate = 1, onEnd, onError } = {}) {
    const utterance = new SpeechSynthesisUtterance(text);
    if (lang) utterance.lang = lang;
    utterance.rate = rate;
    utterance.onend = () => onEnd?.();
    utterance.onerror = (event) => onError?.(event.error);

    speechSynthesis.speak(utterance);
  }

  stop() {
    // cancel() vide la file d'attente ; on ne joue qu'un segment à la fois donc c'est sûr.
    // L'AudioPlayer ignore l'onend/onerror résultant s'il n'est plus en état "playing".
    speechSynthesis.cancel();
  }
}
