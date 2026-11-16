// The user's notes: Notes/ (subfolders are notebooks) and Inbox/ in the vault, written by the user in the
// Notes view (renderer/js/notes.js) and read by the assistant like any vault note (vault_search,
// vault_read_note). Writes go through obsidian.writeNote, so each change is versioned in the vault's
// history, the folder lists and the link index stay current; a deleted note goes to the vault's .trash.
// The pure part is notebookcore.js.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const obsidian = require('./obsidian');
const { resolveInside } = require('./files');
const core = require('./notebookcore');

const MAX_NOTES = 5000;
const MAX_BYTES = 2000000;
const ymd = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function root() {
  const r = await obsidian.vaultPath();
  if (!r) throw new Error('Notes live in your vault, and no vault is set up yet (Settings → Knowledge).');
  return r;
}

function check(rel) {
  if (!core.isNotePath(rel)) throw new Error('That is not one of your notes (Notes/ or Inbox/).');
  return rel;
}

async function walk(dir, out = []) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.') || out.length >= MAX_NOTES) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

/** Every note, newest first (pinned on top): { path, title, folder, mtime, day, words, snippet, tags, pinned }. */
async function list() {
  const r = await root();
  const today = ymd(Date.now());
  const out = [];
  for (const top of core.ROOTS) {
    for (const full of await walk(path.join(r, top))) {
      const rel = path.relative(r, full).split(path.sep).join('/');
      if (!core.isNotePath(rel)) continue;
      const st = await fsp.stat(full).catch(() => null);
      if (!st || st.size > MAX_BYTES) continue;
      const text = await fsp.readFile(full, 'utf8').catch(() => '');
      const { front, body } = core.parse(text);
      const parts = rel.split('/');
      out.push({
        path: rel,
        title: core.titleOf(rel),
        folder: top === 'Inbox' ? 'Inbox' : parts.slice(1, -1).join('/'),
        mtime: st.mtimeMs,
        day: ymd(st.mtimeMs),
        words: core.words(body),
        snippet: core.snippet(body),
        text: body.slice(0, 4000), // for the search in the list
        tags: core.tags(text),
        pinned: core.pinnedIn(front),
      });
    }
  }
  return { notes: core.sortNotes(out), today };
}

/** One note: { path, title, folder, body, pinned, mtime }. */
async function read(rel) {
  check(rel);
  const full = resolveInside(await root(), rel);
  const text = await fsp.readFile(full, 'utf8');
  const st = await fsp.stat(full);
  const { front, body } = core.parse(text);
  return { path: rel, title: core.titleOf(rel), folder: rel.split('/').slice(1, -1).join('/'), body, pinned: core.pinnedIn(front), mtime: st.mtimeMs };
}

async function taken(r, folder) {
  const dir = path.join(r, folder);
  const names = await fsp.readdir(dir).catch(() => []);
  return new Set(names.map((n) => `${folder}/${n}`.toLowerCase()));
}

/** A new note in Notes/ (or a notebook inside it, or Inbox); a taken title gets a number. Returns its path. */
async function create({ title = '', body = '', folder = '' } = {}) {
  const r = await root();
  // A notebook is a subfolder of Notes/ (names cleaned like titles); "Inbox" is the quick-capture folder.
  const parts = String(folder || '').split('/').map((s) => s.trim()).filter(Boolean);
  const dir = parts[0] === 'Inbox' ? 'Inbox' : ['Notes', ...(parts[0] === 'Notes' ? parts.slice(1) : parts).map(core.safeTitle)].join('/');
  const rel = core.uniquePath(dir, title, await taken(r, dir));
  check(rel);
  await obsidian.writeNote(rel, String(body || ''), 'create', { source: 'user' });
  return { path: rel };
}

/**
 * Saves a note's text (its frontmatter kept); a changed title renames it, and the links to it in other
 * notes follow. Returns { path } (the new one after a rename).
 */
async function save(rel, { title, body } = {}) {
  check(rel);
  const r = await root();
  const full = resolveInside(r, rel);
  if (body !== undefined) {
    const old = await fsp.readFile(full, 'utf8').catch(() => '');
    const { frontRaw } = core.parse(old);
    await obsidian.writeNote(rel, `${frontRaw}${String(body)}`, 'overwrite', { source: 'user' });
  }
  if (title !== undefined && core.safeTitle(title) !== core.titleOf(rel)) return rename(rel, title);
  return { path: rel };
}

/** Renames a note in its folder and points the [[links]] to it at the new name. */
async function rename(rel, title) {
  check(rel);
  const r = await root();
  const dir = rel.split('/').slice(0, -1).join('/');
  const used = await taken(r, dir);
  used.delete(rel.toLowerCase());
  const next = core.uniquePath(dir, title, used);
  if (next === rel) return { path: rel };
  const backlinks = (await require('./linkindex').forNote(r, rel).catch(() => ({ backlinks: [] }))).backlinks || [];
  await fsp.rename(resolveInside(r, rel), resolveInside(r, check(next)));
  await obsidian.afterChange(r, rel, `rename ${rel} → ${next}`, { deleted: true });
  await obsidian.afterChange(r, next, `rename ${rel} → ${next}`);
  let relinked = 0;
  for (const b of backlinks) {
    const from = typeof b === 'string' ? b : b?.path || b?.from;
    if (!from || from === rel) continue;
    const fromFull = resolveInside(r, from);
    const text = await fsp.readFile(fromFull, 'utf8').catch(() => null);
    if (text == null) continue;
    const updated = core.relink(text, rel, next);
    if (updated === text) continue;
    await obsidian.writeNote(from, updated, 'overwrite', { source: 'user' });
    relinked++;
  }
  return { path: next, relinked };
}

/** Moves a note to the vault's .trash (Obsidian's own bin; the history keeps it too). */
async function remove(rel) {
  check(rel);
  return obsidian.deleteNote(rel);
}

async function pin(rel, on) {
  check(rel);
  const full = resolveInside(await root(), rel);
  const text = await fsp.readFile(full, 'utf8');
  await obsidian.writeNote(rel, core.setPinned(text, Boolean(on)), 'overwrite', { source: 'user' });
  return { path: rel, pinned: Boolean(on) };
}

/**
 * ✨ Polish: the note rewritten clearly by the AI brain, with links to related notes (polishcore.js).
 * Nothing is written: the Notes view shows it and the user accepts it or keeps theirs. Returns
 * { body, added } (added: the titles newly linked).
 */
async function polish(rel) {
  check(rel);
  const polishcore = require('./polishcore');
  const note = await read(rel);
  if (!note.body.trim()) throw new Error('The note is empty: write something first.');
  if (note.body.length > polishcore.MAX_NOTE) throw new Error(`The note is longer than ${polishcore.MAX_NOTE.toLocaleString()} characters; polish it in parts.`);
  const { notes } = await list();
  const related = polishcore.candidates(note, notes);
  const settings = await require('./store').getSettings();
  // The everyday model (Sonnet for Claude): good at writing, much quicker than the deep one.
  const run = require('./llm').complete({ ...settings, llm: { ...settings.llm, modelMode: 'normal' } }, polishcore.prompt(note, related), { maxTokens: 8000 });
  let timer;
  const limit = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('Polishing took too long; try again.')), 180000)));
  try {
    // "fetch failed" said nothing: name the brain that didn't answer (localcore.unreachableMessage).
    const reply = await Promise.race([run, limit]).catch((err) => {
      const plain = require('./localcore').unreachableMessage(settings.llm?.baseUrl, err);
      throw plain ? new Error(`Polishing needs the AI brain, and it didn't answer: ${plain}`) : err;
    });
    const out = polishcore.clean(reply, note, notes.map((n) => n.title));
    require('./logger').info('note polished', { chars: note.body.length, offered: related.length, linked: out.added.length });
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/** For the Inner World: how many notes, which changed today, and the notebooks. */
async function summary() {
  const { notes, today } = await list();
  return { count: notes.length, today: notes.filter((n) => n.day === today).map((n) => n.title), notebooks: core.notebooks(notes, today) };
}

module.exports = { list, read, create, save, rename, remove, pin, polish, summary };
