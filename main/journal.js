// Auto-journal: when a conversation goes quiet, write a session entry (what got done, in progress,
// decisions, notes touched) to the day's daily note in the vault. Conversations from earlier runs that
// were never journaled are reconstructed on startup, so the daily notes stay continuous.
const store = require('./store');
const log = require('./logger');
const attachcore = require('./attachcore');
const routinecore = require('./routinecore');

let timer = null;
let running = false;

// A conversation whose summary failed (offline, plan cap, sign-in, bad JSON) waits before the next try:
// 5 min, doubling to 1 h, then not again until it changes. Without it every sweep (once a minute) asked
// the model again for the same conversation. In memory only: a restart tries once more.
const BACKOFF_FIRST_MS = 5 * 60000;
const BACKOFF_MAX_MS = 60 * 60000;
const backoff = new Map(); // conversation id → { stamp, failures, nextAt }

// What identifies a conversation's state in the index: a new message or a save changes it.
const stampOf = (c) => `${Number(c?.count) || 0}:${Number(c?.updatedAt) || 0}`;

// The wait after the n-th failure in a row; Infinity = stop until the conversation changes.
function backoffDelay(failures) {
  const n = Math.floor(Number(failures));
  if (!Number.isFinite(n) || n <= 0) return 0;
  const ms = BACKOFF_FIRST_MS * 2 ** (n - 1);
  if (ms < BACKOFF_MAX_MS) return ms; // 5, 10, 20, 40 min
  // The first wait that reaches the hour is the hour; the failure after it stops.
  return ms / 2 < BACKOFF_MAX_MS ? BACKOFF_MAX_MS : Infinity;
}

// Pure: may the conversation be tried now? An entry for an older stamp no longer counts.
function mayTry(entry, stamp, now) {
  if (!entry || entry.stamp !== stamp) return true;
  return Number(now) >= entry.nextAt;
}

// Pure: the entry after a failure (counted again from 1 when the conversation changed).
function afterFailure(entry, stamp, now) {
  const failures = (entry && entry.stamp === stamp ? entry.failures : 0) + 1;
  return { stamp, failures, nextAt: (Number(now) || 0) + backoffDelay(failures) };
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function start() {
  clearInterval(timer);
  timer = setInterval(() => sweep().catch((e) => log.warn('journal sweep failed', { error: e })), 60000);
  setTimeout(() => sweep().catch((e) => log.warn('journal sweep failed', { error: e })), 20000);
}

async function sweep() {
  if (running) return;
  const s = await store.getSettings();
  if (!s.journal.enabled || !s.obsidian.enabled) return;
  running = true;
  try {
    const idleMs = (s.journal.idleMinutes ?? 15) * 60000;
    const listed = await store.listConversations();
    const ids = new Set(listed.map((c) => c.id));
    for (const id of backoff.keys()) if (!ids.has(id)) backoff.delete(id);
    for (const c of listed) {
      const now = Date.now();
      if (now - c.updatedAt < idleMs) continue;
      // From the index alone: nothing new since the last journal entry (the common case) → skip.
      if (c.count - (c.journaledUpTo || 0) < 2) continue;
      const stamp = stampOf(c);
      if (!mayTry(backoff.get(c.id), stamp, now)) continue;
      const conv = await store.getConversation(c.id);
      if (!conv) continue;
      const from = conv.journaledUpTo || 0;
      const fresh = conv.messages.slice(from);
      if (!fresh.some((m) => m.role === 'user')) {
        // Nothing of the user's to journal (a greeting, app messages): mark it read so it isn't opened again.
        await markJournaled(conv.id, conv.messages.length);
        continue;
      }
      if (fresh.length < 2) continue;
      try {
        await journalConversation(conv, from, s);
        backoff.delete(c.id);
      } catch (err) {
        const entry = afterFailure(backoff.get(c.id), stamp, now);
        backoff.set(c.id, entry);
        const away = routinecore.offline(err) || routinecore.brainNotReady(err);
        log.warn('journal summarize failed', {
          error: err,
          conversation: c.id,
          failures: entry.failures,
          retryMin: Number.isFinite(entry.nextAt) ? Math.round((entry.nextAt - now) / 60000) : null,
          ...(away ? { away: true } : {}),
        });
        // Offline or no brain: the other conversations would fail the same way; they wait for the next sweep.
        if (away) break;
      }
    }
  } finally {
    running = false;
  }
}

async function markJournaled(id, upTo) {
  const fresh = await store.getConversation(id);
  if (!fresh || (fresh.journaledUpTo || 0) >= upTo) return;
  fresh.journaledUpTo = upTo;
  await store.saveConversation(fresh, { touch: false });
}

async function journalConversation(conv, from, settings) {
  const llm = require('./llm');
  const obsidian = require('./obsidian');
  const msgs = conv.messages.slice(from);
  const last = new Date(msgs[msgs.length - 1].createdAt || conv.updatedAt);
  // A message with attachments: what was typed and the files' names (attachcore.plainText), not their text.
  const transcript = msgs
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.attachments?.length ? attachcore.plainText(m) : String(m.content || '')).slice(0, 1200)}${m.toolCalls?.length ? `\n[tools: ${m.toolCalls.map((t) => `${t.name}${t.input?.path ? ` ${t.input.path}` : ''}`).join(', ')}]` : ''}`)
    .join('\n\n')
    .slice(-24000);
  const prompt = `Summarize this conversation between a user and their AI assistant as a daily-note session entry. Respond with ONLY a JSON object:
{"topic": "3-6 word topic", "outcome": "one past-tense sentence", "done": ["..."], "inProgress": ["..."], "decisions": ["..."], "notesTouched": ["vault note paths mentioned in tool calls"]}
Keep each list short (0-5 items), concrete and factual. Empty lists are fine. Do not invent anything.

CONVERSATION:
${transcript}`;
  // A failure here (the model, its JSON, the vault write) goes back to sweep(), which backs off.
  const fast = { ...settings, llm: { ...settings.llm, modelMode: 'fast' } };
  const text = await llm.complete(fast, prompt);
  const entry = (await require('./persona').jsonWithRetry(text, (fix) => llm.complete(fast, fix))) || {};
  await obsidian.logSession({
    date: ymd(last),
    time: last.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    topic: String(entry.topic || conv.title).slice(0, 80),
    outcome: entry.outcome,
    done: entry.done,
    inProgress: entry.inProgress,
    decisions: entry.decisions,
    notesTouched: entry.notesTouched,
  });
  await markJournaled(conv.id, conv.messages.length);
  log.info('journaled', { conversation: conv.id, date: ymd(last), topic: entry.topic });
}

function stop() {
  clearInterval(timer);
}

module.exports = { start, stop, sweep, backoffDelay, mayTry, afterFailure, stampOf, BACKOFF_FIRST_MS, BACKOFF_MAX_MS };
