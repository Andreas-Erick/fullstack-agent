// Custom faces: <userData>/faces/<name>/index.html (+ optional face.json), shown in a sandboxed iframe.
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');

const ROOT = path.join(__dirname, '..');
const BUNDLED = path.join(ROOT, 'renderer', 'faces', 'bundled'); // faces the app ships (Siren's own)

const hashOf = (text) => crypto.createHash('sha1').update(text).digest('hex');

/**
 * The shipped faces (renderer/faces/bundled/<slug>/) in the user's faces folder: copied when missing,
 * refreshed when a new version changes one the user never edited (.bundled.json keeps a hash of
 * each index.html as placed), left alone when edited, not brought back when removed.
 */
async function placeBundled(d) {
  const marker = path.join(d, '.bundled.json');
  const seen = await store.readJson(marker, {});
  let changed = false;
  for (const e of await fsp.readdir(BUNDLED, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory()) continue;
    const src = path.join(BUNDLED, e.name);
    const text = await fsp.readFile(path.join(src, 'index.html'), 'utf8').catch(() => null);
    if (text === null) continue;
    const h = hashOf(text);
    const target = path.join(d, e.name);
    const current = await fsp.readFile(path.join(target, 'index.html'), 'utf8').catch(() => null);
    if (!(e.name in seen)) {
      if (current === null) await fsp.cp(src, target, { recursive: true });
    } else if (seen[e.name] === h) continue;
    else if (current === null || hashOf(current) !== seen[e.name]) continue; // removed, or edited by the user
    else await fsp.cp(src, target, { recursive: true, force: true });
    seen[e.name] = h;
    changed = true;
  }
  if (changed) await store.writeJsonAtomic(marker, seen);
}

let bundledOnce = null;
async function dir() {
  const d = path.join(store.dataDir(), 'faces');
  if (!fs.existsSync(d)) {
    // First run: install the bundled example faces as a starting point.
    await fsp.cp(path.join(ROOT, 'renderer', 'faces', 'examples'), d, { recursive: true }).catch(() => fsp.mkdir(d, { recursive: true }));
  }
  bundledOnce ||= placeBundled(d).catch(() => {}); // a read-only install folder must not break faces
  await bundledOnce;
  return d;
}

async function list() {
  const d = await dir();
  const out = [];
  for (const e of await fsp.readdir(d, { withFileTypes: true })) {
    if (!e.isDirectory() || !fs.existsSync(path.join(d, e.name, 'index.html'))) continue;
    const meta = await store.readJson(path.join(d, e.name, 'face.json'), {});
    out.push({ id: `custom:${e.name}`, folder: e.name, title: meta.title || e.name, tagline: meta.tagline || '' });
  }
  return out;
}

/**
 * The file faces://<name>/<rel> serves from the faces folder `root`, or null when it would be outside
 * that face's folder: a name of "." or ".." read the data folder (faces://../settings.json, security
 * review 2026-10-29). name and rel are already decoded.
 */
function servedFile(root, name, rel) {
  if (!/^[\w-][\w.-]*$/.test(String(name || '')) || String(rel || '').includes('..')) return null;
  const base = path.resolve(root);
  const faceRoot = path.resolve(base, name);
  const file = path.resolve(faceRoot, rel || 'index.html');
  if (path.dirname(faceRoot) !== base || !file.startsWith(faceRoot + path.sep)) return null;
  return file;
}

module.exports = { dir, list, placeBundled, servedFile, ROOT, BUNDLED };
