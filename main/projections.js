// One chat message or turn event, as each audience sees it. The producer (turns.js, main.js) stores the
// full message and hands out only these views; the consumers (the window, companion.js for paired devices)
// never trim on their own.
//   stored  the file on disk (store.js): everything, the provider's raw data included.
//   window  this computer's window: no raw provider data; the start event's message without its attempt
//           (it is still running).
//   device  a paired phone, tablet or watch: a trimmed copy (of the window's view, for a turn's events). Tool names only (never
//           inputs or results), an attempt as { outcome }, a message with attachments as its typed words and
//           [{ kind, name }], error and notice text without paths on this computer, hidden messages left out,
//           only the event types the phone handles. The setup conversation never reaches devices.
// Pure apart from worldcore (where the village shows a tool's work), required when a tool starts.
const attachcore = require('./attachcore');

const AUDIENCES = ['window', 'device'];
// The chat events a device gets; the rest (settings, vault, self-change, persona…) stay on the window.
const DEVICE_EVENTS = new Set(['start', 'text', 'retract', 'tool_start', 'tool_end', 'notice', 'done', 'error', 'aborted']);

// ------------------------------------------------------------- text
// Text for a device, without paths on this computer (a file error names the full path, e.g.
// C:\Users\…\vault\note.md: EBUSY). The log keeps the whole error. A quoted path is cut up to its
// closing quote (folder names have spaces, even apostrophes), a bare one on through spaced words as long
// as a slash follows them (C:\Users\Anna Maria Berg\npm\claude.cmd, Program Files (x86)\…); a ")" right
// after a path ends it, and the s:/ of https:// is not a drive. A bare path keeps its apostrophes
// (C:\Users\O'Brien\…): the quoted ones are cut first, so one left after a path's start belongs to it.
// Each spaced word starts with its one space and holds no other, so the match never backtracks far. Only
// the first 2,000 characters are looked at; URLs are kept.
const READ_CHARS = 2000;
const QUOTED_PATH = /(['"`])(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|var|tmp)\/).*?\1(?=$|[\s,;:.)\]])/g;
const BARE_PATH = /(?:(?<![A-Za-z])[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|var|tmp)\/)[^\s"`)]*(?:(?: [^\s"`\\/]*)+[\\/][^\s"`)]*)*/g;

/** An error's message for a device: paths cut, at most `max` characters; `fallback` when nothing is left. */
function deviceText(err, fallback, { max = 300 } = {}) {
  const msg = String(err?.message || '').slice(0, READ_CHARS).replace(QUOTED_PATH, '…').replace(BARE_PATH, '…').slice(0, max).trim();
  return msg && msg !== '…' ? msg : fallback;
}

// ------------------------------------------------------------- messages
function stripRaw(m) {
  const { raw, ...rest } = m;
  return rest;
}

function withoutAttempt(m) {
  const { attempt, ...rest } = m;
  return rest;
}

// A stored or streamed message without the raw provider data and tool inputs/results; a /skill shows
// what was typed rather than the expanded steps. A failed attempt shows only how it ended.
function deviceMessage(m) {
  const { raw, toolCalls, display, content, attempt, attachments, ...rest } = m;
  return {
    ...rest,
    // A message with attachments carries the files' text in its content: devices get only what was typed.
    content: attachments?.length ? display || '' : display ?? content,
    ...(toolCalls?.length ? { toolCalls: toolCalls.map((t) => ({ name: t.name, ok: t.ok })) } : {}),
    ...(attempt?.outcome ? { attempt: { outcome: attempt.outcome } } : {}),
    ...(attachments?.length ? { attachments: attachcore.forDevice(attachments) } : {}),
  };
}

/** A stored message as `audience` sees it ('window' | 'device'). */
function messageFor(audience, m) {
  check(audience);
  if (!m) return m;
  return audience === 'window' ? stripRaw(m) : deviceMessage(stripRaw(m));
}

/** A conversation's messages as `audience` sees them: devices never get hidden ones. */
function messagesFor(audience, list) {
  check(audience);
  const all = Array.isArray(list) ? list : [];
  return (audience === 'device' ? all.filter((m) => !m?.hidden) : all).map((m) => messageFor(audience, m));
}

// ------------------------------------------------------------- events
function windowEvent(ev) {
  if (ev.type === 'start' && ev.userMessage) return { ...ev, userMessage: withoutAttempt(stripRaw(ev.userMessage)) };
  if (ev.type === 'done' && ev.message) return { ...ev, message: stripRaw(ev.message) };
  return ev;
}

// Devices get what the phone shows, nothing more: no tool arguments or results (file contents, commands,
// notes), no internal events. companion.js gets the window's view (main.js send) and trims it again here, so
// a turn's running attempt never reaches a device; a message's attempt otherwise shows as its outcome.
function deviceEvent(ev) {
  if (!DEVICE_EVENTS.has(ev.type)) return null;
  const base = { requestId: ev.requestId, conversationId: ev.conversationId, type: ev.type };
  switch (ev.type) {
    case 'start':
      // replaces: the unanswered message this one takes the place of (Try again; the phone reloads for it).
      return { ...base, title: ev.title, userMessage: ev.userMessage && deviceMessage(ev.userMessage), ...(ev.replaces ? { replaces: String(ev.replaces) } : {}) };
    case 'text':
      return { ...base, delta: ev.delta };
    case 'retract':
      return { ...base, chars: ev.chars };
    case 'tool_start': {
      // Where the village shows the work (from the tool's name alone), for the phone's world screen.
      const { place, label } = require('./worldcore').workFor(ev.name);
      return { ...base, id: ev.id, name: ev.name, work: { place, label } };
    }
    case 'tool_end':
      return { ...base, id: ev.id, name: ev.name, ok: ev.ok };
    case 'done':
      return { ...base, message: ev.message && deviceMessage(ev.message) };
    case 'error':
      return { ...base, message: deviceText({ message: ev.message }, 'The reply failed on the computer') };
    case 'aborted':
      return { ...base, message: deviceText({ message: ev.message }, 'Stopped') };
    case 'notice':
      // A notice can name a model (a local model's id may be a file path) or a model's own reason (hand-over).
      return { ...base, message: deviceText({ message: ev.message }, 'Notice from the computer', { max: READ_CHARS }) };
  }
}

/** A chat event (chat:event) as `audience` sees it; null when it doesn't reach that audience. */
function eventFor(audience, ev) {
  check(audience);
  if (!ev || typeof ev !== 'object') return null;
  return audience === 'window' ? windowEvent(ev) : deviceEvent(ev);
}

/** Whether a conversation's events and messages reach paired devices at all (never the setup conversation). */
const reachesDevices = (conv) => !conv?.setup;

function check(audience) {
  if (!AUDIENCES.includes(audience)) throw new Error(`Unknown audience: ${audience}`);
}

module.exports = { AUDIENCES, DEVICE_EVENTS, messageFor, messagesFor, eventFor, reachesDevices, deviceText };
