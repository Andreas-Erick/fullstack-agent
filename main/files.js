// Shared filesystem helpers: sandboxed path resolution, recursive walking, simple text search.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// Resolve `rel` inside `root`; throws if the result escapes the root.
function resolveInside(root, rel) {
  const base = path.resolve(root);
  const full = path.resolve(base, String(rel || '').replace(/^[/\\]+/, ''));
  const relative = path.relative(base, full);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Path "${rel}" is outside the allowed folder`);
  return full;
}

function isInside(root, full) {
  const relative = path.relative(path.resolve(root), path.resolve(full));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
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

module.exports = { resolveInside, isInside, walk, toPosix, scoreText, queryTerms };
