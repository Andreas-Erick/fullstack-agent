// "Where we left off": when the app closes, the agent writes itself a short handoff note about the
// latest conversation (what was going on, open threads, next steps). The next session reads it in its
// system prompt (prompt.js), the chat shows it as a card with "Continue", and the launch greeting
// mentions it. Stored in <userData>/handoff.json, mirrored to "Where We Left Off.md" in the vault.
// Closing never waits long: the summary has a time limit and "Skip" cuts it short; either way a
// basic note (built without the model) is kept.
const path = require('path');
const store = require('./store');
const log = require('./logger');

const TIME_LIMIT_MS = 20000;
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // older notes are no longer offered
const VAULT_NOTE = 'Where We Left Off.md';

const file = () => path.join(store.dataDir(), 'handoff.json');
let skipNow = null; // resolves the running write early ("Skip" on the closing screen)

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
  skipNow?.();
  return true;
}

const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// The latest real conversation, plus the others touched since the last note.
async function pick(since) {
  const list = (await store.listConversations()).filter((c) => !c.setup && c.count > 0);
  for (const c of list) {
    const conv = await store.getConversation(c.id);
    if (conv?.messages.some((m) => m.role === 'user' && !m.hidden)) return { conv, others: list.filter((o) => o.id !== c.id && o.updatedAt > since).slice(0, 5) };
  }
  return null;
}

// Without the model: the title and the last thing the user asked.
function basicNote(conv, interrupted) {
  const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user' && !m.hidden);
  return {
    topic: clip(conv.title, 60),
    summary: `We were in “${clip(conv.title, 80)}”. The last thing you asked: “${clip(lastUser?.display ?? lastUser?.content, 220)}”.${interrupted ? ' A reply was still running when the app closed.' : ''}`,
    openThreads: [],
    nextSteps: [],
  };
}

async function summarize(settings, conv, interrupted) {
  const llm = require('./llm');
  const transcript = conv.messages
    .filter((m) => !m.hidden)
    .slice(-30)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${clip(m.display ?? m.content, 1500)}${m.toolCalls?.length ? `\n[tools: ${m.toolCalls.map((t) => t.name).join(', ')}]` : ''}`)
    .join('\n\n')
    .slice(-20000);
  // The note goes into every persona's prompt next time: "who I am … as Siren" in it made the
  // Ringmaster answer "I'm Siren". So it names no persona as the writer and records no identity talk.
  const prompt = `The user is closing the app. Write yourself a handoff note so that next time you can pick up exactly where you left off. Respond with ONLY a JSON object:
{"topic": "3-6 word topic", "summary": "2-4 sentences: what you were doing together and where it stands now", "openThreads": ["unfinished items or open questions"], "nextSteps": ["concrete next steps, in order"]}
Be concrete (names, files, numbers) and factual; do not invent anything. Lists may be empty (0-5 items each). The user has several personas and the next one may be another: call yourself "the assistant", never by a persona's name, and leave out who you are, which persona spoke and any switching between them; only the work counts.${interrupted ? '\nYour last reply was still running when the app closed, so it is missing below.' : ''}

CONVERSATION ("${clip(conv.title, 80)}"):
${transcript}`;
  const text = await llm.complete({ ...settings, llm: { ...settings.llm, modelMode: 'fast' } }, prompt);
  const json = require('./persona').extractJson(text);
  const list = (v) => (Array.isArray(v) ? v.map((x) => clip(x, 200)).filter(Boolean).slice(0, 5) : []);
  if (!json?.summary) throw new Error('No summary in the reply');
  return { topic: clip(json.topic || conv.title, 60), summary: clip(json.summary, 900), openThreads: list(json.openThreads), nextSteps: list(json.nextSteps) };
}

/** Writes the note for the latest conversation. Never throws; resolves within TIME_LIMIT_MS. */
async function write({ interrupted = false } = {}) {
  const started = Date.now();
  let timer;
  try {
    const settings = await store.getSettings();
    const prev = await store.readJson(file(), null);
    const found = await pick(prev?.at || 0);
    if (!found) return null;
    const { conv, others } = found;
    // Nothing new since the last note: keep it (and whether it was dismissed).
    if (prev?.conversationId === conv.id && prev.at >= conv.updatedAt && !interrupted) return prev;

    let body = basicNote(conv, interrupted);
    let source = 'basic';
    const skipped = new Promise((resolve) => (skipNow = resolve));
    const limit = new Promise((resolve) => (timer = setTimeout(resolve, TIME_LIMIT_MS)));
    const ai = summarize(settings, conv, interrupted).catch((err) => (log.warn('handoff summary failed', { error: err }), null));
    const result = await Promise.race([ai, skipped.then(() => null), limit.then(() => null)]);
    if (result) (body = result), (source = 'ai');

    const note = { at: Date.now(), conversationId: conv.id, title: clip(conv.title, 80), ...body, interrupted, others: others.map((o) => ({ id: o.id, title: clip(o.title, 80) })), source, dismissed: false };
    await store.writeJsonAtomic(file(), note);
    await mirrorToVault(settings, note).catch((err) => log.warn('handoff vault note failed', { error: err }));
    log.info('handoff written', { source, ms: Date.now() - started, conversation: conv.id.slice(-6) });
    return note;
  } catch (err) {
    log.warn('handoff failed', { error: err });
    return null;
  } finally {
    clearTimeout(timer);
    skipNow = null;
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
