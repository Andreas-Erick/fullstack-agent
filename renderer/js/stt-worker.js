// Local speech-to-text: Whisper running in-app via transformers.js (ONNX/WASM, or WebGPU when available).
// The model is downloaded from Hugging Face on first use and cached by the browser cache afterwards.
import { pipeline, env } from 'app://bundle/node_modules/@huggingface/transformers/dist/transformers.min.js';

env.allowLocalModels = false;
env.useBrowserCache = true;

let modelName = '';
let loading = null;

function load() {
  loading ||= (async () => {
    const progress_callback = (p) => self.postMessage({ type: 'progress', ...p });
    const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter().catch(() => null) : null;
    let asr;
    try {
      asr = await pipeline('automatic-speech-recognition', modelName, adapter ? { device: 'webgpu', dtype: 'fp32', progress_callback } : { dtype: 'q8', progress_callback });
    } catch (err) {
      if (!adapter) throw err;
      asr = await pipeline('automatic-speech-recognition', modelName, { dtype: 'q8', progress_callback });
    }
    self.postMessage({ type: 'ready' });
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
    load().catch((err) => self.postMessage({ type: 'progress', status: 'error', error: err.message }));
    return;
  }
  if (msg.type === 'transcribe') {
    try {
      const asr = await load();
      const englishOnly = /\.en$/i.test(modelName);
      const out = await asr(msg.audio, {
        chunk_length_s: 30,
        stride_length_s: 5,
        ...(englishOnly || !msg.language ? {} : { language: msg.language, task: 'transcribe' }),
      });
      self.postMessage({ id: msg.id, text: (Array.isArray(out) ? out[0]?.text : out?.text) || '' });
    } catch (err) {
      self.postMessage({ id: msg.id, error: err.message });
    }
  }
};
