// Extensions: MCP servers Nexus runs for the Claude account brain (claudecode.js adds them to each
// session's MCP config), each switched on by the user in Settings → Extensions:
//  - REA, "Reverse Engineer Anything" (github.com/morluto/rea, MIT): how apps, websites, Electron/JS
//    bundles and native binaries work, with evidence; `npx rea-agents mcp`, pinned to a release.
//  - God's Eye View (github.com/bilawalsidhu/gods-eye-view, MIT): a live 3D globe of public world data
//    (aircraft, ships, satellites, weather, quakes, fires…). Its MCP server reads the app's local server
//    (npm run dev on port 4173), which Nexus starts and stops; the globe opens in a window of its own.
// Safety: the commands are fixed here. The only input is the God's Eye View folder the user picks, which
// must be a checkout of that project. Everything under settings.extensions is the user's alone (never in
// tools.js SETTABLE), and each extension's tools go through the connector permission levels.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const log = require('./logger');

const REA_VERSION = '6.8.0';
const GODSEYE_PORT = 4173;
const GODSEYE_ORIGIN = `http://localhost:${GODSEYE_PORT}`;
const GODSEYE_REPO = 'https://github.com/bilawalsidhu/gods-eye-view.git';
const isWin = process.platform === 'win32';

const CATALOG = [
  {
    id: 'rea',
    key: 'rea', // the server name in tool names: mcp__rea__…
    name: 'REA: Reverse Engineer Anything',
    about: 'Understand how an app, website, Electron/JavaScript bundle or native binary works, with the evidence. Native binaries can use Ghidra, Hopper or IDA if you have one; JavaScript analysis needs nothing extra. Downloads the rea-agents package the first time.',
    source: 'github.com/morluto/rea (MIT)',
    defaultLevel: 'read',
  },
  {
    id: 'godseye',
    key: 'gods-eye-view',
    name: "God's Eye View",
    about: 'A live 3D globe with public world data: aircraft and military flights, ships, satellites and passes, weather, earthquakes, fires, launches, public cameras. Ask "what is flying over Reykjavik?" or "show me the earthquakes today on the globe".',
    source: 'github.com/bilawalsidhu/gods-eye-view (MIT)',
    defaultLevel: 'all', // its tools only read public data and make links
  },
];

// ------------------------------------------------------------ God's Eye View checkout
/** A folder is usable when it is a checkout of gods-eye-view with its MCP server and dependencies. */
function checkGodsEye(dir) {
  if (!dir) return { ok: false, reason: 'No folder chosen.' };
  const pkgFile = path.join(dir, 'package.json');
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  } catch {
    return { ok: false, reason: 'No package.json there.' };
  }
  if (!/gods-eye-view|worldview/i.test(pkg.name || '') && !fs.existsSync(path.join(dir, 'server', 'mcp', 'stdio.js'))) return { ok: false, reason: "That folder isn't a God's Eye View checkout." };
  if (!fs.existsSync(path.join(dir, 'server', 'mcp', 'stdio.js'))) return { ok: false, reason: 'This checkout has no MCP server (server/mcp/stdio.js); update it with git pull.' };
  if (!fs.existsSync(path.join(dir, 'node_modules'))) return { ok: false, reason: 'Its dependencies are not installed yet (npm ci).', needsInstall: true };
  return { ok: true };
}

function listening(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => (sock.destroy(), resolve(ok));
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

// Vite's "localhost" is often IPv6 only ([::1]) on Windows, so both loopback addresses count.
async function up(port = GODSEYE_PORT, timeoutMs = 1200) {
  const found = await Promise.all(['127.0.0.1', '::1'].map((host) => listening(host, port, timeoutMs)));
  return found.some(Boolean);
}

let server = null; // the dev server Nexus started: { child, startedAt }
let starting = null;

// npm is a .cmd on Windows, which Node only starts through the shell; the command line is fixed.
function npm(args, cwd, opts = {}) {
  return isWin ? spawn('cmd.exe', ['/d', '/s', '/c', `npm ${args.join(' ')}`], { cwd, windowsHide: true, ...opts }) : spawn('npm', args, { cwd, ...opts });
}

/** Starts God's Eye View's local server if it isn't running (only from the user's checkout). */
async function ensureGodsEye(settings) {
  const ext = settings.extensions || {};
  if (!ext.godseye) throw new Error("God's Eye View is off (Settings → Extensions).");
  if (await up()) return { running: true, startedByNexus: Boolean(server) };
  const check = checkGodsEye(ext.godseyePath);
  if (!check.ok) throw new Error(`God's Eye View: ${check.reason}`);
  starting ||= (async () => {
    const child = npm(['run', 'dev'], ext.godseyePath, { stdio: ['ignore', 'pipe', 'pipe'] });
    server = { child, startedAt: Date.now() };
    child.stdout.on('data', (d) => log.debug('godseye', { out: String(d).slice(0, 300) }));
    child.stderr.on('data', (d) => log.debug('godseye', { err: String(d).slice(0, 300) }));
    child.on('exit', (code) => {
      log.info('godseye server exited', { code });
      if (server?.child === child) server = null;
    });
    // The first start (Vite builds its cache) can take well over a minute on a slower disk.
    for (const until = Date.now() + 180000; Date.now() < until; ) {
      if (await up()) {
        log.info('godseye server ready', { ms: Date.now() - server.startedAt });
        return { running: true, startedByNexus: true };
      }
      if (child.exitCode !== null) throw new Error("God's Eye View's server stopped while starting; run `npm run doctor` in its folder.");
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error("God's Eye View didn't start within 3 minutes; run `npm run dev` in its folder to see why.");
  })().finally(() => (starting = null));
  return starting;
}

function stopGodsEye() {
  const child = server?.child;
  server = null;
  if (!child || child.exitCode !== null) return;
  if (isWin) execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else child.kill('SIGTERM');
}

/** Clones and installs God's Eye View into `parent` (the user's click in Settings only). */
async function installGodsEye(parent, onProgress = () => {}) {
  const dir = path.join(parent, 'gods-eye-view');
  if (fs.existsSync(dir) && checkGodsEye(dir).ok) return { dir, already: true };
  const run = (label, child) =>
    new Promise((resolve, reject) => {
      onProgress({ step: label });
      child.stdout?.on('data', (d) => onProgress({ step: label, line: String(d).trim().split('\n').pop().slice(0, 160) }));
      child.stderr?.on('data', (d) => onProgress({ step: label, line: String(d).trim().split('\n').pop().slice(0, 160) }));
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} failed (exit ${code})`))));
    });
  if (!fs.existsSync(path.join(dir, 'package.json'))) await run('Downloading (git clone)', spawn('git', ['clone', '--depth', '1', GODSEYE_REPO, dir], { windowsHide: true }));
  await run('Installing dependencies (npm ci)', npm(['ci'], dir));
  await run('Building the globe panel (npm run build:panel)', npm(['run', 'build:panel'], dir)).catch((err) => onProgress({ step: 'build:panel skipped', line: err.message }));
  return { dir, already: false };
}

// ------------------------------------------------------------ for claudecode.js
/** The MCP servers for a Claude Code session: { key: config } for the extensions that are on and usable. */
function mcpServers(settings) {
  const ext = settings.extensions || {};
  const out = {};
  if (ext.rea) out.rea = isWin ? { command: 'cmd.exe', args: ['/d', '/c', 'npx', '-y', `rea-agents@${REA_VERSION}`, 'mcp'] } : { command: 'npx', args: ['-y', `rea-agents@${REA_VERSION}`, 'mcp'] };
  if (ext.godseye && checkGodsEye(ext.godseyePath).ok) {
    out['gods-eye-view'] = { command: process.execPath, args: [path.join(ext.godseyePath, 'server', 'mcp', 'stdio.js'), '--api-base', GODSEYE_ORIGIN], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return out;
}

/** For the UI and the guide: each extension, whether it is on, and whether it is ready. */
async function status(settings) {
  const ext = settings.extensions || {};
  return Promise.all(
    CATALOG.map(async (c) => {
      const on = Boolean(ext[c.id]);
      if (c.id === 'godseye') {
        const check = checkGodsEye(ext.godseyePath);
        return { ...c, on, path: ext.godseyePath || '', ready: check.ok, reason: check.ok ? '' : check.reason, needsInstall: Boolean(check.needsInstall), running: await up(), startedByNexus: Boolean(server) };
      }
      return { ...c, on, ready: true };
    }),
  );
}

/** A God's Eye View link is opened only when it points at the local server. */
function isGlobeUrl(url) {
  try {
    const u = new URL(String(url || GODSEYE_ORIGIN));
    return u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname) && Number(u.port) === GODSEYE_PORT;
  } catch {
    return false;
  }
}

module.exports = { CATALOG, REA_VERSION, GODSEYE_ORIGIN, checkGodsEye, ensureGodsEye, stopGodsEye, installGodsEye, mcpServers, status, isGlobeUrl, up };
