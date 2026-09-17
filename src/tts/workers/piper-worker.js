// Inférence Piper (VITS) isolée dans un worker.
//
// Piper attend des identifiants de phonèmes, pas du texte : la chaîne est donc
// texte → phonèmes IPA (eSpeak compilé en WASM) → identifiants → modèle ONNX.
// Le modèle et sa configuration viennent du dépôt Piper sur Hugging Face (CORS
// ouvert, donc aucune host_permission) et sont mis en cache par le navigateur.
import * as ort from "onnxruntime-web/wasm";
import { phonemize } from "phonemizer";

const BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main";
const CACHE_NAME = "auslect-piper";

let session = null;
let config = null;

/** fr_FR-siwis-medium -> fr/fr_FR/siwis/medium/fr_FR-siwis-medium */
function remotePath(voice) {
  const [lang, name, quality] = voice.split("-");
  return `${lang.split("_")[0]}/${lang}/${name}/${quality}/${voice}`;
}

/** Télécharge en signalant la progression, et sert depuis le cache si possible. */
async function fetchCached(url, onProgress) {
  let cache = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return hit.arrayBuffer();
  } catch {
    // Cache indisponible : on retombe sur un téléchargement simple.
  }

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Téléchargement impossible (${response.status})`);

  const total = Number(response.headers.get("content-length")) || 0;
  const chunks = [];
  let loaded = 0;

  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total);
  }

  const buffer = new Blob(chunks).arrayBuffer();
  const bytes = await buffer;
  try {
    await cache?.put(url, new Response(bytes.slice(0), { headers: response.headers }));
  } catch {
    // Mise en cache refusée (quota) : sans conséquence sur cette session.
  }
  return bytes;
}

async function init({ voice, wasmPath }) {
  // ORT chercherait son runtime sur un CDN : interdit par la CSP de l'extension.
  ort.env.wasm.wasmPaths = wasmPath;
  // Pas de SharedArrayBuffer sans en-têtes COOP/COEP : inférence mono-thread.
  ort.env.wasm.numThreads = 1;

  const remote = remotePath(voice);

  const configBytes = await fetchCached(`${BASE_URL}/${remote}.onnx.json`);
  config = JSON.parse(new TextDecoder().decode(configBytes));

  const modelBytes = await fetchCached(`${BASE_URL}/${remote}.onnx`, (loaded, total) =>
    self.postMessage({ type: "progress", loaded, total }),
  );

  session = await ort.InferenceSession.create(modelBytes);
}

/**
 * Encode les phonèmes : séquence encadrée par ^ et $, séparateur _ intercalé.
 * Les clés du tableau de correspondance peuvent faire plusieurs caractères
 * (diacritiques IPA), d'où le choix du plus long motif qui correspond.
 */
function toPhonemeIds(phonemes, map) {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const ids = [...map["^"]];

  for (let i = 0; i < phonemes.length; ) {
    const key = keys.find((k) => k.length > 0 && phonemes.startsWith(k, i));
    if (!key) {
      i += 1; // caractère hors inventaire : ignoré plutôt que de casser la phrase
      continue;
    }
    ids.push(...map[key], ...map["_"]);
    i += key.length;
  }

  ids.push(...map["$"]);
  return ids;
}

async function synthesize(text, speed) {
  const phonemes = (await phonemize(text, config.espeak.voice)).join(" ");
  const ids = toPhonemeIds(phonemes, config.phoneme_id_map);

  const { noise_scale = 0.667, length_scale = 1, noise_w = 0.8 } = config.inference ?? {};
  const output = await session.run({
    input: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor(
      "float32",
      Float32Array.from([noise_scale, length_scale / speed, noise_w]),
      [3],
    ),
  });

  const data = output[Object.keys(output)[0]].data;
  // slice() détache les échantillons : transférables sans copie.
  return { samples: data.slice(), sampleRate: config.audio.sample_rate };
}

self.onmessage = async ({ data }) => {
  try {
    switch (data.type) {
      case "init":
        await init(data);
        self.postMessage({ type: "ready" });
        break;

      case "synthesize": {
        if (!session) throw new Error("Moteur non initialisé.");
        const { samples, sampleRate } = await synthesize(data.text, data.speed ?? 1);
        self.postMessage({ type: "audio", requestId: data.requestId, samples, sampleRate }, [
          samples.buffer,
        ]);
        break;
      }

      default:
        break;
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      requestId: data?.requestId,
      message: String(error?.message ?? error),
    });
  }
};
