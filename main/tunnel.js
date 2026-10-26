// Secure remote access (docs/ROADMAP-mobile.md, step 3): an HTTPS address for the companion server
// from anywhere, without opening a port (the tunnel connects outbound). Modes (settings.remote.tunnel):
//  - quick: runs the user's cloudflared for a temporary https://….trycloudflare.com address. For
//    testing: it changes on every start and has no Cloudflare Access in front.
//  - cloudflare: runs the user's named tunnel with its connector token (encrypted in settings, passed
//    in the environment, never on the command line). The public hostname and the Access application
//    are set up in the Cloudflare dashboard; we only verify Access's signed header (verifyAccess).
//  - tailscale: nothing keeps running here. Tailscale Serve forwards https://<name>.ts.net to our port
//    (set up once by the user's click: setupTailscaleServe, or by hand); we accept its hostname, read it,
//    whether HTTPS is enabled and whether Serve forwards to us from the tailscale CLI (detectTailscale),
//    and check the address end to end from this computer (verify).
// We never ship or create Cloudflare credentials.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./logger');

const QUICK_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const CANDIDATES = ['C:\\Program Files (x86)\\cloudflared\\cloudflared.exe', 'C:\\Program Files\\cloudflared\\cloudflared.exe', '/usr/local/bin/cloudflared', '/opt/homebrew/bin/cloudflared', '/usr/bin/cloudflared'];
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const TAILSCALE = ['C:\\Program Files\\Tailscale\\tailscale.exe', '/usr/bin/tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

let child = null;
let want = null; // { mode, port, bin, token, host }
let state = { mode: 'off', running: false, connected: false, url: '', host: '', error: '', check: '', warning: '' };
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

function findBinary(configured, name = 'cloudflared', candidates = CANDIDATES) {
  return new Promise((resolve) => {
    if (configured) return resolve(fs.existsSync(configured) ? configured : null);
    execFile(process.platform === 'win32' ? 'where' : 'which', [name], { windowsHide: true }, (err, out) => {
      const first = !err && String(out).split(/\r?\n/).find(Boolean);
      resolve(first || candidates.find((c) => fs.existsSync(c)) || null);
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
    if (!HOST.test(next.host)) return (update({ mode, host: '', url: '', error: 'Enter the Tailscale address (for example my-pc.tail1234.ts.net).', check: '', warning: '' }), status());
    update({ mode, running: false, connected: true, host: next.host, url: `https://${next.host}`, error: '', check: '', warning: '' });
    verify().catch(() => {}); // in the background: the address is accepted either way
    return status();
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
  update({ mode: w.mode, running: true, connected: false, host, url: host ? `https://${host}` : '', error: '', check: '', warning: '' });
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

// ------------------------------------------------------------ Tailscale
// What Tailscale on this computer says: its HTTPS name and whether Serve forwards to our port. Read
// from the user's tailscale CLI (fixed arguments, no shell); nothing is changed.
async function detectTailscale(port) {
  const bin = await findBinary('', 'tailscale', TAILSCALE);
  if (!bin) return { installed: false, command: `tailscale serve --bg ${port}` };
  const run = (args) => new Promise((resolve, reject) => execFile(bin, args, { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(String(out)))));
  const out = { installed: true, running: false, host: '', serving: null, command: `tailscale serve --bg ${port}` };
  try {
    const st = JSON.parse(await run(['status', '--json']));
    out.running = st.BackendState === 'Running';
    out.host = cleanHost(String(st.Self?.DNSName || '').replace(/\.$/, ''));
    if (!HOST.test(out.host)) out.host = '';
    // HTTPS certificates must be enabled for the tailnet (once, in Tailscale's admin console) before
    // Serve can offer https://<name>.ts.net.
    out.https = Array.isArray(st.CertDomains) && st.CertDomains.length > 0;
  } catch (err) {
    log.warn('tailscale status failed', { error: err });
    return { ...out, error: 'Tailscale is installed but did not answer. Is it running and signed in?' };
  }
  try {
    const serve = JSON.parse((await run(['serve', 'status', '--json'])) || '{}');
    const proxies = Object.values(serve.Web || {}).flatMap((w) => Object.values(w.Handlers || {}).map((h) => String(h.Proxy || '')));
    out.serving = proxies.some((p) => new RegExp(`^https?://(127\\.0\\.0\\.1|localhost)?:${port}/?$`).test(p));
  } catch {
    out.serving = null; // an older tailscale without --json: unknown
  }
  return out;
}

// The user's click "Set it up for me": `tailscale serve --bg --yes <port>`, so https://<name>.ts.net
// forwards to the companion server, for the user's own tailnet only (not the internet: that would be
// `funnel`). When HTTPS isn't enabled for the tailnet yet, Tailscale prints a link to enable it and
// waits; we return that link (the window opens it) and stop waiting. Fixed arguments, no shell.
const TS_LINK = /https:\/\/login\.tailscale\.com\/[^\s"']+/;

/** Pure: what `tailscale serve` printed → { ok } | { enableUrl } | { error }. */
function serveOutcome(code, output) {
  const link = TS_LINK.exec(output);
  if (link) return { enableUrl: link[0] };
  if (code === 0) return { ok: true };
  const line = String(output).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || `tailscale exited with code ${code}`;
  return { error: /access denied|permission|operator/i.test(line) ? `${line} (Tailscale needs this computer's administrator once: run "sudo tailscale set --operator=$USER" in a terminal on macOS/Linux, or start Tailscale as the signed-in user on Windows.)` : line };
}

async function setupTailscaleServe(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: 'Invalid port' };
  const bin = await findBinary('', 'tailscale', TAILSCALE);
  if (!bin) return { error: 'Tailscale is not installed on this computer. Install it from tailscale.com/download and sign in.' };
  const result = await new Promise((resolve) => {
    let output = '';
    let done = false;
    const proc = spawn(bin, ['serve', '--bg', '--yes', String(p)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(serveOutcome(code, output));
    };
    const onData = (b) => {
      output = (output + String(b)).slice(-4000);
      if (TS_LINK.test(output)) {
        proc.kill(); // it would wait for the tailnet's HTTPS to be enabled; the user does that in the browser
        finish(null);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => ((output += err.message), finish(1)));
    proc.on('exit', (code) => finish(code));
    const timer = setTimeout(() => (proc.kill(), finish(1)), 30000);
  });
  log.info('tailscale serve setup', { port: p, ok: Boolean(result.ok), needsHttps: Boolean(result.enableUrl), error: result.error ? result.error.slice(0, 200) : undefined });
  if (result.ok && state.mode === 'tailscale') verify().catch(() => {});
  return result;
}

// Opens the secure address from this computer, like the phone will (Tailscale and Cloudflare).
async function verify() {
  const url = state.url;
  if (!state.connected || !url) return status();
  update({ check: 'checking', warning: '' });
  try {
    const res = await fetch(`${url}/api/ping`, { signal: AbortSignal.timeout(10000) });
    const body = await res.json().catch(() => ({}));
    if (body.app !== 'nexus-agent') throw new Error(`it answered ${res.status} but not as Siren`);
    if (state.url === url) update({ check: 'ok', warning: '' });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? 'no answer within 10 seconds' : err.cause?.code || err.message;
    const hint = state.mode === 'tailscale' ? ` Is Tailscale on, and did you run "tailscale serve --bg ${want?.port || 7823}"?` : '';
    if (state.url === url) update({ check: 'fail', warning: `Couldn't open ${url} from this computer (${why}).${hint}` });
    log.warn('secure address check failed', { mode: state.mode, reason: String(why).slice(0, 200) });
  }
  return status();
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

module.exports = { setListener, apply, stop, status, publicHost, verifyAccess, teamDomain, detectTailscale, setupTailscaleServe, serveOutcome, verify };
