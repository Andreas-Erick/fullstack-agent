// "Claude account" provider: runs the user's own Claude Code CLI (signed in with their Claude
// subscription), like the original fullstack-agent. Each conversation keeps a warm Claude Code
// process; the app's tools are exposed through an MCP server, and permission prompts come back to
// the app for approval. Claude Code's built-in tools add web search/fetch and file editing.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const store = require('./store');
const bridge = require('./bridge');
const github = require('./github');
const approvals = require('./approvals');
const log = require('./logger');
const { ignore } = require('./ignore');
const connectors = require('./connectors');
const turnguard = require('./turnguard');
const { safeCommand } = require('./commandsafety');
const claudeUsage = require('./claudeusage');
const claudeStatus = require('./claudestatus');
const perf = require('./perfcore');

const MCP_SERVER = path.join(__dirname, 'mcp-server.js');

// A process's output as text: a character split across two chunks (UTF-8 '€' is three bytes) is put
// back together; `text += buffer` turned each half into U+FFFD.
function onText(stream, fn) {
  const decoder = new StringDecoder('utf8');
  stream.on('data', (d) => {
    const text = typeof d === 'string' ? d : decoder.write(d);
    if (text) fn(text);
  });
}

// ------------------------------------------------------------- CLI lookup
function candidates() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [path.join(home, '.local', 'bin', 'claude.exe'), path.join(appData, 'npm', 'claude.cmd'), path.join(home, '.claude', 'local', 'claude.exe')];
  }
  return [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude', path.join(home, '.npm-global', 'bin', 'claude')];
}

function which() {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, ['claude'], { windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || null));
  });
}

let cachedCli = null;
async function findCli() {
  const s = await store.getSettings();
  if (s.claudeCode.cliPath) return fs.existsSync(s.claudeCode.cliPath) ? s.claudeCode.cliPath : null;
  if (cachedCli && fs.existsSync(cachedCli)) return cachedCli;
  for (const c of candidates()) if (fs.existsSync(c)) return (cachedCli = c);
  cachedCli = await which();
  return cachedCli;
}

// Environment for the CLI: drop variables that would make it think it's nested inside another
// Claude Code session, or bill an API key instead of the user's Claude subscription.
function cliEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of Object.keys(env)) {
    if (/^CLAUDECODE$|^CLAUDE_CODE_(ENTRYPOINT|SSE_PORT|SESSION)/.test(k)) delete env[k];
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

function quoteWin(a) {
  if (a === '') return '""';
  return /[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '""')}"` : a;
}

// Model and effort for the CLI's command line. With the npm shim (claude.cmd) that line goes through
// cmd.exe, which expands %…% even inside quotes, so only plain ids pass: whatever set the value
// (settings_update, Settings, an old stored value). A value that doesn't pass is left out.
const MODEL_VALUE = /^[A-Za-z0-9][\w.-]{0,99}(\[1m\])?$/; // opus, sonnet[1m], opusplan, claude-opus-5-5…
const EFFORT_VALUES = new Set(['default', 'low', 'medium', 'high', 'xhigh', 'max']);
function cliValue(kind, v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  const ok = kind === 'effort' ? EFFORT_VALUES.has(s) : MODEL_VALUE.test(s);
  if (!ok) log.warn('claude setting ignored', { field: kind }); // never the value
  return ok ? s : '';
}

function spawnCli(cli, args, opts = {}) {
  const isScript = /\.(cmd|bat)$/i.test(cli);
  if (isScript) {
    // cmd.exe can't quote these safely (a quote ends the quoting, a line break ends the command).
    if (args.some((a) => /["\r\n]/.test(String(a)))) throw new Error('Refusing an argument the command shell would misread.');
    return spawn(`${quoteWin(cli)} ${args.map(quoteWin).join(' ')}`, { ...opts, shell: true, windowsHide: true });
  }
  return spawn(cli, args, { ...opts, windowsHide: true });
}

function collect(cli, args, { cwd, input, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCli(cli, args, { cwd: cwd || os.homedir(), env: cliEnv() });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      killTree(child);
      reject(new Error('Claude Code did not respond in time'));
    }, timeout);
    onText(child.stdout, (d) => (out += d));
    onText(child.stderr, (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true }, () => {});
  else child.kill('SIGTERM');
}

// ------------------------------------------------------------ connectors
// The user's claude.ai connectors and plugin MCP servers with their state, from `claude mcp list`
// (it checks each server; no model call, nothing counts toward the plan). The last result is kept in
// <userData>/connectors.json so the agent knows what the user has without waiting for a check.
const connectorsFile = () => path.join(store.dataDir(), 'connectors.json');
let connectorsCheck = null;
// Bumped when reading the list changes: v2 reads the state by its words (before, a check made without a
// terminal found no connected server), so an older cache is checked again at once.
const CONNECTORS_CACHE_V = 2;

function listConnectors() {
  connectorsCheck ||= (async () => {
    const cli = await findCli();
    if (!cli) throw new Error('Claude Code is not installed.');
    const r = await collect(cli, ['mcp', 'list'], { timeout: 90000 });
    if (r.code && !r.out.trim()) throw new Error((r.err || '').trim().slice(0, 300) || `claude mcp list failed (code ${r.code})`);
    const list = connectors.parseMcpList(r.out);
    await store.writeJsonAtomic(connectorsFile(), { at: Date.now(), v: CONNECTORS_CACHE_V, list }).catch((err) => log.warn('connectors cache not written', { error: err }));
    return list;
  })().finally(() => (connectorsCheck = null));
  return connectorsCheck;
}

/** The last check ({ at, list }) or null; starts a fresh check in the background when it is older than maxAgeMs. */
async function cachedConnectors({ maxAgeMs = 24 * 3600000 } = {}) {
  const c = await store.readJson(connectorsFile(), null);
  if (!c || c.v !== CONNECTORS_CACHE_V || Date.now() - (c.at || 0) > maxAgeMs) listConnectors().catch((err) => log.warn('connectors check failed', { error: err }));
  return c && Array.isArray(c.list) ? c : null;
}

// --------------------------------------------------------------- account
// The sign-in check and the CLI's version, cached (claudestatus.js): one per load of this module, run
// with its CLI lookup and runner. An auth error in a turn and openLogin clear it.
const { STATUS_TTL_MS, STATUS_RETRY_MS, AUTH_ERROR } = claudeStatus;
const { status, invalidateStatus } = claudeStatus.create({ findCli, collect });

// Opens a terminal window running `claude auth login` (browser-based sign-in to the Claude account).
async function openLogin(action = 'login') {
  invalidateStatus(); // the next check sees the new sign-in (or sign-out)
  const cli = await findCli();
  if (!cli) throw new Error('Claude Code is not installed.');
  const env = cliEnv();
  const opts = { detached: true, stdio: 'ignore', env };
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'Claude sign-in', 'cmd', '/k', cli, 'auth', action], { ...opts, windowsHide: false }).unref();
  } else if (process.platform === 'darwin') {
    spawn('osascript', ['-e', `tell application "Terminal" to do script "${cli.replace(/"/g, '\\"')} auth ${action}"`, '-e', 'tell application "Terminal" to activate'], opts).unref();
  } else {
    const terms = [['x-terminal-emulator', ['-e']], ['gnome-terminal', ['--']], ['konsole', ['-e']], ['xterm', ['-e']]];
    for (const [t, pre] of terms) {
      try {
        spawn(t, [...pre, cli, 'auth', action], opts).unref();
        return true;
      } catch {
        /* try the next terminal */
      }
    }
    throw new Error(`Open a terminal and run: ${cli} auth ${action}`);
  }
  return true;
}

// Install command shown in settings when the CLI isn't found.
function installHint() {
  return process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex   (in PowerShell)' : 'curl -fsSL https://claude.ai/install.sh | bash';
}

// The app's everyday tools for a Claude session with tools on request: what a local model always has
// (localcore.COMPACT_TOOLS) and the common changes to the same things. The rest: ToolSearch.
// A tool that acts on something by name comes with the one that finds it. persona_switch was loaded and
// persona_list was not: the model found persona_list on nexus_more, then called
// mcp__nexus_more__persona_switch ("No such tool available"): a wasted round, 11.6 s for a switch.
const COMPANIONS = {
  persona_switch: ['persona_list'],
  open_document: ['find_document', 'close_document', 'list_monitors'],
  brain_switch: ['brain_options'],
  calendar_update_event: ['calendar_list_entries'],
  calendar_delete_event: ['calendar_list_entries'],
  memory_update: ['memory_search'],
  memory_delete: ['memory_search'],
  skill_run: ['skill_list'],
};
// Skills are run by voice too ("do my weekly review"): each run needed a ToolSearch round first.
const CORE_TOOLS = new Set([...require('./localcore').COMPACT_TOOLS, 'calendar_update_event', 'calendar_delete_event', 'calendar_list_entries', 'memory_update', 'memory_delete', 'persona_switch', 'tasks_save', 'open_document', 'vault_write_note', 'skill_run', ...Object.values(COMPANIONS).flat()]);

/** The MCP servers of a session: the app's (one, or core + more) and the extensions. */
function mcpServersFor(spec, { url, token, turn }) {
  const server = (set) => ({ command: process.execPath, args: [MCP_SERVER], env: { ELECTRON_RUN_AS_NODE: '1', NEXUS_BRIDGE_URL: url, NEXUS_BRIDGE_TOKEN: token, NEXUS_TURN: turn, ...(set ? { NEXUS_TOOLSET: set } : {}) } });
  const searching = spec.coreTools || spec.connectors || Object.keys(spec.extensions || {}).length;
  return {
    nexus: { ...server(spec.coreTools ? 'core' : ''), ...(searching ? { alwaysLoad: true } : {}) },
    ...(spec.coreTools ? { nexus_more: server('more') } : {}),
    ...(spec.extensions || {}),
  };
}

// ------------------------------------------------------------- warm sessions
// One long-lived Claude Code process per conversation (stream-json in/out), so each turn starts
// immediately instead of spawning the CLI, the MCP server and reloading the session every time.
// Permission prompts are routed to the app (approval_prompt via MCP) so the user can approve
// self-modification by click or voice.
// The app reaches these through claudesession.js (a conversation's session: turn, warm, forget, deleted).
const sessions = new Map(); // conversation id -> Session
// A conversation whose latest exchange was taken out (Try again / Regenerate / Edit, main/redo.js):
// its old session ids are never resumed, and warm-ups queued before it (with the old messages) don't run.
const forgotten = new Map(); // convId → Set of session ids
const epochs = new Map(); // convId → number, bumped by forget
const epochOf = (convId) => epochs.get(convId) || 0;
function forget(convId, ...ids) {
  const set = forgotten.get(convId) || new Set();
  const s = sessions.get(convId);
  for (const id of [...ids, s?.sessionId, s?.resumable]) if (id) set.add(id);
  forgotten.set(convId, set);
  epochs.set(convId, epochOf(convId) + 1);
  endSession(convId);
}
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// Which results are outside content (WebFetch/WebSearch, connectors, reads in the user's folders) and our
// own refusals that never are: turnguard.js, shared with tools.js and redo.js.
const { readTarget } = turnguard;

// Where a path really is: the nearest part that exists, resolved (a Windows short name such as GIT~1, a
// link or a junction becomes what it names), plus the parts that don't exist yet.
function realPath(p) {
  let probe = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) return path.resolve(p);
    rest.unshift(path.basename(probe));
    probe = up;
  }
  try {
    return path.join(fs.realpathSync.native(probe), ...rest);
  } catch {
    return path.resolve(p);
  }
}
const shortTool = (name) => String(name || '').replace(/^mcp__nexus(_more)?__/, '');

// Vault paths that matter beyond the note itself (relative to the vault, as the OS compares names):
// 'prompt' for what the system prompt reads every turn (memory.js, obsidian.startupContext), 'package'
// for the manifests a command would run (npm scripts, .npmrc). Else ''.
const PROMPT_NOTES = ['profile.md', 'active priorities.md'];
const PROMPT_FOLDERS = ['memory', 'jobs'];
const PACKAGE_FILES = ['package.json', '.npmrc'];
function vaultGuarded(rel) {
  const parts = String(rel || '').split(/[/\\]+/).map((p) => p.toLowerCase().replace(/[. ]+$/, ''));
  const last = String(rel || '').split(/[/\\]+/).pop().toLowerCase().replace(/ +$/, '');
  if (PACKAGE_FILES.includes(last)) return 'package';
  if (parts.length === 1 && PROMPT_NOTES.includes(parts[0])) return 'prompt';
  if (parts.length > 1 && PROMPT_FOLDERS.includes(parts[0])) return 'prompt';
  return '';
}

function inside(root, file) {
  if (!root || !file) return false;
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Claude Code keeps long tool results for this session under ~/.claude/projects/<folder name>/ and
// reads them back; that one folder (never other projects') is readable too.
const cliProjectDir = (cwd) => path.join(os.homedir(), '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

// A message with attachments: what was typed first, then the files' names and saved paths (its attached
// text is not repeated; the copies can be read again).
const lineText = (m) => (m.attachments?.length ? require('./attachcore').summaryLine(m) : String(m.content || ''));

function transcript(history) {
  const prior = history.slice(0, -1).slice(-12);
  if (!prior.length) return '';
  const lines = prior.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${lineText(m).slice(0, 1500)}`);
  return `[Earlier in this conversation, for context]\n${lines.join('\n\n')}\n[End of earlier messages]\n\n`;
}

// Multi-provider mode: turns another provider answered while this session was skipped (it hit a
// limit). The session never saw them, so they are passed along with the next message.
function missedTurns(history) {
  const prior = history.slice(0, -1);
  let i = prior.length - 1;
  while (i >= 0 && !(prior[i].role === 'assistant' && prior[i].provider === 'claude-code')) i--;
  const gap = prior.slice(i + 1);
  if (i < 0 || !gap.some((m) => m.role === 'assistant' && m.provider && m.provider !== 'claude-code')) return '';
  const lines = gap.slice(-12).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${lineText(m).slice(0, 1500)}`);
  return `[While you were unavailable, another model answered these messages]\n${lines.join('\n\n')}\n[End of those messages]\n\n`;
}

class Session {
  constructor(convId) {
    this.convId = convId;
    this.child = null;
    this.key = '';
    this.sessionId = null;
    // The id the CLI has a saved conversation under: the one it was resumed from, or this process's own
    // once a turn finished. A process that never answered has an id but nothing saved ("No conversation
    // found with session ID" when resumed).
    this.resumable = null;
    this.turn = null;
    this.chain = Promise.resolve();
    this.stderr = '';
  }

  alive() {
    return Boolean(this.child) && this.child.exitCode === null && !this.dead;
  }

  // Log lines from the process's output, its permission prompts and its exit belong to the turn
  // that is running (they arrive outside that turn's async context).
  inTurn(fn) {
    return log.withContext(this.turn?.ctx?.logTags || { conv: this.convId.slice(-6) }, fn);
  }

  // Switch the running session's model (fast for voice, deep for typing) without restarting it:
  // stream-json sessions accept a set_model control request, applied before the next message.
  setModel(model) {
    const want = model || 'default';
    if (!this.alive() || want === this.requestedModel) return;
    this.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'set_model', model: want } })}\n`);
    log.info('claude model switched', { conversation: this.convId, from: this.requestedModel, to: want });
    this.requestedModel = want;
  }

  // The turn's effort (pace.js), also in place: apply_flag_settings sets effortLevel on the live
  // session; null drops back to what the session started with (no --effort = the model's default).
  setEffort(level) {
    if (level === undefined) return;
    const want = level && level !== 'default' ? level : this.baseEffort;
    if (!this.alive() || want === this.requestedEffort) return;
    this.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'apply_flag_settings', settings: { effortLevel: want } } })}\n`);
    log.info('claude effort switched', { conversation: this.convId, from: this.requestedEffort || 'default', to: want || 'default' });
    this.requestedEffort = want;
  }

  async spawn(spec) {
    // The old process must be gone before the conversation is resumed in a new one.
    await this.kill();
    const cli = await findCli();
    if (!cli) throw new Error('Claude Code is not installed. Install it, then connect your Claude account in Settings → AI brain.');
    const b = await bridge.start();
    // God's Eye View's tools read its local server: start it now (in the background), not when the
    // agent first opens the globe, or its first answers come back empty.
    if (spec.extensions?.['gods-eye-view']) store.getSettings().then((s) => require('./extensions').ensureGodsEye(s)).catch((err) => log.warn('godseye warm start failed', { error: err }));
    this.spec = spec;
    this.requestedModel = spec.model || 'default';
    this.baseEffort = spec.effort && spec.effort !== 'default' ? spec.effort : null;
    this.requestedEffort = this.baseEffort;
    this.dead = false;
    this.stderr = '';
    this.sentAny = false;
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexus-cc-'));
    this.tmp = tmp;
    const bridgeId = crypto.randomUUID();
    const unregister = bridge.registerSession(bridgeId, {
      allowed: spec.toolNames,
      core: spec.coreTools,
      getCtx: () => (this.turn && !this.turn.settled ? this.turn.ctx : null),
      approve: (req) => this.inTurn(() => this.approve(req)),
    });
    this.unregister = unregister;
    const sysFile = path.join(this.tmp, 'system.md');
    const mcpFile = path.join(this.tmp, 'mcp.json');
    const settingsFile = path.join(this.tmp, 'settings.json');
    await fsp.writeFile(sysFile, spec.system, 'utf8');
    await fsp.writeFile(settingsFile, JSON.stringify(SESSION_SETTINGS), 'utf8');
    await fsp.writeFile(
      mcpFile,
      // Connector tools are found on demand (ToolSearch); of the app's own, the everyday ones stay
      // loaded (nexus, with the approval prompt) and the rest are found on demand too (nexus_more).
      JSON.stringify({ mcpServers: mcpServersFor(spec, { url: b.url, token: b.token, turn: bridgeId }) }),
      'utf8',
    );
    const resume = spec.resume || this.resumable;
    const args = sessionArgs(spec, { sysFile, mcpFile, settingsFile, resume });
    this.resumed = Boolean(resume);
    this.resumable = resume || null;

    const child = spawnCli(cli, args, { cwd: spec.cwd, env: cliEnv() });
    this.child = child;
    this.key = spec.key;
    let buf = '';
    // Handlers act only while this child is the session's process: a replaced process exiting
    // late must not end the new one's turn or delete its files.
    const current = () => this.child === child;
    this.gotOutput = false;
    onText(child.stdout, (chunk) => {
      if (!current()) return;
      this.gotOutput = true;
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.inTurn(() => this.onLine(line));
      }
    });
    onText(child.stderr, (d) => {
      if (!current()) return;
      this.stderr = (this.stderr + d).slice(-4000);
      this.inTurn(() => log.debug('claude stderr', String(d).slice(0, 1500)));
    });
    const exited = (code, err) => {
      unregister();
      fsp.rm(tmp, { recursive: true, force: true }).catch(ignore('temporary MCP config not removed (swept at the next start)'));
      if (current()) this.inTurn(() => this.onExit(code, err));
    };
    child.on('error', (err) => exited(null, err));
    child.on('close', (code) => exited(code));
    log.info('claude session started', { conversation: this.convId, model: spec.model, resume: resume || null, pid: child.pid });
    this.resetIdle();
  }

  onExit(code, err) {
    clearTimeout(this.idleTimer);
    const wasDead = this.dead;
    this.dead = true;
    this.afterInterrupt?.(); // nothing left to wait for
    if (this.turn && !this.turn.settled) {
      const detail = err?.message || this.stderr.trim() || `Claude Code exited (code ${code})`;
      log.error('claude session exited mid-turn', { conversation: this.convId, code, detail: detail.slice(0, 500) });
      const auth = AUTH_ERROR.test(detail);
      if (auth) invalidateStatus(); // the title bar and multi-provider mode check the sign-in again
      this.turn.reject(new Error(auth ? `${detail}\nConnect your Claude account in Settings → AI brain.` : detail));
    } else if (!wasDead && code) log.warn('claude session exited', { conversation: this.convId, code, stderr: this.stderr.slice(-300) });
    // The Session stays in `sessions` for its resumable id; what it held for the process goes (the last
    // turn's context and tool records, the spec with the stable prompt, the child and its streams).
    this.turn = null;
    this.spec = null;
    this.child = null;
    this.stderr = '';
  }

  // Stops the current reply but keeps the process and its warm cache: the CLI ends the turn with a
  // result that onLine swallows, and the next turn waits for it (`interrupting`), so that late result
  // never ends the next turn. Unconfirmed within 3 seconds: the process is stopped, as before.
  interrupt() {
    if (!this.alive() || this.interrupting) return;
    let done;
    this.interrupting = new Promise((r) => (done = r));
    const timer = setTimeout(() => {
      log.warn('claude interrupt not confirmed; stopping the session', { conversation: this.convId });
      this.kill();
    }, 3000);
    this.afterInterrupt = () => {
      clearTimeout(timer);
      this.afterInterrupt = null;
      this.interrupting = null;
      done();
    };
    this.child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: crypto.randomUUID(), request: { subtype: 'interrupt' } })}\n`);
    log.info('claude turn interrupted', { conversation: this.convId });
  }

  // Stops the process; resolves once it has exited (at most 5 seconds).
  kill() {
    clearTimeout(this.idleTimer);
    const child = this.child;
    this.afterInterrupt?.(); // a new process (or none) never sends the interrupted turn's end
    if (!this.alive()) return Promise.resolve();
    this.dead = true;
    const gone = new Promise((resolve) => {
      child.once('close', resolve);
      setTimeout(resolve, 5000);
    });
    killTree(child);
    log.info('claude session stopped', { conversation: this.convId });
    return gone;
  }

  resetIdle() {
    clearTimeout(this.idleTimer);
    this.lastUsed = Date.now();
    const mins = this.spec?.idleMinutes || 20;
    this.idleTimer = setTimeout(() => {
      if (!this.turn || this.turn.settled) this.kill();
    }, mins * 60000);
  }

  // Permission prompts from Claude Code: vault edits are fine, own-code edits need approval,
  // shell commands outside the safe list always ask, anything else outside the allowed folders is denied.
  async approve({ tool_name: tool, input = {} }) {
    // The cache warm-up (warmCache) is not the user's turn: nothing it asks for runs.
    if (this.warming) return { behavior: 'deny', message: 'This is an automatic warm-up: no tools.' };
    if (!this.turn || this.turn.settled) return { behavior: 'deny', message: 'The reply was stopped.' };
    const turnState = this.turn?.ctx?.turn;
    const { codeRoot, vault, repos, allowSelfModify } = this.spec;
    if (EDIT_TOOLS.includes(tool)) {
      const file = input.file_path || input.notebook_path || '';
      if (vault && inside(vault, file)) {
        // The vault's own machinery (.git: vaultgit runs git there; .obsidian: Obsidian loads its plugins
        // from it; .trash, node_modules) is never written from a session, as the app's own vault tools
        // refuse it. Compared where the file really is, so GIT~1 is .git and a link can't lead out.
        const rel = path.relative(realPath(vault), realPath(file));
        if (rel.startsWith('..') || path.isAbsolute(rel)) return { behavior: 'deny', message: 'That path leads out of the vault.' };
        // A colon names an NTFS stream (".git::$INDEX_ALLOCATION" is .git itself); no note name has one.
        if (rel.includes(':')) return { behavior: 'deny', message: 'A vault path can’t contain “:” (Obsidian doesn’t allow it in a note’s name either).' };
        if (require('./files').hasReservedPart(rel, require('./obsidian').IGNORE)) return { behavior: 'deny', message: 'The vault’s .git, .obsidian, .trash and node_modules folders are not edited from here.' };
        // After outside content, a note the prompt reads in later turns (memories, Profile, Active
        // Priorities, Jobs) or a package manifest a command would run asks, each one: else a page's
        // words would come back as the user's own data in a clean turn.
        const guarded = vaultGuarded(rel);
        if (guarded) {
          const preview = String(input.new_string ?? input.content ?? '').slice(0, 600);
          const r = await turnguard.guardWrite(turnState, guarded === 'prompt' ? `Write a note your assistant reads every time (${rel.split(path.sep).join('/')})` : `Write a package file (${rel.split(path.sep).join('/')})`, `${tool} ${rel.split(path.sep).join('/')}${preview ? `\n\n${preview}` : ''}`, { gate: approvals.gate });
          if (!r.allow) return { behavior: 'deny', message: `User did not approve: ${r.reason}` };
        }
        return { behavior: 'allow', updatedInput: input };
      }
      if (repos && inside(repos, file)) return this.approveRepoEdit(tool, file, input, turnState);
      if (inside(codeRoot, file)) {
        if (!allowSelfModify) return { behavior: 'deny', message: 'Self-modification is disabled in Settings.' };
        const rel = path.relative(codeRoot, file).split(path.sep).join('/');
        // Any part, compared as the OS does (".GIT/hooks" is .git/hooks on Windows).
        if (require('./files').hasReservedPart(rel, ['node_modules', '.git'])) return { behavior: 'deny', message: 'node_modules/ and .git/ must not be modified.' };
        const preview = String(input.new_string ?? input.content ?? '').slice(0, 600);
        const r = await approvals.gate(turnState, 'self_modify', `Change its own code (${rel})`, `${tool} ${rel}${preview ? `\n\n${preview}` : ''}`);
        return r.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `User did not approve: ${r.reason}` };
      }
      return { behavior: 'deny', message: 'Writing outside your code folder and your vault is not allowed.' };
    }
    if (tool === 'Bash') {
      // The app's own checks and plain git views, word for word (commandsafety.js); anything else asks.
      if (allowSelfModify && safeCommand(input.command)) return { behavior: 'allow', updatedInput: input };
      const r = await approvals.gate(turnState, 'command', 'Run a command on your computer', String(input.command || ''));
      return r.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `User did not approve: ${r.reason}` };
    }
    if (connectors.isConnectorTool(tool)) {
      if (!this.spec.connectors && !(connectors.toolServer(tool) in (this.spec.extensions || {}))) return { behavior: 'deny', message: 'Connectors are turned off in Settings.' };
      // Connectors act in the user's accounts (send, post, create, delete), so they ask even in auto
      // mode; one yes covers that connector for the rest of the turn, except that after outside content
      // deleting or reaching other people needs a yes given after it (below). The user's level for the
      // service (connectors.levelOf: allow reading / all but deleting / everything) is read live, so a
      // change applies at once, even mid-turn, and taking a permission back never waits for a restart.
      const server = connectors.toolServer(tool);
      const s = await store.getSettings();
      const level = connectors.levelOf(s.claudeCode, server);
      const tainted = turnguard.guarded(turnState, s); // with the taint guard on
      // After outside content (a calendar invitation's or a shared task's text can ask for anything),
      // deleting or reaching other people needs a yes given after it: neither the level nor an earlier yes
      // in the turn covers it. One dialog per service for deleting and one for reaching people, with the
      // warning: a yes to one never covers the other.
      const why = tainted ? connectors.taintedAsk(tool, input) : null;
      const askKey = why ? `${server}#${why}` : server;
      if (why ? turnState?.connectorsApprovedTainted?.has(askKey) : turnState?.connectorsApproved?.has(server)) return { behavior: 'allow', updatedInput: input };
      if (!why && connectors.permits(level, tool)) return { behavior: 'allow', updatedInput: input };
      if (why && connectors.permits(level, tool)) log.info('connector asked after outside content', { server, why });
      // Parallel calls to one service (several searches at once) ask once: the others wait for that
      // answer instead of each opening a dialog. A delete or an invitation after outside content never
      // follows another call's yes.
      const asking = turnState?.connectorAsking?.get(askKey);
      if (asking) {
        const first = await asking;
        if (first.allow) return { behavior: 'allow', updatedInput: input };
        return { behavior: 'deny', message: `User did not approve: ${first.reason}` };
      }
      const { service, action } = connectors.describeTool(tool);
      const choices = tainted ? [] : connectors.rememberChoices(tool); // never "from now on" from a turn that read outside content
      const question = approvals.gate(turnState, 'connector', `Use ${service}: ${action}`, JSON.stringify(input, null, 2).slice(0, 1500), { remember: choices });
      if (turnState) (turnState.connectorAsking ||= new Map()).set(askKey, question);
      let r;
      try {
        r = await question;
      } finally {
        turnState?.connectorAsking?.delete(askKey);
      }
      if (r.allow && turnState) {
        (turnState.connectorsApproved ||= new Set()).add(server);
        // A yes to a delete covers the service's next deletes for the rest of the turn, a yes to an
        // invitation its next invitations; a yes to anything else covers neither (its dialog said nothing
        // about deleting or inviting).
        if (why) (turnState.connectorsApprovedTainted ||= new Set()).add(askKey);
      }
      // "Always allow…" in the dialog (the user's click or spoken "always"): only a level offered for this tool.
      if (r.allow && choices.some((c) => c.level === r.remember)) {
        await store.setSettings({ claudeCode: connectors.levelPatch((await store.getSettings()).claudeCode, server, r.remember) });
        log.info('connector level set from approval', { server, level: r.remember });
      }
      return r.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `User did not approve: ${r.reason}` };
    }
    if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') {
      // Only the folders the user allowed (workspace + added ones), the vault, its own code and repos.
      const target = readTarget(input, this.spec.cwd);
      // Files the user attached in this conversation (main/attachments.js): its own copies only, read as outside content.
      const attached = /^[a-z0-9_-]+$/i.test(this.convId || '') && path.join(require('./datadir').attachmentsFolder(), this.convId);
      if (attached && inside(attached, target)) {
        turnguard.noteApprovedRead(turnState, tool, input);
        return { behavior: 'allow', updatedInput: input };
      }
      if (!(this.spec.readRoots || []).some((r) => inside(r, target))) {
        log.info('read outside allowed folders denied', { tool, target });
        return { behavior: 'deny', message: `${target} is outside the folders you may use (${(this.spec.readRoots || []).join(', ')}). Only the user can allow another folder (Settings → Documents → Add folder); ask them instead of looking elsewhere.` };
      }
      // Only reads outside the session's own folders come here (the CLI allows those itself): marked now.
      turnguard.noteApprovedRead(turnState, tool, input);
      return { behavior: 'allow', updatedInput: input };
    }
    // Only when the session was given it (web search on): a new host after outside content asks.
    if (tool === 'WebFetch' && (this.spec.builtins || []).includes('WebFetch')) {
      const r = await approvals.askOutbound(turnState, input.url);
      return r.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `User did not approve: ${r.reason}` };
    }
    return { behavior: 'deny', message: `Tool ${tool} is not available here.` };
  }

  // Edits inside a cloned GitHub repo: only on a work branch, never in .git, approved like
  // github_change_file (per the permission mode).
  async approveRepoEdit(tool, file, input, turnState) {
    const repo = github.repoOf(file);
    if (!repo) return { behavior: 'deny', message: 'Edit files inside a cloned repository (owner/name folder).' };
    // Compared where the file really is: a link or junction committed in the clone can't lead out of it.
    const real = path.relative(realPath(github.localPath(repo)), realPath(file));
    if (!real || real.startsWith('..') || path.isAbsolute(real)) return { behavior: 'deny', message: `That path leads out of ${repo}.` };
    if (real.includes(':')) return { behavior: 'deny', message: 'A file path in a repository can’t contain “:”.' };
    const rel = path.relative(github.localPath(repo), file).split(path.sep).join('/');
    if (require('./files').hasReservedPart(rel, ['.git']) || require('./files').hasReservedPart(real, ['.git'])) return { behavior: 'deny', message: '.git must not be modified.' };
    let branch;
    try {
      ({ branch } = await github.requireWorkBranch(repo));
    } catch (err) {
      return { behavior: 'deny', message: err.message };
    }
    const preview = String(input.new_string ?? input.content ?? '').slice(0, 600);
    const r = await approvals.gate(turnState, 'repo_change', `Change files in ${repo} (branch ${branch})`, `${tool} ${rel}${preview ? `\n\n${preview}` : ''}`);
    return r.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `User did not approve: ${r.reason}` };
  }

  send(content, { emit, signal, ctx }) {
    return new Promise((resolve, reject) => {
      const turn = {
        ctx,
        emit,
        text: '',
        tools: new Map(),
        records: [],
        sentAt: Date.now(),
        settled: false,
        resolve: (v) => {
          if (turn.settled) return;
          turn.settled = true;
          resolve(v);
        },
        reject: (e) => {
          if (turn.settled) return;
          turn.settled = true;
          reject(e);
        },
      };
      this.turn = turn;
      const stopped = () => {
        const e = new Error('Stopped');
        e.name = 'AbortError';
        turn.reject(e);
      };
      if (signal.aborted) return stopped(); // nothing was sent yet
      signal.addEventListener(
        'abort',
        () => {
          if (turn.settled) return;
          this.interrupt();
          stopped();
        },
        { once: true },
      );
      this.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
      this.resetIdle();
    });
  }

  onLine(line) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.session_id) this.sessionId = msg.session_id;
    const t = this.turn;
    if (msg.type === 'system' && msg.subtype === 'init') {
      if (msg.model) this.model = msg.model;
      return;
    }
    // The plan's usage windows (how much is left) come with every turn; the title bar shows them.
    if (msg.type === 'rate_limit_event') {
      onPlan = true; // only a Claude plan sends these: its main conversation keeps the cache an hour
      return claudeUsage.update(msg.rate_limit_info);
    }
    // The end of a turn that was interrupted (see interrupt()).
    if (msg.type === 'result' && this.afterInterrupt) return this.afterInterrupt();
    // A control request (model, effort, interrupt) the CLI refused: worth knowing, never fatal.
    if (msg.type === 'control_response') {
      if (msg.response?.subtype === 'error') log.warn('claude control request refused', { error: String(msg.response.error || '').slice(0, 300) });
      return;
    }
    if (!t || t.settled) return;
    if (msg.type === 'result') {
      // A plan's usage limit can come back as the reply text itself; it is an error (so multi-provider mode falls back).
      // Newer CLIs say "You've hit your limit · resets 5pm": anchored, and only in the CLI's own form (the
      // dot before its reset time) or flagged as an error, so a reply about some other limit stays a reply.
      const r = String(msg.result || '').trim();
      const limitHit = t.text.trim().length < 200 && (/usage limit reached/i.test(r) || (/^(you['’]?ve|you have) hit your (\w+ )?limit|^\d+-hour limit reached/i.test(r) && (msg.is_error === true || /[·∙•]\s*resets?\b/i.test(r))));
      if ((msg.is_error && !t.text) || limitHit) {
        if (limitHit && t.text) t.emit({ type: 'retract', chars: t.text.length });
        const why = String(msg.result || msg.errors?.join('; ') || 'Claude Code error');
        if (AUTH_ERROR.test(why)) invalidateStatus();
        t.reject(new Error(why));
        return;
      }
      // Where the time went: the CLI's own overhead vs. waiting for the model (finding slow turns).
      // startupMs: how long the message waited before the CLI's own clock started (a new process
      // starting and connecting its tool servers; ~0 when warm).
      const waited = Date.now() - t.sentAt - (Number(msg.duration_ms) || 0);
      log.info('claude timing', { totalMs: msg.duration_ms, apiMs: msg.duration_api_ms, firstTokenMs: msg.ttft_ms, toRequestMs: msg.time_to_request_ms, turns: msg.num_turns, contextTokens: t.contextTokens || undefined, startupMs: waited > 150 ? waited : undefined });
      this.resumable = this.sessionId;
      // A fresh session's first turn: how big a session starts in this setup (rollover is measured from it).
      const freshTokens = !this.resumed && !this.freshTokens && t.contextTokens ? (this.freshTokens = t.contextTokens) : 0;
      // What is cached now, and on which model (startOrReuse keeps it warm; outlives this process).
      lastCalls.set(this.convId, { model: this.requestedModel, at: Date.now(), tokens: t.contextTokens || 0, key: this.key });
      t.resolve({ text: t.text.trim() || String(msg.result || '').trim(), toolCalls: t.records, raw: null, model: this.model || this.spec.model, sessionId: this.sessionId, contextTokens: t.contextTokens || 0, freshTokens });
      this.resetIdle();
      return;
    }
    if (msg.parent_tool_use_id) return; // sub-agent traffic
    if (msg.type === 'stream_event') {
      const ev = msg.event || {};
      if (ev.type === 'message_start' && t.text && !t.text.endsWith('\n')) {
        t.text += '\n\n';
        t.emit({ type: 'text', delta: '\n\n' });
      } else if (ev.type === 'content_block_start' && ev.content_block?.type !== 'text') t.emit({ type: 'thinking' });
      else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
        t.text += ev.delta.text;
        t.emit({ type: 'text', delta: ev.delta.text });
      }
      return;
    }
    if (msg.type === 'assistant') {
      // How much the model read for this call: the session's size (the result's usage sums every call).
      if (msg.message?.model) this.model = msg.message.model; // after set_model, init's model is stale
      const u = msg.message?.usage;
      if (u) t.contextTokens = Math.max(t.contextTokens || 0, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
      for (const block of msg.message?.content || []) {
        if (block.type !== 'tool_use' || t.tools.has(block.id)) continue;
        const name = shortTool(block.name);
        if (name === 'approval_prompt') continue;
        // own: one of the app's tools (tools.js runs and logs it), not a connector or a Claude Code tool.
        t.tools.set(block.id, { name, input: block.input, started: Date.now(), own: /^mcp__nexus(_more)?__/.test(block.name) });
        t.emit({ type: 'tool_start', id: block.id, name, input: block.input });
        log.info('tool', { name, input: JSON.stringify(block.input || {}).slice(0, 300) });
      }
      return;
    }
    if (msg.type === 'user') {
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const info = t.tools.get(block.tool_use_id);
        if (!info) continue;
        const raw = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join('\n') : String(block.content ?? '');
        const preview = raw.slice(0, 600);
        // What came back is outside content (a page, search results, a connector's data, a file from the
        // user's folders or a cloned repo): marked when it arrives, not when the call is made, so a call
        // never counts as having read itself (its own approve() runs before its result). Only an error
        // result can be our refusal: a page or an email that starts with those words still taints.
        // The app's own tools were classified by tools.js when they ran (turnguard `own`).
        turnguard.noteResult(t.ctx?.turn, { tool: info.name, input: info.input || {}, content: block.content, error: Boolean(block.is_error), text: preview, spec: this.spec, own: info.own, untrusted: false });
        t.emit({ type: 'tool_end', id: block.tool_use_id, name: info.name, ok: !block.is_error, preview });
        t.records.push({ name: info.name, input: info.input, ok: !block.is_error, preview });
        const ms = Date.now() - info.started;
        if (block.is_error) logToolError(info, ms, preview);
        else if (ms > 5000) log.info('tool slow', { name: info.name, ms });
      }
    }
  }
}

// One failure, one line. The app's own tools answer with tools.js's JSON result, and tools.js has logged
// the failure already (with its arguments and stack); the CLI refusing the call (<tool_use_error>) or the
// bridge failing ("Error: …") never reached it. A call the user declined is an outcome, not a fault.
function logToolError(info, ms, preview) {
  if (info.own && /^\s*\{/.test(preview)) return;
  const declined = /^(User did not approve|Not approved by the user)/.test(preview);
  log[declined ? 'info' : 'warn'](declined ? 'tool declined' : 'tool failed', { name: info.name, ms, input: JSON.stringify(info.input || {}).slice(0, 300), preview: (declined ? approvals.declineForLog(preview) : preview).slice(0, 500) });
}

// Claude Code's own memory (MEMORY.md and how to write it) belongs to whoever develops the app, not to
// the assistant: off in its sessions (~1.2k tokens per message, and no notes written there).
const SESSION_SETTINGS = { autoMemoryEnabled: false };

/**
 * Which of the user's own Claude Code settings a session loads. Never the project's (the repo's
 * CLAUDE.md, which imports the developer map docs/agents/MAP.md: ~50k tokens; the assistant reads the map itself
 * before changing its code, prompt.js Self-improvement) and never local ones. The user's settings only
 * with connectors on, where their plugins are set up: otherwise the user's permission rules and extra
 * folders (written for their own coding sessions, e.g. "git push" allowed, a whole workspace readable)
 * would let calls skip approve() and the folder policy (documents.userFolders).
 * Only when the user also wants their plugins (claudeCode.plugins): the claude.ai connectors load
 * without them, and the plugins' skill lists were ~4,000 tokens on every message (16.2k vs 12.3k
 * measured), used twice in three weeks.
 */
const settingSources = (spec) => (spec.connectors && spec.plugins ? 'user' : '');

/** The CLI's arguments for a session. */
function sessionArgs(spec, { sysFile, mcpFile, settingsFile, resume }) {
  const args = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--system-prompt-snapshot', 'off',
    '--append-system-prompt-file', sysFile,
    '--setting-sources', settingSources(spec),
    '--settings', settingsFile,
    '--mcp-config', mcpFile, ...(spec.connectors ? [] : ['--strict-mcp-config']),
    '--tools', spec.builtins.join(','),
    '--allowedTools', spec.allowed.join(','),
    '--permission-mode', 'default', '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__nexus__approval_prompt',
  ];
  for (const d of spec.addDirs) args.push('--add-dir', d);
  const model = cliValue('model', spec.model);
  if (model && model !== 'default') args.push('--model', model);
  const effort = cliValue('effort', spec.effort);
  if (effort && effort !== 'default') args.push('--effort', effort);
  if (resume) args.push('--resume', resume);
  return args;
}

function sessionSpec({ settings, configKey, activeTools, cwd, vault, repos, folders = [], model }) {
  const cc = settings.claudeCode;
  const builtins = ['Read', 'Glob', 'Grep'];
  if (settings.web.enabled) builtins.push('WebSearch', 'WebFetch');
  if (settings.code.allowSelfModify) builtins.push('Edit', 'Write', 'Bash');
  else if (repos) builtins.push('Edit', 'Write');
  // Read, Glob and Grep are not pre-allowed: inside the session's folders the CLI allows them itself,
  // anything else comes to approve(), which checks the path against readRoots.
  const allowed = ['mcp__nexus'];
  const readRoots = [...new Set([cwd, vault, repos, ...folders, cwd && cliProjectDir(cwd)].filter(Boolean).map((p) => path.resolve(p)))];
  if (settings.web.enabled) allowed.push('WebSearch'); // WebFetch comes to approve() (approvals.askOutbound)
  // Exact commands only: a wildcard rule (Bash(git diff*)) let "git log --output=<file>", "git diff
  // --no-index <any file>" and "npm test --prefix <clone>" run without approve(). The other safe
  // forms (flags such as --oneline, one test file) come to approve(), which allows commandsafety's list.
  if (settings.code.allowSelfModify) allowed.push('Bash(npm run check)', 'Bash(node scripts/check.js)', 'Bash(npm test)', 'Bash(node scripts/test.js)', 'Bash(node scripts/verify.js)', 'Bash(git status)', 'Bash(git diff)', 'Bash(git log)');
  // The user's claude.ai connectors and plugins: found with ToolSearch, plugin skills with Skill.
  const withConnectors = Boolean(cc.connectors);
  const withPlugins = withConnectors && cc.plugins === true; // their skills (Skill) and MCP servers
  // Extensions (extensions.js): MCP servers Nexus adds itself; they work with connectors off too.
  const extensionServers = require('./extensions').mcpServers(settings);
  const extensionKeys = Object.keys(extensionServers);
  // Connector and extension tools are never pre-allowed: every call comes to approve(), which checks
  // the user's permission level for that server live (no session restart when a level changes).
  // The app's own tools on request (claudeCode.toolsOnRequest, on by default): the everyday ones
  // (CORE_TOOLS) stay loaded, the rest are a second server whose tools ToolSearch finds when a message
  // needs them. All 120 sent with every message were ~30k of a ~75k fresh session.
  const onRequest = cc.toolsOnRequest !== false;
  if (withConnectors || extensionKeys.length || onRequest) {
    builtins.push('ToolSearch');
    allowed.push('ToolSearch');
  }
  if (onRequest) allowed.push('mcp__nexus_more');
  if (withPlugins) {
    builtins.push('Skill');
    allowed.push('Skill');
  }
  const toolNames = activeTools.map((t) => t.name);
  const coreTools = onRequest ? toolNames.filter((n) => CORE_TOOLS.has(n)) : null;
  const spec = {
    connectors: withConnectors,
    plugins: withPlugins,
    extensions: extensionServers,
    system: '',
    builtins,
    allowed,
    toolNames,
    coreTools,
    cwd,
    vault,
    codeRoot: cwd,
    repos,
    readRoots,
    userFolders: folders,
    addDirs: [...new Set([vault, repos, ...folders].filter(Boolean))],
    model,
    effort: cc.effort,
    allowSelfModify: settings.code.allowSelfModify,
    idleMinutes: perf.profile(settings) === 'balanced' ? Math.min(cc.idleMinutes || 20, perf.BALANCED.sessionIdleMin) : cc.idleMinutes,
  };
  // The session restarts only when configuration changes (persona, tools…), not when the vault or
  // memories change (those reach the agent through the per-turn context) and not for a model switch
  // (Session.setModel changes it in place).
  // Each part named, so a restart can say what changed (see ensureSession).
  spec.keyParts = { config: configKey, builtins, allowed, tools: toolNames, core: coreTools, folders: [cwd, vault, repos, ...readRoots], effort: cc.effort, connectors: withConnectors, plugins: withPlugins, extensions: extensionServers };
  spec.key = crypto.createHash('sha1').update(JSON.stringify(Object.values(spec.keyParts))).digest('hex');
  return spec;
}

// The named fields that differ between two config keys (claudesession.configKey), or null when they
// can't be compared (an older key format).
function configFields(before, after) {
  try {
    const [a, b] = [JSON.parse(before), JSON.parse(after)];
    if (!a || !b || Array.isArray(a) || typeof a !== 'object') return null;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
    return keys.length ? keys.join(', ') : null;
  } catch {
    return null;
  }
}

/** Which parts of a session's configuration differ (for tools: which were added or removed). */
function changedParts(before = {}, after = {}) {
  const out = [];
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    const fields = k === 'config' ? configFields(before[k], after[k]) : null;
    if (fields) out.push(`config (${fields})`);
    else if (k === 'tools' && Array.isArray(before[k])) {
      const added = after[k].filter((t) => !before[k].includes(t));
      const removed = before[k].filter((t) => !after[k].includes(t));
      out.push(`tools${added.length ? ` +${added.join(',')}` : ''}${removed.length ? ` -${removed.join(',')}` : ''}`);
    } else out.push(k);
  }
  return out.join('; ');
}

// One at a time per conversation: the prewarm and the first message (or two windows' events) used to
// both find no live process while the prompt was being built, and each started one (two "claude
// session started" for one conversation in the same millisecond). The second now waits and reuses it.
async function ensureSession(conv, opts) {
  let session = sessions.get(conv.id);
  if (!session) {
    session = new Session(conv.id);
    sessions.set(conv.id, session);
  }
  const run = (session.ensuring || Promise.resolve()).catch(() => {}).then(() => startOrReuse(session, conv, opts)); // a failed earlier start reached its own caller; this one starts afresh
  session.ensuring = run;
  try {
    return await run;
  } finally {
    if (session.ensuring === run) session.ensuring = null;
  }
}

// The last call of each conversation's session: its model, when, how big, under which configuration.
const lastCalls = new Map();
let onPlan = false;
// How long the CLI keeps the main conversation cached: an hour on a Claude plan, 5 minutes on an API
// key (its promptCacheTtl setting), each with a margin.
const cacheTtl = () => (onPlan ? 55 : 4) * 60000;

// The model for this turn: the pace's choice unless that would make the session read cold (pace.warmModel).
function chooseModel(conv, spec, { model, routine, settings }) {
  if (settings.claudeCode?.keepModelWarm === false) return model;
  const last = lastCalls.get(conv.id);
  const pick = require('./pace').warmModel({ want: model, last, key: spec.key, ttlMs: cacheTtl(), routine });
  if (pick.kept) log.info('claude model kept warm', { conversation: conv.id, wanted: model || 'default', kept: pick.model, why: pick.kept, tokens: last.tokens });
  return pick.model;
}

// skipSaved: the conversation's saved session id is not resumed (runTurn's retry after a failed start).
async function startOrReuse(session, conv, { settings, configKey, buildPrompt, activeTools, cwd, vault, repos, folders, model: wanted, effort, routine = false, prewarming = false, skipSaved = false }) {
  const spec = sessionSpec({ settings, configKey, activeTools, cwd, vault, repos, folders, model: wanted });
  // A prewarm knows no message, so no pace: it never moves a live session's model (opening a chat
  // switched it to the settings' model), and a new process starts on the conversation's last one.
  const model = prewarming ? lastCalls.get(conv.id)?.model || wanted : chooseModel(conv, spec, { model: wanted, routine, settings });
  spec.model = model;
  if (session.alive() && session.key === spec.key) {
    if (prewarming) return session;
    session.setModel(model);
    session.setEffort(effort);
    return session;
  }
  // Never restart under a reply that is still being written (a persona picked from the menu mid-reply).
  if (prewarming && session.turn && !session.turn.settled) return session;
  // A restart costs a cold start (several seconds); the log says why it happened.
  const restart = session.alive();
  if (restart) log.info('claude session restarts', { conversation: conv.id, changed: changedParts(session.spec?.keyParts, spec.keyParts) });
  const p = await buildPrompt();
  spec.system = p.stable;
  spec.resume = (skipSaved ? null : conv.claudeSessionId) || session.resumable;
  // A session that held a withdrawn exchange (forget): a stale copy of the conversation still names it.
  if (spec.resume && forgotten.get(conv.id)?.has(spec.resume)) {
    spec.resume = null;
    session.resumable = null;
  }
  // A resumed session that is cold anyway is read in full: 127k tokens, 7.4 s to the first word after
  // a persona switch. A fresh one with the recent messages (transcript()) starts sooner (startFresh).
  const last = lastCalls.get(conv.id);
  const why = spec.resume && startFresh({ last, key: spec.key, tokens: conv.claudeTokens, freshTokens: conv.claudeFreshTokens, now: Date.now(), ttlMs: cacheTtl() });
  if (why) {
    log.info('claude session starts fresh', { conversation: conv.id, why, contextTokens: last?.tokens || conv.claudeTokens });
    spec.resume = null;
    session.resumable = null;
  }
  session.memIds = p.memIds;
  closeExcessSessions(conv.id, perf.sessionCap(settings));
  await session.spawn(spec);
  session.setEffort(effort);
  return session;
}

// At most a few live processes (perfcore.sessionCap: fewer on Balanced); the least recently used idle
// ones close (they resume their conversation when it is used again).
function closeExcessSessions(keep, cap) {
  const list = [...sessions.entries()].map(([id, s]) => ({ id, alive: s.alive(), busy: Boolean(s.turn && !s.turn.settled), lastUsed: s.lastUsed }));
  for (const id of perf.sessionsToClose(list, cap, keep)) {
    log.info('claude session closed to save memory', { conversation: id });
    sessions.get(id)?.kill();
  }
}

/** Live sessions (for the system monitor's memory section). */
function liveSessions() {
  return [...sessions.values()].filter((s) => s.alive()).map((s) => ({ busy: Boolean(s.turn && !s.turn.settled), pid: s.child?.pid }));
}

/** Closes the sessions that aren't answering right now (the memory section's "Free" button). */
function closeIdleSessions() {
  let n = 0;
  for (const s of sessions.values()) if (s.alive() && !(s.turn && !s.turn.settled)) (s.kill(), n++);
  return n;
}

const abortError = () => Object.assign(new Error('Stopped'), { name: 'AbortError' });
function raceAbort(p, signal) {
  if (!signal) return p;
  let off = () => {};
  const stopped = new Promise((_, reject) => {
    if (signal.aborted) return reject(abortError());
    const on = () => reject(abortError());
    signal.addEventListener('abort', on, { once: true });
    off = () => signal.removeEventListener('abort', on);
  });
  stopped.catch(() => {}); // only raced below; without this a turn that ends first leaves an unhandled rejection
  return Promise.race([p, stopped]).finally(off);
}

/**
 * One assistant turn through the conversation's warm Claude Code session. The stable prompt is built
 * once when the process starts; `buildContext(memIds)` supplies what changed since then, every turn.
 */
async function runTurn({ conv, history, buildContext, emit, signal, ctx, images = [], ...opts }) {
  const session0 = sessions.get(conv.id) || new Session(conv.id);
  sessions.set(conv.id, session0);
  const attempt = async (retry = false) => {
    if (signal.aborted) throw abortError(); // stopped while waiting in line: never sent, nothing spawned
    await session0.interrupting; // the previous, interrupted turn must end first
    if (signal.aborted) throw abortError();
    const session = await ensureSession(conv, retry ? { ...opts, skipSaved: true } : opts);
    const context = await buildContext(session.memIds);
    let prompt = history[history.length - 1].content;
    if (context) prompt = `<context>\n${context}\n</context>\n\n${prompt}`;
    if (!session.resumed && !session.sentAny) prompt = transcript(history) + prompt;
    else prompt = missedTurns(history) + prompt;
    session.sentAny = true;
    // Screenshots go in as image blocks next to the text.
    const pictures = images.map((url) => String(url).match(/^data:(image\/[\w+.-]+);base64,(.+)$/)).filter(Boolean).map((m) => ({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }));
    const content = pictures.length ? [...pictures, { type: 'text', text: prompt }] : prompt;
    return { session, result: session.send(content, { emit, signal, ctx }) };
  };
  // A process that dies before printing anything never started the turn (e.g. resuming a
  // conversation it can't load): start fresh once, with the recent conversation as context.
  // A process that dies after starting work is not retried, so no action runs twice.
  const run = async () => {
    const first = await attempt();
    try {
      return await first.result;
    } catch (err) {
      // A saved conversation the CLI can't find ("No conversation found with session ID") never started either.
      if (signal.aborted || (first.session.gotOutput && !NO_SAVED_SESSION.test(err.message))) throw err;
      log.warn('claude session failed to start; retrying with a fresh session', { conversation: conv.id, error: err });
      // The saved id is skipped (never written into the caller's conversation: claudesession.js keeps that).
      first.session.sessionId = null;
      first.session.resumable = null;
      first.session.key = '';
      return (await attempt(true)).result;
    }
  };
  const p = session0.chain.then(run, run);
  session0.chain = p.catch(() => {}); // the queue only orders the work; each caller gets its own error
  return raceAbort(p, signal); // Stop ends a turn waiting behind a warm-up or another reply at once
}

// Start the process ahead of time (e.g. while the greeting plays) so the first turn is warm.
// Also after a persona switch (claudesession.afterTurn, renderer personas.js): the new session's process
// and tool servers start while the user reads or listens (~1 s), not when they speak again.
// opts.epoch (epochOf when the caller read the conversation): a message run again since then makes it stale.
async function prewarm(conv, opts) {
  if (!conv) return;
  if (opts?.epoch !== undefined && opts.epoch !== epochOf(conv.id)) return;
  await ensureSession(conv, { ...opts, prewarming: true });
}

// Starting the process fills no cache: only a request does. So the first message after a launch or a
// persona switch read the whole session cold (5.0 and 7.3 s to Haiku's first word at 64–72k tokens,
// 2.3–3.4 s warm). warmCache sends one tiny message on the model the next one will likely use
// (claudesession.warmTarget), queued like a turn, while the greeting plays; skipped when the session is warm already.
const WARMUP = '[Automatic warm-up from the app, not a message from the user. Do not use any tools. Reply with only: ok]';
const WARMUP_TIMEOUT_MS = 60000;

/** Is a call on this configuration still cached? Then a warm-up would be wasted. */
const isWarm = (last, key, now, ttlMs) => Boolean(last && last.key === key && now - last.at < ttlMs);

// epoch: as for prewarm; checked when the queued warm-up starts and again right before it sends `history`.
async function warmCache(conv, opts, { model, effort, history = [], epoch } = {}) {
  if (!conv) return null;
  const session0 = sessions.get(conv.id) || new Session(conv.id);
  sessions.set(conv.id, session0);
  const stale = () => epoch !== undefined && epoch !== epochOf(conv.id);
  const run = async () => {
    if (stale()) return null;
    const session = await ensureSession(conv, { ...opts, prewarming: true });
    if (!session.alive() || (session.turn && !session.turn.settled)) return null;
    if (stale()) return null; // a message was run again while the session started: `history` is the old one
    if (isWarm(lastCalls.get(conv.id), session.key, Date.now(), cacheTtl())) return null;
    session.setModel(model);
    session.setEffort(effort);
    // A fresh session's first message carries the recent conversation (as runTurn's would), so it is
    // cached too and the user's message after it doesn't send it again.
    let text = WARMUP;
    if (!session.resumed && !session.sentAny) text = transcript([...history, { role: 'user', content: '' }]) + text;
    session.sentAny = true;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), WARMUP_TIMEOUT_MS);
    const started = Date.now();
    session.warming = true;
    try {
      const r = await session.send(text, { emit() {}, signal: ac.signal, ctx: null });
      // The user's first turn reports the fresh size (rollover is measured from it), not this one.
      session.freshTokens = 0;
      log.info('claude cache warmed', { conversation: conv.id, model: model || 'default', ms: Date.now() - started, contextTokens: r.contextTokens || undefined });
      return r;
    } finally {
      clearTimeout(timer);
      session.warming = false;
    }
  };
  const p = session0.chain.then(run, run);
  session0.chain = p.catch(() => {}); // the queue only orders the work; each caller gets its own error
  return p;
}

function endSession(convId) {
  sessions.get(convId)?.kill();
  sessions.delete(convId);
}

// A conversation's Claude session keeps everything it ever read (tool results included) and is resumed
// across restarts: one used for days had ~370k tokens, so every message re-read them (2–3 s before the
// first word warm, 6–11 s after a restart, and plan usage). Past this size it is closed after the turn
// and a fresh one carries on with the recent messages (transcript()); memories, notes and "where we
// left off" keep the rest.
const ROLLOVER_TOKENS = 100000;
// 50k (was 80k): a long chat carried up to ~165k tokens on every message; the recent messages, memories
// and notes carry over to the fresh one.
const GROWTH_TOKENS = 50000;
// Measured from how big a fresh session is in this setup (its tools, vault notes and persona: ~50k to
// ~120k): a fresh one of 119k rolled over again after one message when the limit was a flat 100k.
const needsRollover = (contextTokens, freshTokens = 0) => Number(contextTokens) > Math.max(ROLLOVER_TOKENS, (Number(freshTokens) || 0) + GROWTH_TOKENS);
const NO_SAVED_SESSION = /No conversation found with session ID/i;

// How big a fresh session starts here when the conversation hasn't measured it (37k measured with
// connectors on), and how far past that a cold session may have grown before it is not resumed.
const FRESH_GUESS = 40000;
const COLD_GROWTH = 15000;

/**
 * Resume the conversation's saved session, or start fresh with the recent messages? Fresh when the
 * resumed one would be read cold anyway (a new configuration such as a persona switch, or nothing
 * cached in this run or past the cache's lifetime) and it has grown well past a fresh one: after a
 * switch a 64k session took 5.0 s to Haiku's first word, a fresh one is ~37k. A warm one is always
 * resumed. `last` = lastCalls' entry; `tokens` = the size the conversation saved (conv.claudeTokens).
 * Returns why (for the log), or ''.
 */
function startFresh({ last, key, tokens, freshTokens, now, ttlMs }) {
  const size = Number(last?.tokens || tokens) || 0;
  if (size <= (Number(freshTokens) || FRESH_GUESS) + COLD_GROWTH) return '';
  if (!last) return 'cold after a restart';
  if (last.key !== key) return 'new configuration';
  if (now - last.at >= ttlMs) return 'cache expired';
  return '';
}

/** Closes the conversation's session so the next one starts fresh (not resumed). */
function rollover(convId, contextTokens) {
  log.info('claude session rolls over', { conversation: convId, contextTokens });
  endSession(convId);
}

// Session folders (system prompt, MCP config) left behind by processes that were killed hard.
async function sweepStaleTemp() {
  const root = os.tmpdir();
  const names = await fsp.readdir(root).catch(() => []);
  for (const name of names.filter((n) => n.startsWith('nexus-cc-'))) {
    const dir = path.join(root, name);
    const st = await fsp.stat(dir).catch(() => null); // gone meanwhile: nothing to sweep
    if (st?.isDirectory() && Date.now() - st.mtimeMs > 86400000) await fsp.rm(dir, { recursive: true, force: true }).catch(ignore('stale temp folder not removed (tried again at the next start)'));
  }
}

function shutdown() {
  for (const s of sessions.values()) s.kill();
  sessions.clear();
}

// One-shot completion (persona/theme generation, journaling). Optionally lets Claude look at an image.
// timeoutMs: a long reply (a drawing) may need more than the usual four minutes.
async function complete(prompt, { imagePath, model, timeoutMs } = {}) {
  const cli = await findCli();
  if (!cli) throw new Error('Claude Code is not installed.');
  const s = await store.getSettings();
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--permission-prompts', 'none'];
  const m = cliValue('model', model || s.claudeCode.model);
  if (m && m !== 'default') args.push('--model', m);
  if (imagePath) args.push('--tools', 'Read', '--allowedTools', 'Read');
  else args.push('--tools', '');
  const r = await collect(cli, args, { cwd: imagePath ? path.dirname(imagePath) : os.tmpdir(), input: imagePath ? `${prompt}\n\nThe agent's image is at: ${imagePath} (read it with the Read tool).` : prompt, timeout: Math.max(240000, Number(timeoutMs) || 0) });
  let json;
  try {
    json = JSON.parse(r.out);
  } catch {
    throw new Error((r.err || r.out || 'Claude Code returned no output').trim().slice(0, 500));
  }
  if (json.is_error) throw new Error(String(json.result || 'Claude Code error'));
  return String(json.result || '');
}

module.exports = { CORE_TOOLS, COMPANIONS, mcpServersFor, sessionArgs, changedParts, findCli, status, invalidateStatus, STATUS_TTL_MS, STATUS_RETRY_MS, listConnectors, cachedConnectors, sessionSpec, Session, openLogin, installHint, runTurn, prewarm, warmCache, startFresh, endSession, forget, epochOf, rollover, needsRollover, ROLLOVER_TOKENS, shutdown, complete, sweepStaleTemp, liveSessions, closeIdleSessions, cliValue, spawnCli, onText };
