// Everything that leaves the composer, from any source: the box (Enter), spoken words, Try again /
// Regenerate / Edit, a suggestion, a skill run, the setup flow. One place keeps the rule that two messages
// never go out in reverse order: a message waiting for its files to be read, or queued behind the reply
// being stopped, holds everything after it (attachcore.sendPlan, asked once for every source).
// It owns the pending outgoing state (the wait for files, the one queued message, edit mode's draft), hands
// the tray to the user's own words only, and gives the words and files back when a send is refused or
// fails. Pure, no DOM: chat.js passes its ports and draws what happened; test/outbox.test.js drives it with
// fakes.
import { sendPlan } from './attachcore.mjs';

const NO_FILES = Object.freeze({ tokens: [], meta: [] });

/**
 * ports:
 *  - tray: the composer's attachments (attach.js `tray`): count(), reading(), ready() → Promise (resolves
 *    once nothing is read any more), take() → { tokens, meta }, restore(files), setBusy(on, n).
 *  - box: the text box: read(), write(text).
 *  - turn: the chat's turn state (turnstate.js): `own` (this window's reply, or null), busy(), setWaiting(on).
 *  - deliver({ text, voice, hidden, redo, kept, files }) → Promise<{ refused } | { error } | {}>: draws the
 *    message and sends it (chat:send, or chat:redo for `redo`); a refusal or failure is drawn there too.
 *  - again(kind, messageId, text) → Promise<boolean>: runs the latest message again (chat.js runAgain).
 *  - stop(): stops this window's reply.
 *  - notify(text): a notice.
 *  - setup(): the setup conversation is open (it never takes the tray).
 *  - waitChanged(): a wait for files started or is about to send (the latest message's buttons step aside).
 *  - editEnded(): edit mode is over (the composer's edit bar goes).
 *  - defer(fn): runs fn after the current events (a queued message goes once the stopped reply has ended).
 */
export function createOutbox(ports) {
  const { tray, box, turn, deliver, again, stop, notify = () => {}, setup = () => false, waitChanged = () => {}, editEnded = () => {}, defer = (fn) => setTimeout(fn, 0) } = ports;
  let waiting = false; // a message waits for its attachments to be read
  let queued = null; // { text, voice, attach }: sent once the reply being stopped has ended
  let editing = null; // { messageId, draft }: ✎ Edit put the latest message in the box (draft: what was there)

  // Anything already waiting (for files, or behind the reply being stopped) goes first.
  const plan = (text) => sendPlan({ text, files: tray.count(), reading: tray.reading(), active: Boolean(turn.own), waiting: waiting || Boolean(queued) });

  function waitForFiles(then) {
    tray.setBusy(true, tray.count()); // "Reading 2 files…"
    turn.setWaiting(true);
    waiting = true;
    Promise.resolve(tray.ready()).finally(() => {
      waiting = false;
      turn.setWaiting(false);
      tray.setBusy(false);
      waitChanged(); // ✎ / ↻ come back before the message goes (its own 'start' then sets them)
      then();
    });
    waitChanged(); // ✎ / ↻ step aside meanwhile
  }

  function endEdit() {
    editing = null;
    editEnded();
  }

  /** Leaves edit mode; the box gets back what was in it before, unless keepText. */
  function cancelEdit({ keepText = false } = {}) {
    if (!editing) return;
    const { draft } = editing;
    endEdit();
    if (!keepText) box.write(draft);
  }

  /**
   * Sends a message: the box's words (attach: true), spoken words, a suggestion, a skill run, the setup
   * flow, or a redo (redo: the chat:redo request; kept: the files it keeps, shown until the stored copy
   * comes). Only attach (the user's own words, typed or spoken) takes the tray, never in setup, never with a
   * hidden message or a redo.
   */
  async function submit(text, { voice = false, hidden = false, attach = false, redo = null, kept = [] } = {}) {
    text = String(text || '').trim();
    const withFiles = attach && !hidden && !redo && !setup() && tray.count() > 0;
    if (!text && !withFiles && !redo) return 'none'; // a redo may have no words of its own (a message of files only)
    if (editing) cancelEdit({ keepText: true }); // another message went first: the box keeps the edit as a draft
    if (turn.own) {
      if (redo) return 'none'; // runAgain checked first; a reply that started since wins
      queued = { text, voice, attach };
      notify('Interrupting the current reply…');
      stop();
      return 'queue';
    }
    if (withFiles && tray.reading()) {
      waitForFiles(() => submit(text, { voice, attach }));
      return 'wait';
    }
    const files = withFiles ? tray.take() : NO_FILES;
    const res = (await deliver({ text, voice, hidden, redo, kept, files })) || {};
    if (res.error) tray.restore(files); // the message never reached the computer: its chips come back
    // The words come back to an empty box (a redo that failed reloads its conversation instead: nothing was dropped).
    if ((res.refused || (res.error && !redo)) && !box.read()) box.write(text);
    return res.refused || res.error ? 'refused' : 'send';
  }

  /** Enter or the send button. Returns sendPlan's answer, or (a promise of) 'edit'. */
  function typed() {
    const text = box.read().trim();
    if (editing) {
      // ✎ Edit: the latest message again, in its new words (main/redo.js).
      const { messageId, draft } = editing;
      endEdit();
      box.write('');
      return Promise.resolve(again('edit', messageId, text)).then((started) => {
        // What was typed meanwhile stays. Refused: the edited text stays as a draft (an empty edit gives the old draft back).
        if (!box.read()) box.write(started || !text ? draft : text);
        return 'edit';
      });
    }
    const p = plan(text);
    if (p === 'wait') waitForFiles(typed); // the text stays in the box meanwhile
    if (p !== 'send' && p !== 'queue') return p;
    box.write('');
    submit(text, { attach: true });
    return p;
  }

  /**
   * Spoken words (autoSend off: they go into the box). While something is waiting they go into the box
   * too, never in its place; during a reply they stop it and go once it has ended.
   */
  function spoken(text, { autoSend = true } = {}) {
    const add = () => box.write((box.read() ? `${box.read()} ` : '') + text);
    if (!autoSend) return (add(), 'box');
    const p = plan(text);
    if (p === 'hold') {
      add();
      notify(waiting ? 'Still reading your file; your words are in the box.' : 'Your last message goes first; these words are in the box.');
    } else if (p === 'wait') waitForFiles(() => spoken(text));
    else if (p === 'queue') {
      queued = { text, voice: true, attach: true };
      stop();
    } else if (p === 'send') submit(text, { voice: true, attach: true });
    return p;
  }

  return {
    /** A message waits for its files (runAgain and startEdit refuse with 'Still reading your file…'). */
    get waitingFiles() {
      return waiting;
    },
    /** ✎ Edit mode is on (Esc cancels it; a missed reply doesn't reload over it). */
    get editing() {
      return Boolean(editing);
    },
    typed,
    spoken,
    submit,

    /** This window's reply is over: a message queued behind it goes now. */
    replyEnded() {
      if (!queued) return;
      const q = queued;
      queued = null;
      defer(() => submit(q.text, { voice: q.voice, attach: q.attach }));
    },

    /**
     * ✎ Edit: the latest message's words (text; null when it isn't there) into the box, what was there kept
     * as the draft. False when refused: a message waits for its files (no edit in its place), or a reply runs.
     */
    startEdit(messageId, text) {
      if (waiting) return (notify('Still reading your file…'), false);
      if (text == null || turn.busy()) return false;
      if (!editing) editing = { messageId, draft: box.read() };
      else editing.messageId = messageId;
      box.write(text);
      return true;
    },

    cancelEdit,
  };
}
