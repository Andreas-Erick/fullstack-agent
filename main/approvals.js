// Permission gate for consequential actions (self-modification, settings changes, deletions, commands).
//  - "ask" mode: the user approves in the app (click) or by voice (a yes spoken on its own: "yes", "yeah", "okay", "go ahead"…).
//  - "auto" mode: allowed silently — except self-modification in a turn that read external content
//    (web pages, documents), which always asks: external content is data, never instructions; and
//    the ALWAYS_ASK kinds, which reach beyond this computer or copy someone's voice.
// Approval is remembered per turn and kind, so one "yes" covers a whole multi-file change.
const crypto = require('crypto');
const store = require('./store');
const log = require('./logger');

const pending = new Map(); // id -> resolve

// Shell commands, calendar changes that email other people, cloning a voice from a recording,
// publishing to GitHub (push, pull request) and the user's connectors (their accounts in other
// services) always need a human, even in auto mode.
const ALWAYS_ASK = new Set(['command', 'invite', 'voice_clone', 'github_publish', 'connector']);
// Each of these names different people, a different recording or a different service, so one yes
// never covers the next (claudecode.js remembers a connector's yes per service for the turn).
const EACH_TIME = new Set(['invite', 'voice_clone', 'github_publish', 'connector']);
let sender = null;

function setSender(fn) {
  sender = fn;
}

function newTurn() {
  return { tainted: false, taintSources: [], approved: new Set(), plan: null };
}

function markTainted(turn, source) {
  if (!turn) return;
  turn.tainted = true;
  if (turn.taintSources.length < 5) turn.taintSources.push(source);
}

/**
 * @param {object} turn per-turn state from newTurn()
 * @param {string} kind self_modify | settings | delete | command | calendar | invite | voice | voice_clone | repo_change | github_publish | connector | browser
 * @returns {Promise<{allow: boolean, reason?: string}>}
 */
async function gate(turn, kind, title, detail = '') {
  const s = await store.getSettings();
  if (turn?.approved.has(kind) && !EACH_TIME.has(kind)) return { allow: true };
  const tainted = Boolean(turn?.tainted) && kind === 'self_modify' && s.safety.taintGuard;
  if (s.safety.permissionMode === 'auto' && !tainted && !ALWAYS_ASK.has(kind)) {
    turn?.approved.add(kind);
    return { allow: true, auto: true };
  }
  const res = await ask({ kind, title, detail, tainted, sources: turn?.taintSources || [], timeoutSec: s.safety.approvalTimeoutSec || 75 });
  log.info('approval', { kind, title, allow: res.allow, reason: res.reason });
  if (res.allow) turn?.approved.add(kind);
  return res;
}

function ask(payload) {
  if (!sender) return Promise.resolve({ allow: false, reason: 'No app window is open to ask the user.' });
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    pending.set(id, resolve);
    sender('approval:request', { id, ...payload });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      sender('approval:cancel', { id });
      resolve({ allow: false, reason: `No answer within ${payload.timeoutSec} seconds — treated as no.` });
    }, payload.timeoutSec * 1000);
  });
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

function respond(id, allow, reason) {
  const resolve = pending.get(id);
  if (!resolve) return false;
  pending.delete(id);
  resolve({ allow: Boolean(allow), reason: reason || (allow ? '' : 'The user said no.') });
  // Answered in one place (desktop, phone, notification): close it everywhere else.
  sender?.('approval:cancel', { id, answered: true });
  return true;
}

module.exports = { setSender, newTurn, markTainted, gate, respond, askSecret, askRecording };
