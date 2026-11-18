// The pure part of the chat (js/chat.js): what a message shows, as data: tool chips (label, a short
// summary of the input, state, details), the tags, the HUD's telemetry stamp, the spoken filler for a
// tool. chat.js turns it into nodes. No DOM and no app state here, so test/chatcore.test.js covers it.

// Connector tools (mcp__<server>__<tool>, see main/connectors.js): "🔌 Todoist · find tasks".
export function connectorLabel(n) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(n || ''));
  if (!m || m[1] === 'nexus') return '';
  const service = m[1].replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ');
  return `🔌 ${service} · ${m[2].replace(/[-_]+/g, ' ')}`;
}

/** The chip's label: the app's own label, a connector's, or the raw name. */
export const toolLabel = (n, labels = {}) => labels[n] || connectorLabel(n) || `🔧 ${n}`;

/** "· notes/today.md": the one input worth showing next to the label (long paths shortened). */
export function briefInput(input) {
  if (!input) return '';
  const v = input.title || input.query || input.path || input.file_path || input.url || input.pattern || input.command || input.summary || input.setting || input.section || input.service || input.id || input.start_date || input.folder || '';
  if (!v) return '';
  let s = String(v);
  if (/^([a-z]:)?[\\/]/i.test(s)) s = s.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
  return `· ${s.slice(0, 60)}`;
}

/** A tool call as the chip shows it. t: { name, input, ok, preview }. */
export function toolChip(t, labels = {}) {
  return {
    state: t.ok === undefined ? 'running' : t.ok ? 'ok' : 'fail',
    label: toolLabel(t.name, labels),
    brief: briefInput(t.input),
    detail: `input: ${JSON.stringify(t.input, null, 1)}\n\n${t.preview ? `result: ${t.preview}` : 'running…'}`,
  };
}

/** The little tags over a message: a skill that ran, a shared screen. */
export const messageTags = (m) => [m.skill && `⚡ skill /${m.skill}`, m.screen && '🖥 screen shared'].filter(Boolean);

/** The model as the stamp writes it: "claude-opus-5-5" → "opus 5.5". */
export const modelName = (model) => String(model || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ');

/** The telemetry line the HUD shows on a reply (hud.css): "Siren · 14:32:05 · opus 5.5". */
export function stampText(m, agentName, timeText) {
  return [agentName, timeText, modelName(m.model)].filter(Boolean).join(' · ');
}

/** What a message is, for the node chat.js builds: tools, tags, and whether its text is Markdown. */
export function describeMessage(m, labels = {}) {
  return {
    role: m.role,
    tools: (m.toolCalls || []).map((t) => toolChip(t, labels)),
    tags: messageTags(m),
    markdown: m.role === 'assistant',
    text: m.role === 'assistant' ? m.content || '' : m.display || m.content || '',
  };
}

const newest = (items, key) => items.reduce((best, c) => (!best || (c[key] || 0) > (best[key] || 0) ? c : best), null);

/** The chat opened at launch, from the conversation index (main/store.js): the one the user last wrote
 *  in, not a routine's run that came later; the setup conversation only when there is nothing else. */
export function launchConversation(list) {
  const items = (list || []).filter(Boolean);
  if (!items.length) return null;
  const mine = items.filter((c) => !c.setup && c.lastOwnAt > 0);
  if (mine.length) return newest(mine, 'lastOwnAt');
  return newest(items.filter((c) => !c.routine && !c.setup), 'updatedAt') || items[0];
}

/** A History row: a routine's conversation (no message of the user's own; also the tasks sync) is marked
 *  ⏰, once (its title usually starts with the run's own ⏰ or 🔄 already). */
export function historyTitle(c) {
  const title = c.title || 'Untitled';
  if (!c.routine) return { text: title, tip: title };
  return { text: /^(⏰|🔄)/u.test(title) ? title : `⏰ ${title}`, tip: `${title} (started by a routine or the app, not by you)` };
}

// What the voice says while a tool runs, by the kind of tool.
export const FILLERS = {
  web: ['Let me look that up.', 'Searching the web.', 'One moment, checking online.'],
  calendar: ['Checking your calendar.', 'Let me look at your schedule.'],
  vault: ['Let me check my notes.', 'Looking through the vault.'],
  code: ['Let me look at my code.', 'Checking how I work.'],
  doc: ['Opening that now.', 'Reading the document.'],
  other: ['One moment.', 'On it.', 'Give me a second.'],
  think: ['Let me see.', 'Just a moment.', 'Hmm, let me check.'],
};

// A spoken message heard nothing for 4–11 s when the reply started with tools or long thinking (the
// tool filler only came with the first tool). After this long without a word, a short line says the
// message arrived. Not for small talk, which is answered quickly, and not for one or two words.
export const EARLY_FILLER_MS = 1800;
const SMALL_TALK = /^(hi|hey|hello|hallo|yo|how are (you|u|ya)|how'?s it going|how have you been|what'?s up|wie geht'?s|good (morning|afternoon|evening|night)|guten (morgen|tag|abend)|gute nacht|thanks?|thank you|danke|cool|great|nice|perfect|awesome|ok(ay)?|yes|no|yeah|nope|bye|see you|tsch[uü]ss)\b/i;
export function earlyFiller(text, random = Math.random) {
  const t = String(text || '').trim().replace(/[‘’ʼ]/g, "'");
  if (t.split(/\s+/).filter(Boolean).length < 3 || (t.length <= 60 && SMALL_TALK.test(t))) return null;
  return FILLERS.think[Math.floor(random() * FILLERS.think.length)];
}
/** Every filler line, to make their audio ahead of time (voice.js warmFillers). */
export const allFillers = () => [...new Set(Object.values(FILLERS).flat())];
export const fillerGroup = (name) => (/web|Web/.test(name) ? 'web' : /calendar/.test(name) ? 'calendar' : /vault|daily|priorit|job|profile/.test(name) ? 'vault' : /code|Read|Grep|Glob|Edit|Write|self/.test(name) ? 'code' : /document/.test(name) ? 'doc' : 'other');
export function fillerFor(name, random = Math.random) {
  const list = FILLERS[fillerGroup(name)];
  return list[Math.floor(random() * list.length)];
}
