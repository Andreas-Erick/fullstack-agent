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
let deps = null; // { run({ routine, text }) → Promise<{ ok, text, conversationId, error }>, notify(event) }

// A damaged routines.json is kept as routines.corrupt-<time>.json (never silently overwritten by the
// next save) and the routines start empty; the log says where the copy is.
async function list() {
  const raw = await store.readJson(file(), [], {
    onCorrupt: async (err) => {
      const kept = path.join(store.dataDir(), `routines.corrupt-${Date.now()}.json`);
      await require('fs').promises.copyFile(file(), kept).catch(() => {});
      await store.writeJsonAtomic(file(), []).catch(() => {});
      log.error('routines file unreadable', { error: err, kept });
      deps?.notify({ type: 'finished', name: 'Routines', ok: false, summary: `Your routines file was damaged; a copy is kept at ${kept}.` });
      return [];
    },
  });
  return (Array.isArray(raw) ? raw : []).filter((r) => r && r.id && r.schedule && typeof r.name === 'string');
}

async function saveAll(all) {
  await store.writeJsonAtomic(file(), all);
  deps?.notify({ type: 'changed' });
}

/** Creates or updates a routine; what it last did is kept when it is edited. */
async function save(input) {
  const all = await list();
  const old = input.id ? all.find((r) => r.id === input.id) : null;
  if (input.id && !old) throw new Error(`No routine with id "${input.id}".`);
  if (!old && all.length >= MAX_ROUTINES) throw new Error(`There are already ${MAX_ROUTINES} routines; delete one first.`);
  const routine = core.normalize({ ...(old || {}), ...input, schedule: input.schedule || old?.schedule }, { newId: store.newId });
  await saveAll(old ? all.map((r) => (r.id === old.id ? routine : r)) : [...all, routine]);
  return withNext(routine);
}

async function remove(id) {
  const all = await list();
  const r = all.find((x) => x.id === id);
  if (!r) throw new Error(`No routine with id "${id}".`);
  await saveAll(all.filter((x) => x.id !== id));
  return { deleted: r.name };
}

function withNext(r) {
  const c = core.check(r);
  return { ...r, when: core.describe(r.schedule), nextRun: c.action === 'wait' && c.next ? c.next.getTime() : r.enabled ? Date.now() : null };
}

async function update(id, patch) {
  const all = await list();
  const next = all.map((r) => (r.id === id ? { ...r, ...patch } : r));
  await saveAll(next);
  return next.find((r) => r.id === id);
}

/** Runs one routine now (scheduled or on request). */
async function runNow(id, { reason = 'request' } = {}) {
  if (!deps) throw new Error('Routines are not running yet.');
  const routine = (await list()).find((r) => r.id === id);
  if (!routine) throw new Error(`No routine with id "${id}".`);
  if (busy) throw new Error('Another routine is running; try again in a moment.');
  busy = true;
  const startedAt = Date.now();
  log.info('routine run', { routine: routine.name, reason });
  deps.notify({ type: 'started', id, name: routine.name });
  try {
    const res = await deps.run({ routine, text: core.prompt(routine), limitMs: RUN_LIMIT_MS });
    const summary = String(res.text || res.error || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    await update(id, { lastRun: startedAt, lastStatus: res.ok ? 'ok' : 'error', lastSummary: summary, conversationId: res.conversationId || routine.conversationId });
    if (!res.ok) log.warn('routine failed', { routine: routine.name, error: res.error });
    if (routine.notify || !res.ok) deps.notify({ type: 'finished', id, name: routine.name, ok: res.ok, summary, conversationId: res.conversationId });
    return { ok: res.ok, summary, conversationId: res.conversationId };
  } finally {
    busy = false;
  }
}

async function tick() {
  if (busy || !deps) return;
  for (const r of await list()) {
    const c = core.check(r);
    if (c.action === 'skip') {
      log.info('routine skipped', { routine: r.name, missed: c.due?.toISOString() });
      await update(r.id, { lastRun: Date.now(), lastStatus: 'skipped', lastSummary: `Skipped the run of ${c.due?.toLocaleString()}: the app was closed.` });
    } else if (c.action === 'run') {
      await runNow(r.id, { reason: 'schedule' }).catch((err) => log.error('routine run failed', { routine: r.name, error: err }));
      return; // one per tick
    }
  }
}

function start(d) {
  deps = d;
  clearInterval(timer);
  timer = setInterval(() => tick().catch((err) => log.warn('routines tick', { error: err })), 60000);
  timer.unref?.();
  // A little after startup, so the window and the brain are ready.
  setTimeout(() => tick().catch((err) => log.warn('routines tick', { error: err })), 45000).unref?.();
}

async function listForUi() {
  return (await list()).map(withNext);
}

module.exports = { list: listForUi, save, remove, runNow, start, tick, setEnabled: (id, enabled) => update(id, { enabled: Boolean(enabled) }).then(withNext) };
