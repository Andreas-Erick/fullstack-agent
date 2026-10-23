// VoiceStudio TTS (OpenAI-compatible /v1/audio/speech) and optional remote speech-to-text.
const store = require('./store');

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
async function transcribe(wavBytes) {
  const s = await store.getSettings();
  const base = (s.stt.remoteUrl || s.llm.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Set a transcription URL in Settings → Voice input');
  const key = s.stt.remoteKey || s.llm.apiKey;
  const form = new FormData();
  form.append('file', new Blob([wavBytes], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', s.stt.remoteModel || 'whisper-1');
  if (s.stt.language) form.append('language', s.stt.language);
  const url = base.endsWith('/audio/transcriptions') ? base : `${base}/audio/transcriptions`;
  const res = await fetch(url, { method: 'POST', headers: authHeaders(key), body: form, signal: AbortSignal.timeout(120000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Transcription error ${res.status}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text).text || '';
  } catch {
    return text;
  }
}

module.exports = { speak, voices, transcribe, ping };
