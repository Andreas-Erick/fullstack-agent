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
