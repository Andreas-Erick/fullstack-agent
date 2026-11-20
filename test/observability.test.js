// Round 4 observability: the breadcrumb trail on error lines (logger.js), read back by errorinsight.js and
// shown as "Just before" in a problem report (issuecore.js); file-system failures in words (plainerror.js);
// one error trap for every window with the preload (util.js installErrorTrap).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir } = require('./helpers');

const dir = tmpDir('nexus-obs-');
stub({ electron: { app: { getPath: () => dir } } });
const log = load('main/logger.js');
const insight = load('main/errorinsight.js');
const issuecore = load('main/issuecore.js');
const { plainIpcError } = load('main/plainerror.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const lastLine = () => log.tail(1);
const detailOf = (line) => JSON.parse(line.slice(line.indexOf(' {') + 1));

test('an error line carries the names of the lines before it, never their details', () => {
  log.info('tool', { name: 'vault_read_note', input: 'my secret diary' });
  log.warn('tool failed', { name: 'web_fetch' });
  log.error('turn failed', new Error('boom'));
  const d = detailOf(lastLine());
  assert.strictEqual(d.message, 'boom');
  assert.match(d.trail, /-\d+\.\ds I tool · -\d+\.\ds W tool failed$/);
  assert.doesNotMatch(d.trail, /diary|vault_read_note|web_fetch/, 'details stay out');
});

test('inside a turn the trail is that turn only', async () => {
  log.info('unrelated');
  await log.withContext({ turn: 'abc123' }, async () => {
    log.info('turn');
    log.info('reply');
    log.error('turn failed', { error: new Error('x') });
  });
  const d = detailOf(lastLine());
  assert.match(d.trail, /I turn · .*I reply$/);
  assert.doesNotMatch(d.trail, /unrelated/);
});

test('a plain-text detail stays as it is; an empty one becomes the trail alone; repeats add nothing', () => {
  log.info('before');
  log.error('plain', 'just words');
  assert.match(lastLine(), / plain just words$/);
  log.error('bare');
  assert.match(detailOf(lastLine()).trail, /E plain$/);
  for (let i = 0; i < 5; i++) log.info('spam');
  log.error('after spam', {});
  const t = detailOf(log.tail(5).split('\n').filter((l) => / after spam /.test(l)).pop()).trail;
  assert.strictEqual((t.match(/spam/g) || []).length, 1, 'a repeated line is one breadcrumb');
});

test('the trail keeps at most ten names and is masked like the rest', () => {
  for (let i = 0; i < 30; i++) log.info(`step ${i}`);
  log.info(`key sk-${'a1'.repeat(20)}`);
  log.error('many', {});
  const t = detailOf(lastLine()).trail;
  assert.strictEqual(t.split(' · ').length, 10);
  assert.ok(!t.includes(`sk-${'a1'.repeat(20)}`), 'the key is masked');
});

test('errorinsight reads the trail and a group keeps the latest one', () => {
  const t0 = new Date().toISOString();
  const row = (trail) => `${t0} ERROR turn failed ${JSON.stringify({ error: { message: 'boom', stack: 'f main/llm.js:10:2' }, trail })}`;
  const p = insight.parseLine(row('-1.0s I tool'));
  assert.strictEqual(p.trail, '-1.0s I tool');
  assert.strictEqual(insight.parseLine(`${t0} ERROR x {"trail":5}`).trail, '', 'only a string counts');
  const [g] = insight.analyze(`${row('-2.0s I old')}\n${row('-1.0s I new')}`, { now: Date.now() + 1000 });
  assert.strictEqual(g.count, 2);
  assert.strictEqual(g.trail, '-1.0s I new');
});

test('a problem report lists what came just before, and hides any name that is not plain words', () => {
  const base = { event: 'turn failed', message: 'boom', count: 1, locations: [] };
  const r = issuecore.report({ ...base, trail: '-4.2s I tool · -1.1s W tool failed · -0.5s I <script>alert(1)</script> · -0.2s I C:\\Users\\Anna\\x' }, {}, { user: 'Anna' });
  assert.match(r.body, /### Just before \(event names only\)/);
  assert.match(r.body, /- 4\.2 s before · I · `tool`/);
  assert.match(r.body, /- 1\.1 s before · W · `tool failed`/);
  assert.doesNotMatch(r.body, /script|alert|Anna/);
  assert.strictEqual((r.body.match(/\(other\)/g) || []).length, 2);
  for (const trail of [undefined, '', 'garbage', '·  · ', 42, '-x s I y']) assert.doesNotMatch(issuecore.report({ ...base, trail }).body, /Just before/, String(trail));
  const long = Array.from({ length: 30 }, (_, i) => `-${i}.0s I e${i}`).join(' · ');
  assert.strictEqual((issuecore.report({ ...base, trail: long }).body.match(/ s before /g) || []).length, 10);
});

test('a file-system failure reaches the window in words, naming only the file', () => {
  const fsErr = (code, p) => Object.assign(new Error(`${code}: oops, open '${p}'`), { code, path: p });
  assert.strictEqual(plainIpcError(fsErr('EBUSY', 'C:\\Users\\Anna\\Vault\\Notes\\Plan.md')), '“Plan.md” is in use by another app (close it there and try again).');
  assert.match(plainIpcError(fsErr('ENOENT', '/home/anna/x.md')), /^“x\.md” isn't there any more\.$/);
  for (const code of ['EACCES', 'EPERM', 'ENOSPC', 'EMFILE']) assert.doesNotMatch(plainIpcError(fsErr(code, 'C:\\Users\\Anna\\a.txt')), /Anna|Users|EACCES|EPERM/);
  // Not a file-system failure, or no path to name: the message as it was.
  assert.strictEqual(plainIpcError(new Error('Close Obsidian first.')), 'Close Obsidian first.');
  assert.strictEqual(plainIpcError(Object.assign(new Error('m'), { code: 'ENOENT' })), 'm');
  assert.strictEqual(plainIpcError(Object.assign(new Error('m'), { code: 'ENOENT', path: '' })), 'm');
  assert.strictEqual(plainIpcError(Object.assign(new Error('m'), { code: '__proto__', path: '/a' })), 'm');
  assert.strictEqual(plainIpcError(Object.assign(new Error('m'), { code: 'toString', path: '/a' })), 'm');
  assert.strictEqual(plainIpcError('text'), 'text');
  assert.strictEqual(plainIpcError(null), 'null');
});

test('every window with the preload installs the one error trap, which logs the error as an object', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const util = read('renderer/js/util.js');
  assert.match(util, /logEvent\('error', `ui \$\{kind\}`, \{ error: stack \? \{ message, stack \} : \{ message \} \}\)/);
  for (const f of ['renderer/js/app.js', 'renderer/js/viewer.js', 'renderer/js/agentwindow.js']) {
    const src = read(f);
    assert.match(src, /^installErrorTrap\(\);/m, `${f} installs the trap`);
    assert.doesNotMatch(src, /addEventListener\('unhandledrejection'/, `${f} has no trap of its own`);
  }
  // The console copy of an uncaught error isn't logged a second time (main.js captureConsole).
  assert.match(read('main/main.js'), /if \(e\.level !== 'error' \|\| \/\^Uncaught\\b\/\.test\(String\(e\.message\)\)\) return;/);
});
