// Bundle les scripts de l'extension avec esbuild, puis copie les fichiers
// statiques et le runtime ONNX dans dist/.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";

const outdir = "dist";
const target = "firefox140";

// ONNX Runtime va chercher ces fichiers sur un CDN par défaut, ce que la CSP de
// l'extension interdit : on les embarque et le worker repointe wasmPaths dessus.
// Variante sans JSEP : le support WebGPU ferait 7 Mo de plus pour rien, le
// backend n'étant pas fiable sur Gecko.
const ORT_RUNTIME_DIR = "node_modules/onnxruntime-web/dist";
const ORT_RUNTIME_FILES = ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

if (existsSync(outdir)) rmSync(outdir, { recursive: true });
mkdirSync(`${outdir}/ort`, { recursive: true });

// Content script : injecté dans la page, doit rester un script classique (pas un module ES).
await build({
  entryPoints: ["src/content/content-script.js"],
  outfile: `${outdir}/content-script.js`,
  bundle: true,
  format: "iife",
  target,
});

// Background : module ES, héberge le TTSService (singleton) et l'élément <audio>.
await build({
  entryPoints: ["src/background/background.js"],
  outfile: `${outdir}/background.js`,
  bundle: true,
  format: "esm",
  target,
});

// Popup : module ES, chargé par popup.html.
await build({
  entryPoints: ["src/popup/popup.js"],
  outfile: `${outdir}/popup.js`,
  bundle: true,
  format: "esm",
  target,
});

// Page lecteur : héberge le TTSService et produit le son dans un onglet.
await build({
  entryPoints: ["src/player-page/player.js"],
  outfile: `${outdir}/player.js`,
  bundle: true,
  format: "esm",
  target,
});

// Worker Piper : module ES (ONNX Runtime charge son runtime par import dynamique).
await build({
  entryPoints: ["src/tts/workers/piper-worker.js"],
  outfile: `${outdir}/piper-worker.js`,
  bundle: true,
  format: "esm",
  platform: "browser",
  target,
});

cpSync("manifest.json", `${outdir}/manifest.json`);
cpSync("src/popup/popup.html", `${outdir}/popup.html`);
cpSync("src/popup/popup.css", `${outdir}/popup.css`);
cpSync("src/player-page/player.html", `${outdir}/player.html`);
cpSync("src/player-page/player.css", `${outdir}/player.css`);

for (const file of ORT_RUNTIME_FILES) {
  cpSync(`${ORT_RUNTIME_DIR}/${file}`, `${outdir}/ort/${file}`);
}

console.log("Build terminé →", outdir);
