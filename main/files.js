// Shared filesystem helpers: sandboxed path resolution, recursive walking, simple text search.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Where a path really is on disk: a link or junction inside the root may point anywhere (security
// review 2026-10-29: "link/secret.txt" in the vault read a file outside it). The nearest part that
// exists is resolved (a file about to be written doesn't exist yet). If even that fails, the plain
// check above stands.
function realInside(base, full) {
  let probe = full;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) return true;
    probe = up;
  }
  try {
    const relative = path.relative(fs.realpathSync.native(base), fs.realpathSync.native(probe));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  } catch {
    return true;
  }
}

// Resolve `rel` inside `root`; throws if the result escapes the root, by name or through a link, or
// names a Windows alternate data stream ("note.md:hidden").
function resolveInside(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, String(rel || '').replace(/^[/\\]+/, ''));
  const relative = path.relative(base, full);
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(':') || !realInside(base, full)) throw new Error(`Path "${rel}" is outside the allowed folder`);
  return full;
}

function isInside(root, full) {
  const base = path.resolve(root);
  const relative = path.relative(base, path.resolve(full));
  return !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(':') && realInside(base, path.resolve(full));
}

// A folder or file name as Windows and macOS compare it: case doesn't count, and Windows drops
// trailing dots and spaces. ".GIT", ".git." and "Node_Modules" are .git and node_modules.
const sameName = (part) => String(part || '').toLowerCase().replace(/[. ]+$/, '');

/** Whether any part of a relative path is one of `names` (lower-case), compared as the OS does. */
function hasReservedPart(relative, names) {
  return String(relative || '').split(/[/\\]+/).some((p) => names.includes(sameName(p)));
}

async function walk(root, { exts, ignore = [], maxFiles = 20000 } = {}) {
  const out = [];
  async function visit(dir) {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      if (ignore.includes(e.name) || (e.name.startsWith('.') && e.name !== '.env.example')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await visit(full);
      else if (e.isFile() && (!exts || exts.includes(path.extname(e.name).toLowerCase()))) out.push(full);
    }
  }
  await visit(path.resolve(root));
  return out;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Score a document against query terms; returns { score, snippet }.
function scoreText(text, terms, titleBoost = '') {
  const lower = text.toLowerCase();
  const title = titleBoost.toLowerCase();
  let score = 0;
  let firstHit = -1;
  for (const t of terms) {
    if (title.includes(t)) score += 5;
    let idx = lower.indexOf(t);
    let count = 0;
    while (idx !== -1 && count < 20) {
      if (firstHit === -1 || idx < firstHit) firstHit = idx;
      count++;
      idx = lower.indexOf(t, idx + t.length);
    }
    score += count;
  }
  let snippet = '';
  if (firstHit >= 0) {
    const s = Math.max(0, firstHit - 120);
    snippet = (s > 0 ? '…' : '') + text.slice(s, firstHit + 220).replace(/\s+/g, ' ').trim() + '…';
  }
  return { score, snippet };
}

function queryTerms(q) {
  return String(q || '')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((t) => t.length > 1);
}

module.exports = { resolveInside, isInside, hasReservedPart, walk, toPosix, scoreText, queryTerms };
