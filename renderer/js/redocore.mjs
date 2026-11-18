// Running the user's latest message again (Try again, Regenerate, Edit and resend): which message,
// what is dropped, when the Claude session starts fresh, and what the new turn is told about the
// earlier one. Pure, no imports: main/redo.js requires it (like chartcore.mjs) and renderer/js/chat.js
// imports it, so both sides apply the same rules (test/redocore.test.js).

/** What the tasks sync's message shows (= store.TASKS_SYNC_DISPLAY, main/store.js ownMessage). */
export const TASKS_SYNC_DISPLAY = '🔄 Sync my tasks for the calendar';
export const MAX_TEXT = 20000;
const LISTED = 12; // acted / ask entries handed on (the window's confirm, the notice)
const NOTE_LINES = 8; // actions named in the context note
const BRIEF = 160;
const ATTEMPT_TOOLS = 20;

/** The user's own words: not a hidden prompt, a routine's run, a turn the app started, or an old import without an id. */
export const isOwn = (m) => m?.role === 'user' && Boolean(m.id) && !m.hidden && !m.routine && !m.auto && m.display !== TASKS_SYNC_DISPLAY;

/** A reply that was stopped before it said anything worth keeping (API paths store one). */
export const isStoppedReply = (m) => m?.role === 'assistant' && (m.stopped === true || String(m.content || '').trim() === '*(stopped)*');

/** What the user sent, as they typed it: a /skill as typed (not its steps), a message with files its typed words. */
export const sentText = (m) => (m?.skill && m.display ? String(m.display) : m?.attachments?.length ? String(m.display || '') : String(m?.content || ''));

/** A call of an earlier attempt that never reported back (attemptRecord's ok: null): it may or may not have happened. */
export const cutOff = (t) => t?.ok === null;

/**
 * At most n of the calls, the ones `first` picks ahead of the rest, in their original order. Every cap takes
 * the cut-off calls first: the call in flight at a stop is the last one started, and a first-n slice dropped
 * it into a count that every surface calls done.
 */
function keepFirst(list, n, first) {
  const order = list.map((_t, i) => i);
  const kept = new Set([...order.filter((i) => first(list[i])), ...order.filter((i) => !first(list[i]))].slice(0, n));
  return list.filter((_t, i) => kept.has(i));
}

const count = (n) => Math.max(0, Math.floor(Number(n) || 0));

/** Two messages are the same when they are after this: lower case, letters and digits, single spaces. */
export const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The title startTurn gives a conversation from its first message (main/main.js); a /skill's is its name.
 * A message with files is titled by its typed words, else by the files (attachcore.compose: summary, '📎 a.pdf, b.png').
 */
export function autoTitle(m) {
  if (m?.skill) return null;
  const files = Array.isArray(m?.attachments) && m.attachments.length ? m.attachments : null;
  const t = files ? String(m.display || '').trim() || `📎 ${files.map((a) => a?.name).join(', ')}` : String(m?.display || m?.content || '');
  return t.replace(/\s+/g, ' ').slice(0, 60);
}

/** Whether a message has anything to send again: words, or files (pictures are never kept). */
const resendable = (m) => Boolean(sentText(m).trim()) || (m?.attachments || []).some((a) => a?.kind !== 'image');

const oneLine = (s, max = BRIEF) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const BRIEF_KEYS = ['title', 'query', 'path', 'file_path', 'url', 'pattern', 'command', 'summary', 'id'];

/** A tool's input in one short line: its telling field (a title, a path, a query…), else the JSON. */
export function briefOf(input) {
  if (input == null) return '';
  if (typeof input !== 'object') return oneLine(input);
  const key = BRIEF_KEYS.find((k) => input[k] != null && String(input[k]).trim());
  if (key) return oneLine(input[key]);
  const json = JSON.stringify(input);
  return json === '{}' || json === '[]' ? '' : oneLine(json);
}

export const withoutAttempt = (m) => {
  const { attempt, ...rest } = m || {};
  return rest;
};

/**
 * The latest exchange: the last user message (any kind) and the replies after it. state: 'answered',
 * 'stopped' (only stopped replies) or 'unanswered'. An unanswered one is certain only when its attempt
 * says how it ended (failed or stopped, all of it recorded); a quit, a crash or old data leave it uncertain.
 */
export function latest(messages) {
  const list = Array.isArray(messages) ? messages : [];
  let index = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role === 'user') {
      index = i;
      break;
    }
  }
  if (index < 0) return null;
  const user = list[index];
  const replies = list.slice(index + 1).filter((m) => m?.role === 'assistant');
  const state = !replies.length ? 'unanswered' : replies.every(isStoppedReply) ? 'stopped' : 'answered';
  const a = user.attempt;
  const certain = state !== 'unanswered' || Boolean(a && (a.outcome === 'failed' || a.outcome === 'stopped') && !a.partial);
  return { index, user, replies, own: isOwn(user), state, certain };
}

/** What the chat offers on the latest exchange: ids, or null. busy: a reply is being written there. */
export function actions(messages, { busy = false, setup = false } = {}) {
  const none = { again: null, edit: null, reply: null, state: null, certain: true };
  const l = latest(messages);
  if (!l || !l.own || busy || setup) return none;
  const last = l.replies[l.replies.length - 1];
  return {
    again: l.user.id,
    edit: l.user.id,
    reply: l.state === 'answered' && last?.id ? last.id : null,
    state: l.state,
    certain: l.certain,
  };
}

const STALE_OR_LONG = /No conversation found with session ID|Prompt is too long|context.{0,20}(length|window)|maximum context/i;

/**
 * The plan for running the latest message again. req: { messageId, kind: 'again'|'edit', text, expectLast }.
 * Refused: { ok: false, error, changed? }. Else what is cut, sent, said and asked (see the fields below).
 */
export function plan(messages, req, { title = '', hasSession = false, readOnly = () => false, harmless = () => false, tainting = () => false } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const refuse = (error, extra = {}) => ({ ok: false, error, ...extra });
  // The window's view is stale (a phone turn, another device): it reloads instead.
  if (req?.expectLast && req.expectLast !== list[list.length - 1]?.id) return refuse('This conversation changed since you opened it. Have a look, then try again.', { changed: true });
  const l = latest(list);
  if (!l || !l.own || l.user.id !== req?.messageId) return refuse('Only your latest message can be sent again.');
  const user = l.user;
  let kind = req.kind === 'edit' ? 'edit' : 'again';
  let text = sentText(user);
  let voice = Boolean(user.spoken);
  if (kind === 'edit') {
    const typed = String(req.text ?? '').trim();
    const files = (user.attachments || []).some((a) => a?.kind !== 'image');
    if (!typed && !files) return refuse('The message is empty.');
    if (typed.length > MAX_TEXT) return refuse('The message is too long.');
    if (norm(typed) === norm(text)) kind = 'again';
    else {
      text = typed;
      voice = false;
    }
  }
  // Nothing left to send (a message that was only a picture; an Edit to the same nothing): never an empty turn.
  if (kind === 'again' && !resendable(user)) {
    const picture = Boolean(user.screen || user.attachments?.some((x) => x?.kind === 'image'));
    return refuse(picture ? 'This message was only a picture, and pictures aren’t kept: attach it again and send it.' : 'The message is empty.');
  }
  const a = user.attempt || null;
  const replyDropped = l.state === 'answered';
  const fromClaude = (m) => m.provider === 'claude-code' || (!m.provider && hasSession);
  // The Claude session must never keep a reply that is withdrawn. Trying again after a failure keeps it
  // (it holds only the failed attempt at this same message) unless it can't be resumed or is too long.
  const staleOrLong = STALE_OR_LONG.test(String(a?.error || ''));
  const resetSession = l.state === 'unanswered' ? staleOrLong || (kind === 'edit' && Boolean(a?.output)) : l.replies.some(fromClaude);
  // What the dropped replies and the attempt did (tools that read only don't count).
  const dropped = [
    ...l.replies.flatMap((r) => (Array.isArray(r.toolCalls) ? r.toolCalls : []).map((t) => ({ name: String(t?.name || ''), ok: t?.ok, input: t?.input }))),
    ...(l.state === 'unanswered' && Array.isArray(a?.tools) ? a.tools.map((t) => ({ name: String(t?.name || ''), ok: t?.ok, input: t?.brief || '' })) : []),
  ];
  const acted = dropped.filter((t) => t.name && t.ok !== false && !readOnly(t.name));
  // Actions past the attempt record's limit (attemptRecord) are known only by their number, so asked about:
  // the reported ones (more) as done; cut-off ones (moreCut) through the cut-off calls it names, harmless or not.
  const more = l.state === 'unanswered' ? count(a?.more) : 0;
  const moreCut = l.state === 'unanswered' ? count(a?.moreCut) : 0;
  const ask = acted.filter((t) => !harmless(t.name) || (moreCut > 0 && cutOff(t)));
  const uncertain = l.state === 'unanswered' && !l.certain;
  const firstUser = list.findIndex((m) => m?.role === 'user') === l.index;
  const listed = keepFirst(acted, LISTED, cutOff);
  return {
    ok: true,
    kind,
    cut: l.index,
    text,
    voice,
    replaces: user.id,
    user,
    state: l.state,
    replyDropped,
    resetSession,
    acted: listed,
    unsure: listed.filter(cutOff), // cut off before they reported back: a subset of acted, the same objects
    ask: keepFirst(ask, LISTED, cutOff),
    more,
    uncertain,
    taint: !resetSession && (dropped.some((t) => tainting(t.name)) || (l.state === 'unanswered' && a?.tainted === true)),
    keepTitle: !firstUser || Boolean(user.skill) || title !== autoTitle(user),
    hadImages: Boolean(user.screen || user.attachments?.some((x) => x?.kind === 'image')),
    note: noteFor({ kind, replyDropped, failed: !replyDropped, sameSession: !resetSession, acted, more, moreCut, uncertain }),
  };
}

/** The same text sent again after a failure (watch, phone, by hand): applied as Try again, or null. */
export function supersedes(messages, text, opts = {}) {
  const l = latest(messages);
  if (!l || !l.own || l.state === 'answered' || l.user.attachments?.length) return null;
  const t = norm(text);
  if (!t || t !== norm(sentText(l.user))) return null;
  const p = plan(messages, { kind: 'again', messageId: l.user.id }, opts);
  return p.ok ? p : null;
}

/** Marks that count messages (main/journal.js, llm.js compactHistory) after a cut at `cut`. */
export function clampMarks(conv, cut) {
  const out = {};
  if (typeof conv?.journaledUpTo === 'number' && conv.journaledUpTo > cut) out.journaledUpTo = cut;
  if (typeof conv?.summaryUpTo === 'number' && cut < conv.summaryUpTo) Object.assign(out, { summary: '', summaryUpTo: 0 });
  return out;
}

const REGENERATED = 'The user asked for a new reply to this message; your earlier reply to it was withdrawn and is not shown.';
const EDITED = 'The user edited this message after your reply; the earlier version and your reply were withdrawn.';
const REWROTE = 'The user rewrote their previous message, which got no reply; answer only this version.';
const UNFINISHED = 'Your earlier attempt at this message did not finish.';
const CUT_OFF = 'An earlier attempt at this message was cut off (the app closed or restarted), so it may already have done part of it. Check before repeating anything (the schedule, memories, notes, files).';

/**
 * What the new turn is told about the earlier one (prompt.turnContext's "Answering this message again"); '' for nothing.
 * more / moreCut: the reported and the cut-off actions past the attempt record's limit, each counted with
 * the unnamed ones of its kind.
 */
export function noteFor({ kind = 'again', replyDropped = false, failed = false, sameSession = false, acted = [], more = 0, moreCut = 0, uncertain = false } = {}) {
  const lines = [];
  if (replyDropped) lines.push(kind === 'edit' ? EDITED : REGENERATED);
  else {
    if (kind === 'edit' && sameSession) lines.push(REWROTE);
    if (uncertain) lines.push(CUT_OFF);
    else if (failed && kind !== 'edit') lines.push(UNFINISHED);
  }
  const list = Array.isArray(acted) ? acted : [];
  // Split before the cap, the cut-off calls named first: they are the ones to check.
  const cutAll = list.filter(cutOff);
  const doneAll = list.filter((t) => !cutOff(t));
  const cut = cutAll.slice(0, NOTE_LINES);
  const done = doneAll.slice(0, NOTE_LINES - cut.length);
  const restCut = cutAll.length - cut.length + count(moreCut);
  const restDone = doneAll.length - done.length + count(more);
  const line = (t) => oneLine(`- ${t.name} ${typeof t.input === 'string' ? t.input : JSON.stringify(t.input ?? {})}`, BRIEF);
  if (done.length || restDone) {
    lines.push(uncertain ? 'These are known to have happened; there may be more:' : 'These actions from it already happened and were not undone:', ...done.map(line));
    if (restDone) lines.push(`…and ${restDone} more`);
    lines.push("Don't do them again unless the user asks.");
  }
  if (cut.length || restCut) {
    lines.push('These were cut off before they reported back; check whether they happened (the schedule, the repository, the service) before doing them again:', ...cut.map(line));
    if (restCut) lines.push(`…and ${restCut} more`);
  }
  return lines.join('\n');
}

/**
 * How an attempt at a message went, as stored on it (main.js startTurn): normalized and bounded. Only the
 * calls that may have changed something are listed (reads, and calls that failed, did nothing to repeat),
 * so a long run of reads never pushes an action out. Those that never reported back are kept first (in
 * their order with the rest): `more` counts the reported actions past the limit, `moreCut` the cut-off ones,
 * and `tainted` says whether any call brought in outside content (a kept session still holds it).
 */
export function attemptRecord({ outcome = 'failed', at = Date.now(), error = '', ran = [], output = false, partial = false, readOnly = () => false, tainting = () => false } = {}) {
  const kind = ['running', 'failed', 'stopped'].includes(outcome) ? outcome : 'failed';
  const calls = (Array.isArray(ran) ? ran : []).filter((t) => t?.name);
  const acting = calls.filter((t) => t.ok !== false && !readOnly(String(t.name)));
  const unreported = (t) => t.ok !== true;
  const kept = keepFirst(acting, ATTEMPT_TOOLS, unreported);
  const tools = kept.map((t) => ({
    name: String(t.name).slice(0, 120),
    ok: t.ok === true ? true : null, // null: it never reported back
    brief: briefOf(t.input ?? t.brief),
  }));
  const moreCut = acting.filter(unreported).length - kept.filter(unreported).length;
  const more = acting.length - kept.length - moreCut;
  return {
    outcome: kind,
    at: Number(at) || Date.now(),
    ...(kind === 'failed' && error ? { error: String(error).slice(0, 300) } : {}),
    tools,
    ...(more ? { more } : {}),
    ...(moreCut ? { moreCut } : {}),
    ...(calls.some((t) => tainting(String(t.name))) ? { tainted: true } : {}),
    output: Boolean(output),
    ...(partial ? { partial: true } : {}),
  };
}

/** The conversation with that message's attempt set; null when the message is gone or already has a reply. */
export function withAttempt(conv, messageId, attempt) {
  const list = conv?.messages;
  if (!Array.isArray(list)) return null;
  const i = list.findIndex((m) => m?.id === messageId);
  if (i < 0 || list.slice(i + 1).some((m) => m?.role === 'assistant')) return null;
  list[i] = { ...list[i], attempt };
  return conv;
}

/** The conversation with that message's attempt removed (its reply is stored). */
export function stripAttempt(conv, messageId) {
  const list = conv?.messages;
  if (!Array.isArray(list)) return conv;
  const i = list.findIndex((m) => m?.id === messageId);
  if (i >= 0 && list[i].attempt) list[i] = withoutAttempt(list[i]);
  return conv;
}
