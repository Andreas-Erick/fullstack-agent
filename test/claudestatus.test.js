// The Claude sign-in check (main/claudecode.js status): it starts the CLI, so the title bar and
// multi-provider mode share a cached answer (10 min while signed in, 30 s otherwise); Settings' check,
// the wizard and diagnose ask { fresh: true }; an auth error in a turn clears it; one probe at a time.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { stub, load, tmpDir, quietLog } = require('./helpers');

const dir = tmpDir('nexus-claudestatus-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// A stand-in CLI: answers `auth status --json` and `--version`, and notes each call.
const script = path.join(dir, 'fake-claude.js');
const callLog = path.join(dir, 'calls.log');
fs.writeFileSync(script, `const fs = require('fs');
const args = process.argv.slice(2).join(' ');
fs.appendFileSync(${JSON.stringify(callLog)}, args + '\\n');
process.stdout.write(args === '--version' ? '2.1.0 (Claude Code)\\n' : JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', subscriptionType: 'max' }));
`);
const cli = path.join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
fs.writeFileSync(cli, process.platform === 'win32' ? `@"${process.execPath}" "${script}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
const ran = () => (fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : []);

let cliPath = cli;
stub({
  './store': { getSettings: async () => ({ claudeCode: { cliPath } }), dataDir: () => dir },
  './bridge': {},
  './github': {},
  './logger': quietLog,
  './approvals': { gate: async () => ({ allow: true }), markTainted: () => {} },
});
const claudecode = load('main/claudecode.js');

const signedIn = { installed: true, cli, version: '2.1.0', loggedIn: true, email: 'a@b.c' };
function counting(value) {
  const probe = async () => (probe.n++, { ...value });
  probe.n = 0;
  return probe;
}
// A probe that answers when released.
function held(value) {
  const probe = () => (probe.n++, new Promise((r) => (probe.release = () => r({ ...value }))));
  probe.n = 0;
  return probe;
}

test('asked once while fresh; fresh: true asks again; callers get their own copy', async () => {
  claudecode.invalidateStatus();
  const probe = counting(signedIn);
  const first = await claudecode.status({ probe });
  assert.strictEqual(first.email, 'a@b.c');
  first.email = 'changed by a caller';
  assert.strictEqual((await claudecode.status({ probe })).email, 'a@b.c');
  assert.strictEqual(probe.n, 1, 'the title bar and the router share one check');
  await claudecode.status({ probe, fresh: true });
  assert.strictEqual(probe.n, 2, 'Settings, the wizard and diagnose check for real');
});

test('signed out or not installed: checked again after 30 s; signed in: after 10 min', async (t) => {
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  t.after(() => (Date.now = realNow));

  claudecode.invalidateStatus();
  const out = counting({ installed: true, loggedIn: false });
  await claudecode.status({ probe: out });
  offset = 20000;
  await claudecode.status({ probe: out });
  assert.strictEqual(out.n, 1);
  offset = claudecode.STATUS_RETRY_MS + 1000;
  await claudecode.status({ probe: out });
  assert.strictEqual(out.n, 2, 'signing in shows quickly');

  claudecode.invalidateStatus();
  offset = 0;
  const signed = counting(signedIn);
  await claudecode.status({ probe: signed });
  offset = claudecode.STATUS_TTL_MS - 60000;
  await claudecode.status({ probe: signed });
  assert.strictEqual(signed.n, 1);
  offset = claudecode.STATUS_TTL_MS + 1000;
  await claudecode.status({ probe: signed });
  assert.strictEqual(signed.n, 2);
});

test('checks at the same time share one probe', async () => {
  claudecode.invalidateStatus();
  const probe = held(signedIn);
  const all = Promise.all([claudecode.status({ probe }), claudecode.status({ probe, fresh: true }), claudecode.status({ probe })]);
  probe.release();
  const results = await all;
  assert.strictEqual(probe.n, 1);
  assert.ok(results.every((r) => r.loggedIn));
  assert.notStrictEqual(results[0], results[1]);
});

test('invalidateStatus forces a probe, and a probe from before it is not kept', async () => {
  claudecode.invalidateStatus();
  const probe = counting(signedIn);
  await claudecode.status({ probe });
  claudecode.invalidateStatus();
  await claudecode.status({ probe });
  assert.strictEqual(probe.n, 2);

  // A check was running when the sign-in failed: the next one doesn't wait for it, and its answer is dropped.
  const old = held({ ...signedIn, email: 'before' });
  const first = claudecode.status({ probe: old, fresh: true });
  claudecode.invalidateStatus();
  const now = counting({ installed: true, loggedIn: false });
  assert.strictEqual((await claudecode.status({ probe: now })).loggedIn, false);
  old.release();
  assert.strictEqual((await first).email, 'before');
  assert.strictEqual((await claudecode.status({ probe: now })).loggedIn, false, 'the older answer was not cached');
  assert.strictEqual(now.n, 1);
});

test('a turn that fails on the sign-in clears the cached answer', async () => {
  const probe = counting(signedIn);
  const failTurn = (how) => {
    claudecode.invalidateStatus();
    return claudecode.status({ probe }).then(() => {
      const sess = new claudecode.Session('c1');
      sess.turn = { settled: false, text: '', emit() {}, reject: (e) => (sess.error = e) };
      how(sess);
      return sess;
    });
  };
  let sess = await failTurn((s) => s.onLine(JSON.stringify({ type: 'result', is_error: true, result: 'OAuth token has expired. Please run /login' })));
  assert.match(sess.error.message, /OAuth token has expired/);
  await claudecode.status({ probe });
  assert.strictEqual(probe.n, 2, 'checked again after the error result');

  sess = await failTurn((s) => ((s.stderr = 'Invalid API key · Please run /login'), s.onExit(1)));
  assert.match(sess.error.message, /Connect your Claude account/);
  await claudecode.status({ probe });
  assert.strictEqual(probe.n, 4, 'checked again after the process exited on it');

  // Any other failure keeps the answer.
  sess = await failTurn((s) => s.onLine(JSON.stringify({ type: 'result', is_error: true, result: 'Overloaded' })));
  await claudecode.status({ probe });
  assert.strictEqual(probe.n, 5);
});

test('the real check runs the CLI; --version again only when the CLI changed', async () => {
  claudecode.invalidateStatus();
  const st = await claudecode.status({ fresh: true });
  assert.deepStrictEqual(
    { installed: st.installed, loggedIn: st.loggedIn, version: st.version, email: st.email, subscription: st.subscription, authMethod: st.authMethod },
    { installed: true, loggedIn: true, version: '2.1.0 (Claude Code)', email: 'a@b.c', subscription: 'max', authMethod: 'claude.ai' },
  );
  assert.strictEqual((await claudecode.status({ fresh: true })).version, '2.1.0 (Claude Code)');
  assert.deepStrictEqual(ran(), ['auth status --json', '--version', 'auth status --json']);

  const later = new Date(Date.now() + 60000);
  fs.utimesSync(cli, later, later); // an update replaced the CLI
  await claudecode.status({ fresh: true });
  assert.deepStrictEqual(ran().slice(3), ['auth status --json', '--version']);

  cliPath = path.join(dir, 'missing');
  assert.deepStrictEqual(await claudecode.status({ fresh: true }), { installed: false });
  cliPath = cli;
});

// A check that failed (timed out, crashed, printed no JSON) is not "signed out": it showed as "no Claude
// account is connected" in Settings, the title bar, Health, Test connection, the wizard and setup.
const script2 = path.join(dir, 'fake-claude-2.js');
const modeFile = path.join(dir, 'mode.txt');
const traceFile = path.join(dir, 'trace.txt');
fs.writeFileSync(script2, `const fs = require('fs');
const args = process.argv.slice(2).join(' ');
if (args === '--version') process.stdout.write('2.1.0 (Claude Code)\\n');
else {
  const mode = fs.readFileSync(${JSON.stringify(modeFile)}, 'utf8').trim();
  if (mode === 'trace') (process.stderr.write(fs.readFileSync(${JSON.stringify(traceFile)}, 'utf8')), (process.exitCode = 1));
  else if (mode === 'signed-out-trace') (process.stdout.write('{"loggedIn":false}'), process.stderr.write(fs.readFileSync(${JSON.stringify(traceFile)}, 'utf8')), (process.exitCode = 1));
  else if (mode === 'signed-out') (process.stdout.write('{"loggedIn":false,"authMethod":"none"}'), (process.exitCode = 1));
  else if (mode === 'garbage') (process.stdout.write('not json'), (process.exitCode = 1));
  else if (mode === 'crash') (process.stderr.write('x'.repeat(10000)), (process.exitCode = 2));
  else if (mode === 'null') process.stdout.write('null');
  else if (mode === 'array') process.stdout.write('[]');
  else if (mode === 'number') process.stdout.write('42');
}
`);
const cli2 = path.join(dir, process.platform === 'win32' ? 'claude2.cmd' : 'claude2');
fs.writeFileSync(cli2, process.platform === 'win32' ? `@"${process.execPath}" "${script2}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script2}" "$@"\n`, { mode: 0o755 });

async function checkAs(mode, cliFile = cli2) {
  fs.writeFileSync(modeFile, mode);
  cliPath = cliFile;
  claudecode.invalidateStatus();
  return claudecode.status({ fresh: true });
}

test('a signed-out CLI (its JSON on exit 1) is checked and not connected: Connect stays right', async (t) => {
  t.after(() => (cliPath = cli));
  const st = await checkAs('signed-out');
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.checked, true);
  assert.strictEqual(st.loggedIn, false);
  assert.strictEqual(st.authMethod, 'none');
});

test('a check that crashed, printed no JSON or nothing says so instead of "not connected"', async (t) => {
  t.after(() => (cliPath = cli));
  for (const mode of ['garbage', 'crash', 'null', 'array', 'number', 'empty']) {
    const st = await checkAs(mode);
    assert.strictEqual(st.installed, true, mode);
    assert.strictEqual(st.checked, false, `${mode}: the check itself failed`);
    assert.strictEqual(st.loggedIn, false, mode);
    assert.strictEqual(st.email, null, mode);
    assert.ok(typeof st.error === 'string' && st.error.length >= 1 && st.error.length <= 300, `${mode}: error ${JSON.stringify(st.error).slice(0, 80)}`);
    assert.strictEqual(st.version, '2.1.0 (Claude Code)', mode);
  }
  assert.strictEqual((await checkAs('crash')).error, 'x'.repeat(300), 'the crash’s own words, cut to 300 characters');
  assert.strictEqual((await checkAs('garbage')).error, 'claude auth status gave no readable answer');
});

// The error reaches the screen, Health and (through Test connection) the log, which never holds the folders
// above the app: they name the user. A crash trace keeps its words and file names only.
test('a crash trace in the check’s error keeps file names, not the folders that name the user', async (t) => {
  t.after(() => (cliPath = cli));
  fs.writeFileSync(traceFile, [
    String.raw`C:\Users\Jane Doe\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js:42`,
    '    throw err;',
    '    ^',
    'Error: boom (see https://docs.example.com/claude/errors/x)',
    '    at Object.<anonymous> (/home/jane/.npm/claude-code/cli.js:1:2)',
    String.raw`    at load (file:///C:/Users/jane/AppData/x/loader.mjs:3:4)`,
    String.raw`spawn D:\Tools\jane's tools\claude.cmd ENOENT`,
  ].join('\n'));
  for (const mode of ['trace', 'signed-out-trace']) {
    const st = await checkAs(mode);
    assert.strictEqual(st.checked, mode === 'trace' ? false : true, mode);
    for (const name of ['Jane', 'jane', 'Users', 'AppData', 'home/', 'npm', 'Tools']) assert.ok(!st.error.includes(name), `${mode}: “${name}” in ${st.error}`);
    for (const kept of ['cli.js:42', 'throw err;', 'Error: boom', 'cli.js:1:2', 'loader.mjs:3:4', 'https://docs.example.com/claude/errors/x', 'ENOENT']) assert.ok(st.error.includes(kept), `${mode}: “${kept}” lost from ${st.error}`);
    assert.ok(st.error.length <= 300 || mode === 'signed-out-trace', mode);
  }
});

// A huge, path-heavy answer (drive paths with spaces, slashes without an end, runs with no separator) is
// cleaned in one pass: the patterns split into disjoint pieces, so nothing backtracks without end.
test('an oversized, path-heavy error is cleaned and cut without hanging', { timeout: 20000 }, async (t) => {
  t.after(() => (cliPath = cli));
  const piece = String.raw`C:\Users\Jane Doe\${'a'.repeat(60)} (/home/jane/${'b'.repeat(60)} C:\${'c '.repeat(30)}/ / x/`;
  fs.writeFileSync(traceFile, piece.repeat(3000) + 'x'.repeat(50000));
  const st = await checkAs('trace');
  assert.strictEqual(st.checked, false);
  assert.ok(st.error.length >= 1 && st.error.length <= 300, String(st.error.length));
  for (const name of ['Jane', 'jane', 'Users', 'home/']) assert.ok(!st.error.includes(name), `“${name}” in ${st.error.slice(0, 80)}`);
});

test('a CLI that can’t be started (the path a timeout takes too) is a failed check', async (t) => {
  t.after(() => (cliPath = cli));
  const st = await checkAs('signed-out', modeFile); // the file exists but isn't a program
  assert.strictEqual(st.installed, true);
  assert.strictEqual(st.checked, false);
  assert.strictEqual(st.loggedIn, false);
  assert.ok(st.error && st.error.length <= 300, String(st.error));
});

test('a failed check is asked again after 30 s, like a signed-out one', async (t) => {
  t.after(() => (cliPath = cli));
  claudecode.invalidateStatus();
  let n = 0;
  const probe = async () => (n++, { installed: true, checked: false, loggedIn: false, error: 'Claude Code did not respond in time' });
  await claudecode.status({ probe });
  await claudecode.status({ probe });
  assert.strictEqual(n, 1);
  const realNow = Date.now;
  Date.now = () => realNow() + claudecode.STATUS_RETRY_MS + 1000;
  t.after(() => (Date.now = realNow));
  await claudecode.status({ probe });
  assert.strictEqual(n, 2);
});
