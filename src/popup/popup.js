// Télécommande : lance l'extraction et pilote l'onglet lecteur, qui est le seul
// à produire du son. Tout l'état vit là-bas.
const els = {
  title: document.getElementById("title"),
  status: document.getElementById("status"),
  progress: document.getElementById("progress"),
  play: document.getElementById("btn-play"),
  pause: document.getElementById("btn-pause"),
  resume: document.getElementById("btn-resume"),
  stop: document.getElementById("btn-stop"),
  stats: document.getElementById("stats"),
};

const STATE_LABELS = {
  idle: "Prêt.",
  generating: "Génération de l'audio…",
  playing: "Lecture en cours…",
  paused: "En pause.",
  ended: "Lecture terminée.",
};

let currentState = "idle";

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function applyState(state) {
  currentState = state;
  els.status.textContent = STATE_LABELS[state] ?? state;

  els.play.disabled = state === "playing" || state === "generating";
  els.pause.disabled = state !== "playing";
  els.resume.disabled = state !== "paused";
  els.stop.disabled = state === "idle";

  if (state !== "generating") els.progress.hidden = true;
}

function showProgress(value, max, label) {
  els.progress.hidden = false;
  els.progress.max = max;
  els.progress.value = value;
  els.status.textContent = label;
}

function send(type, payload = {}) {
  return browser.runtime.sendMessage({ type, ...payload }).catch(() => null);
}

els.play.addEventListener("click", () => {
  els.status.textContent = "Extraction de l'article…";
  send("PLAY_REQUEST");
});
els.pause.addEventListener("click", () => send("PAUSE_REQUEST"));
els.resume.addEventListener("click", () => send("RESUME_REQUEST"));
els.stop.addEventListener("click", () => send("STOP_REQUEST"));

browser.runtime.onMessage.addListener((message) => {
  if (message?.type !== "PLAYER_EVENT") return;
  const event = message.event;

  switch (event.type) {
    case "state-change":
      applyState(event.state);
      break;

    case "model-progress":
      showProgress(
        event.loaded,
        event.total,
        `Téléchargement du modèle… ${Math.round((event.loaded / event.total) * 100)} %`,
      );
      break;

    case "generation-progress": {
      const eta = event.remainingSeconds > 1 ? ` — ~${formatTime(event.remainingSeconds)} restantes` : "";
      showProgress(event.done, event.total, `Génération… ${event.done}/${event.total}${eta}`);
      break;
    }

    case "generation-done":
      els.stats.hidden = false;
      els.stats.textContent =
        `Généré en ${formatTime(event.elapsed)} pour ${formatTime(event.audioSeconds)} d'audio — RTF ${event.rtf.toFixed(2)}` +
        // Des coupures signifient que la synthèse n'a pas suivi la lecture.
        (event.underruns ? ` — ${event.underruns} coupure(s)` : "");
      break;

    case "progress":
      if (currentState === "playing") {
        els.status.textContent = `${formatTime(event.position)} / ${formatTime(event.duration)}`;
      }
      break;

    case "engine-fallback":
      els.status.textContent = event.reason;
      break;

    case "error":
      els.progress.hidden = true;
      els.status.textContent = `Erreur : ${event.message ?? "inconnue"}`;
      break;

    default:
      break;
  }
});

// État courant : il vit dans l'onglet lecteur, qui peut ne pas être ouvert.
send("GET_STATE").then((snapshot) => {
  if (!snapshot) return; // aucun lecteur ouvert
  if (snapshot.title) {
    els.title.hidden = false;
    els.title.textContent = snapshot.title;
  }
  applyState(snapshot.state);
});
