// Creating voices in VoiceStudio from the app: design a voice from a description, clone one from a
// recording, list and delete them. Uses VoiceStudio's local API (the same server that speaks).
const store = require('./store');

const AUDIO_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.webm': 'audio/webm' };
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

async function conn() {
  const s = await store.getSettings();
  const root = String(s.voice.baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  if (!root) throw new Error('VoiceStudio URL is not set (Settings → Voice output).');
  return { root, headers: s.voice.apiKey ? { Authorization: `Bearer ${s.voice.apiKey}` } : {} };
}

async function call(pathname, { method = 'GET', json, form, timeout = 120000 } = {}) {
  const { root, headers } = await conn();
  let res;
  try {
    res = await fetch(`${root}${pathname}`, {
      method,
      headers: json ? { ...headers, 'Content-Type': 'application/json' } : headers,
      body: json ? JSON.stringify(json) : form,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new Error(`VoiceStudio is not reachable at ${root} (${err.cause?.code || err.message}). Is it running?`);
  }
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { detail: text };
  }
  if (!res.ok) {
    const detail = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail || body.error || body).slice(0, 300);
    throw new Error(`VoiceStudio error ${res.status}: ${detail}`);
  }
  return body;
}

async function list() {
  const r = await call('/v1/audio/voices', { timeout: 10000 });
  return (r.voices || []).filter((v) => v.type === 'profile').map((v) => ({ id: v.voice_id, name: v.name, language: v.language }));
}

// Free-text description → VoiceStudio's design attributes (gender, age, pitch, style, accent).
async function design({ name, description, sampleText = '', language = 'Auto' }) {
  if (!name?.trim()) throw new Error('The new voice needs a name.');
  const parsed = await call('/design/describe', { method: 'POST', json: { description: description || '' } });
  const form = new FormData();
  form.append('name', name.trim());
  form.append('kind', 'design');
  form.append('vd_states', JSON.stringify(parsed.attrs || {}));
  form.append('instruct', parsed.instruct || '');
  form.append('language', language);
  if (sampleText) form.append('ref_text', sampleText);
  const profile = await call('/profiles', { method: 'POST', form, timeout: 300000 });
  return {
    id: profile.id,
    name: profile.name || name,
    understood: parsed.instruct || '(neutral voice: nothing in the description matched)',
    ignored: parsed.unmatched || [],
  };
}

// Reference recording (a few clean seconds of one speaker) → a cloned voice.
async function clone({ name, audio, filename = 'reference.wav', transcript = '', language = 'Auto' }) {
  if (!name?.trim()) throw new Error('The new voice needs a name.');
  if (!audio?.length) throw new Error('The recording is empty.');
  if (audio.length > MAX_AUDIO_BYTES) throw new Error('The recording is too large (25 MB max); a 10–30 second clip is ideal.');
  const ext = (filename.match(/\.[a-z0-9]+$/i)?.[0] || '.wav').toLowerCase();
  const form = new FormData();
  form.append('name', name.trim());
  form.append('kind', 'clone');
  form.append('language', language);
  form.append('ref_text', transcript);
  form.append('ref_audio', new Blob([audio], { type: AUDIO_TYPES[ext] || 'application/octet-stream' }), `reference${ext}`);
  const profile = await call('/profiles', { method: 'POST', form, timeout: 300000 });
  return { id: profile.id, name: profile.name || name };
}

async function remove(id) {
  await call(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

module.exports = { list, design, clone, remove, AUDIO_TYPES };
