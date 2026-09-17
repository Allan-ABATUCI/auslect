// D'où vient le temps de génération ? Sépare la phonémisation de l'inférence, et
// compare un découpage par phrase (beaucoup de petits appels) à un découpage par
// paragraphe (peu de gros appels).
//
//   node tests/piper-profile.js [voix]
import { phonemize } from "phonemizer";
import * as ort from "onnxruntime-node";
import { readFileSync, existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DOMParser } from "linkedom";
import { segmentArticle } from "../src/lib/segmenter.js";

globalThis.DOMParser = DOMParser;

const VOICE = process.argv[2] ?? "en_US-lessac-medium";
const CACHE_DIR = "diagnostic/models";

// Texte générique, proche d'un chapitre en longueur de phrases.
const PARAGRAPHS = [
  "The morning air was cold enough to sting. He pulled his coat tighter and stepped into the street. Nothing moved. The lamps were still burning, pale against a sky that had not quite decided to be blue.",
  "She had told him to wait by the bridge. He had agreed without asking why, which was, he thought later, the first mistake of many. The river below ran fast and brown after the rain.",
  "A bell rang somewhere behind the rooftops. He counted the strokes out of habit and lost track after the fourth. Somewhere a door opened, then closed again, and the quiet came back heavier than before.",
  "By the time the sun cleared the hills, the square had filled with people who all seemed to know where they were going. He did not. He stood there a while longer, watching, and then he followed the crowd.",
];

function splitSentences(text) {
  return text
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function toPhonemeIds(phonemes, map) {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const ids = [...map["^"]];
  for (let i = 0; i < phonemes.length; ) {
    const key = keys.find((k) => k.length > 0 && phonemes.startsWith(k, i));
    if (!key) {
      i += 1;
      continue;
    }
    ids.push(...map[key], ...map["_"]);
    i += key.length;
  }
  ids.push(...map["$"]);
  return ids;
}

async function run(session, config, chunks, label) {
  let phonemeTime = 0;
  let inferTime = 0;
  let audioSeconds = 0;

  for (const text of chunks) {
    const t0 = performance.now();
    const phonemes = (await phonemize(text, config.espeak.voice)).join(" ");
    const ids = toPhonemeIds(phonemes, config.phoneme_id_map);
    phonemeTime += (performance.now() - t0) / 1000;

    const { noise_scale = 0.667, length_scale = 1, noise_w = 0.8 } = config.inference ?? {};
    const t1 = performance.now();
    const output = await session.run({
      input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor("float32", Float32Array.from([noise_scale, length_scale, noise_w]), [3]),
    });
    inferTime += (performance.now() - t1) / 1000;
    audioSeconds += output[Object.keys(output)[0]].data.length / config.audio.sample_rate;
  }

  const total = phonemeTime + inferTime;
  console.log(
    `${label.padEnd(26)} ${String(chunks.length).padStart(3)} appels | ` +
      `phonèmes ${phonemeTime.toFixed(2)}s (${Math.round((phonemeTime / total) * 100)} %) | ` +
      `inférence ${inferTime.toFixed(2)}s | total ${total.toFixed(2)}s | ` +
      `RTF ${(total / audioSeconds).toFixed(3)}`,
  );
  return total;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const modelPath = `${CACHE_DIR}/${VOICE}.onnx`;
  if (!existsSync(modelPath)) {
    console.error(`Modèle absent : ${modelPath}\nLancez d'abord: node tests/piper-bench.js ${VOICE}`);
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(`${CACHE_DIR}/${VOICE}.onnx.json`, "utf8"));
  const session = await ort.InferenceSession.create(modelPath);

  const sentences = PARAGRAPHS.flatMap(splitSentences);
  console.log(`Voix ${VOICE} — ${PARAGRAPHS.length} paragraphes, ${sentences.length} phrases\n`);

  // Ce que produit réellement le segmenter de l'extension.
  const html = PARAGRAPHS.map((p) => `<p>${p}</p>`).join("");
  const grouped = segmentArticle(html).map((s) => s.text);

  const bySentence = await run(session, config, sentences, "une phrase par appel");
  const byGrouped = await run(session, config, grouped, "segmenter du projet");

  console.log(
    `\n${sentences.length} appels → ${grouped.length} : ` +
      `×${(bySentence / byGrouped).toFixed(2)} plus rapide ` +
      `(${Math.round((1 - byGrouped / bySentence) * 100)} % de temps en moins)`,
  );
}
