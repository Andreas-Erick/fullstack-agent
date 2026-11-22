// Voice I/O: speech-to-text, utterance handling (the voice-input arbiter's outcomes, push-to-talk) and
// the public API the rest of the window imports. The parts live in their own modules: the shared
// AudioContext (voicecommon.js), the offline voice (offlinevoice.js), the Speaker (speaker.js), the
// microphone and push-to-talk Recorder (mic.js) and hands-free listening (handsfree.js).
import { api, el, emit, on, speakable, toastError, pushToast, logEvent } from './util.js';
import { state, setFlag, setCaption, ttsActive } from './state.js';
import { offlineVoiceSpeaks } from './speechplan.js';
import { forgetPhrases } from './phrases.js';
import { allFillers } from './chatcore.js';
import { practiceLanguage } from './practice.js';
import { BALANCED, speechPlan, preloadSpeech } from './perfcore.js';
import { perfReady } from './perf.js';
import { PTT_MAX_MS } from './utterance.js';
import { createVoiceInput } from './voiceinput.js';
import { createModelHost } from './modelhost.js';
import { ctx, timers, byProfile } from './voicecommon.js';
import { fallbackMode, localVoice } from './offlinevoice.js';
import { speaker, replySpeech, noteSpeechEnd } from './speaker.js';
import { recorder, Recorder, concat, toMono16k, listMics } from './mic.js';
import { createHandsFree } from './handsfree.js';

export { ctx, fallbackMode, speaker, replySpeech, recorder, listMics };

/**
 * At launch: load the offline voice when it is the main voice, so the greeting needn't wait for it.
 * Once it is in, the filler lines are made in the first quiet moment (speaker.filler plays only those),
 * when replies are spoken: with auto-speak off no filler plays, and making them is CPU work for nothing.
 * The ones kept from earlier sessions (phrases.js) are ready at once, in any voice, without the model.
 */
export function preloadOfflineVoice() {
  const v = state.settings?.voice;
  if (ttsActive() && v.filler) speaker.loadKept(allFillers());
  if (!v?.ttsEnabled || v.engine !== 'local') return;
  const idle = () => !state.generating && !state.recording;
  localVoice.start().then(() => ttsActive() && state.settings.voice.filler && speaker.warmFillers(allFillers(), idle), () => {});
}

/** A paired phone's reply in the offline voice, as a WAV (remote.js). Never cancelled by a stop here. */
export async function offlineVoiceWav(text) {
  const buf = await localVoice.speak(speakable(text), { waitMs: 180000, keep: true });
  if (!buf) throw new Error('The offline voice is not ready');
  return encodeWav(buf.getChannelData(0), buf.sampleRate);
}

/** For the system monitor's memory section. */
export const offlineVoiceStatus = () => ({ loaded: Boolean(localVoice.worker), device: localVoice.device });
export const unloadOfflineVoice = () => localVoice.unload();

/** Settings → Voice output: the kept lines go (made again when next needed). True if there were any. */
export async function forgetVoiceLines() {
  speaker.fillers.clear();
  speaker.warmWant = null;
  return forgetPhrases();
}

// Settings → Voice output: download/load the offline voice ahead of time, then speak a sample.
export async function testLocalVoice(text) {
  await localVoice.start();
  speaker.say(text, { engine: 'local' });
  return localVoice.device;
}

// On any profile, an unloaded offline voice (Balanced frees it after a quiet while; the system
// monitor's Unload frees it anywhere) loads again as soon as a reply is coming (a message went out),
// or at a push-to-talk press when speech-to-text runs in the cloud (with local Whisper the press
// already loads that model on the same processor). Never on a hands-free onset (breath and room noise
// start one) or the face demo. With the voice loaded, start() returns at once and keepFor() restarts
// Balanced's idle clock (elsewhere it does nothing).
on('agent-state', (s) => {
  if (state.demo || state.transcribing || !offlineVoiceSpeaks(state.settings?.voice, { onFallback: speaker.onFallback })) return;
  const sent = s === 'thinking' && state.generating;
  const talking = s === 'listening' && recorder.active && state.settings.stt?.engine !== 'local';
  if (!sent && !talking) return;
  localVoice.start();
  if (sent && localVoice.worker) localVoice.keepFor();
});

// A voice sample for cloning, kept at the mic's own rate (cloning wants more than the 16 kHz used
// for speech-to-text). Hands-free listening ignores the mic meanwhile, so reading the script aloud
// doesn't start a turn. Returns { seconds(), stop() → { samples, rate, wav() }, cancel() }.
export async function recordClip() {
  speaker.stop();
  const rec = new Recorder();
  await rec.start();
  input.clip(true);
  const end = () => {
    input.clip(false);
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

// ------------------------------------------------------------ Transcriber
// modelhost.js: one worker per plan (perfcore.js speechPlan: model, fallback, gpu; another plan, another
// worker), Balanced's idle unload after a while without voice input (it loads again, from the cache, with
// the next sentence), and the restart of a run that hangs or fails. Whatever it was transcribing fails
// with the reason, so the mic never waits on it forever.
let sttLoaded = null; // { model, device } once the worker reports ready
let reqId = 0;
const pending = new Map();

const stt = createModelHost({
  name: 'speech model',
  create: () => new Worker(new URL('./stt-worker.js', import.meta.url), { type: 'module' }),
  configure: (w, key) => w.postMessage({ type: 'load', ...JSON.parse(key) }),
  onMessage: onSttMessage,
  onStop: (reason) => {
    sttLoaded = null;
    for (const { reject } of pending.values()) reject(new Error(reason));
    pending.clear();
  },
  failText: 'Speech model failed to load',
  idleMs: (p) => (p === 'balanced' ? BALANCED.speechIdleMin * 60000 : 0),
  profile: byProfile,
  idleLog: 'speech model unloaded after idle',
  idleReason: 'The speech model was unloaded',
  switchReason: 'The speech model was switched',
  clock: timers,
  log: logEvent,
});

function onSttMessage(msg) {
  if (msg.type === 'progress') emit('stt-progress', msg);
  else if (msg.type === 'ready') {
    const model = msg.model || JSON.parse(stt.key).model;
    stt.ready();
    sttLoaded = { model, device: msg.device };
    logEvent('info', 'speech-to-text ready', { model, device: msg.device });
    emit('stt-progress', { status: 'ready' });
  } else if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (!msg.error) return resolve(msg.text);
    reject(new Error(msg.error));
    // A failed run can leave the model unusable (e.g. the GPU was reset after sleep or a driver
    // update); reload it for the next sentence instead of failing every time from now on.
    stt.restart('Speech-to-text was restarted', { warn: 'speech-to-text failed; reloading the model', data: msg.error });
  }
}

// The model for this computer and the language being spoken (practice mode switches it).
const currentPlan = () => speechPlan(state.settings, practiceLanguage(state.settings) || state.settings.stt.language || 'en');

function getWorker(plan) {
  stt.load(JSON.stringify(plan));
  return stt.worker;
}

/** For the system monitor's memory section. */
export function speechStatus() {
  const s = state.settings?.stt;
  return { on: Boolean(s?.enabled && s.engine === 'local'), loaded: Boolean(stt.worker), ready: stt.loaded, model: sttLoaded?.model || (stt.worker ? currentPlan().model : ''), device: sttLoaded?.device || '' };
}

export function unloadSpeech() {
  stt.unload('The speech model was unloaded to free memory');
}

export function preloadLocalModel() {
  const s = state.settings?.stt;
  if (s?.enabled && s.engine === 'local') getWorker(currentPlan());
}

// When voice input was last used, on this computer only (a convenience: lost storage means one
// launch without the preload). Decides whether the model loads at launch (perfcore.js preloadSpeech).
const VOICE_USED_KEY = 'siren.voiceInputAt';
function noteVoiceInput() {
  try {
    localStorage.setItem(VOICE_USED_KEY, String(Date.now()));
  } catch {} // storage unavailable: one launch without the preload
}
function voiceInputAt() {
  try {
    return Number(localStorage.getItem(VOICE_USED_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** At launch: load the speech model only for someone who used voice input lately. */
export function preloadSpeechIfUsed() {
  if (preloadSpeech(state.settings, voiceInputAt())) preloadLocalModel();
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
  // Cloud: Groq's Whisper Large v3 Turbo ("groq") or a custom endpoint ("remote"), sent by main/voice.js.
  if (s.engine === 'remote' || s.engine === 'groq') return cleanTranscript(await api.stt.transcribe(encodeWav(samples), { raw }), { raw });
  noteVoiceInput();
  // Local, with Groq as the fallback (stt.cloudFallback): while the model is still loading (the first
  // minutes after a start or after it was unloaded), or if it fails, the cloud answers instead; the
  // local model keeps loading for next time.
  if (s.cloudFallback && !raw) {
    if (!stt.loaded) {
      getWorker(currentPlan());
      return cleanTranscript(await api.stt.transcribe(encodeWav(samples), { provider: 'groq' }));
    }
    try {
      return await transcribeLocal(samples, { raw });
    } catch (err) {
      logEvent('warn', 'local speech-to-text failed; using Groq', { error: err.message });
      return cleanTranscript(await api.stt.transcribe(encodeWav(samples), { provider: 'groq' }));
    }
  }
  return transcribeLocal(samples, { raw });
}

async function transcribeLocal(samples, { raw = false } = {}) {
  const s = state.settings.stt;
  const w = getWorker(currentPlan());
  stt.use(); // never unloaded for idleness while it writes this down
  const id = ++reqId;
  const copy = new Float32Array(samples);
  // A loaded model answers in seconds; if it hangs, restart it rather than leave the mic waiting.
  // (No limit while the model is still downloading or loading.)
  const limitMs = stt.loaded ? 20000 + (samples.length / 16000) * 3000 : 0;
  const text = await new Promise((resolve, reject) => {
    const cancel = stt.deadline(limitMs, { warn: 'speech-to-text timed out; restarting it', reason: 'Speech-to-text took too long and was restarted' });
    const done = (fn) => (v) => (cancel(), fn(v));
    pending.set(id, { resolve: done(resolve), reject: done(reject) });
    w.postMessage({ type: 'transcribe', id, audio: copy, language: practiceLanguage(state.settings) || s.language || 'en' }, [copy.buffer]);
  });
  stt.idle(); // Balanced: the idle clock starts after each sentence
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
// The arbiter (voiceinput.js): who holds the microphone, one outcome per utterance, and when an
// interrupted reply speaks again. These are what its outcomes do here.
function onVoiceOutcome(o) {
  if (o.type === 'barge-in') {
    speaker.stop();
    emit('barge-in');
  } else if (o.type === 'resume') emit('barge-in-over'); // nothing was said: an interrupted reply speaks again
  else if (o.type === 'held') setCaption(`${o.text} …`, 'user');
  else if (o.type === 'words') {
    // A piece that trailed off waited this long for more: part of the wait before a reply.
    if (o.heldMs) logEvent('info', 'voice piece sent after a hold', { heldMs: o.heldMs });
    emit('voice-input', o.text);
  } else if (o.type === 'failed') {
    logEvent('error', 'speech-to-text failed', o.error?.message);
    setCaption('');
    // The words aren't lost: the recording waits for Try again (only the latest one is kept).
    if (o.kept) offerRetry(`Couldn’t write down what you said: ${plainMessage(o.error)}`);
    else toastError(new Error(`Speech-to-text: ${o.error?.message}`));
  }
}

const input = createVoiceInput({
  now: () => performance.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (t) => clearTimeout(t),
  setFlag,
  agentTalking: () => speaker.playing,
  approvalPending: () => Boolean(state.approvalPending),
  on: onVoiceOutcome,
});

// Where and when the words being written down began (approval.js: speech that started before an
// approval appeared isn't its answer; an always-ask approval takes a spoken yes only from the talk key).
export const utteranceInfo = () => input.info();

export const handsFree = createHandsFree({ input, finishUtterance });

// Rebuild the mic after a headset is plugged in or removed (the old stream goes silent otherwise).
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  logEvent('info', 'audio devices changed');
  if (handsFree.running) handsFree.restart().catch((e) => logEvent('warn', 'mic restart failed', e.message));
});

// Writes one utterance down and settles its handle (`u`, from the arbiter) exactly once.
async function finishUtterance(getSamples, u, { pauseMs = 0 } = {}) {
  noteSpeechEnd(performance.now() - pauseMs); // speaker.js: for the first audio's latency
  let samples = null;
  try {
    samples = await getSamples();
    if (!samples?.length) {
      setCaption(input.heldText);
      return void u.empty();
    }
    u.transcribing();
    setCaption('Transcribing…', 'user');
    const started = performance.now();
    const text = await transcribe(samples);
    setCaption(text || '(didn’t catch that)', 'user');
    if (text) logEvent('info', 'heard', { chars: text.length, sttMs: Math.round(performance.now() - started), audioSec: +(samples.length / 16000).toFixed(1), pauseMs: pauseMs || undefined });
    if (text && state.settings?.logging?.debug) logEvent('debug', 'heard text', { text: text.slice(0, 200) });
    u.heard(text);
  } catch (err) {
    u.failed(samples, err); // a no-op if the handle already settled
  }
}

let retryOffer = null; // the kept recording's notice: one on screen, since only the latest recording is kept
const plainMessage = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
function offerRetry(why) {
  retryOffer?.remove();
  const t = el('div', { class: 'toast' }, el('div', {}, `${/[.!?…]$/.test(why) ? why : `${why}.`} The recording is kept.`));
  const close = () => {
    t.remove();
    if (retryOffer === t) retryOffer = null;
  };
  const later = () => {
    close();
    input.forget(); // let go: nothing else offers it again
  };
  t.append(el('div', { class: 'toast-actions' }, el('button', { class: 'btn small', onclick: () => (close(), retryLastRecording()) }, 'Try again'), el('button', { class: 'btn small', onclick: later }, 'Later')));
  retryOffer = t;
  pushToast(t, 120000);
}
function retryLastRecording() {
  const r = input.retry();
  if (!r) return;
  // Words said before an approval appeared are never its answer: they wait until it is answered.
  if (r.refused === 'approval') return offerRetry('Answer the open approval first.');
  // Another recording is being made or written down: the kept one waits (its button comes back).
  if (r.refused) return offerRetry('Still busy with another recording.');
  finishUtterance(() => r.samples, input.begin()); // one piece: never joined to a hands-free piece that has moved on
}

// A press while the last utterance is still being transcribed waits for it (a moment) instead of
// being dropped; a release meanwhile cancels the wait (the arbiter's ready(id) says so).
const untilIdle = (ms) => new Promise((resolve) => {
  const t0 = performance.now();
  const poll = () => (!input.busy || performance.now() - t0 > ms ? resolve() : setTimeout(poll, 40));
  poll();
});

/** Opens the microphone ahead of the first press (at launch, when the window gets focus). */
export function warmMic() {
  const s = state.settings?.stt;
  if (s?.enabled && s.micMode !== 'open') recorder.warm().catch(() => {}); // warming only; the press starts the microphone again
}

export async function startListening() {
  if (!state.settings?.stt?.enabled) {
    toastError(new Error('Voice input is disabled in Settings.'));
    return;
  }
  if (recorder.active || recorder.starting) return;
  // Barge-in: pressing the talk key interrupts the agent (the arbiter's 'barge-in' stops the speaker).
  const p = input.press();
  if (p.cutOpen) handsFree.endSegment('cut'); // the open mic's words so far: a piece that waits for these
  if (p.wait) {
    setCaption('One moment…', 'user');
    await untilIdle(4000);
    if (!input.ready(p.id)) return; // released meanwhile
  }
  // Not preloaded at launch (perfcore.js preloadSpeech): it loads while you speak, not after.
  preloadLocalModel();
  try {
    await recorder.start();
    input.micStarted(p.id, recorder.startedAt);
    setCaption('Listening…', 'user');
    emit('listening', true);
    // A stuck talk key must not record forever: what was said so far is sent.
    clearTimeout(pttLimit);
    pttLimit = setTimeout(() => input.holds(p.id) && recorder.active && (logEvent('warn', 'push-to-talk held at the limit; stopped', { min: PTT_MAX_MS / 60000 }), stopListening()), PTT_MAX_MS);
  } catch (err) {
    input.micFailed(p.id); // nothing was recorded: the reply the press silenced speaks again
    logEvent('error', 'microphone failed', err.message);
    toastError(new Error(`Microphone: ${err.message}`));
  }
}

let pttLimit = 0;
export async function stopListening() {
  clearTimeout(pttLimit);
  input.release(); // a press still waiting to start is over
  if (recorder.starting) await recorder.starting.catch(() => {}); // the earlier start failed for its own caller
  if (!recorder.active) return;
  emit('listening', false);
  // The talk key's source and start, unless another piece is still being written down: its words keep
  // their own, and these then count with that earlier start and source (at worst the yes is asked again).
  await finishUtterance(() => recorder.stop(), input.begin({ fromKey: true }));
}

export function toggleListening() {
  return recorder.active ? stopListening() : startListening();
}

export async function setMicMode(mode) {
  if (mode === 'open') {
    perfReady.then(preloadLocalModel); // always listening: the model is needed soon
    try {
      await handsFree.start();
    } catch (err) {
      toastError(new Error(`Hands-free: ${err.message}`));
    }
  } else handsFree.stop();
}
