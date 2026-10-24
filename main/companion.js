// Companion server (docs/ROADMAP-mobile.md, step 1): lets a paired phone or other computer chat with
// the assistant and answer approvals, while the brain and data stay here. Off by default.
//  - HTTP on 127.0.0.1, or on the local network when remote.lan is on. No port is opened otherwise.
//    From anywhere: through the tunnel (tunnel.js), which reaches 127.0.0.1 and brings HTTPS.
//  - Pairing: the desktop shows a one-time code (5 minutes, one use, 5 wrong tries); the device gets a
//    long-lived token. Only its SHA-256 is stored (<userData>/remote-devices.json); revocable per device.
//  - Every call needs the token. Host and Origin are checked (DNS rebinding, other web pages), no CORS.
//  - Scope: chat, conversations (read) and approvals. Never settings, secrets, setup or screen sharing.
//  - Streaming: GET /api/events is a Server-Sent Events stream of chat and approval events.
//  - The phone client (step 2) is static files from renderer/remote/, served without a token (they
//    hold no data) under a strict Content Security Policy.
const http = require('http');
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');
const store = require('./store');
const voice = require('./voice');
const tunnel = require('./tunnel');
const log = require('./logger');

const ROOT = path.join(__dirname, '..');
// URL path -> file (relative to the app root). Nothing else is served.
const STATIC = {
  '/': 'renderer/remote/index.html',
  '/app.js': 'renderer/remote/app.js',
  '/styles.css': 'renderer/remote/styles.css',
  '/sw.js': 'renderer/remote/sw.js',
  '/manifest.webmanifest': 'renderer/remote/manifest.webmanifest',
  '/icon.png': 'assets/logo.png',
  '/vendor/marked.js': 'node_modules/marked/lib/marked.umd.js',
  '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js',
};
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const HEX = /^#[0-9a-f]{6}$/i;

const MAX_BODY = 64 * 1024;
const MAX_AUDIO_SEC = 60;
const PAIR_TTL_MS = 5 * 60 * 1000;
const PAIR_TRIES = 5;
const TURNS_PER_MIN = 20;
const STREAMS_PER_DEVICE = 3;
const STREAMED = new Set(['chat:event', 'approval:request', 'approval:cancel']);

let hooks = null; // { startTurn, abortTurn, notify } from main.js
let server = null;
let current = { enabled: false, lan: false, port: 0 };
let lastError = '';
let access = { team: '', aud: '' }; // Cloudflare Access application in front of the tunnel (optional)
let pairing = null; // { code, expiresAt, tries }
const streams = new Set(); // { res, deviceId }
const openApprovals = new Map(); // approval id -> request; only these can be answered remotely (never secret or recording prompts)
const turnOwners = new Map(); // requestId -> deviceId
const rateTimes = new Map(); // `${bucket}:${deviceId}` -> [timestamps]

const devicesFile = () => path.join(store.dataDir(), 'remote-devices.json');
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function readDevices() {
  const list = await store.readJson(devicesFile(), []);
  return Array.isArray(list) ? list : [];
}

async function writeDevices(list) {
  await store.writeJsonAtomic(devicesFile(), list);
}

function init(h) {
  hooks = h;
}

// Starts, restarts or stops the server to match settings.remote.
async function apply(settings) {
  const r = settings.remote || {};
  const port = Math.round(Number(r.port));
  const want = { enabled: Boolean(r.enabled), lan: Boolean(r.lan), port: port >= 1024 && port <= 65535 ? port : 7823 };
  access = { team: r.accessTeam || '', aud: String(r.accessAud || '').trim() };
  if (!(server && want.enabled && want.lan === current.lan && want.port === current.port)) await restart(want);
  await tunnel.apply(settings, server ? current.port : 0);
  return status();
}

async function restart(want) {
  await stop();
  current = want;
  if (!want.enabled) return;
  lastError = '';
  await new Promise((resolve) => {
    const s = http.createServer((req, res) => route(req, res).catch((err) => fail(res, 500, 'Server error', err)));
    s.on('error', (err) => {
      lastError = err.code === 'EADDRINUSE' ? `Port ${want.port} is already in use. Choose another port.` : err.message;
      log.warn('remote server error', { error: err });
      server = null;
      resolve();
    });
    s.listen(want.port, want.lan ? '0.0.0.0' : '127.0.0.1', () => {
      server = s;
      log.info('remote server listening', { port: want.port, lan: want.lan });
      resolve();
    });
  });
}

async function stop() {
  tunnel.stop();
  for (const st of streams) st.res.end();
  streams.clear();
  if (!server) return;
  const s = server;
  server = null;
  const closed = new Promise((resolve) => s.close(() => resolve()));
  s.closeAllConnections?.();
  await closed;
  log.info('remote server stopped');
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function urls() {
  if (!server) return [];
  const hosts = current.lan ? lanAddresses() : ['127.0.0.1'];
  const t = tunnel.status();
  return [...(t.connected && t.url ? [t.url] : []), ...hosts.map((h) => `http://${h}:${current.port}`)];
}

async function status() {
  const devices = (await readDevices()).map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen, connected: [...streams].some((s) => s.deviceId === id) }));
  return { enabled: current.enabled, listening: Boolean(server), lan: current.lan, port: current.port, urls: urls(), error: lastError, tunnel: tunnel.status(), access: Boolean(access.team && access.aud), devices, pairing: pairing && pairing.expiresAt > Date.now() ? { code: pairing.code, expiresAt: pairing.expiresAt } : null };
}

// Desktop only (IPC): a fresh one-time pairing code.
function startPairing() {
  if (!server) throw new Error('Turn on remote access first.');
  pairing = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), expiresAt: Date.now() + PAIR_TTL_MS, tries: 0 };
  log.info('remote pairing started');
  return { code: pairing.code, expiresAt: pairing.expiresAt, urls: urls() };
}

async function revoke(id) {
  const list = await readDevices();
  const device = list.find((d) => d.id === id);
  await writeDevices(list.filter((d) => d.id !== id));
  for (const st of streams) if (st.deviceId === id) (st.res.end(), streams.delete(st));
  if (device) log.info('remote device revoked', { device: device.name });
  return Boolean(device);
}

// Called by main.js for every event sent to the window; devices only get chat and approval events.
function publish(channel, payload) {
  if (!STREAMED.has(channel)) return;
  if (channel === 'chat:event' && ['done', 'error', 'aborted'].includes(payload.type)) turnOwners.delete(payload.requestId);
  if (channel === 'approval:cancel') openApprovals.delete(payload.id);
  // Open approvals are kept (until answered or timed out) so a device that connects later sees them.
  if (channel === 'approval:request') openApprovals.set(payload.id, payload);
  const data = sse(channel, payload);
  for (const st of streams) st.res.write(data);
}

const sse = (channel, payload) => `event: ${channel.replace(':', '.')}\ndata: ${JSON.stringify(payload)}\n\n`;

// ------------------------------------------------------------- requests
// Requests arrive as 127.0.0.1 / localhost / a LAN address with our port, or through the tunnel with
// its public hostname (HTTPS at the edge). Anything else is refused (DNS rebinding).
function hostKind(host) {
  const pub = tunnel.publicHost();
  if (pub && host === pub) return 'tunnel';
  const names = ['127.0.0.1', 'localhost', ...(current.lan ? lanAddresses() : [])];
  return names.some((n) => host === `${n}:${current.port}`) ? 'local' : null;
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

function fail(res, code, message, err) {
  if (err) log.warn('remote request failed', { error: err });
  if (code === 413) {
    res.setHeader('Connection', 'close');
    res.on('finish', () => res.socket?.destroy());
  }
  if (!res.headersSent) json(res, code, { error: message });
  else res.end();
}

function readBody(req, { raw = false, max = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        // Stop keeping it; the 413 goes out, then the connection is closed (see fail()).
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (raw) return resolve(Buffer.concat(chunks));
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

async function authenticate(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const want = Buffer.from(hash(m[1]), 'hex');
  const list = await readDevices();
  const device = list.find((d) => crypto.timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), want));
  if (!device) return null;
  // lastSeen is coarse (one write per 5 minutes at most).
  if (!device.lastSeen || Date.now() - device.lastSeen > 5 * 60 * 1000) {
    device.lastSeen = Date.now();
    writeDevices(list).catch(() => {});
  }
  return device;
}

function underLimit(bucket, deviceId, perMin) {
  const key = `${bucket}:${deviceId}`;
  const now = Date.now();
  const times = (rateTimes.get(key) || []).filter((t) => now - t < 60000);
  rateTimes.set(key, times);
  if (times.length >= perMin) return false;
  times.push(now);
  return true;
}

async function serveStatic(res, rel) {
  try {
    const data = await fsp.readFile(path.join(ROOT, rel));
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(rel)] || 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    res.end(data);
  } catch (err) {
    fail(res, 404, 'Not found', err);
  }
}

// Name and colors for the phone client, so it looks like the desktop.
async function info() {
  const s = await store.getSettings();
  const colors = {};
  for (const [k, v] of Object.entries(s.appearance?.theme?.colors || {})) if (HEX.test(v)) colors[k] = v;
  return { name: String(s.agent.name || 'Nexus').slice(0, 40), colors, voice: Boolean(s.voice?.baseUrl) };
}

async function speak(req, res) {
  const body = await readBody(req).catch((e) => e);
  if (body instanceof Error) return fail(res, body.status || 400, body.message);
  const text = String(body.text || '').trim().slice(0, 4000);
  if (!text) return fail(res, 400, 'Nothing to say');
  const { mime, audio } = await voice.speak(text).catch((err) => ({ err }));
  if (!audio) return fail(res, 502, 'The voice is not available right now');
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(Buffer.from(audio));
}

async function route(req, res) {
  const host = req.headers.host || '';
  const kind = hostKind(host);
  if (!kind) {
    log.warn('remote request for an unknown host', { host: host.slice(0, 100) });
    return fail(res, 403, 'Unknown host');
  }
  const origin = req.headers.origin;
  if (origin && origin !== `${kind === 'tunnel' ? 'https' : 'http'}://${host}`) return fail(res, 403, 'Cross-origin requests are not allowed');
  // Behind Cloudflare Access, every request must carry Access's signed login (checked here too).
  if (kind === 'tunnel' && tunnel.status().mode === 'cloudflare' && access.team && access.aud) {
    try {
      await tunnel.verifyAccess(req.headers['cf-access-jwt-assertion'], access);
    } catch (err) {
      log.warn('remote request without a valid Access login', { reason: err.message });
      return fail(res, 403, 'Sign in through Cloudflare Access first');
    }
  }
  const url = new URL(req.url, `http://${host}`);
  const p = url.pathname;
  const type = req.headers['content-type'] || '';
  const wantType = p === '/api/transcribe' ? /^audio\/wav\b/ : /^application\/json\b/;
  if (req.method === 'POST' && !wantType.test(type)) return fail(res, 415, 'Unsupported content type');

  if (req.method === 'GET' && STATIC[p]) return serveStatic(res, STATIC[p]);
  if (req.method === 'GET' && p === '/api/ping') return json(res, 200, { app: 'nexus-agent', api: 1 });
  if (req.method === 'POST' && p === '/api/pair') return pair(req, res);

  const device = await authenticate(req);
  if (!device) return fail(res, 401, 'Not paired, or this device was removed');

  if (req.method === 'GET' && p === '/api/events') return openStream(req, res, device);
  if (req.method === 'GET' && p === '/api/info') return json(res, 200, await info());
  if (req.method === 'POST' && p === '/api/speak') {
    if (!underLimit('speak', device.id, 60)) return fail(res, 429, 'Too many requests; wait a minute');
    return speak(req, res);
  }
  if (req.method === 'POST' && p === '/api/transcribe') {
    if (!underLimit('transcribe', device.id, 30)) return fail(res, 429, 'Too many requests; wait a minute');
    return transcribe(req, res, device);
  }
  if (req.method === 'GET' && p === '/api/conversations') return json(res, 200, await store.listConversations());
  let m = /^\/api\/conversations\/([\w-]+)$/.exec(p);
  if (req.method === 'GET' && m) {
    const conv = await store.getConversation(m[1]);
    if (!conv || conv.setup) return fail(res, 404, 'Conversation not found');
    return json(res, 200, { ...conv, messages: conv.messages.filter((x) => !x.hidden).map(({ raw, ...rest }) => rest) });
  }
  if (req.method === 'POST' && p === '/api/chat') return chat(req, res, device);
  m = /^\/api\/chat\/([\w-]+)\/abort$/.exec(p);
  if (req.method === 'POST' && m) {
    if (turnOwners.get(m[1]) !== device.id) return fail(res, 404, 'No such request from this device');
    hooks.abortTurn(m[1]);
    return json(res, 200, { ok: true });
  }
  m = /^\/api\/approvals\/([\w-]+)$/.exec(p);
  if (req.method === 'POST' && m) {
    const body = await readBody(req).catch((e) => e);
    if (body instanceof Error) return fail(res, body.status || 400, body.message);
    if (!openApprovals.has(m[1])) return fail(res, 404, 'No open approval with that id');
    openApprovals.delete(m[1]);
    const allow = body.allow === true;
    log.info('remote approval', { device: device.name, allow });
    return json(res, 200, { ok: hooks.respondApproval(m[1], allow, allow ? '' : `The user said no (on ${device.name}).`) });
  }
  return fail(res, 404, 'Not found');
}

// Push-to-talk: a 16 kHz mono 16-bit WAV (at most MAX_AUDIO_SEC) is transcribed on the desktop with
// the user's speech-to-text (local Whisper runs in the window, so main.js hands it over).
async function transcribe(req, res, device) {
  const wav = await readBody(req, { raw: true, max: 44 + MAX_AUDIO_SEC * 32000 }).catch((e) => e);
  if (wav instanceof Error) return fail(res, wav.status || 400, wav.message);
  const valid = wav.length > 44 && wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE' && wav.readUInt16LE(22) === 1 && wav.readUInt32LE(24) === 16000 && wav.readUInt16LE(34) === 16;
  if (!valid) return fail(res, 400, 'Send 16 kHz mono 16-bit WAV');
  try {
    const text = await hooks.transcribe(wav);
    log.info('remote transcription', { device: device.name, seconds: Math.round((wav.length - 44) / 32000), chars: text.length });
    return json(res, 200, { text });
  } catch (err) {
    return fail(res, 502, err.message || 'Speech-to-text failed', err);
  }
}

async function pair(req, res) {
  const body = await readBody(req).catch((e) => e);
  if (body instanceof Error) return fail(res, body.status || 400, body.message);
  if (!pairing || pairing.expiresAt < Date.now()) return fail(res, 403, 'No pairing in progress. Start pairing on the desktop.');
  const code = String(body.code || '');
  const ok = code.length === pairing.code.length && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code));
  if (!ok) {
    if (++pairing.tries >= PAIR_TRIES) pairing = null;
    log.warn('remote pairing: wrong code');
    return fail(res, 403, 'Wrong code');
  }
  pairing = null;
  const token = crypto.randomBytes(32).toString('base64url');
  const device = { id: store.newId('dev'), name: String(body.name || 'Device').replace(/[^\w .()-]/g, '').slice(0, 40) || 'Device', tokenHash: hash(token), createdAt: Date.now(), lastSeen: Date.now() };
  await writeDevices([...(await readDevices()), device]);
  log.info('remote device paired', { device: device.name });
  hooks.notify({ type: 'paired', name: device.name });
  return json(res, 200, { token, deviceId: device.id, name: device.name });
}

function openStream(req, res, device) {
  if ([...streams].filter((s) => s.deviceId === device.id).length >= STREAMS_PER_DEVICE) return fail(res, 429, 'Too many open streams');
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
  res.write(': connected\n\n');
  for (const a of openApprovals.values()) res.write(sse('approval:request', a));
  const st = { res, deviceId: device.id };
  streams.add(st);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    streams.delete(st);
  });
}

async function chat(req, res, device) {
  const body = await readBody(req).catch((e) => e);
  if (body instanceof Error) return fail(res, body.status || 400, body.message);
  const text = String(body.text || '').trim();
  if (!text) return fail(res, 400, 'Empty message');
  if (text.length > 20000) return fail(res, 413, 'Message too long');
  if (!underLimit('turn', device.id, TURNS_PER_MIN)) return fail(res, 429, 'Too many messages; wait a minute');
  if (body.conversationId) {
    const conv = await store.getConversation(String(body.conversationId));
    if (!conv) return fail(res, 404, 'Conversation not found');
    if (conv.setup) return fail(res, 403, 'The setup conversation can only be used on the desktop');
  }
  const requestId = `r${Date.now()}${crypto.randomBytes(3).toString('hex')}`;
  turnOwners.set(requestId, device.id);
  log.info('remote turn', { device: device.name, turn: requestId.slice(-6) });
  const r = await hooks.startTurn({ conversationId: body.conversationId || null, text, requestId, remote: device.name });
  return json(res, 200, { requestId, conversationId: r.conversationId });
}

module.exports = { init, apply, stop, status, startPairing, revoke, publish };
