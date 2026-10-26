// Neural voice-activity detection: Silero VAD (a tiny ONNX model, ~2 MB) via transformers.js.
// Takes raw mic frames at the AudioContext rate, resamples to 16 kHz, scores every 32 ms window
// and posts back the speech probability. Downloaded from Hugging Face once, then cached.
import { AutoModel, Tensor, env } from 'app://bundle/node_modules/@huggingface/transformers/dist/transformers.min.js';
// The ONNX runtime comes from the app (node_modules/onnxruntime-web, the version transformers.js pins),
// not from a CDN: works offline and runs no code fetched at run time.
const ORT = 'app://bundle/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify';
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = { mjs: `${ORT}.mjs`, wasm: `${ORT}.wasm` };

env.allowLocalModels = false;
env.useBrowserCache = true;

const WINDOW = 512; // samples per Silero window at 16 kHz
let model = null;
let loading = null;
let state = null;
let sr = null;
let pending = new Float32Array(0);
let phase = 0; // fractional read position carried between frames by the resampler
let last = 0;

function load() {
  loading ||= (async () => {
    model = await AutoModel.from_pretrained('onnx-community/silero-vad', { config: { model_type: 'custom' }, dtype: 'fp32', device: 'wasm' });
    sr = new Tensor('int64', [16000n], []);
    reset();
    self.postMessage({ type: 'ready' });
  })().catch((err) => {
    loading = null;
    self.postMessage({ type: 'error', error: err.message || String(err) });
  });
  return loading;
}

function reset() {
  state = new Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
  pending = new Float32Array(0);
  phase = 0;
}

// Linear-interpolation resampler to 16 kHz; the mic is already low-passed by the browser's processing.
function resample(samples, rate) {
  const step = rate / 16000;
  const n = Math.max(0, Math.floor((samples.length - 1 - phase) / step) + 1);
  const out = new Float32Array(n);
  let pos = phase;
  for (let i = 0; i < n; i++, pos += step) {
    const j = Math.floor(pos);
    const f = pos - j;
    out[i] = samples[j] * (1 - f) + (samples[j + 1] ?? samples[j]) * f;
  }
  phase = Math.max(0, pos - samples.length); // the sub-sample remainder; negligible at mic rates
  return out;
}

// Frames are scored strictly in order; one queue keeps the model's recurrent state consistent.
let chain = Promise.resolve();

async function score(samples, rate) {
  if (!model) return;
  const fresh = resample(samples, rate);
  const buf = new Float32Array(pending.length + fresh.length);
  buf.set(pending);
  buf.set(fresh, pending.length);
  let o = 0;
  for (; o + WINDOW <= buf.length; o += WINDOW) {
    const out = await model({ input: new Tensor('float32', buf.slice(o, o + WINDOW), [1, WINDOW]), sr, state });
    state = out.stateN;
    last = out.output.data[0];
  }
  pending = buf.slice(o);
  self.postMessage({ type: 'prob', prob: last });
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') load();
  else if (msg.type === 'reset') chain = chain.then(reset);
  else if (msg.type === 'frame') chain = chain.then(() => score(msg.samples, msg.rate)).catch((err) => self.postMessage({ type: 'error', error: err.message }));
};
