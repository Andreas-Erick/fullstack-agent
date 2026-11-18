// VoiceStudio TTS (OpenAI-compatible /v1/audio/speech), a cloud voice (voice.engine 'cloud': Groq's
// Orpheus or OpenAI, the same API) and optional remote speech-to-text.
const store = require('./store');
const log = require('./logger');

// Cloud voices (settings cloudVoice.*). Groq uses the Groq key the user already has for speech-to-text.
const CLOUD_VOICES = {
  groq: { name: 'Groq (Orpheus)', baseUrl: 'https://api.groq.com/openai/v1', model: 'canopylabs/orpheus-v1-english', voices: ['hannah', 'autumn', 'diana', 'austin', 'daniel', 'troy'], format: 'wav', speed: false, keyUrl: 'https://console.groq.com/keys' },
  openai: { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voices: ['coral', 'nova', 'shimmer', 'sage', 'alloy', 'ash', 'ballad', 'echo', 'fable', 'onyx', 'verse'], format: 'mp3', speed: true, keyUrl: 'https://platform.openai.com/api-keys' },
};

/** The request for one line in the cloud voice: { url, key, body }. Pure. */
function cloudRequest(s, text) {
  const c = s.cloudVoice || {};
  const p = CLOUD_VOICES[c.provider] || CLOUD_VOICES.groq;
  const key = c.provider === 'openai' ? c.apiKey : s.groq?.apiKey;
  if (!key) throw new Error(c.provider === 'openai' ? 'Add an OpenAI API key for the cloud voice (Settings → Voice).' : 'Add a Groq API key for the cloud voice (Settings → Voice).');
  const body = { model: c.model || p.model, input: String(text).slice(0, 4000), voice: c.voice && p.voices.includes(c.voice) ? c.voice : p.voices[0], response_format: p.format };
  if (p.speed && Number(s.voice?.speed) && Number(s.voice.speed) !== 1) body.speed = Number(s.voice.speed);
  return { url: `${p.baseUrl}/audio/speech`, key, body, name: p.name };
}

function apiBase(url) {
  const u = String(url || '').trim().replace(/\/+$/, '');
  return u.endsWith('/v1') ? u : `${u}/v1`;
}

function authHeaders(key) {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function speak(text, override = {}) {
  const s = await store.getSettings();
  const v = { ...s.voice, ...override };
  if (v.engine === 'cloud' && !override.voice) return speakCloud(s, text);
  if (!v.baseUrl) throw new Error('VoiceStudio URL is not set');
  const body = {
    model: v.model || 'tts-1',
    input: String(text).slice(0, 4000),
    voice: v.voice || 'default',
    response_format: v.format || 'mp3',
    speed: Number(v.speed) || 1,
  };
  const res = await fetch(`${apiBase(v.baseUrl)}/audio/speech`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(v.apiKey) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`VoiceStudio error ${res.status}: ${detail.slice(0, 300)}`);
  }
  const mime = res.headers.get('content-type') || 'audio/mpeg';
  return { mime, audio: new Uint8Array(await res.arrayBuffer()) };
}

async function speakCloud(s, text) {
  const r = cloudRequest(s, text);
  const res = await fetch(r.url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeaders(r.key) }, body: JSON.stringify(r.body), signal: AbortSignal.timeout(30000) });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${r.name} voice error ${res.status}: ${detail.slice(0, 300)}`);
  }
  return { mime: res.headers.get('content-type') || (r.body.response_format === 'wav' ? 'audio/wav' : 'audio/mpeg'), audio: new Uint8Array(await res.arrayBuffer()) };
}

// VoiceStudio builds differ; try the common voice-listing endpoints.
async function voices(override = {}) {
  const s = await store.getSettings();
  const v = { ...s.voice, ...override };
  const root = String(v.baseUrl || '').replace(/\/+$/, '').replace(/\/v1$/, '');
  const candidates = [`${root}/v1/audio/voices`, `${root}/v1/voices`, `${root}/voices`, `${root}/api/voices`];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: authHeaders(v.apiKey), signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const json = await res.json();
      const arr = Array.isArray(json) ? json : json.voices || json.data || json.items || [];
      const list = arr
        .map((x) => (typeof x === 'string' ? { id: x, name: x } : { id: x.id || x.voice_id || x.name, name: x.name || x.id || x.voice_id }))
        .filter((x) => x.id);
      if (list.length) return list;
    } catch {
      /* try next */
    }
  }
  return [];
}

// Reachability check for the status pill: any HTTP response means the server is up.
async function ping() {
  const s = await store.getSettings();
  if (!s.voice.ttsEnabled) return { enabled: false, ok: false };
  try {
    await fetch(String(s.voice.baseUrl).replace(/\/+$/, ''), { signal: AbortSignal.timeout(3000) });
    return { enabled: true, ok: true };
  } catch {
    return { enabled: true, ok: false };
  }
}

// Remote STT: OpenAI-compatible POST /audio/transcriptions (e.g. FreeLLMAPI → Groq Whisper).
// The words from voice calibration go along as Whisper's prompt, which biases it towards spelling
// those names right (skipped for raw calibration measurements).
const GROQ_STT = { base: 'https://api.groq.com/openai/v1', model: 'whisper-large-v3-turbo', models: ['whisper-large-v3-turbo', 'whisper-large-v3'] };

/**
 * Where a cloud transcription goes: { base, key, model, name }. `provider` 'groq' (engine "groq", or the
 * fallback of local Whisper) uses the Groq key the AI brain uses too; anything else is the custom
 * OpenAI-compatible endpoint (engine "remote").
 */
function sttEndpoint(s, provider = s.stt.engine) {
  if (provider === 'groq') {
    if (!s.groq?.apiKey) throw new Error('Cloud speech-to-text needs a Groq API key (free at console.groq.com/keys): Settings → Voice input.');
    return { base: GROQ_STT.base, key: s.groq.apiKey, model: GROQ_STT.models.includes(s.stt.groqModel) ? s.stt.groqModel : GROQ_STT.model, name: 'Groq' };
  }
  const base = (s.stt.remoteUrl || s.llm.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Set a transcription URL in Settings → Voice input');
  return { base, key: s.stt.remoteKey || s.llm.apiKey, model: s.stt.remoteModel || 'whisper-1', name: 'remote' };
}

// Transient failures are tried again (the spoken words are lost otherwise): network errors, the time
// limit, and HTTP 408/429-with-a-short-retry-after/500/502/503/504, at most 3 attempts. Never 400/401/403/
// 404/413/422, nor a 429 without a short retry-after (the daily cap): those keep today's messages. Nor a
// refused connection ("fetch failed" with ECONNREFUSED): nothing is listening there.
// error: the thrown error's name, message and cause code in one string ('' for an HTTP answer).
function sttRetryDelay({ status = 0, error = '', attempt, retryAfter = 0 }) {
  if (attempt >= 3) return null;
  const transient = status
    ? [408, 500, 502, 503, 504].includes(status) || (status === 429 && retryAfter > 0 && retryAfter <= 8)
    : !/ECONNREFUSED/i.test(error) && /TimeoutError|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(error);
  if (!transient) return null;
  if (status === 429) return retryAfter * 1000;
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
}

// A WAV of 16 kHz 16-bit mono is 32,000 bytes a second. Per attempt: time to upload a long one (at most the
// two minutes one attempt always had); in all: under the window's own wait for the phone (main.js
// transcribeInWindow: 60 s + 1 s per second of audio).
function sttLimits(bytes) {
  const sec = Math.max(0, Number(bytes) || 0) / 32000;
  return { attemptMs: Math.round(Math.min(120000, 10000 + 500 * sec)), budgetMs: Math.round(55000 + 1000 * sec) };
}

// The final error in plain words: it reaches a notice and, through /api/transcribe, the phone. The details
// (a service's error JSON, never the user's words) go to the log.
function sttError({ status, failure, error, text, via }) {
  const name = via === 'Groq' ? 'Groq' : 'the transcription service';
  if (failure) {
    if (!/TimeoutError|AbortError|fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(error)) return failure; // anything else: as today
    log.warn('transcription failed', { via, error: failure });
    // The time limit: the service was there, just slow (a busy service, a self-hosted one on a processor).
    if (/TimeoutError|AbortError/i.test(error)) return new Error(`${via} took too long to answer; try again in a moment.`);
    return new Error(`Couldn't reach ${name}; check the internet connection.`);
  }
  if (status === 401 || status === 403) return new Error(`${via} did not accept the API key (Settings → Voice input).`);
  if (status === 429) return new Error(`${via}'s limit is used up for now; try again in a while, or switch to local Whisper.`);
  log.warn('transcription failed', { status, via, body: text.slice(0, 300) });
  return new Error(`${via} answered with an error (${status}); details are in the log.`);
}

async function transcribe(wavBytes, { raw = false, provider, retry } = {}) {
  const s = await store.getSettings();
  const { base, key, model } = sttEndpoint(s, provider === 'groq' ? 'groq' : s.stt.engine);
  const via = provider === 'groq' || s.stt.engine === 'groq' ? 'Groq' : 'The transcription service';
  // Tests pass their own clock and sleep (an IPC call can't carry functions, so the window never does).
  const sleep = typeof retry?.sleep === 'function' ? retry.sleep : (ms) => new Promise((r) => setTimeout(r, ms));
  const now = typeof retry?.now === 'function' ? retry.now : Date.now;
  const { attemptMs, budgetMs } = sttLimits(wavBytes?.length);
  const deadline = now() + budgetMs;
  // A self-hosted endpoint (Whisper on a processor) may need far longer than Groq: each of its attempts may
  // use what is left of the budget, up to two minutes. A retry still needs at least `attemptMs` left.
  const limitNow = () => (via === 'Groq' ? attemptMs : Math.min(120000, Math.max(attemptMs, deadline - now())));
  const language = s.learning?.practiceLanguage || s.stt.language; // language practice listens for that language
  const url = base.endsWith('/audio/transcriptions') ? base : `${base}/audio/transcriptions`;
  for (let attempt = 1; ; attempt++) {
    const form = new FormData(); // a fresh body for each attempt
    form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', model);
    if (language) form.append('language', language);
    if (!raw && s.stt.vocabulary?.length) form.append('prompt', s.stt.vocabulary.join(', '));
    let res = null;
    let text = '';
    let failure = null;
    try {
      res = await fetch(url, { method: 'POST', headers: authHeaders(key), body: form, signal: AbortSignal.timeout(limitNow()) });
      text = await res.text();
    } catch (err) {
      failure = err;
    }
    if (!failure && res.ok) {
      try {
        return JSON.parse(text).text || '';
      } catch {
        return text;
      }
    }
    const status = failure ? 0 : res.status;
    const error = failure ? [failure.name, failure.message, failure.cause?.code].filter(Boolean).join(' ') : '';
    const delay = sttRetryDelay({ status, error, attempt, retryAfter: Number(res?.headers.get('retry-after')) || 0 });
    if (delay !== null && now() + delay + attemptMs <= deadline) {
      log.info('stt retry', { status, attempt });
      await sleep(delay);
      continue;
    }
    throw sttError({ status, failure, error, text, via });
  }
}

module.exports = { speak, voices, transcribe, ping, sttEndpoint, sttRetryDelay, sttLimits, cloudRequest, CLOUD_VOICES, GROQ_STT };
