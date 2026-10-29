// The schedule (main/schedulecore.js for the format and rules, main/calendar.js for Schedule.md in
// the vault): parsing what the agent and the user write, repeat rules, and editing a note without
// losing the user's own text.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load } = require('./helpers');

const core = load('main/schedulecore.js');
const at = (s) => new Date(`${s}T00:00:00`);
const days = (list) => list.map((o) => o.start.slice(0, 10));

test('reads dates, times and repeat rules', () => {
  assert.deepStrictEqual(core.parseWhen('2026-10-28 14:00-15:00'), { date: '2026-10-28', endDate: '', start: '14:00', end: '15:00', repeat: null });
  assert.deepStrictEqual(core.parseWhen('2026-12-21 to 2027-01-06'), { date: '2026-12-21', endDate: '2027-01-06', start: '', end: '', repeat: null });
  assert.deepStrictEqual(core.parseWhen('every Monday at 9:05am').repeat, { freq: 'weekly', interval: 1, days: [1] });
  assert.strictEqual(core.parseWhen('every Monday at 9:05am').start, '09:05');
  assert.deepStrictEqual(core.parseWhen('every tue, Thursday and fri 2pm-3:30pm'), { date: '', endDate: '', start: '14:00', end: '15:30', repeat: { freq: 'weekly', interval: 1, days: [2, 4, 5] } });
  assert.deepStrictEqual(core.parseWhen('every weekday 07:30').repeat.days, [1, 2, 3, 4, 5]);
  assert.deepStrictEqual(core.parseWhen('every other Friday 16:00').repeat, { freq: 'weekly', interval: 2, days: [5] });
  assert.deepStrictEqual(core.parseWhen('every 3 weeks on Sunday').repeat, { freq: 'weekly', interval: 3, days: [0] });
  assert.deepStrictEqual(core.parseWhen('every month on the 15th').repeat, { freq: 'monthly', interval: 1, monthDay: 15 });
  assert.deepStrictEqual(core.parseWhen('every year on March 14th').repeat, { freq: 'yearly', interval: 1, month: 3, monthDay: 14 });
  assert.deepStrictEqual(core.parseWhen('every Mondays 21:00').repeat.days, [1]);
});

test('rejects what it cannot read, saying what works', () => {
  for (const bad of ['next Monday', '2026-02-30', 'every Funday', 'every month on the 40th', '2026-10-28 25:00', '2026-10-28 to 2026-10-30 10:00', '']) {
    assert.throws(() => core.parseWhen(bad), /./, bad);
  }
  assert.throws(() => core.parseWhen('tomorrow at 3'), /every Monday 10:00-11:30/);
  assert.throws(() => core.normalize({ title: 'x', when: 'every Monday', from: '2026-10-10', until: '2026-10-01' }), /before/);
  assert.throws(() => core.normalize({ title: '  ', when: '2026-10-28' }), /title/);
});

test('the canonical text reads back to the same entry', () => {
  for (const when of ['2026-10-28', '2026-10-28 14:00', '2026-10-28 14:00-15:00', '2026-12-21 to 2027-01-06', 'every day 22:00', 'every 2 days', 'every weekday 07:30', 'every Monday, Wednesday 10:00-11:30', 'every 2 weeks on Friday', 'every month on the 1st', 'every 3 months on the 22nd', 'every year on Mar 14']) {
    const e = core.normalize({ title: 'T', when });
    assert.strictEqual(core.formatWhen(e), when);
    const again = core.parse(`## Events\n${core.formatLine({ ...e, id: 'x1' })}`).entries[0];
    assert.deepStrictEqual({ ...again, line: 0, kind: 0 }, { ...e, id: 'x1', line: 0, kind: 0 });
  }
});

test('a weekly lecture for a semester, with a day off', () => {
  const e = core.normalize({ id: 'r1', title: 'Linear Algebra', when: 'every Monday 10:00-11:30', location: 'H1', from: '2026-10-05', until: '2026-11-09', except: '2026-10-19' });
  const list = core.occurrences([e], at('2026-09-01'), at('2027-01-01'));
  assert.deepStrictEqual(days(list), ['2026-10-05', '2026-10-12', '2026-10-26', '2026-11-02', '2026-11-09']);
  assert.deepStrictEqual(list[0], { id: 'r1@2026-10-05', entryId: 'r1', title: 'Linear Algebra', location: 'H1', notes: '', recurring: true, rule: core.describe(e), allDay: false, start: '2026-10-05T10:00:00', end: '2026-10-05T11:30:00', openEnd: false });
});

test('every other week counts from its first day; monthly skips months without the day', () => {
  const lab = core.normalize({ id: 'r2', title: 'Lab', when: 'every 2 weeks on Tuesday, Thursday 08:15', from: '2026-10-06' });
  assert.deepStrictEqual(days(core.occurrences([lab], at('2026-10-01'), at('2026-11-01'))), ['2026-10-06', '2026-10-08', '2026-10-20', '2026-10-22']);
  const rent = core.normalize({ id: 'r3', title: 'Rent', when: 'every month on the 31st' });
  assert.deepStrictEqual(days(core.occurrences([rent], at('2026-01-01'), at('2026-06-01'))), ['2026-01-31', '2026-03-31', '2026-05-31']);
  const bday = core.normalize({ id: 'r4', title: 'Birthday', when: 'every year on Mar 14' });
  const b = core.occurrences([bday], at('2026-01-01'), at('2028-01-01'));
  assert.deepStrictEqual(days(b), ['2026-03-14', '2027-03-14']);
  assert.strictEqual(b[0].allDay, true);
  assert.strictEqual(b[0].end, '2026-03-15T00:00:00');
});

test('single events: open end, past midnight, several days, overlap with the range', () => {
  const ev = (when) => core.normalize({ id: 'e', title: 'E', when });
  assert.strictEqual(core.occurrences([ev('2026-10-28 14:00')], at('2026-10-28'), at('2026-10-29'))[0].end, '2026-10-28T15:00:00');
  assert.strictEqual(core.occurrences([ev('2026-10-28 23:30')], at('2026-10-28'), at('2026-10-29'))[0].end, '2026-10-29T00:30:00');
  const night = core.occurrences([ev('2026-10-28 22:00-02:00')], at('2026-10-29'), at('2026-10-30'));
  assert.strictEqual(night.length, 1, 'shows on the next day too');
  assert.strictEqual(night[0].end, '2026-10-29T02:00:00');
  const trip = ev('2026-12-21 to 2027-01-06');
  assert.strictEqual(core.occurrences([trip], at('2027-01-01'), at('2027-01-02')).length, 1);
  assert.strictEqual(core.occurrences([trip], at('2027-01-07'), at('2027-01-08')).length, 0);
  const shift = core.normalize({ id: 'r', title: 'Night shift', when: 'every Friday 22:00-06:00' });
  assert.deepStrictEqual(days(core.occurrences([shift], at('2026-10-24'), at('2026-10-25'))), ['2026-10-23'], 'Friday night reaches into Saturday');
});

test('editing keeps the user’s own text and puts entries in the right place', () => {
  const mine = '---\ntype: schedule\n---\n# Schedule\n\nMy own words.\n\n## Recurring\n- every Monday 10:00 | Lecture | id r1\n\n## Events\n- 2026-11-02 | Later | id e2\n\n## Ideas\n- not an entry, just a list\n';
  let text = core.addEntry(mine, core.normalize({ id: 'e1', title: 'Earlier', when: '2026-10-30 09:00' }));
  text = core.addEntry(text, core.normalize({ id: 'r2', title: 'Gym', when: 'every weekday 07:00' }));
  assert.match(text, /My own words\./);
  assert.match(text, /## Ideas\n- not an entry, just a list/);
  assert.match(text, /- every Monday 10:00 \| Lecture \| id r1\n- every weekday 07:00 \| Gym \| id r2\n/);
  assert.match(text, /- 2026-10-30 09:00 \| Earlier \| id e1\n- 2026-11-02 \| Later \| id e2/);
  const parsed = core.parse(text);
  assert.deepStrictEqual(parsed.entries.map((e) => e.id), ['r1', 'r2', 'e1', 'e2']);
  assert.deepStrictEqual(parsed.problems, [], 'lists under other headings are not entries');

  text = core.replaceEntry(text, 'r1', core.normalize({ id: 'r1', title: 'Lecture', when: 'every Monday 10:00-11:30', location: 'H1' }));
  assert.match(text, /- every Monday 10:00-11:30 \| Lecture \| @ H1 \| id r1/);
  text = core.replaceEntry(text, 'e2', core.normalize({ id: 'e2', title: 'Later', when: 'every Tuesday' }));
  assert.match(text, /## Recurring\n(- .*\n)*- every Tuesday \| Later \| id e2\n/, 'a date turned rule moves to Recurring');
  text = core.removeEntry(text, 'e1').text;
  assert.deepStrictEqual(core.parse(text).entries.map((e) => e.id), ['r1', 'r2', 'e2']);
  assert.throws(() => core.removeEntry(text, 'nope'), /No schedule entry/);
});

test('hand-written lines get a stable id; unreadable ones are reported, not lost', () => {
  const text = '## Recurring\n- every Thursday 18:00 | Choir\n- every Funday | Oops\n\n```\n- every Monday | in a code block\n```\n';
  const a = core.parse(text);
  const b = core.parse(text);
  assert.strictEqual(a.entries.length, 1);
  assert.strictEqual(a.entries[0].id, b.entries[0].id);
  assert.deepStrictEqual(a.problems.map((p) => [p.line, p.text]), [[3, 'every Funday | Oops']]);
  const edited = core.addEntry(text, core.normalize({ id: 'r9', title: 'New', when: 'every day' }));
  assert.match(edited, /- every Funday \| Oops/);
});

test('an empty or missing note starts from the template', () => {
  const text = core.addEntry('', core.normalize({ id: 'e1', title: 'Dentist', when: '2026-10-28 14:00-15:00', location: 'Main St 4' }));
  assert.match(text, /^---\ntype: schedule/);
  assert.match(text, /## Events\n\n- 2026-10-28 14:00-15:00 \| Dentist \| @ Main St 4 \| id e1\n/);
  assert.strictEqual(core.parse(core.template()).entries.length, 0, 'the examples in the template are not entries');
  const noSections = core.addEntry('# My schedule\n', core.normalize({ id: 'r1', title: 'Gym', when: 'every day' }));
  assert.match(noSections, /# My schedule\n\n## Recurring\n\n- every day \| Gym \| id r1/);
});

test('fields cannot break the line format', () => {
  const e = core.normalize({ id: 'e1', title: 'A | B\nC', when: '2026-10-28', location: 'x|y', notes: 'line\nbreak' });
  assert.strictEqual(core.formatLine(e), '- 2026-10-28 | A B C | @ x y | note line break | id e1');
});

test('calendar.js keeps Schedule.md in the vault, one change at a time', async () => {
  let file = '';
  const writes = [];
  stub({
    './store': { getSettings: async () => ({ calendar: { enabled: true, daysAhead: 7 }, agent: { name: 'Nexus' } }), setSecretBlob: async () => {} },
    './obsidian': {
      vaultPath: async () => '/vault',
      readOptional: async () => file,
      writeNote: async (rel, text) => {
        writes.push(rel);
        file = text;
      },
    },
    './logger': { info() {}, warn() {} },
  });
  const calendar = load('main/calendar.js');
  const [a, b] = await Promise.all([
    calendar.add({ title: 'Linear Algebra', when: 'every Monday 10:00-11:30', location: 'H1', until: '2027-02-12' }),
    calendar.add({ title: 'Dentist', when: '2026-10-28 14:00' }),
  ]);
  assert.deepStrictEqual(writes, ['Schedule.md', 'Schedule.md']);
  assert.match(a.id, /^r[0-9a-f]{4}$/);
  assert.match(b.id, /^e[0-9a-f]{4}$/);
  const { entries } = await calendar.entries();
  assert.deepStrictEqual(entries.map((e) => e.title).sort(), ['Dentist', 'Linear Algebra'], 'neither change overwrote the other');

  await calendar.update(a.id, { location: '', notes: 'Bring the laptop' });
  await calendar.remove(a.id, { onlyDate: '2026-11-02' });
  const lecture = (await calendar.entries()).entries.find((e) => e.id === a.id);
  assert.deepStrictEqual([lecture.location, lecture.notes, lecture.except], ['', 'Bring the laptop', ['2026-11-02']]);
  const nov = await calendar.events({ start: '2026-11-01T00:00:00', end: '2026-11-17T00:00:00' });
  assert.deepStrictEqual(nov.map((o) => o.start), ['2026-11-09T10:00:00', '2026-11-16T10:00:00']);
  await assert.rejects(calendar.remove(b.id, { onlyDate: '2026-10-28' }), /single event/);
  await calendar.remove(b.id);
  assert.strictEqual((await calendar.entries()).entries.length, 1);
  const st = await calendar.status();
  assert.deepStrictEqual([st.connected, st.recurring, st.events, st.problems], [true, 1, 0, 0]);
});

// Regression: "Halloween party 19:00-24:00" was rejected ("is not a time"), so the agent could not
// add an evening that ends at midnight.
test('an end of 24:00 is midnight', () => {
  const w = core.parseWhen('2026-10-31 19:00-24:00');
  assert.strictEqual(w.start, '19:00');
  assert.strictEqual(w.end, '00:00');
  const party = core.normalize({ id: 'p1', title: 'Halloween party', when: '2026-10-31 19:00-24:00' });
  const [o] = core.occurrences([party], at('2026-10-31'), at('2026-11-02'));
  assert.strictEqual(o.start, '2026-10-31T19:00:00');
  assert.strictEqual(o.end, '2026-11-01T00:00:00', 'ends exactly at midnight');
  assert.throws(() => core.parseWhen('2026-10-31 24:00'), /not a time/, 'a start of 24:00 is still wrong');
  assert.throws(() => core.parseWhen('2026-10-31 19:00-24:30'), /not a time/);
});
