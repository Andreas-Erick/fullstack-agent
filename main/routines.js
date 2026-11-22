// Routines: the agent runs instructions on a schedule (routinecore.js), each routine in a conversation
// of its own, and the user gets a notification with the result. Stored in <userData>/routines.json.
// Checked every minute while the app runs; a run missed while it was closed happens once at the next
// start if it isn't too late (routinecore.check). One routine runs at a time.
const path = require('path');
const store = require('./store');
const log = require('./logger');
const core = require('./routinecore');

const MAX_ROUTINES = 30;
const RUN_LIMIT_MS = 15 * 60000; // a run that takes longer is stopped, so one stuck run can't block the rest
const file = () => path.join(store.dataDir(), 'routines.json');

let timer = null;
let busy = false;
let running = null; // { id, controller, turn }: the run going on now (one at a time); turn: its turn's log tag
// { run({ routine, text, limitMs, signal, onTurn }) → Promise<{ ok, text, conversationId, error, stopped }>, notify(event) };
// run calls onTurn(tag) with the log tag its turn runs under (turns.tagFor, main/turns.js: { turn }).
let deps = null;

// One change of routines.json at a time (save, remove, update): a run's status written while the
// routine is being deleted or switched off can't put back the old list.
let queue = Promise.resolve();
function change(fn) {
  const next = queue.catch(() => {}).then(fn); // the queue only orders the work; each caller gets its own error
  queue = next;
  return next;
}

// A record whose schedule doesn't validate (edited by hand, an older version) is kept as it is and marked
// `broken`: it never runs, and the others still do. The log says so once per routine.
const warned = new Set();
function warnOnce(r, err) {
  if (warned.has(r.id)) return;
  warned.add(r.id);
  log.warn('routine schedule unreadable', { routine: r.name, error: err });
}

function checked(r) {
  try {
    const schedule = core.normalizeSchedule(r.schedule);
    // check() counts from the last run or the creation time: without a usable one it can't say when (an
    // edit gives it one: core.normalize).
    if (!core.usableTime(r.lastRun || r.createdAt)) throw new Error('its creation time and last run are missing or unreadable');
    return { ...r, schedule };
  } catch (err) {
    warnOnce(r, err);
    return { ...r, broken: err.message }; // the raw schedule is kept
  }
}

// A damaged routines.json is kept as routines.corrupt-<time>.json (never silently overwritten by the
// next save) and the routines start empty; the log says where the copy is.
async function list() {
  const raw = await store.readJson(file(), [], {
    onCorrupt: async (err) => {
      const kept = path.join(store.dataDir(), `routines.corrupt-${Date.now()}.json`);
      await require('fs').promises.copyFile(file(), kept).catch((e) => log.warn('damaged routines file not kept', { error: e }));
      await store.writeJsonAtomic(file(), []).catch((e) => log.warn('routines file not reset', { error: e }));
      log.error('routines file unreadable', { error: err, kept });
      deps?.notify({ type: 'finished', name: 'Routines', ok: false, summary: `Your routines file was damaged; a copy is kept at ${kept}.` });
      return [];
    },
  });
  return (Array.isArray(raw) ? raw : []).filter((r) => r && r.id && r.schedule && typeof r.name === 'string').map(checked);
}

async function saveAll(all) {
  await store.writeJsonAtomic(file(), all.map(({ broken, ...r }) => r)); // the mark is never stored
  deps?.notify({ type: 'changed' });
}

/** Creates or updates a routine; what it last did is kept when it is edited. */
async function save(input) {
  if (input.enabled === false && input.id) stopRun(input.id); // paused through routine_save
  return change(async () => {
    const all = await list();
    const old = input.id ? all.find((r) => r.id === input.id) : null;
    if (input.id && !old) throw new Error(`No routine with id "${input.id}".`);
    if (!old && all.length >= MAX_ROUTINES) throw new Error(`There are already ${MAX_ROUTINES} routines; delete one first.`);
    // normalize builds a fresh record: a valid schedule clears a `broken` mark.
    const routine = core.normalize({ ...(old || {}), ...input, schedule: input.schedule || old?.schedule }, { newId: store.newId });
    await saveAll(old ? all.map((r) => (r.id === old.id ? routine : r)) : [...all, routine]);
    return withNext(routine);
  });
}

async function remove(id) {
  stopRun(id);
  return change(async () => {
    const all = await list();
    const r = all.find((x) => x.id === id);
    if (!r) throw new Error(`No routine with id "${id}".`);
    await saveAll(all.filter((x) => x.id !== id));
    return { deleted: r.name };
  });
}

function withNext(r) {
  if (r.broken) return { ...r, when: 'schedule needs fixing', nextRun: null };
  const c = core.check(r);
  return { ...r, when: core.describe(r.schedule), nextRun: c.action === 'wait' && c.next ? c.next.getTime() : r.enabled ? Date.now() : null };
}

/** Changes one routine's fields; null (nothing written) when it is gone. */
function update(id, patch) {
  return change(async () => {
    const all = await list();
    if (!all.some((r) => r.id === id)) return null;
    const next = all.map((r) => (r.id === id ? { ...r, ...patch } : r));
    await saveAll(next);
    return next.find((r) => r.id === id);
  });
}

// A run stops when its routine is deleted or switched off ("It stops now if it's running"), unless the
// change comes from that run's own turn ("…then switch yourself off"): that turn finishes and reports.
// Every tool call runs under its turn's log tags (tools.execute), whichever brain made it.
function stopRun(id) {
  if (running?.id !== id) return;
  if (running.turn && log.context().turn === running.turn) return;
  running.controller.abort();
}

async function setEnabled(id, enabled) {
  if (!enabled) stopRun(id);
  const r = await update(id, { enabled: Boolean(enabled) });
  if (!r) throw new Error(`No routine with id "${id}".`);
  return withNext(r);
}

/**
 * Runs one routine now (scheduled or on request). signal: the chat reply that ran it (routine_run);
 * when it stops, the run stops too.
 */
async function runNow(id, { reason = 'request', signal = null } = {}) {
  if (!deps) throw new Error('Routines are not running yet.');
  const routine = (await list()).find((r) => r.id === id);
  if (!routine) throw new Error(`No routine with id "${id}".`);
  if (routine.broken) throw new Error(`“${routine.name}” can't run: its schedule needs fixing (${routine.broken}). Edit it in Skills → Routines.`);
  if (busy) throw new Error('Another routine is running; try again in a moment.');
  busy = true;
  const startedAt = Date.now();
  const controller = new AbortController();
  const outer = () => controller.abort(); // the chat reply that ran it was stopped (routine_run)
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', outer, { once: true });
  const run = { id, controller, turn: '' };
  running = run;
  log.info('routine run', { routine: routine.name, reason });
  try {
    // Written before it runs: a run cut off by quitting is never due again for this occurrence (a retry's
    // time goes too; this run's outcome sets a new one), and the next start marks it interrupted.
    const marked = await update(id, { lastRun: startedAt, lastStatus: 'running', lastSummary: '', retryAt: null });
    // Deleted or switched off while this run was being set up, before stopRun could find it. A paused
    // routine still runs when asked to (▶ Run), unless it was switched off after the asking.
    if (!marked || (marked.enabled === false && (reason !== 'request' || routine.enabled !== false))) controller.abort();
    if (!controller.signal.aborted) deps.notify({ type: 'started', id, name: routine.name });
    const res = controller.signal.aborted ? null : await deps.run({ routine, text: core.prompt(routine), limitMs: RUN_LIMIT_MS, signal: controller.signal, onTurn: (tag) => (run.turn = tag) });
    if (controller.signal.aborted) {
      // Stopped on purpose (Stop in the chat, deleted, switched off): no failure notice, no retry. A deleted
      // routine isn't written back (update does nothing for a missing id).
      const summary = res ? 'Stopped before it finished.' : 'Stopped before it started.';
      await update(id, { lastStatus: 'stopped', lastSummary: summary, retryAt: null, retries: 0, ...(res?.conversationId ? { conversationId: res.conversationId } : {}) });
      log.info('routine stopped', { routine: routine.name, started: Boolean(res) });
      return { ok: false, stopped: true, summary, conversationId: res?.conversationId };
    }
    const summary = String(res.text || res.error || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    // The brain or the internet wasn't there: wait and try again (routinecore.retryPlan); the user hears it
    // once. A routine its own run deleted has nothing to wait for: it fails as below.
    const retry = res.ok ? null : core.retryPlan(routine, res.error);
    if (retry && (await update(id, { lastRun: startedAt, lastStatus: 'waiting', lastSummary: retry.summary, retryAt: retry.retryAt, retries: retry.retries, conversationId: res.conversationId || routine.conversationId }))) {
      log.warn('routine waits', { routine: routine.name, for: retry.waitsFor, retries: retry.retries, error: res.error });
      if (retry.retries === 1) deps.notify({ type: 'finished', id, name: routine.name, ok: false, summary: retry.summary, conversationId: res.conversationId });
      return { ok: false, waiting: true, summary: retry.summary, conversationId: res.conversationId };
    }
    await update(id, { lastRun: startedAt, lastStatus: res.ok ? 'ok' : 'error', lastSummary: summary, retryAt: null, retries: 0, conversationId: res.conversationId || routine.conversationId });
    if (!res.ok) log.warn('routine failed', { routine: routine.name, error: res.error });
    if (routine.notify || !res.ok) deps.notify({ type: 'finished', id, name: routine.name, ok: res.ok, summary, conversationId: res.conversationId });
    return { ok: res.ok, summary, conversationId: res.conversationId };
  } catch (err) {
    // deps.run never rejects (main.js resolves every outcome), but if it or a write does, the record
    // mustn't say 'running' until the next launch.
    await update(id, { lastStatus: 'error', lastSummary: String(err?.message || err).slice(0, 400) }).catch((e) => log.warn('routine status not saved', { error: e }));
    throw err;
  } finally {
    busy = false;
    running = null;
    signal?.removeEventListener('abort', outer);
  }
}

async function tick() {
  if (busy || !deps) return;
  for (const r of await list()) {
    if (r.broken) continue;
    // One routine that can't be checked never keeps the ones after it from running.
    try {
      // A run waiting for the brain goes again at its time (and nothing else of it runs meanwhile).
      if (r.retryAt && r.enabled !== false) {
        if (Date.now() < r.retryAt) continue;
        await runNow(r.id, { reason: 'retry' }).catch((err) => log.error('routine run failed', { routine: r.name, error: err }));
        return;
      }
      const c = core.check(r);
      if (c.action === 'skip') {
        log.info('routine skipped', { routine: r.name, missed: c.due?.toISOString() });
        await update(r.id, { lastRun: Date.now(), lastStatus: 'skipped', lastSummary: `Skipped the run of ${c.due?.toLocaleString()}: the app was closed.` });
      } else if (c.action === 'run') {
        await runNow(r.id, { reason: 'schedule' }).catch((err) => log.error('routine run failed', { routine: r.name, error: err }));
        return; // one per tick
      }
    } catch (err) {
      log.warn('routine check failed', { routine: r.name, error: err });
    }
  }
}

// A run still marked 'running' from before this start was cut off when the app closed: it isn't run again
// for that occurrence (its lastRun is set), and its next prompt says to check what it already did.
async function markInterrupted() {
  const cut = await change(async () => {
    const all = await list();
    const hit = all.filter((r) => r.lastStatus === 'running' && r.id !== running?.id).map((r) => r.id);
    // Its next occurrence starts counting retries afresh.
    if (hit.length) await saveAll(all.map((r) => (hit.includes(r.id) ? { ...r, lastStatus: 'interrupted', lastSummary: 'Cut off when the app closed.', retries: 0 } : r)));
    return all.filter((r) => hit.includes(r.id));
  });
  for (const r of cut) log.info('routine interrupted', { routine: r.name });
}

/** Starts the minute checks; the promise it returns settles once interrupted runs are marked. */
function start(d) {
  deps = d;
  clearInterval(timer);
  timer = setInterval(() => tick().catch((err) => log.warn('routines tick', { error: err })), 60000);
  timer.unref?.();
  // A little after startup, so the window and the brain are ready.
  setTimeout(() => tick().catch((err) => log.warn('routines tick', { error: err })), 45000).unref?.();
  return markInterrupted().catch((err) => log.warn('routines interrupted check', { error: err }));
}

async function listForUi() {
  return (await list()).map(withNext);
}

module.exports = { list: listForUi, save, remove, runNow, start, tick, setEnabled };
