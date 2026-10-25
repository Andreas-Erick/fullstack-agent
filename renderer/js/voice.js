// Voice I/O: VoiceStudio playback (sentence-chunked, in order, with the offline Kokoro voice or the
// OS voice as fallback), microphone capture (push-to-talk or hands-free with voice-activity
// detection), speech-to-text.
import { api, emit, speakable, toastError, logEvent } from './util.js';
import { state, setFlag, setCaption } from './state.js';
import { KOKORO_SAMPLE_RATE } from './kokorotext.js';
import { mathOpen } from './mathtext.js';
import { practiceLanguage, pickVoice, languageName } from './practice.js';

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

// ----------------------------------------------------------------- Offline voice
// Kokoro in tts-worker.js, used when VoiceStudio is unreachable (voice.fallback: local | system | off).
export const fallbackMode = () => state.settings.voice.fallback || 'local';

const localVoice = {
  worker: null,
  ready: null, // resolves when the model is loaded, rejects if it can't be
  device: '',
  seq: 0,
  pending: new Map(),
  lastWarn: 0,

  start() {
    if (this.ready) return this.ready;
    this.worker = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === 'progress') emit('tts-progress', msg);
        else if (msg.type === 'ready') {
          this.device = msg.device;
          logEvent('info', 'offline voice ready', { device: msg.device });
          emit('tts-progress', { status: 'ready', device: msg.device });
          resolve();
        } else if (msg.id && this.pending.has(msg.id)) {
          const { done, fail } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.type === 'audio') done(msg.samples);
          else fail(new Error(msg.message));
        } else if (msg.type === 'error') this.reset(msg.message, reject);
      };
      this.worker.onerror = (e) => this.reset(e.message || 'the offline voice failed to load', reject);
    });
    this.ready.catch(() => {});
    this.worker.postMessage({ type: 'load' });
    return this.ready;
  },

  // A failed load is retried on the next sentence after a minute (e.g. it was offline on first use).
  reset(reason, reject) {
    this.worker?.terminate();
    this.worker = null;
    for (const { fail } of this.pending.values()) fail(new Error(reason));
    this.pending.clear();
    emit('tts-progress', { status: 'error', message: reason });
    reject?.(new Error(reason));
    // Also after a crash once loaded: until the retry, sentences go straight to the system voice.
    this.ready = Promise.reject(new Error(reason));
    this.ready.catch(() => {});
    setTimeout(() => (this.ready = null), 60000);
  },

  // Gives up (returns null) while the model is still downloading, so the system voice fills in.
  async speak(text, { waitMs = 8000 } = {}) {
    const ready = this.start();
    const loaded = await Promise.race([ready.then(() => true), new Promise((r) => setTimeout(() => r(false), waitMs))]);
    if (!loaded) return null;
    const v = state.settings.voice;
    const id = ++this.seq;
    const samples = await new Promise((done, fail) => {
      this.pending.set(id, { done, fail });
      this.worker.postMessage({ type: 'speak', id, text, voice: v.localVoice, speed: Number(v.speed) || 1 });
      // Generous: a sentence pair takes well under a second on the GPU, a few seconds on the CPU.
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), fail(new Error('the offline voice took too long'))), 30000);
    });
    const buf = ctx().createBuffer(1, samples.length, KOKORO_SAMPLE_RATE);
    buf.copyToChannel(samples, 0);
    return buf;
  },

  warn(err) {
    logEvent('warn', 'offline voice failed', err.message);
    if (Date.now() - this.lastWarn > 60000) toastError(new Error(`Offline voice: ${err.message} — using the system voice.`));
    this.lastWarn = Date.now();
  },
};

// Settings → Voice output: download/load the offline voice ahead of time, then speak a sample.
export async function testLocalVoice(text) {
  await localVoice.start();
  speaker.say(text, { engine: 'local' });
  return localVoice.device;
}

// ----------------------------------------------------------------- Speaker
class Speaker {
  constructor() {
    this.queue = []; // [{ text, audio: Promise<AudioBuffer|'system'|null> }]
    this.gen = 0;
    this.source = null;
    this.buffer = '';
    this.batch = [];
    this.started = false;
    this.running = false;
    this.onFallback = false; // set after VoiceStudio fails; retried periodically
    this.lastSpokeAt = 0;
  }

  say(text, override) {
    this.stop();
    for (const s of splitSentences(speakable(text), true)) this.chunk(s, override);
    this.release();
    this.started = false;
  }

  feed(delta) {
    this.buffer += delta;
    const { done, rest } = takeSentences(this.buffer);
    this.buffer = rest;
    for (const s of done) this.chunk(speakable(s));
  }

  flush() {
    const s = speakable(this.buffer);
    this.buffer = '';
    if (s) this.chunk(s);
    this.release();
    this.started = false;
  }

  // The first sentence of a reply goes out alone so the voice starts fast; after that sentences go
  // in pairs, because the voice gives fuller chunks livelier delivery than single short sentences.
  // A lone sentence never waits longer than a moment for its partner.
  chunk(text, override) {
    if (!text) return;
    if (!this.started) {
      this.started = true;
      return this.enqueue(text, override, { first: true });
    }
    this.batch.push(text);
    this.batchOverride = override;
    clearTimeout(this.batchTimer);
    if (this.batch.length >= 2) this.release();
    else this.batchTimer = setTimeout(() => this.release(), 1500);
  }

  release() {
    clearTimeout(this.batchTimer);
    if (this.batch.length) this.enqueue(this.batch.join(' '), this.batchOverride);
    this.batch = [];
  }

  // Short line while tools run, so a pause never feels like a dead line. Skipped if already talking.
  filler(text) {
    if (this.busy || Date.now() - this.lastSpokeAt < 4000) return;
    this.enqueue(text);
  }

  enqueue(text, override, { first = false } = {}) {
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
    const gen = this.gen;
    const audio = this.synthesize(text, override, gen);
    this.queue.push({ text, audio, gen, first, queuedAt: performance.now() });
    this.pump();
  }

  async synthesize(text, override, gen) {
    if (override?.engine === 'local') return localVoice.speak(text, { waitMs: 600000 }).catch((err) => (this.reportError(err), null));
    // Language practice speaks with a Windows voice for that language (if one is installed).
    const practice = practiceLanguage(state.settings);
    if (practice && !override?.voice && state.settings.learning?.practiceVoice !== 'assistant') {
      if (pickVoice(speechSynthesis.getVoices(), practice)) return 'system';
      if (this.noPracticeVoice !== practice) {
        this.noPracticeVoice = practice;
        toastError(new Error(`No ${languageName(practice)} voice on this computer, so the usual voice speaks. Add one in Windows Settings → Time & language → Speech → Add voices.`));
      }
    }
    const mode = fallbackMode();
    if (this.onFallback && mode !== 'off' && Date.now() - this.fallbackSince < 120000) return this.fallback(text, gen);
    try {
      const { audio } = await api.tts.speak(text, override);
      const bytes = audio instanceof Uint8Array ? audio : new Uint8Array(audio);
      const buf = await ctx().decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      if (this.onFallback) logEvent('info', 'VoiceStudio back online');
      this.onFallback = false;
      return buf;
    } catch (err) {
      if (gen !== this.gen) return null;
      logEvent('warn', 'VoiceStudio failed', err.message);
      if (mode === 'off') {
        this.reportError(err);
        return null;
      }
      if (!this.onFallback && !state.setupMode) {
        toastError(new Error(`VoiceStudio unavailable — using the ${mode === 'local' ? 'offline' : 'system'} voice. (${err.message})`));
        emit('voice-fallback', err.message);
      }
      this.onFallback = true;
      this.fallbackSince = Date.now();
      return this.fallback(text, gen);
    }
  }

  // The offline voice when it is chosen and works; the OS voice otherwise (also while the offline
  // voice is still downloading, so a reply is never silent).
  async fallback(text, gen) {
    if (fallbackMode() === 'local') {
      const buf = await localVoice.speak(text).catch((err) => (localVoice.warn(err), null));
      if (gen !== this.gen) return null;
      if (buf) return buf;
    }
    return 'speechSynthesis' in window ? 'system' : null;
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
      if (item.first) logFirstAudio(item);
      if (buf === 'system') await this.playSystem(item.text);
      else {
        await new Promise((resolve) => {
          const src = ctx().createBufferSource();
          src.buffer = buf;
          src.connect(state.analyser);
          // onended never fires while the audio device is stalled (e.g. a headset being switched).
          const limit = setTimeout(resolve, (buf.duration + 3) * 1000);
          src.onended = () => (clearTimeout(limit), resolve());
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
      // voice.voice is a VoiceStudio id, so pick by language: the Windows default may be another
      // language pack's voice (a German voice reading English).
      // During language practice: a voice for the practiced language.
      const voices = speechSynthesis.getVoices();
      const lang = practiceLanguage(state.settings) || (state.settings.stt?.language || 'en').toLowerCase();
      u.voice = pickVoice(voices, lang) || voices.find((v) => v.default) || null;
      if (u.voice) u.lang = u.voice.lang;
      let t = 0;
      const pulse = setInterval(() => (state.synthLevel = 0.35 + 0.35 * Math.abs(Math.sin((t += 0.6)))), 80);
      // Chromium sometimes never fires onend; never let that leave the speaker (and mic) stuck.
      const limit = setTimeout(() => done(), (text.length / 10 / (u.rate || 1) + 5) * 1000);
      const done = () => {
        clearTimeout(limit);
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
    clearTimeout(this.batchTimer);
    this.batch = [];
    this.started = false;
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
    // Never split inside a formula: "$$a. b$$" would be spoken as raw LaTeX.
    if ((acc.trim().length >= 24 || /\n\s*\n/.test(m[0])) && !mathOpen(acc)) {
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

// A voice sample for cloning, kept at the mic's own rate (cloning wants more than the 16 kHz used
// for speech-to-text). Hands-free listening ignores the mic meanwhile, so reading the script aloud
// doesn't start a turn. Returns { seconds(), stop() → { samples, rate, wav() }, cancel() }.
let clipActive = false;

export async function recordClip() {
  speaker.stop();
  const rec = new Recorder();
  await rec.start();
  clipActive = true;
  const end = () => {
    clipActive = false;
    rec.cancel();
  };
  return {
    seconds: () => (performance.now() - rec.startedAt) / 1000,
    stop: () => {
      const samples = concat(rec.chunks);
      end();
      return { samples, rate: ctx().sampleRate, wav: () => encodeWav(samples, ctx().sampleRate) };
    },
    cancel: end,
  };
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

// Neural voice detector (Silero VAD in a worker). Scores arrive about one frame behind the audio,
// which the pre-roll absorbs. Until it is ready, or if it fails to load, the energy detector is used.
const neural = {
  worker: null,
  ready: false,
  prob: 0,
  start() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./vad-worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'prob') this.prob = msg.prob;
      else if (msg.type === 'ready') {
        this.ready = true;
        logEvent('info', 'neural voice detection ready');
      } else if (msg.type === 'error') this.fail(msg.error);
    };
    this.worker.onerror = (e) => this.fail(e.message || 'worker failed');
    this.worker.postMessage({ type: 'load' });
  },
  fail(message) {
    logEvent('warn', 'neural voice detection unavailable, using the energy detector', message);
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  },
  feed(samples, rate) {
    const copy = new Float32Array(samples);
    this.worker.postMessage({ type: 'frame', samples: copy, rate }, [copy.buffer]);
  },
  reset() {
    this.prob = 0;
    this.worker?.postMessage({ type: 'reset' });
  },
};

// Hands-free: always listening. Speech is found by the neural detector (or, as a fallback, by energy
// with an adaptive noise floor plus a voicing check). While the agent speaks the mic is ignored (it
// would hear itself) unless headphones are declared, in which case speaking over the agent interrupts it.
class HandsFree {
  // Concurrent starts (settings change + device change) share one, so the mic never opens twice.
  start() {
    if (this.running) return Promise.resolve();
    this.starting ||= this.open().finally(() => (this.starting = null));
    return this.starting;
  }

  // The mic stream ends on sleep or when a USB mic is unplugged; without this, listening would
  // silently stop. Retries for a while, since the device may come back a moment later.
  async recover(attempt = 0) {
    logEvent('warn', 'microphone stream ended; reopening it', { attempt });
    this.stop();
    try {
      await this.start();
    } catch (err) {
      if (attempt < 5) setTimeout(() => state.settings.stt.micMode === 'open' && !this.running && this.recover(attempt + 1), 2000 * (attempt + 1));
      else toastError(new Error(`Hands-free: the microphone is gone (${err.message}). Reconnect it, then say or click to listen again.`));
    }
  }

  async open() {
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
    this.node.port.onmessage = (e) => gen === this.gen && this.onFrame(e.data.samples, e.data.rms, e.data.voiced);
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => gen === this.gen && this.running && this.recover());
    this.src.connect(this.node);
    this.sink = silentSink(ac);
    this.node.connect(this.sink);
    if (state.settings.stt.vadEngine !== 'energy') neural.start();
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

  onFrame(samples, rms, voiced) {
    const s = state.settings.stt;
    const sens = Math.min(1, Math.max(0, Number(s.vadSensitivity ?? 0.5)));
    const agentTalking = state.playing;
    if (!this.seg) this.noise = this.noise * 0.995 + Math.min(rms, 0.05) * 0.005; // learn the room
    state.micLevel = this.seg ? Math.min(1, rms * 5) : 0;

    if (busy || clipActive || state.transcribing || (agentTalking && !s.headphones)) {
      if (agentTalking) this.seg = null;
      if (!this.paused) neural.reset();
      this.paused = true;
      return;
    }
    this.paused = false;

    // speaking = this frame is speech; held = still inside speech (a lower bar, so words aren't split).
    let speaking, held;
    if (neural.ready && s.vadEngine !== 'energy') {
      neural.feed(samples, this.rate);
      const threshold = 0.75 - sens * 0.5;
      speaking = neural.prob > threshold;
      held = neural.prob > threshold - 0.15;
      voiced = speaking;
    } else {
      speaking = rms > Math.max(0.012, this.noise * (3.2 - sens * 1.8));
      held = speaking;
    }
    this.pre.push(samples);
    const frameMs = (samples.length / this.rate) * 1000;
    while (this.pre.length * frameMs > 400) this.pre.shift();

    if (!this.seg) {
      if (speaking) {
        this.loud = (this.loud || 0) + frameMs;
        if (voiced) this.onsetVoiced = (this.onsetVoiced || 0) + frameMs;
        this.gap = 0;
        // Interrupting the agent needs clearly voiced speech, so breathing or a cough doesn't cut it off.
        const started = agentTalking ? this.onsetVoiced >= 240 : this.loud > 120;
        if (started) {
          if (agentTalking) {
            speaker.stop();
            emit('barge-in');
          }
          this.seg = { chunks: [...this.pre], silence: 0, length: 0, voiced: this.onsetVoiced || 0 };
          setFlag('recording', true);
          setCaption('Listening…', 'user');
        }
      } else if ((this.gap = (this.gap || 0) + frameMs) > 80) {
        this.loud = 0;
        this.onsetVoiced = 0;
      }
      return;
    }
    this.seg.chunks.push(samples);
    this.seg.length += frameMs;
    this.seg.silence = held ? 0 : this.seg.silence + frameMs;
    if (speaking && voiced) this.seg.voiced += frameMs;
    const endMs = Math.min(2000, Math.max(300, Number(s.endSilenceMs) || 600));
    if (this.seg.silence > endMs || this.seg.length > 30000) {
      const seg = this.seg;
      this.seg = null;
      this.loud = 0;
      this.onsetVoiced = 0;
      setFlag('recording', false);
      // A short "yes" has ~150 ms of vowel; segments with none are breath or noise.
      if (seg.voiced < 80) return setCaption('');
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

let workerReady = false;

// Stops the worker and fails whatever it was transcribing, so the mic never waits on it forever.
function resetWorker(reason) {
  worker?.terminate();
  worker = null;
  workerReady = false;
  for (const { reject } of pending.values()) reject(new Error(reason));
  pending.clear();
}

function getWorker(model) {
  if (worker && workerModel === model) return worker;
  resetWorker('The speech model was switched');
  worker = new Worker(new URL('./stt-worker.js', import.meta.url), { type: 'module' });
  workerModel = model;
  worker.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') emit('stt-progress', msg);
    else if (msg.type === 'ready') {
      workerReady = true;
      logEvent('info', 'speech-to-text ready', { model: msg.model || model, device: msg.device });
      emit('stt-progress', { status: 'ready' });
    } else if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (!msg.error) return resolve(msg.text);
      reject(new Error(msg.error));
      // A failed run can leave the model unusable (e.g. the GPU was reset after sleep or a driver
      // update); reload it for the next sentence instead of failing every time from now on.
      logEvent('warn', 'speech-to-text failed; reloading the model', msg.error);
      resetWorker('Speech-to-text was restarted');
    }
  };
  worker.onerror = (e) => resetWorker(e.message || 'Speech model failed to load');
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

// raw: skip the vocabulary hint and the learned corrections (voice calibration measures without them).
export async function transcribe(samples, { raw = false } = {}) {
  const s = state.settings.stt;
  if (s.engine === 'remote') return cleanTranscript(await api.stt.transcribe(encodeWav(samples), { raw }), { raw });
  const w = getWorker(s.localModel);
  const id = ++reqId;
  const copy = new Float32Array(samples);
  // A loaded model answers in seconds; if it hangs, restart it rather than leave the mic waiting.
  // (No limit while the model is still downloading or loading.)
  const limitMs = workerReady ? 20000 + (samples.length / 16000) * 3000 : 0;
  const text = await new Promise((resolve, reject) => {
    const timer = limitMs && setTimeout(() => (logEvent('warn', 'speech-to-text timed out; restarting it'), resetWorker('Speech-to-text took too long and was restarted')), limitMs);
    const done = (fn) => (v) => (clearTimeout(timer), fn(v));
    pending.set(id, { resolve: done(resolve), reject: done(reject) });
    w.postMessage({ type: 'transcribe', id, audio: copy, language: practiceLanguage(state.settings) || s.language || 'en' }, [copy.buffer]);
  });
  return cleanTranscript(text, { raw });
}

function cleanTranscript(t, { raw = false } = {}) {
  // Whisper marks non-speech in brackets: [BLANK_AUDIO], [SIGHS], (coughs), (breathing)…
  const x = String(t || '').replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g, '').replace(/\s+/g, ' ').trim();
  if (/^(you|thank you\.?|\.)$/i.test(x)) return '';
  return raw ? x : applyCorrections(x);
}

// Names and words the user's voice calibration found misheard ("lexus" → "Nexus"), whole words only.
function applyCorrections(text) {
  let out = text;
  for (const { heard, meant } of state.settings.stt.corrections || []) {
    const words = String(heard).split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${words.join('[\\s,.-]+')}(?![\\p{L}\\p{N}])`, 'giu'), meant);
  }
  return out;
}

// Voice calibration: what the user's reading of the script sounded like to speech-to-text, plus
// their speaking level against the room (loudness percentiles over 20 ms frames).
export async function analyzeClip(samples, rate) {
  const frame = Math.round(rate * 0.02);
  const levels = [];
  for (let i = 0; i + frame <= samples.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j];
    levels.push(Math.sqrt(sum / frame));
  }
  levels.sort((a, b) => a - b);
  const pct = (p) => levels[Math.min(levels.length - 1, Math.floor(levels.length * p))] || 0;
  const transcript = await transcribe(await toMono16k(samples, rate), { raw: true });
  return { transcript, speechLevel: pct(0.9), noiseFloor: pct(0.1), seconds: samples.length / rate };
}

// ----------------------------------------------------- utterance handling
let busy = false;

// End-to-end latency: from the moment an utterance was closed to the reply's first audio.
let utteranceEndedAt = 0;

function logFirstAudio(item) {
  const now = performance.now();
  const sinceSpeechEndMs = utteranceEndedAt && now - utteranceEndedAt < 120000 ? Math.round(now - utteranceEndedAt) : undefined;
  utteranceEndedAt = 0;
  logEvent('info', 'first audio', { synthMs: Math.round(now - item.queuedAt), sinceSpeechEndMs, chars: item.text.length });
}

async function finishUtterance(getSamples) {
  utteranceEndedAt = performance.now();
  busy = true;
  try {
    const samples = await getSamples();
    if (!samples?.length) {
      setCaption('');
      emit('barge-in-over'); // nothing was said: an interrupted reply speaks again
      return;
    }
    setFlag('transcribing', true);
    setCaption('Transcribing…', 'user');
    const started = performance.now();
    const text = await transcribe(samples);
    setCaption(text || '(didn’t catch that)', 'user');
    if (text) {
      logEvent('info', 'heard', { text, sttMs: Math.round(performance.now() - started), audioSec: +(samples.length / 16000).toFixed(1) });
      emit('voice-input', text);
    } else emit('barge-in-over');
  } catch (err) {
    emit('barge-in-over');
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
