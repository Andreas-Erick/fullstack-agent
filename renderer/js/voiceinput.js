// The voice-input arbiter: who holds the microphone, and what each utterance comes to. Pure (no DOM:
// the clock, timers, flags and the speaker are passed in), tested in test/voiceinput.test.js. voice.js
// keeps the adapters (the recorder, the worklet, the voice detector, speech-to-text) and feeds it events.
//
// The microphone has one holder at a time for new speech: the talk key, the open microphone (one
// hands-free segment), or a voice-sample clip. A talk-key press cuts a hands-free segment in progress;
// that piece waits for its continuation like one cut at the length limit, and the talk key's words join
// it. The open microphone is paused while the talk key holds it, a clip records, or words are being
// written down.
//
// Each utterance ends in exactly one outcome (its handle settles once):
//  - words  → on({ type: 'words', text, source, startedAt }): the app routes them (approval, command, chat);
//  - held   → a piece that waits for its continuation (utterance.js createJoiner), sent later as words;
//  - nothing (an empty recording, an accidental press, noise, a dropped segment);
//  - failed → on({ type: 'failed', samples, error, kept }): the recording is kept for retry().
// The reply-resumes contract: a barge-in the arbiter caused (on({ type: 'barge-in' })) is resolved once,
// by words going out or by on({ type: 'resume' }) (voice.js: barge-in-over) when everything that was said
// came to nothing and nothing else is still being recorded, written down or held.
import { onset, createJoiner, HOLD_MS } from './utterance.js';

export const NOISE_VOICED_MS = 80; // a short "yes" has ~150 ms of vowel; segments with less are breath or noise

const IDLE = Object.freeze({ state: 'idle', id: 0, startedAt: 0 });

/**
 * deps: now() (ms), setTimer(fn, ms) / clearTimer(t), setFlag(name, value) for 'recording' and
 * 'transcribing', agentTalking() (the speaker is playing), approvalPending(), on(event), holdMs.
 */
export function createVoiceInput({ now, setTimer, clearTimer, setFlag = () => {}, agentTalking = () => false, approvalPending = () => false, on = () => {}, holdMs = HOLD_MS } = {}) {
  const joiner = createJoiner({ holdMs });
  let current = { source: '', startedAt: 0 }; // where and when the words being written down began
  let presses = 0;
  // The talk key: idle → waiting (for a piece being written down) → starting → recording → stopping
  // (released, until its recording is handed over); released = let go while the mic was still starting.
  let ptt = IDLE;
  let open = null; // { start } while a hands-free segment records
  let clip = false;
  const writing = new Set(); // utterances being written down
  let interrupted = false; // a barge-in of ours that no words or resume answered yet
  let failed = null; // the latest recording speech-to-text couldn't write down
  let holdTimer = 0;
  let heldSince = 0;
  const flags = { recording: false, transcribing: false };

  const keyBusy = () => ptt.state !== 'idle' || [...writing].some((u) => u.fromKey);
  // The open microphone takes no new speech meanwhile.
  const micTaken = () => writing.size > 0 || clip || ptt.state !== 'idle';
  const quiet = () =>ptt.state === 'idle' && !open && !writing.size && !joiner.pending;

  function sync() {
    const next = { recording: ptt.state === 'recording' || Boolean(open), transcribing: [...writing].some((u) => u.transcribing) };
    for (const k of Object.keys(next)) if (next[k] !== flags[k]) setFlag(k, (flags[k] = next[k]));
  }

  function interrupt() {
    interrupted = true;
    on({ type: 'barge-in' });
  }

  function resume() {
    if (!interrupted || !quiet()) return;
    interrupted = false;
    on({ type: 'resume' });
  }

  function words(text, extra = {}) {
    interrupted = false;
    on({ type: 'words', text, source: current.source, startedAt: current.startedAt, ...extra });
    return 'words';
  }

  // A held piece goes out after its wait, but never while the talk key holds the mic or its words are
  // being written down (they join it).
  function later() {
    clearTimer(holdTimer);
    if (!heldSince) heldSince = now();
    const due = () => {
      if (keyBusy()) return void (holdTimer = setTimer(due, holdMs + 50));
      const text = joiner.due(now());
      if (!text) return;
      const heldMs = Math.round(now() - heldSince);
      heldSince = 0;
      words(text, { heldMs });
    };
    holdTimer = setTimer(due, holdMs + 50);
  }

  function stopHold() {
    clearTimer(holdTimer);
    heldSince = 0;
  }

  /**
   * One utterance being written down. fromKey: the talk key's (its source and start are taken unless
   * another piece is still being written down); start: a hands-free segment's; join: its pieces may wait
   * for each other; limit: cut off, so it waits for its continuation.
   */
  function begin({ fromKey = false, start = null, join = false, limit = false } = {}) {
    if (fromKey) {
      if (!writing.size) current = { source: 'ptt', startedAt: ptt.startedAt || now() };
      ptt = IDLE;
    } else if (start) current = start;
    const u = { fromKey, transcribing: false, done: false, outcome: '' };
    writing.add(u);
    sync();
    const settle = (fn) => (...args) => {
      if (u.done) return u.outcome;
      u.done = true;
      writing.delete(u);
      u.transcribing = false;
      try {
        u.outcome = fn(...args);
      } finally {
        sync();
      }
      return u.outcome;
    };
    const nothing = () => (resume(), 'nothing');
    return {
      /** The samples are in; speech-to-text starts. */
      transcribing() {
        if (u.done) return;
        u.transcribing = true;
        sync();
      },
      /** Nothing was recorded (too short, or no audio). */
      empty: settle(() => (join && joiner.pending ? (later(), 'held') : nothing())),
      /** What speech-to-text wrote down ('' = nothing). */
      heard: settle((text) => {
        if (join) {
          const whole = joiner.add(text, { limit, now: now() });
          if (whole) return stopHold(), words(whole);
          if (!joiner.pending) return nothing();
          later();
          on({ type: 'held', text: joiner.pending });
          return 'held';
        }
        // The talk key's words after a piece it cut off (or one that trailed off): one message, piece first.
        if (fromKey && text && joiner.pending) {
          const whole = joiner.add(text, { now: now() }) || joiner.due(Infinity);
          return stopHold(), words(whole);
        }
        return text ? words(text) : nothing();
      }),
      /** Speech-to-text failed; a recording with samples is kept for retry() (only the latest). */
      failed: settle((samples, error) => {
        const kept = Boolean(samples?.length);
        if (kept) failed = samples;
        on({ type: 'failed', samples, error, kept });
        if (join && joiner.pending) later(); // what was heard before still goes out
        resume();
        return 'failed';
      }),
    };
  }

  return {
    /** Where and when the words being written down began (approval.js: early speech, the talk key). */
    info: () => current,
    /** An utterance is being written down. */
    get busy() {
      return writing.size > 0;
    },
    get recording() {
      return flags.recording;
    },
    /** The piece waiting for its continuation ('' when none). */
    get heldText() {
      return joiner.pending;
    },
    get hasFailed() {
      return Boolean(failed);
    },

    // ------------------------------------------------------------ the talk key
    /**
     * The talk key went down: it interrupts the agent. wait: a piece is still being written down (call
     * ready(id) after a moment); cutOpen: a hands-free segment was recording (end it with openEnd 'cut').
     */
    press() {
      const wait = writing.size > 0;
      const cutOpen = Boolean(open);
      ptt = { state: wait ? 'waiting' : 'starting', id: ++presses, startedAt: 0 };
      interrupt();
      sync();
      return { id: presses, wait, cutOpen };
    },
    /** After the wait: false when the key was let go meanwhile. */
    ready(id) {
      if (ptt.id !== id) return false;
      if (ptt.state === 'waiting') ptt = { ...ptt, state: 'starting' };
      return ptt.state === 'starting';
    },
    micStarted(id, startedAt) {
      if (ptt.id !== id) return;
      if (ptt.state === 'starting') ptt = { ...ptt, state: 'recording', startedAt };
      else if (ptt.state === 'released') ptt = { ...ptt, state: 'stopping', startedAt };
      sync();
    },
    /** The microphone didn't open: nothing was recorded. */
    micFailed(id) {
      if (ptt.id !== id || !['starting', 'released'].includes(ptt.state)) return;
      ptt = IDLE;
      sync();
      resume();
    },
    /** This press still holds the recording mic (the stuck-key limit). */
    holds: (id) => ptt.id === id && ptt.state === 'recording',
    /** The talk key went up. true: a recording is (or may still be) coming; hand it over with begin({ fromKey: true }). */
    release() {
      switch (ptt.state) {
        case 'waiting':
          ptt = IDLE;
          sync();
          resume();
          return false;
        case 'starting':
          ptt = { ...ptt, state: 'released' };
          return true;
        case 'recording':
          ptt = { ...ptt, state: 'stopping' };
          sync();
          return true;
        default:
          return false;
      }
    },

    // ------------------------------------------------------- the open microphone
    /** Each frame: listen = feed the detector; drop = the segment in progress is gone (the agent talks). */
    openGate({ headphones = false } = {}) {
      const talking = agentTalking();
      if (micTaken() || (talking && !headphones)) {
        if (talking && open) {
          open = null;
          sync();
          resume();
        }
        return { listen: false, drop: talking };
      }
      return { listen: true, drop: false };
    },
    /** A run of speech: its start ({ source, startedAt }) once it starts a segment, else null. */
    openOnset({ loudMs = 0, voicedMs = 0 } = {}) {
      const talking = agentTalking();
      // Interrupting the agent needs clearly voiced speech, so breathing or a cough doesn't cut it off.
      if (open || micTaken() || !onset({ agentTalking: talking, loudMs, voicedMs })) return null;
      stopHold(); // a piece waiting for its continuation: this is it
      joiner.hold(now());
      if (talking) interrupt();
      if (!joiner.pending) current = { source: 'open', startedAt: now() - loudMs }; // a held piece keeps the earlier start
      open = { start: current };
      sync();
      return open.start;
    },
    /** The segment ended ('pause' | 'limit' | 'cut'): its handle, or null for noise. */
    openEnd({ start, voicedMs = 0, ended = 'pause' } = {}) {
      open = null;
      if (voicedMs < NOISE_VOICED_MS) {
        sync();
        if (joiner.pending) later();
        else resume();
        return null;
      }
      // The open microphone's start, even if the talk key was tapped meanwhile.
      return begin({ start: start || current, join: true, limit: ended !== 'pause' });
    },
    /** Hands-free listening stopped: a segment in progress is dropped (the talk key's recording stays). */
    openStopped() {
      if (!open) return;
      open = null;
      sync();
      resume();
    },

    // ------------------------------------------------------------ the rest
    /** A voice sample for cloning is being recorded: the open microphone ignores it. */
    clip(on) {
      clip = Boolean(on);
    },
    begin,
    /** The kept recording, to write down again: { samples }, { refused: 'approval' | 'busy' }, or null. */
    retry() {
      if (!failed) return null;
      // Words said before an approval appeared are never its answer: they wait until it is answered.
      if (approvalPending()) return { refused: 'approval' };
      if (writing.size || ptt.state !== 'idle') return { refused: 'busy' };
      const samples = failed;
      failed = null; // kept again if this attempt fails too
      return { samples };
    },
    /** Let the kept recording go. */
    forget() {
      failed = null;
    },
  };
}
