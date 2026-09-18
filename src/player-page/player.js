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
  speed: document.getElementById("speed"),
};

// Vitesse de parole, appliquée à la génération. Conservée dans le localStorage
// de la page d'extension plutôt que dans browser.storage : l'origine
// moz-extension:// est stable, et demander une permission de plus pour un seul
// nombre ne se justifie pas. Toute lecture ou écriture peut échouer (fenêtre
// privée, données de site bloquées), d'où les try/catch.
const SPEED_KEY = "auslect.speed";
const DEFAULT_SPEED = 1;

function storedSpeed() {
  try {
    const value = Number(localStorage.getItem(SPEED_KEY));
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SPEED;
  } catch {
    return DEFAULT_SPEED;
  }
}

function currentSpeed() {
  const value = Number(els.speed.value);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SPEED;
}

// L'état pilote la répartition des messages : pendant l'écoute, la génération
// passe en seconde ligne au lieu d'écraser « Lecture en cours ».
let currentState = "idle";

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
  currentState = state;
  els.status.textContent = STATE_LABELS[state] ?? state;
  els.pause.disabled = state !== "playing";
  els.resume.disabled = state !== "paused";
  els.stop.disabled = state === "idle";
  // La vitesse est figée dans l'audio déjà synthétisé : la changer en cours de
  // route imposerait de tout regénérer. Elle s'applique à l'article suivant.
  els.speed.disabled = state !== "idle" && state !== "ended";
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
      const message = `Génération… ${event.done}/${event.total}${eta}`;
      // Une fois la lecture lancée, la génération continue en fond : elle n'a
      // plus à s'annoncer comme l'activité principale.
      if (currentState === "playing" || currentState === "paused") {
        els.stats.hidden = false;
        els.stats.textContent = message;
      } else {
        els.status.textContent = message;
      }
      break;
    }

    case "waiting":
      // La synthèse n'a pas suivi la lecture : c'est audible, autant le dire.
      els.status.textContent = "La génération n'a pas suivi : reprise dès que la suite est prête…";
      break;

    case "generation-done":
      els.stats.hidden = false;
      els.stats.textContent =
        `Son en ${formatTime(event.timeToFirstAudio)}, généré en ${formatTime(event.elapsed)} ` +
        `pour ${formatTime(event.audioSeconds)} d'audio — RTF ${event.rtf.toFixed(2)}` +
        (event.underruns ? ` — ${event.underruns} coupure(s)` : "");
      break;

    case "segment-start":
      els.segment.textContent = event.text;
      break;

    case "progress":
      els.position.textContent = formatTime(event.position);
      // Tant que la génération tourne, la durée affichée est celle du fichier
      // déjà produit, pas celle de l'article : le « + » l'annonce.
      els.duration.textContent = formatTime(event.duration) + (event.complete ? "" : " +");
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

els.speed.value = String(storedSpeed());
if (!els.speed.value) els.speed.value = String(DEFAULT_SPEED); // valeur stockée hors liste
els.speed.addEventListener("change", () => {
  try {
    localStorage.setItem(SPEED_KEY, els.speed.value);
  } catch {
    // Préférence non conservée : sans conséquence sur la lecture en cours.
  }
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
    await ttsService.load(segments, {
      lang: article.lang,
      title: article.title,
      speed: currentSpeed(),
    });
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
