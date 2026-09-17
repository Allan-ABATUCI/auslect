// Banc d'essai Piper (VITS) : vitesse, qualité de signal et voix française.
// Le RTF (temps de calcul / durée audio produite) doit rester sous 1 pour que la
// génération reste supportable sur un long chapitre.
//
//   node tests/piper-bench.js [voix]
//   ex. node tests/piper-bench.js fr_FR-siwis-medium
import { phonemize } from "phonemizer";
import * as ort from "onnxruntime-node";
import { mkdirSync, existsSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { encodeWav } from "../src/lib/wav.js";
import { analyseSignal } from "./signal.js";

const VOICE = process.argv[2] ?? "fr_FR-siwis-medium";
const CACHE_DIR = "diagnostic/models";
const BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main";

// Phrases de longueurs variées, pour que le RTF ne dépende pas d'un cas isolé.
const SEGMENTS = {
  en: [
    "Life is like a box of chocolates.",
    "You never know what you're gonna get, but you keep reaching in anyway.",
    "The quick brown fox jumps over the lazy dog near the river bank.",
    "Artificial intelligence has changed how we think about language and speech synthesis.",
    "Short one.",
    "Another moderately long sentence to balance the measurement across segment lengths.",
  ],
  fr: [
    "La vie est comme une boîte de chocolats.",
    "On ne sait jamais sur quoi on va tomber, mais on y plonge la main quand même.",
    "Le renard brun et rapide saute par-dessus le chien paresseux près de la rivière.",
    "L'intelligence artificielle a changé notre façon de penser le langage et la synthèse vocale.",
    "Court.",
    "Une autre phrase de longueur moyenne, pour équilibrer la mesure entre segments.",
  ],
};

/** fr_FR-siwis-medium -> fr/fr_FR/siwis/medium/fr_FR-siwis-medium */
function remotePath(voice) {
  const [lang, name, quality] = voice.split("-");
  return `${lang.split("_")[0]}/${lang}/${name}/${quality}/${voice}`;
}

async function download(url, destination) {
  if (existsSync(destination)) return destination;
  process.stdout.write(`Téléchargement ${url.split("/").pop()}… `);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} sur ${url}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
  console.log(`${(statSync(destination).size / 1e6).toFixed(1)} Mo`);
  return destination;
}

/**
 * Piper attend des identifiants de phonèmes, encadrés par ^ et $, avec le
 * séparateur _ intercalé après chaque phonème. Les clés du tableau de
 * correspondance peuvent faire plusieurs caractères (diacritiques IPA), d'où le
 * choix du plus long motif qui correspond.
 */
function toPhonemeIds(phonemes, map) {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const ids = [...map["^"]];
  let unknown = 0;

  for (let i = 0; i < phonemes.length; ) {
    const key = keys.find((k) => k.length > 0 && phonemes.startsWith(k, i));
    if (!key) {
      unknown += 1;
      i += 1;
      continue;
    }
    ids.push(...map[key], ...map["_"]);
    i += key.length;
  }

  ids.push(...map["$"]);
  return { ids, unknown };
}

async function synthesize(session, config, text) {
  const phonemes = (await phonemize(text, config.espeak.voice)).join(" ");
  const { ids, unknown } = toPhonemeIds(phonemes, config.phoneme_id_map);

  const { noise_scale = 0.667, length_scale = 1, noise_w = 0.8 } = config.inference ?? {};
  const feeds = {
    input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor("float32", Float32Array.from([noise_scale, length_scale, noise_w]), [3]),
  };

  const output = await session.run(feeds);
  const samples = output[Object.keys(output)[0]].data;
  return { samples, unknown, phonemes };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(CACHE_DIR, { recursive: true });

  const remote = remotePath(VOICE);
  const modelPath = await download(`${BASE_URL}/${remote}.onnx`, `${CACHE_DIR}/${VOICE}.onnx`);
  const configPath = await download(`${BASE_URL}/${remote}.onnx.json`, `${CACHE_DIR}/${VOICE}.onnx.json`);

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const sampleRate = config.audio.sample_rate;
  console.log(
    `\nVoix ${VOICE} — ${(statSync(modelPath).size / 1e6).toFixed(1)} Mo, ${sampleRate} Hz, espeak "${config.espeak.voice}"`,
  );

  const session = await ort.InferenceSession.create(modelPath);

  let totalTime = 0;
  let totalAudio = 0;
  let totalUnknown = 0;
  const chunks = [];

  const segments = SEGMENTS[config.espeak.voice.split("-")[0]] ?? SEGMENTS.en;

  console.log("\n--- séquentiel ---");
  for (const text of segments) {
    const start = performance.now();
    const { samples, unknown } = await synthesize(session, config, text);
    const elapsed = (performance.now() - start) / 1000;
    const duration = samples.length / sampleRate;

    totalTime += elapsed;
    totalAudio += duration;
    totalUnknown += unknown;
    chunks.push(samples);

    console.log(`  ${elapsed.toFixed(2)}s pour ${duration.toFixed(2)}s d'audio (RTF ${(elapsed / duration).toFixed(3)})`);
  }

  const rtf = totalTime / totalAudio;
  console.log(`TOTAL : ${totalTime.toFixed(2)}s pour ${totalAudio.toFixed(2)}s d'audio`);
  console.log(`RTF global : ${rtf.toFixed(3)}`);
  console.log(`=> 10 min d'audio ≈ ${((rtf * 600) / 60).toFixed(1)} min de génération`);
  if (totalUnknown > 0) console.log(`⚠ ${totalUnknown} caractère(s) de phonème non reconnus`);

  console.table(analyseSignal(concat(chunks), sampleRate));

  const out = `diagnostic/piper-${VOICE}.wav`;
  writeFileSync(out, Buffer.from(await encodeWav(chunks, sampleRate).arrayBuffer()));
  console.log(`Écrit : ${out}`);
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}
