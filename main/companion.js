// Companion server (docs/ROADMAP-mobile.md, step 1): lets a paired phone or other computer chat with
// the assistant and answer approvals, while the brain and data stay here. Off by default.
//  - HTTP on 127.0.0.1, or on the local network when remote.lan is on. No port is opened otherwise.
//    From anywhere: through the tunnel (tunnel.js), which reaches 127.0.0.1 and brings HTTPS.
//  - Pairing: the desktop shows a one-time code and a QR code (5 minutes, one use, 5 wrong tries); the
//    QR link carries a 256-bit secret in its #fragment. The device gets a long-lived token. Only its
//    SHA-256 is stored (<userData>/remote-devices.json); revocable per device or all at once; unused
//    for 90 days, it expires.
//  - Every call needs the token. Host and Origin are checked (DNS rebinding, other web pages), no CORS.
//  - Moving to the secure address: a paired device on the local network asks for a one-time secret
//    (POST /api/move, 2 minutes); redeemed through the tunnel (POST /api/pair { move }), it rotates
//    that device's token, so the one that crossed the plain network stops working.
//  - Scope: chat, conversations (read), approvals and the schedule (read). Never settings, secrets,
//    setup or screen sharing.
//  - Streaming: GET /api/events is a Server-Sent Events stream of chat and approval events.
//  - The phone client (step 2) is static files from renderer/remote/, served without a token (they
//    hold no data) under a strict Content Security Policy.
const http = require('http');
const os = require('os');
const path = require('path');
const fsp = require('fs').promises;
const crypto = require('crypto');
const store = require('./store');
const data = require('./companiondata');
const voice = require('./voice');
const tunnel = require('./tunnel');
const calendar = require('./calendar');
const log = require('./logger');

const ROOT = path.join(__dirname, '..');
// URL path -> file (relative to the app root). Nothing else is served.
const STATIC = {
  '/': 'renderer/remote/index.html',
  '/app.js': 'renderer/remote/app.js',
  '/screens.js': 'renderer/remote/screens.js',
  '/styles.css': 'renderer/remote/styles.css',
  '/sw.js': 'renderer/remote/sw.js',
  '/manifest.webmanifest': 'renderer/remote/manifest.webmanifest',
  '/icon.png': 'assets/logo.png',
  '/vendor/marked.js': 'node_modules/marked/lib/marked.umd.js',
  '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js',
  // The desktop's built-in faces (app code, no data), so the phone shows the same one.
  '/js/themecore.js': 'renderer/js/themecore.js',
  '/js/visualizer.js': 'renderer/js/visualizer.js',
  '/js/faces/env.js': 'renderer/js/faces/env.js',
  '/js/faces/common.js': 'renderer/js/faces/common.js',
  '/js/faces/radial.js': 'renderer/js/faces/radial.js',
  '/js/faces/rain.js': 'renderer/js/faces/rain.js',
  '/js/faces/neural.js': 'renderer/js/faces/neural.js',
  '/js/faces/companion.js': 'renderer/js/faces/companion.js',
  '/js/faces/siren.js': 'renderer/js/faces/siren.js',
  // The Inner World's drawing code (app code, no data), so the phone draws the same village.
  '/js/world/map.js': 'renderer/js/world/map.js',
  '/js/world/art.js': 'renderer/js/world/art.js',
  '/js/world/places.js': 'renderer/js/world/places.js',
  '/js/world/interiors.js': 'renderer/js/world/interiors.js',
  '/js/world/scene.js': 'renderer/js/world/scene.js',
  '/js/world/sprites.js': 'renderer/js/world/sprites.js',
  '/js/world/season.js': 'renderer/js/world/season.js',
};
// The village's rendered art (renderer/assets/world: WebP sprites and their manifest; CC0, no data).
const WORLD_ART = /^\/assets\/world\/([\w.-]+\.(webp|json))$/;
const FACES = ['siren', 'circuit', 'radial', 'rain', 'neural', 'companion'];
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; media-src 'self' blob:; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// On every response. HSTS is added for the tunnel address (HTTPS at the edge).
const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
};
const HEX = /^#[0-9a-f]{6}$/i;

const MAX_BODY = 64 * 1024;
const MAX_AUDIO_SEC = 60;
const PAIR_TTL_MS = 5 * 60 * 1000;
const PAIR_TRIES = 5;
const MOVE_TTL_MS = 2 * 60 * 1000;
const TURNS_PER_MIN = 20;
const STREAMS_PER_DEVICE = 3;
const MAX_CONNECTIONS = 64;
const DEVICE_IDLE_MS = 90 * 24 * 60 * 60 * 1000; // a device unused this long is unpaired
const STREAMED = new Set(['chat:event', 'approval:request', 'approval:cancel']);
const CHAT_TYPES = new Set(['start', 'text', 'retract', 'tool_start', 'tool_end', 'notice', 'done', 'error', 'aborted']);

let hooks = null; // { startTurn, abortTurn, notify } from main.js
let server = null;
let current = { enabled: false, lan: false, port: 0 };
let lastError = '';
let access = { team: '', aud: '' }; // Cloudflare Access application in front of the tunnel (optional)
let pairing = null; // { code, expiresAt, tries }
const moves = new Map(); // secret hash -> { deviceId, expiresAt }: moving a device to the secure address
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
    const s = http.createServer({ connectionsCheckingInterval: 5000 }, (req, res) => route(req, res).catch((err) => fail(res, 500, 'Server error', err)));
    // Slow or idle connections can't pile up (event streams are long responses, not slow requests).
    s.headersTimeout = 10000;
    s.requestTimeout = 60000;
    s.keepAliveTimeout = 5000;
    s.maxConnections = MAX_CONNECTIONS;
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
  const devices = (await readDevices()).map(({ id, name, createdAt, lastSeen, lastVia, lastIp }) => ({ id, name, createdAt, lastSeen, lastVia, lastIp, connected: [...streams].some((s) => s.deviceId === id) }));
  return { enabled: current.enabled, listening: Boolean(server), lan: current.lan, port: current.port, urls: urls(), error: lastError, tunnel: tunnel.status(), access: Boolean(access.team && access.aud), devices, pairing: pairing && pairing.expiresAt > Date.now() ? { code: pairing.code, expiresAt: pairing.expiresAt } : null };
}

// Desktop only (IPC): a fresh one-time pairing code to type, and a long one-time secret for the QR
// code. The secret travels in the link's #fragment, which browsers never send to a server or a log.
function startPairing() {
  if (!server) throw new Error('Turn on remote access first.');
  const secret = crypto.randomBytes(32).toString('base64url');
  pairing = { code: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), secretHash: hash(secret), expiresAt: Date.now() + PAIR_TTL_MS, tries: 0 };
  log.info('remote pairing started');
  // The QR code links to an address another device can reach (never 127.0.0.1).
  const links = urls().filter((u) => !/\/\/(127\.0\.0\.1|localhost)[:/]/.test(u)).map((u) => ({ url: u, link: `${u}/#pair=${secret}`, secure: u.startsWith('https:') }));
  return { code: pairing.code, expiresAt: pairing.expiresAt, urls: urls(), links };
}

function cancelPairing() {
  pairing = null;
}

async function revoke(id) {
  const list = await readDevices();
  const device = list.find((d) => d.id === id);
  await writeDevices(list.filter((d) => d.id !== id));
  for (const st of streams) if (st.deviceId === id) (st.res.end(), streams.delete(st));
  if (device) log.info('remote device revoked', { device: device.name });
  return Boolean(device);
}

// "Remove all devices" (e.g. a phone was lost): every token stops working at once.
async function revokeAll() {
  const n = (await readDevices()).length;
  await writeDevices([]);
  for (const st of streams) st.res.end();
  streams.clear();
  pairing = null;
  log.info('remote devices all revoked', { count: n });
  return n;
}

// Called by main.js for every event sent to the window; devices only get chat and approval events.
function publish(channel, payload) {
  if (!STREAMED.has(channel)) return;
  if (channel === 'chat:event' && ['done', 'error', 'aborted'].includes(payload.type)) turnOwners.delete(payload.requestId);
  if (channel === 'approval:cancel') openApprovals.delete(payload.id);
  // Open approvals are kept (until answered or timed out) so a device that connects later sees them.
  if (channel === 'approval:request') openApprovals.set(payload.id, { ...payload, at: Date.now() });
  const out = channel === 'chat:event' ? chatForDevice(payload) : channel === 'approval:request' ? approvalForDevice(openApprovals.get(payload.id)) : payload;
  if (!out) return;
  const data = sse(channel, out);
  for (const st of streams) st.res.write(data);
}

const sse = (channel, payload) => `event: ${channel.replace(':', '.')}\ndata: ${JSON.stringify(payload)}\n\n`;

// Devices get what the phone shows, nothing more: no tool arguments or results (file contents, commands,
// notes), no internal events (settings, vault, self-change). The window keeps the full events.
function chatForDevice(ev) {
  if (!CHAT_TYPES.has(ev.type)) return null;
  const base = { requestId: ev.requestId, conversationId: ev.conversationId, type: ev.type };
  switch (ev.type) {
    case 'start':
      return { ...base, title: ev.title, userMessage: messageForDevice(ev.userMessage) };
    case 'text':
      return { ...base, delta: ev.delta };
    case 'retract':
      return { ...base, chars: ev.chars };
    case 'tool_start':
      return { ...base, id: ev.id, name: ev.name };
    case 'tool_end':
      return { ...base, id: ev.id, name: ev.name, ok: ev.ok };
    case 'done':
      return { ...base, message: messageForDevice(ev.message) };
    default:
      return { ...base, message: ev.message };
  }
}

// A stored or streamed message without the raw provider data and tool inputs/results; a /skill shows
// what was typed rather than the expanded steps.
function messageForDevice(m) {
  if (!m) return m;
  const { raw, toolCalls, display, content, ...rest } = m;
  return { ...rest, content: display ?? content, ...(toolCalls?.length ? { toolCalls: toolCalls.map((t) => ({ name: t.name, ok: t.ok })) } : {}) };
}

// expiresIn: seconds left, so a device that connects later shows the right countdown.
function approvalForDevice(a) {
  const { at, ...rest } = a;
  return { ...rest, expiresIn: Math.max(0, Math.round((a.timeoutSec || 0) - (Date.now() - at) / 1000)) };
}

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

// Where a request came from, for the device list ("via the secure address, 203.0.113.7"). Through the
// tunnel the socket is cloudflared or Tailscale on this computer, so their forwarding header is used.
function clientAddress(req, kind) {
  const fwd = kind === 'tunnel' ? String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = (fwd || req.socket.remoteAddress || '').replace(/^::ffff:/, '').slice(0, 64);
  return { via: kind === 'tunnel' ? 'secure address' : ip === '127.0.0.1' || ip === '::1' ? 'this computer' : 'local network', ip };
}

async function authenticate(req, kind) {
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const want = Buffer.from(hash(m[1]), 'hex');
  const list = await readDevices();
  const device = list.find((d) => /^[0-9a-f]{64}$/.test(d.tokenHash) && crypto.timingSafeEqual(Buffer.from(d.tokenHash, 'hex'), want));
  if (!device) return null;
  // A device unused for months (a lost or forgotten phone) is unpaired instead of let in.
  if (Date.now() - (device.lastSeen || device.createdAt || 0) > DEVICE_IDLE_MS) {
    log.info('remote device expired', { device: device.name });
    await revoke(device.id);
    return null;
  }
  // lastSeen is coarse (one write per 5 minutes at most), the address is kept current.
  const from = clientAddress(req, kind);
  if (!device.lastSeen || Date.now() - device.lastSeen > 5 * 60 * 1000 || device.lastIp !== from.ip) {
    if (device.lastIp && device.lastIp !== from.ip) log.info('remote device address changed', { device: device.name, via: from.via });
    Object.assign(device, { lastSeen: Date.now(), lastVia: from.via, lastIp: from.ip });
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
  const fx = ['hud', 'subtle', 'off'].includes(s.ui?.fx) ? s.ui.fx : 'hud';
  // The face chosen on the desktop (custom faces live in the user's data folder and stay there) and the
  // theme's face parameters; the phone normalizes them again (themecore.normalizeTheme).
  const f = s.appearance?.theme?.face || {};
  const face = { id: FACES.includes(s.ui?.face) ? s.ui.face : 'siren', states: {} };
  if (/^\w{1,20}$/.test(f.core || '')) face.core = f.core;
  if (/^\w{1,20}$/.test(f.traces || '')) face.traces = f.traces;
  if (Number.isFinite(+f.density)) face.density = +f.density;
  if (Number.isFinite(+f.glow)) face.glow = +f.glow;
  for (const [k, v] of Object.entries(f.states || {})) if (/^\w{1,12}$/.test(k) && Array.isArray(v) && HEX.test(v[0])) face.states[k] = [v[0], HEX.test(v[1]) ? v[1] : v[0]];
  const sleepAfterMin = Math.max(0, Math.min(240, Number(s.ui?.sleepAfterMin) || 0));
  const t = tunnel.status();
  const secureUrl = t.connected && /^https:\/\//.test(t.url) ? t.url : '';
  return { name: String(s.agent.name || 'Siren').slice(0, 40), colors, voice: Boolean(s.voice?.ttsEnabled && (s.voice.engine === 'local' || s.voice.baseUrl)), fx, face, sleepAfterMin, secureUrl, calendar: Boolean(s.calendar?.enabled), share: s.remote?.shareData !== false, world: Boolean(s.innerWorld?.enabled), season: s.innerWorld?.season || 'auto', art: s.innerWorld?.art || 'rendered' };
}

async function speak(req, res) {
  const body = await readBody(req).catch((e) => e);
  if (body instanceof Error) return fail(res, body.status || 400, body.message);
  const text = String(body.text || '').trim().slice(0, 4000);
  if (!text) return fail(res, 400, 'Nothing to say');
  const s = await store.getSettings();
  // The offline voice (the default) runs in the desktop window; VoiceStudio falls back to it when chosen.
  const offline = () => hooks.synthesize(text).then((wav) => ({ mime: 'audio/wav', audio: wav }));
  const viaStudio = s.voice?.engine !== 'local';
  let { mime, audio } = await (viaStudio ? voice.speak(text) : offline()).catch((err) => ({ err }));
  if (!audio && viaStudio && (s.voice?.fallback || 'local') === 'local') ({ mime, audio } = await offline().catch((err) => ({ err })));
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
  for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
  if (kind === 'tunnel') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
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
  const art = req.method === 'GET' && WORLD_ART.exec(p);
  if (art && !art[1].startsWith('.')) return serveStatic(res, `renderer/assets/world/${art[1]}`);
  if (req.method === 'GET' && p === '/api/ping') return json(res, 200, { app: 'nexus-agent', api: 1 });
  if (req.method === 'POST' && p === '/api/pair') return pair(req, res, kind);

  const device = await authenticate(req, kind);
  if (!device) return fail(res, 401, 'Not paired, or this device was removed');

  if (req.method === 'GET' && p === '/api/events') return openStream(req, res, device);
  if (req.method === 'GET' && p === '/api/info') return json(res, 200, await info());
  if (req.method === 'POST' && p === '/api/move') return startMove(res, device);
  if (req.method === 'GET' && p === '/api/schedule') {
    if (!underLimit('schedule', device.id, 60)) return fail(res, 429, 'Too many requests; wait a minute');
    return schedule(url, res);
  }
  if (p.startsWith('/api/data/')) return dataRoute(req, res, url, device);
  if (req.method === 'POST' && p === '/api/speak') {
    if (!underLimit('speak', device.id, 60)) return fail(res, 429, 'Too many requests; wait a minute');
    return speak(req, res);
  }
  if (req.method === 'POST' && p === '/api/transcribe') {
    if (!underLimit('transcribe', device.id, 30)) return fail(res, 429, 'Too many requests; wait a minute');
    return transcribe(req, res, device);
  }
  if (req.method === 'GET' && p === '/api/conversations') {
    const list = (await store.listConversations()).filter((c) => !c.setup);
    return json(res, 200, list.map(({ id, title, updatedAt, createdAt }) => ({ id, title, updatedAt, createdAt })));
  }
  let m = /^\/api\/conversations\/([\w-]+)$/.exec(p);
  if (req.method === 'GET' && m) {
    const conv = await store.getConversation(m[1]);
    if (!conv || conv.setup) return fail(res, 404, 'Conversation not found');
    return json(res, 200, { id: conv.id, title: conv.title, updatedAt: conv.updatedAt, messages: conv.messages.filter((x) => !x.hidden).map(messageForDevice) });
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

// The device's schedule view: occurrences in a date range (at most 62 days), read-only.
async function schedule(url, res) {
  const s = await store.getSettings();
  if (!s.calendar?.enabled) return fail(res, 404, 'The calendar is turned off on the computer');
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  if (!day.test(from) || !day.test(to)) return fail(res, 400, 'from and to must be dates (YYYY-MM-DD)');
  const span = (new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86400000;
  if (!(span >= 1 && span <= 62)) return fail(res, 400, 'Ask for 1 to 62 days');
  try {
    const list = await calendar.events({ start: `${from}T00:00:00`, end: `${to}T00:00:00` });
    return json(res, 200, { events: list.map(({ id, entryId, title, location, notes, allDay, start, end, openEnd, recurring, rule }) => ({ id, entryId, title, location, notes, allDay, start, end, openEnd, recurring, rule })) });
  } catch (err) {
    return fail(res, 503, err.message);
  }
}

// The phone's data screens (companiondata.js): read-only, plus checking a habit off. Only while the
// user shares them (remote.shareData, a switch only they change), and rate-limited per device.
const DATA_GET = {
  today: () => data.today(),
  habits: () => data.habits(),
  learn: () => data.learn(),
  tree: () => data.tree(),
  memories: (url) => data.memories(url.searchParams.get('q') || ''),
  stream: () => data.stream(),
  notes: (url) => data.notes(url.searchParams.get('q') || ''),
  note: (url) => data.note(url.searchParams.get('path') || ''),
  world: () => data.world(),
  skills: () => data.skills(),
  routines: () => data.routines(),
};

async function dataRoute(req, res, url, device) {
  const s = await store.getSettings();
  if (s.remote?.shareData === false) return fail(res, 403, 'Sharing your notes, memories and progress with devices is off on the computer (Settings → Remote access)');
  if (!underLimit('data', device.id, 120)) return fail(res, 429, 'Too many requests; wait a minute');
  const name = url.pathname.slice('/api/data/'.length);
  try {
    if (req.method === 'GET' && Object.hasOwn(DATA_GET, name)) return json(res, 200, await DATA_GET[name](url));
    if (req.method === 'POST' && name === 'habits/log') {
      const body = await readBody(req);
      return json(res, 200, await data.logHabit(body.name, body.done, body.date));
    }
    return fail(res, 404, 'Not found');
  } catch (err) {
    return fail(res, err.status || (/vault|not found/i.test(err.message) ? 404 : 500), err.message.slice(0, 300), err);
  }
}

// A paired device on the local network asks to continue on the secure address.
function startMove(res, device) {
  const t = tunnel.status();
  if (!t.connected || !/^https:\/\//.test(t.url)) return fail(res, 409, 'There is no secure address. Set one up on the computer (Settings → Remote access).');
  const now = Date.now();
  for (const [k, m] of moves) if (m.expiresAt < now || m.deviceId === device.id) moves.delete(k);
  const secret = crypto.randomBytes(32).toString('base64url');
  moves.set(hash(secret), { deviceId: device.id, expiresAt: now + MOVE_TTL_MS });
  log.info('remote move started', { device: device.name });
  return json(res, 200, { url: t.url, secret });
}

// Redeems a move secret (only through the secure address): the same device, with a new token.
async function finishMove(res, secret) {
  const key = /^[A-Za-z0-9_-]{43}$/.test(secret) ? hash(secret) : '';
  const m = key && moves.get(key);
  if (m) moves.delete(key);
  if (!m || m.expiresAt < Date.now()) return fail(res, 403, 'This link has expired or was already used. Tap “Switch to the secure address” again.');
  const list = await readDevices();
  const device = list.find((d) => d.id === m.deviceId);
  if (!device) return fail(res, 403, 'This device was removed on the computer. Pair it again.');
  const token = crypto.randomBytes(32).toString('base64url');
  Object.assign(device, { tokenHash: hash(token), lastSeen: Date.now(), lastVia: 'secure address' });
  await writeDevices(list);
  for (const st of streams) if (st.deviceId === device.id) (st.res.end(), streams.delete(st)); // they used the old token
  log.info('remote device moved to the secure address', { device: device.name });
  hooks.notify({ type: 'moved', name: device.name });
  return json(res, 200, { token, deviceId: device.id, name: device.name });
}

async function pair(req, res, kind) {
  const body = await readBody(req).catch((e) => e);
  if (body instanceof Error) return fail(res, body.status || 400, body.message);
  if (body.move != null) {
    if (kind !== 'tunnel') return fail(res, 403, 'Open the secure address to finish the switch');
    return finishMove(res, String(body.move));
  }
  if (!pairing || pairing.expiresAt < Date.now()) return fail(res, 403, 'No pairing in progress. Start pairing on the desktop.');
  const code = String(body.code || '').trim();
  const secret = String(body.secret || '');
  // The typed code (six ASCII digits) or the QR code's secret; anything else counts as a wrong try.
  const ok = secret
    ? /^[A-Za-z0-9_-]{43}$/.test(secret) && crypto.timingSafeEqual(Buffer.from(hash(secret), 'hex'), Buffer.from(pairing.secretHash, 'hex'))
    : /^\d{6}$/.test(code) && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(pairing.code));
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
  for (const a of openApprovals.values()) res.write(sse('approval:request', approvalForDevice(a)));
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
  // voice: the question was spoken (the watch, push-to-talk): a short, speakable reply on the fast model.
  const voice = body.voice === true;
  const remote = body.via === 'watch' ? `${device.name} · watch` : device.name;
  const r = await hooks.startTurn({ conversationId: body.conversationId || null, text, requestId, remote, voice });
  return json(res, 200, { requestId, conversationId: r.conversationId });
}

module.exports = { init, apply, stop, status, startPairing, cancelPairing, revoke, revokeAll, publish };
