// Secure remote access (docs/ROADMAP-mobile.md, step 3): an HTTPS address for the companion server
// from anywhere, without opening a port (the tunnel connects outbound). Modes (settings.remote.tunnel):
//  - quick: runs the user's cloudflared for a temporary https://….trycloudflare.com address. For
//    testing: it changes on every start and has no Cloudflare Access in front.
//  - cloudflare: runs the user's named tunnel with its connector token (encrypted in settings, passed
//    in the environment, never on the command line). The public hostname and the Access application
//    are set up in the Cloudflare dashboard; we only verify Access's signed header (verifyAccess).
//  - tailscale: nothing runs here. The user runs `tailscale serve`; we accept its hostname.
// We never ship or create Cloudflare credentials.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const CANDIDATES = ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe', '/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/bin/cloudflared'];
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

let child = null;
let want = null; // { mode, port, bin, token, host }
let state = { mode: 'off', running: false, connected: false, url: '', host: '', error: '' };
let restarts = [];
let restartTimer = null;
let onChange = () => {};

function setListener(fn) {
  onChange = fn;
}

function update(patch) {
  state = { ...state, ...patch };
  onChange(status());
}

const status = () => ({ ...state });
// The hostname requests arrive with through the tunnel ('' when none).
const publicHost = () => state.host;
const cleanHost = (h) => String(h || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, '');

function findBinary(configured) {
  return new Promise((resolve) => {
    if (configured) return resolve(fs.existsSync(configured) ? configured : null);
    execFile(process.platform === 'win32' ? 'where' : 'which', ['cloudflared'], { windowsHide: true }, (err, out) => {
      const first = !err && String(out).split(/\r?\n/).find(Boolean);
      resolve(first || CANDIDATES.find((c) => fs.existsSync(c)) || null);
    });
  });
}

// Starts, restarts or stops the tunnel to match settings.remote (the server must be running on port).
async function apply(settings, port) {
  const r = settings.remote || {};
  const mode = r.enabled && port ? r.tunnel || 'off' : 'off';
  const next = { mode, port, token: r.tunnelToken || '', host: cleanHost(r.publicHost), binPath: r.cloudflaredPath || '' };
  const key = JSON.stringify(next);
  if (want && want.key === key && (child || restartTimer || mode === 'tailscale')) return status();
  stop();
  next.key = key;
  want = next;
  restarts = [];
  if (mode === 'off') return (update({ mode, running: false, connected: false, url: '', host: '', error: '' }), status());
  if (mode === 'tailscale') {
    if (!HOST.test(next.host)) return (update({ mode, host: '', url: '', error: 'Enter the Tailscale address (for example my-pc.tail1234.ts.net).' }), status());
    return (update({ mode, running: false, connected: true, host: next.host, url: `https://${next.host}`, error: '' }), status());
  }
  if (mode === 'cloudflare' && !next.token) return (update({ mode, error: 'Paste the tunnel token from the Cloudflare dashboard.' }), status());
  if (mode === 'cloudflare' && !HOST.test(next.host)) return (update({ mode, error: 'Enter the public hostname you gave the tunnel (for example nexus.example.com).' }), status());
  const bin = await findBinary(next.binPath);
  if (!bin) return (update({ mode, error: 'cloudflared was not found. Install it (winget install Cloudflare.cloudflared) or set its path.' }), status());
  next.bin = bin;
  start();
  return status();
}

function start() {
  const w = want;
  const args = w.mode === 'quick' ? ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${w.port}`] : ['tunnel', '--no-autoupdate', 'run'];
  const env = { ...process.env, ...(w.mode === 'cloudflare' ? { TUNNEL_TOKEN: w.token } : {}) };
  const host = w.mode === 'cloudflare' ? w.host : '';
  update({ mode: w.mode, running: true, connected: false, host, url: host ? `https://${host}` : '', error: '' });
  let proc;
  try {
    proc = spawn(w.bin, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    log.warn('tunnel start failed', { error: err });
    return update({ running: false, error: err.message });
  }
  child = proc;
  log.info('tunnel starting', { mode: w.mode });
  let tail = '';
  const onOutput = (buf) => {
    const text = String(buf);
    tail = (tail + text).slice(-2000);
    const quick = w.mode === 'quick' && QUICK_URL.exec(text);
    if (quick && !state.connected) {
      const url = quick[0].toLowerCase();
      update({ connected: true, url, host: new URL(url).hostname });
      log.info('tunnel connected', { mode: 'quick', url });
    }
    if (w.mode === 'cloudflare' && /Registered tunnel connection/i.test(text) && !state.connected) {
      update({ connected: true });
      log.info('tunnel connected', { mode: 'cloudflare', host: w.host });
    }
  };
  proc.stdout.on('data', onOutput);
  proc.stderr.on('data', onOutput);
  proc.on('error', (err) => {
    log.warn('tunnel error', { error: err });
    update({ error: err.message });
  });
  proc.on('exit', (code) => {
    if (child !== proc) return; // stopped on purpose
    child = null;
    const last = tail.split(/\r?\n/).filter((l) => /ERR|error|failed/i.test(l)).pop() || `cloudflared exited (code ${code})`;
    log.warn('tunnel stopped unexpectedly', { code, last: last.slice(0, 300) });
    update({ running: false, connected: false, error: last.replace(/^.*?(ERR|INF)\s*/, '').slice(0, 200) });
    // A dropped connection restarts, a few times; then it waits for the user.
    const now = Date.now();
    restarts = restarts.filter((t) => now - t < 10 * 60 * 1000);
    if (restarts.length < 5 && want === w) {
      restarts.push(now);
      restartTimer = setTimeout(() => {
        restartTimer = null;
        if (want === w && !child) start();
      }, 3000 * restarts.length);
    }
  });
}

function stop() {
  clearTimeout(restartTimer);
  restartTimer = null;
  want = null;
  if (child) {
    const c = child;
    child = null;
    c.kill();
    log.info('tunnel stopped');
  }
  if (state.mode !== 'off' || state.connected) update({ mode: 'off', running: false, connected: false, url: '', host: '' });
}

// ------------------------------------------------- Cloudflare Access check
// When Access protects the tunnel, Cloudflare signs each request (Cf-Access-Jwt-Assertion). Checking
// the signature here means nobody reaches the app by skipping the Access login.
const certCache = new Map(); // team -> { keys, at }

function teamDomain(team) {
  const t = cleanHost(team);
  if (!t) return '';
  return t.includes('.') ? t : `${t}.cloudflareaccess.com`;
}

async function certs(domain, fresh = false) {
  const c = certCache.get(domain);
  if (c && !fresh && Date.now() - c.at < 60 * 60 * 1000) return c.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Access certificates: HTTP ${res.status}`);
  const keys = (await res.json()).keys || [];
  certCache.set(domain, { keys, at: Date.now() });
  return keys;
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

async function verifyAccess(token, { team, aud }) {
  const domain = teamDomain(team);
  if (!domain || !aud) throw new Error('Access is not configured');
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Missing Access token');
  const header = b64json(parts[0]);
  const claims = b64json(parts[1]);
  if (header.alg !== 'RS256') throw new Error('Unexpected Access token algorithm');
  let jwk = (await certs(domain)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await certs(domain, true)).find((k) => k.kid === header.kid); // keys rotate
  if (!jwk) throw new Error('Unknown Access signing key');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('Bad Access token signature');
  const now = Date.now() / 1000;
  if (!(claims.exp > now - 30) || (claims.nbf && claims.nbf > now + 30)) throw new Error('Expired Access token');
  if (claims.iss !== `https://${domain}`) throw new Error('Access token from another team');
  if (![].concat(claims.aud || []).includes(aud)) throw new Error('Access token for another application');
  return { email: claims.email || '' };
}

module.exports = { setListener, apply, stop, status, publicHost, verifyAccess, teamDomain };
