// Offline voice: Kokoro-82M running in-app via transformers.js (WebGPU, or ONNX/WASM on the CPU).
// Used when VoiceStudio is unreachable. The model and voices are downloaded from Hugging Face on
// first use and cached by the browser cache afterwards; text never leaves the computer.
import { StyleTextToSpeech2Model, AutoTokenizer, Tensor, env } from 'app://bundle/node_modules/@huggingface/transformers/dist/transformers.min.js';
import { KOKORO_MODEL, voiceUrl, toPhonemes, styleOffset, kokoroVoice } from './kokorotext.js';

env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.webgpu) env.backends.onnx.webgpu.powerPreference = 'high-performance';

let loading = null;
let device = '';
const styles = new Map();

function load() {
  loading ||= (async () => {
    const progress_callback = (p) => self.postMessage({ type: 'progress', ...p });
    // phonemizer is an optional dependency (npm install phonemizer); say so if it is missing.
    const url = 'app://bundle/node_modules/phonemizer/dist/phonemizer.js';
    const { phonemize } = await import(url).catch(async (err) => {
      const found = await fetch(url, { method: 'HEAD' }).then((r) => r.ok, () => false);
      throw found ? err : new Error('the "phonemizer" package is not installed (run: npm install phonemizer)');
    });
    const tokenizer = await AutoTokenizer.from_pretrained(KOKORO_MODEL, { progress_callback });
    const adapter = 'gpu' in navigator ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null) : null;
    let model;
    // Kokoro needs fp32 on WebGPU (fp16 garbles the audio); on the CPU the 8-bit model is fast enough.
    try {
      if (!adapter) throw new Error('no WebGPU adapter');
      model = await StyleTextToSpeech2Model.from_pretrained(KOKORO_MODEL, { device: 'webgpu', dtype: 'fp32', progress_callback });
      device = 'WebGPU';
    } catch (err) {
      model = await StyleTextToSpeech2Model.from_pretrained(KOKORO_MODEL, { dtype: 'q8', progress_callback });
      device = adapter ? `CPU (WASM; WebGPU failed: ${err.message})` : 'CPU (WASM)';
    }
    const engine = { model, tokenizer, phonemize };
    // The first run compiles the GPU kernels; do it now so the first spoken sentence isn't slow.
    await generate(engine, 'Ready.', 'af_heart', 1).catch(() => {});
    self.postMessage({ type: 'ready', device });
    return engine;
  })().catch((err) => {
    loading = null;
    throw err;
  });
  return loading;
}

async function style(voice) {
  if (styles.has(voice)) return styles.get(voice);
  const url = voiceUrl(voice);
  const cache = await caches.open('kokoro-voices').catch(() => null);
  let res = await cache?.match(url);
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`voice "${voice}" download failed (${res.status})`);
    await cache?.put(url, res.clone()).catch(() => {});
  }
  const data = new Float32Array(await res.arrayBuffer());
  styles.set(voice, data);
  return data;
}

async function generate({ model, tokenizer, phonemize }, text, voice, speed) {
  const phonemes = await toPhonemes(text, voice, phonemize);
  const { input_ids } = tokenizer(phonemes, { truncation: true });
  const offset = styleOffset(input_ids.dims.at(-1));
  const s = (await style(voice)).slice(offset, offset + 256);
  const { waveform } = await model({ input_ids, style: new Tensor('float32', s, [1, 256]), speed: new Tensor('float32', [speed], [1]) });
  return waveform.data;
}

// One sentence at a time: an ONNX session must not run twice at once.
let chain = Promise.resolve();

async function speak(msg) {
  try {
    const engine = await load();
    const samples = await generate(engine, msg.text, kokoroVoice(msg.voice), Number(msg.speed) || 1);
    // The model's output buffer may be shared with its tensor; send a copy we can transfer.
    const out = new Float32Array(samples);
    self.postMessage({ type: 'audio', id: msg.id, samples: out }, [out.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err.message });
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') load().catch((err) => self.postMessage({ type: 'error', message: err.message }));
  else if (msg.type === 'speak') chain = chain.then(() => speak(msg));
};
