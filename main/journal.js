// Auto-journal: when a conversation goes quiet, write a session entry (what got done, in progress,
// decisions, notes touched) to the day's daily note in the vault. Conversations from earlier runs that
// were never journaled are reconstructed on startup, so the daily notes stay continuous.
const store = require('./store');
const log = require('./logger');

let timer = null;
let running = false;

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function start() {
  clearInterval(timer);
  timer = setInterval(() => sweep().catch((e) => log.warn('journal sweep', e.message)), 60000);
  setTimeout(() => sweep().catch((e) => log.warn('journal sweep', e.message)), 20000);
}

async function sweep() {
  if (running) return;
  const s = await store.getSettings();
  if (!s.journal.enabled || !s.obsidian.enabled) return;
  running = true;
  try {
    const idleMs = (s.journal.idleMinutes ?? 15) * 60000;
    for (const c of await store.listConversations()) {
      if (Date.now() - c.updatedAt < idleMs) continue;
      const conv = await store.getConversation(c.id);
      const from = conv?.journaledUpTo || 0;
      const fresh = (conv?.messages || []).slice(from);
      if (fresh.filter((m) => m.role === 'user').length < 1 || fresh.length < 2) continue;
      await journalConversation(conv, from, s);
    }
  } finally {
    running = false;
  }
}

async function journalConversation(conv, from, settings) {
  const llm = require('./llm');
  const obsidian = require('./obsidian');
  const msgs = conv.messages.slice(from);
  const last = new Date(msgs[msgs.length - 1].createdAt || conv.updatedAt);
  const transcript = msgs
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 1200)}${m.toolCalls?.length ? `\n[tools: ${m.toolCalls.map((t) => `${t.name}${t.input?.path ? ` ${t.input.path}` : ''}`).join(', ')}]` : ''}`)
    .join('\n\n')
    .slice(-24000);
  const prompt = `Summarize this conversation between a user and their AI assistant as a daily-note session entry. Respond with ONLY a JSON object:
{"topic": "3-6 word topic", "outcome": "one past-tense sentence", "done": ["..."], "inProgress": ["..."], "decisions": ["..."], "notesTouched": ["vault note paths mentioned in tool calls"]}
Keep each list short (0-5 items), concrete and factual. Empty lists are fine. Do not invent anything.

CONVERSATION:
${transcript}`;
  let entry;
  try {
    const text = await llm.complete({ ...settings, llm: { ...settings.llm, modelMode: 'fast' } }, prompt);
    entry = require('./persona').extractJson(text);
  } catch (err) {
    log.warn('journal summarize failed', err.message);
    return;
  }
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
  const fresh = await store.getConversation(conv.id);
  if (fresh) {
    fresh.journaledUpTo = conv.messages.length;
    await store.saveConversation(fresh, { touch: false });
  }
  log.info('journaled', { conversation: conv.id, date: ymd(last), topic: entry.topic });
}

function stop() {
  clearInterval(timer);
}

module.exports = { start, stop, sweep };
