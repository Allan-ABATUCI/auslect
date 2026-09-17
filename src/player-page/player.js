// Page lecteur : héberge le TTSService et produit le son.
//
// Le son ne vit plus dans la page de fond : une event page MV3 est suspendue
// après une trentaine de secondes d'inactivité, alors qu'un onglet qui joue de
// l'audio est traité par Firefox comme n'importe quel lecteur web. C'est la
// condition pour que la lecture tienne en arrière-plan, écran éteint, sur Android.
import { TTSService } from "../tts/TTSService.js";
import { ENGINE_IDS } from "../tts/TTSEngineFactory.js";
import { segmentArticle } from "../lib/segmenter.js";

const ttsService = TTSService.getInstance();

const els = {
  title: document.getElementById("title"),
  status: document.getElementById("status"),
  progress: document.getElementById("progress"),
  position: document.getElementById("position"),
  duration: document.getElementById("duration"),
  pause: document.getElementById("btn-pause"),
  resume: document.getElementById("btn-resume"),
  stop: document.getElementById("btn-stop"),
  segment: document.getElementById("segment"),
  stats: document.getElementById("stats"),
};

const STATE_LABELS = {
  idle: "Prêt.",
  generating: "Génération de l'audio…",
  playing: "Lecture en cours.",
  paused: "En pause.",
  ended: "Lecture terminée.",
};

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function applyState(state) {
  els.status.textContent = STATE_LABELS[state] ?? state;
  els.pause.disabled = state !== "playing";
  els.resume.disabled = state !== "paused";
  els.stop.disabled = state === "idle";
}

function render(event) {
  switch (event.type) {
    case "state-change":
      applyState(event.state);
      break;

    case "model-progress":
      els.status.textContent = `Téléchargement du modèle… ${Math.round((event.loaded / event.total) * 100)} %`;
      break;

    case "generation-progress": {
      const eta = event.remainingSeconds > 1 ? ` — ~${formatTime(event.remainingSeconds)} restantes` : "";
      els.status.textContent = `Génération… ${event.done}/${event.total}${eta}`;
      break;
    }

    case "generation-done":
      els.stats.hidden = false;
      els.stats.textContent =
        `Généré en ${formatTime(event.elapsed)} pour ${formatTime(event.audioSeconds)} d'audio — RTF ${event.rtf.toFixed(2)}` +
        (event.underruns ? ` — ${event.underruns} coupure(s)` : "");
      break;

    case "segment-start":
      els.segment.textContent = event.text;
      break;

    case "progress":
      els.position.textContent = formatTime(event.position);
      els.duration.textContent = formatTime(event.duration);
      els.progress.max = Math.max(event.duration, 1);
      els.progress.value = event.position;
      break;

    case "engine-fallback":
      els.status.textContent = event.reason;
      break;

    case "error":
      els.status.textContent = `Erreur : ${event.message ?? "inconnue"}`;
      break;

    default:
      break;
  }
}

// L'UI locale se met à jour, et le popup reste informé s'il est ouvert.
ttsService.onEvent((event) => {
  render(event);
  browser.runtime.sendMessage({ type: "PLAYER_EVENT", event }).catch(() => {});
});

els.pause.addEventListener("click", () => ttsService.pause());
els.resume.addEventListener("click", () => ttsService.resume());
els.stop.addEventListener("click", () => ttsService.stop());

/**
 * Récupère l'article mis de côté par le background. Le background le retire dès
 * qu'il est servi, ce qui évite un double chargement quand la page démarre juste
 * après avoir reçu l'avis de nouvel article.
 */
async function loadPendingArticle() {
  const article = await browser.runtime.sendMessage({ type: "TAKE_PENDING_ARTICLE" }).catch(() => null);
  if (!article) return;

  els.title.textContent = article.title || "Article sans titre";
  els.segment.textContent = "";
  els.stats.hidden = true;
  document.title = `${article.title || "Article"} — Auslect`;

  const segments = segmentArticle(article.html);
  if (segments.length === 0) {
    els.status.textContent = "Erreur : article vide après extraction.";
    return;
  }

  try {
    await ttsService.load(segments, { lang: article.lang, title: article.title });
    await ttsService.speak();
  } catch (error) {
    els.status.textContent = `Erreur : ${String(error?.message ?? error)}`;
  }
}

browser.runtime.onMessage.addListener((message) => {
  switch (message?.type) {
    case "NEW_ARTICLE":
      loadPendingArticle();
      return;
    case "PAUSE_REQUEST":
      ttsService.pause();
      return;
    case "RESUME_REQUEST":
      ttsService.resume();
      return;
    case "STOP_REQUEST":
      ttsService.stop();
      return;
    case "GET_STATE":
      return Promise.resolve(ttsService.getSnapshot());
    default:
      return;
  }
});

// Un seul moteur : Piper produit un vrai fichier audio, seule voie vers la
// session média. TTSService bascule de lui-même sur la voix du navigateur si le
// modèle ne charge pas ou si la langue n'est pas supportée.
ttsService.setPreferredEngine(ENGINE_IDS.PIPER);

await loadPendingArticle();
