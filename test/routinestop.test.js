// Stopping a routine run: Stop in the chat reaches the routine it ran (routine_run passes the turn's signal to
// runNow), and deleting a running routine stops it; either way the run ends as stopped, with no failure
// notice, and keeps the conversation it ran in.
const test = require('node:test');
const assert = require('node:assert');
const fx = require('./appfixture')('routinestop');
const { approvals, routines, untilTrue, allTools } = fx;

const runs = [];
const notes = [];
let routinesStarted = false;
function startRoutines() {
  if (routinesStarted) return;
  routinesStarted = true;
  // As main.js startRoutines: a stop resolves the run as stopped, with the conversation it had.
  routines.start({
    run: ({ routine, signal, onTurn }) =>
      new Promise((resolve) => {
        onTurn?.('rt0stop');
        runs.push(routine.id);
        const stop = () => resolve({ ok: false, error: 'Stopped', stopped: true, conversationId: 'c-routine-stop' });
        if (signal?.aborted) return stop();
        signal?.addEventListener('abort', stop, { once: true });
      }),
    notify: (ev) => notes.push(ev),
  });
}

test('Stop in the chat reaches the routine it ran (routine_run → runNow’s signal): stopped, no failure notice', async () => {
  startRoutines();
  const r = await routines.save({ name: 'Morning check', schedule: { kind: 'daily', time: '08:00' }, instructions: 'Check the schedule.' });
  const ctl = new AbortController();
  const ctx = { emit() {}, signal: ctl.signal, turn: approvals.newTurn({ signal: ctl.signal }) };
  notes.length = 0;
  const call = allTools().execute('routine_run', { id: r.id }, ctx);
  await untilTrue(() => runs.includes(r.id));
  ctl.abort();
  const out = await call;
  assert.strictEqual(out.ok, true, JSON.stringify(out));
  assert.strictEqual(out.result.stopped, true);
  assert.strictEqual(out.result.summary, 'Stopped before it finished.');
  const row = (await routines.list()).find((x) => x.id === r.id);
  assert.strictEqual(row.lastStatus, 'stopped');
  assert.strictEqual(row.conversationId, 'c-routine-stop', 'the run’s conversation is kept');
  assert.ok(notes.some((n) => n.type === 'started'));
  assert.ok(!notes.some((n) => n.type === 'finished'), 'no failure notice for a stop');
  // Not busy any more: the next run starts.
  const again = routines.runNow(r.id, { reason: 'request' });
  await untilTrue(() => runs.filter((x) => x === r.id).length === 2);
  await routines.remove(r.id);
  assert.strictEqual((await again).stopped, true);
});

test('deleting a running routine stops it: no failure notice, nothing written back', async () => {
  startRoutines();
  const r = await routines.save({ name: 'Weekly review', schedule: { kind: 'weekly', time: '19:00', days: [0] }, instructions: 'Review the week.' });
  notes.length = 0;
  const run = routines.runNow(r.id, { reason: 'request' });
  await untilTrue(() => runs.includes(r.id));
  assert.deepStrictEqual(await routines.remove(r.id), { deleted: 'Weekly review' });
  const out = await run;
  assert.strictEqual(out.stopped, true);
  assert.ok(!(await routines.list()).some((x) => x.id === r.id), 'the deleted routine stays deleted');
  assert.ok(!notes.some((n) => n.type === 'finished' && n.ok === false), JSON.stringify(notes));
});
