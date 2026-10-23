// Voice I/O: VoiceStudio playback (sentence-chunked, in order, with the OS voice as fallback),
// microphone capture (push-to-talk or hands-free with voice-activity detection), speech-to-text.
import { api, emit, speakable, toastError, logEvent } from './util.js';
import { state, setFlag, setCaption } from './state.js';

let audioCtx = null;
export function ctx() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    state.analyser = audioCtx.createAnalyser();
    state.analyser.fftSize = 512;
    state.analyser.smoothingTimeConstant = 0.75;
    state.analyser.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// ----------------------------------------------------------------- Speaker
class Speaker {
  constructor() {
    this.queue = []; // [{ text, audio: Promise<AudioBuffer|'system'|null> }]
    this.gen = 0;
    this.source = null;
    this.buffer = '';
    this.running = false;
    this.useSystemVoice = false; // set after VoiceStudio fails; retried periodically
    this.lastSpokeAt = 0;
  }

  say(text, override) {
    this.stop();
    for (const s of splitSentences(speakable(text), true)) this.enqueue(s, override);
  }

  feed(delta) {
    this.buffer += delta;
    const { done, rest } = takeSentences(this.buffer);
    this.buffer = rest;
    for (const s of done) this.enqueue(speakable(s));
  }

  flush() {
    const s = speakable(this.buffer);
    this.buffer = '';
    if (s) this.enqueue(s);
  }

  // Short line while tools run, so a pause never feels like a dead line. Skipped if already talking.
  filler(text) {
    if (this.busy || Date.now() - this.lastSpokeAt < 4000) return;
    this.enqueue(text);
  }

  enqueue(text, override) {
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
    const gen = this.gen;
    const audio = this.synthesize(text, override, gen);
    this.queue.push({ text, audio, gen });
    this.pump();
  }

  async synthesize(text, override, gen) {
    const v = state.settings.voice;
    if (this.useSystemVoice && Date.now() - this.fallbackSince < 120000) return 'system';
    try {
      const { audio } = await api.tts.speak(text, override);
      const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
      const buf = await ctx().decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      if (this.useSystemVoice) logEvent('info', 'VoiceStudio back online');
      this.useSystemVoice = false;
      return buf;
    } catch (err) {
      if (gen !== this.gen) return null;
      logEvent('warn', 'VoiceStudio failed', err.message);
      if (v.fallbackSystemVoice && 'speechSynthesis' in window) {
        if (!this.useSystemVoice && !state.setupMode) {
          toastError(new Error(`VoiceStudio unavailable — using the system voice. (${err.message})`));
          emit('voice-fallback', err.message);
        }
        this.useSystemVoice = true;
        this.fallbackSince = Date.now();
        return 'system';
      }
      this.reportError(err);
      return null;
    }
  }

  reportError(err) {
    const now = Date.now();
    if (now - (this.lastErr || 0) > 8000) toastError(new Error(`Voice: ${err.message}`));
    this.lastErr = now;
  }

  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const item = this.queue.shift();
      if (item.gen !== this.gen) continue;
      const buf = await item.audio;
      if (!buf || item.gen !== this.gen) continue;
      setFlag('playing', true);
      setCaption(item.text, 'assistant');
      if (buf === 'system') await this.playSystem(item.text);
      else {
        await new Promise((resolve) => {
          const src = ctx().createBufferSource();
          src.buffer = buf;
          src.connect(state.analyser);
          src.onended = resolve;
          this.source = src;
          src.start();
        });
      }
      this.source = null;
      this.lastSpokeAt = Date.now();
    }
    this.running = false;
    setFlag('playing', false);
    emit('speech-idle');
  }

  // OS speech synthesis fallback. The face gets a synthetic level so it still "speaks".
  playSystem(text) {
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = Number(state.settings.voice.speed) || 1;
      const voices = speechSynthesis.getVoices();
      const want = (state.settings.voice.voice || '').toLowerCase();
      u.voice = voices.find((v) => want && v.name.toLowerCase().includes(want)) || voices.find((v) => v.default) || null;
      let t = 0;
      const pulse = setInterval(() => (state.synthLevel = 0.35 + 0.35 * Math.abs(Math.sin((t += 0.6)))), 80);
      const done = () => {
        clearInterval(pulse);
        state.synthLevel = 0;
        resolve();
      };
      u.onend = done;
      u.onerror = done;
      this.source = { stop: () => speechSynthesis.cancel() };
      speechSynthesis.speak(u);
    });
  }

  stop() {
    this.gen++;
    this.queue = [];
    this.buffer = '';
    try {
      this.source?.stop();
    } catch {
      /* already stopped */
    }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.source = null;
    setFlag('playing', false);
  }

  get busy() {
    return this.running || this.queue.length > 0;
  }
}

function splitSentences(text, all = false) {
  const { done, rest } = takeSentences(text);
  if (all && rest.trim()) done.push(rest);
  return done;
}

// Pull complete sentences out of a streaming buffer. Short fragments are merged to avoid choppy audio.
function takeSentences(buf) {
  const done = [];
  let rest = buf;
  const re = /([\s\S]*?[.!?…:;](?=\s|$)|[\s\S]*?\n\s*\n)/;
  let m;
  let acc = '';
  while ((m = rest.match(re)) && m[0].length < rest.length) {
    acc += m[0];
    rest = rest.slice(m[0].length);
    if (acc.trim().length >= 24 || /\n\s*\n/.test(m[0])) {
      done.push(acc.trim());
      acc = '';
    }
  }
  return { done, rest: acc + rest };
}

export const speaker = new Speaker();

// ----------------------------------------------------------- microphone
// Resolve the configured mic (label substring) to a deviceId; falls back to the default and logs why.
async function micConstraints() {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
  const want = (state.settings.stt.micDevice || '').toLowerCase();
  if (!want) return base;
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const match = inputs.find((d) => d.label.toLowerCase().includes(want) || d.deviceId === state.settings.stt.micDevice);
  if (match) return { ...base, deviceId: { exact: match.deviceId } };
  logEvent('warn', 'configured mic not found, using default', { wanted: want, found: inputs.map((d) => d.label) });
  return base;
}

export async function listMics() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
  } catch {
    /* labels may stay empty without permission */
  }
  return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => ({ id: d.deviceId, label: d.label || 'Microphone' }));
}

async function openMic() {
  await api.mic.request().catch(() => true);
  return navigator.mediaDevices.getUserMedia({ audio: await micConstraints() });
}

async function toMono16k(float32, sampleRate) {
  if (sampleRate === 16000) return float32;
  const length = Math.max(1, Math.ceil((float32.length * 16000) / sampleRate));
  const off = new OfflineAudioContext(1, length, 16000);
  const buf = off.createBuffer(1, float32.length, sampleRate);
  buf.copyToChannel(float32, 0);
  const src = off.createBufferSource();
  src.buffer = buf;
  src.connect(off.destination);
  src.start();
  return (await off.startRendering()).getChannelData(0);
}

// Push-to-talk recorder: raw PCM via an AudioWorklet while the key is held.
class Recorder {
  async start() {
    if (this.active) return;
    this.stream = await openMic();
    const ac = ctx();
    await ac.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url)).catch(() => {});
    this.src = ac.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ac, 'pcm-capture');
    this.chunks = [];
    this.node.port.onmessage = (e) => {
      this.chunks.push(e.data.samples);
      state.micLevel = Math.min(1, e.data.rms * 5);
    };
    this.src.connect(this.node);
    this.sink = silentSink(ac);
    this.node.connect(this.sink);
    this.startedAt = performance.now();
    this.active = true;
  }

  async stop() {
    if (!this.active) return null;
    this.active = false;
    state.micLevel = 0;
    const duration = performance.now() - this.startedAt;
    this.teardown();
    if (duration < 350) return null;
    return toMono16k(concat(this.chunks), ctx().sampleRate);
  }

  teardown() {
    this.src?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  cancel() {
    if (!this.active) return;
    this.active = false;
    state.micLevel = 0;
    this.teardown();
  }
}

// Worklets must be connected through to the destination to be processed; a muted gain does that.
function silentSink(ac) {
  const g = ac.createGain();
  g.gain.value = 0;
  g.connect(ac.destination);
  return g;
}

function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export const recorder = new Recorder();

// Hands-free: always listening, speech segments detected by energy with an adaptive noise floor.
// While the agent speaks the mic is ignored (it would hear itself) unless headphones are declared,
// in which case speaking over the agent interrupts it.
class HandsFree {
  async start() {
    if (this.running) return;
    this.stream = await openMic();
    const ac = ctx();
    await ac.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url)).catch(() => {});
    this.src = ac.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ac, 'pcm-capture');
    this.rate = ac.sampleRate;
    this.noise = 0.01;
    this.pre = []; // ~400 ms pre-roll so the first syllable isn't cut
    this.seg = null;
    this.gen = (this.gen || 0) + 1;
    const gen = this.gen;
    this.node.port.onmessage = (e) => gen === this.gen && this.onFrame(e.data.samples, e.data.rms);
    this.src.connect(this.node);
    this.sink = silentSink(ac);
    this.node.connect(this.sink);
    this.running = true;
    emit('handsfree', true);
    logEvent('info', 'hands-free listening started');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.gen++;
    this.src?.disconnect();
    this.node?.disconnect();
    this.sink?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (state.recording) setFlag('recording', false);
    state.micLevel = 0;
    emit('handsfree', false);
  }

  async restart() {
    this.stop();
    await this.start();
  }

  onFrame(samples, rms) {
    const s = state.settings.stt;
    const sens = Math.min(1, Math.max(0, Number(s.vadSensitivity ?? 0.5)));
    const threshold = Math.max(0.012, this.noise * (3.2 - sens * 1.8));
    const speaking = rms > threshold;
    const agentTalking = state.playing;
    if (!this.seg) this.noise = this.noise * 0.995 + Math.min(rms, 0.05) * 0.005; // learn the room
    state.micLevel = this.seg ? Math.min(1, rms * 5) : 0;

    if (busy || state.transcribing) return;
    if (agentTalking && !s.headphones) {
      this.seg = null;
      return;
    }
    this.pre.push(samples);
    const frameMs = (samples.length / this.rate) * 1000;
    while (this.pre.length * frameMs > 400) this.pre.shift();

    if (!this.seg) {
      if (speaking) {
        this.loud = (this.loud || 0) + frameMs;
        if (this.loud > 120) {
          // Speech started.
          if (agentTalking) {
            speaker.stop();
            emit('barge-in');
          }
          this.seg = { chunks: [...this.pre], silence: 0, length: 0 };
          setFlag('recording', true);
          setCaption('Listening…', 'user');
        }
      } else this.loud = 0;
      return;
    }
    this.seg.chunks.push(samples);
    this.seg.length += frameMs;
    this.seg.silence = speaking ? 0 : this.seg.silence + frameMs;
    if (this.seg.silence > 900 || this.seg.length > 30000) {
      const seg = this.seg;
      this.seg = null;
      this.loud = 0;
      setFlag('recording', false);
      if (seg.length - seg.silence < 300) return setCaption('');
      finishUtterance(() => toMono16k(concat(seg.chunks), this.rate));
    }
  }
}

export const handsFree = new HandsFree();

// Rebuild the mic after a headset is plugged in or removed (the old stream goes silent otherwise).
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  logEvent('info', 'audio devices changed');
  if (handsFree.running) handsFree.restart().catch((e) => logEvent('warn', 'mic restart failed', e.message));
});

// ------------------------------------------------------------ Transcriber
let worker = null;
let workerModel = '';
let reqId = 0;
const pending = new Map();

function getWorker(model) {
  if (worker && workerModel === model) return worker;
  worker?.terminate();
  worker = new Worker(new URL('./stt-worker.js', import.meta.url), { type: 'module' });
  workerModel = model;
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') emit('stt-progress', msg);
    else if (msg.type === 'ready') emit('stt-progress', { status: 'ready' });
    else if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error)) : resolve(msg.text);
    }
  };
  worker.onerror = (e) => {
    for (const { reject } of pending.values()) reject(new Error(e.message || 'Speech model failed to load'));
    pending.clear();
    worker = null;
  };
  worker.postMessage({ type: 'load', model });
  return worker;
}

export function preloadLocalModel() {
  const s = state.settings?.stt;
  if (s?.enabled && s.engine === 'local') getWorker(s.localModel);
}

function encodeWav(samples, rate = 16000) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}

export async function transcribe(samples) {
  const s = state.settings.stt;
  if (s.engine === 'remote') return cleanTranscript(await api.stt.transcribe(encodeWav(samples)));
  const w = getWorker(s.localModel);
  const id = ++reqId;
  const copy = new Float32Array(samples);
  const text = await new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ type: 'transcribe', id, audio: copy, language: s.language || 'en' }, [copy.buffer]);
  });
  return cleanTranscript(text);
}

function cleanTranscript(t) {
  const x = String(t || '').replace(/\[(BLANK_AUDIO|MUSIC|NOISE|Silence)\]|\((?:music|silence|inaudible)\)/gi, '').trim();
  return /^(you|thank you\.?|\.)$/i.test(x) ? '' : x;
}

// ----------------------------------------------------- utterance handling
let busy = false;

async function finishUtterance(getSamples) {
  busy = true;
  try {
    const samples = await getSamples();
    if (!samples?.length) {
      setCaption('');
      return;
    }
    setFlag('transcribing', true);
    setCaption('Transcribing…', 'user');
    const text = await transcribe(samples);
    setCaption(text || '(didn’t catch that)', 'user');
    if (text) {
      logEvent('info', 'heard', text);
      emit('voice-input', text);
    }
  } catch (err) {
    logEvent('error', 'speech-to-text failed', err.message);
    toastError(new Error(`Speech-to-text: ${err.message}`));
    setCaption('');
  } finally {
    setFlag('transcribing', false);
    busy = false;
  }
}

export async function startListening() {
  if (!state.settings?.stt?.enabled) {
    toastError(new Error('Voice input is disabled in Settings.'));
    return;
  }
  if (recorder.active || busy) return;
  speaker.stop(); // barge-in: pressing the talk key interrupts the agent
  emit('barge-in');
  try {
    await recorder.start();
    setFlag('recording', true);
    setCaption('Listening…', 'user');
    emit('listening', true);
  } catch (err) {
    logEvent('error', 'microphone failed', err.message);
    toastError(new Error(`Microphone: ${err.message}`));
  }
}

export async function stopListening() {
  if (!recorder.active) return;
  setFlag('recording', false);
  emit('listening', false);
  await finishUtterance(() => recorder.stop());
}

export function toggleListening() {
  return recorder.active ? stopListening() : startListening();
}

export async function setMicMode(mode) {
  if (mode === 'open') {
    try {
      await handsFree.start();
    } catch (err) {
      toastError(new Error(`Hands-free: ${err.message}`));
    }
  } else handsFree.stop();
}
