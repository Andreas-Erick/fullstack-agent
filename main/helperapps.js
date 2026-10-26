// Helper apps: VoiceStudio (the natural voice) and FreeLLMAPI (a local OpenAI-compatible brain)
// are separate desktop apps. So the user only has to open Nexus, Nexus starts the ones its settings
// actually use (Settings → Helper apps):
//  - only if the configured address is on this computer, the app is installed (known install
//    folder, or a path the user set) and nothing answers there yet;
//  - in the background: their windows are minimized without taking focus;
//  - again when they are needed and down (the voice, or the brain falling back to FreeLLMAPI);
//  - optionally closed when Nexus quits, but only the ones Nexus started.
// Safety: the program paths are settings only the user can change (never in tools.js SETTABLE), so the
// agent can never make Nexus launch something else. "Up" means a TCP connection to the configured
// address succeeds, which works for any version of either app.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const log = require('./logger');

const APPS = {
  voicestudio: {
    name: 'VoiceStudio',
    url: (s) => s.voice?.baseUrl,
    needed: (s) => Boolean(s.voice?.ttsEnabled),
    readyMs: 180000, // loads its speech models onto the GPU
    candidates: { win32: ['%LOCALAPPDATA%\\Programs\\VoiceStudio\\VoiceStudio.exe'], darwin: ['/Applications/VoiceStudio.app'] },
  },
  freellmapi: {
    name: 'FreeLLMAPI',
    url: (s) => s.llm?.baseUrl,
    needed: (s) => s.llm?.provider === 'openai' || (s.llm?.provider === 'auto' && (s.routing?.order || []).includes('openai') && !(s.routing?.disabled || []).includes('openai')),
    readyMs: 60000,
    candidates: { win32: ['%LOCALAPPDATA%\\Programs\\freellmapi-desktop\\FreeLLMAPI.exe'], darwin: ['/Applications/FreeLLMAPI.app'] },
  },
};
const IDS = Object.keys(APPS);
const RETRY_AFTER_MS = 2 * 60000; // when needed again, start it at most this often

const state = Object.fromEntries(IDS.map((id) => [id, { status: 'unknown', pid: null, startedByNexus: false, lastStart: 0, error: '' }]));
const starting = new Map(); // id -> promise
let notify = () => {};
let spawnApp = defaultSpawn;
let lastSettings = null;

function init(opts = {}) {
  if (opts.notify) notify = opts.notify;
  if (opts.spawnApp) spawnApp = opts.spawnApp; // tests
}

const cfg = (s) => s?.helperApps || {};

// ------------------------------------------------------------ where and whether
function endpoint(url) {
  try {
    const u = new URL(String(url || ''));
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80) };
  } catch {
    return null;
  }
}

/** Only apps whose address is on this computer are started here. */
function isLocal(url) {
  const e = endpoint(url);
  return Boolean(e && ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(e.host.toLowerCase()));
}

function up(url, timeoutMs = 1500) {
  const e = endpoint(url);
  if (!e) return Promise.resolve(false);
  return new Promise((resolve) => {
    const sock = net.connect({ host: e.host === '0.0.0.0' ? '127.0.0.1' : e.host, port: e.port });
    const done = (ok) => (sock.destroy(), resolve(ok));
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

const expand = (p) => String(p).replace(/%([A-Z_]+)%/gi, (_m, v) => process.env[v] || '');

// A user-set path must be an existing program of the right kind; otherwise the known install folders.
function installedPath(id, settings) {
  const custom = String(cfg(settings)[`${id}Path`] || '').trim();
  const ext = process.platform === 'win32' ? /\.exe$/i : process.platform === 'darwin' ? /\.app\/?$/i : /./;
  if (custom) return ext.test(custom) && fs.existsSync(custom) ? custom : null;
  return (APPS[id].candidates[process.platform] || []).map(expand).find((p) => p && fs.existsSync(p)) || null;
}

function target(id, settings) {
  const file = installedPath(id, settings);
  if (!file) return null;
  if (process.platform === 'darwin') return { command: 'open', args: [...(cfg(settings).minimize !== false ? ['-g', '-j'] : []), '-a', file], file };
  return { command: file, args: [], file };
}

function defaultSpawn(t) {
  const child = spawn(t.command, t.args, { detached: true, stdio: 'ignore', cwd: path.dirname(t.file) });
  child.unref();
  return child;
}

// ------------------------------------------------------------ starting
function set(id, patch) {
  Object.assign(state[id], patch);
  notify({ type: 'status', id, name: APPS[id].name, ...publicState(id) });
}

const publicState = (id) => ({ status: state[id].status, startedByNexus: state[id].startedByNexus, error: state[id].error });

/** Starts one helper app if it is needed here and not running. Resolves to its state. */
function start(id, settings, { reason = 'manual', readyMs } = {}) {
  if (!APPS[id]) return Promise.reject(new Error(`Unknown helper app "${id}"`));
  if (starting.has(id)) return starting.get(id);
  const p = (async () => {
    const app = APPS[id];
    const url = app.url(settings);
    if (!isLocal(url)) return set(id, { status: 'remote', error: '' }), publicState(id);
    if (await up(url)) return set(id, { status: 'running', error: '' }), publicState(id);
    const t = target(id, settings);
    if (!t) return set(id, { status: 'not_installed', error: '' }), publicState(id);
    log.info('helper app starting', { app: id, reason });
    set(id, { status: 'starting', error: '', lastStart: Date.now() });
    notify({ type: 'starting', id, name: app.name, reason });
    let child;
    try {
      child = spawnApp(t);
    } catch (err) {
      log.warn('helper app start failed', { app: id, error: err });
      set(id, { status: 'failed', error: err.message });
      return publicState(id);
    }
    let spawnError = null;
    child?.once?.('error', (err) => (spawnError = err));
    state[id].pid = child?.pid || null;
    state[id].startedByNexus = true;
    if (process.platform === 'win32' && cfg(settings).minimize !== false && child?.pid) minimizeWindows(child.pid);
    const deadline = Date.now() + (readyMs || app.readyMs);
    while (Date.now() < deadline) {
      if (spawnError) break;
      if (await up(url)) {
        log.info('helper app ready', { app: id, ms: Date.now() - state[id].lastStart });
        set(id, { status: 'running', error: '' });
        notify({ type: 'ready', id, name: app.name });
        return publicState(id);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    const error = spawnError ? spawnError.message : `${app.name} started but did not answer at ${url} within ${Math.round((readyMs || app.readyMs) / 1000)} s.`;
    log.warn('helper app did not come up', { app: id, error });
    set(id, { status: 'failed', error });
    notify({ type: 'failed', id, name: app.name, error });
    return publicState(id);
  })().finally(() => starting.delete(id));
  starting.set(id, p);
  return p;
}

/** At launch and when settings change: start every helper app the settings use (if turned on). */
function ensureAll(settings, reason = 'launch') {
  lastSettings = settings;
  if (cfg(settings).autoStart === false) return [];
  return IDS.filter((id) => APPS[id].needed(settings) && isLocal(APPS[id].url(settings))).map((id) => start(id, settings, { reason }).catch((err) => log.warn('helper app start failed', { app: id, error: err })));
}

/** A request to the app failed because nothing answered: start it again (at most every 2 minutes). */
function onUnreachable(id, err, settings = lastSettings) {
  if (!settings || cfg(settings).autoStart === false || !APPS[id]?.needed(settings)) return false;
  if (!/ECONNREFUSED|fetch failed|unreachable|ECONNRESET|socket hang up/i.test(`${err?.message || ''} ${err?.cause?.code || ''}`)) return false;
  if (starting.has(id) || Date.now() - state[id].lastStart < RETRY_AFTER_MS) return false;
  start(id, settings, { reason: 'needed' }).catch(() => {});
  return true;
}

// Windows: minimize the app's windows without activating them, as they appear (for ~25 s).
function minimizeWindows(pid) {
  const script = `
Add-Type @"
using System; using System.Runtime.InteropServices;
public class NexusWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
}
"@
$done = @{}
for ($i = 0; $i -lt 50; $i++) {
  [NexusWin]::EnumWindows({ param($h, $l) $p = 0; [void][NexusWin]::GetWindowThreadProcessId($h, [ref]$p)
    if ($p -eq ${Number(pid)} -and [NexusWin]::IsWindowVisible($h) -and -not [NexusWin]::IsIconic($h) -and -not $done.ContainsKey($h)) { [void][NexusWin]::ShowWindowAsync($h, 7); $done[$h] = 1 }
    return $true }, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 500
}`;
  // -EncodedCommand (UTF-16LE base64): no quoting rules to get wrong for a multi-line script.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 40000 }, (err) => {
    if (err && !err.killed) log.debug('helper app minimize', { error: err });
  });
}

// ------------------------------------------------------------ stopping
/** On quit, if turned on: close the apps Nexus started (gracefully, then forced after 3 s). */
function stopStarted(settings = lastSettings) {
  // Balanced performance (perfcore.js) also stops them: they hold memory while Nexus isn't running.
  if (!cfg(settings).stopOnQuit && require('./perfcore').profile(settings) !== 'balanced') return;
  for (const id of IDS) {
    const s = state[id];
    if (!s.startedByNexus || !s.pid) continue;
    log.info('helper app stopping', { app: id });
    try {
      if (process.platform === 'win32') {
        // Detached, so it finishes after Nexus has exited; /T includes the app's own helper processes.
        spawn('cmd.exe', ['/c', `taskkill /PID ${Number(s.pid)} /T >nul 2>&1 & ping -n 4 127.0.0.1 >nul & taskkill /PID ${Number(s.pid)} /T /F >nul 2>&1`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      } else if (process.platform === 'darwin') {
        spawn('osascript', ['-e', `quit app "${APPS[id].name}"`], { detached: true, stdio: 'ignore' }).unref();
      } else process.kill(s.pid, 'SIGTERM');
    } catch (err) {
      log.warn('helper app stop failed', { app: id, error: err });
    }
  }
}

// ------------------------------------------------------------ status
async function status(settings) {
  return Promise.all(
    IDS.map(async (id) => {
      const app = APPS[id];
      const url = app.url(settings);
      const local = isLocal(url);
      const running = await up(url);
      const s = state[id];
      const st = running ? 'running' : s.status === 'starting' ? 'starting' : !local ? 'remote' : s.status === 'failed' ? 'failed' : 'stopped';
      return { id, name: app.name, url, needed: app.needed(settings), local, installedAt: installedPath(id, settings), status: st, startedByNexus: s.startedByNexus, error: st === 'failed' ? s.error : '' };
    }),
  );
}

module.exports = { APPS, IDS, init, isLocal, up, installedPath, start, ensureAll, onUnreachable, stopStarted, status, _state: state };
