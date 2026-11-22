// Static knowledge of this codebase, without running it: symbols per file, the IPC surface, the tool
// list, imports and exports. Used by the agent (code_outline, code_map) and by scripts/verify.js,
// which turns the cross-file rules from docs/agents/MAP.md into checks. Plain Node, no Electron: it takes the
// code root as an argument so scripts can use it too.
const fs = require('fs');
const path = require('path');

const read = (root, rel) => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8');
  } catch {
    return '';
  }
};

// Every JavaScript source file of the app (not node_modules, build output or the Android app).
function jsFiles(root) {
  const out = ['preload.js'];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (e.name.endsWith('.js')) out.push(rel);
    }
  };
  ['main', 'renderer/js', 'renderer/remote', 'renderer/faces', 'scripts', 'test'].forEach(walk);
  return out.filter((f) => fs.existsSync(path.join(root, f)));
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'with']);
// The phone client (renderer/remote) is ES modules too, all but its service worker (a classic script).
const isModule = (rel) => rel.startsWith('renderer/js/') || (rel.startsWith('renderer/remote/') && rel.endsWith('.js') && rel !== 'renderer/remote/sw.js');
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// main/tools.js and its groups (main/tools/<group>.js) define the agent's tools.
const isToolFile = (rel) => rel === 'main/tools.js' || rel.startsWith('main/tools/');

// ------------------------------------------------------------ symbols
/** Functions, classes, exports, IPC handlers and tools in one file, with line numbers. */
function outline(text, rel = '') {
  const items = [];
  const add = (kind, name, index, extra = '') => items.push({ kind, name, line: lineOf(text, index), ...(extra ? { detail: extra } : {}) });
  const rx = [
    [/^(export\s+)?(async\s+)?function\s*\*?\s*(\w+)\s*\(([^)]*)\)/gm, (m) => add(m[1] ? 'export function' : 'function', m[3], m.index, `(${m[4].replace(/\s+/g, ' ').trim()})`)],
    [/^(export\s+)?class\s+(\w+)/gm, (m) => add(m[1] ? 'export class' : 'class', m[2], m.index)],
    [/^(export\s+)?const\s+(\w+)\s*=\s*(async\s*)?(\([^)]*\)|\w+)\s*=>/gm, (m) => add(m[1] ? 'export function' : 'function', m[2], m.index)],
    [/^(export\s+)?(const|let)\s+([A-Z][A-Z0-9_]*)\s*=/gm, (m) => add(m[1] ? 'export const' : 'const', m[3], m.index)],
    [/^ {2}(?:async\s+|static\s+)?(\w+)\s*\(([^)]*)\)\s*\{\s*$/gm, (m) => !KEYWORDS.has(m[1]) && add('method', m[1], m.index, `(${m[2].trim()})`)],
    [/\bhandle\('([\w-]+:[\w-]+)'/g, (m) => add('ipc', m[1], m.index)],
    [/^\s{4}name: '(\w+)',\s*$/gm, (m) => isToolFile(rel) && add('tool', m[1], m.index)],
  ];
  for (const [re, fn] of rx) for (const m of text.matchAll(re)) fn(m);
  return items.sort((a, b) => a.line - b.line);
}

// ------------------------------------------------------------ exports and imports
function topLevelSplit(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('{[('.includes(ch)) depth++;
    if ('}])'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) (parts.push(cur), (cur = ''));
    else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function braceBlock(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return text.slice(start + 1, i);
  }
  return null;
}

/** Names a file exports; null when they can't be read statically (e.g. a spread or a function). */
function exportsOf(text, rel) {
  if (isModule(rel) || rel.endsWith('.mjs')) {
    const names = new Set();
    for (const m of text.matchAll(/^export\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var)\s+([\w$]+)/gm)) names.add(m[1]);
    for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) for (const p of m[1].split(',')) p.trim() && names.add(p.trim().split(/\s+as\s+/).pop());
    if (/^export\s+default\b/m.test(text)) names.add('default');
    return names;
  }
  const m = /^module\.exports\s*=\s*\{/m.exec(text);
  if (!m) return null;
  const body = braceBlock(text, m.index + m[0].length - 1);
  if (body == null) return null;
  const names = new Set();
  for (const part of topLevelSplit(body.replace(/\/\/.*$/gm, ''))) {
    if (part.startsWith('...')) return null;
    const key = /^(?:async\s+)?(\w+)/.exec(part);
    if (key) names.add(key[1]);
  }
  for (const x of text.matchAll(/^module\.exports\.(\w+)\s*=/gm)) names.add(x[1]);
  return names;
}

// True when `index` is not code: inside a "…" or `…` string on its line (e.g. code quoted in a test)
// or after a // comment.
function insideString(text, index) {
  const before = text.slice(text.lastIndexOf('\n', index) + 1, index).replace(/\\./g, '');
  if (/^\s*(\/\/|\*)/.test(before)) return true;
  return (before.split('"').length - 1) % 2 === 1 || (before.split('`').length - 1) % 2 === 1;
}

function resolveRelative(root, fromRel, spec) {
  // The phone client loads the desktop's shared modules by URL: /js/… is served from renderer/js/ (companion.js STATIC).
  const served = fromRel.startsWith('renderer/remote/') && spec.startsWith('./js/');
  const base = served ? path.posix.join('renderer', spec) : path.posix.join(path.posix.dirname(fromRel), spec);
  for (const cand of [base, `${base}.js`, `${base}/index.js`]) if (fs.existsSync(path.join(root, cand)) && fs.statSync(path.join(root, cand)).isFile()) return cand;
  return null;
}

/** Relative imports/requires of one file: [{ spec, target, names, line }] (target null = missing). */
function importsOf(root, rel, text) {
  const out = [];
  if (isModule(rel)) {
    for (const m of text.matchAll(/^import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?(?:\s*\*\s+as\s+\w+)?\s*from\s*'(\.[^']+)'/gm)) {
      const names = (m[2] || '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      if (m[1]) names.push('default');
      out.push({ spec: m[3], target: resolveRelative(root, rel, m[3]), names, line: lineOf(text, m.index) });
    }
    // Dynamic imports with a literal path: `(await import('./x.js')).member` must find `member` too.
    for (const m of text.matchAll(/\bimport\(\s*'(\.[^']+)'\s*\)(?:\)\.([\w$]+))?/g)) {
      if (insideString(text, m.index)) continue;
      out.push({ spec: m[1], target: resolveRelative(root, rel, m[1]), names: m[2] ? [m[2]] : [], line: lineOf(text, m.index) });
    }
  } else {
    for (const m of text.matchAll(/(?:const\s+\{([^}]*)\}\s*=\s*)?require\('(\.[^']+)'\)(?:\.(\w+))?/g)) {
      if (insideString(text, m.index)) continue;
      // require('./x').member(...): only `member` must exist; destructuring then applies to its result.
      const names = m[3] ? [m[3]] : m[1] ? m[1].split(',').map((s) => s.trim().split(/\s*:\s*/)[0]).filter(Boolean) : [];
      out.push({ spec: m[2], target: resolveRelative(root, rel, m[2]), names, line: lineOf(text, m.index) });
    }
  }
  return out;
}

// ------------------------------------------------------------ app-specific surfaces
/** IPC: handlers registered in main.js and the channels preload.js exposes. */
function ipc(root) {
  const handlers = new Set();
  for (const f of jsFiles(root).filter((x) => x.startsWith('main/'))) for (const m of read(root, f).matchAll(/\bhandle\('([\w-]+:[\w-]+)'/g)) handlers.add(m[1]);
  const pre = read(root, 'preload.js');
  const block = /const channels = \{([\s\S]*?)\n\};/.exec(pre);
  const exposed = new Set();
  if (block) for (const m of block[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) for (const x of m[2].matchAll(/'(\w+)'/g)) exposed.add(`${m[1]}:${x[1]}`);
  return { handlers: [...handlers].sort(), exposed: [...exposed].sort(), notExposed: [...handlers].filter((h) => !exposed.has(h)).sort(), noHandler: [...exposed].filter((c) => !handlers.has(c)).sort() };
}

/** Agent tools (main/tools.js and the groups in main/tools/) and which have a label in the chat
 *  (TOOL_LABELS in renderer/js/chatcore.js, shared by the desktop and the phone). */
function toolsInfo(root) {
  const text = jsFiles(root).filter(isToolFile).map((f) => read(root, f)).join('\n');
  const tools = [...text.matchAll(/^\s{4}name: '(\w+)',\s*\n\s{4}group: '(\w+)'/gm)].map((m) => ({ name: m[1], group: m[2] }));
  const chat = read(root, 'renderer/js/chatcore.js');
  const block = /const TOOL_LABELS = \{([\s\S]*?)\n\};/.exec(chat);
  const labels = new Set(block ? [...block[1].matchAll(/^\s*'?(\w+)'?\s*:/gm)].map((m) => m[1]) : []);
  return { tools, unlabeled: tools.filter((t) => t.group !== 'setup' && !labels.has(t.name)).map((t) => t.name) };
}

/** The DEFAULTS object of main/store.js, or null. Only its keys matter here, so names it refers to
 *  (constants like brand.MASTER_PROMPT) evaluate to a placeholder instead of being looked up. */
function settingsDefaults(root) {
  const text = read(root, 'main/store.js');
  const m = /^const DEFAULTS = \{/m.exec(text);
  if (!m) return null;
  const body = braceBlock(text, m.index + m[0].length - 1);
  // A value for any name, whose properties are that value again (brand.THEME.name…); not an object, so
  // its "keys" never count as settings.
  const nothing = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : nothing) });
  // braintable is the real (pure) brain table: the brains' own sections come from its rows.
  let braintable = nothing;
  try {
    braintable = require(path.join(root, 'renderer/js/braintable.mjs'));
  } catch {} // no brain table (an older checkout): its sections read as unknown, never as an error
  const anyName = new Proxy({}, { has: () => true, get: (_t, k) => (k === Symbol.unscopables ? undefined : k === 'braintable' ? braintable : nothing) });
  try {
    return new Function('scope', `with (scope) { return {${body}}; }`)(anyName);
  } catch {
    return null;
  }
}

const hasPath = (obj, dotted) => dotted.split('.').reduce((o, k) => (o && typeof o === 'object' && k in o ? o[k] : undefined), obj) !== undefined;

/** A compact architecture overview for the agent. */
function map(root) {
  const files = jsFiles(root).filter((f) => !f.startsWith('test/'));
  const modules = files.map((rel) => {
    const text = read(root, rel);
    const head = (text.match(/^\/\/ (.+)/) || [])[1] || '';
    const ex = exportsOf(text, rel);
    return { file: rel, lines: text.split('\n').length, about: head.slice(0, 140), exports: ex ? [...ex] : undefined };
  });
  const i = ipc(root);
  const t = toolsInfo(root);
  const defaults = settingsDefaults(root);
  const groups = {};
  for (const x of t.tools) (groups[x.group] ||= []).push(x.name);
  return {
    modules,
    ipc: { channels: i.handlers.length, byNamespace: i.handlers.reduce((a, h) => ((a[h.split(':')[0]] = (a[h.split(':')[0]] || 0) + 1), a), {}) },
    tools: groups,
    settingsSections: defaults ? Object.keys(defaults) : [],
    docs: ['docs/agents/MAP.md', 'docs/ENGINEERING.md', 'docs/adr', 'TROUBLESHOOTING.md', 'PRIVACY.md', 'CHANGELOG.md'].filter((d) => fs.existsSync(path.join(root, d))),
  };
}

// Silent catches: a promise `.catch` that drops the error (`() => {}`, `null`, `undefined`, `false`)
// or an empty `catch {}` block, with no comment saying why (docs/ENGINEERING.md §2). A comment after it
// on the same line, or inside the block, is the reason; one in front of it on the line means the code
// itself is commented out or quoted in a comment.
const SILENT_PROMISE = /\.catch\(\s*(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*(?:\{\s*\}|null|undefined|false)\s*\)/g;
const SILENT_BLOCK = /(?<![.\w$])catch\s*(?:\(\s*[\w$]*\s*\))?\s*\{\s*\}/g;

function silentCatches(text) {
  const out = [];
  const lineStart = (i) => text.lastIndexOf('\n', i - 1) + 1;
  const lineEnd = (i) => (text.indexOf('\n', i) + 1 || text.length + 1) - 1;
  for (const re of [SILENT_PROMISE, SILENT_BLOCK]) {
    for (const m of text.matchAll(re)) {
      const end = m.index + m[0].length;
      if (/\/\/|\/\*/.test(text.slice(lineStart(m.index), m.index))) continue;
      if (/\/\/|\/\*/.test(text.slice(end, lineEnd(end)))) continue;
      out.push({ line: lineOf(text, m.index), code: m[0].replace(/\s+/g, ' ') });
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

module.exports = { jsFiles, isModule, outline, exportsOf, importsOf, ipc, toolsInfo, settingsDefaults, hasPath, map, silentCatches };
