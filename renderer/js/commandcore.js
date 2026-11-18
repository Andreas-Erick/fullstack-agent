// The words of the voice commands (js/commands.js runs them). Pure, so it is tested directly
// (test/commands.test.js). A command counts only when it is said on its own: the patterns are anchored,
// so "cancel my dentist appointment" still goes to the agent.

/** A transcript as the patterns read it: lower case, letters and single spaces only. */
export const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Longer than this, a transcript is a message, never a command. */
export const MAX_WORDS = 7;

// "New chat", "start a new conversation", "let's start a fresh chat please", "clear the chat".
export const NEW_CHAT = /^(okay |ok |so )?(let s |let us |can we |could we |please |i want to |i d like to )?((start|open|begin|make)( a| an| the)? )?((new|fresh|another) |(clear|reset) (the |this )?)(session|conversation|chat)( please)?$/;

// Stops the reply that is still being written, and its tools ("cancel", "never mind", "stop working").
export const CANCEL_REPLY = /^(please |okay |ok )?(cancel( that| it)?|never ?mind|stop working|stop that)( please)?$/;

// Only silences the voice; the reply goes on being written (with push-to-talk the press already did).
export const STOP_SPEAKING = /^(stop|quiet|be quiet|shut up|stop talking)$/;

// "Try again", "retry", "please try that again": the failed or stopped reply, sent again (chat.js retryLatest).
export const TRY_AGAIN = /^(please |okay |ok )?(try (that |it )?again|retry)( please)?$/;

/** "Try again" is a command only while the latest reply failed or was stopped; after a good one it goes to the agent. */
export const retryCommand = (t, canRetry) => Boolean(canRetry) && TRY_AGAIN.test(t);

/**
 * Which stop command a transcript (normalized) is: 'reply' stops the reply still being written (and its
 * tools), 'voice' only silences, null is none (it goes to the agent). The CANCEL_REPLY words stop a reply
 * only while one is being written: afterwards "cancel that" or "never mind" go to the agent, which may
 * read them as "undo what you just did" (swallowed, they did nothing and said nothing). A bare "cancel"
 * then only silences the voice, as it always did.
 */
export function stopCommand(t, generating) {
  if (CANCEL_REPLY.test(t)) return generating ? 'reply' : t === 'cancel' ? 'voice' : null;
  return STOP_SPEAKING.test(t) ? 'voice' : null;
}

// ---- Spoken answers to an approval (approval.js handleSpokenAnswer).
// Whisper adds punctuation ("Yes, please."): letters only, apostrophes dropped ("don't" → "dont").
const answerWords = (t) => String(t || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
// Spoken alone, these approve. Anything longer is a sentence: it declines and goes back as the reason.
export const APPROVE = new Set(['yes', 'yeah', 'yep', 'sure', 'okay', 'ok', 'go ahead', 'do it', 'approved', 'yes please', 'yeah yes', 'yes do it', 'yes go ahead', 'approve', 'approve it', 'allow', 'allow it', 'yes approve', 'yes yes', 'okay go ahead', 'ok go ahead', 'sure go ahead', 'yes sure', 'ok do it', 'okay do it']);
// These approve and pick the first "from now on" choice (a connector: allow reading, else all but deleting).
export const ALWAYS_SAY = new Set(['always', 'always allow', 'always allow it', 'yes always', 'allow always', 'yes always allow', 'dont ask again', 'yes dont ask again', 'stop asking']);
const DETAILS = /^(details|show details|what exactly)$/;

/**
 * What a spoken answer means: 'early' (speech that began before the approval appeared: never its answer),
 * 'details', 'needs-click' / 'needs-key' (a yes this request doesn't take by voice, or not from an open
 * microphone; nothing is declined), 'yes', 'always', or 'no' (any other words: they go back as the reason).
 * voice: main's approvals.voicePolicy ('any' | 'key' | 'click'). A "from now on" needs the talk key always.
 */
export function approvalAnswer(text, { voice = 'any', source = '', startedAt = 0, shownAt = 0, canRemember = false } = {}) {
  if (shownAt && startedAt && startedAt < shownAt) return 'early';
  const t = answerWords(text);
  if (DETAILS.test(t)) return 'details';
  const always = canRemember && ALWAYS_SAY.has(t);
  if (!always && !APPROVE.has(t)) return 'no';
  if (voice === 'click') return 'needs-click';
  if ((voice === 'key' || always) && source !== 'ptt') return 'needs-key';
  return always ? 'always' : 'yes';
}

/** What Siren says when an approval opens. */
export function approvalPrompt(req) {
  const parts = [`Permission needed: ${req.title}.`];
  if (req.tainted) parts.push('This came after reading outside content, so please check it on the screen.');
  if (req.kind === 'command') parts.push('Say details to hear the command.');
  parts.push(req.voice === 'click' ? 'Then click Approve or Deny.' : 'Say yes or no.');
  return parts.join(' ');
}

/** The line under the approval: how it can be answered by voice. */
export function approvalHint(req, { pttKey = 'the talk key', handsFree = false } = {}) {
  if (req.voice === 'click') return 'Click Approve or Deny: this one isn’t answered by voice. ';
  const say = (w) => (handsFree && (req.voice === 'key' || w === 'always') ? `hold ${pttKey} and say “${w}”` : `say “${w}”`);
  const first = say('yes');
  return `${first[0].toUpperCase()}${first.slice(1)} to approve${req.remember?.length ? `, ${say('always')} to stop asking` : ''}, “details” to hear more; anything else declines. `;
}
