// Running the user's latest message again: Try again, Regenerate, Edit and resend (chat:redoCheck /
// chat:redo), and the same message sent again after a failure from any device (turns.js start).
// The rules are the pure renderer/js/redocore.mjs, shared with the chat; this side knows which tools
// change something, remembers an attempt until it is stored, and holds every gate (prepare).
const core = require('../renderer/js/redocore.mjs');
const connectors = require('./connectors');
const localcore = require('./localcore');

// Claude Code's own tools that only read (or keep its to-do list).
const CLAUDE_READ = new Set(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'ToolSearch', 'Skill', 'TodoWrite']);
// Tools that change something, but nothing worth asking about before running the message again.
const HARMLESS = new Set(['daily_note_log', 'stream_observe', 'stream_reflect', 'open_document', 'close_document', 'identify_monitors', 'move_window', 'set_window_state', 'browser_open', 'browser_close', 'tools_more', 'hand_over']);

/** A tool that only reads. A connector's by its action alone ("mcp__x_search__send_email" sends). New tools count as acting. */
function readOnly(name) {
  const n = String(name || '');
  return connectors.isConnectorTool(n) ? connectors.isReadOnly(n) : localcore.isReadTool(n) || CLAUDE_READ.has(n);
}

const harmless = (name) => HARMLESS.has(String(name || ''));

/** A tool whose result is external content (web pages, documents, connectors): a kept session still holds it. */
function tainting(name) {
  const n = String(name || '');
  if (['WebFetch', 'WebSearch'].includes(n) || connectors.isConnectorTool(n)) return true;
  return Boolean(require('./tools').TOOLS.find((t) => t.name === n)?.untrusted);
}

// The attempt of the turn that just failed or stopped, until the store has it (an immediate Try again).
const remembered = new Map(); // convId → { messageId, attempt }
function remember(convId, messageId, attempt) {
  if (!attempt) remembered.delete(convId);
  else remembered.set(convId, { messageId, attempt });
}

const ID = /^[\w-]{1,64}$/;
function sanitize(req) {
  const id = (v) => (ID.test(String(v ?? '')) ? String(v) : '');
  return {
    kind: ['again', 'edit'].includes(req?.kind) ? req.kind : '',
    messageId: id(req?.messageId),
    // Compared, never used as a path: an id that fails the pattern can't match, so the window reloads.
    expectLast: req?.expectLast == null || req.expectLast === '' ? '' : id(req.expectLast) || '\u0000',
    text: String(req?.text ?? '').slice(0, core.MAX_TEXT + 1), // one over: the plan says it is too long
    confirmed: req?.confirmed === true,
  };
}

// The stored messages with the remembered attempt on its message (it may not be written yet).
function overlay(conv) {
  const mem = remembered.get(conv.id);
  if (!mem) return conv.messages || [];
  return (conv.messages || []).map((m) => (m?.id === mem.messageId && m.role === 'user' ? { ...m, attempt: mem.attempt } : m));
}

const options = (conv) => ({ title: conv.title || '', hasSession: Boolean(conv.claudeSessionId), readOnly, harmless, tainting });

/** The plan for an explicit redo, or { ok: false, error, changed? }. */
function check(conv, req, { busy = false } = {}) {
  if (!conv) return { ok: false, error: 'Conversation not found' };
  if (conv.setup) return { ok: false, error: 'The setup conversation can’t be sent again.' };
  if (busy) return { ok: false, error: 'Wait for the current reply to finish (or stop it) first.' };
  const r = sanitize(req);
  if (!r.kind) return { ok: false, error: 'Bad request' };
  return core.plan(overlay(conv), r, options(conv));
}

/** An implicit Try again: the same text as the unanswered message before it, or null. */
function supersedes(conv, text, { busy = false } = {}) {
  if (busy || !conv || conv.setup) return null;
  return core.supersedes(overlay(conv), text, options(conv));
}

/** Takes the old exchange out of `conv` (in memory; turns.js saves it) and ends a session that holds it. */
function apply(conv, p, { forget = null } = {}) {
  Object.assign(conv, core.clampMarks(conv, p.cut));
  conv.messages = (conv.messages || []).slice(0, p.cut);
  if (p.resetSession) {
    forget?.(conv.id, conv.claudeSessionId);
    conv.claudeSessionId = null;
    conv.claudeTokens = 0;
  }
  remember(conv.id, null);
  return {
    kind: p.kind === 'edit' ? 'edit' : p.replyDropped ? 'regenerate' : 'again',
    replaces: p.replaces,
    replyDropped: p.replyDropped,
    keepTitle: p.keepTitle,
    acted: p.acted,
    unsure: p.unsure,
    uncertain: p.uncertain,
    hadImages: p.hadImages,
    fresh: p.resetSession,
    user: p.user,
    again: { note: p.note, taint: p.taint },
  };
}

/**
 * The gates of a turn (turns.js start): an explicit redo (desktop only, confirmed when it must be) or the
 * same message sent again after a failure. Returns { again, text, voice }; throws for a refusal.
 */
function prepare({ conv, redo = null, text, voice = false, remote = null, routine = '', auto = '', hidden = false, busy = false, forget = null }) {
  if (redo) {
    if (remote) throw new Error('Only the computer can send a message again.');
    const p = check(conv, redo, { busy });
    if (!p.ok) throw Object.assign(new Error(p.error), p.changed ? { changed: true } : {});
    if ((p.ask.length || p.more || p.uncertain) && redo.confirmed !== true) throw new Error('Confirm first: the earlier reply already did something.');
    return { again: apply(conv, p, { forget }), text: p.text, voice: p.voice };
  }
  if (!routine && !auto && !hidden && !conv.setup) {
    const s = supersedes(conv, text, { busy });
    if (s) return { again: apply(conv, s, { forget }), text, voice };
  }
  return { again: null, text, voice };
}

/**
 * The attempt record of a turn: running (its first action that changes something), failed or stopped.
 * It lists only the actions, so a long run of reads can't push one out, and notes any outside content.
 */
function attemptFrom({ aborted = false, err = null, ran = new Map(), firstTextMs = null, running = false } = {}) {
  return core.attemptRecord({
    outcome: running ? 'running' : aborted ? 'stopped' : 'failed',
    at: Date.now(),
    error: running || aborted ? '' : String(err?.message || err || ''),
    ran: [...ran.values()],
    output: firstTextMs !== null || ran.size > 0,
    partial: running,
    readOnly,
    tainting,
  });
}

/** What the window sees of a plan (tool inputs included); never sent to devices. */
function forWindow(p) {
  if (!p?.ok) return { ok: false, error: p?.error || 'Not possible', changed: Boolean(p?.changed) };
  return { ok: true, kind: p.kind, text: p.text, voice: p.voice, acted: p.acted, ask: p.ask, more: p.more || 0, uncertain: p.uncertain, fresh: p.resetSession, replyDropped: p.replyDropped };
}

module.exports = {
  CLAUDE_READ,
  HARMLESS,
  readOnly,
  harmless,
  tainting,
  remember,
  check,
  supersedes,
  apply,
  prepare,
  attemptFrom,
  forWindow,
  publicMessage: core.withoutAttempt,
  withAttempt: core.withAttempt,
  stripAttempt: core.stripAttempt,
};
