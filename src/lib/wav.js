// Assemblage des segments PCM en un seul fichier WAV 16 bits.
//
// Un fichier unique plutôt qu'un blob par segment : <audio> expose alors une vraie
// timeline (durée totale, seek), indispensable pour la Media Session et les
// contrôles sur l'écran verrouillé.
//
// La lecture par lots republie le fichier plusieurs fois, en l'allongeant à
// chaque fois. Les segments sont donc conservés déjà quantifiés en 16 bits
// (`toPcm16`) : deux fois moins de mémoire que du Float32, et aucune
// reconversion des minutes déjà encodées à chaque republication.

const BYTES_PER_SAMPLE = 2;
const HEADER_SIZE = 44;

/** Quantifie un bloc Float32 (-1..1) en PCM 16 bits, avec écrêtage. */
export function toPcm16(samples) {
  if (samples instanceof Int16Array) return samples;

  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return pcm;
}

/**
 * @param {Array<Float32Array|Int16Array>} chunks segments dans l'ordre de lecture
 * @returns {Blob} fichier WAV complet
 */
export function encodeWav(chunks, sampleRate) {
  const pcmChunks = chunks.map(toPcm16);
  const sampleCount = pcmChunks.reduce((total, chunk) => total + chunk.length, 0);
  const dataSize = sampleCount * BYTES_PER_SAMPLE;
  const header = new DataView(new ArrayBuffer(HEADER_SIZE));

  writeAscii(header, 0, "RIFF");
  header.setUint32(4, 36 + dataSize, true);
  writeAscii(header, 8, "WAVE");
  writeAscii(header, 12, "fmt ");
  header.setUint32(16, 16, true); // taille du bloc fmt
  header.setUint16(20, 1, true); // PCM non compressé
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true); // octets par seconde
  header.setUint16(32, BYTES_PER_SAMPLE, true); // alignement de bloc
  header.setUint16(34, 16, true); // bits par échantillon
  writeAscii(header, 36, "data");
  header.setUint32(40, dataSize, true);

  // Le Blob assemble les morceaux lui-même : pas besoin d'allouer d'un coup les
  // ~80 Mo d'un chapitre entier dans un ArrayBuffer contigu.
  return new Blob([header, ...pcmChunks], { type: "audio/wav" });
}

/** Silence servant de respiration entre deux segments. */
export function silence(seconds, sampleRate) {
  return new Int16Array(Math.round(seconds * sampleRate));
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}
