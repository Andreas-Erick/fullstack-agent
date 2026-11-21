// Files and images the user pastes, drops or picks in the chat (renderer/js/attach.js). The window sends
// the bytes, never a path (chat:attach); here they are checked again (type by extension and by their first
// bytes, size), a PDF's or Word file's text is read in a worker thread (a heap cap, the process's memory
// watched, a time limit; a zip that says it unpacks to too much isn't opened), and the result is held
// under a one-time token (for at most 30 minutes) until the message that carries it is sent (chat:send →
// turns.js start: claim, save, attachcore.compose, release). Non-image files are copied to
// <userData>/attachments/<conversation>/ so the brain can read more of them later; the folder goes with
// its conversation (removeFor, removeAll) and leftovers are swept at start. The rules (limits, names, the
// blocks a message carries) are the pure renderer/js/attachcore.mjs.
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Worker } = require('worker_threads');
const store = require('./store');
const log = require('./logger');
const datadir = require('./datadir');
const core = require('./attachcore');

const { LIMITS } = core;
const WORKER = path.join(__dirname, 'extractworker.js');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONV_ID = /^[a-z0-9_-]+$/i;
const EXPIRED = 'An attachment expired before it was sent. Add it again.';

const root = () => datadir.attachmentsFolder();
const now = () => Date.now();

// ------------------------------------------------------------------ text extraction
const WATCH_MS = 100; // how often the memory is looked at while a file is read

/**
 * A PDF's or Word file's text, read in its own thread: { text, pages, pagesRead }, or null when it failed,
 * took longer than `timeoutMs` or needed too much memory (the thread is ended either way). The heap cap
 * covers the thread's objects only: what it unpacks (a zip's entries, a PDF's streams) is ArrayBuffers in
 * this process's memory, so the process's own growth is watched too (`memoryMb`). `onWorker` sees the
 * thread (tests).
 */
function extract(bytes, kind, { timeoutMs = LIMITS.extractMs, workerPath = WORKER, maxChars = LIMITS.fileChars + 1, memoryMb = LIMITS.extractGrowthMb, onWorker = null } = {}) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(workerPath, { resourceLimits: { maxOldGenerationSizeMb: LIMITS.extractHeapMb, maxYoungGenerationSizeMb: 64 } });
    } catch (error) {
      log.warn('text extraction could not start', { kind, error });
      return resolve(null);
    }
    onWorker?.(worker);
    let settled = false;
    const end = (value, why, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(watch);
      worker.terminate().catch(() => {});
      if (why || error) log.warn('text extraction failed', error ? { kind, error } : { kind, why });
      resolve(value);
    };
    const timer = setTimeout(() => end(null, 'took too long'), timeoutMs);
    const before = process.memoryUsage.rss();
    const watch = setInterval(() => process.memoryUsage.rss() - before > memoryMb * 1048576 && end(null, 'needed too much memory'), WATCH_MS);
    worker.once('message', (m) => (m?.ok ? end({ text: String(m.text || ''), pages: Number(m.pages) || undefined, pagesRead: Number(m.pagesRead) || undefined }) : end(null, String(m?.error || 'no answer').slice(0, 200))));
    worker.once('error', (error) => end(null, 'failed', error)); // the Error itself: its code (ERR_WORKER_OUT_OF_MEMORY) and stack
    worker.once('exit', (code) => end(null, `stopped (${code})`));
    // A copy, handed over: the caller keeps its bytes for saving.
    const copy = new Uint8Array(bytes);
    worker.postMessage({ bytes: copy, kind, maxChars }, [copy.buffer]);
  });
}

// ------------------------------------------------------------------ prepared, not yet sent
const pending = new Map(); // token -> { item, at, claimed, bytes }

const heldBytes = () => [...pending.values()].reduce((n, e) => n + e.bytes, 0);
/** What is held now (tests, diagnostics): { items, bytes }. */
const held = () => ({ items: pending.size, bytes: heldBytes() });

// Unsent ones past their time (a chip removed, a window reloaded: nothing tells main; the tokens go here).
function expire() {
  let n = 0;
  for (const [token, e] of pending) {
    if (e.claimed || now() - e.at <= LIMITS.ttlMs) continue;
    pending.delete(token);
    n++;
  }
  if (n) log.info('attachments expired', { n });
}

// One timer for the oldest unsent one, so they go after their time even when nothing else is attached or
// sent (each holds its whole file, up to 25 MB). Re-armed whenever what is held changes; never keeps the
// app running.
let expiry = null;
function armExpiry() {
  clearTimeout(expiry);
  expiry = null;
  let oldest = Infinity;
  for (const e of pending.values()) if (!e.claimed) oldest = Math.min(oldest, e.at);
  if (oldest === Infinity) return;
  expiry = setTimeout(() => {
    expiry = null;
    expire();
    armExpiry();
  }, Math.max(1000, oldest + LIMITS.ttlMs + 1000 - now()));
  expiry.unref?.();
}

// Room for one more of `size` bytes: the oldest unclaimed ones go while it doesn't fit.
function makeRoom(size) {
  expire();
  for (const [token, e] of pending) {
    if (pending.size < LIMITS.heldItems && heldBytes() + size <= LIMITS.heldBytes) break;
    if (e.claimed) continue;
    pending.delete(token);
    log.warn('attachment evicted', { kind: e.item.kind, kb: Math.round(e.bytes / 1024) });
  }
}

function hold(item, size) {
  makeRoom(size);
  const token = crypto.randomUUID();
  pending.set(token, { item, at: now(), claimed: false, bytes: size });
  armExpiry();
  return token;
}

const refused = (error, kind, name) => {
  log.info('attachment refused', { kind, ext: core.extOf(name) || undefined });
  return { error };
};
const view = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const dimension = (v) => v === undefined || (Number.isInteger(v) && v > 0 && v <= 10000);

/**
 * One file from the window (chat:attach): { name, type, bytes, width?, height?, thumb? }. Returns what its
 * chip shows, with a one-time token, or { error } for every expected refusal (never the file's text).
 */
async function prepare(input) {
  const started = now();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return refused('That attachment couldn’t be read.', 'invalid', '');
  const { name, type = '', bytes, width, height, thumb } = input;
  if (typeof name !== 'string' || !name || name.length > 255) return refused('That file’s name couldn’t be used.', 'invalid', '');
  if (!ArrayBuffer.isView(bytes) || typeof type !== 'string') return refused('That attachment couldn’t be read.', 'invalid', name);
  const display = core.safeName(name);
  if (bytes.byteLength > LIMITS.fileBytes) return refused(`“${display}” is too big (${core.formatBytes(bytes.byteLength)}). Files can be up to ${core.formatBytes(LIMITS.fileBytes)}.`, 'big', name);
  const kind = core.classify({ name, type, size: bytes.byteLength });
  if (kind.error) return refused(kind.error, 'type', name);
  const buf = view(bytes);
  const prepared = kind.kind === 'image' ? readImage(buf, display, { width, height, thumb }) : await readDocument(buf, kind.kind, display);
  if (prepared.error) return refused(prepared.error, kind.kind, name);
  const { item, result } = prepared;
  const token = hold(item, buf.byteLength + 2 * String(item.text || item.dataUrl || '').length);
  log.info('attachment prepared', { kind: item.kind, ext: core.extOf(name) || undefined, kb: Math.round(buf.byteLength / 1024), pages: item.pages, note: result.note, ms: now() - started });
  return { token, ...result };
}

function readImage(buf, name, { width, height, thumb }) {
  const sniffed = core.sniffImage(buf);
  if (!core.IMAGE_OUT.includes(sniffed)) return { error: `“${name}” isn’t the image it says it is.` };
  if (buf.byteLength > LIMITS.imageBytes) return { error: `“${name}” is too big even after resizing (${core.formatBytes(buf.byteLength)}). Try a smaller image.` };
  if (!dimension(width) || !dimension(height)) return { error: `“${name}” has a size Siren can’t use.` };
  const item = { kind: 'image', name, type: sniffed, width, height, size: buf.byteLength, dataUrl: `data:${sniffed};base64,${buf.toString('base64')}`, ...(core.isThumb(thumb) ? { thumb } : {}) };
  return { item, result: { kind: 'image', name, size: buf.byteLength, width, height } };
}

async function readDocument(buf, kind, name) {
  const ext = core.extOf(name);
  let text = '';
  let chars = 0;
  let pages;
  let pagesRead;
  let note;
  if (kind === 'pdf' || kind === 'docx') {
    if (kind === 'pdf' ? !core.isPdf(buf) : !core.isZip(buf)) return { error: `“${name}” isn’t a ${kind === 'pdf' ? 'PDF' : 'Word document'} Siren can read.` };
    // A Word file whose zip says it unpacks to far more than a document would (a zip bomb) isn't opened.
    const bomb = kind === 'docx' && core.unpacksTooFar(buf);
    if (bomb) log.warn('text extraction skipped', { kind, why: 'it unpacks to too much' });
    const r = bomb ? null : await extract(buf, kind);
    ({ pages, pagesRead } = r || {});
    text = r?.text || '';
    chars = core.estimateChars({ chars: text.length, pages, pagesRead });
    if (!text.trim()) note = 'no-text';
  } else {
    // Text and code, and files of an unknown type that turn out to be text. A notebook is read whole (its
    // JSON must parse) and keeps only its cells' sources.
    const notebook = ext === 'ipynb';
    const d = core.decodeText(buf, { maxBytes: notebook ? LIMITS.fileBytes : LIMITS.textReadBytes });
    if (d.binary) return { error: kind === 'unknown' ? `“${name}” doesn’t look like text or a document Siren can read.` : `“${name}” isn’t plain text.` };
    text = (notebook && core.notebookText(d.text)) || d.text;
    chars = d.cut ? Math.round((text.length * buf.byteLength) / LIMITS.textReadBytes) : text.length;
    kind = 'text';
  }
  if (text.length > LIMITS.fileChars) note = 'cut';
  const item = { kind, name, size: buf.byteLength, text: text.slice(0, LIMITS.fileChars), chars, pages, pagesRead, note, bytes: buf };
  return { item, result: { kind, name, size: buf.byteLength, pages, chars, shown: Math.min(chars, LIMITS.fileChars), note } };
}

/** The items of a message about to be sent: { items } or { error } (nothing is claimed then). */
function claim(tokens) {
  const list = [...new Set(Array.isArray(tokens) ? tokens : [])];
  if (list.length > LIMITS.files) return { error: `Siren takes up to ${LIMITS.files} attachments per message.` };
  expire();
  const entries = [];
  for (const t of list) {
    const e = typeof t === 'string' && UUID.test(t) ? pending.get(t) : null;
    if (!e) return { error: EXPIRED };
    if (e.claimed) return { error: 'That attachment was already sent.' };
    entries.push(e);
  }
  if (entries.filter((e) => e.item.kind === 'image').length > LIMITS.images) return { error: `Up to ${LIMITS.images} images per message.` };
  for (const e of entries) e.claimed = true;
  armExpiry();
  return { items: entries.map((e) => e.item) };
}

/** The message wasn't stored: its attachments can be sent again. */
function unclaim(tokens) {
  for (const t of Array.isArray(tokens) ? tokens : []) {
    const e = pending.get(t);
    if (e) (e.claimed = false), (e.at = now());
  }
  armExpiry();
}

/** The message was stored: the held copies go. */
function release(tokens) {
  for (const t of Array.isArray(tokens) ? tokens : []) pending.delete(t);
  armExpiry();
}

// ------------------------------------------------------------------ copies on disk
const folderOf = (convId) => {
  if (!CONV_ID.test(String(convId || ''))) throw new Error('Invalid conversation id');
  return path.join(root(), convId);
};

// The file under its name, never over another one (a link, or a copy where links don't work).
async function place(dir, name, bytes, taken) {
  const part = path.join(dir, `.${crypto.randomUUID()}.part`);
  await fsp.writeFile(part, bytes, { flag: 'wx' });
  try {
    for (let n = core.uniqueName(name, taken); ; n = core.uniqueName(name, taken)) {
      const full = path.join(dir, n);
      if (path.dirname(path.resolve(full)) !== path.resolve(dir)) throw new Error('An attachment’s name left its folder');
      taken.add(n.toLowerCase());
      try {
        await fsp.link(part, full);
        return full;
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        if (!['EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS', 'EINVAL'].includes(err.code)) throw err;
      }
      try {
        await fsp.copyFile(part, full, fs.constants.COPYFILE_EXCL);
        return full;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  } finally {
    await fsp.rm(part, { force: true });
  }
}

/** Copies the non-image files into the conversation's folder; returns the items with `path` (images as they were). */
async function save(convId, items) {
  const dir = folderOf(convId);
  const files = (items || []).filter((i) => i.kind !== 'image');
  if (!files.length) return items || [];
  await fsp.mkdir(dir, { recursive: true });
  const taken = new Set((await fsp.readdir(dir).catch(() => [])).map((n) => n.toLowerCase()));
  const out = [];
  for (const item of items) {
    if (item.kind === 'image') out.push(item);
    else out.push({ ...item, path: await place(dir, core.savedName(item.name), item.bytes, taken) });
  }
  return out;
}

/** A conversation was deleted: its copies go too. */
async function removeFor(convId) {
  await fsp.rm(folderOf(convId), { recursive: true, force: true });
}

async function removeAll() {
  await fsp.rm(root(), { recursive: true, force: true });
}

/** At start: folders whose conversation is gone (deleted while the app crashed, or by hand). */
async function sweep() {
  const entries = await fsp.readdir(root(), { withFileTypes: true }).catch((err) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  let removed = 0;
  for (const e of entries) {
    if (!e.isDirectory() || !CONV_ID.test(e.name)) continue;
    const conv = path.join(store.dataDir(), 'conversations', `${e.name}.json`);
    if (fs.existsSync(conv)) continue;
    await fsp.rm(path.join(root(), e.name), { recursive: true, force: true });
    removed++;
  }
  if (removed) log.info('attachments swept', { removed });
  return removed;
}

module.exports = { root, extract, prepare, claim, unclaim, release, held, save, removeFor, removeAll, sweep };
