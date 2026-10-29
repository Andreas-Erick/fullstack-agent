// Code self-access: lets the agent browse and read its own source code (read-only).
const fsp = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const store = require('./store');
const { resolveInside, hasReservedPart, walk, toPosix, scoreText, queryTerms } = require('./files');
const codemap = require('./codemap');

const IGNORE = ['node_modules', '.git', 'dist', 'out', 'build', '.cache', 'coverage'];
const EXTS = ['.js', '.mjs', '.cjs', '.ts', '.json', '.html', '.css', '.md', '.txt', '.yml', '.yaml', '.py', '.sh', '.bat', '.ps1'];

async function root() {
  const s = await store.getSettings();
  return path.resolve(s.code.rootPath || app.getAppPath());
}

async function listFiles(dir = '') {
  const r = await root();
  const start = dir ? resolveInside(r, dir) : r;
  const files = await walk(start, { exts: EXTS, ignore: IGNORE, maxFiles: 2000 });
  return Promise.all(
    files.map(async (f) => {
      const st = await fsp.stat(f);
      return { path: toPosix(path.relative(r, f)), size: st.size };
    }),
  );
}

async function readFile(rel, startLine, endLine) {
  const r = await root();
  const full = resolveInside(r, rel);
  if (hasReservedPart(path.relative(r, full), IGNORE)) {
    throw new Error('That folder is excluded from code access.');
  }
  const text = await fsp.readFile(full, 'utf8');
  const lines = text.split(/\r?\n/);
  const s = Math.max(1, Number(startLine) || 1);
  const e = Math.min(lines.length, Number(endLine) || Math.min(lines.length, s + 799));
  const body = lines
    .slice(s - 1, e)
    .map((l, i) => `${String(s + i).padStart(4)}| ${l}`)
    .join('\n');
  return {
    path: toPosix(path.relative(r, full)),
    totalLines: lines.length,
    range: [s, e],
    content: body + (e < lines.length ? `\n…[${lines.length - e} more lines; request a later start_line]` : ''),
  };
}

async function search(query, limit = 15) {
  const r = await root();
  const terms = queryTerms(query);
  const files = await walk(r, { exts: EXTS, ignore: IGNORE, maxFiles: 2000 });
  const results = [];
  for (const f of files) {
    const text = await fsp.readFile(f, 'utf8').catch(() => '');
    const { score, snippet } = scoreText(text, terms, path.basename(f));
    if (score > 0) {
      const lineNo = text.slice(0, text.toLowerCase().indexOf(terms[0])).split('\n').length;
      results.push({ path: toPosix(path.relative(r, f)), score, line: lineNo, snippet });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Simple globs for code_grep's `path`: "main/*.js", "renderer/**/*.css", "chat" (substring).
function globMatcher(glob) {
  if (!glob) return () => true;
  if (!/[*?]/.test(glob)) return (p) => p.includes(glob);
  const body = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '(.*/)?')
    .replace(/\u0001/g, '.*');
  const re = new RegExp(`^${body}$`);
  return (p) => re.test(p);
}

/** Regular-expression search with line numbers and context: exact, unlike the ranked search(). */
async function grep(pattern, { glob = '', ignoreCase = false, context = 2, max = 60 } = {}) {
  let re;
  try {
    re = new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (err) {
    throw new Error(`Invalid regular expression: ${err.message}`);
  }
  const r = await root();
  const match = globMatcher(glob);
  const files = (await walk(r, { exts: EXTS, ignore: IGNORE, maxFiles: 3000 })).map((f) => ({ full: f, rel: toPosix(path.relative(r, f)) })).filter((f) => match(f.rel));
  const out = [];
  let total = 0;
  for (const f of files) {
    const lines = (await fsp.readFile(f.full, 'utf8').catch(() => '')).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      total++;
      if (out.length >= max) continue;
      const from = Math.max(0, i - context);
      const to = Math.min(lines.length - 1, i + context);
      out.push({ path: f.rel, line: i + 1, text: lines.slice(from, to + 1).map((l, k) => `${String(from + k + 1).padStart(4)}${from + k === i ? '>' : '|'} ${l.slice(0, 300)}`).join('\n') });
    }
  }
  return { matches: out, total, ...(total > out.length ? { note: `Showing ${out.length} of ${total}; narrow the pattern or the path.` } : {}) };
}

/** Symbols of one file (functions, classes, exports, IPC handlers, tools) with line numbers. */
async function outline(rel) {
  const r = await root();
  const full = resolveInside(r, rel);
  const text = await fsp.readFile(full, 'utf8');
  const file = toPosix(path.relative(r, full));
  return { path: file, lines: text.split('\n').length, symbols: codemap.outline(text, file).map((s) => `${String(s.line).padStart(5)}  ${s.kind} ${s.name}${s.detail || ''}`).join('\n') };
}

/** Architecture overview: modules (purpose, exports, size), IPC, tools by group, settings sections. */
async function map() {
  return codemap.map(await root());
}

// ---- Self-modification (writes are confined to the code root, never node_modules/.git/dist).
async function writable(rel) {
  const s = await store.getSettings();
  if (!s.code.allowSelfModify) throw new Error('Self-modification is disabled in Settings → Self-improvement.');
  const r = await root();
  if (r.includes('.asar')) throw new Error('Self-modification needs the app to run from source.');
  const full = resolveInside(r, rel);
  // Compared as the OS compares names: ".GIT/hooks" is .git/hooks on Windows (security review 2026-10-29).
  if (hasReservedPart(path.relative(r, full), IGNORE)) throw new Error('That location cannot be modified.');
  return { r, full };
}

async function writeFile(rel, content) {
  const { r, full } = await writable(rel);
  const existed = await fsp.access(full).then(() => true, () => false);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, String(content ?? ''), 'utf8');
  return { path: toPosix(path.relative(r, full)), created: !existed, bytes: Buffer.byteLength(String(content ?? '')) };
}

async function editFile(rel, oldString, newString, replaceAll = false) {
  const { r, full } = await writable(rel);
  const text = await fsp.readFile(full, 'utf8');
  if (!oldString) throw new Error('old_string must not be empty');
  const count = text.split(oldString).length - 1;
  if (count === 0) throw new Error('old_string was not found in the file. Read the file again and copy the exact text (including indentation).');
  if (count > 1 && !replaceAll) throw new Error(`old_string occurs ${count} times; add surrounding context to make it unique, or set replace_all.`);
  const next = replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString);
  await fsp.writeFile(full, next, 'utf8');
  return { path: toPosix(path.relative(r, full)), replacements: replaceAll ? count : 1 };
}

module.exports = { root, listFiles, readFile, search, grep, outline, map, writeFile, editFile };
