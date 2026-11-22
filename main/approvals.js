// Permission gate for consequential actions (self-modification, settings changes, deletions, commands).
//  - "ask" mode: the user approves in the app (click) or by voice (a yes spoken on its own: "yes", "okay",
//    "approve"…; main's voicePolicy says when a yes needs the talk key or a click).
//  - "auto" mode: allowed silently, except the ALWAYS_ASK kinds: changing the app's own code (a
//    prompt injection that slipped past tainting must never be able to rewrite the app), and what
//    reaches beyond this computer or copies someone's voice.
//  - With the taint guard on, a turn that read outside content (web pages, documents, a connector's
//    data) shows the warning on every dialog and asks for the TAINT_ASKS kinds and for calls marked
//    `taintAsks`, in auto mode too, and for each command (TAINT_EACH_TIME): outside content is data,
//    never instructions. What counts as outside content, the turn's ledger and the guard's definition
//    (turnguard.guarded) live in turnguard.js; this file keeps the dialog mechanics.
// Approval is remembered per turn and kind, so one "yes" covers a whole multi-file change. Stop ends
// every open question of its turn (newTurn's `signal`).
const crypto = require('crypto');
const store = require('./store');
const log = require('./logger');
const outbound = require('./outboundcore');
const turnguard = require('./turnguard');

const pending = new Map(); // id -> resolve

// Self-changes, shell commands, calendar changes that email other people, cloning a voice from a
// recording, publishing to GitHub (push, pull request) and the user's connectors (their accounts in
// other services) always need a human, even in auto mode.
// Giving a connector more permission (tool connector_permission) always asks too.
// Changing where the brain or the voice connects (their keys go there) and widening the agent's own
// access during setup ask too, each time. So does opening a web address that came up only after the
// turn read outside content (askOutbound).
const ALWAYS_ASK = new Set(['self_modify', 'command', 'invite', 'voice_clone', 'github_publish', 'connector', 'connector_trust', 'endpoint', 'permissions', 'web_outbound']);
// Each of these names different people, a different recording, a different service or a different
// site, so one yes never covers the next (claudecode.js remembers a connector's yes per service for
// the turn, askOutbound a site's per host).
const EACH_TIME = new Set(['invite', 'voice_clone', 'github_publish', 'connector', 'connector_trust', 'endpoint', 'permissions', 'web_outbound']);
// These ask in a turn that read outside content (taint guard on), in auto mode too; a yes given before the
// taint doesn't cover them. tools/common.js requireApproval's `taintAsks` does the same for one call.
const TAINT_ASKS = new Set(['self_modify', 'endpoint']);
// After outside content these ask each time, like a `taintAsks` call: a command's dialog shows the one
// command that would run, so a yes to one (before or after the taint) never covers the next (curl …?d=…).
const TAINT_EACH_TIME = new Set(['command']);
const STOPPED = Object.freeze({ allow: false, reason: 'The reply was stopped.' });
let sender = null;

function setSender(fn) {
  sender = fn;
}

/**
 * A turn's approval state. signal: the turn's AbortSignal (Stop closes its open questions); userText: the
 * user's own words (the web hosts they name may be opened after outside content, outboundcore.check).
 */
function newTurn({ signal = null, userText = '' } = {}) {
  return { tainted: false, taintSources: [], approved: new Set(), approvedTainted: new Set(), plan: null, signal, userHosts: outbound.hostsIn(userText), knownHosts: new Set(), outboundApproved: new Set() };
}

// The ledger is turnguard.js's; the name stays for the callers that seed a turn (llm.js runOn).
const markTainted = turnguard.mark;

/**
 * How a spoken answer may approve this request (renderer commandcore.approvalAnswer): 'click' = not by
 * voice (a command or a code change after outside content: the spoken title can't say what would run),
 * 'key' = a yes only through the talk key (the always-ask kinds and whatever the taint made ask: never an
 * open microphone a TV or a visitor can answer), 'any' = any spoken yes.
 */
function voicePolicy(kind, { tainted = false, taintBlocks = false } = {}) {
  if (tainted && (kind === 'command' || kind === 'self_modify')) return 'click';
  return ALWAYS_ASK.has(kind) || taintBlocks ? 'key' : 'any';
}

/**
 * @param {object} turn per-turn state from newTurn()
 * @param {string} kind self_modify | settings | endpoint | permissions | delete | command | calendar | invite | voice | voice_clone | repo_change | github_publish | connector | connector_trust | browser | web_outbound
 * @param {object} [extra] `remember`: [{ level, label }] "from now on" choices the dialog offers;
 *   `taintAsks`: in a turn that read outside content (taint guard on) this call asks, in auto mode too, and
 *   no earlier yes in the turn covers it (never sent to the window)
 * @returns {Promise<{allow: boolean, reason?: string, remember?: string}>} remember = the choice the user picked
 */
async function gate(turn, kind, title, detail = '', extra = {}) {
  if (turn?.signal?.aborted) return STOPPED; // asked after Stop: never shown
  const s = await store.getSettings();
  if (turn?.signal?.aborted) return STOPPED;
  const { taintAsks = false, ...shown } = extra;
  // The dialog says so whenever the turn read outside content; only some kinds ask because of it.
  const tainted = turnguard.guarded(turn, s);
  const askEach = taintAsks || TAINT_EACH_TIME.has(kind);
  const taintBlocks = tainted && (TAINT_ASKS.has(kind) || askEach);
  // One yes covers the kind for the rest of the turn, except EACH_TIME kinds, a `taintAsks` call or a
  // TAINT_EACH_TIME kind once the turn is tainted, and a TAINT_ASKS kind whose yes came before the taint.
  const remembered = turn?.approved.has(kind) && !EACH_TIME.has(kind) && (!taintBlocks || (!askEach && turn.approvedTainted?.has(kind)));
  if (remembered) return { allow: true };
  if (s.safety.permissionMode === 'auto' && !taintBlocks && !ALWAYS_ASK.has(kind)) {
    turn?.approved.add(kind);
    return { allow: true, auto: true };
  }
  const res = await ask({ ...shown, kind, title, detail, tainted, voice: voicePolicy(kind, { tainted, taintBlocks }), sources: turn?.taintSources || [], timeoutSec: s.safety.approvalTimeoutSec || 75 }, turn?.signal);
  const why = reasonForLog(res.reason);
  log.info('approval', { kind, title, allow: res.allow, ...why, remember: res.remember, tainted: tainted || undefined });
  if (why.reasonChars) log.debug('approval reason', { text: String(res.reason).slice(0, 200) });
  if (res.allow) {
    turn?.approved.add(kind);
    if (tainted) turn?.approvedTainted?.add(kind);
  }
  return res;
}

// The reasons the app itself gives for an answer: a click (Deny, Esc), the time limit, Stop, no window, a
// device's no. Any other reason is what the user said (a spoken "no, …" goes back to the model as the
// reason): the log keeps only its length, and the words only with Detailed logging on, as for every transcript.
const OWN_REASON = /^(|declined|The user said no\.|The user pressed Esc\.|The user clicked Deny\.|The reply was stopped\.|No answer within \d+ seconds — treated as no\.|No app window is open to ask the user\.|The user said no \(on [^\n]{0,80}\)\.)$/;

/** An answer's reason for the log: { reason } when the app wrote it, else { reasonChars }. */
function reasonForLog(reason) {
  const text = String(reason ?? '');
  return OWN_REASON.test(text) ? { reason: text } : { reasonChars: text.length };
}

/** A declined call's message ("Not approved by the user[ (note)]: <reason>") for the log, without what the user said. */
function declineForLog(message) {
  const m = /^((?:User did not approve|Not approved by the user)(?: \([^)\n]*\))?): ([\s\S]*)$/.exec(String(message ?? ''));
  return !m || OWN_REASON.test(m[2]) ? String(message ?? '') : `${m[1]} (${m[2].length} characters said)`;
}

function ask(payload, signal = null) {
  if (!sender) return Promise.resolve({ allow: false, reason: 'No app window is open to ask the user.' });
  if (signal?.aborted) return Promise.resolve(STOPPED);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    let timer = null;
    // One way out per request: an answer (respond), the time limit, or Stop. Each clears the others.
    const settle = (r) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const end = (r) => {
      if (!pending.delete(id)) return;
      sender('approval:cancel', { id }); // closes it on the desktop, the phone and the notification
      settle(r);
    };
    const onAbort = () => end(STOPPED);
    pending.set(id, settle);
    sender('approval:request', { id, ...payload });
    timer = setTimeout(() => end({ allow: false, reason: `No answer within ${payload.timeoutSec} seconds — treated as no.` }), payload.timeoutSec * 1000);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A request to a web address in this turn (WebFetch, web_fetch, browser_open). Silent unless the turn read
 * outside content (taint guard on) and the host is new to it (outboundcore.check); then one dialog per
 * host (web_outbound: always asks, auto mode too).
 */
async function askOutbound(turn, url) {
  const s = await store.getSettings();
  const d = outbound.check(turn, url, { tainted: turnguard.guarded(turn, s) });
  if (d.decision === 'allow') {
    outbound.noteHosts(turn, [d.host]); // only while the turn is still untainted
    return { allow: true };
  }
  const r = await gate(turn, 'web_outbound', `Open ${d.host || 'a web address'}`, `${String(url).slice(0, 300)}\n\nThis address came up after reading outside content. Approve only if you expect this site to be opened.`);
  if (r.allow && d.host) turn?.outboundApproved?.add(d.host);
  else if (!r.allow) log.info('web address declined after outside content', { host: d.host });
  return r;
}

// Secure input: asks the user for a secret in a masked field in the app. The value goes straight
// into the encrypted settings and is never returned to the model. Resolves to true if entered.
function askSecret({ label, hint }) {
  if (!sender) return Promise.resolve(null);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    pending.set(id, (r) => resolve(r.allow ? r.reason : null));
    sender('secret:request', { id, label, hint });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      sender('approval:cancel', { id });
      resolve(null);
    }, 180000);
  });
}

// Voice recording: the app shows a script, the user records themselves reading it (and can redo or
// cancel). Resolves to the recording as a base64 WAV — or, with mode "calibrate", to a JSON string of
// what speech-to-text heard and the loudness levels — or null if they cancelled.
function askRecording({ script, seconds, mode = 'clone', title, intro }) {
  if (!sender) return Promise.resolve(null);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    pending.set(id, (r) => resolve(r.allow ? r.reason : null));
    sender('record:request', { id, script, seconds, mode, title, intro });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      sender('approval:cancel', { id });
      resolve(null);
    }, 300000);
  });
}

// `remember` (a "from now on" choice) comes only from the app window (approval:respond), never from a device.
function respond(id, allow, reason, remember) {
  const resolve = pending.get(id);
  if (!resolve) return false;
  pending.delete(id);
  resolve({ allow: Boolean(allow), reason: reason || (allow ? '' : 'The user said no.'), ...(allow && typeof remember === 'string' ? { remember } : {}) });
  // Answered in one place (desktop, phone, notification): close it everywhere else.
  sender?.('approval:cancel', { id, answered: true });
  return true;
}

module.exports = { ALWAYS_ASK, EACH_TIME, TAINT_ASKS, TAINT_EACH_TIME, STOPPED, setSender, newTurn, markTainted, voicePolicy, gate, askOutbound, respond, askSecret, askRecording, reasonForLog, declineForLog };
