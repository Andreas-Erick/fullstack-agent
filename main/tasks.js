// Tasks from Todoist / TickTick in the Calendar view (pure part: taskscore.js). Kept in
// <userData>/connector-tasks.json: what the assistant last saved per service with tasks_save, and the
// conversation the "Sync tasks" runs use. A sync is an ordinary assistant turn (main.js runs it with
// startTurn, one at a time), so the connector's own approvals and permission levels apply.
const path = require('path');
const store = require('./store');
const log = require('./logger');
const core = require('./taskscore');

const file = () => path.join(store.dataDir(), 'connector-tasks.json');
let writing = Promise.resolve();
let syncing = null;
let runner = null; // main.js: (text, conversationId) => Promise<{ ok, error?, conversationId }>
let notify = () => {};

function init({ run, changed }) {
  runner = run;
  notify = changed || notify;
}

async function read() {
  const d = await store.readJson(file(), null);
  return d && Array.isArray(d.tasks) ? d : { sources: {}, tasks: [], conversationId: '' };
}

/** Replaces one service's tasks with what the assistant fetched; returns { saved, skipped, source }. */
function save(source, list) {
  const { tasks, skipped } = core.clean(list);
  const run = writing.then(async () => {
    const next = core.replace(await read(), String(source || '').toLowerCase(), tasks);
    await store.writeJsonAtomic(file(), next);
    return { source, saved: tasks.length, skipped };
  });
  writing = run.catch(() => {});
  return run.then((r) => (notify(), log.info('tasks saved', { source, saved: r.saved, skipped }), r));
}

/** For the Calendar view: the tasks, which task connectors are usable, and the last syncs. */
async function status() {
  const s = await store.getSettings();
  const d = await read();
  const cached = await require('./claudecode').cachedConnectors().catch(() => null);
  const available = core.connectedSources(cached?.list);
  const brain = s.llm.provider === 'claude-code' || (s.llm.provider === 'auto' && !(s.routing?.disabled || []).includes('claude-code'));
  return {
    tasks: d.tasks,
    sources: d.sources,
    available,
    ready: Boolean(brain && s.claudeCode?.connectors && available.length),
    reason: !available.length ? 'no-connector' : !brain ? 'no-claude' : !s.claudeCode?.connectors ? 'connectors-off' : '',
    syncing: Boolean(syncing),
  };
}

/** Asks the assistant to fetch the tasks again (in its own conversation); one sync at a time. */
function sync() {
  // Marked busy before anything is awaited: a second click while it checks joins this run.
  if (syncing) return syncing;
  syncing = (async () => {
    const st = await status();
    if (!st.ready) throw new Error(st.reason === 'connectors-off' ? 'Turn on "Use my Claude connectors and plugins" in Settings → AI brain first.' : st.reason === 'no-claude' ? 'Syncing tasks needs the Claude account brain (Settings → AI brain).' : 'Connect Todoist or TickTick on claude.ai first (Settings → Connectors), then "Check connectors" in Settings → AI brain.');
    if (!runner) throw new Error('The app is still starting.');
    const today = new Date().toLocaleDateString('en-CA');
    const d = await read();
    const r = await runner(core.syncPrompt(st.available, today), d.conversationId);
    if (r.conversationId && r.conversationId !== d.conversationId) {
      const fresh = await read();
      await store.writeJsonAtomic(file(), { ...fresh, conversationId: r.conversationId });
    }
    if (!r.ok) throw new Error(r.error || 'The sync did not finish.');
    return status();
  })().finally(() => {
    syncing = null;
    notify();
  });
  notify();
  return syncing;
}

module.exports = { init, save, status, sync, read };
