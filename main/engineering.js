// Engineering mode: coding, self-change and debugging turns need room. Reading several files,
// editing, checking, testing and committing easily takes 20+ tool rounds, and design work benefits
// from more thinking. Such turns get a larger tool budget and higher effort; a turn that starts a
// self-change mid-way is upgraded at that point (llm.js runTool). Claude Code runs its own agent loop
// and is not limited by this budget.
const DEFAULT_ROUNDS = 8;
const ENGINEERING_ROUNDS = 40;
const ENGINEERING_TOOLS = /^(self_change_|code_|run_tests$|analyze_errors$|diagnose$|read_app_log$)/;
const CODE_WORDS = /```|\b(code|coding|function|bug|debug|refactor|compile|stack ?trace|regex|script|typescript|javascript|python|sql|pull request)\b/i;
const ENGINEERING_TEXT = /\b(implement|add (a|an|the)? ?(new )?feature|new feature|redesign|architecture|your (own )?(code|source)|change (yourself|how you)|improve yourself|self-?improv\w*)\b/i;
// Words that are engineering only about software: "the voice is broken", "fix the calendar sync", but
// not "my bike is broken", "fix my diet" or "an error in my essay" (each of those was a 40-round deep
// turn, and with hand-over on a local brain sent it to Claude as code work).
const TROUBLE = /\b(fix|investigate|troubleshoot|diagnose|crash(es|ed|ing)?|errors?|exception|broken|not (working|syncing|loading|starting|responding|connecting)|(does|did|is|wo)n'?t (work|sync|load|start|open|connect|respond|update|show)\w*)\b/i;
const SOFTWARE = /\b(app|application|program|software|feature|view|page|button|settings?|window|sync\w*|logs?|startup|start ?up|install\w*|updates?|updating|server|connectors?|plugins?|extensions?|tools?|model|brain|voice|mic(rophone)?|speech|face|theme|vault|notifications?|routines?|skills?|tunnel|api|database|ui|login|loading|yourself|claude|siren|nexus|android|wear ?os)\b/i;

function isEngineeringTask(text) {
  const t = String(text || '').replace(/[‘’ʼ]/g, "'");
  return CODE_WORDS.test(t) || ENGINEERING_TEXT.test(t) || (TROUBLE.test(t) && SOFTWARE.test(t));
}

function toolBudget(settings, engineering) {
  const base = Number(settings?.llm?.maxToolRounds) || DEFAULT_ROUNDS;
  const deep = Math.max(base, Number(settings?.llm?.engineeringToolRounds) || ENGINEERING_ROUNDS);
  return { rounds: engineering ? deep : base, deep, engineering: Boolean(engineering) };
}

/** Called for each tool call: an engineering tool upgrades the turn's budget (once). Returns true then. */
function upgradeBudget(ctx, toolName) {
  const b = ctx?.budget;
  if (!b || b.engineering || !ENGINEERING_TOOLS.test(String(toolName))) return false;
  Object.assign(b, { rounds: b.deep, engineering: true });
  return true;
}

/** Anthropic effort for the turn: the turn's pace (ctx.effort, pace.js), at least "high" once it becomes engineering work. */
function turnEffort(configured, ctx) {
  const e = (ctx?.effort && ctx.effort !== 'default' ? ctx.effort : configured) || 'medium';
  return ctx?.budget?.engineering && ['low', 'medium'].includes(e) ? 'high' : e;
}

module.exports = { isEngineeringTask, toolBudget, upgradeBudget, turnEffort, ENGINEERING_ROUNDS };
