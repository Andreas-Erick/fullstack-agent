// "Where we left off": when the app closes, the agent writes itself a short handoff note about the
// user's latest own conversation (what was going on, open threads, next steps; a routine's run is never
// the topic). The next session reads it in its system prompt (prompt.js), the chat shows it as a card
// with "Continue", and the launch greeting mentions it. Stored in <userData>/handoff.json, mirrored to
// "Where We Left Off.md" in the vault. The window is already hidden meanwhile (main.js closeWithHandoff);
// the summary has a time limit and skip() (the window asked for again: main.js showMain) cuts it short;
// either way a basic note (built without the model) is kept, and the next close tries the model again.
// One write at a time.
const path = require('path');
const store = require('./store');
const log = require('./logger');
const attachcore = require('./attachcore');

// What a message says in the note's sources: with attachments, what was typed and the files' names.
const said = (m) => (m?.attachments?.length ? attachcore.plainText(m) : m?.display ?? m?.content);

const TIME_LIMIT_MS = 20000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // older notes are no longer offered
const VAULT_NOTE = 'Where We Left Off.md';

const file = () => path.join(store.dataDir(), 'handoff.json');
const skips = new Set(); // resolvers of the summaries being waited for; skip() cuts them all short
let skipCount = 0; // skip() calls so far: a write asked for before one doesn't start the summary at all
let running = Promise.resolve(); // the write in progress: the next one waits for it

// The user's own words, as store.js ownMessage: not hidden, not a routine's run, not app-started (auto,
// or the tasks sync's display on its messages from before that marker).
const own = (m) => m.role === 'user' && !m.hidden && !m.routine && !m.auto && m.display !== store.TASKS_SYNC_DISPLAY;

async function read() {
  const note = await store.readJson(file(), null);
  if (!note?.at || Date.now() - note.at > MAX_AGE_MS) return null;
  return note;
}

async function dismiss() {
  const note = await read();
  if (note && !note.dismissed) await store.writeJsonAtomic(file(), { ...note, dismissed: true });
  return true;
}

function skip() {
  skipCount++;
  for (const cut of skips) cut();
  skips.clear();
  return true;
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// The conversation the user last wrote in (the index's lastOwnAt; a routine's chat updated later doesn't
// count), plus the others touched since the last note. None of the user's own: no note.
async function pick(since) {
  const latest = (c) => c.lastOwnAt ?? c.updatedAt;
  const list = (await store.listConversations()).filter((c) => !c.setup && c.count > 0 && !c.routine).sort((a, b) => latest(b) - latest(a));
  for (const c of list) {
    const conv = await store.getConversation(c.id);
    if (conv?.messages.some(own)) return { conv, others: list.filter((o) => o.id !== c.id && o.updatedAt > since).slice(0, 5) };
  }
  return null;
}

// Without the model: the title and the last thing the user asked.
function basicNote(conv, interrupted) {
  const lastUser = [...conv.messages].reverse().find(own);
  return {
    topic: clip(conv.title, 60),
    summary: `We were in “${clip(conv.title, 80)}”. The last thing you asked: “${clip(said(lastUser), 220)}”.${interrupted ? ' A reply was still running when the app closed.' : ''}`,
    openThreads: [],
    nextSteps: [],
  };
}

async function summarize(settings, conv, interrupted) {
  const llm = require('./llm');
  const transcript = conv.messages
    .filter((m) => !m.hidden)
    .slice(-30)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(said(m), 1500)}${m.toolCalls?.length ? `\n[tools: ${m.toolCalls.map((t) => t.name).join(', ')}]` : ''}`)
    .join('\n\n')
    .slice(-20000);
  // The note goes into every persona's prompt next time: "who I am … as Siren" in it made the
  // Ringmaster answer "I'm Siren". So it names no persona as the writer and records no identity talk.
  const prompt = `The user is closing the app. Write yourself a handoff note so that next time you can pick up exactly where you left off. Respond with ONLY a JSON object:
{"topic": "3-6 word topic", "summary": "2-4 sentences: what you were doing together and where it stands now", "openThreads": ["unfinished items or open questions"], "nextSteps": ["concrete next steps, in order"]}
Be concrete (names, files, numbers) and factual; do not invent anything. Lists may be empty (0-5 items each). The user has several personas and the next one may be another: call yourself "the assistant", never by a persona's name, and leave out who you are, which persona spoke and any switching between them; only the work counts.${interrupted ? '\nYour last reply was still running when the app closed, so it is missing below.' : ''}

CONVERSATION ("${clip(conv.title, 80)}"):
${transcript}`;
  const fast = { ...settings, llm: { ...settings.llm, modelMode: 'fast' } };
  const text = await llm.complete(fast, prompt);
  const json = await require('./persona').jsonWithRetry(text, (fix) => llm.complete(fast, fix));
  const list = (v) => (Array.isArray(v) ? v.map((x) => clip(x, 200)).filter(Boolean).slice(0, 5) : []);
  if (!json?.summary) throw new Error('No summary in the reply');
  return { topic: clip(json.topic || conv.title, 60), summary: clip(json.summary, 900), openThreads: list(json.openThreads), nextSteps: list(json.nextSteps) };
}

/** Writes the note for the user's latest conversation. Never throws; each write ends within TIME_LIMIT_MS.
 *  A call while one runs waits for it (then usually finds nothing new: one model call, not two).
 *  replying: the ids of the conversations with a reply still being written (turns.replying(), main/turns.js); the
 *  note is "interrupted" only when its own conversation is one. interrupted: true/false decides outright. */
function write(opts = {}) {
  const skipsBefore = skipCount;
  const job = running.then(() => writeNow(opts, skipsBefore));
  running = job.catch(() => null); // the queue only orders the work; each caller gets its own error
  return job;
}

async function writeNow({ interrupted: told, replying = null }, skipsBefore) {
  const started = Date.now();
  let timer;
  let cut;
  try {
    const settings = await store.getSettings();
    const prev = await store.readJson(file(), null);
    const found = await pick(prev?.at || 0);
    if (!found) return null;
    const { conv, others } = found;
    const interrupted = told ?? replying?.has(conv.id) ?? false;
    // Nothing new since the last note: keep it (and whether it was dismissed). A basic one (skipped, timed
    // out, the model failed) is tried again with the model, still dismissed if it was.
    const same = prev?.conversationId === conv.id && prev.at >= conv.updatedAt;
    if (same && !interrupted && prev.source === 'ai') return prev;

    let body = basicNote(conv, interrupted);
    let source = 'basic';
    if (skipCount === skipsBefore) {
      const skipped = new Promise((resolve) => skips.add((cut = resolve)));
      const limit = new Promise((resolve) => (timer = setTimeout(resolve, TIME_LIMIT_MS)));
      const ai = summarize(settings, conv, interrupted).catch((err) => (log.warn('handoff summary failed', { error: err }), null));
      const result = await Promise.race([ai, skipped.then(() => null), limit.then(() => null)]);
      if (result) (body = result), (source = 'ai');
    }

    const note = { at: Date.now(), conversationId: conv.id, title: clip(conv.title, 80), ...body, interrupted, others: others.map((o) => ({ id: o.id, title: clip(o.title, 80) })), source, dismissed: same && prev.dismissed === true };
    await store.writeJsonAtomic(file(), note);
    await mirrorToVault(settings, note).catch((err) => log.warn('handoff vault note failed', { error: err }));
    log.info('handoff written', { source, ms: Date.now() - started, conversation: conv.id.slice(-6) });
    return note;
  } catch (err) {
    log.warn('handoff failed', { error: err });
    return null;
  } finally {
    clearTimeout(timer);
    skips.delete(cut);
  }
}

async function mirrorToVault(settings, note) {
  if (!settings.obsidian?.enabled) return;
  const obsidian = require('./obsidian');
  if (!(await obsidian.vaultPath())) return;
  const items = (title, list) => (list.length ? `\n## ${title}\n${list.map((x) => `- ${x}`).join('\n')}\n` : '');
  const text = `# Where we left off\n\n_${new Date(note.at).toLocaleString()} · conversation “${note.title}”_\n\n${note.summary}\n${items('Open threads', note.openThreads)}${items('Next steps', note.nextSteps)}${items('Also touched', note.others.map((o) => o.title))}\n_Written by the assistant when the app closed; replaced each time._\n`;
  await obsidian.writeNote(VAULT_NOTE, text, 'overwrite', { source: 'handoff' });
}

// For the system prompt: the note from last time. Written by whichever persona was active then, so
// its "I" is not the reader's identity (an older note said "who I am … as Siren" to every persona).
async function promptBlock(name = '') {
  const note = await read();
  if (!note) return '';
  const when = new Date(note.at).toLocaleString();
  const self = name ? ` It says what was done, not who you are: you are ${name}, whatever its "I" or any name in it says.` : '';
  const lines = [`## Where you left off (the handoff note the assistant wrote when the app closed, ${when})`, `Conversation: “${note.title}”${note.interrupted ? ' (the last reply was cut off by the app closing)' : ''}${self}`, note.summary];
  if (note.openThreads?.length) lines.push(`Open threads:\n${note.openThreads.map((x) => `- ${x}`).join('\n')}`);
  if (note.nextSteps?.length) lines.push(`Next steps:\n${note.nextSteps.map((x) => `- ${x}`).join('\n')}`);
  lines.push('If the user wants to continue (or asks what you were doing), pick up from here. Do not bring it up unprompted in an unrelated conversation; it may be out of date, so check the real state before acting on it.');
  return lines.join('\n');
}

module.exports = { read, write, dismiss, skip, promptBlock };
