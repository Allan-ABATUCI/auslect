// Assemblage des segments PCM en un seul fichier WAV 16 bits.
//
// Un fichier unique plutôt qu'un blob par segment : <audio> expose alors une vraie
// timeline (durée totale, seek), indispensable pour la Media Session et les
// contrôles sur l'écran verrouillé.

const BYTES_PER_SAMPLE = 2;
const HEADER_SIZE = 44;

export function encodeWav(chunks, sampleRate) {
  const sampleCount = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const dataSize = sampleCount * BYTES_PER_SAMPLE;
  const view = new DataView(new ArrayBuffer(HEADER_SIZE + dataSize));

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // taille du bloc fmt
  view.setUint16(20, 1, true); // PCM non compressé
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // octets par seconde
  view.setUint16(32, BYTES_PER_SAMPLE, true); // alignement de bloc
  view.setUint16(34, 16, true); // bits par échantillon
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = HEADER_SIZE;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      const sample = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return new Blob([view.buffer], { type: "audio/wav" });
}

/** Silence servant de respiration entre deux segments. */
export function silence(seconds, sampleRate) {
  return new Float32Array(Math.round(seconds * sampleRate));
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
