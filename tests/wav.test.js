// L'encodeur WAV est le suspect naturel quand le son sort en bruit : ces tests
// vérifient l'entête octet par octet et le round-trip d'un signal connu.
import test from "node:test";
import assert from "node:assert/strict";
import { encodeWav, silence } from "../src/lib/wav.js";

const SAMPLE_RATE = 24000;

async function readBack(blob) {
  return new DataView(await blob.arrayBuffer());
}

function sine(frequency, seconds, sampleRate = SAMPLE_RATE) {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = 0.5 * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return samples;
}

function ascii(view, offset, length) {
  return Array.from({ length }, (_, i) => String.fromCharCode(view.getUint8(offset + i))).join("");
}

test("l'entête décrit un PCM 16 bits mono cohérent", async () => {
  const samples = sine(440, 0.1);
  const view = await readBack(encodeWav([samples], SAMPLE_RATE));

  assert.equal(ascii(view, 0, 4), "RIFF");
  assert.equal(ascii(view, 8, 4), "WAVE");
  assert.equal(ascii(view, 12, 4), "fmt ");
  assert.equal(ascii(view, 36, 4), "data");

  assert.equal(view.getUint16(20, true), 1, "format PCM");
  assert.equal(view.getUint16(22, true), 1, "mono");
  assert.equal(view.getUint32(24, true), SAMPLE_RATE);
  assert.equal(view.getUint32(28, true), SAMPLE_RATE * 2, "octets par seconde");
  assert.equal(view.getUint16(32, true), 2, "alignement de bloc");
  assert.equal(view.getUint16(34, true), 16, "bits par échantillon");

  const dataSize = samples.length * 2;
  assert.equal(view.getUint32(40, true), dataSize, "taille du bloc data");
  assert.equal(view.getUint32(4, true), 36 + dataSize, "taille RIFF");
  assert.equal(view.byteLength, 44 + dataSize, "taille totale du fichier");
});

test("un signal encodé puis relu reste le même signal", async () => {
  const samples = sine(440, 0.05);
  const view = await readBack(encodeWav([samples], SAMPLE_RATE));

  let maxError = 0;
  for (let i = 0; i < samples.length; i++) {
    const decoded = view.getInt16(44 + i * 2, true) / 0x7fff;
    maxError = Math.max(maxError, Math.abs(decoded - samples[i]));
  }

  // Seule la quantification 16 bits doit introduire une erreur (~3e-5).
  assert.ok(maxError < 0.001, `écart maximal trop élevé : ${maxError}`);
});

test("les segments sont concaténés dans l'ordre, sans perte", async () => {
  const first = sine(440, 0.02);
  const second = sine(880, 0.02);
  const view = await readBack(encodeWav([first, second], SAMPLE_RATE));

  assert.equal(view.getUint32(40, true), (first.length + second.length) * 2);

  const boundary = 44 + first.length * 2;
  const lastOfFirst = view.getInt16(boundary - 2, true) / 0x7fff;
  const firstOfSecond = view.getInt16(boundary, true) / 0x7fff;

  assert.ok(Math.abs(lastOfFirst - first.at(-1)) < 0.001);
  assert.ok(Math.abs(firstOfSecond - second[0]) < 0.001);
});

test("les valeurs hors bornes sont écrêtées au lieu de boucler", async () => {
  // Sans écrêtage, un dépassement repasse en négatif via setInt16 : c'est
  // exactement ce qui transforme un signal fort en grésillement.
  const view = await readBack(encodeWav([new Float32Array([2, -2])], SAMPLE_RATE));

  assert.equal(view.getInt16(44, true), 0x7fff);
  assert.equal(view.getInt16(46, true), -0x8000);
});

test("silence() produit la bonne durée de zéros", () => {
  const samples = silence(0.5, SAMPLE_RATE);
  assert.equal(samples.length, SAMPLE_RATE / 2);
  assert.ok(samples.every((value) => value === 0));
});
