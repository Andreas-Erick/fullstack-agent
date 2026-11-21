// A local brain's turn (Ollama, LM Studio, the router's `local`): when localcore's rules apply. The rules
// themselves (what counts as giving up, a claim, a question, a read-only tool…) are pure, in localcore.js;
// this module owns the turn they apply in, so llm.js runs one generic OpenAI streaming loop and calls the
// hooks here (runOpenAI: `requestQuirks` on every request, `ctx.localTurn` for the compact prompt):
//  - where a brain is local, one answer for llm.js and persona.js (isLocalBrain, localBrainOf);
//  - the hand-over to Claude: who to (handOverTarget), straight away or on the model's request (handOverPlan),
//    and the tool hand_over's request, refused once the turn changed something (turn.requestHandOver);
//  - the compact toolset: the everyday tools, the groups loaded before (conv.toolGroups) or obvious from the
//    message, more on request (tools_more → turn.loadGroup);
//  - the nudges: a reply that gave up unlooked (LOOK_FIRST) or claimed an action no tool did (CLAIM_CHECK),
//    each asked about once and never stored; a write tool refused for a question (NOT_FOR_A_QUESTION);
//  - the request quirks a server refused once (images, a later system message, the local extras, tools),
//    remembered per server and model for the app's run.
const localcore = require('./localcore');
const { isEngineeringTask } = require('./engineering');
const log = require('./logger');

// ------------------------------------------------------------------ is this brain local?

/**
 * A brain is local when it runs on the OpenAI path (provider 'openai': FreeLLMAPI, the router's providers)
 * at an address on this computer, or as the router's `local`. A Claude brain whose old llm.baseUrl still
 * points at localhost is not (it checked the Claude sign-in on every message and showed a false "Handed to
 * Claude"). `settings` are concrete (router.concrete / llm.js narrow), never 'auto'.
 */
const isLocalBrain = (settings) => settings?.llm?.provider === 'openai' && localcore.isLocal(settings);

/**
 * The local brain of these settings, concrete, or null: in multi-provider mode the router's `local` when a
 * model is set; else the chosen brain when it is local. (persona.js: the summary for small models.)
 */
function localBrainOf(settings) {
  const router = require('./router');
  const id = settings.llm.provider;
  if (id === 'auto') return settings.local?.model ? router.concrete(settings, 'local') : null;
  const narrowed = router.PROVIDERS[id]?.openai ? router.concrete(settings, id) : settings;
  return isLocalBrain(narrowed) ? narrowed : null;
}

/** Does this turn get the compact prompt (localcore.compactWanted, on the OpenAI path only)? */
const wantsCompact = (settings) => settings?.llm?.provider === 'openai' && localcore.compactWanted(settings);

// ------------------------------------------------------------------ hand-over to Claude
// A local brain hands a message it can't do well to the Claude brain (setting llm.handOver, off by default
// and user-only: the message then leaves this computer). Obvious cases go straight there
// (localcore.handOverHint), others when the local model calls hand_over; never after it changed something.

/**
 * The Claude brain to hand over to, or null: the setting is on (or this is a routine: see handOverPlan),
 * this brain is local, Claude is ready.
 */
async function handOverTarget(settings, narrowed, { routine = false } = {}) {
  // A Claude brain never asks the router (the Claude sign-in check starts the CLI).
  if (!isLocalBrain(narrowed) || !(settings.llm.handOver || routine)) return null;
  const ready = await require('./router').status(settings).catch(() => []);
  return ['claude-code', 'anthropic'].find((id) => ready.some((p) => p.id === id && p.configured && !p.resting)) || null;
}

/**
 * How a message on this brain goes: { to, now, offer }. `now`: why it goes to `to` without asking the
 * local model ('' = it doesn't); `offer`: the local model gets the tool hand_over. A routine the user made
 * for a connected service ("sync Google Calendar") can only work on Claude (a local brain has no
 * connectors): it goes there even with the hand-over off, and only then. `text` is the whole message
 * (attached text included: a long attachment is "a long text"); services(): the connector names, asked only
 * when there is a Claude brain to hand to.
 */
async function handOverPlan(settings, narrowed, { setup = false, routine = false, text = '', images = 0, services = async () => [] } = {}) {
  const to = setup ? null : await handOverTarget(settings, narrowed, { routine });
  if (!to) return { to: null, now: '', offer: false };
  const userOn = Boolean(settings.llm.handOver);
  const names = await services();
  if (!userOn) {
    const needed = localcore.neededService(text, names);
    return { to, now: needed ? `the routine needs ${needed}` : '', offer: false };
  }
  return { to, now: localcore.handOverHint(text, { services: names, engineering: !routine && isEngineeringTask(text), images }), offer: true };
}

// ------------------------------------------------------------------ request quirks
// What a server refused once, by `${baseUrl}|${model}`, so later requests leave it out at once.
const refused = { tools: new Set(), extras: new Set(), systemNote: new Set() };

const IMAGE_REFUSED = [400, 404, 415, 422];
const NOTE_REFUSED = [400, 422, 500];
const EXTRAS_REFUSED = [400, 422];
const TOOLS_REFUSED = [400, 404, 415, 422, 500];

/**
 * One request's quirks on an OpenAI-compatible server (any brain on that path). `base` + `model` name the
 * server; `tools`: the turn has tools; `note`: this message's notes go just before it (localcore.placeNote).
 * retry(err, { round, payload, imaged }) says which retry a refused request gets, in this order, or null
 * (the error stands): 'images' (the model can't see: again without the pictures, round 0), 'note' (a
 * template that refuses a system message after the first: the notes go into the user's message), 'extras'
 * (a server that refuses keep_alive/reasoning_effort), 'tools' (no function calling, round 0). What it
 * returns is remembered: the state below changes, and for the server's later requests too.
 */
function requestQuirks({ settings, base, model, tools = false, note = '' }) {
  const key = `${base}|${model}`;
  let useTools = tools && !refused.tools.has(key);
  let noteAsSystem = !refused.systemNote.has(key);
  return {
    get useTools() { return useTools; },
    get noteAsSystem() { return noteAsSystem; },
    // The role of a message from the app inside the conversation (a nudge, like the notes).
    get noteRole() { return noteAsSystem ? 'system' : 'user'; },
    /** keep_alive and reasoning_effort for a local server (localcore.requestExtras), unless refused. */
    extras: (pace) => (refused.extras.has(key) ? {} : localcore.requestExtras(settings, pace)),
    retry(err, { round, payload = {}, imaged = false }) {
      const status = err?.status;
      if (imaged && IMAGE_REFUSED.includes(status) && round === 0) return 'images';
      if (note && noteAsSystem && NOTE_REFUSED.includes(status) && round === 0) {
        refused.systemNote.add(key);
        noteAsSystem = false;
        return 'note';
      }
      if ((payload.keep_alive || payload.reasoning_effort) && EXTRAS_REFUSED.includes(status) && !refused.extras.has(key)) {
        refused.extras.add(key);
        return 'extras';
      }
      if (payload.tools && TOOLS_REFUSED.includes(status) && round === 0) {
        refused.tools.add(key);
        useTools = false;
        return 'tools';
      }
      return null;
    },
  };
}

// ------------------------------------------------------------------ the compact turn

/**
 * A local model's turn with the compact prompt. `active`: the tools the settings allow; `catalog`: every
 * tool (tools.TOOLS), for tools_more and hand_over; `lastText`: the user's own words (no attached text);
 * `handOverTo`: the Claude brain this turn may hand over to (handOverPlan `offer`), or null.
 * The turn goes on the tool context as `ctx.localTurn` (tools/toolbox.js) and to llm.js runOpenAI, which
 * calls afterReply / beforeTool / afterTool / handedOver; finish(result) adds what the turn changed.
 */
function begin({ settings, conv = {}, active = [], lastText = '', catalog = [], handOverTo = null }) {
  // The everyday tools, the groups this conversation loaded before or this message obviously needs,
  // and tools_more for the rest (localcore.js TOOLBOX).
  const personas = (settings?.personas?.list || []).map((p) => p.name);
  const loaded = [...new Set([...(Array.isArray(conv.toolGroups) ? conv.toolGroups : []), ...localcore.hintGroups(lastText, { personas })])].filter((g) => localcore.TOOLBOX[g]);
  let groupsChanged = loaded.length !== (conv.toolGroups || []).length;
  // tools_more, and hand_over when this brain may hand messages to Claude.
  const extra = [catalog.find((t) => t.name === 'tools_more'), ...(handOverTo ? [catalog.find((t) => t.name === 'hand_over')] : [])];
  let list = [...localcore.compactTools(active, loaded), ...extra];
  const handOver = handOverTo ? { to: handOverTo, requested: '' } : null;
  const question = localcore.questionOnly(lastText);
  const nudged = { look: false, claim: false };
  let changed = false; // a tool that isn't a read ran and succeeded (the claim check)
  let wrote = false; // …other than hand_over itself (the hand-over)
  const failed = [];

  return {
    /** The tools the model gets this round (tools_more can add some mid-turn). */
    get tools() { return list; },
    /** The groups loaded so far, in load order. */
    get groups() { return loaded; },
    /** The tool names the prompt names: only the everyday ones, so it stays the same when a group is added. */
    get promptTools() { return [...localcore.compactTools(active).map((t) => t.name), ...extra.map((t) => t.name)]; },
    /** Why the model handed over (tool hand_over), or ''. */
    get handedOver() { return handOver?.requested || ''; },

    /**
     * Where the prompt goes. A local server reuses what it already read when the start of the request is
     * unchanged: the rules, the tools (which its template puts after the system text) and the history. So
     * the per-message part (time, calendar, recalled memories) goes just before the newest message
     * (localcore.placeNote), and only that and the message are read again: first word in ~0.2 s instead
     * of ~2.5 s. A compact prompt on a cloud server (llm.compactPrompt 'on') stays whole.
     */
    prompt({ system, stable, context, reminder }) {
      return isLocalBrain(settings) ? { system: `${stable}\n\n${reminder}`, turnNote: context } : { system, turnNote: '' };
    },

    /** tools_more: a group's tools, usable right after the call. Returns the tool's result. */
    loadGroup(group) {
      let added = [];
      if (localcore.TOOLBOX[group] && !loaded.includes(group)) {
        const before = new Set(list.map((t) => t.name));
        loaded.push(group);
        groupsChanged = true;
        list = [...localcore.compactTools(active, loaded), ...extra];
        added = list.filter((t) => !before.has(t.name)).map((t) => t.name);
        log.info('tools loaded', { group, added: added.length });
      }
      return added.length ? { added } : { note: `No new tools: the ${group} tools are already loaded, or turned off in Settings.` };
    },

    /** hand_over: the other brain answers, unless this turn already changed something. Returns the tool's result. */
    requestHandOver(reason) {
      if (!handOver) return { note: 'No stronger brain is set up: answer yourself.' };
      // Something this turn already changed would be done a second time by the other brain.
      if (wrote) return { note: 'You already changed something in this turn, so finish it yourself.' };
      handOver.requested = String(reason || 'a harder task').slice(0, 120);
      return { handedOver: true, note: 'Stop now and write nothing more: the stronger brain answers the user.' };
    },

    /**
     * A reply without tool calls: the messages to send before asking again (the reply taken back, then the
     * ask), or null when it stands. Sent, never stored. `useTools`/`noteRole` from requestQuirks; `rounds`:
     * the turn's tool rounds (no claim check on the last one, which can't call a tool).
     */
    afterReply(result, { round, rounds, useTools, noteRole = 'system', model } = {}) {
      if (result.calls?.length || !useTools) return null;
      // Gave up without looking anything up: asked once, on the first round, to look.
      if (round === 0 && !nudged.look && list.some((t) => t.name === 'memory_search') && localcore.gaveUpUnlooked(result.text)) {
        nudged.look = true;
        log.info('local model gave up without looking; asked to look first', { model });
        return [{ role: 'assistant', content: result.text }, { role: noteRole, content: localcore.LOOK_FIRST }];
      }
      // Says it did something no tool did ("Icelandic practice done." with nothing logged): asked once to
      // do it or say it isn't done.
      if (!nudged.claim && round < rounds && !changed && localcore.claimsAction(result.text)) {
        nudged.claim = true;
        log.info('local model claimed an action no tool did; asked to do it', { model, failed: failed.join(',') || undefined });
        return [{ role: 'assistant', content: result.text }, { role: noteRole, content: localcore.CLAIM_CHECK }];
      }
      return null;
    },

    /** Before a tool runs: the error it answers instead, or null. A question changes nothing: it is answered. */
    beforeTool(name) {
      if (!question || localcore.isReadTool(name) || name === 'hand_over') return null;
      log.info('local model tried to change something for a question; refused', { name });
      return localcore.NOT_FOR_A_QUESTION;
    },

    /** After a tool ran ({ name, ok }). A tool that changed something: no hand-over (it would run again there). */
    afterTool({ name, ok }) {
      if (!ok) failed.push(name);
      if (!ok || localcore.isReadTool(name)) return;
      changed = true;
      if (name !== 'hand_over') wrote = true;
    },

    /** The turn's result with the groups it loaded (kept for the conversation) and its hand-over request. */
    finish(result) {
      if (groupsChanged) result.convPatch = { ...(result.convPatch || {}), toolGroups: loaded };
      if (handOver?.requested) result.handOver = handOver.requested;
      return result;
    },
  };
}

module.exports = { isLocalBrain, localBrainOf, wantsCompact, handOverTarget, handOverPlan, requestQuirks, begin };
