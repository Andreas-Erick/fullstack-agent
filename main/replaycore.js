// The pure part of the history replays (no git, no files): parsing a git log into commits with the
// files each one touched, naming what kind of commit it was, and laying the vault's notes out as a map
// the Architecture renderer (renderer/js/archdraw.js) can draw and replay. main/replay.js runs git and
// hands the output here; the Architecture view and the vault's Growth replay animate the result.
const archcore = require('./archcore');

const SELF = '[self-change]';
const MAX_COMMITS = 3000;
const MAX_FILES_PER_COMMIT = 400;

/**
 * Parses `git log --reverse --pretty=format:%H%x1f%ct%x1f%an%x1f%s` followed by --numstat lines
 * ("added<TAB>removed<TAB>path", "-" for binary) or --name-status lines ("A<TAB>path", "M<TAB>path",
 * "D<TAB>path", "R100<TAB>old<TAB>new"). Renamed paths are written as git prints them in numstat
 * ("{a => b}/c", "a => b"); the new name is kept and the old one is reported as removed.
 * Returns commits in the order given: { sha, at (ms), author, subject, kind, files: [{ path, status,
 * added, removed }] }, at most MAX_COMMITS, newest kept.
 */
function parseLog(text, { kinds = classifyApp } = {}) {
  const commits = [];
  let cur = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.includes('\x1f')) {
      const [sha, ts, author, ...rest] = line.split('\x1f');
      const subject = rest.join('\x1f').trim();
      cur = { sha, at: Number(ts) * 1000 || 0, author: author || '', subject, kind: kinds(subject, author), files: [] };
      commits.push(cur);
      continue;
    }
    if (!cur || cur.files.length >= MAX_FILES_PER_COMMIT) continue;
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const [a, b, c] = parts;
    if (/^\d+$/.test(a) || a === '-') {
      // numstat
      const path = b === '-' || /^\d+$/.test(b) ? parts.slice(2).join('\t') : b;
      const r = renamed(path);
      if (r.from) cur.files.push({ path: r.from, status: 'D', added: 0, removed: 0 });
      cur.files.push({ path: r.to, status: r.from ? 'R' : 'M', added: a === '-' ? 0 : Number(a), removed: b === '-' ? 0 : Number(b) });
    } else if (/^[AMDRCT]\d*$/.test(a)) {
      // name-status
      const status = a[0];
      if ((status === 'R' || status === 'C') && c) {
        if (status === 'R') cur.files.push({ path: b, status: 'D', added: 0, removed: 0 });
        cur.files.push({ path: c, status: status === 'R' ? 'R' : 'A', added: 0, removed: 0 });
      } else cur.files.push({ path: b, status: status === 'T' ? 'M' : status, added: 0, removed: 0 });
    }
  }
  return commits.length > MAX_COMMITS ? commits.slice(commits.length - MAX_COMMITS) : commits;
}

// "{src => lib}/a.js" → from src/a.js to lib/a.js; "a.js => b.js" → from a.js to b.js.
function renamed(path) {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
  if (brace) return { from: `${brace[1]}${brace[2]}${brace[4]}`.replace(/\/\//g, '/'), to: `${brace[1]}${brace[3]}${brace[4]}`.replace(/\/\//g, '/') };
  const arrow = /^(.+) => (.+)$/.exec(path);
  if (arrow) return { from: arrow[1], to: arrow[2] };
  return { from: null, to: path };
}

/** What kind of commit this was in the app's own repository (as the Evolution view names them). */
function classifyApp(subject) {
  if (subject.startsWith(SELF)) return 'self';
  if (/^Revert|^Restore/.test(subject)) return 'revert';
  if (/^Baseline/.test(subject)) return 'baseline';
  if (/^(Siren Assistant|Nexus Agent) \d+\.\d+/.test(subject)) return 'release';
  return 'manual';
}

/** What kind of commit this was in the vault's history. */
function classifyVault(subject, author) {
  if (/^Vault history started/.test(subject)) return 'baseline';
  return /Siren|Nexus/i.test(author || '') ? 'self' : 'manual';
}

/** The subject without the self-change marker, cut for a label. */
const cleanSubject = (s) => String(s || '').replace(SELF, '').trim().slice(0, 120);

/**
 * The vault's notes as a map for the Architecture renderer: one container ("Your vault"), a component
 * per folder (nested folders flattened to "Folder / Sub"), a file per note. `paths` are every note
 * ever seen in the history (so positions stay put while the replay runs); `lines` maps a path to its
 * size (lines) for the card's size, if known. Notes outside .md are left out, as is .obsidian.
 */
function vaultMap(paths, { lines = {}, links = {} } = {}) {
  const notes = [...new Set(paths)].filter((p) => /\.md$/i.test(p) && !/^\.obsidian\//.test(p) && !/(^|\/)\.trash\//.test(p)).sort();
  const nodes = [{ id: 'c:vault', level: 'container', kind: 'system', kindLabel: 'Vault', name: 'Your vault', tech: 'Markdown notes', about: 'Every note in the vault, folder by folder. Zoom in to open a folder; the replay shows when each note appeared.', tone: 'c1', row: 0, anchor: true, parent: null }];
  const folders = new Map();
  const TONES = ['c1', 'c2', 'c3', 'ok', 'warn'];
  for (const p of notes) {
    const parts = p.split('/');
    const folder = parts.length > 1 ? parts.slice(0, -1).join(' / ') : '';
    const key = folder || '(root)';
    if (!folders.has(key)) {
      const id = `k:vault/${folders.size}`;
      folders.set(key, id);
      nodes.push({ id, level: 'component', kind: 'component', kindLabel: 'Folder', name: folder || 'Notes at the root', about: folder ? `The folder ${folder}` : 'Notes kept at the top of the vault', tone: TONES[folders.size % TONES.length], parent: 'c:vault' });
    }
    nodes.push({ id: `f:${p}`, level: 'file', kind: 'file', kindLabel: 'Note', name: parts[parts.length - 1].replace(/\.md$/i, ''), path: p, about: '', lines: Math.max(0, Number(lines[p]) || 0), symbols: [], tone: nodes.find((n) => n.id === folders.get(key)).tone, parent: folders.get(key) });
  }
  const bounds = nodes.length > 1 ? archcore.layout({ nodes }) : { x: 0, y: 0, w: 1800, h: 1000 };
  for (const n of nodes) {
    delete n.ox;
    delete n.oy;
  }
  // [[wikilinks]] between the notes on the map (linkindex.js; only notes that exist now link).
  const edges = require('./linkcore').edges(links, new Set(notes));
  const stats = { containers: 1, components: folders.size, files: notes.length, lines: notes.reduce((s, p) => s + (Number(lines[p]) || 0), 0), connections: edges.length, undescribed: [] };
  return { version: 1, nodes, edges, bounds, principles: [], stats, sizes: { fileHead: 84, symRow: 19, maxRows: 16 }, nouns: { container: 'folder', component: 'folder', file: 'note' } };
}

/** Every path a history ever touched, and each path's final line count (numstat sums). */
function pathsOf(commits) {
  const lines = {};
  for (const c of commits) for (const f of c.files) lines[f.path] = Math.max(0, (lines[f.path] || 0) + (f.added || 0) - (f.removed || 0));
  return { paths: Object.keys(lines), lines };
}

module.exports = { parseLog, classifyApp, classifyVault, cleanSubject, vaultMap, pathsOf, renamed, MAX_COMMITS };
