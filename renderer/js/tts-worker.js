// Offline voice: Kokoro-82M running in-app via transformers.js (WebGPU, or ONNX/WASM on the CPU).
// Used when VoiceStudio is unreachable. The model and voices are downloaded from Hugging Face on
// first use and cached by the browser cache afterwards; text never leaves the computer.
import { StyleTextToSpeech2Model, AutoTokenizer, Tensor, env } from 'app://bundle/node_modules/@huggingface/transformers/dist/transformers.min.js';
import { KOKORO_MODEL, voiceUrl, toPhonemes, styleOffset, kokoroVoice } from './kokorotext.js';
// The worker's time origin is its creation: this is how long loading transformers.js took.
const importMs = Math.round(performance.now());
// The ONNX runtime comes from the app (node_modules/onnxruntime-web, the version transformers.js pins),
// not from a CDN: works offline and runs no code fetched at run time.
const ORT = 'app://bundle/node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify';
if (env.backends?.onnx?.wasm) env.backends.onnx.wasm.wasmPaths = { mjs: `${ORT}.mjs`, wasm: `${ORT}.wasm` };

env.allowLocalModels = false;
env.useBrowserCache = true;
if (env.backends?.onnx?.webgpu) env.backends.onnx.webgpu.powerPreference = 'high-performance';

let loading = null;
let device = '';
let allowGpu = true; // false: Balanced performance (the 8-bit model on the processor: 88 MB instead of 310)
const styles = new Map();

// Sentences are posted at once, even before the window's 'load' (GPU or not is known only after the
// hardware check): they wait for it, or one would load the 310 MB GPU model on a Balanced computer.
let askLoad;
const loadAsked = new Promise((r) => (askLoad = r));
let waiting = 0; // speak messages received and not finished
// A stop cancels the sentences not begun yet: every id up to cancelUpTo (keep ones, the phone's WAVs,
// never), and single ids that gave up waiting for the model.
let cancelUpTo = 0;
const dropped = new Set();

function load() {
  loading ||= (async () => {
    const progress_callback = (p) => self.postMessage({ type: 'progress', ...p });
    const t0 = performance.now();
    // phonemizer is an optional dependency (npm install phonemizer); say so if it is missing.
    const url = 'app://bundle/node_modules/phonemizer/dist/phonemizer.js';
    const { phonemize } = await import(url).catch(async (err) => {
      const found = await fetch(url, { method: 'HEAD' }).then((r) => r.ok, () => false);
      throw found ? err : new Error('the "phonemizer" package is not installed (run: npm install phonemizer)');
    });
    const t1 = performance.now();
    const tokenizer = await AutoTokenizer.from_pretrained(KOKORO_MODEL, { progress_callback });
    const t2 = performance.now();
    const adapter = allowGpu && 'gpu' in navigator ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null) : null;
    let model;
    // Kokoro needs fp32 on WebGPU (fp16 garbles the audio); on the CPU the 8-bit model is fast enough.
    try {
      if (!adapter) throw new Error('no WebGPU adapter');
      model = await StyleTextToSpeech2Model.from_pretrained(KOKORO_MODEL, { device: 'webgpu', dtype: 'fp32', progress_callback });
      // Which GPU it got (a laptop has two): the log's "offline voice ready" says, as speech recognition's does.
      const info = adapter.info || {};
      device = `WebGPU · ${[info.vendor, info.architecture, info.description].filter(Boolean).join(' ') || 'GPU'}`;
    } catch (err) {
      model = await StyleTextToSpeech2Model.from_pretrained(KOKORO_MODEL, { dtype: 'q8', progress_callback });
      device = adapter ? `CPU (WASM; WebGPU failed: ${err.message})` : 'CPU (WASM)';
    }
    const t3 = performance.now();
    const engine = { model, tokenizer, phonemize };
    // The first run compiles the GPU kernels: done now so the first spoken sentence isn't slow, unless
    // a sentence already waits (the launch greeting): then that sentence is the first run.
    const warmupSkipped = waiting > 0;
    if (!warmupSkipped) await generate(engine, 'Ready.', 'af_heart', 1).catch(() => {});
    const ms = (a, b) => Math.round(b - a);
    const timing = { importMs, phonemizerMs: ms(t0, t1), tokenizerMs: ms(t1, t2), sessionMs: ms(t2, t3), warmupMs: ms(t3, performance.now()), warmupSkipped };
    self.postMessage({ type: 'ready', device, timing });
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

// Where a sentence's time goes (voice.js logs the first ones after a load, with what the window was
// doing meanwhile): a short sentence took as long as a long one (0.8–2 s).
async function generate({ model, tokenizer, phonemize }, text, voice, speed) {
  const t0 = performance.now();
  const phonemes = await toPhonemes(text, voice, phonemize);
  const t1 = performance.now();
  const { input_ids } = tokenizer(phonemes, { truncation: true });
  const tokens = input_ids.dims.at(-1);
  const offset = styleOffset(tokens);
  const s = (await style(voice)).slice(offset, offset + 256);
  const t2 = performance.now();
  const { waveform } = await model({ input_ids, style: new Tensor('float32', s, [1, 256]), speed: new Tensor('float32', [speed], [1]) });
  const t3 = performance.now();
  const timing = { tokens, phonemeMs: Math.round(t1 - t0), modelMs: Math.round(t3 - t2), audioSec: +(waveform.data.length / 24000).toFixed(2) };
  return { samples: waveform.data, timing };
}

// One sentence at a time: an ONNX session must not run twice at once.
let chain = Promise.resolve();

const cancelled = (msg) => dropped.delete(msg.id) || (!msg.keep && msg.id <= cancelUpTo);
// Queued sentences follow each other as one chain of microtasks, and a run on the processor doesn't
// yield either: without a task boundary before the check, a 'cancel' that came meanwhile was read only
// after the sentences it cancelled had been made.
const nextTask = () => new Promise((r) => setTimeout(r, 0));

async function speak(msg) {
  try {
    await loadAsked;
    const engine = await load();
    await nextTask();
    if (cancelled(msg)) return void self.postMessage({ type: 'skipped', id: msg.id });
    // From here the window's run limit counts (ttsjobs.js); `ahead`: sentences waiting behind this one.
    const ahead = waiting - 1;
    self.postMessage({ type: 'begin', id: msg.id, ahead });
    const { samples, timing } = await generate(engine, msg.text, kokoroVoice(msg.voice), Number(msg.speed) || 1);
    // The model's output buffer may be shared with its tensor; send a copy we can transfer.
    const out = new Float32Array(samples);
    self.postMessage({ type: 'audio', id: msg.id, samples: out, timing: { ...timing, ahead } }, [out.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err.message });
  } finally {
    waiting--;
  }
}

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'load') {
    allowGpu = msg.gpu !== false;
    askLoad();
    load().catch((err) => self.postMessage({ type: 'error', message: err.message }));
  } else if (msg.type === 'speak') {
    waiting++;
    chain = chain.then(() => speak(msg));
  } else if (msg.type === 'cancel') {
    cancelUpTo = Math.max(cancelUpTo, Number(msg.upTo) || 0);
    for (const id of msg.ids || []) dropped.add(id);
  }
};
