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
