// The vault's link index (rules in linkcore.js), kept in memory: built on first use, then each call
// re-reads only the notes whose modification time changed (edits made here and in Obsidian alike) and
// drops the ones that are gone. obsidian.js marks a note it wrote so the next call reads it again.
// Each note keeps only its link targets (linksOf), never its text. An edit that leaves the set of notes
// as it was updates that note's links in place (linkcore.relinkNote); a note added or gone rebuilds.
const path = require('path');
const fsp = require('fs').promises;
const log = require('./logger');
const core = require('./linkcore');
const { walk, toPosix } = require('./files');

const IGNORE = ['.obsidian', '.trash', 'node_modules', '.git'];
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const BATCH = 32; // stats and reads at a time

const empty = (root = null) => ({ root, notes: new Map(), index: null, resolve: null, dirty: new Set() });
let cache = empty(); // notes: rel -> { mtime, targets }
let building = null;

/** obsidian.js wrote, moved or deleted a note: read it again next time. */
function touched(rel) {
  cache.dirty.add(rel);
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

async function refresh(root) {
  if (cache.root !== root) cache = empty(root);
  const started = Date.now();
  const files = await walk(root, { exts: ['.md'], ignore: IGNORE });
  const dirty = cache.dirty;
  cache.dirty = new Set();
  const seen = new Set();
  const changed = []; // [rel, the targets it had]
  let reshaped = false; // a note came or went: every link resolves again
  let read = 0;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH).map((full) => ({ full, rel: toPosix(path.relative(root, full)) }));
    const stats = await Promise.all(batch.map((f) => fsp.stat(f.full).catch(() => null))); // a note removed meanwhile is skipped
    const reads = batch.map(async ({ full, rel }, j) => {
      seen.add(rel);
      const st = stats[j];
      if (!st || st.size > MAX_NOTE_BYTES) return;
      const hit = cache.notes.get(rel);
      if (hit && hit.mtime === st.mtimeMs && !dirty.has(rel)) return;
      const text = await fsp.readFile(full, 'utf8').catch(() => '');
      const targets = text.includes('[[') ? core.linksOf(text) : [];
      if (!hit) reshaped = true;
      else if (!sameList(hit.targets, targets)) changed.push([rel, hit.targets]);
      cache.notes.set(rel, { mtime: st.mtimeMs, targets });
      read++;
    });
    await Promise.all(reads);
  }
  for (const rel of [...cache.notes.keys()]) {
    if (!seen.has(rel)) {
      cache.notes.delete(rel);
      reshaped = true;
    }
  }
  if (!cache.index || reshaped) {
    // Map order is the walk's for a first build; notes added later go last (order only matters for ties
    // that resolver() settles by path, never by order).
    cache.resolve = core.resolver([...cache.notes.keys()]);
    cache.index = core.build([...cache.notes].map(([p, n]) => ({ path: p, targets: n.targets })), cache.resolve);
    if (read > 50) log.info('vault links indexed', { notes: cache.notes.size, read, ms: Date.now() - started });
  } else {
    for (const [rel, before] of changed) {
      cache.index = core.relinkNote(cache.index, rel, core.linkNote(rel, before, cache.resolve), core.linkNote(rel, cache.notes.get(rel).targets, cache.resolve));
    }
  }
  return cache.index;
}

/** The current index for the vault at `root` (one refresh at a time). */
async function get(root) {
  if (!root) return { links: {}, backlinks: {}, unresolved: 0, notes: 0 };
  while (building) await building.catch(() => {}); // the earlier refresh failed for its own caller; this one builds afresh
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
