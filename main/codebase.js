// Code self-access: lets the agent browse and read its own source code (read-only).
const fsp = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const store = require('./store');
const { resolveInside, walk, toPosix, scoreText, queryTerms } = require('./files');

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
  if (path.relative(r, full).split(path.sep).some((part) => IGNORE.includes(part))) {
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

// ---- Self-modification (writes are confined to the code root, never node_modules/.git/dist).
async function writable(rel) {
  const s = await store.getSettings();
  if (!s.code.allowSelfModify) throw new Error('Self-modification is disabled in Settings → Self-improvement.');
  const r = await root();
  if (r.includes('.asar')) throw new Error('Self-modification needs the app to run from source.');
  const full = resolveInside(r, rel);
  if (path.relative(r, full).split(path.sep).some((part) => IGNORE.includes(part) || part === '.git')) throw new Error('That location cannot be modified.');
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

module.exports = { root, listFiles, readFile, search, writeFile, editFile };
