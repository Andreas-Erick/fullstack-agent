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
