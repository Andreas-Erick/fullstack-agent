// Runs a rehearsal (rules and prompts in rehearsalcore.js): one model call per turn, characters in
// order, then a debrief. Saved as a note in Inner World/Rehearsals/, shown on the Stage in the Inner
// World view, and noted in the user's memory stream. Bounded: at most MAX_CALLS turns, a time limit per
// call and for the whole scene; a rehearsal stopped early still keeps what was said.
const store = require('./store');
const log = require('./logger');
const obsidian = require('./obsidian');
const core = require('./rehearsalcore');

const CALL_LIMIT_MS = 90000;
const TOTAL_LIMIT_MS = 8 * 60 * 1000;

function withLimit(promise, ms, message) {
  let t;
  return Promise.race([promise, new Promise((_, reject) => (t = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(t));
}

const fileName = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Rehearsal';

/** Plays the scene and debriefs it. onTurn(line) is called after every turn (progress for the chat). */
async function run(args, { onTurn = () => {} } = {}) {
  const spec = core.validate(args);
  const settings = await store.getSettings();
  const fast = { ...settings, llm: { ...settings.llm, modelMode: 'fast' } };
  const llm = require('./llm');
  const started = Date.now();
  const lines = [];
  let ended = 0;
  let stopped = '';
  for (const speaker of core.order(spec)) {
    if (Date.now() - started > TOTAL_LIMIT_MS) {
      stopped = 'time limit';
      break;
    }
    const prompt = speaker === 'You' ? core.standInPrompt(spec, lines) : core.characterPrompt(spec, speaker, lines);
    let text;
    try {
      text = await withLimit(llm.complete(fast, prompt), CALL_LIMIT_MS, `${speaker}'s turn took too long.`);
    } catch (err) {
      log.warn('rehearsal turn failed', { speaker, error: err });
      if (!lines.length) throw err;
      stopped = err.message;
      break;
    }
    const said = core.parseTurn(text, speaker);
    if (!said) {
      // Everyone but one says it's over: it's over.
      if (++ended >= Math.max(1, spec.characters.length)) break;
      continue;
    }
    ended = 0;
    const line = { who: speaker, text: said };
    lines.push(line);
    onTurn(line);
  }

  let debrief = null;
  try {
    const text = await withLimit(llm.complete(settings, core.debriefPrompt(spec, lines)), CALL_LIMIT_MS, 'The debrief took too long.');
    debrief = core.parseDebrief(require('./persona').extractJson(text));
  } catch (err) {
    log.warn('rehearsal debrief failed', { error: err });
  }

  const at = Date.now();
  let note = '';
  if (await obsidian.vaultPath().catch(() => null)) {
    note = `Inner World/Rehearsals/${obsidian.ymd()} ${fileName(spec.title)}.md`;
    await obsidian.writeNote(note, core.markdown(spec, lines, debrief, at), 'overwrite', { source: 'rehearsal' }).catch((err) => {
      log.warn('rehearsal note failed', { error: err });
      note = '';
    });
  }
  await require('./innerworld').recordRehearsal({ at, title: spec.title, outcome: debrief?.outcome || '', note, turns: lines.length, cast: spec.characters.map((c) => c.name) }).catch(() => {});
  const st = require('./stream');
  if (await st.enabled()) await st.add(st.USER, [{ text: `Rehearsed "${spec.title}" (${spec.userRole}): ${debrief?.outcome || `${lines.length} turns`}`, importance: 5 }]).catch(() => {});
  log.info('rehearsal', { turns: lines.length, characters: spec.characters.length, ms: at - started, debrief: Boolean(debrief), stopped: stopped || undefined });
  return { title: spec.title, transcript: lines, debrief, note, stopped: stopped || undefined, hiddenGoals: spec.characters.map((c) => ({ name: c.name, goal: c.goal })) };
}

module.exports = { run };
