// Routines (main/routinecore.js): odd schedules from the user or the agent, the app closed over a run,
// a laptop asleep for days, clock changes, and when a missed run still happens or is skipped.
const test = require('node:test');
const assert = require('node:assert');
const core = require('../main/routinecore');

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const routine = (schedule, extra = {}) => core.normalize({ name: 'R', instructions: 'Do it', schedule, ...extra }, { newId: (p) => `${p}1`, now: at(2026, 10, 1).getTime() });

test('schedules people (or the agent) write oddly are cleaned or refused with a reason', () => {
  assert.deepStrictEqual(core.normalizeSchedule({ kind: 'DAILY', time: ' 8:05 ' }), { kind: 'daily', time: '08:05' });
  assert.deepStrictEqual(core.normalizeSchedule({ kind: 'weekly', time: '19:00', days: [6, '0', 6, 9, -1, 1.5] }), { kind: 'weekly', time: '19:00', days: [0, 6] });
  assert.deepStrictEqual(core.normalizeSchedule({ kind: 'weekly', time: '07:30', days: 3 }), { kind: 'weekly', time: '07:30', days: [3] });
  assert.deepStrictEqual(core.normalizeSchedule({ kind: 'interval', hours: '2.4' }), { kind: 'interval', hours: 2 });
  for (const bad of [{}, { kind: 'monthly', time: '08:00' }, { kind: 'daily' }, { kind: 'daily', time: '24:00' }, { kind: 'daily', time: '8:60' }, { kind: 'daily', time: '8am' }, { kind: 'weekly', time: '08:00', days: [] }, { kind: 'weekly', time: '08:00', days: [7, 'x'] }, { kind: 'interval', hours: 0 }, { kind: 'interval', hours: 169 }, { kind: 'interval', hours: 'often' }, { kind: 'interval', hours: Infinity }])
    assert.throws(() => core.normalizeSchedule(bad), /must|needs/, JSON.stringify(bad));
  assert.throws(() => core.normalizeSchedule(), /kind/);
});

test('names and instructions: trimmed, capped, never empty', () => {
  const r = core.normalize({ name: `  ${'x'.repeat(200)}\n\t `, instructions: 'y'.repeat(9000), schedule: { kind: 'daily', time: '08:00' } }, { newId: () => 'id' });
  assert.strictEqual(r.name.length, 60);
  assert.strictEqual(r.instructions.length, 4000);
  assert.throws(() => core.normalize({ name: '   ', instructions: 'x', schedule: { kind: 'daily', time: '08:00' } }, { newId: () => 'id' }), /name/);
  assert.throws(() => core.normalize({ name: 'x', instructions: ' \n ', schedule: { kind: 'daily', time: '08:00' } }, { newId: () => 'id' }), /instructions/);
});

test('next run: weekdays skip the weekend, weekly finds the next chosen day, all strictly after', () => {
  const fri = at(2026, 10, 30, 9); // a Friday after 8:00
  assert.deepStrictEqual(core.nextRun({ kind: 'weekdays', time: '08:00' }, fri), at(2026, 11, 2, 8));
  assert.deepStrictEqual(core.nextRun({ kind: 'daily', time: '08:00' }, at(2026, 10, 30, 8)), at(2026, 10, 31, 8), 'exactly at the time: the next one');
  assert.deepStrictEqual(core.nextRun({ kind: 'weekly', time: '19:00', days: [0] }, at(2026, 11, 1, 19, 1)), at(2026, 11, 8, 19));
  assert.deepStrictEqual(core.nextRun({ kind: 'interval', hours: 3 }, at(2026, 10, 30, 23)), at(2026, 10, 31, 2));
  // Month and year ends.
  assert.deepStrictEqual(core.nextRun({ kind: 'daily', time: '00:00' }, at(2026, 12, 31, 12)), at(2027, 1, 1, 0));
  assert.deepStrictEqual(core.nextRun({ kind: 'weekdays', time: '08:00' }, at(2027, 2, 26, 9)), at(2027, 3, 1, 8));
});

test('clock changes (daylight saving): a daily run stays at its wall-clock time', () => {
  // Whatever this machine's time zone, a day later is the same wall-clock time, never 7:00 or 9:00.
  let t = at(2026, 3, 20, 9);
  for (let i = 0; i < 20; i++) {
    t = core.nextRun({ kind: 'daily', time: '08:00' }, t);
    assert.strictEqual(t.getHours(), 8);
    assert.strictEqual(t.getMinutes(), 0);
  }
  t = at(2026, 10, 20, 9);
  for (let i = 0; i < 20; i++) assert.strictEqual((t = core.nextRun({ kind: 'daily', time: '08:00' }, t)).getHours(), 8);
});

test('the app closed over a run: a run the same day still happens, once; days late is skipped', () => {
  const r = routine({ kind: 'daily', time: '08:00' }, { lastRun: at(2026, 10, 27, 8).getTime() });
  assert.strictEqual(core.check(r, at(2026, 10, 28, 7, 59)).action, 'wait');
  const late = core.check(r, at(2026, 10, 28, 13));
  assert.strictEqual(late.action, 'run', 'opened at 13:00: the 8:00 run happens');
  assert.deepStrictEqual(late.due, at(2026, 10, 28, 8));
  // Asleep for three days: the missed mornings count once, and only today's is still worth running.
  const away = core.check(r, at(2026, 10, 31, 9));
  assert.strictEqual(away.action, 'run');
  assert.deepStrictEqual(away.due, at(2026, 10, 31, 8), 'the latest occurrence, not three runs');
  assert.strictEqual(core.check(r, at(2026, 10, 31, 1)).action, 'skip', 'yesterday\'s morning, found after midnight: too late');
  assert.deepStrictEqual(core.check(r, at(2026, 10, 31, 1)).next, at(2026, 10, 31, 8));
});

test('disabled, brand new, or a clock set back: nothing runs by surprise', () => {
  assert.strictEqual(core.check(routine({ kind: 'daily', time: '08:00' }, { enabled: false }), at(2027, 1, 1)).action, 'wait');
  const fresh = routine({ kind: 'daily', time: '08:00' }, { createdAt: at(2026, 10, 28, 9).getTime() });
  assert.strictEqual(core.check(fresh, at(2026, 10, 28, 9, 30)).action, 'wait', 'made after today\'s time: tomorrow');
  const future = routine({ kind: 'daily', time: '08:00' }, { lastRun: at(2027, 1, 1, 8).getTime() });
  assert.strictEqual(core.check(future, at(2026, 10, 28, 12)).action, 'wait', 'a last run "in the future" (clock set back) never loops');
});

test('labels for people', () => {
  assert.strictEqual(core.describe({ kind: 'interval', hours: 1 }), 'every hour');
  assert.strictEqual(core.describe({ kind: 'weekly', time: '19:00', days: [0, 3] }), 'Sunday, Wednesday at 19:00');
  assert.strictEqual(core.describe({ kind: 'weekly', time: '19:00', days: [5] }), 'every Friday at 19:00');
});

test('a run is told to look for a connector before calling it down (they load after a session starts)', () => {
  const text = core.prompt({ name: 'Sync TickTick tasks', schedule: { kind: 'daily', time: '22:30' }, instructions: 'Fetch my TickTick tasks and save them.' });
  assert.ok(text.includes(core.CONNECTOR_CHECK));
  assert.match(core.CONNECTOR_CHECK, /ToolSearch/);
  assert.match(core.CONNECTOR_CHECK, /write nothing about a failure/);
});

// The TickTick sync's first run made the conversation the user then chatted in: every sync ran in
// their chat, moved its model and added its tool results to every later message's context.
test('a routine whose conversation became the user’s chat starts its own; replies to a briefing don’t count', () => {
  const run = { role: 'user', routine: 'r1', content: '⏰' };
  const own = { role: 'user', content: 'hi' };
  const reply = { role: 'assistant', content: 'ok' };
  const conv = (...m) => ({ messages: m });
  assert.strictEqual(core.takenOver(conv(run, reply, ...Array(12).fill(own)), 'r1'), true);
  assert.strictEqual(core.takenOver(conv(run, reply, own, run, own, run, own, run, own, own, own), 'r1'), false, 'follow-ups to each briefing');
  assert.strictEqual(core.takenOver(conv(run, ...Array(5).fill(own)), 'r1'), false, 'a few messages');
  assert.strictEqual(core.takenOver(conv(run, run, run), 'r1'), false);
  assert.strictEqual(core.takenOver(null, 'r1'), false);
  // Another routine's runs are not the user's own messages.
  assert.strictEqual(core.takenOver(conv(run, ...Array(8).fill({ role: 'user', routine: 'r2' })), 'r1'), false);
});

// "No model selected" failed the daily briefing and the recordings check, and nothing tried again.
test('a routine whose brain is not ready waits and tries again, says so once, then gives up', async () => {
  const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');
  const dir = tmpDir('nexus-routine-retry-');
  stub({ './store': fileStore(dir), './logger': quietLog });
  const routines = load('main/routines.js');
  const notes = [];
  let answer = { ok: false, error: 'No model selected. Choose a model in Settings → AI Brain.' };
  let runs = 0;
  routines.start({ run: async () => (runs++, answer), notify: (e) => notes.push(e) });
  const r = await routines.save({ name: 'Daily briefing', instructions: 'Brief me', schedule: { kind: 'daily', time: '07:45' } });
  const res = await routines.runNow(r.id);
  assert.strictEqual(res.waiting, true);
  let saved = (await routines.list()).find((x) => x.id === r.id);
  assert.strictEqual(saved.lastStatus, 'waiting');
  assert.strictEqual(saved.retries, 1);
  assert.ok(saved.retryAt > Date.now() + 9 * 60000);
  assert.strictEqual(notes.filter((n) => n.type === 'finished').length, 1, 'told once');
  assert.match(notes.find((n) => n.type === 'finished').summary, /Waiting for the AI brain \(No model selected/);

  // Not yet due: the tick leaves it alone.
  await routines.tick();
  assert.strictEqual(runs, 1);
  // Due: it runs again; a second wait is not announced again.
  const fs = require('fs');
  const file = require('path').join(dir, 'routines.json');
  const due = () => fs.writeFileSync(file, JSON.stringify(JSON.parse(fs.readFileSync(file, 'utf8')).map((x) => ({ ...x, retryAt: Date.now() - 1 }))));
  due();
  await routines.tick();
  assert.strictEqual(runs, 2);
  assert.strictEqual(notes.filter((n) => n.type === 'finished').length, 1);
  // The brain is back: done, the wait is over.
  answer = { ok: true, text: 'Briefing done.' };
  due();
  await routines.tick();
  saved = (await routines.list()).find((x) => x.id === r.id);
  assert.strictEqual(saved.lastStatus, 'ok');
  assert.strictEqual(saved.retryAt, null);
  assert.strictEqual(saved.retries, 0);
});

test('retries only for a brain that is not ready, at most three times', () => {
  assert.ok(core.retryPlan({}, new Error('fetch failed')));
  assert.ok(core.retryPlan({ retries: 2 }, 'connect ECONNREFUSED 127.0.0.1:11434'));
  assert.strictEqual(core.retryPlan({ retries: 3 }, 'No model selected'), null, 'gives up after three');
  assert.strictEqual(core.retryPlan({}, 'TickTick returned 500'), null, 'a real failure fails as before');
  assert.strictEqual(core.retryPlan({}, 'Stopped after 15 minutes.'), null);
});

// ---- Round 3: runs cut off, the internet down, broken records, stopping a run ----

const fs = require('fs');
const path = require('path');
const helpers = require('./helpers');

// A fresh load is a restarted app; each test gets its own folder.
function fresh(prefix, { log = helpers.quietLog } = {}) {
  const dir = helpers.tmpDir(prefix);
  helpers.stub({ './store': helpers.fileStore(dir), './logger': log });
  return { dir, file: path.join(dir, 'routines.json'), load: () => helpers.load('main/routines.js') };
}
const readFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
// deps.run that reports when it started and settles only when its signal aborts (as main.js stops a turn,
// with the conversation the turn ran in).
function stoppable() {
  const runs = [];
  const waiters = [];
  let seen = 0;
  const deps = {
    notes: [],
    notify: (e) => deps.notes.push(e),
    run: ({ routine, signal }) =>
      new Promise((resolve) => {
        const run = { routine, signal };
        runs.push(run);
        const end = () => resolve({ ok: false, error: 'Stopped', stopped: true, conversationId: `conv-${routine.id}` });
        if (signal.aborted) end();
        else signal.addEventListener('abort', end);
        waiters[runs.length - 1]?.(run);
      }),
  };
  // The next run that starts (in order).
  const next = () => {
    const n = seen++;
    return runs[n] ? Promise.resolve(runs[n]) : new Promise((r) => (waiters[n] = r));
  };
  return { deps, runs, next };
}
const daily = (name) => ({ name, instructions: 'Do it', schedule: { kind: 'daily', time: '08:00' } });

// io-3: lastRun was written only after a run, so a run cut off by quitting ran again in full at the next start.
test('a run cut off by quitting is marked at the next start, not run again, and its next prompt says to check first', async () => {
  const f = fresh('nexus-routine-cut-');
  const first = f.load();
  let started;
  const going = new Promise((r) => (started = r));
  first.start({ run: () => (started(), new Promise(() => {})), notify() {} });
  const r = await first.save(daily('Sync TickTick'));
  const before = Date.now();
  first.runNow(r.id); // never settles: the app is closed mid-run
  await going;
  const after = Date.now();
  let saved = readFile(f.file).find((x) => x.id === r.id);
  assert.strictEqual(saved.lastStatus, 'running', 'written before the run starts');
  assert.ok(saved.lastRun >= before && saved.lastRun <= after, 'lastRun is when it started');

  // The next start.
  const second = f.load();
  const runs = [];
  await second.start({ run: async ({ routine }) => (runs.push(routine.id), { ok: true, text: 'Done.' }), notify() {} });
  saved = (await second.list()).find((x) => x.id === r.id);
  assert.strictEqual(saved.lastStatus, 'interrupted');
  assert.strictEqual(saved.lastSummary, 'Cut off when the app closed.');
  assert.strictEqual(core.check(saved, new Date(saved.lastRun)).action, 'wait', 'that occurrence is never due again');
  // Not until the next occurrence, whatever time of day the test runs (an hour later crossed 08:00 at 07:xx).
  const next = core.nextRun(saved.schedule, new Date(saved.lastRun));
  assert.strictEqual(core.check(saved, new Date(next.getTime() - 1)).action, 'wait', 'nor up to the next occurrence');
  assert.strictEqual(core.check(saved, next).action, 'run', 'the next occurrence runs as usual');
  assert.match(core.prompt(saved), /cut off when the app closed before it finished: check what it already did/);
  assert.doesNotMatch(core.prompt({ ...saved, lastStatus: 'ok' }), /cut off/, 'only after a cut-off run');
  await second.tick();
  assert.deepStrictEqual(runs, [], 'the tick leaves it alone');

  // A normal run afterwards: ok, its lastRun the time it started.
  const t0 = Date.now();
  const res = await second.runNow(r.id);
  const t1 = Date.now();
  assert.strictEqual(res.ok, true);
  saved = readFile(f.file).find((x) => x.id === r.id);
  assert.strictEqual(saved.lastStatus, 'ok');
  assert.ok(saved.lastRun >= t0 && saved.lastRun <= t1);
  // A third start finds nothing to mark.
  await f.load().start({ run: async () => ({ ok: true }), notify() {} });
  assert.strictEqual(readFile(f.file).find((x) => x.id === r.id).lastStatus, 'ok');
});

// A retry (the brain or the internet was away) cut off by quitting kept its retryAt: it ran again in full.
test('a retry run cut off by quitting is not run again at the next start either', async () => {
  const f = fresh('nexus-routine-cut-retry-');
  const ago = Date.now() - 20 * 60000;
  fs.writeFileSync(
    f.file,
    JSON.stringify([{ id: 'w', name: 'Waiting one', instructions: 'Do it', enabled: true, createdAt: ago - 86400000, schedule: { kind: 'daily', time: '08:00' }, lastRun: ago, lastStatus: 'waiting', retryAt: ago + 10 * 60000, retries: 2 }]),
  );
  const first = f.load();
  let started;
  const going = new Promise((r) => (started = r));
  first.start({ run: () => (started(), new Promise(() => {})), notify() {} });
  first.tick(); // the retry is due; it never settles (the app is closed mid-run)
  await going;
  let saved = readFile(f.file)[0];
  assert.strictEqual(saved.lastStatus, 'running');
  assert.strictEqual(saved.retryAt, null, 'its retry time is used up');
  assert.strictEqual(saved.retries, 2, 'kept while it runs: this run\'s outcome counts from it');

  const second = f.load();
  const runs = [];
  await second.start({ run: async ({ routine }) => (runs.push(routine.id), { ok: true }), notify() {} });
  saved = readFile(f.file)[0];
  assert.strictEqual(saved.lastStatus, 'interrupted');
  assert.strictEqual(saved.retries, 0, 'the next occurrence counts its own retries');
  await second.tick();
  assert.deepStrictEqual(runs, [], 'not run again for that occurrence');
});

test('a run that throws is not left "running", and the next one can start', async () => {
  const f = fresh('nexus-routine-throw-');
  const routines = f.load();
  routines.start({ run: async () => { throw new Error('run broke'); }, notify() {} });
  const r = await routines.save(daily('Breaks'));
  await assert.rejects(() => routines.runNow(r.id), /run broke/);
  const saved = readFile(f.file).find((x) => x.id === r.id);
  assert.strictEqual(saved.lastStatus, 'error');
  assert.strictEqual(saved.lastSummary, 'run broke');
  // Not busy for good: the next run starts.
  await assert.rejects(() => routines.runNow(r.id), /run broke/);
});

// feedback-1: the CLI's offline wording failed the routine for the day.
test('the internet being down waits like a brain that is not ready; certificate and proxy problems fail', () => {
  for (const m of [
    'Unable to connect to API. Check your internet connection',
    'Unable to connect to API (ECONNRESET)',
    'Connection dropped (ECONNRESET)',
    "Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    'Can’t reach the API server — check your internet or DNS (ENOTFOUND)',
    'No internet route — check your connection or VPN (ENETUNREACH)',
    'getaddrinfo EAI_AGAIN api.anthropic.com',
  ]) {
    const plan = core.retryPlan({}, m, 1000);
    assert.ok(plan, m);
    assert.match(plan.summary, /^Waiting for the internet connection \(/, m);
    assert.strictEqual(plan.retryAt, 1000 + core.RETRY_MIN * 60000);
    assert.strictEqual(core.offline(new Error(m)), true, m);
  }
  for (const m of [
    'TickTick returned 500',
    'Unable to connect to API: SSL certificate has expired',
    'Unable to connect to API: Self-signed certificate detected',
    "Couldn't connect through your proxy (ERR_PROXY_TUNNEL) — the proxy refused the tunnel",
    '',
  ])
    assert.strictEqual(core.retryPlan({}, m), null, m);
  assert.match(core.retryPlan({}, 'No model selected').summary, /^Waiting for the AI brain/);
  assert.strictEqual(core.retryPlan({ retries: 3 }, 'Connection dropped (ECONNRESET)'), null, 'gives up after three');
  assert.strictEqual(core.offline(null), false);
  assert.strictEqual(core.offline(undefined), false);
});

// A run's error can be a page of output: the patterns read it in one pass (no backtracking blow-up).
test('long and hostile error texts are read at once', () => {
  const t0 = performance.now();
  assert.strictEqual(core.offline('Unable to connect to API: '.repeat(20000)), false, 'a certificate problem, many times over');
  assert.strictEqual(core.offline(`${'x'.repeat(200000)} ECONNRESET`), true, 'the code at the very end');
  assert.strictEqual(core.offline('can’t reach the ap'.repeat(20000)), false);
  assert.strictEqual(core.brainNotReady('log '.repeat(50000)), false);
  assert.strictEqual(core.retryPlan({}, 'Connection dropped '.repeat(20000)).waitsFor, 'internet');
  assert.ok(core.retryPlan({}, 'Connection dropped '.repeat(20000)).summary.length < 300, 'the summary quotes only the start');
  assert.strictEqual(core.retryPlan({}, 'No model selected').waitsFor, 'brain');
  assert.ok(performance.now() - t0 < 2000, `took ${Math.round(performance.now() - t0)} ms`);
});

// boundary-4: one record with a schedule that doesn't validate threw in tick() every minute (the ones after it
// never ran) and in the list (the view, routine_list and the phone's screen failed).
test('a record with a broken schedule is kept, shown as needing a fix and skipped; the others still run', async () => {
  const f = fresh('nexus-routine-broken-');
  const base = { instructions: 'Do it', enabled: true, createdAt: Date.now() - 10 * 86400000 };
  fs.writeFileSync(
    f.file,
    JSON.stringify([
      { ...base, id: 'b1', name: 'Weekly without days', schedule: { kind: 'weekly', time: '08:00' } },
      { ...base, id: 'b2', name: 'Bad time', schedule: { kind: 'daily', time: '8' } },
      { ...base, id: 'b3', name: 'Interval without hours', schedule: { kind: 'interval' } },
      { ...base, id: 'good', name: 'Good', schedule: { kind: 'interval', hours: 1 }, lastRun: Date.now() - 90 * 60000 },
    ]),
  );
  const routines = f.load();
  const listed = await routines.list();
  assert.strictEqual(listed.length, 4);
  const broken = listed.filter((r) => r.broken);
  assert.deepStrictEqual(broken.map((r) => r.id), ['b1', 'b2', 'b3']);
  for (const r of broken) {
    assert.strictEqual(r.when, 'schedule needs fixing');
    assert.strictEqual(r.nextRun, null);
  }
  assert.strictEqual(listed.find((r) => r.id === 'good').when, 'every hour');

  const ran = [];
  routines.start({ run: async ({ routine }) => (ran.push(routine.id), { ok: true, text: 'ok' }), notify() {} });
  await routines.tick();
  assert.deepStrictEqual(ran, ['good'], 'the good one runs');
  const file = readFile(f.file);
  for (const id of ['b1', 'b2', 'b3']) {
    const r = file.find((x) => x.id === id);
    assert.strictEqual(r.lastStatus, undefined, `${id}: nothing written (no 'skipped')`);
    assert.ok(r.schedule, `${id}: the raw schedule is kept`);
  }
  assert.ok(file.every((r) => !('broken' in r)), 'the mark is never stored');

  await assert.rejects(() => routines.runNow('b1'), /needs fixing/);
  assert.deepStrictEqual(await routines.remove('b2'), { deleted: 'Bad time' });
  const fixed = await routines.save({ id: 'b3', schedule: { kind: 'daily', time: '08:00' } });
  assert.strictEqual(fixed.broken, undefined);
  assert.strictEqual(fixed.when, 'every day at 08:00');
  assert.deepStrictEqual(readFile(f.file).map((r) => r.id), ['b1', 'b3', 'good']);
  assert.ok(readFile(f.file).every((r) => !('broken' in r)));
  // An edit that keeps the broken schedule is refused with the reason, and the record is unchanged.
  await assert.rejects(() => routines.save({ id: 'b1', name: 'Renamed' }), /weekly routine needs days/);
  assert.strictEqual(readFile(f.file).find((r) => r.id === 'b1').name, 'Weekly without days');
});

test('an empty, odd or null routines file lists as no routines', async () => {
  for (const content of ['[]', '{}', 'null', '[null, 1, "x", {"id": "a"}, {"id": "b", "name": "B"}]']) {
    const f = fresh('nexus-routine-empty-');
    fs.writeFileSync(f.file, content);
    const routines = f.load();
    assert.deepStrictEqual(await routines.list(), [], content);
    routines.start({ run: async () => ({ ok: true }), notify() {} });
    await routines.tick();
  }
});

// gap-stop-cancellation-7: deleting or switching off a running routine didn't stop it, though the delete
// confirm said "It stops running."
test('deleting a running routine stops the run, and it stays deleted', async () => {
  const f = fresh('nexus-routine-stop-del-');
  const routines = f.load();
  const s = stoppable();
  routines.start(s.deps);
  const r = await routines.save(daily('Plaud check'));
  const going = routines.runNow(r.id);
  const run = await s.next();
  assert.strictEqual(run.signal.aborted, false);
  assert.deepStrictEqual(await routines.remove(r.id), { deleted: 'Plaud check' });
  const res = await going;
  assert.strictEqual(run.signal.aborted, true);
  assert.strictEqual(res.stopped, true);
  assert.deepStrictEqual(readFile(f.file), [], 'not written back');
  assert.ok(!s.deps.notes.some((n) => n.type === 'finished'), 'no failure notice');
});

test('switching a running routine off stops it; switching on or removing another does not', async () => {
  const f = fresh('nexus-routine-stop-off-');
  const routines = f.load();
  const s = stoppable();
  routines.start(s.deps);
  const r = await routines.save(daily('Briefing'));
  const other = await routines.save(daily('Other'));
  const going = routines.runNow(r.id);
  const run = await s.next();
  await routines.setEnabled(r.id, true);
  await routines.remove(other.id);
  assert.strictEqual(run.signal.aborted, false, 'switching on, or removing another, leaves it running');
  const off = await routines.setEnabled(r.id, false);
  assert.strictEqual(off.enabled, false);
  const res = await going;
  assert.strictEqual(res.stopped, true);
  const saved = readFile(f.file).find((x) => x.id === r.id);
  assert.strictEqual(saved.enabled, false, 'the switch-off is kept');
  assert.strictEqual(saved.lastStatus, 'stopped');
  assert.strictEqual(saved.lastSummary, 'Stopped before it finished.');
  assert.strictEqual(saved.conversationId, `conv-${r.id}`, 'the stopped run’s conversation is the routine’s (a first run made it)');
  assert.ok(!s.deps.notes.some((n) => n.type === 'finished'));
  // routine_save with enabled: false (the agent pauses it) stops a run too.
  await routines.setEnabled(r.id, true);
  const again = routines.runNow(r.id);
  const run2 = await s.next();
  await routines.save({ id: r.id, enabled: false });
  assert.strictEqual(run2.signal.aborted, true);
  assert.strictEqual((await again).stopped, true);
  assert.strictEqual(readFile(f.file).find((x) => x.id === r.id).enabled, false);
  await assert.rejects(() => routines.setEnabled('nope', true), /No routine with id/);
  await assert.rejects(() => routines.setEnabled('nope', false), /No routine with id/);
});

// gap-stop-cancellation-2: routine_run from a chat ran 15 minutes under its own request id; Stop left it running.
test('the chat reply that ran a routine stops its run (routine_run passes its signal)', async () => {
  const f = fresh('nexus-routine-stop-outer-');
  const routines = f.load();
  const s = stoppable();
  routines.start(s.deps);
  const r = await routines.save(daily('TickTick sync'));
  const outer = new AbortController();
  const going = routines.runNow(r.id, { signal: outer.signal });
  const run = await s.next();
  outer.abort();
  assert.strictEqual(run.signal.aborted, true);
  assert.strictEqual((await going).stopped, true);
  assert.strictEqual(readFile(f.file).find((x) => x.id === r.id).lastStatus, 'stopped');
  assert.strictEqual(readFile(f.file).find((x) => x.id === r.id).enabled, true, 'a stop is not a switch-off');

  // Already stopped before it began: the run never starts.
  const done = new AbortController();
  done.abort();
  const late = await routines.runNow(r.id, { signal: done.signal });
  assert.strictEqual(late.stopped, true);
  assert.strictEqual(late.summary, 'Stopped before it started.');
  assert.strictEqual(s.runs.length, 1, 'deps.run was not called for it');
  assert.strictEqual(readFile(f.file).find((x) => x.id === r.id).lastStatus, 'stopped');
  // A finished run's outer signal does nothing later (its listener is gone).
  const after = new AbortController();
  const okRoutines = f.load();
  okRoutines.start({ run: async ({ signal }) => (assert.strictEqual(signal.aborted, false), { ok: true, text: 'fine' }), notify() {} });
  assert.strictEqual((await okRoutines.runNow(r.id, { signal: after.signal })).ok, true);
  after.abort();
  assert.strictEqual(readFile(f.file).find((x) => x.id === r.id).lastStatus, 'ok');
});

test('ten deletes in one tick: one stop, one delete, nine clear refusals', async () => {
  const f = fresh('nexus-routine-stop-spam-');
  const routines = f.load();
  const s = stoppable();
  routines.start(s.deps);
  const r = await routines.save(daily('Spam'));
  const going = routines.runNow(r.id);
  const run = await s.next();
  let aborts = 0;
  run.signal.addEventListener('abort', () => aborts++);
  const results = await Promise.allSettled(Array.from({ length: 10 }, () => routines.remove(r.id)));
  assert.strictEqual(aborts, 1, 'one abort event');
  assert.deepStrictEqual(results[0], { status: 'fulfilled', value: { deleted: 'Spam' } });
  for (const [i, x] of results.slice(1).entries()) {
    assert.strictEqual(x.status, 'rejected', `call ${i + 2}`);
    assert.match(x.reason.message, /No routine with id/);
  }
  assert.strictEqual((await going).stopped, true);
  assert.deepStrictEqual(readFile(f.file), []);
});

// The queue (one change of routines.json at a time): changes fired together land as if made one by one.
test('property: random saves, switches and deletes fired at once end as if made one after another', async () => {
  const seed = 20261118;
  let a = seed;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let round = 0; round < 20; round++) {
    const f = fresh('nexus-routine-queue-');
    const routines = f.load();
    routines.start({ run: async () => ({ ok: true }), notify() {} });
    const model = new Map();
    for (let i = 0; i < 4; i++) {
      const r = await routines.save(daily(`R${i}`));
      model.set(r.id, { name: `R${i}`, enabled: true });
    }
    const ids = [...model.keys(), 'gone'];
    const ops = [];
    const expected = [];
    for (let i = 0; i < 25; i++) {
      const id = ids[Math.floor(rand() * ids.length)];
      const kind = Math.floor(rand() * 3);
      const exists = model.has(id);
      if (kind === 0) {
        ops.push(routines.remove(id));
        expected.push(exists);
        model.delete(id);
      } else if (kind === 1) {
        const on = rand() < 0.5;
        ops.push(routines.setEnabled(id, on));
        expected.push(exists);
        if (exists) model.get(id).enabled = on;
      } else {
        const name = `N${round}-${i}`;
        ops.push(routines.save({ id, name }));
        expected.push(exists);
        if (exists) model.get(id).name = name;
      }
    }
    const results = await Promise.allSettled(ops);
    results.forEach((x, i) => assert.strictEqual(x.status === 'fulfilled', expected[i], `seed ${seed} round ${round} op ${i}: ${x.reason?.message || 'ok'}`));
    const file = readFile(f.file);
    assert.deepStrictEqual(
      file.map((r) => [r.id, r.name, r.enabled]),
      [...model].map(([id, m]) => [id, m.name, m.enabled]),
      `seed ${seed} round ${round}: the file matches the changes made one by one`,
    );
  }
});

// A delete or switch-off that came while runNow was still reading the list found no run to stop: the
// deleted routine ran in full (connectors included) and then announced its result.
test('deleted or switched off the moment it was started: the run never begins', async () => {
  const f = fresh('nexus-routine-stop-early-');
  const routines = f.load();
  const ran = [];
  const notes = [];
  routines.start({ run: async ({ routine }) => (ran.push(routine.id), { ok: true, text: 'did it' }), notify: (e) => notes.push(e) });
  const r = await routines.save(daily('Gone at once'));
  const [res, del] = await Promise.all([routines.runNow(r.id), routines.remove(r.id)]);
  assert.deepStrictEqual(del, { deleted: 'Gone at once' });
  assert.deepStrictEqual(res, { ok: false, stopped: true, summary: 'Stopped before it started.', conversationId: undefined });
  assert.deepStrictEqual(ran, [], 'deps.run is never called');
  assert.deepStrictEqual(readFile(f.file), [], 'it stays deleted');
  assert.ok(!notes.some((n) => n.type === 'started' || n.type === 'finished'), 'no notice of a run');

  // Switched off in the same moment (a scheduled run, or ▶ Run just before the switch): not run, kept off.
  for (const reason of ['schedule', 'request']) {
    const p = await routines.save(daily(`Paused at once (${reason})`));
    const [res2, off] = await Promise.all([routines.runNow(p.id, { reason }), routines.setEnabled(p.id, false)]);
    assert.strictEqual(off.enabled, false, reason);
    assert.strictEqual(res2.stopped, true, reason);
    const saved = readFile(f.file).find((x) => x.id === p.id);
    assert.strictEqual(saved.enabled, false, reason);
    assert.strictEqual(saved.lastStatus, 'stopped', reason);
    assert.strictEqual(saved.lastSummary, 'Stopped before it started.', reason);
  }
  assert.deepStrictEqual(ran, []);

  // ▶ Run of a routine that was already paused still runs: that is what was asked for.
  const paused = await routines.save({ ...daily('Already paused'), enabled: false });
  assert.strictEqual((await routines.runNow(paused.id)).ok, true);
  assert.deepStrictEqual(ran, [paused.id]);
  assert.strictEqual(readFile(f.file).find((x) => x.id === paused.id).enabled, false, 'and stays paused');
  // A scheduled run of a paused routine (tick read the list before the switch) doesn't.
  assert.strictEqual((await routines.runNow(paused.id, { reason: 'schedule' })).stopped, true);
  assert.deepStrictEqual(ran, [paused.id]);
});

// "Check hourly until my results are posted, then switch yourself off": the routine's own routine_save
// (enabled: false) or routine_delete aborted its own turn mid-tool, so its report never came and no
// notice either.
test('a routine that deletes or pauses itself in its own run finishes that run and reports', async () => {
  const { AsyncLocalStorage } = require('async_hooks');
  const als = new AsyncLocalStorage();
  // As logger.js: tool calls run under their turn's tags (tools.execute → log.withContext(ctx.logTags)).
  const log = { ...helpers.quietLog, withContext: (tags, fn) => als.run({ ...(als.getStore() || {}), ...tags }, fn), context: () => als.getStore() || {} };
  const f = fresh('nexus-routine-self-', { log });
  const routines = f.load();
  const notes = [];
  let act = async () => {};
  let answer = { ok: true, text: 'Results are posted; switched myself off.' };
  const signals = [];
  routines.start({
    notify: (e) => notes.push(e),
    run: async ({ routine, signal, onTurn }) => {
      signals.push(signal);
      onTurn('ab12cd');
      await log.withContext({ turn: 'ab12cd', conv: 'cv0001' }, () => act(routine));
      return { ...answer, conversationId: 'conv-self' };
    },
  });
  const cases = [
    ['setEnabled', (r) => routines.setEnabled(r.id, false)],
    ['routine_save enabled false', (r) => routines.save({ id: r.id, enabled: false })],
    ['routine_delete', (r) => routines.remove(r.id)],
  ];
  for (const [label, how] of cases) {
    const r = await routines.save(daily(`Self ${label}`));
    act = how;
    notes.length = 0;
    const res = await routines.runNow(r.id);
    assert.strictEqual(res.ok, true, label);
    assert.ok(!res.stopped, label);
    assert.strictEqual(signals.at(-1).aborted, false, `${label}: its own turn isn't aborted`);
    const done = notes.find((n) => n.type === 'finished');
    assert.ok(done && done.ok && /switched myself off/.test(done.summary), `${label}: the report reaches the user`);
    const saved = readFile(f.file).find((x) => x.id === r.id);
    if (label === 'routine_delete') assert.strictEqual(saved, undefined, 'deleted, and not written back');
    else {
      assert.strictEqual(saved.enabled, false, `${label}: paused`);
      assert.strictEqual(saved.lastStatus, 'ok', label);
    }
  }

  // Deleted itself, then the internet dropped: nothing waits to try again; it fails and says so.
  const gone = await routines.save(daily('Self then offline'));
  act = (r) => routines.remove(r.id);
  answer = { ok: false, error: 'Connection dropped (ECONNRESET)' };
  notes.length = 0;
  const res = await routines.runNow(gone.id);
  assert.strictEqual(res.ok, false);
  assert.ok(!res.waiting, 'no retry for a deleted routine');
  assert.match(notes.find((n) => n.type === 'finished')?.summary || '', /Connection dropped/);
  assert.strictEqual(readFile(f.file).find((x) => x.id === gone.id), undefined);

  // The same delete from another turn (the user's chat, under its own tag) still stops the run.
  const other = await routines.save(daily('Stopped by the chat'));
  act = (r) => log.withContext({ turn: 'zz99yy' }, () => routines.remove(r.id));
  answer = { ok: true, text: 'not reached' };
  notes.length = 0;
  const stopped = await routines.runNow(other.id);
  assert.strictEqual(stopped.stopped, true);
  assert.strictEqual(signals.at(-1).aborted, true);
  assert.ok(!notes.some((n) => n.type === 'finished'));
});

// The run's own turn is told apart by its log tag: main.js hands routines.js the tag turns.js gives it
// (turns.tagFor; that the turn runs under it is shown in test/turns.test.js).
test('main.js tells a routine run the log tag its turn runs under', () => {
  const src = fs.readFileSync(path.join(helpers.ROOT, 'main', 'main.js'), 'utf8');
  const turns = fs.readFileSync(path.join(helpers.ROOT, 'main', 'turns.js'), 'utf8');
  assert.match(turns, /const tags = \{ turn: tagFor\(requestId\),/, 'turns.js tags its turn');
  assert.ok(src.includes('onTurn?.(tagFor(requestId));'), 'startRoutines reports the same tag');
});

// A hand-written record without a creation time threw in tick() every minute ('routine check failed'),
// and the list said it was due "now" for ever.
test('a record without a usable time is shown as needing a fix, warned about once, and an edit heals it', async () => {
  const warns = [];
  const f = fresh('nexus-routine-notime-', { log: { ...helpers.quietLog, warn: (e) => warns.push(e) } });
  fs.writeFileSync(
    f.file,
    JSON.stringify([
      { id: 'x', name: 'Hand', instructions: 'Do', enabled: true, schedule: { kind: 'interval', hours: 2 } },
      { id: 'y', name: 'Garbled', instructions: 'Do', enabled: true, createdAt: 5, lastRun: 'yesterday-ish', schedule: { kind: 'daily', time: '08:00' } },
    ]),
  );
  const routines = f.load();
  const ran = [];
  routines.start({ run: async ({ routine }) => (ran.push(routine.id), { ok: true }), notify() {} });
  const listed = await routines.list();
  for (const r of listed) {
    assert.strictEqual(r.when, 'schedule needs fixing', r.id);
    assert.match(r.broken, /creation time and last run/, r.id);
    assert.strictEqual(r.nextRun, null, r.id);
  }
  await routines.tick();
  await routines.tick();
  assert.deepStrictEqual(ran, []);
  assert.deepStrictEqual(warns.filter((w) => w === 'routine check failed'), [], 'no warning every minute');
  assert.strictEqual(warns.filter((w) => w === 'routine schedule unreadable').length, 2, 'one line per record');
  await assert.rejects(() => routines.runNow('x'), /needs fixing \(its creation time and last run/);
  // An edit (any field) gives it a creation time; a garbled last run counts as never.
  const t0 = Date.now();
  const healed = await routines.save({ id: 'x', name: 'Hand, edited' });
  assert.strictEqual(healed.broken, undefined);
  assert.strictEqual(healed.when, 'every 2 hours');
  assert.ok(readFile(f.file)[0].createdAt >= t0);
  const y = await routines.save({ id: 'y', instructions: 'Do it' });
  assert.strictEqual(y.broken, undefined);
  assert.strictEqual(readFile(f.file)[1].lastRun, 0);
  assert.strictEqual(readFile(f.file)[1].createdAt, 5, 'a usable creation time is kept');
});

test('usable times: only what a Date can read; normalize drops the rest', () => {
  for (const t of [0, undefined, null, '', 'x', NaN, Infinity, -Infinity, {}]) assert.strictEqual(core.usableTime(t), false, String(t));
  for (const t of [1, Date.now(), '2026-11-18T08:00', 8.64e15]) assert.strictEqual(core.usableTime(t), true, String(t));
  assert.strictEqual(core.usableTime(8.64e15 + 1), false, 'past the largest Date');
  const r = core.normalize({ name: 'R', instructions: 'Do', schedule: { kind: 'daily', time: '08:00' }, createdAt: 'garbage', lastRun: NaN }, { newId: () => 'id', now: 42 });
  assert.strictEqual(r.createdAt, 42);
  assert.strictEqual(r.lastRun, 0);
});
