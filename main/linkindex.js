// The vault's link index (rules in linkcore.js), kept in memory: built on first use, then each call
// re-reads only the notes whose modification time changed (edits made here and in Obsidian alike) and
// drops the ones that are gone. obsidian.js marks a note it wrote so the next call reads it again.
const path = require('path');
const fsp = require('fs').promises;
const log = require('./logger');
const core = require('./linkcore');
const { walk, toPosix } = require('./files');

const IGNORE = ['.obsidian', '.trash', 'node_modules', '.git'];
const MAX_NOTE_BYTES = 2 * 1024 * 1024;

let cache = { root: null, notes: new Map(), index: null }; // notes: rel -> { mtime, text }
let building = null;

/** obsidian.js wrote, moved or deleted a note: read it again next time. */
function touched(rel) {
  cache.notes.delete(rel);
  cache.index = null;
}

async function refresh(root) {
  if (cache.root !== root) cache = { root, notes: new Map(), index: null };
  const started = Date.now();
  const files = await walk(root, { exts: ['.md'], ignore: IGNORE });
  const seen = new Set();
  let read = 0;
  for (const full of files) {
    const rel = toPosix(path.relative(root, full));
    seen.add(rel);
    const st = await fsp.stat(full).catch(() => null);
    if (!st || st.size > MAX_NOTE_BYTES) continue;
    const hit = cache.notes.get(rel);
    if (hit && hit.mtime === st.mtimeMs) continue;
    const text = await fsp.readFile(full, 'utf8').catch(() => '');
    cache.notes.set(rel, { mtime: st.mtimeMs, text: text.includes('[[') ? text : '' }); // only linking notes keep their text
    cache.index = null;
    read++;
  }
  for (const rel of [...cache.notes.keys()]) {
    if (!seen.has(rel)) {
      cache.notes.delete(rel);
      cache.index = null;
    }
  }
  if (!cache.index) {
    cache.index = core.build([...cache.notes].map(([p, n]) => ({ path: p, text: n.text })));
    if (read > 50) log.info('vault links indexed', { notes: cache.notes.size, read, ms: Date.now() - started });
  }
  return cache.index;
}

/** The current index for the vault at `root` (one refresh at a time). */
async function get(root) {
  if (!root) return { links: {}, backlinks: {}, unresolved: 0, notes: 0 };
  while (building) await building.catch(() => {});
  building = refresh(root);
  try {
    return await building;
  } finally {
    building = null;
  }
}

/** One note's links and backlinks (vault-relative path). */
async function forNote(root, rel) {
  const index = await get(root);
  return { path: rel, links: index.links[rel] || [], backlinks: index.backlinks[rel] || [] };
}

module.exports = { get, forNote, touched };
