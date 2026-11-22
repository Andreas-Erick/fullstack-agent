// The turn's outside-content ledger: which results are outside content (one classification for the API
// and local brains' tools, Claude Code's own tools and connectors, and redo's look at an earlier attempt),
// marking the turn when such a result arrives, and the two questions the rest of the app asks of it:
//  - isTainted(turn): the raw fact that the turn read outside content. Provenance follows it whatever the
//    settings say (a memory saved then is `source: outside`, a stream record `x: 1`), and so does the
//    choice to send a write through the gate at all (guardWrite) and guide's refusal to grant access.
//  - guarded(turn, settings): tainted with the taint guard on (`safety.taintGuard`). This is what makes a
//    dialog carry the warning and what makes TAINT_ASKS kinds, `taintAsks` calls, a connector's deletes
//    and invitations, and a new web host ask (approvals.gate, askOutbound, claudecode approve()).
// guardWrite(turn, …) joins them: a write that later turns read as the user's own (memories, routines,
// skills, persona and look, a clone, notes the prompt reads) goes to the gate with `taintAsks` once the
// turn is tainted; the gate decides with the guard whether the taint forces a question.
// approvals.js keeps the dialog mechanics (and re-exports mark as markTainted); outboundcore.js stays the
// pure host bookkeeping underneath. test/turnguard.test.js.
const path = require('path');
const connectors = require('./connectors');
const outbound = require('./outboundcore');

// Claude Code's own tools whose results are outside content wherever they point.
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
// Claude Code's reading tools: outside content in the user's folders or a cloned repo (readsOutside).
const READ_TOOLS = ['Read', 'Glob', 'Grep'];
// Our own refusals (approve() and the bridge): an error result that starts with these carries no outside
// content. Only an error result: a page or an email that starts with those words still taints.
const DENIED = /^(User did not approve|Not approved by the user|Connectors are turned off|This is an automatic warm-up|The reply was stopped|Tool \S+ is not available)/;
const MAX_SOURCES = 5;
const DEFAULT_DETAIL = 'Asked after reading external content.';

/** Marks the turn as having read outside content; `source` names it on every later dialog (up to five). */
function mark(turn, source) {
  if (!turn) return;
  turn.tainted = true;
  if (!Array.isArray(turn.taintSources)) turn.taintSources = [];
  if (turn.taintSources.length < MAX_SOURCES) turn.taintSources.push(source);
}

/** The raw fact: did this turn read outside content? */
const isTainted = (turn) => Boolean(turn?.tainted);

/** Tainted with the taint guard on: the warning on dialogs and the extra questions follow this. */
const guarded = (turn, settings) => isTainted(turn) && Boolean(settings?.safety?.taintGuard);

function inside(root, file) {
  if (!root || !file) return false;
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** The folder a Read, Glob or Grep call looks in (relative to `cwd`); a glob pattern's fixed part counts when absolute. */
function readTarget(input, cwd) {
  let target = input?.file_path || input?.notebook_path || input?.path || '';
  if (!target && path.isAbsolute(String(input?.pattern || ''))) target = String(input.pattern).split(/[*?[{]/)[0] || String(input.pattern);
  return path.resolve(cwd || '.', String(target || '.'));
}

/**
 * Read/Glob/Grep in the user's folders or a cloned repo (the CLI allows them there without asking approve()).
 * The vault and the app's own code stay the user's own, as vault_read_note and code_read_file.
 * `spec`: the session's { cwd, vault, codeRoot, repos, userFolders }.
 */
function readsOutside(name, input, spec) {
  if (!READ_TOOLS.includes(name)) return false;
  const { cwd, vault, codeRoot, repos, userFolders = [] } = spec || {};
  const target = readTarget(input || {}, cwd);
  if ((vault && inside(vault, target)) || (codeRoot && inside(codeRoot, target))) return false;
  return [repos, ...userFolders].some((r) => r && inside(r, target));
}

// An app tool (tools.js) marked `untrusted`: its result is external content (web, documents, the screen…).
function appUntrusted(name) {
  return Boolean(require('./tools').TOOLS.find((t) => t.name === name)?.untrusted);
}

/**
 * Whether a tool's result is outside content, as the source to name ('' when it isn't). One rule:
 *  - a connector or plugin tool (any server but the app's own): "Service: action", as the dialogs name it;
 *  - Claude Code's WebFetch and WebSearch; its Read/Glob/Grep only with `spec`, in the user's folders or repos;
 *  - an app tool marked `untrusted` (`untrusted` given by the caller that holds the tool, else looked up).
 * Without `input`/`spec` (redo's look at a stored attempt) it answers by the name alone.
 */
function sourceOf({ tool, input = {}, spec = null, untrusted } = {}) {
  const name = String(tool || '');
  const args = input || {};
  if (connectors.isConnectorTool(name)) {
    const { service, action } = connectors.describeTool(name);
    return `${service}: ${action}`;
  }
  if (WEB_TOOLS.includes(name) || (spec && readsOutside(name, args, spec))) return `${name} ${args.url || args.query || args.file_path || args.path || ''}`.trim();
  if (untrusted ?? appUntrusted(name)) return `${name} ${args.url || args.path || args.query || ''}`;
  return '';
}

/** By the name alone (redo: a tool in an earlier attempt that brought in outside content). */
const taints = (name) => Boolean(sourceOf({ tool: name }));

/**
 * A tool's result arrived: marks the turn when it is outside content and returns the source ('' if not).
 * `error` + `text`: an error result that is our own refusal (DENIED) never taints; any other may carry a
 * page's words. `own`: one of the app's tools reached through Claude Code's bridge; tools.js classified it
 * when it ran (with `untrusted`), so it isn't marked twice. `content`: a WebSearch's result, whose own
 * links become known hosts while the turn is still clean (outboundcore).
 */
function noteResult(turn, { tool, input, content, error = false, text = '', spec = null, own = false, untrusted } = {}) {
  if (!turn || own) return '';
  if (error && DENIED.test(String(text || ''))) return '';
  if (tool === 'WebSearch') outbound.noteHosts(turn, outbound.resultLinkHosts(content));
  const source = sourceOf({ tool, input, spec, untrusted });
  if (source) mark(turn, source);
  return source;
}

/**
 * A Read/Glob/Grep that approve() let through (an attached file's copy, Claude Code's spill folder):
 * only reads outside the session's own folders come to approve(), so it is marked at approval, before its
 * result, which is stricter than on arrival (a call made meanwhile already sees the taint).
 */
function noteApprovedRead(turn, tool, input = {}) {
  mark(turn, `${tool} ${input.file_path || input.path || ''}`);
}

/**
 * A write that later turns read as the user's own (or that runs later as their instructions). Clean turn:
 * nothing asked, `{ asked: false, allow: true }`. Tainted: the gate with `taintAsks`, which asks in auto
 * mode too while the guard is on; returns `{ asked: true, allow, reason }`. `gate` is approvals.gate (the
 * caller's own, so a test's stand-in sees the call).
 */
async function guardWrite(turn, title, detail = DEFAULT_DETAIL, { kind = 'settings', gate } = {}) {
  if (!isTainted(turn)) return { asked: false, allow: true };
  const ask = gate || ((...a) => require('./approvals').gate(...a));
  const r = await ask(turn, kind, title, detail || DEFAULT_DETAIL, { taintAsks: true });
  return { asked: true, allow: Boolean(r?.allow), ...(r?.reason !== undefined ? { reason: r.reason } : {}) };
}

module.exports = { WEB_TOOLS, READ_TOOLS, DENIED, DEFAULT_DETAIL, mark, isTainted, guarded, readTarget, readsOutside, sourceOf, taints, noteResult, noteApprovedRead, guardWrite };
