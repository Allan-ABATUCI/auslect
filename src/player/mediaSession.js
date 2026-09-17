// Expose la lecture au système via la Media Session API : titre de l'article et
// contrôles play / pause / navigation sur l'écran verrouillé et le casque.

const available = () => typeof navigator !== "undefined" && "mediaSession" in navigator;

export function bindMediaSession(handlers) {
  if (!available()) return;

  const actions = {
    play: handlers.onPlay,
    pause: handlers.onPause,
    stop: handlers.onStop,
    previoustrack: handlers.onPrevious,
    nexttrack: handlers.onNext,
    seekbackward: handlers.onSeekBackward,
    seekforward: handlers.onSeekForward,
    seekto: handlers.onSeekTo,
  };

  for (const [action, handler] of Object.entries(actions)) {
    try {
      navigator.mediaSession.setActionHandler(action, handler ?? null);
    } catch {
      // Action non supportée par le navigateur : sans conséquence.
    }
  }
}

export function setMediaSessionMetadata({ title, artist }) {
  if (!available()) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: title || "Article",
    artist: artist || "Auslect",
  });
}

export function setMediaSessionPlaybackState(state) {
  if (!available()) return;
  navigator.mediaSession.playbackState = state;
}

export function setMediaSessionPosition({ duration, position, playbackRate = 1 }) {
  if (!available() || !Number.isFinite(duration) || duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration,
      position: Math.min(Math.max(position, 0), duration),
      playbackRate,
    });
  } catch {
    // Certaines combinaisons position/durée sont refusées pendant un seek : sans conséquence.
  }
}
