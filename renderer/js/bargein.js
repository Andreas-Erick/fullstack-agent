// Whether the reply that is streaming is still spoken after the user talks over the agent. Pure (no DOM),
// so it is tested directly (test/bargein.test.js).
//
// Talking over the agent (the talk key, or voice in hands-free mode) silences the rest of the reply: the
// new words usually replace it. Two exceptions used to leave replies text-only:
//  - an approval is waiting ("Permission needed… say yes or no"): the words answer it, the reply goes on;
//  - the words turn out to be nothing (empty transcript, an accidental key press) or only an approval
//    answer: the reply speaks again from there (barge-in-over).

/** The user started talking while `reply` ({ muted }) streams. */
export function bargeIn(reply, { approvalPending = false } = {}) {
  if (!reply || approvalPending) return;
  reply.muted = true;
}

/** What the user said didn't replace the reply: let it speak again. */
export function bargeInOver(reply) {
  if (reply) reply.muted = false;
}
