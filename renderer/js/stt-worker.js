// Local speech-to-text: Whisper running in-app via transformers.js (WebGPU, or ONNX/WASM on the CPU).
// The model is downloaded from Hugging Face on first use and cached by the browser cache afterwards.
import { pipeline, env } from 'app://bundle/node_modules/@huggingface/transformers/dist/transformers.min.js';

env.allowLocalModels = false;
// The ONNX runtime comes from the app (node_modules/onnxruntime-web, the version transformers.js pins),
// not from a CDN: works offline and runs no code fetched at run time.
const ORT = 'app://bundle/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify';
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = { mjs: `${ORT}.mjs`, wasm: `${ORT}.wasm` };
env.useBrowserCache = true;
// Prefer the dedicated GPU over integrated graphics (onnxruntime requests its own adapter).
if (env.backends?.onnx?.webgpu) env.backends.onnx.webgpu.powerPreference = 'high-performance';

let modelName = '';
let fallbackName = ''; // the processor's model when the GPU can't run modelName (sent by voice.js)
let allowGpu = true; // false: Balanced performance keeps the model on the processor
let running = ''; // the model actually loaded (a CPU fallback may differ from modelName)
let loading = null;
let device = '';

// Measured in Electron on WebGPU (RTX laptop GPU): an fp16 encoder with a 4-bit decoder makes
// whisper-large-v3-turbo transcribe a short sentence in ~0.4 s, about 10x faster than an all-fp32
// model and more accurate than small.en. Without fp16 support the encoder stays fp32.
function gpuDtype(adapter) {
  return { encoder_model: adapter.features.has('shader-f16') ? 'fp16' : 'fp32', decoder_model_merged: 'q4' };
}

// Large models are far too slow on the CPU; there a small model keeps replies usable.
const cpuModel = (name) => (/large/i.test(name) ? fallbackName || 'Xenova/whisper-base.en' : name);

function decodeOptions(name, language) {
  const englishOnly = /\.en$/i.test(name);
  return { chunk_length_s: 30, stride_length_s: 5, ...(englishOnly || !language ? {} : { language, task: 'transcribe' }) };
}

function load() {
  loading ||= (async () => {
    const progress_callback = (p) => self.postMessage({ type: 'progress', ...p });
    const adapter = allowGpu && 'gpu' in navigator ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null) : null;
    const info = adapter?.info || {};
    device = adapter ? `WebGPU · ${[info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'GPU'}` : allowGpu ? 'CPU (WASM)' : 'CPU (WASM, Balanced performance)';
    let asr;
    running = modelName;
    try {
      if (!adapter) throw new Error('no WebGPU adapter');
      // Without fp16 the large model's encoder would load in fp32: about 2.4 GB. Not worth it.
      if (/large/i.test(modelName) && !adapter.features.has('shader-f16')) throw new Error('no fp16 support for the large model');
      asr = await pipeline('automatic-speech-recognition', modelName, { device: 'webgpu', dtype: gpuDtype(adapter), progress_callback });
    } catch (err) {
      running = cpuModel(modelName);
      if (adapter) device = `CPU (WASM; WebGPU failed: ${err.message})`;
      asr = await pipeline('automatic-speech-recognition', running, { dtype: 'q8', progress_callback });
    }
    // The first run compiles the GPU kernels; do it now so the user's first sentence isn't slow.
    await asr(new Float32Array(16000), decodeOptions(running, 'en')).catch(() => {});
    self.postMessage({ type: 'ready', device, model: running });
    return asr;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    modelName = msg.model;
    fallbackName = msg.fallback || '';
    allowGpu = msg.gpu !== false;
    load().catch((err) => self.postMessage({ type: 'progress', status: 'error', error: err.message }));
    return;
  }
  if (msg.type === 'transcribe') {
    try {
      const asr = await load();
      const out = await asr(msg.audio, decodeOptions(running, msg.language));
      self.postMessage({ id: msg.id, text: (Array.isArray(out) ? out[0]?.text : out?.text) || '' });
    } catch (err) {
      self.postMessage({ id: msg.id, error: err.message });
    }
  }
};
