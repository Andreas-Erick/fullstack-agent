// One chat turn for a conversation: main.js wires chat:send, chat:redo, routine runs, the tasks sync and the
// companion server to `start`, and conv:delete / conv:clear to `deleteConversation` / `clearConversations`.
// The module owns the order of a turn: attachments claimed, the redo gates (main/redo.js), busy from the gates
// on, the message stored with its running attempt, the reply streamed to the sink, the attempt recorded on a
// failure (after the sink heard it), the reply stored at the end, and a delete that lands meanwhile honoured.
// The window and devices are adapters passed to create(): send (window + paired devices) and toWindow.
const store = require('./store');
const log = require('./logger');
const llm = require('./llm');
const claudesession = require('./claudesession');
const selfchange = require('./selfchange');
const skills = require('./skills');
const screenshare = require('./screenshare');
const attachments = require('./attachments');
const attachcore = require('./attachcore');
const redo = require('./redo');
const projections = require('./projections');
const { UNTRUSTED_NOTICE } = require('./tools/common');

// The log tag a turn runs under (routines.js tells its own turn apart by it: stopRun).
const tagFor = (requestId) => String(requestId).slice(-6);

function create({ send = () => {}, toWindow = send } = {}) {
  const active = new Map(); // requestId -> AbortController (with .conversationId)
  // Deleted conversations: id -> the turn count when its files were gone (null while they are removed). A turn
  // that began before then may still hold the old copy and must not save it back; once every such turn has
  // settled the entry goes (prune).
  const deletions = new Map();
  const inflight = new Map(); // token -> its number, from start() until the turn's end
  let count = 0;

  const busy = (id) => [...active.values()].some((c) => c.conversationId === id); // a reply is being written there
  const isDeleted = (id) => deletions.has(id);

  function prune() {
    const oldest = Math.min(Infinity, ...inflight.values());
    for (const [id, at] of deletions) if (at !== null && at < oldest) deletions.delete(id);
  }

  function marked(ids) {
    for (const id of ids) deletions.set(id, null);
  }
  function settled(ids) {
    for (const id of ids) if (deletions.get(id) === null) deletions.set(id, count);
    prune();
  }

  // History ✕: its reply stops, its session ends (and a warm-up queued by opening it a moment ago doesn't
  // run), the file and the attachments folder go; a turn still being set up stores nothing.
  async function deleteConversation(id) {
    marked([id]);
    for (const c of active.values()) if (c.conversationId === id) c.abort();
    claudesession.deleted(id);
    try {
      const r = await store.deleteConversation(id);
      await attachments.removeFor(id).catch((error) => log.warn('attachments not removed', { error }));
      return r;
    } finally {
      settled([id]);
    }
  }

  // Clear all: the same for every conversation.
  async function clearConversations() {
    const ids = (await store.listConversations()).map((c) => c.id);
    marked(ids);
    for (const id of ids) claudesession.deleted(id);
    for (const c of active.values()) c.abort();
    try {
      const r = await store.clearConversations();
      await attachments.removeAll().catch((error) => log.warn('attachments not removed', { error }));
      return r;
    } finally {
      settled(ids);
    }
  }

  // One chat turn, from the window (chat:send) or a paired device (remote = the device name). Returns
  // at once; the reply streams as chat:event. Remote turns never carry a screenshot of this desktop.
  // display: what the chat shows instead of the text (routines); onFinish({ ok, text, error }) after the turn.
  // routine / auto ('tasks'): a turn the user didn't write, so it never counts as their chat (store.js lastOwnAt).
  // redo: Try again / Regenerate / Edit from the window (chat:redo; its text replaces `text`).
  // attachments: one-time tokens from chat:attach (main/attachments.js); only the user's own messages in the
  // window carry them. An expired one returns { refused } and nothing is stored.
  async function start(opts) {
    const token = Symbol('turn');
    inflight.set(token, ++count);
    const end = () => (inflight.delete(token), prune());
    let r;
    try {
      r = await begin(opts);
    } catch (err) {
      end();
      throw err;
    }
    if (r.background) r.background.finally(end);
    else end();
    return r.result;
  }

  async function begin({ conversationId, text, requestId, voice: viaVoice = false, hidden = false, remote = null, display = '', routine = '', auto = '', onFinish = null, redo: redoReq = null, attachments: tokens = [] }) {
    const settings = await store.getSettings();
    // Attachments (main/attachments.js): one-time tokens from chat:attach, claimed before anything is stored.
    const claim = tokens.length ? attachments.claim(tokens) : { items: [] };
    if (claim.error) return { result: { refused: claim.error } };
    // A failure before the turn runs in the background: it no longer counts as busy (below), and the
    // attachments' chips come back in the window.
    const fail = (err) => {
      active.delete(requestId);
      attachments.unclaim(tokens);
      throw err;
    };
    let conv = conversationId ? await store.getConversation(conversationId).catch(fail) : null;
    if (redoReq && !conv) fail(new Error('Conversation not found'));
    if (!conv) conv = await store.createConversation().catch(fail);
    if (remote && conv.setup) fail(new Error('The setup conversation can only be used on the desktop'));
    if (claim.items.length && (remote || conv.setup || hidden || routine || auto)) fail(new Error('Attachments can only go with your own messages in the chat.'));
    // Try again / Regenerate / Edit, and the same message sent again after a failure (main/redo.js).
    let prep;
    try {
      prep = redo.prepare({ conv, redo: redoReq, text, voice: viaVoice, remote, routine, auto, hidden, busy: busy(conv.id) });
    } catch (err) {
      fail(err);
    }
    text = prep.text;
    viaVoice = prep.voice;
    const again = prep.again;
    if (again) log.info('turn again', { kind: again.kind, fresh: again.fresh, acted: again.acted.length, uncertain: again.uncertain || undefined, from: remote ? 'device' : 'window' });
    const own = !conv.setup && !routine && !auto && !hidden; // the user's own message: its attempt is recorded (Try again)
    // Busy from the gates on, not only once the reply runs: another Try again, or the same message sent
    // again from the phone or the watch, can't pass them during the awaits below.
    const controller = new AbortController();
    controller.conversationId = conv.id;
    active.set(requestId, controller);
    // "/skill-name input": the agent gets the skill's steps; the chat shows what was typed.
    const slash = conv.setup ? null : await skills.fromSlash(text).catch(() => null);
    // While the screen is shared, the message carries a fresh screenshot (not stored).
    let images = [];
    if (!remote && !conv.setup && screenshare.state().active && settings.screen.attachToMessages !== false) {
      images = await screenshare.capture().then(
        (shot) => [shot.url],
        (err) => (send('app:notice', { kind: 'error', message: err.message }), []),
      );
    }
    const screenShot = images.length > 0;
    // Attached files: copies kept with the conversation, their text in blocks before the user's words;
    // attached images go with the message like a screenshot and are never stored (attachcore.compose).
    const saved = claim.items.length ? await attachments.save(conv.id, claim.items).catch(fail) : [];
    const prompt = slash ? skills.instructions(slash.skill, slash.args) : String(text);
    // A message run again keeps its files (their text is in the old message's blocks); its pictures are gone.
    const composed = saved.length
      ? attachcore.compose({ prompt, typed: String(text), items: saved, notice: UNTRUSTED_NOTICE })
      : again?.user?.attachments?.length
        ? attachcore.recompose(again.user, { prompt, typed: String(text) })
        : null;
    if (composed) images.push(...composed.images);
    const userMsg = {
      id: store.newId('m'),
      role: 'user',
      content: composed ? composed.content : prompt,
      createdAt: Date.now(),
      ...(slash ? { display: String(text), skill: slash.skill.slug } : {}),
      ...(composed ? { display: composed.display, attachments: composed.meta } : {}),
      ...(display ? { display: String(display) } : {}),
      ...(routine ? { routine } : {}),
      ...(auto ? { auto } : {}),
      ...(screenShot ? { screen: true } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(remote ? { remote } : {}),
      ...(viaVoice ? { spoken: true } : {}), // the cache warm-up guesses the next model from it (claudesession.warmTarget)
      ...(own ? { attempt: { outcome: 'running', at: Date.now() } } : {}),
    };
    conv.messages.push(userMsg);
    if (!conv.setup && !again?.keepTitle && conv.messages.filter((m) => m.role === 'user').length === 1) conv.title = (slash ? slash.skill.name : display || (composed && !String(text).trim() ? composed.title : String(text))).replace(/\s+/g, ' ').slice(0, 60);
    // Deleted (History ✕, Clear all) during the awaits above: the save would bring it back, with the files just copied.
    if (isDeleted(conv.id)) {
      if (saved.length) attachments.removeFor(conv.id).catch((error) => log.warn('attachments not removed', { error }));
      fail(new Error('The conversation was deleted'));
    }
    await store.saveConversation(conv).catch(fail);
    attachments.release(tokens);

    // Until that save, the file still had the old exchange: a warm-up that read it meanwhile is stale too.
    if (again?.fresh) claudesession.forget(conv.id);
    // Timing for the log: when the first words of the reply arrived, and when it finished.
    const startedAt = Date.now();
    let firstTextMs = null;
    // The source files the agent's tools write this turn (selfchange.touchedBy): the end-of-turn record
    // commits those and nothing else.
    const touched = new Set();
    let codeRoot = null;
    // The tools this turn ran (Try again tells the next attempt what already happened).
    const ran = new Map();
    let attemptSaved = false;
    // Events go out as the window sees them (projections.js); devices trim that copy (companion.js), and the
    // setup conversation never reaches them.
    const sink = projections.reachesDevices(conv) ? send : toWindow;
    const emit = (ev) => {
      if (firstTextMs === null && ev.type === 'text') firstTextMs = Date.now() - startedAt;
      // The Inner World sends the active persona to where the work happens (counts only).
      if (ev.type === 'tool_start' && !conv.setup) {
        require('./innerworld').noteTool(ev.name);
        const t = selfchange.touchedBy(ev.name, ev.input, codeRoot);
        if (t) {
          touched.add(t);
          selfchange.noteTouched(tagFor(requestId), t); // self_change_commit reads it under this turn's tag
        }
      }
      if (ev.type === 'tool_start') {
        ran.set(ev.id, { name: ev.name, ok: null, input: ev.input });
        // The first action that changes something is recorded at once: a quit or crash mid-turn leaves a trace.
        if (own && !attemptSaved && !redo.readOnly(ev.name)) {
          attemptSaved = true;
          const a = redo.attemptFrom({ running: true, ran, firstTextMs });
          redo.remember(conv.id, userMsg.id, a);
          store.updateConversation(conv.id, (c) => redo.withAttempt(c, userMsg.id, a)).catch((error) => log.warn('could not record the attempt', { error }));
        }
      }
      if (ev.type === 'tool_end' && ran.has(ev.id)) ran.get(ev.id).ok = ev.ok;
      sink('chat:event', projections.eventFor('window', { requestId, conversationId: conv.id, ...ev }));
    };
    emit({ type: 'start', userMessage: userMsg, title: conv.title, ...(again ? { replaces: again.replaces } : {}) });
    if (again?.acted.length || again?.uncertain) {
      const names = (list) => [...new Set(list.map((a) => a.name.replace(/^mcp__(claude_ai_)?/, '').replace(/_+/g, ' ')))].join(', ');
      const cut = again.unsure || [];
      const done = again.acted.filter((a) => !cut.includes(a));
      const who = settings.agent?.name || 'Siren';
      const said = [done.length ? `Already done by the earlier ${again.replyDropped ? 'reply' : 'attempt'} (not undone): ${names(done)}.` : '', cut.length ? `Cut off before it reported back (check before repeating): ${names(cut)}.` : ''].filter(Boolean).join(' ');
      emit({ type: 'notice', message: said || `The earlier attempt was cut off; ${who} checks before repeating anything.`, tools: done.map((a) => a.name), cut: cut.map((a) => a.name) });
    }
    if (again?.hadImages && !images.length) emit({ type: 'notice', message: 'This message had a picture with it; pictures aren’t kept, so the new reply can’t see it.' });

    // Run the turn in the background; the renderer receives streamed events. Every log line it
    // produces carries turn=<id> conv=<id>, so one request can be traced end to end.
    const tags = { turn: tagFor(requestId), conv: conv.id.slice(-6) };
    const background = log.withContext(tags, async () => {
      const trackChanges = settings.code.enabled && settings.code.allowSelfModify;
      const before = trackChanges ? await selfchange.fingerprint() : null;
      codeRoot = trackChanges ? await selfchange.root().catch(() => null) : null;
      try {
        const result = await llm.runTurn({ settings, conv, history: conv.messages, emit, signal: controller.signal, voice: viaVoice, images, routine: Boolean(routine), again: again?.again || null, taint: [...(screenShot ? ['the shared screen'] : []), ...(slash && skills.imported(slash.skill) ? [`the skill /${slash.skill.slug}`] : []), ...(composed?.taint || [])], imageNoun: attachcore.imageNoun({ screen: screenShot, images: composed?.images.length || 0 }) });
        const assistantMsg = {
          id: store.newId('m'),
          role: 'assistant',
          content: result.text || (controller.signal.aborted ? '*(stopped)*' : ''),
          toolCalls: result.toolCalls,
          raw: result.raw,
          model: result.model,
          provider: result.provider || settings.llm.provider,
          persona: settings.agent?.name || undefined, // who answered: a later switch is named in the next turn's context
          createdAt: Date.now(),
          ...(controller.signal.aborted ? { stopped: true } : {}), // the Claude API path stores a stopped reply (Try again)
        };
        if (isDeleted(conv.id)) {
          // Deleted mid-reply: the API paths return from an abort (no AbortError), so the window and devices
          // hear the end here, as the Claude Code path's throw tells them below.
          emit({ type: 'aborted', message: 'Stopped' });
          return onFinish?.({ ok: false, error: 'The conversation was deleted', conversationId: conv.id });
        }
        const fresh = (await store.getConversation(conv.id)) || conv;
        fresh.messages.push(assistantMsg);
        redo.stripAttempt(fresh, userMsg.id); // answered: nothing to try again
        redo.remember(conv.id, null);
        // What the brain keeps with the conversation: loaded tool groups, the Claude session's fields (claudesession.js).
        if (result.convPatch) Object.assign(fresh, result.convPatch);
        await store.saveConversation(fresh);
        emit({ type: 'done', message: assistantMsg });
        onFinish?.({ ok: true, text: assistantMsg.content, conversationId: conv.id });
        log.info('reply', { model: result.model, voice: viaVoice, remote: Boolean(remote), firstTextMs, totalMs: Date.now() - startedAt, chars: assistantMsg.content.length, tools: (result.toolCalls || []).map((t) => t.name).join(',') });
        log.debug('reply text', { text: assistantMsg.content.slice(0, 160) });
        // The turn switched persona (or another setting that defines the session): the next session
        // starts now, while the reply is read or heard, not when the user speaks again.
        const after = await store.getSettings();
        claudesession.afterTurn(settings, after, fresh).catch((error) => log.warn('prewarm failed', { error }));
      } catch (err) {
        const aborted = controller.signal.aborted || err?.name === 'AbortError';
        // A routine whose brain isn't ready yet, or that ran while the computer was offline, waits and
        // runs again (routinecore.retryPlan): not a fault.
        const rc = require('./routinecore');
        const notReady = !aborted && routine && (rc.brainNotReady(err) || rc.offline(err));
        if (aborted) log.info('turn interrupted', { conversation: conv.id });
        else log[notReady ? 'warn' : 'error'](notReady ? 'turn not ready' : 'turn failed', { provider: settings.llm.provider, model: settings.llm.provider === 'claude-code' ? settings.claudeCode.model : undefined, voice: viaVoice, ms: Date.now() - startedAt, error: err });
        const attempt = own && !isDeleted(conv.id) ? redo.attemptFrom({ aborted, err, ran, firstTextMs }) : null;
        if (attempt) redo.remember(conv.id, userMsg.id, attempt); // an immediate Try again sees it
        // The window hears it first (a barge-in waits for this); the record is written after.
        emit({ type: aborted ? 'aborted' : 'error', message: aborted ? 'Stopped' : err?.message || String(err) });
        onFinish?.({ ok: false, error: aborted ? 'Stopped' : err?.message || String(err), conversationId: conv.id });
        if (attempt) store.updateConversation(conv.id, (c) => redo.withAttempt(c, userMsg.id, attempt)).catch((e) => log.warn('could not record the failed attempt', { error: e }));
      } finally {
        active.delete(requestId);
        selfchange.forgetTurn(tagFor(requestId));
        if (trackChanges) recordSelfChanges(before, text, [...touched]).catch((e) => log.warn('self-change tracking failed', { error: e }));
      }
    });
    return { result: { conversationId: conv.id }, background };
  }

  // After a turn: if the agent changed its own source, syntax-check and record it in the history. Only
  // what its tools wrote (`touched`, see selfchange.touchedBy): the repo may be edited by someone else
  // while a turn runs (the developer, another session), and that is never the agent's change to record.
  // A shell command in the turn ('*') could have changed anything, so then everything dirty counts.
  async function recordSelfChanges(before, userText, touched = []) {
    const after = await selfchange.fingerprint();
    if (after === null || after === before) return;
    const dirty = await selfchange.dirtyFiles();
    if (!dirty.length) return;
    const all = touched.includes('*');
    const only = all ? null : touched;
    if (!all && !dirty.some((d) => only.includes(d.file))) {
      log.info('self-change tracking: the repo changed during the turn, but not by the agent', { dirty: dirty.length, touched: touched.length });
      return;
    }
    const r = await selfchange.commit(`Requested: "${String(userText).replace(/\s+/g, ' ').slice(0, 80)}"`, { source: 'auto (end of turn)', only });
    if (r.ok && !r.nothing) send('self:event', { type: 'committed', change: r });
    else if (!r.ok) send('self:event', { type: 'check_failed', files: r.files, output: r.check.output });
  }

  return {
    start,
    abort: (requestId) => active.get(requestId)?.abort(),
    busy,
    // The conversations with a reply still being written (the handoff note counts those as interrupted).
    replying: () => new Set([...active.values()].map((c) => c.conversationId)),
    deleteConversation,
    clearConversations,
    // For tests: how many deletes are still remembered.
    pendingDeletes: () => deletions.size,
  };
}

module.exports = { create, tagFor };
