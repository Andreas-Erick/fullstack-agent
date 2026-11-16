// The user's notes (the Notes view, renderer/js/notes.js, over main/notebook.js), pure: reading a note
// (frontmatter, title, body, snippet, #tags, words), safe file names, pinning, the order of the list,
// search, and rewriting [[links]] when a note is renamed. Notes are plain Markdown in the vault's Notes/
// folder (subfolders are notebooks) and Inbox/ (quick captures), so Obsidian opens them as they are.
// test/notebook.test.js.

const ROOTS = ['Notes', 'Inbox'];
// The folders' auto-maintained lists (obsidian.refreshFolderIndex) are not notes of the user's.
const isIndex = (rel) => ROOTS.some((r) => rel === `${r}/${r}.md`);

/** A vault-relative path that is one of the user's notes (inside Notes/ or Inbox/, a .md, no tricks). */
function isNotePath(rel) {
  const p = String(rel || '');
  if (!/\.md$/i.test(p) || p.includes('\\') || p.split('/').some((s) => !s || s === '.' || s === '..' || s.startsWith('.'))) return false;
  return ROOTS.includes(p.split('/')[0]) && p.split('/').length >= 2 && !isIndex(p);
}

/** { front: { key: value }, frontRaw, body }; front values are strings (lists stay as written). */
function parse(text) {
  const t = String(text ?? '').replace(/^﻿/, '');
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { front: {}, frontRaw: '', body: t };
  const front = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) front[kv[1]] = kv[2].trim();
  }
  return { front, frontRaw: m[0], body: t.slice(m[0].length) };
}

const titleOf = (rel) => String(rel || '').split('/').pop().replace(/\.md$/i, '');

/** The body as plain text for a preview line: no Markdown, links shown by their text. */
function snippet(body, max = 180) {
  const s = String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[\[[^\]]*\]\]/g, ' ')
    .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : s;
}

/** #tags in the body (not in code, not headings) and the frontmatter's tags, lower case, once each. */
function tags(text) {
  const { front, body } = parse(text);
  const out = new Set();
  const fm = String(front.tags || '').replace(/^\[|\]$/g, '');
  for (const t of fm.split(/[,\s]+/)) if (/^#?[\p{L}\p{N}_/-]+$/u.test(t)) out.add(t.replace(/^#/, '').toLowerCase());
  const clean = body.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
  for (const m of clean.matchAll(/(^|[\s(])#([\p{L}_][\p{L}\p{N}_/-]{0,40})/gu)) out.add(m[2].toLowerCase());
  return [...out].slice(0, 20);
}

const words = (body) => (String(body || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

/** A title that works as a file name everywhere (and in [[links]]), at most 80 characters. */
function safeTitle(title) {
  const t = String(title || '').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 80).trim();
  return t || 'Untitled';
}

/** `<folder>/<title>.md`, or "<title> 2", "<title> 3"… when taken (`taken` holds lower-case paths). */
function uniquePath(folder, title, taken) {
  const base = safeTitle(title);
  for (let n = 1; n < 1000; n++) {
    const rel = `${folder}/${n === 1 ? base : `${base} ${n}`}.md`;
    if (!taken.has(rel.toLowerCase())) return rel;
  }
  throw new Error('Too many notes with that title.');
}

/** A brain dump → { title, body }: the first line (without a heading mark) is the title. */
function fromDump(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i < 0) return { title: '', body: '' };
  const first = lines[i].replace(/^\s{0,3}#{1,6}\s+/, '').trim();
  const title = safeTitle(first.length > 80 ? first.slice(0, 80).replace(/\s+\S*$/, '') : first);
  const rest = lines.slice(i + 1).join('\n').replace(/^\n+/, '');
  // A long first line is the start of the text, not a title: keep it in the body too.
  return { title, body: first.length > 80 ? `${first}\n${rest}`.trim() : rest };
}

/** The note with `pinned: true` in its frontmatter, or without it. */
function setPinned(text, on) {
  const { frontRaw, body } = parse(text);
  if (!frontRaw) return on ? `---\npinned: true\n---\n${body}` : body;
  let fm = frontRaw.replace(/^pinned:.*\r?\n?/m, '');
  if (on) fm = fm.replace(/^---\r?\n/, '---\npinned: true\n');
  return /^---\r?\n---/.test(fm) ? body : fm + body;
}

const pinnedIn = (front) => /^(true|yes|1)$/i.test(String(front?.pinned || ''));

/** Pinned first, then the most recently changed. */
const sortNotes = (list) => [...list].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.mtime - a.mtime);

/** Whether a note matches a search: every word in its title, text, tags or notebook. */
function matches(note, query) {
  const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const qs = norm(query).split(/\s+/).filter(Boolean);
  if (!qs.length) return true;
  const hay = norm(`${note.title} ${note.text ?? note.snippet ?? ''} ${(note.tags || []).map((t) => `#${t}`).join(' ')} ${note.folder || ''}`);
  return qs.every((q) => hay.includes(q.replace(/^#/, '#')) || hay.includes(q.replace(/^#/, '')));
}

/** The text with links to a renamed note pointing at its new name: [[Old]], [[Old|x]], [[Old#h]], [[Notes/Old]]. */
function relink(text, oldRel, newRel) {
  const oldTitle = titleOf(oldRel);
  const newTitle = titleOf(newRel);
  const oldPath = oldRel.replace(/\.md$/i, '');
  const newPath = newRel.replace(/\.md$/i, '');
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(text).replace(new RegExp(`(!?\\[\\[)(${esc(oldPath)}|${esc(oldTitle)})((?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\])`, 'gi'), (_, open, target, rest) => `${open}${target.includes('/') ? newPath : newTitle}${rest}`);
}

/** Notebooks (subfolders of Notes/, and Inbox), each with how many notes and whether one changed today. */
function notebooks(list, today) {
  const by = new Map();
  for (const n of list) {
    const name = n.folder || 'Notes';
    const b = by.get(name) || { name, count: 0, done: false };
    b.count++;
    if (n.day === today) b.done = true;
    by.set(name, b);
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
}

module.exports = { ROOTS, isIndex, isNotePath, parse, titleOf, snippet, tags, words, safeTitle, uniquePath, fromDump, setPinned, pinnedIn, sortNotes, matches, relink, notebooks };
