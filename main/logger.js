// Diagnostic log (<userData>/logs/nexus.log): what happened in each turn (lengths, timings, tools; the words
// only with Detailed logging on), tool calls, fallbacks, session spawns, errors. The agent reads it through
// read_app_log to diagnose itself ("the mechanic").
//
// One line per event:  <ISO time> <LEVEL> [turn=… conv=…] <event> <JSON detail>
// - Lines written while a turn runs carry its id (AsyncLocalStorage), so `turn=ab12cd` pulls out
//   everything that happened in one request: tools, approvals, session events, errors.
// - Errors keep their message, code, cause and top stack frames (short paths such as main/llm.js:499:23,
//   never the folders above the app: they hold the user's name).
// - Secrets (API keys, tokens, Bearer headers) are masked before anything is written.
// - A line repeated within 10 seconds is collapsed into "(previous line repeated N more times)", written
//   at the repeated line's level, so error analysis (errorinsight.js) counts every repeat.
// - nexus.log rotates at 5 MB, keeping three older files (nexus.1.log … nexus.3.log).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { app } = require('electron');

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
const als = new AsyncLocalStorage();
// Detailed logging: the setting (setDebug), or NEXUS_LOG_DEBUG=1 from the start (also when the window never boots).
const debugFromEnv = process.env.NEXUS_LOG_DEBUG === '1';
let debugEnabled = debugFromEnv;

// Lines are buffered and written together every quarter second (errors at once, and everything on
// flush(): quit and crash handlers call it), so a busy turn doesn't stall the main process with one
// disk write per line. The folder is made once and the file's size is tracked in memory.
const FLUSH_MS = 250;
let madeDir = '';
let size = null; // bytes in nexus.log, read once

function dir() {
  const d = path.join(app.getPath('userData'), 'logs');
  if (madeDir !== d) {
    fs.mkdirSync(d, { recursive: true });
    madeDir = d;
    size = null;
  }
  return d;
}

function file() {
  return path.join(dir(), 'nexus.log');
}

function rotate(f) {
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = path.join(dir(), `nexus.${i}.log`);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dir(), `nexus.${i + 1}.log`));
  }
  fs.renameSync(f, path.join(dir(), 'nexus.1.log'));
  size = 0;
}

// ------------------------------------------------------------ redaction
const SECRET_PATTERNS = [
  [/\b(sk-ant-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, '$1***'],
  [/\b(sk-[A-Za-z0-9]{4})[A-Za-z0-9_-]{16,}/g, '$1***'],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, '$1***'],
  [/\b(github_pat_)[A-Za-z0-9_]{20,}/g, '$1***'],
  [/\b(AIza)[A-Za-z0-9_-]{30,}/g, '$1***'],
  [/\b(ya29\.)[A-Za-z0-9_.-]{20,}/g, '$1***'],
  // Groq, Perplexity, xAI, OpenRouter, Tailscale auth keys, and JWTs (Cloudflare Access logins).
  [/\b(gsk_)[A-Za-z0-9]{20,}/g, '$1***'],
  [/\b(pplx-)[A-Za-z0-9]{20,}/g, '$1***'],
  [/\b(xai-)[A-Za-z0-9]{20,}/g, '$1***'],
  [/\b(sk-or-v1-)[A-Za-z0-9]{20,}/g, '$1***'],
  [/\b(tskey-[a-z]+-)[A-Za-z0-9-]{16,}/g, '$1***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 'eyJ***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1***'],
  // key: "value" pairs, also when they sit inside an already-JSON-encoded string (\"value\").
  [/(\\?"?(?:api_?key|apiKey|token|access_token|refresh_token|id_token|secret|clientSecret|client_secret|password|remoteKey)\\?"?\s*[:=]\s*\\?")[^"\\]{3,}(\\?")/gi, '$1***$2'],
];

function redact(text) {
  let out = text;
  for (const [re, sub] of SECRET_PATTERNS) out = out.replace(re, sub);
  return out;
}

// ------------------------------------------------------- serialization
// The app's folder (where main/ sits), wherever it is installed.
const APP_ROOT = path.resolve(__dirname, '..');

// The file of a frame: inside the app, its path from the app's folder (…/resources/app/main/x.js →
// main/x.js, app://bundle/renderer/js/chat.js → renderer/js/chat.js); anything else by its name alone,
// since the folders above it can hold the user's name.
function shortFile(location, root = APP_ROOT) {
  let file = location.replace(/\\/g, '/');
  if (/^file:\/\//i.test(file)) {
    try {
      file = decodeURIComponent(file.replace(/^file:\/\//i, '').replace(/^\/([A-Za-z]:\/)/, '$1'));
    } catch {
      /* a malformed escape: the name alone below */
    }
  }
  const base = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  if (file.toLowerCase().startsWith(base.toLowerCase())) return file.slice(base.length);
  return /^app:\/\/bundle\/(.+)$/.exec(file)?.[1] || file.split('/').pop();
}

// A location inside a frame that isn't "fn (file:line:col)": each "file:line:col" in it, e.g. the
// position of the code that called eval ("eval at load (C:\…\x.js:1:2), <anonymous>:3:4").
const INNER_LOCATION = /((?:[A-Za-z]:[\\/]|\/|file:\/\/|app:\/\/)[^]*?):(\d+):(\d+)/g;

// One stack frame as "fn file:line:col" (e.g. "Session.spawn main/claudecode.js:212:9"). Folders may
// contain spaces and brackets ("Some One", "Program Files (x86)").
function shortFrame(frame) {
  const l = frame.replace(/^at\s+/, '');
  const m = /^(.+?) \((.+):(\d+):(\d+)\)$/.exec(l) || /^()(.+):(\d+):(\d+)$/.exec(l);
  if (!m || /<anonymous>|eval at /.test(m[2])) return l.replace(INNER_LOCATION, (_all, location, line, col) => `${shortFile(location)}:${line}:${col}`);
  const [, fn, location, line, col] = m;
  return `${fn ? `${fn} ` : ''}${shortFile(location)}:${line}:${col}`;
}

function errorInfo(err) {
  const info = { message: err.message || String(err) };
  if (err.name && err.name !== 'Error') info.name = err.name;
  if (err.code) info.code = err.code;
  if (err.exitCode != null) info.exitCode = err.exitCode;
  if (err.stack) {
    // Only the frames ("at …"): the message's own lines are in `message` already.
    const frames = String(err.stack)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^at\s/.test(l) && !/node:internal|node_modules|\(native\)|^at new Promise/.test(l))
      .map(shortFrame);
    info.stack = frames.slice(0, 6).join(' | ');
  }
  if (err.cause) info.cause = err.cause instanceof Error ? errorInfo(err.cause) : String(err.cause);
  return info;
}

function serialize(data) {
  if (data === undefined) return '';
  if (typeof data === 'string') return data;
  if (data instanceof Error) return JSON.stringify(errorInfo(data));
  try {
    return JSON.stringify(data, (_k, v) => (v instanceof Error ? errorInfo(v) : typeof v === 'bigint' ? String(v) : v));
  } catch {
    return String(data);
  }
}

// --------------------------------------------------------------- writing
let last = { key: '', at: 0, count: 0, level: 'INFO' };

// Breadcrumbs: the names of the last lines (event, level, time, turn; never their details), so an ERROR line
// says what happened just before it: `trail` = the same turn's lines, else the last minute's, newest last.
// Written into the line itself, so a report read later (issues.js) still has it.
const TRAIL_KEEP = 40;
const TRAIL_SHOWN = 10;
const TRAIL_WINDOW_MS = 60000;
const crumbs = [];

function noteCrumb(at, level, event, turn) {
  crumbs.push({ at, level: level[0], event: String(event).slice(0, 60), turn });
  if (crumbs.length > TRAIL_KEEP) crumbs.shift();
}

/** "-4.2s I tool · -1.1s W tool failed" for an error at `at` (empty when nothing came before it). */
function trailFor(at, turn) {
  return crumbs
    .filter((c) => (turn ? c.turn === turn : at - c.at <= TRAIL_WINDOW_MS))
    .slice(-TRAIL_SHOWN)
    .map((c) => `-${((at - c.at) / 1000).toFixed(1)}s ${c.level} ${c.event}`)
    .join(' · ')
    .slice(-600);
}

// The trail goes into a JSON detail as one more field ({"trail": …} when there was none); a plain-text
// detail is left as it is.
function withTrail(detail, trail) {
  if (!trail) return detail;
  const field = `"trail":${JSON.stringify(trail)}`;
  if (!detail || detail === '{}') return `{${field}}`;
  if (detail.startsWith('{') && detail.endsWith('}')) return `${detail.slice(0, -1)},${field}}`;
  return detail;
}

let buffer = [];
let timer = null;

function append(line, now = false) {
  buffer.push(line);
  if (now) return writeBuffer();
  if (!timer) {
    timer = setTimeout(writeBuffer, FLUSH_MS);
    timer.unref?.();
  }
}

function writeBuffer() {
  clearTimeout(timer);
  timer = null;
  if (!buffer.length) return;
  const text = `${buffer.join('\n')}\n`;
  buffer = [];
  try {
    const f = file();
    if (size === null) size = fs.existsSync(f) ? fs.statSync(f).size : 0;
    if (size > MAX_BYTES) rotate(f);
    fs.appendFileSync(f, text);
    size += Buffer.byteLength(text);
  } catch {
    /* logging must never break the app */
  }
}

// The repeats of the last line: at its level (a reader filtering for warnings sees them) and at the time
// of the last repeat. It always directly follows the line it repeats.
function flushRepeats() {
  if (last.count > 0) append(`${new Date(last.at).toISOString()} ${last.level.padEnd(5)} (previous line repeated ${last.count} more time${last.count > 1 ? 's' : ''})`);
  last = { key: '', at: 0, count: 0, level: 'INFO' };
}

function write(level, event, data) {
  try {
    const ctx = als.getStore();
    const tags = ctx ? Object.entries(ctx).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    // One event, one line: a string detail with line breaks (JSON never has raw ones) would become lines the
    // level and turn filters drop.
    let detail = redact(serialize(data)).replace(/\r?\n/g, ' | ');
    const now = Date.now();
    if (level === 'ERROR') detail = withTrail(detail, redact(trailFor(now, ctx?.turn)));
    const cap = level === 'ERROR' ? 6000 : 2500;
    if (detail.length > cap) detail = `${detail.slice(0, cap)}… (${detail.length} chars)`;
    const body = `${level.padEnd(5)} ${tags ? `[${tags}] ` : ''}${event}${detail ? ` ${detail}` : ''}`;
    if (body === last.key && now - last.at < 10000) {
      last.count++;
      last.at = now;
      return;
    }
    flushRepeats();
    noteCrumb(now, level, event, ctx?.turn);
    last = { key: body, at: now, count: 0, level };
    append(`${new Date(now).toISOString()} ${body}`, level === 'ERROR');
  } catch {
    /* logging must never break the app */
  }
}

// -------------------------------------------------------------- reading
// lines: how many (from the end); filter: text; level: 'error' | 'warn' (and worse); turn: a turn id;
// sinceMin: only the last N minutes.
function tail(lines = 150, filter = '', { level, turn, sinceMin } = {}) {
  // Reading sees every line logged so far, and how often the last one repeated.
  flushRepeats();
  writeBuffer();
  try {
    const older = path.join(dir(), 'nexus.1.log');
    const text = (fs.existsSync(older) && lines > 300 ? fs.readFileSync(older, 'utf8') : '') + fs.readFileSync(file(), 'utf8');
    let rows = text.trimEnd().split('\n');
    if (level) {
      const wanted = String(level).toLowerCase() === 'error' ? / ERROR / : / (ERROR|WARN) /;
      rows = rows.filter((r) => wanted.test(r));
    }
    if (turn) rows = rows.filter((r) => r.includes(`turn=${turn}`));
    if (sinceMin) {
      const cutoff = Date.now() - sinceMin * 60000;
      rows = rows.filter((r) => Date.parse(r.slice(0, 24)) >= cutoff);
    }
    if (filter) {
      const f = filter.toLowerCase();
      rows = rows.filter((r) => r.toLowerCase().includes(f));
    }
    return rows.slice(-Math.min(2000, lines)).join('\n') || '(no matching log lines)';
  } catch {
    return '(log is empty)';
  }
}

function recentErrors(sinceMs = 3600000) {
  return tail(2000, '', { level: 'warn', sinceMin: sinceMs / 60000 })
    .split('\n')
    .filter((r) => / (ERROR|WARN) /.test(r));
}

process.on('exit', writeBuffer); // whatever is still buffered when the process ends

module.exports = {
  debug: (e, d) => debugEnabled && write('DEBUG', e, d),
  info: (e, d) => write('INFO', e, d),
  warn: (e, d) => write('WARN', e, d),
  error: (e, d) => write('ERROR', e, d),
  /** Runs fn with tags (e.g. { turn, conv }) added to every line it logs, including async work. */
  withContext: (tags, fn) => als.run({ ...(als.getStore() || {}), ...tags }, fn),
  context: () => als.getStore() || {},
  setDebug: (on) => (debugEnabled = Boolean(on) || debugFromEnv),
  flush: () => {
    try {
      flushRepeats();
      writeBuffer();
    } catch {
      /* ignore */
    }
  },
  redact,
  errorInfo,
  shortFile,
  tail,
  recentErrors,
  file,
  dir,
};
