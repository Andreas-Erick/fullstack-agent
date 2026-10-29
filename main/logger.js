// Diagnostic log (<userData>/logs/nexus.log): what was heard and said, tool calls, fallbacks, session
// spawns, timings, errors. The agent reads it through read_app_log to diagnose itself ("the mechanic").
//
// One line per event:  <ISO time> <LEVEL> [turn=… conv=…] <event> <JSON detail>
// - Lines written while a turn runs carry its id (AsyncLocalStorage), so `turn=ab12cd` pulls out
//   everything that happened in one request: tools, approvals, session events, errors.
// - Errors keep their message, code, cause and top stack frames.
// - Secrets (API keys, tokens, Bearer headers) are masked before anything is written.
// - A line repeated within 10 seconds is collapsed into "(repeated N times)".
// - nexus.log rotates at 5 MB, keeping three older files (nexus.1.log … nexus.3.log).
const fs = require('fs');
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { app } = require('electron');

const MAX_BYTES = 5 * 1024 * 1024;
const KEEP = 3;
const als = new AsyncLocalStorage();
let debugEnabled = false;

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
function errorInfo(err) {
  const info = { message: err.message || String(err) };
  if (err.name && err.name !== 'Error') info.name = err.name;
  if (err.code) info.code = err.code;
  if (err.exitCode != null) info.exitCode = err.exitCode;
  if (err.stack) {
    // The app's own frames, shortened to e.g. "Session.spawn main/claudecode.js:212:9".
    const frames = String(err.stack)
      .split('\n')
      .slice(1)
      .map((l) => l.trim().replace(/^at /, ''))
      .filter((l) => !/node:internal|node_modules|\(native\)|^new Promise/.test(l))
      .map((l) => l.replace(/\(?(?:[A-Za-z]:)?[^\s()]*?[\\/]((?:main|renderer|preload)[\\/][^\s():]*|[^\\/\s():]+)(:\d+:\d+)\)?/, '$1$2').replace(/\\/g, '/'));
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
let last = { key: '', at: 0, count: 0 };

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

function flushRepeats() {
  if (last.count > 0) append(`${new Date().toISOString()} INFO  (previous line repeated ${last.count} more time${last.count > 1 ? 's' : ''})`);
  last = { key: '', at: 0, count: 0 };
}

function write(level, event, data) {
  try {
    const ctx = als.getStore();
    const tags = ctx ? Object.entries(ctx).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') : '';
    let detail = redact(serialize(data));
    const cap = level === 'ERROR' ? 6000 : 2500;
    if (detail.length > cap) detail = `${detail.slice(0, cap)}… (${detail.length} chars)`;
    const body = `${level.padEnd(5)} ${tags ? `[${tags}] ` : ''}${event}${detail ? ` ${detail}` : ''}`;
    const now = Date.now();
    if (body === last.key && now - last.at < 10000) {
      last.count++;
      last.at = now;
      return;
    }
    flushRepeats();
    last = { key: body, at: now, count: 0 };
    append(`${new Date(now).toISOString()} ${body}`, level === 'ERROR');
  } catch {
    /* logging must never break the app */
  }
}

// -------------------------------------------------------------- reading
// lines: how many (from the end); filter: text; level: 'error' | 'warn' (and worse); turn: a turn id;
// sinceMin: only the last N minutes.
function tail(lines = 150, filter = '', { level, turn, sinceMin } = {}) {
  writeBuffer(); // reading sees every line logged so far
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
  setDebug: (on) => (debugEnabled = Boolean(on)),
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
  tail,
  recentErrors,
  file,
  dir,
};
