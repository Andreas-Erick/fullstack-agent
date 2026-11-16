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
