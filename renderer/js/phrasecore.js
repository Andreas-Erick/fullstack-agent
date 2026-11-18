// Kept voice lines, the pure part (phrases.js stores them in Cache Storage, voice.js speaks them): the
// audio of fixed lines the voice says often (the persona's greeting, the "one moment" fillers), so they
// play at once instead of waiting for the model. Keys never hold an API key; the audio is checked before
// it is kept and again when it is read. Pure: test/phrasecore.test.js loads it.
import { kokoroVoice } from './kokorotext.js';

// Bump when a fixed text would sound different (kokorotext.js normalisation or phonemes, the model,
// speakable()'s output): every kept line is then made again once.
export const PHRASE_REV = 1;
export const PHRASE_CACHE = 'siren-voice-phrases';
export const MAX_ENTRIES = 256; // at most ~30 MB (a 160-character line is ~10 s of 24 kHz 16-bit audio)
export const MAX_CHARS = 160;
export const HANDOFF_RECENT_MS = 3 * 24 * 3600e3; // a "where we left off" note older than this isn't mentioned
export const HANDOFF_LATE_MS = 20000; // the "Last time we were on …" line is dropped if it would start later

const ENGINES = ['local', 'voicestudio', 'cloud'];
const engineOf = (v) => (ENGINES.includes(v?.engine) ? v.engine : 'local');

/**
 * The voice a line is spoken in, as far as it changes the sound: { rev, engine, voice, model, localVoice,
 * speed, cloud }, always in this key order. The renderer's settings hold decrypted keys: never one here.
 */
export function voiceIdentity(settings) {
  const v = settings?.voice || {};
  const c = settings?.cloudVoice || {};
  const engine = engineOf(v);
  return {
    rev: PHRASE_REV,
    engine,
    voice: engine === 'voicestudio' ? String(v.voice || '') : '',
    model: engine === 'voicestudio' ? String(v.model || '') : '',
    localVoice: engine === 'local' ? kokoroVoice(v.localVoice) : '',
    speed: Number(v.speed) || 1,
    cloud: engine === 'cloud' ? [c.provider || '', c.model || '', c.voice || ''] : null,
  };
}

/** What made a line's audio (`engine` with the settings sent with its request), for madeByMatches. */
export function madeByOf(engine, settings) {
  const v = settings?.voice || {};
  const c = settings?.cloudVoice || {};
  const speed = Number(v.speed) || 1;
  if (engine === 'local') return { engine, localVoice: kokoroVoice(v.localVoice), speed };
  if (engine === 'cloud') return { engine, cloud: [c.provider || '', c.model || '', c.voice || ''], speed };
  return { engine: 'voicestudio', voice: String(v.voice || ''), model: String(v.model || ''), speed };
}

/** The text a line's key is hashed from (SHA-256 in phrases.js; never stored). */
export const phraseKeyText = (identity, text) => JSON.stringify([identity, String(text)]);

/** The Cache Storage address of a line: its key's hash under a host that can never resolve. */
export function phraseUrl(hex) {
  if (!/^[0-9a-f]{64}$/.test(String(hex))) throw new Error('not a SHA-256 hex digest');
  return `https://siren-phrases.invalid/${hex}`;
}

export const keepable = (text) => typeof text === 'string' && text.length > 0 && text.length <= MAX_CHARS;

/** Float samples as 16-bit PCM (half the size; the voice is 24 kHz speech). */
export function toPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) out[i] = Math.round(Math.max(-1, Math.min(1, float32[i])) * 32767);
  return out;
}

export function fromPcm16(int16) {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) out[i] = int16[i] / 32768;
  return out;
}

const LOUD = 0.02; // a sample this loud counts for the peak and the zero-crossing rate
const MIN_PEAK = 0.02;
const MAX_PEAK = 1.5;
const MIN_RMS = 0.005;
// Sign changes between loud neighbouring samples: speech at 24 kHz sits well under it, white noise ~0.5.
export const MAX_ZCR = 0.35;

/** Zero crossings per pair of neighbouring samples where either is loud (0 when none is). */
export function zeroCrossingRate(samples) {
  let pairs = 0;
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (Math.max(Math.abs(a), Math.abs(b)) <= LOUD) continue;
    pairs++;
    if (a * b < 0) crossings++;
  }
  return pairs ? crossings / pairs : 0;
}

/**
 * Does this audio look like the line spoken? Not silence, not clipped garbage, not noise (a garbled run),
 * and about as long as the text: kept or played only then.
 */
export function plausibleSpeech({ chars, samples, rate }) {
  const n = samples?.length || 0;
  if (!(rate >= 8000 && rate <= 96000) || !n) return false;
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = samples[i];
    if (!Number.isFinite(x)) return false;
    peak = Math.max(peak, Math.abs(x));
    sum += x * x;
  }
  const seconds = n / rate;
  return peak >= MIN_PEAK && peak <= MAX_PEAK && Math.sqrt(sum / n) >= MIN_RMS && zeroCrossingRate(samples) <= MAX_ZCR && seconds >= 0.2 && seconds <= (Number(chars) || 0) * 0.2 + 2;
}

/**
 * Was this audio made by the voice the identity describes? Fallback audio (the offline voice while
 * VoiceStudio is down) and audio from a voice changed mid-request never go under the wrong key.
 */
export function madeByMatches(identity, madeBy) {
  if (!identity || !madeBy || madeBy.engine !== identity.engine || madeBy.speed !== identity.speed) return false;
  if (identity.engine === 'local') return madeBy.localVoice === identity.localVoice;
  if (identity.engine === 'voicestudio') return madeBy.voice === identity.voice && madeBy.model === identity.model;
  if (identity.engine === 'cloud') return JSON.stringify(madeBy.cloud) === JSON.stringify(identity.cloud);
  return false;
}

/** The oldest entries over the limit (keys in Cache Storage order: oldest first). */
export const toEvict = (keys, max = MAX_ENTRIES) => keys.slice(0, Math.max(0, keys.length - max));

/** A hit in the oldest quarter of a well-filled cache is stored again, so a line in use isn't evicted. */
export const rePutWanted = (index, total, max = MAX_ENTRIES) => index >= 0 && total > max / 2 && index < total / 4;

/**
 * What the launch greeting says: the persona's greeting, and with a recent "where we left off" note one
 * line about it (spoken after the greeting, never kept: it holds conversation content).
 */
export function launchGreeting(settings, note = null, now = Date.now()) {
  const greeting = settings?.appearance?.greeting || `Hello, I'm ${settings?.agent?.name || 'Siren'}. What are we working on today?`;
  const recent = note && now - note.at < HANDOFF_RECENT_MS;
  return { greeting, handoff: recent ? `Last time we were on ${note.topic || note.title}; say the word and we continue.` : '' };
}
