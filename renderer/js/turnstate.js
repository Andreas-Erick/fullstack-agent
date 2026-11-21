// The open conversation and the replies being written in it, as data: shared by the desktop's chat
// (renderer/js/chat.js) and the phone client (renderer/remote/app.js), which only draw it. Events from
// main (chat:event / the device stream's chat.event) are folded in by apply(): which turn an event belongs
// to (this client's own, one started elsewhere in the open conversation, or none), its text, tool calls,
// notices and outcome, the stored messages kept in step, events held while a send's requestId isn't known
// yet, and what Try again, Regenerate and Edit may do to the latest exchange. Pure, no DOM: imported
// directly by test/turnstate.test.js, served to the phone as /js/turnstate.js.
import { toolLabel } from './chatcore.js';

/**
 * A reconnect's view of the replies still being written (`running`, the server's requestIds) against this
 * client's own turn: kept when still running or not sent yet (no requestId), ended when it finished while
 * the link was down (the loaded messages already hold it). Others still running are followed.
 * → { keepActive, endActive, follow: [requestId] }
 */
export function reconcile(active, running) {
  const list = Array.isArray(running) ? running.filter((x) => typeof x === 'string' && x) : [];
  const id = active?.requestId;
  const keepActive = Boolean(active) && (!id || list.includes(id));
  return { keepActive, endActive: Boolean(active) && !keepActive, follow: list.filter((x) => x !== id) };
}

/**
 * A notice's words. A message run again names the tools the earlier attempt already ran (`tools`) and the
 * ones cut off before they reported back (`cut`, maybe never done), as the chips name them; anything else
 * says its own `message`.
 */
export function noticeText(ev) {
  const label = (names) => names.map((n) => toolLabel(n)).join(', ');
  const tools = Array.isArray(ev?.tools) ? ev.tools : [];
  const cut = Array.isArray(ev?.cut) ? ev.cut : [];
  const said = [tools.length ? `Already done by the earlier attempt or reply (not undone): ${label(tools)}.` : '', cut.length ? `Cut off before it reported back (check before repeating): ${label(cut)}.` : ''].filter(Boolean).join(' ');
  return `⚠ ${said || String(ev?.message || '')}`;
}

/**
 * The face's state from what is going on: idle / listening / thinking / working (tools running) /
 * speaking, then happy (a moment after a reply) and sleeping. A reply written without a voice (`spoken`
 * false) counts as speaking while its text streams. `demo`: a scripted state that wins over everything.
 */
export function faceState({ demo = null, recording = false, playing = false, transcribing = false, generating = false, toolsRunning = 0, streamingText = false, spoken = false, happy = false, sleeping = false } = {}) {
  if (demo) return demo;
  if (recording) return 'listening';
  if (playing) return 'speaking';
  if (transcribing) return 'thinking';
  if (generating) return toolsRunning > 0 ? 'working' : streamingText && !spoken ? 'speaking' : 'thinking';
  if (happy) return 'happy';
  if (sleeping) return 'sleeping';
  return 'idle';
}

const DAY_MS = 86400000;
const JOINABLE = new Set(['text', 'retract', 'tool_start', 'tool_end', 'notice']); // a reply followed from its middle
const NONE = { again: null, edit: null, reply: null, state: null, certain: true };

/**
 * The conversation state. redo: renderer/js/redocore.mjs (its latest/actions rules), passed in by the
 * desktop, which offers Try again, Regenerate and Edit; the phone passes none (it resends its own failed
 * message instead).
 *
 * A turn: { requestId, mine, text, tools: Map(id → { id, name, input, ok, preview }), running (tools not
 * finished), notices, outcome: running | done | failed | stopped | unsent, error, message (the stored
 * reply), userMessage, muted (talked over: not spoken), greeting (a persona switch's hello), view (the
 * client's own nodes; never read here) }.
 */
export function createChat({ redo = null } = {}) {
  let convId = null;
  let messages = []; // the open conversation's messages as stored (hidden ones too)
  let setup = false;
  let own = null; // this client's turn; requestId null while its send is in flight
  const turns = new Map(); // requestId → a turn started elsewhere in the open conversation
  let held = []; // events that came while own's requestId wasn't known
  let waiting = false; // a message waiting for its files to be read

  const newTurn = (requestId, mine, view = null) => ({ requestId, mine, text: '', tools: new Map(), running: 0, notices: [], outcome: 'running', error: '', message: null, userMessage: null, muted: false, greeting: '', view });

  /** Takes the exchange from message `id` on out of the list (main took it out of the conversation). */
  function dropFrom(id) {
    const i = messages.findIndex((m) => m?.id === id);
    if (i >= 0) messages.splice(i);
    return i >= 0;
  }

  // The failed or stopped message as this client saw it end (main stored the full record).
  function markAttempt(outcome, error) {
    const l = redo?.latest(messages);
    if (!l?.own || l.state === 'answered') return;
    messages[l.index] = { ...l.user, attempt: { outcome, at: Date.now(), ...(outcome === 'failed' ? { error: String(error || '') } : {}) } };
  }

  function end(turn, outcome = null) {
    if (!turn) return;
    if (outcome) turn.outcome = outcome;
    turn.running = 0;
    if (turn === own) own = null;
    if (turns.get(turn.requestId) === turn) turns.delete(turn.requestId);
  }

  function finish(turn, outcome, ev) {
    if (outcome === 'done') {
      turn.message = ev.message || null;
      if (ev.message) messages.push(ev.message);
    } else {
      turn.error = String(ev.message || '');
      markAttempt(outcome, turn.error);
    }
    end(turn, outcome);
    return { type: outcome, turn, mine: turn.mine, message: turn.message, error: turn.error };
  }

  // One event of a known turn (apply's second half).
  function fold(turn, ev) {
    const mine = turn.mine;
    switch (ev.type) {
      case 'text':
        turn.text += String(ev.delta ?? '');
        return { type: 'text', turn, mine, delta: String(ev.delta ?? '') };
      case 'retract':
        turn.text = turn.text.slice(0, Math.max(0, turn.text.length - (Number(ev.chars) || 0)));
        return { type: 'retract', turn, mine };
      case 'tool_start': {
        const tool = { id: ev.id, name: ev.name, input: ev.input, ok: undefined, preview: '' };
        turn.tools.set(ev.id, tool);
        turn.running++;
        return { type: 'tool_start', turn, mine, tool, work: ev.work || null };
      }
      case 'tool_end': {
        const prev = turn.tools.get(ev.id);
        const tool = { id: ev.id, name: ev.name || prev?.name, input: prev?.input, ok: ev.ok, preview: ev.preview || '' };
        turn.tools.set(ev.id, tool);
        turn.running = Math.max(0, turn.running - 1);
        return { type: 'tool_end', turn, mine, tool, known: Boolean(prev) };
      }
      case 'notice': {
        const text = noticeText(ev);
        turn.notices.push(text);
        return { type: 'notice', turn, mine, text, toast: Boolean(ev.toast) };
      }
      case 'persona_switched':
        turn.greeting = String(ev.greeting || ''); // spoken in the new voice after this reply
        return { type: 'other', turn, mine, ev };
      case 'done':
        return finish(turn, 'done', ev);
      case 'error':
        return finish(turn, 'failed', ev);
      case 'aborted':
        return finish(turn, 'stopped', ev);
      default:
        return { type: 'other', turn, mine, ev };
    }
  }

  /** Is a reply being written in the open conversation (here or elsewhere), or a message waiting for its files? */
  const busy = () => Boolean(own || turns.size || waiting);
  const actions = () => (redo ? redo.actions(messages, { busy: busy(), setup }) : NONE);

  return {
    get convId() {
      return convId;
    },
    get messages() {
      return messages;
    },
    get setup() {
      return setup;
    },
    /** This client's turn, or null. */
    get own() {
      return own;
    },
    /** The turns started elsewhere that are being followed. */
    get others() {
      return [...turns.values()];
    },

    /** A conversation opened (or loaded again): its stored messages. Turns followed in the old list go; own stays. */
    open({ id = null, messages: list = [], setup: isSetup = false } = {}) {
      convId = id || null;
      messages = Array.isArray(list) ? list.slice() : [];
      setup = Boolean(isSetup);
      turns.clear();
    },
    /** The open conversation's id changed without a reload (a new one got its id, or it is gone). */
    setConv(id) {
      convId = id || null;
    },
    /** The setup flow goes on in conversation `id` with what is on the screen. */
    continueIn(id) {
      convId = id || null;
      setup = true;
    },
    dropFrom,

    /** This client sends a message: its turn (requestId null while the send is in flight; events are held meanwhile). */
    begin({ requestId = null, view = null } = {}) {
      own = newTurn(requestId, true, view);
      held = [];
      return own;
    },
    /** The send was accepted: own's requestId, and the events held meanwhile, to apply now in order. */
    sent(requestId) {
      if (own) own.requestId = requestId;
      const h = held;
      held = [];
      return h;
    },
    /** A turn ends without its event (a send refused or failed, a reconnect found it finished). */
    end,

    /**
     * One event → what happened, for the client to draw: { type, turn, mine, … } with type start (drop: the
     * message id it replaces, title), text, retract, tool_start / tool_end (tool), notice (text, toast),
     * done (message), failed / stopped (error), other (ev: side events such as memory_changed), held (kept
     * for sent()), unknown (the end of a turn in the open conversation that wasn't followed) or null (not for
     * here). `joined`: the first event seen of a turn followed from its middle (no view yet).
     */
    apply(ev) {
      if (!ev || typeof ev !== 'object') return null;
      if (own && !own.requestId && !turns.has(ev.requestId)) {
        held.push(ev);
        return { type: 'held' };
      }
      const mine = Boolean(own && own.requestId && ev.requestId === own.requestId);
      if (!mine && (!convId || ev.conversationId !== convId)) return null;
      if (ev.type === 'start') {
        const drop = ev.replaces ? String(ev.replaces) : null;
        if (!mine && turns.has(ev.requestId)) return null; // already followed (a reconnect found it running)
        if (mine) convId = ev.conversationId || convId;
        if (drop) dropFrom(drop);
        const turn = mine ? own : newTurn(ev.requestId, false);
        if (!mine) turns.set(ev.requestId, turn);
        if (ev.userMessage) {
          turn.userMessage = ev.userMessage;
          messages.push(ev.userMessage);
        }
        return { type: 'start', turn, mine, drop, title: ev.title || '' };
      }
      let turn = mine ? own : turns.get(ev.requestId);
      let joined = false;
      if (!turn) {
        // A reply in the open conversation whose start went by (it began before this conversation was opened
        // here): followed from here on; one that ends unseen is 'unknown' (the client reads the conversation again).
        if (!JOINABLE.has(ev.type)) return { type: 'unknown', mine, ev };
        turn = newTurn(ev.requestId, false);
        turns.set(ev.requestId, turn);
        joined = true;
      }
      const step = fold(turn, ev);
      return joined ? { ...step, joined } : step;
    },

    /** After a reconnect (the server's `running` list): { keepOwn, ended (own, if it finished meanwhile), follow: [new turns] }. */
    reconcile(running) {
      const r = reconcile(own, running);
      const ended = r.endActive ? own : null;
      if (ended) end(ended);
      const follow = r.follow.filter((id) => !turns.has(id)).map((id) => {
        const t = newTurn(id, false);
        turns.set(id, t);
        return t;
      });
      return { keepOwn: r.keepActive, ended, follow };
    },

    /** Talking over the agent silences the rest of own reply, unless the words answer a waiting approval. */
    bargeIn({ approvalPending = false } = {}) {
      if (own && !approvalPending) own.muted = true;
    },
    /** What was said didn't replace the reply (nothing, or only an approval answer): it speaks again. */
    bargeInOver() {
      if (own) own.muted = false;
    },

    /** What is running, for the face: own only (the desktop) or every turn in the open conversation (the phone). */
    activity({ ownOnly = false } = {}) {
      const list = [...(own ? [own] : []), ...(ownOnly ? [] : turns.values())];
      return { generating: list.length > 0, toolsRunning: list.reduce((n, t) => n + t.running, 0), streamingText: list.some((t) => t.text.length > 0) };
    },

    setWaiting(on) {
      waiting = Boolean(on);
    },
    busy,

    /**
     * What may be done to the latest exchange: { again, edit, reply, state, certain } (ids or null). Nothing
     * while a reply is being written in this conversation (here or on another device) or a message waits
     * for its files, nor in the setup conversation.
     */
    actions,
    /** The latest exchange (redocore.latest), or null. */
    latest() {
      return redo?.latest(messages) || null;
    },
    /**
     * How a reloaded conversation's unanswered (or stopped) latest message ended, for the line under it:
     * { kind: 'noreply' | 'failed' | 'stopped', error } or null when there is nothing to offer.
     */
    failure() {
      const a = actions();
      const l = redo?.latest(messages);
      if (!a.again || !l || l.state === 'answered') return null;
      const attempt = l.user.attempt || {};
      return !l.certain ? { kind: 'noreply', error: '' } : attempt.outcome === 'failed' ? { kind: 'failed', error: String(attempt.error || '') } : { kind: 'stopped', error: '' };
    },
    /**
     * A recent (24 h) failure of the latest exchange, for the Face layout's card when a conversation opens:
     * { failed: true, error } or { text } (a stop, or no reply), else null. Nothing while busy (actions()).
     */
    failedCard(now = Date.now()) {
      const a = actions();
      const l = redo?.latest(messages);
      if (!a.again || !l || l.state === 'answered') return null;
      const at = l.user.attempt?.at || l.replies[l.replies.length - 1]?.createdAt || l.user.createdAt || 0;
      if (now - at > DAY_MS) return null;
      if (l.certain && l.user.attempt?.outcome === 'failed') return { failed: true, error: String(l.user.attempt.error || '') };
      return { text: l.state === 'stopped' ? l.replies[l.replies.length - 1]?.content || '*(stopped)*' : l.certain ? '*(stopped)*' : 'This message got no reply.' };
    },
  };
}
