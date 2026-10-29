// Where one spoken message begins and ends in hands-free mode. Pure (no DOM, no clock: times are
// passed in), tested in test/utterance.test.js.
//  - onset: speech starts a recording; talking over the agent needs clearly voiced speech, so a cough
//    or a breath doesn't interrupt it.
//  - segmentEnd: a pause ends the recording, or the length limit (a safety net for a mic that never
//    goes quiet; Whisper transcribes long audio in 30-second chunks itself).
//  - createJoiner: pieces that belong together go out as one message: a recording that hit the limit,
//    or a transcript that trails off ("…and then the"), waits a moment for what comes next.

export const MAX_UTTERANCE_MS = 120000;
export const HOLD_MS = 2500; // how long an unfinished piece waits for its continuation
export const PTT_MAX_MS = 5 * 60000; // a talk key held (or stuck) this long stops recording
const ONSET_MS = 120; // speech this long starts a recording
const BARGE_IN_VOICED_MS = 240; // voiced speech this long interrupts the agent

/** Does this run of speech start a recording? (agentTalking: it would interrupt the agent.) */
export function onset({ agentTalking = false, loudMs = 0, voicedMs = 0 }) {
  return agentTalking ? voicedMs >= BARGE_IN_VOICED_MS : loudMs > ONSET_MS;
}

/** The pause that ends a recording, from the setting (ms), kept within reason. */
export const endSilence = (setting) => Math.min(2000, Math.max(300, Number(setting) || 600));

/** Has the recording ended? null (go on), 'pause' or 'limit'. */
export function segmentEnd({ silenceMs, lengthMs }, { endMs = 600, maxMs = MAX_UTTERANCE_MS } = {}) {
  if (silenceMs > endMs) return 'pause';
  if (lengthMs > maxMs) return 'limit';
  return null;
}

// Endings that mean the sentence isn't over: a joining word, an article, a comma, a dash, "…".
// (Whisper often ends a cut-off sentence with a full stop anyway: "I want to go to the.")
const TRAILING = /(?:[,\-–—:]|\.\.\.|…|\b(?:and|but|or|so|because|if|that|which|the|a|an|to|of|with|for|my|your|then|um|uh)\.?)\s*$/i;
export const looksUnfinished = (text) => TRAILING.test(String(text || '').trim());

/**
 * Joins pieces of one spoken message. add(text, { limit, now }) → the message to send now, or null
 * (held: call due(now) later, or add the continuation). due(now) → the held message once its wait is over.
 */
export function createJoiner({ holdMs = HOLD_MS } = {}) {
  let held = null; // { text, at, open: it trailed off mid-sentence }
  // The full stop Whisper put on a piece cut off mid-sentence goes: "to the." + "station." = "to the station."
  const join = (b) => (held ? `${held.open ? held.text.replace(/(?:\.\.\.|…|\.)\s*$/, '') : held.text} ${b}` : b).replace(/\s+/g, ' ').trim();
  return {
    add(text, { limit = false, now = 0 } = {}) {
      const t = String(text || '').trim();
      if (!t) return null;
      const joined = join(t);
      const open = looksUnfinished(t);
      if (limit || open) {
        held = { text: joined, at: now, open };
        return null;
      }
      held = null;
      return joined;
    },
    due(now) {
      if (!held || now - held.at < holdMs) return null;
      const t = held.text;
      held = null;
      return t;
    },
    /** Speech started again: the held piece waits for it (its wait starts over at the next add). */
    hold(now) {
      if (held) held.at = now;
    },
    get pending() {
      return held?.text || '';
    },
    clear() {
      held = null;
    },
  };
}
