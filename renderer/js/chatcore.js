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

/** What Copy on a message copies: what its bubble shows (a /skill as typed, not its steps). */
export const copyText = (m) => describeMessage(m).text;

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

// ------------------------------------------------------------ failed replies
// A failed reply in plain words, with the way out (chat.js errorNode; the phone shows the same). The raw
// message stays under Details. First match wins; the patterns follow the messages main/ actually throws.

/** HH:MM today, else the weekday and HH:MM. */
function hhmm(ms, now = Date.now()) {
  const d = new Date(ms);
  if (d.toDateString() === new Date(now).toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

const BRAIN = { label: 'Open AI brain settings', go: 'settings', section: 'brain' };
const NETWORK = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|socket hang up|connection error|network/i;
const OPENAI_PATH = ['local', 'gemini', 'deepseek', 'groq', 'perplexity']; // providers with their own base URL (main/router.js concrete)
const LOCAL_HOST = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

// The address the chosen brain talks to, when it is on the OpenAI path (FreeLLMAPI, a local model…).
function brainAddress(settings) {
  const id = settings?.llm?.provider || '';
  const base = id === 'openai' ? settings.llm.baseUrl : OPENAI_PATH.includes(id) ? settings?.[id]?.baseUrl : '';
  return { id, base: String(base || '') };
}

// When the plan's limit resets: Claude Code's "limit reached|<epoch>", the usage meter's tightest full
// window, or the words after "resets".
function resetTime(raw, { usage, now, time }) {
  const epoch = /limit reached\|(\d{10})/i.exec(raw);
  if (epoch) return time(Number(epoch[1]) * 1000, now);
  if (usage?.limited) {
    const at = (usage.windows || []).filter((w) => w.used >= 0.99 && w.resetsAt).map((w) => w.resetsAt * 1000).sort((a, b) => a - b)[0];
    if (at) return time(at, now);
  }
  const words = /\bresets?\s+(?:at\s+)?([^.\n]{1,40})/i.exec(raw);
  return words ? words[1].trim() : '';
}

/**
 * A failed reply's message → { kind, title, text, action, retry, raw }. action: { label, go: 'settings',
 * section } | { label, go: 'helper', id } | { label, go: 'newchat' } | { label, go: 'edit' } | null.
 * settings / usage (optional) make it exact: which brain, when the plan resets. time: a formatter (tests).
 */
export function errorHelp(message, { usage = null, settings = null, now = Date.now(), time = hhmm } = {}) {
  const raw = String(message ?? '').trim().slice(0, 2000);
  const first = (raw.split('\n').find((l) => l.trim()) || '').trim().slice(0, 200);
  const out = (kind, title, text, action = null) => ({ kind, title, text, action, retry: true, raw });

  // Multi-provider mode stopped after a brain had already acted (main/llm.js runTurn): its own words say it best.
  if (/already used tools, so this reply was not repeated/i.test(raw)) return out('toolsran', 'The brain failed partway', raw);
  if (/No AI provider is ready|No model selected|Choose a model|not installed|No provider could answer|Add your Anthropic API key/i.test(raw)) {
    const list = /No provider could answer:\s*([\s\S]+)/i.exec(raw);
    if (list) return out('notready', 'No brain could answer', list[1].trim().slice(0, 300), BRAIN);
    if (/No model selected|Choose a model/i.test(raw)) return out('notready', 'No model is chosen', 'Choose a model in Settings → AI brain.', BRAIN);
    if (/not installed/i.test(raw)) return out('notready', 'Claude Code isn’t installed', 'Install it and connect your Claude account, or pick another brain in Settings → AI brain.', BRAIN);
    return out('notready', 'No brain is ready', 'Connect your Claude account or add an API key in Settings → AI brain.', BRAIN);
  }
  if (/usage limit reached|(you['’]?ve|you have) hit your (\w+ )?limit|\d+-hour limit reached|spend limit|out of usage credits/i.test(raw)) {
    const at = resetTime(raw, { usage, now, time });
    return out('limit', 'Your Claude plan’s limit is reached', `${at ? `It resets at ${at}.` : 'It resets after a while.'} Until then you can pick another brain in Settings → AI brain.`, BRAIN);
  }
  if (/credit balance|insufficient[_ ](balance|credit|funds|quota)|payment required|exceeded your current quota|\b402\b/i.test(raw)) return out('credits', 'The brain is out of credits', 'Add credits with the provider, or pick another brain in Settings → AI brain.', BRAIN);
  if (/\b429\b|rate.?limit|too many requests|resource.?exhausted/i.test(raw)) return out('rate', 'The brain is busy right now', 'It hit its rate limit. Wait a moment, then try again.');
  if (/overloaded|\b529\b/i.test(raw)) return out('overloaded', 'The brain is overloaded', 'Try again in a minute.');
  if (/not signed in|log ?in|\/login|oauth|credential|authenticat|unauthori[sz]ed|invalid.{0,20}key|\b40[13]\b/i.test(raw)) return out('signin', 'The brain isn’t signed in', 'Connect your Claude account or check the key in Settings → AI brain.', BRAIN);
  const { id, base } = brainAddress(settings);
  const named = /nothing answers at|isn['’]t running/i.test(raw);
  if (named || (NETWORK.test(raw) && LOCAL_HOST.test(base))) {
    const at = /nothing answers at ([^\s:()]+)(?::(\d+))?/i.exec(raw);
    const port = at?.[2] || (/:(\d+)/.exec(base.replace(/^https?:\/\//i, '')) || [])[1] || '';
    if (port === '11434' || port === '1234') return out('local-down', 'Ollama / LM Studio isn’t running', 'Start Ollama or LM Studio, then try again.', BRAIN);
    if (id === 'local') return out('local-down', 'Your local model’s server isn’t running', 'Start it, then try again, or check its address in Settings → AI brain.', BRAIN);
    // A server somewhere else (not this computer) that doesn't answer: not FreeLLMAPI's to start.
    if (at && !/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(at[1])) return out('local-down', 'The brain’s server doesn’t answer', first, BRAIN);
    return out('local-down', 'FreeLLMAPI isn’t running', 'Start it, then try again.', { label: 'Start FreeLLMAPI', go: 'helper', id: 'freellmapi' });
  }
  if (/No conversation found with session ID/i.test(raw)) return out('session', 'The Claude session couldn’t be reopened', 'Try again starts a fresh one with your recent messages.');
  if (NETWORK.test(raw)) return out('network', 'Couldn’t reach the brain', 'Check the internet connection, then try again.');
  if (/did not respond in time|timed? ?out|Stopped after \d+ minutes/i.test(raw)) return out('timeout', 'The brain took too long', 'It didn’t answer in time. Try again in a moment.');
  if (/Claude Code exited \(code/i.test(raw)) return out('exited', 'Claude Code stopped unexpectedly', 'Try again; Health → Run checks shows why if it keeps happening.');
  if (/prompt is too long|context.{0,20}(length|window)|maximum context|too many tokens/i.test(raw)) {
    const text = id === 'claude-code' ? 'Try again starts a fresh session with your recent messages.' : 'Start a new chat (your notes and memories carry over), or send a shorter message.';
    return out('toolong', 'This conversation is too long for the brain', text, { label: '＋ New chat', go: 'newchat' });
  }
  if (/declined this request/i.test(raw)) return out('declined', 'The model declined to answer', 'You can change your message and send it again.', { label: '✎ Edit message', go: 'edit' });
  if (/LLM error 5\d\d|internal server error|bad gateway|service unavailable/i.test(raw)) return out('server', 'The brain’s server had a problem', 'Try again in a moment.');
  if (/LLM error 4\d\d/.test(raw)) {
    const said = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
    return out('badrequest', 'The brain refused the request', said ? said[1].replace(/\\(.)/g, '$1').slice(0, 200) : first);
  }
  return out('default', 'Something went wrong', first || 'The reply failed.');
}
