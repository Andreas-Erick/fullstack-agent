// Memory vault: one plain-text Markdown file per memory, with a small front-matter header.
// Users can read/edit the files in any text editor; the agent reads/writes them through tool calls.
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const log = require('./logger');

// A memory written in a turn that had read outside content (a web page, an email, a file): kept as
// `source: outside` in its frontmatter, so the prompt shows it as data, never as the user's own words.
const OUTSIDE = 'outside';
const LEGACY_DIR = () => path.join(store.dataDir(), 'memory-vault');
let migrated = false;

// Memories live in the agent's Obsidian vault (Memory/) unless a custom folder is configured.
async function vaultDir() {
  const s = await store.getSettings();
  let dir = s.memory.vaultPath;
  if (!dir) {
    const vault = await require('./obsidian').vaultPath();
    dir = vault ? path.join(vault, 'Memory') : LEGACY_DIR();
  }
  await fsp.mkdir(dir, { recursive: true });
  if (!migrated) {
    migrated = true;
    await migrateLegacy(dir).catch(() => {});
  }
  return dir;
}

// One-time copy of memories from the old app-data folder into the vault.
async function migrateLegacy(dir) {
  const legacy = LEGACY_DIR();
  if (path.resolve(legacy) === path.resolve(dir)) return;
  const old = await fsp.readdir(legacy).catch(() => []);
  const marker = path.join(legacy, '.migrated');
  if (!old.some((f) => f.endsWith('.md')) || old.includes('.migrated')) return;
  for (const f of old.filter((x) => x.endsWith('.md'))) {
    const dest = path.join(dir, f);
    await fsp.copyFile(path.join(legacy, f), dest).catch(() => {});
  }
  await fsp.writeFile(marker, `Copied to ${dir} on ${new Date().toISOString()}\n`);
}

function parseEntry(id, text) {
  const entry = { id, title: id, category: 'general', created: 0, updated: 0, content: text };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (m) {
    entry.content = m[2].trim();
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      const [, k, v] = kv;
      if (k === 'created' || k === 'updated') entry[k] = Date.parse(v) || 0;
      else if (k === 'title' || k === 'category') entry[k] = unquote(v);
      else if (k === 'source' && unquote(v) === OUTSIDE) entry.source = OUTSIDE;
    }
  }
  return entry;
}

function unquote(v) {
  try {
    return v.startsWith('"') ? JSON.parse(v) : v;
  } catch {
    return v;
  }
}

function serialize(entry) {
  return [
    '---',
    'type: memory',
    `title: ${JSON.stringify(entry.title)}`,
    `category: ${JSON.stringify(entry.category || 'general')}`,
    ...(entry.source === OUTSIDE ? [`source: ${OUTSIDE}`] : []),
    `created: ${new Date(entry.created).toISOString()}`,
    `updated: ${new Date(entry.updated).toISOString()}`,
    '---',
    '',
    entry.content.trim(),
    '',
  ].join('\n');
}

// Memory files are the .md notes in the folder, except its auto-generated index note.
const isMemoryFile = (f) => f.endsWith('.md') && f !== 'Memory.md';

// Keep the vault folder index and note history in sync (no-op when memories live outside the vault).
function notify(full, message) {
  require('./obsidian').notifyExternalChange(full, message).catch(() => {});
}

function slug(text) {
  return (
    String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'memory'
  );
}

function checkId(id) {
  if (!/^[a-z0-9_-]+$/i.test(String(id || ''))) throw new Error(`Invalid memory id "${id}"`);
  return id;
}

// The parsed list, kept for a minute (prompts read it every turn); our own writes clear it at once,
// edits made outside the app show up within the minute.
const CACHE_MS = 60000;
let cache = null;
const forget = () => (cache = null);

// A list with a file skipped is not cached: a file locked for a moment comes back on the next read. The
// log gets a count, never names (a memory's file name is its title).
async function list() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.entries.map((e) => ({ ...e }));
  const { entries, skipped } = await readAll();
  if (skipped) log.warn('memory unreadable', { count: skipped });
  else cache = { at: Date.now(), entries };
  return entries.map((e) => ({ ...e }));
}

async function readOne(dir, f) {
  const full = path.join(dir, f);
  const [text, stat] = await Promise.all([fsp.readFile(full, 'utf8'), fsp.stat(full)]);
  const e = parseEntry(f.slice(0, -3), text);
  e.created ||= stat.birthtimeMs;
  e.updated ||= stat.mtimeMs;
  return e;
}

// Each file on its own: one that can't be read (locked for a moment, a folder named x.md) is skipped.
async function readAll() {
  const dir = await vaultDir();
  const files = (await fsp.readdir(dir)).filter(isMemoryFile);
  const read = await Promise.all(files.map((f) => readOne(dir, f).catch(() => null)));
  const entries = read.filter(Boolean).sort((a, b) => b.updated - a.updated);
  return { entries, skipped: read.length - entries.length };
}

async function get(id) {
  const dir = await vaultDir();
  const text = await fsp.readFile(path.join(dir, `${checkId(id)}.md`), 'utf8').catch(() => null);
  return text == null ? null : parseEntry(id, text);
}

async function save({ title, content, category, source }) {
  if (!content || !String(content).trim()) throw new Error('Memory content is required');
  const dir = await vaultDir();
  const now = Date.now();
  const id = `${slug(title || content)}-${crypto.randomBytes(3).toString('hex')}`;
  const entry = {
    id,
    title: String(title || String(content).slice(0, 60)).trim(),
    category: String(category || 'general').trim(),
    created: now,
    updated: now,
    content: String(content),
    ...(source === OUTSIDE ? { source: OUTSIDE } : {}),
  };
  await store.writeTextAtomic(path.join(dir, `${id}.md`), serialize(entry));
  forget();
  notify(path.join(dir, `${id}.md`), `memory: save ${entry.title}`);
  return entry;
}

async function update(id, patch) {
  const existing = await get(id);
  if (!existing) throw new Error(`Memory "${id}" not found`);
  const entry = { ...existing };
  for (const k of ['title', 'content', 'category']) if (patch[k] != null && patch[k] !== '') entry[k] = String(patch[k]);
  if (patch.source === OUTSIDE) entry.source = OUTSIDE; // once outside content wrote into it, it stays marked
  entry.updated = Date.now();
  const dir = await vaultDir();
  await store.writeTextAtomic(path.join(dir, `${id}.md`), serialize(entry));
  forget();
  notify(path.join(dir, `${id}.md`), `memory: update ${entry.title}`);
  return entry;
}

async function remove(id) {
  const dir = await vaultDir();
  await fsp.rm(path.join(dir, `${checkId(id)}.md`), { force: true });
  forget();
  notify(path.join(dir, `${id}.md`), `memory: delete ${id}`);
  return { deleted: id };
}

// Undo of a delete (the Memory view): the entry back as it was, id, dates and all. Never over a memory that
// took the file meanwhile: then it comes back under a new id, as a save would make it.
async function restore(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('Nothing to restore');
  if (typeof entry.content !== 'string' || !entry.content.trim()) throw new Error('Memory content is required');
  const id = checkId(entry.id);
  const dir = await vaultDir();
  const full = path.join(dir, `${id}.md`);
  if (await fsp.access(full).then(() => true, () => false)) return save(entry);
  const now = Date.now();
  const time = (t) => (Number.isFinite(t) && t > 0 ? t : now);
  const back = {
    id,
    title: String(entry.title || entry.content.slice(0, 60)).trim(),
    category: String(entry.category || 'general').trim(),
    created: time(entry.created),
    updated: time(entry.updated),
    content: entry.content,
    ...(entry.source === OUTSIDE ? { source: OUTSIDE } : {}),
  };
  await store.writeTextAtomic(full, serialize(back));
  forget();
  notify(full, `memory: restore ${back.title}`);
  return back;
}

async function search(query) {
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const all = await list();
  if (!terms.length) return all;
  return all
    .map((e) => {
      const hay = `${e.title} ${e.category} ${e.content}`.toLowerCase();
      const score = terms.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.e);
}

async function exportMarkdown() {
  const all = await list();
  return all
    .map((e) => `## ${e.title}\n\n*${e.category} · updated ${new Date(e.updated).toLocaleString()}*\n\n${e.content}\n`)
    .join('\n');
}

const NOT_AN_EXPORT = "This file isn't a memory export (a JSON list of memories).";
const IMPORT_MAX = 2000;
// One memory from an export (memory:export's JSON): an object with text content; title and category text when present.
const isEntry = (e) => e !== null && typeof e === 'object' && !Array.isArray(e) && typeof e.content === 'string' && e.content.trim() !== '' && ['title', 'category'].every((k) => e[k] == null || typeof e[k] === 'string');

/** Saves the memories of an export (a list); returns { imported, skipped }. Anything but a list is refused. */
async function importEntries(entries, { max = IMPORT_MAX } = {}) {
  if (!Array.isArray(entries)) throw new Error(NOT_AN_EXPORT);
  let imported = 0;
  let skipped = 0;
  for (const e of entries) {
    if (!isEntry(e) || imported >= max) {
      skipped++;
      continue;
    }
    await save({ title: e.title, category: e.category, content: e.content });
    imported++;
  }
  return { imported, skipped };
}

async function clear() {
  const dir = await vaultDir();
  const files = (await fsp.readdir(dir)).filter(isMemoryFile);
  await Promise.all(files.map((f) => fsp.rm(path.join(dir, f), { force: true })));
  forget();
}

/**
 * The memories that matter for a message (when there are too many to list them all): ranked by
 * relevance and recency (streamcore.retrieve), at most k, each clipped.
 */
async function relevant(query, k = 8) {
  const all = await list();
  const records = all.map((e) => ({ id: e.id, text: `${e.title}. ${e.content}`, at: e.updated, importance: 5, kind: 'observation', evidence: [], entry: e }));
  const top = require('./streamcore').retrieve(records, query, { k, minRelevance: 0.05, weights: { recency: 0.4, importance: 0, relevance: 1.6 } });
  return top.map((r) => r.entry);
}

module.exports = { vaultDir, list, get, save, update, remove, restore, search, exportMarkdown, importEntries, clear, relevant, NOT_AN_EXPORT, OUTSIDE };
