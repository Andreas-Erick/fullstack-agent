// Connection checks for the local services (FreeLLMAPI and VoiceStudio) with a diagnosis and
// step-by-step help that matches what went wrong. Used by the setup interview, the scripted brain
// setup and the agent's mechanic role.
const store = require('./store');

const DEFAULTS = { freellmapi: 'http://localhost:3001/v1', voicestudio: 'http://localhost:3900' };

function classify(err) {
  const code = err?.cause?.code || err?.code || '';
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET/.test(code) || /fetch failed/i.test(err?.message)) return 'unreachable';
  if (err?.name === 'TimeoutError' || /timeout/i.test(err?.message)) return 'timeout';
  return 'error';
}

function root(url) {
  return String(url || '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function checkFreeLLMAPI(url, key) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  const out = { service: 'freellmapi', name: 'FreeLLMAPI', url: base, ok: false };
  try {
    const res = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(6000) });
    if (res.status === 401 || res.status === 403) return { ...out, status: 'auth', detail: `The server answered with ${res.status}: it needs a valid bearer token.` };
    if (res.status === 404) return { ...out, status: 'not_found', detail: `${base}/models was not found (404).` };
    if (!res.ok) return { ...out, status: 'error', detail: `The server answered with ${res.status}.` };
    const json = await res.json().catch(() => ({}));
    const models = (Array.isArray(json) ? json : json.data || json.models || []).map((m) => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean);
    if (!models.length) return { ...out, status: 'no_models', detail: 'The server is running but offers no models.' };
    return { ...out, ok: true, status: 'ok', detail: `Connected — ${models.length} models available.`, models: models.slice(0, 30) };
  } catch (err) {
    const status = classify(err);
    return { ...out, status, detail: status === 'unreachable' ? `Nothing is answering at ${base}.` : status === 'timeout' ? `${base} did not answer within 6 seconds.` : err.message };
  }
}

async function checkVoiceStudio(url, key, voice) {
  const base = root(url);
  const out = { service: 'voicestudio', name: 'VoiceStudio', url: base, ok: false };
  const headers = { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
  try {
    const res = await fetch(`${base}/v1/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'tts-1', input: 'ok', voice: voice || 'default', response_format: 'mp3' }),
      signal: AbortSignal.timeout(20000),
    });
    const voices = await require('./voice').voices({ baseUrl: base, apiKey: key }).catch(() => []);
    const voiceIds = voices.map((v) => v.id).slice(0, 60);
    if (res.status === 401 || res.status === 403) return { ...out, status: 'auth', detail: `VoiceStudio answered with ${res.status}: it needs an API key.`, voices: voiceIds };
    if (res.status === 404) return { ...out, status: 'not_found', detail: `${base}/v1/audio/speech was not found (404).`, voices: voiceIds };
    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 200);
      const badVoice = /voice/i.test(text) || res.status === 422 || res.status === 400;
      return { ...out, status: badVoice ? 'bad_voice' : 'error', detail: `VoiceStudio answered ${res.status}${text ? `: ${text}` : ''}`, voices: voiceIds };
    }
    return { ...out, ok: true, status: 'ok', detail: `Connected — speech works${voiceIds.length ? `, ${voiceIds.length} voices available` : ''}.`, voices: voiceIds };
  } catch (err) {
    const status = classify(err);
    return { ...out, status, detail: status === 'unreachable' ? `Nothing is answering at ${base}.` : status === 'timeout' ? `${base} did not answer in time.` : err.message };
  }
}

// Step-by-step help for each diagnosis. Kept generic on purpose: how each tool is installed and
// launched depends on the user's setup, so the steps say what to check, not invented commands.
function help(r) {
  const settingsPlace = r.service === 'freellmapi' ? 'Config → AI brain → FreeLLMAPI' : 'Config → Voice output';
  const what = r.service === 'freellmapi'
    ? 'FreeLLMAPI is a small server on your computer that gives me access to free language models through an OpenAI-compatible address (it ends in /v1).'
    : 'VoiceStudio is a program on your computer that turns my replies into speech through an OpenAI-compatible address (/v1/audio/speech).';
  const steps = {
    ok: [],
    unreachable: [
      r.installedAt
        ? `${r.name} is installed on this computer (${r.installedAt}). I can start it for you now (helper_app_start), and from now on Nexus starts it by itself (Settings → Helper apps).`
        : `Start ${r.name} on this computer the way you normally launch it, and leave it running (its window or service must stay open). If it is installed somewhere unusual, set its location in Settings → Helper apps, and Nexus will start it for you from then on.`,
      `Look at the address it shows when it starts (or in its settings). I'm currently trying ${r.url}${r.service === 'freellmapi' ? ' (the default is http://localhost:3001/v1)' : ' (the default is http://localhost:3900)'}.`,
      'If the address is different, tell me — I’ll switch to it and check again.',
      'If it still fails: make sure nothing else uses that port and that a firewall isn’t blocking local connections.',
    ],
    timeout: [`${r.name} is reachable but very slow — it may still be starting up. Wait a moment, then I’ll check again.`],
    auth: [
      `${r.name} is running but asks for a key/token. You find it in ${r.name}'s own configuration (the API key or token it was set up with).`,
      'I’ll open a secure field for it — please don’t type it into the chat.',
    ],
    not_found: [
      `Something answers at ${r.url}, but not the endpoint I need.`,
      r.service === 'freellmapi' ? 'OpenAI-compatible servers usually live under /v1 — the address should end in /v1 (for example http://localhost:3001/v1).' : 'The address should be the server root (for example http://localhost:3900) — I add /v1/audio/speech myself.',
      'Check the address and port it shows, and tell me the right one.',
    ],
    no_models: [
      'FreeLLMAPI is running but has no models yet. Add at least one provider or model in FreeLLMAPI’s own configuration (it usually needs the free API keys of the providers it routes to).',
      'Restart it, then I’ll check again.',
    ],
    bad_voice: [
      `VoiceStudio is running, but the selected voice didn't work.${r.voices?.length ? ` Available voices include: ${r.voices.slice(0, 8).join(', ')}.` : ''}`,
      'Pick a voice (I can choose one that fits me) and I’ll test it.',
    ],
    error: [`${r.name} answered with an unexpected error: ${r.detail}`, `Check ${r.name}'s own window or log for the reason, then I'll check again.`],
  };
  return { ...r, about: what, steps: steps[r.status] || steps.error, laterIn: settingsPlace };
}

async function check(service, { url } = {}) {
  const s = await store.getSettings();
  const installedAt = (id) => require('./helperapps').installedPath(id, s);
  if (service === 'freellmapi') return help({ ...(await checkFreeLLMAPI(url || s.llm.baseUrl || DEFAULTS.freellmapi, s.llm.apiKey)), installedAt: installedAt('freellmapi') });
  if (service === 'voicestudio') return help({ ...(await checkVoiceStudio(url || s.voice.baseUrl || DEFAULTS.voicestudio, s.voice.apiKey, s.voice.voice)), installedAt: installedAt('voicestudio') });
  throw new Error('service must be "freellmapi" or "voicestudio"');
}

module.exports = { check, DEFAULTS };
