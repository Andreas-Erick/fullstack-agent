// What a paired device should fetch again after something changed on the computer (pure; used by
// companion.js). A change is told to devices only as topics named after the phone's screens
// (renderer/remote/screens.js TITLES, plus 'sched' and 'conversations'), never a path or a value: the
// device asks /api/data/* again, under the same checks as always. test/sync.test.js.

// Every topic a device may hear. 'sched' is the schedule screen, 'conversations' the list and titles.
const TOPICS = ['today', 'habits', 'learn', 'memory', 'notes', 'tree', 'world', 'skills', 'cards', 'sched', 'conversations'];

// Vault notes by where they live (vault-relative, forward slashes), first match wins; every note also
// counts for 'notes'. Habits, decks and topics feed Today and the skill tree's evidence too.
const VAULT_RULES = [
  [/^Habits\.md$/i, ['habits', 'today', 'tree']],
  [/^Schedule\.md$/i, ['sched', 'today']],
  [/^Skill Tree\.md$/i, ['tree']],
  [/^Memory\//i, ['memory']],
  [/^Stream\//i, ['memory']],
  [/^Flashcards\//i, ['cards', 'today', 'tree']],
  [/^Languages\//i, ['cards', 'learn', 'today', 'tree']],
  [/^Learning\//i, ['learn', 'today', 'tree']],
  [/^Inner World\//i, ['world']],
  [/^(Active Priorities|Where We Left Off)\.md$/i, ['today']],
];

/** The topics a change to vault note `rel` touches. */
function topicsForVault(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!p || p.startsWith('.')) return [];
  const rule = VAULT_RULES.find(([re]) => re.test(p));
  const out = new Set(rule ? rule[1] : []);
  if (/\.md$/i.test(p)) out.add('notes');
  return [...out];
}

// Chat events that say the agent changed something (tools emit them for the window).
const CHAT_TOPICS = {
  start: ['conversations'], // a new conversation, or one moved to the top of the list
  habits_changed: ['habits', 'today', 'tree'],
  calendar_changed: ['sched', 'today'],
  memory_changed: ['memory'],
  skills_changed: ['skills'],
  skilltree_changed: ['tree'],
  world_changed: ['world'],
};

/** The topics an event the window gets (main.js send) touches; [] for anything else. */
function topicsForEvent(channel, payload) {
  if (channel === 'vault:changed') return topicsForVault(typeof payload === 'string' ? payload : payload?.rel);
  if (channel === 'chat:event') return CHAT_TOPICS[payload?.type] || [];
  return [];
}

/** Only known topics, each once. */
const clean = (topics) => [...new Set((Array.isArray(topics) ? topics : [topics]).filter((t) => TOPICS.includes(t)))];

/**
 * Collects topics for `waitMs` and hands them over at once (a turn can write a dozen notes; a deck
 * import hundreds). `flush(topics)` gets a sorted list; `timers` lets tests drive time.
 */
function coalescer(flush, { waitMs = 600, timers = { setTimeout, clearTimeout } } = {}) {
  let pending = new Set();
  let timer = null;
  return {
    add(topics) {
      const t = clean(topics);
      if (!t.length) return;
      for (const x of t) pending.add(x);
      if (timer) return;
      timer = timers.setTimeout(() => {
        timer = null;
        const out = [...pending].sort();
        pending = new Set();
        flush(out);
      }, waitMs);
      timer?.unref?.();
    },
    cancel() {
      if (timer) timers.clearTimeout(timer);
      timer = null;
      pending = new Set();
    },
    get pending() {
      return [...pending].sort();
    },
  };
}

/**
 * Turns still running, per conversation, so a device that (re)opens a conversation mid-reply can follow
 * it, and one that missed the end knows it is over. An entry older than `maxAgeMs` is dropped (a turn
 * that never reported its end must not look busy forever).
 */
function runningTurns({ maxAgeMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const map = new Map(); // requestId -> { conversationId, at }
  const prune = () => {
    for (const [id, t] of map) if (now() - t.at > maxAgeMs) map.delete(id);
  };
  return {
    note(ev) {
      if (!ev?.requestId) return;
      if (ev.type === 'start' && ev.conversationId) map.set(ev.requestId, { conversationId: ev.conversationId, at: now() });
      else if (['done', 'error', 'aborted'].includes(ev.type)) map.delete(ev.requestId);
    },
    in(conversationId) {
      prune();
      return [...map].filter(([, t]) => t.conversationId === conversationId).map(([id]) => id);
    },
    get size() {
      return map.size;
    },
  };
}

module.exports = { TOPICS, VAULT_RULES, topicsForVault, topicsForEvent, clean, coalescer, runningTurns };
