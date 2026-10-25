// Habit tracker (main/habitcore.js) and routines' scheduling (main/routinecore.js).
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./helpers');

const habits = load('main/habitcore.js');
const routines = load('main/routinecore.js');

test('habits: add, log, undo, and the note round-trips', () => {
  let h = habits.parse('');
  h = habits.addHabit(h, { name: 'Meditate', target: 7, note: '10 minutes after coffee' }, '2026-10-20');
  h = habits.addHabit(h, { name: 'Run', target: 3 }, '2026-10-20');
  h = habits.setDone(h, ['meditate', 'Run'], '2026-10-25').habits;
  h = habits.setDone(h, 'Meditate', '2026-10-24').habits;
  h = habits.setDone(h, 'Meditate', '2026-10-25').habits; // twice: once
  assert.deepStrictEqual(h.log.get('2026-10-25'), ['Meditate', 'Run']);
  assert.throws(() => habits.setDone(h, 'Juggle', '2026-10-25'), /isn't a tracked habit/);
  const text = habits.serialize(h);
  assert.match(text, /- \*\*Meditate\*\* — daily · 10 minutes after coffee <!-- habit target=7 since=2026-10-20 -->/);
  assert.match(text, /- \*\*Run\*\* — 3× a week <!-- habit target=3 since=2026-10-20 -->/);
  assert.match(text, /## Log\n- 2026-10-25: Meditate, Run\n- 2026-10-24: Meditate/);
  const again = habits.parse(text);
  assert.deepStrictEqual(again.habits, h.habits);
  assert.deepStrictEqual([...again.log], [...h.log].sort().reverse());
  const undone = habits.setDone(again, 'Run', '2026-10-25', false).habits;
  assert.deepStrictEqual(undone.log.get('2026-10-25'), ['Meditate']);
});

test('habits: daily streaks count back from today or yesterday', () => {
  let h = habits.addHabit(habits.parse(''), { name: 'Read' }, '2026-10-01');
  for (const d of ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24']) h = habits.setDone(h, 'Read', d).habits;
  let s = habits.stats(h, '2026-10-25')[0];
  assert.deepStrictEqual([s.doneToday, s.streak, s.streakUnit], [false, 4, 'days'], 'today still open: the streak is alive');
  h = habits.setDone(h, 'Read', '2026-10-25').habits;
  s = habits.stats(h, '2026-10-25')[0];
  assert.deepStrictEqual([s.doneToday, s.streak], [true, 5]);
  assert.deepStrictEqual(s.last7, [false, false, true, true, true, true, true]);
  assert.strictEqual(habits.stats(h, '2026-10-27')[0].streak, 0, 'a missed day breaks it');
});

test('habits: weekly targets count weeks that met the target', () => {
  // 2026-10-19 is a Monday.
  let h = habits.addHabit(habits.parse(''), { name: 'Run', target: 2 }, '2026-10-01');
  for (const d of ['2026-10-13', '2026-10-15', '2026-10-20', '2026-10-23', '2026-10-26']) h = habits.setDone(h, 'Run', d).habits;
  const s = habits.stats(h, '2026-10-26')[0];
  assert.deepStrictEqual([s.streak, s.streakUnit, s.thisWeek], [2, 'weeks', 1], 'this week not met yet: counts the two weeks before');
});

test('habits: hand-written text around the sections survives, pausing keeps history', () => {
  const text = '---\ntype: habits\n---\n# Habits\n\nMy intro.\n\n## Habits\n- **Stretch** — daily <!-- habit target=7 since=2026-10-01 -->\n\n## Log\n- 2026-10-02: Stretch\n\n## Thoughts\nkeep going';
  const h = habits.setPaused(habits.parse(text), 'stretch', true);
  const out = habits.serialize(h);
  assert.ok(out.includes('My intro.') && out.includes('## Thoughts\nkeep going') && out.includes('target=7 since=2026-10-01 paused'));
  assert.ok(out.includes('- 2026-10-02: Stretch'));
});

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const daily = (time = '08:00', extra = {}) => routines.normalize({ name: 'Check Plaud', instructions: 'Look for new recordings.', schedule: { kind: 'daily', time }, createdAt: at(2026, 10, 24, 12).getTime(), ...extra }, { newId: () => 'rt-1' });

test('routines: validation', () => {
  assert.throws(() => routines.normalize({ name: '', instructions: 'x', schedule: { kind: 'daily', time: '08:00' } }, { newId: () => 'x' }), /name/);
  assert.throws(() => routines.normalizeSchedule({ kind: 'daily', time: '25:00' }), /HH:MM/);
  assert.throws(() => routines.normalizeSchedule({ kind: 'weekly', time: '09:00' }), /days/);
  assert.throws(() => routines.normalizeSchedule({ kind: 'interval', hours: 0 }), /hours/);
  assert.deepStrictEqual(routines.normalizeSchedule({ kind: 'weekly', time: '9:05', days: [5, 1, 1] }), { kind: 'weekly', time: '09:05', days: [1, 5] });
});

test('routines: next run times', () => {
  assert.deepStrictEqual(routines.nextRun({ kind: 'daily', time: '08:00' }, at(2026, 10, 25, 7, 59)), at(2026, 10, 25, 8));
  assert.deepStrictEqual(routines.nextRun({ kind: 'daily', time: '08:00' }, at(2026, 10, 25, 8)), at(2026, 10, 26, 8), 'strictly after');
  // 2026-10-24 is a Saturday: weekdays go to Monday.
  assert.deepStrictEqual(routines.nextRun({ kind: 'weekdays', time: '18:30' }, at(2026, 10, 24, 9)), at(2026, 10, 26, 18, 30));
  assert.deepStrictEqual(routines.nextRun({ kind: 'weekly', time: '19:00', days: [0] }, at(2026, 10, 25, 20)), at(2026, 11, 1, 19));
  assert.deepStrictEqual(routines.nextRun({ kind: 'interval', hours: 3 }, at(2026, 10, 25, 10)), at(2026, 10, 25, 13));
});

test('routines: due, missed-but-recent, and too-late runs', () => {
  const r = daily();
  assert.strictEqual(routines.check(r, at(2026, 10, 25, 7)).action, 'wait');
  assert.strictEqual(routines.check(r, at(2026, 10, 25, 8, 1)).action, 'run');
  assert.strictEqual(routines.check({ ...r, lastRun: at(2026, 10, 25, 8).getTime() }, at(2026, 10, 25, 20)).action, 'wait', 'ran today already');
  // The app was closed for days: one catch-up run if the latest slot is recent, else skip.
  assert.strictEqual(routines.check(r, at(2026, 10, 28, 12)).action, 'run');
  assert.strictEqual(routines.check(r, at(2026, 10, 28, 3)).action, 'skip', 'yesterday 08:00 is 19 hours ago');
  assert.strictEqual(routines.check({ ...r, enabled: false }, at(2026, 10, 25, 9)).action, 'wait');
});

test('routines: a label for people and a prompt for the agent', () => {
  assert.strictEqual(routines.describe({ kind: 'weekly', time: '19:00', days: [0] }), 'every Sunday at 19:00');
  assert.strictEqual(routines.describe({ kind: 'weekdays', time: '07:30' }), 'weekdays at 07:30');
  assert.strictEqual(routines.describe({ kind: 'interval', hours: 1 }), 'every hour');
  const p = routines.prompt(daily(), at(2026, 10, 25, 8));
  assert.match(p, /Routine "Check Plaud" \(runs every day at 08:00\)/);
  assert.match(p, /Last run: never/);
  assert.match(p, /Look for new recordings\./);
  assert.match(p, /may not be at the computer/);
});

test('the routine runner: due runs happen once, results are kept, one at a time', async () => {
  const { stub, tmpDir, fileStore, quietLog } = require('./helpers');
  const fs = require('fs');
  const dir = tmpDir('nexus-routines-');
  stub({ './store': fileStore(dir), './logger': quietLog });
  const runner = load('main/routines.js');
  const runs = [];
  const events = [];
  let finish;
  runner.start({ run: ({ routine, text }) => (runs.push({ routine, text }), new Promise((r) => (finish = r))), notify: (ev) => events.push(ev) });
  const saved = await runner.save({ name: 'Check Plaud', schedule: { kind: 'interval', hours: 1 }, instructions: 'Look for new recordings.', createdAt: Date.now() - 2 * 3600000 });
  assert.ok(saved.id && saved.when === 'every hour');

  const first = runner.tick();
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(runs.length, 1, 'due: it runs');
  assert.match(runs[0].text, /Look for new recordings/);
  await assert.rejects(runner.runNow(saved.id), /Another routine is running/);
  finish({ ok: true, text: 'Two new recordings: …', conversationId: 'c1' });
  await first;
  const [r] = await runner.list();
  assert.deepStrictEqual([r.lastStatus, r.conversationId, r.lastSummary], ['ok', 'c1', 'Two new recordings: …']);
  assert.ok(events.some((e) => e.type === 'finished' && e.ok && e.conversationId === 'c1'));

  await runner.tick();
  assert.strictEqual(runs.length, 1, 'just ran: not again');
  await assert.rejects(runner.save({ id: 'nope', name: 'x', instructions: 'y', schedule: { kind: 'daily', time: '08:00' } }), /No routine/);
  await runner.remove(saved.id);
  assert.strictEqual((await runner.list()).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});
