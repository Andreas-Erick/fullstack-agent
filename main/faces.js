// Custom faces: <userData>/faces/<name>/index.html (+ optional face.json), shown in a sandboxed iframe.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');

const ROOT = path.join(__dirname, '..');

async function dir() {
  const d = path.join(store.dataDir(), 'faces');
  if (!fs.existsSync(d)) {
    // First run: install the bundled example faces as a starting point.
    await fsp.cp(path.join(ROOT, 'renderer', 'faces', 'examples'), d, { recursive: true }).catch(() => fsp.mkdir(d, { recursive: true }));
  }
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

module.exports = { dir, list, ROOT };
