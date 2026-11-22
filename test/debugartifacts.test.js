// A sweep for debugging leftovers over a fixed, historical range of commits: from 2.7.24 (BASE) to 2.7.25
// (END), a release that changed main/ and renderer/js across many modules at once. Its added lines there must
// carry no console.* call, no TODO/FIXME/XXX/HACK marker, no commented-out code and no environment variable
// the code didn't read before. Later changes are judged by their own tests; the range is fixed so this file
// never fails on new work. Skipped in a checkout without those commits (a shallow clone).
const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const { ROOT } = require('./helpers');

const BASE = '6336559'; // 2.7.24
const END = 'cdc54c9'; // 2.7.25

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}
// Kept on purpose: app.js's startup fallback (in 2.7.24) and startFailed's console.error (the launch check
// fails on console errors).
const CONSOLE_OK = new Set(['renderer/js/app.js\tconsole.error(err);', 'renderer/js/app.js\tconsole.error(`${name} couldn’t start`, err);']);
// A comment line that is a statement: an assignment, a call, a declaration or a brace.
const CODE_COMMENT = /^\s*\/\/\s*(?:(?:const|let|var|return|await|throw|import|export|if|for|while|switch|function|class)\b.*[;{}]|[\w$.[\]'"]+\s*\(.*\)\s*;|[\w$.[\]'"]+\s*[-+*/]?=\s*[^=>].*;|\}\s*(?:else\b.*)?\{?)\s*$/;

// The added lines of a unified diff (-U0) that leave a debugging artifact; `known(name)` says whether an
// environment variable was read before BASE.
function artifacts(diff, known) {
  const hits = [];
  const envNames = new Map(); // name -> where it was first added
  let file = '';
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!raw.startsWith('+') || !/\.(c|m)?js$/.test(file)) continue;
    const text = raw.slice(1);
    const where = `${file}:${line}: ${text.trim().slice(0, 160)}`;
    line++;
    if (/\bconsole\.(log|warn|error|info|debug|trace|dir|table)\s*\(/.test(text) && !CONSOLE_OK.has(`${file}\t${text.trim()}`)) hits.push(`console: ${where}`);
    if (/\b(TODO|FIXME|XXX|HACK)\b/.test(text)) hits.push(`marker: ${where}`);
    if (CODE_COMMENT.test(text) || /\/\*\s*(?:const|let|var|return|await)\b[^*]*;\s*\*\//.test(text)) hits.push(`commented-out code: ${where}`);
    for (const m of text.matchAll(/process\.env(?:\.([A-Za-z_]\w*)|\[\s*['"`]([^'"`]+)['"`]\s*\])|['"`]((?:NEXUS|SIREN)_[A-Z0-9_]+)['"`]/g)) {
      const name = m[1] || m[2] || m[3];
      if (!envNames.has(name)) envNames.set(name, where);
    }
  }
  for (const [name, where] of envNames) if (!known(name)) hits.push(`new environment knob ${name}: ${where}`);
  return hits;
}

test('the artifact scanner finds what it looks for (and leaves prose comments alone)', () => {
  const c = 'console';
  const diff = [
    '+++ b/main/x.js',
    '@@ -1,0 +10,9 @@',
    `+  ${c}.log('debugging');`,
    `+  // ${'TO'}${'DO'}: later`,
    '+  // const old = compute(a);',
    '+  // await, so the latest render’s cards are the ones it points to.',
    '+  // { run({ routine }) → Promise<{ ok }>, notify(event) };',
    '+  const port = process.env.NEXUS_TEST_PORT || 0;',
    '+  const home = process.env.HOME;',
    '+++ b/renderer/js/app.js',
    '@@ -1,0 +5,1 @@',
    `+  ${c}.error(err);`,
  ].join('\n');
  const hits = artifacts(diff, (name) => name === 'HOME');
  assert.deepStrictEqual(hits.map((h) => h.split(':')[0]), ['console', 'marker', 'commented-out code', 'new environment knob NEXUS_TEST_PORT']);
  assert.match(hits[0], /^console: main\/x\.js:10: /, 'with the file and the line');
});

test('2.7.24 → 2.7.25 adds no console.*, marker, commented-out code or environment knob in main/ or renderer/js', (t) => {
  try {
    git(['cat-file', '-e', `${BASE}^{commit}`]);
    git(['cat-file', '-e', `${END}^{commit}`]);
  } catch {
    return t.skip(`${BASE} or ${END} is not in this checkout`);
  }
  const diff = git(['-c', 'core.quotepath=off', 'diff', '-U0', '--no-color', '--no-ext-diff', BASE, END, '--', 'main', 'renderer/js']);
  assert.ok(diff.includes('+++ b/main/'), 'the range changed main/');
  const known = (name) => {
    try {
      git(['grep', '-q', '-F', name, BASE, '--', '.']);
      return true;
    } catch {
      return false;
    }
  };
  assert.deepStrictEqual(artifacts(diff, known), []);
});
