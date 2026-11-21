// The diagnostic log's buffering (main/logger.js, audit #9): lines are written in batches, errors and
// reads flush at once, nothing is lost or reordered.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, stub, load, tmpDir } = require('./helpers');

const dir = tmpDir('nexus-log-');
stub({ electron: { app: { getPath: () => dir } } });
const log = load('main/logger.js');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const onDisk = () => (fs.existsSync(log.file()) ? fs.readFileSync(log.file(), 'utf8') : '');

test('info lines wait for the batch; an error writes everything at once, in order', () => {
  log.info('first', { n: 1 });
  log.info('second', { n: 2 });
  assert.doesNotMatch(onDisk(), /second/, 'buffered');
  log.error('third', new Error('boom'));
  const text = onDisk();
  assert.ok(text.indexOf('first') < text.indexOf('second') && text.indexOf('second') < text.indexOf('third'));
});

test('reading the log and flush() see every line logged so far', () => {
  log.info('fourth');
  assert.match(log.tail(10), /fourth/);
  log.info('fifth');
  log.flush();
  assert.match(onDisk(), /fifth/);
});

test('the batch is written on its own shortly after', async () => {
  log.info('sixth');
  await new Promise((r) => setTimeout(r, 400));
  assert.match(onDisk(), /sixth/);
});

test('every key format the app can hold is masked before it is written', () => {
  // Fake keys, put together at run time: written out whole, GitHub's secret scanning takes them for
  // real ones (it reported the Google and Tailscale ones). Each is a real prefix plus filler.
  const fill = (n) => 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'.slice(0, n);
  const keys = {
    anthropic: ['sk-ant-', 'api03-', fill(30)].join(''),
    openai: ['sk-', 'proj-', fill(32)].join(''),
    groq: ['gsk', '_', fill(40)].join(''),
    perplexity: ['pplx', '-', fill(40)].join(''),
    xai: ['xai', '-', fill(36)].join(''),
    openrouter: ['sk-or-', 'v1-', fill(36)].join(''),
    gemini: ['AI', 'za', 'Sy', fill(33)].join(''),
    github: ['gh', 'p_', fill(36)].join(''),
    tailscale: ['tskey', '-auth-', 'k', fill(12), '-', fill(26)].join(''),
    jwt: ['ey', 'J', fill(18), '.ey', 'J', fill(20), '.', fill(21)].join(''),
  };
  for (const [name, key] of Object.entries(keys)) {
    const out = log.redact(`failed with ${key} in it`);
    assert.ok(!out.includes(key.slice(-12)), `${name}: ${out}`);
  }
  assert.strictEqual(log.redact('mcp__claude_ai_Google_Calendar__list_events took 120 ms'), 'mcp__claude_ai_Google_Calendar__list_events took 120 ms', 'ordinary text stays');
});

// Regression: the marker was always INFO, so readers of warnings and errors (analyze_errors, Health,
// problem reports, the self-change check) counted a warning repeated 40 times once.
test('a repeated line is counted at its own level', () => {
  log.warn('disk nearly full', { free: 1 });
  log.warn('disk nearly full', { free: 1 });
  log.flush();
  const warnings = log.tail(50, '', { level: 'warn' });
  assert.match(warnings, /WARN {2}disk nearly full \{"free":1\}\n\S+ WARN {2}\(previous line repeated 1 more time\)$/);

  // Reading the log shows the repeats so far too, without a flush or a different line first.
  for (let i = 0; i < 40; i++) log.error('vault unreadable', { code: 'EBUSY' });
  const groups = require('../main/errorinsight').analyze(log.tail(2000, '', { level: 'warn' }));
  assert.strictEqual(groups.find((g) => g.event === 'vault unreadable').count, 40);
  assert.strictEqual(groups.find((g) => g.event === 'disk nearly full').count, 2);
});

// Regression: a folder with a space in it (the user's name, "Siren Assistant") broke the one-regex
// shortening: frames came out mangled and kept C:\Users\<name>.
test('stack frames are short real paths, never the user folder', () => {
  // The app's own files sit under its folder (this checkout's, here: a path with spaces in it).
  const own = (...parts) => path.join(ROOT, ...parts);
  const err = new Error('boom');
  err.stack = [
    'Error: boom',
    'with a second line of the message in C:\\Users\\Some One\\notes.txt',
    `    at runOpenAI (${own('main', 'llm.js')}:499:23)`,
    '    at process.processTicksAndRejections (node:internal/process/task_queues:95:5)',
    `    at async check (${own('main', 'innerworld.js')}:354:3)`,
    '    at Object.parse (C:\\Users\\Some One\\Siren\\node_modules\\lib\\index.js:9:9)',
    '    at C:\\Users\\Some One\\Downloads\\lib\\other.js:1:2',
    // Code made by new Function / eval (codemap.js): the caller's position is inside the frame.
    '    at eval (eval at load (C:\\Users\\Some One\\Desktop\\AI Assistant main\\x.js:1:2), <anonymous>:3:4)',
  ].join('\n');
  const { stack } = log.errorInfo(err);
  assert.strictEqual(stack, 'runOpenAI main/llm.js:499:23 | async check main/innerworld.js:354:3 | other.js:1:2 | eval (eval at load (x.js:1:2), <anonymous>:3:4)');
  assert.doesNotMatch(JSON.stringify(log.errorInfo(err)), /Users|Some One/);

  const more = new Error('x');
  more.stack = [
    'Error: x',
    `    at contextBridge (${own('preload.js')}:12:5)`,
    '    at send (app://bundle/renderer/js/chat.js:88:3)',
    `    at ${pathToFileURL(own('scripts', 'eval.js')).href}:7:1`,
    '    at Array.map (<anonymous>)',
    `    at ${own('main', 'tools', 'common.js').replace(/\\/g, '/')}:21:9`,
    // Outside the app, a user named after one of its folders ("test", "scripts") keeps no folder.
    '    at C:\\Users\\test\\Downloads\\lib\\helper.js:5:6',
    '    at eval (eval at <anonymous> (file:///home/scripts/x.js:2:3), <anonymous>:1:1)',
  ].join('\n');
  assert.strictEqual(log.errorInfo(more).stack, 'contextBridge preload.js:12:5 | send renderer/js/chat.js:88:3 | scripts/eval.js:7:1 | Array.map (<anonymous>) | main/tools/common.js:21:9 | helper.js:5:6');
  assert.match(log.errorInfo({ message: 'y', stack: more.stack.split('\n').slice(-1).join('\n') }).stack, /^eval \(eval at <anonymous> \(x\.js:2:3\), <anonymous>:1:1\)$/);

  // An installed copy: its folder, wherever it is, is the root of the short paths.
  const installed = 'C:\\Users\\Some One\\AppData\\Local\\Programs\\Siren Assistant\\resources\\app';
  assert.strictEqual(log.shortFile(`${installed}\\main\\innerworld.js`, installed), 'main/innerworld.js');
  assert.strictEqual(log.shortFile('c:/users/some one/appdata/local/programs/siren assistant/resources/app/preload.js', installed), 'preload.js', 'the drive and folders in any case');
  assert.strictEqual(log.shortFile(`${installed}-old\\main\\x.js`, installed), 'x.js', 'a neighbouring folder is outside the app');
});

// Regression: the crash handlers logged err.stack as a string: several physical lines (the level and turn
// filters dropped all but the first), the user's folders in them, and no code location for analyze_errors.
test('a crash is one line with short app paths and a code location', () => {
  log.flush();
  const start = fs.existsSync(log.file()) ? fs.statSync(log.file()).size : 0;
  const e = new Error('first line of the message\nsecond line of it');
  e.stack = [`Error: ${e.message}`, `    at onTick (${path.join(ROOT, 'main', 'journal.js')}:41:7)`, `    at listOnTimeout (${path.join(ROOT, 'main', 'helperapps.js')}:9:3)`].join('\n');
  log.error('uncaught exception', { error: e });
  log.flush();
  const added = fs.readFileSync(log.file()).subarray(start).toString('utf8');
  assert.strictEqual(added.trimEnd().split('\n').length, 1, added);
  const parent = path.dirname(ROOT);
  for (const p of [ROOT, parent, require('os').homedir()]) {
    assert.ok(!added.includes(p) && !added.includes(p.replace(/\\/g, '/')), `no ${p} in ${added}`);
  }
  const [group] = require('../main/errorinsight').analyze(added);
  assert.ok(group.locations.includes('main/journal.js:41'), JSON.stringify(group));
});

test('a detail with line breaks stays on its line', () => {
  log.flush();
  const start = fs.statSync(log.file()).size;
  log.info('setup complete', 'a\nb\r\nc');
  log.flush();
  const added = fs.readFileSync(log.file()).subarray(start).toString('utf8');
  assert.strictEqual(added.trimEnd().split('\n').length, 1, added);
  assert.match(added.trimEnd(), /setup complete a \| b \| c$/);
});

// The words of messages, replies and transcripts stay out of the INFO lines (DEBUG lines carry them only
// with Detailed logging on); the crash handlers log the Error itself.
test('the turn, reply and heard lines carry lengths, not words', () => {
  const lineOf = (rel, start) => fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').find((l) => l.includes(start));
  for (const [rel, start] of [
    ['main/llm.js', "log.info('turn', {"],
    ['main/turns.js', "log.info('reply', {"],
    ['renderer/js/voice.js', "logEvent('info', 'heard', {"],
  ]) {
    const line = lineOf(rel, start);
    assert.ok(line, `${rel}: ${start}`);
    assert.match(line, /\bchars:/, rel);
    assert.doesNotMatch(line, /\btext:/, rel);
  }
  const main = fs.readFileSync(path.join(ROOT, 'main/main.js'), 'utf8');
  assert.match(main, /process\.on\('uncaughtException', \(err\) => \(log\.error\('uncaught exception', \{ error: err/);
  assert.match(main, /process\.on\('unhandledRejection', \(err\) => \(log\.error\('unhandled rejection', \{ error: err/);
});
