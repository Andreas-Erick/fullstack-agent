// The architecture map for the Architecture view: reads the app's code (statically, like codemap.js),
// hands each file's facts to archcore.js and caches the result in <userData>/archmap.json. "Rebuild"
// in the view scans again; a fingerprint of the files (names, sizes, times) tells the view when the
// code changed since the last build, e.g. after a self-change.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const codemap = require('./codemap');
const core = require('./archcore');

const MAX_SYMBOLS = 200;

// Every file on the map: the JavaScript codemap knows, plus the pages and styles, plus the Android app.
function sourceFiles(root) {
  const out = codemap.jsFiles(root).filter((f) => !f.startsWith('renderer/faces/examples/'));
  const list = (dir, re) => {
    try {
      return fs.readdirSync(path.join(root, dir)).filter((n) => re.test(n)).map((n) => `${dir}/${n}`);
    } catch {
      return [];
    }
  };
  out.push(...list('renderer', /\.(html|css)$/), ...list('renderer/remote', /\.(html|css)$/));
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory() && !['build', '.gradle'].includes(e.name)) walk(rel);
      else if (e.name.endsWith('.java')) out.push(rel);
    }
  };
  walk('android');
  return [...new Set(out)].sort();
}

function symbolsOf(root, rel, text) {
  if (rel.endsWith('.js')) {
    const exported = codemap.exportsOf(text, rel);
    const seen = new Set();
    return codemap
      .outline(text, rel)
      .filter((s) => !seen.has(`${s.kind}:${s.name}`) && seen.add(`${s.kind}:${s.name}`))
      .map((s) => ({ ...s, ...(exported?.has(s.name) || s.kind.startsWith('export') ? { exported: true } : {}) }))
      .slice(0, MAX_SYMBOLS);
  }
  if (rel.endsWith('.html')) return [...text.matchAll(/<section[^>]*\bid="([\w-]+)"/g)].map((m) => ({ kind: 'section', name: m[1], line: text.slice(0, m.index).split('\n').length }));
  if (rel.endsWith('.java')) {
    const items = [];
    for (const m of text.matchAll(/^\s*(?:public\s+|final\s+)*class\s+(\w+)/gm)) items.push({ kind: 'class', name: m[1], line: text.slice(0, m.index).split('\n').length, exported: true });
    for (const m of text.matchAll(/^\s+(public|private|protected)\s+(?:static\s+|final\s+|synchronized\s+)*[\w<>[\], ]+\s+(\w+)\s*\([^)]*\)\s*(?:throws [\w, ]+)?\{/gm)) items.push({ kind: 'method', name: m[2], line: text.slice(0, m.index).split('\n').length, ...(m[1] === 'public' ? { exported: true } : {}) });
    return items.sort((a, b) => a.line - b.line).slice(0, MAX_SYMBOLS);
  }
  return [];
}

/** Each file's facts: description, size, symbols, imports, IPC calls, events, outside connections. */
function scan(root) {
  const handlers = {};
  const files = sourceFiles(root).map((rel) => {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      /* vanished between listing and reading */
    }
    if (rel.startsWith('main/')) for (const m of text.matchAll(/\bhandle\('([\w-]+:[\w-]+)'/g)) handlers[m[1]] ||= rel;
    const imports = rel.endsWith('.js') ? codemap.importsOf(root, rel, text).map((i) => i.target).filter(Boolean) : [];
    return { path: rel, lines: text ? text.split('\n').length : 0, about: core.aboutOf(text), symbols: symbolsOf(root, rel, text), imports: [...new Set(imports)], ...core.facts(rel, text) };
  });
  return { files, handlers };
}

/** Changes whenever a file is added, removed or edited. */
function fingerprint(root) {
  const h = crypto.createHash('sha1');
  for (const rel of sourceFiles(root)) {
    try {
      const st = fs.statSync(path.join(root, rel));
      h.update(`${rel}:${st.size}:${Math.round(st.mtimeMs)}\n`);
    } catch {
      h.update(`${rel}:gone\n`);
    }
  }
  return h.digest('hex');
}

const cacheFile = () => path.join(require('./store').dataDir(), 'archmap.json');

/** Scans the code and builds the map; compares it with the cached one and saves it. */
async function build(root) {
  const store = require('./store');
  const started = Date.now();
  const prev = await store.readJson(cacheFile(), null);
  const { files, handlers } = scan(root);
  const map = core.build(files, { handlers });
  map.changes = core.diff(prev, map);
  map.builtAt = Date.now();
  map.buildMs = map.builtAt - started;
  map.fingerprint = fingerprint(root);
  await store.writeJsonAtomic(cacheFile(), map);
  return { ...map, stale: false };
}

/** The cached map (built now if there is none or it is from an older format), and whether it is stale. */
async function get(root) {
  const map = await require('./store').readJson(cacheFile(), null);
  if (!map?.nodes || map.version !== 1) return build(root);
  return { ...map, stale: map.fingerprint !== fingerprint(root) };
}

module.exports = { sourceFiles, scan, fingerprint, build, get };
