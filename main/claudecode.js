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
const store = require('./store');
const bridge = require('./bridge');
const github = require('./github');
const approvals = require('./approvals');
const log = require('./logger');
const connectors = require('./connectors');
const claudeUsage = require('./claudeusage');
const perf = require('./perfcore');

const MCP_SERVER = path.join(__dirname, 'mcp-server.js');

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
    execFile(cmd, ['claude'], { windowsHide: true }, (err, out) => resolve(err ? null : String(out).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || null));
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

function spawnCli(cli, args, opts = {}) {
  const isScript = /\.(cmd|bat)$/i.test(cli);
  if (isScript) {
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
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
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
async function status() {
  const cli = await findCli();
  if (!cli) return { installed: false };
  const r = await collect(cli, ['auth', 'status', '--json'], { timeout: 20000 }).catch((e) => ({ err: e.message, out: '' }));
  let auth = {};
  try {
    auth = JSON.parse(r.out);
  } catch {
    /* not JSON */
  }
  const ver = await collect(cli, ['--version'], { timeout: 15000 }).catch(() => ({ out: '' }));
  return {
    installed: true,
    cli,
    version: ver.out.trim(),
    loggedIn: Boolean(auth.loggedIn),
    authMethod: auth.authMethod || null,
    email: auth.email || null,
    subscription: auth.subscriptionType || null,
    error: auth.loggedIn ? null : (r.err || '').trim() || null,
  };
}

// Opens a terminal window running `claude auth login` (browser-based sign-in to the Claude account).
async function openLogin(action = 'login') {
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

// ------------------------------------------------------------- warm sessions
// One long-lived Claude Code process per conversation (stream-json in/out), so each turn starts
// immediately instead of spawning the CLI, the MCP server and reloading the session every time.
// Permission prompts are routed to the app (approval_prompt via MCP) so the user can approve
// self-modification by click or voice.
const sessions = new Map(); // conversation id -> Session
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const WEB_TOOLS = ['WebFetch', 'WebSearch'];
const shortTool = (name) => String(name || '').replace(/^mcp__nexus__/, '');

function inside(root, file) {
  if (!root || !file) return false;
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// The folder a Read, Glob or Grep call looks in (relative to the session's folder); a glob pattern's
// fixed part counts when it is absolute.
function readTarget(input, cwd) {
  let target = input.file_path || input.notebook_path || input.path || '';
  if (!target && path.isAbsolute(String(input.pattern || ''))) target = String(input.pattern).split(/[*?[{]/)[0] || String(input.pattern);
  return path.resolve(cwd || '.', String(target || '.'));
}

// Claude Code keeps long tool results for this session under ~/.claude/projects/<folder name>/ and
// reads them back; that one folder (never other projects') is readable too.
const cliProjectDir = (cwd) => path.join(os.homedir(), '.claude', 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

function transcript(history) {
  const prior = history.slice(0, -1).slice(-12);
  if (!prior.length) return '';
  const lines = prior.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 1500)}`);
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
  const lines = gap.slice(-12).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content || '').slice(0, 1500)}`);
  return `[While you were unavailable, another model answered these messages]\n${lines.join('\n\n')}\n[End of those messages]\n\n`;
}

class Session {
  constructor(convId) {
    this.convId = convId;
    this.child = null;
    this.key = '';
    this.sessionId = null;
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
      getCtx: () => this.turn?.ctx || null,
      approve: (req) => this.inTurn(() => this.approve(req)),
    });
    this.unregister = unregister;
    const sysFile = path.join(this.tmp, 'system.md');
    const mcpFile = path.join(this.tmp, 'mcp.json');
    await fsp.writeFile(sysFile, spec.system, 'utf8');
    await fsp.writeFile(
      mcpFile,
      // With connectors, their tools are found on demand (ToolSearch); the app's own stay loaded.
      JSON.stringify({ mcpServers: { nexus: { command: process.execPath, args: [MCP_SERVER], env: { ELECTRON_RUN_AS_NODE: '1', NEXUS_BRIDGE_URL: b.url, NEXUS_BRIDGE_TOKEN: b.token, NEXUS_TURN: bridgeId }, ...(spec.connectors || Object.keys(spec.extensions || {}).length ? { alwaysLoad: true } : {}) }, ...(spec.extensions || {}) } }),
      'utf8',
    );
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--system-prompt-snapshot', 'off',
      '--append-system-prompt-file', sysFile,
      '--mcp-config', mcpFile, ...(spec.connectors ? [] : ['--strict-mcp-config']),
      '--tools', spec.builtins.join(','),
      '--allowedTools', spec.allowed.join(','),
      '--permission-mode', 'default', '--permission-prompts', 'host', '--permission-prompt-tool', 'mcp__nexus__approval_prompt',
    ];
    for (const d of spec.addDirs) args.push('--add-dir', d);
    if (spec.model && spec.model !== 'default') args.push('--model', spec.model);
    if (spec.effort && spec.effort !== 'default') args.push('--effort', spec.effort);
    const resume = spec.resume || this.sessionId;
    if (resume) args.push('--resume', resume);
    this.resumed = Boolean(resume);

    const child = spawnCli(cli, args, { cwd: spec.cwd, env: cliEnv() });
    this.child = child;
    this.key = spec.key;
    let buf = '';
    // Handlers act only while this child is the session's process: a replaced process exiting
    // late must not end the new one's turn or delete its files.
    const current = () => this.child === child;
    this.gotOutput = false;
    child.stdout.on('data', (chunk) => {
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
    child.stderr.on('data', (d) => {
      if (!current()) return;
      this.stderr = (this.stderr + d).slice(-4000);
      this.inTurn(() => log.debug('claude stderr', String(d).slice(0, 1500)));
    });
    const exited = (code, err) => {
      unregister();
      fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
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
      this.turn.reject(new Error(/log ?in|auth|credential/i.test(detail) ? `${detail}\nConnect your Claude account in Settings → AI brain.` : detail));
    } else if (!wasDead && code) log.warn('claude session exited', { conversation: this.convId, code, stderr: this.stderr.slice(-300) });
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
    const turnState = this.turn?.ctx?.turn;
    const { codeRoot, vault, repos, allowSelfModify } = this.spec;
    if (EDIT_TOOLS.includes(tool)) {
      const file = input.file_path || input.notebook_path || '';
      if (vault && inside(vault, file)) return { behavior: 'allow', updatedInput: input };
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
      const r = await approvals.gate(turnState, 'command', 'Run a command on your computer', String(input.command || ''));
      return r.allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `User did not approve: ${r.reason}` };
    }
    if (connectors.isConnectorTool(tool)) {
      if (!this.spec.connectors && !(connectors.toolServer(tool) in (this.spec.extensions || {}))) return { behavior: 'deny', message: 'Connectors are turned off in Settings.' };
      // Connectors act in the user's accounts (send, post, create, delete), so they ask even in auto
      // mode; one yes covers that connector for the rest of the turn. The user's level for the service
      // (connectors.levelOf: allow reading / all but deleting / everything) is read live, so a change
      // applies at once, even mid-turn, and taking a permission back never waits for a restart.
      const server = connectors.toolServer(tool);
      if (turnState?.connectorsApproved?.has(server)) return { behavior: 'allow', updatedInput: input };
      const cc = (await store.getSettings()).claudeCode;
      if (connectors.permits(connectors.levelOf(cc, server), tool)) return { behavior: 'allow', updatedInput: input };
      // Parallel calls to one service (several searches at once) ask once: the others wait for that
      // answer instead of each opening a dialog.
      const asking = turnState?.connectorAsking?.get(server);
      if (asking) {
        const first = await asking;
        if (first.allow) return { behavior: 'allow', updatedInput: input };
        return { behavior: 'deny', message: `User did not approve: ${first.reason}` };
      }
      const { service, action } = connectors.describeTool(tool);
      const choices = connectors.rememberChoices(tool);
      const question = approvals.gate(turnState, 'connector', `Use ${service}: ${action}`, JSON.stringify(input, null, 2).slice(0, 1500), { remember: choices });
      if (turnState) (turnState.connectorAsking ||= new Map()).set(server, question);
      let r;
      try {
        r = await question;
      } finally {
        turnState?.connectorAsking?.delete(server);
      }
      if (r.allow && turnState) (turnState.connectorsApproved ||= new Set()).add(server);
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
      if (!(this.spec.readRoots || []).some((r) => inside(r, target))) {
        log.info('read outside allowed folders denied', { tool, target });
        return { behavior: 'deny', message: `${target} is outside the folders you may use (${(this.spec.readRoots || []).join(', ')}). Only the user can allow another folder (Settings → Documents → Add folder); ask them instead of looking elsewhere.` };
      }
      approvals.markTainted(turnState, `${tool} ${input.file_path || input.path || ''}`);
      return { behavior: 'allow', updatedInput: input };
    }
    return { behavior: 'deny', message: `Tool ${tool} is not available here.` };
  }

  // Edits inside a cloned GitHub repo: only on a work branch, never in .git, approved like
  // github_change_file (per the permission mode).
  async approveRepoEdit(tool, file, input, turnState) {
    const repo = github.repoOf(file);
    if (!repo) return { behavior: 'deny', message: 'Edit files inside a cloned repository (owner/name folder).' };
    const rel = path.relative(github.localPath(repo), file).split(path.sep).join('/');
    if (require('./files').hasReservedPart(rel, ['.git'])) return { behavior: 'deny', message: '.git must not be modified.' };
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
    if (msg.type === 'rate_limit_event') return claudeUsage.update(msg.rate_limit_info);
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
      const limitHit = /usage limit reached/i.test(String(msg.result || '')) && t.text.trim().length < 200;
      if ((msg.is_error && !t.text) || limitHit) {
        if (limitHit && t.text) t.emit({ type: 'retract', chars: t.text.length });
        t.reject(new Error(String(msg.result || msg.errors?.join('; ') || 'Claude Code error')));
        return;
      }
      // Where the time went: the CLI's own overhead vs. waiting for the model (finding slow turns).
      log.info('claude timing', { totalMs: msg.duration_ms, apiMs: msg.duration_api_ms, firstTokenMs: msg.ttft_ms, toRequestMs: msg.time_to_request_ms, turns: msg.num_turns, contextTokens: t.contextTokens || undefined });
      t.resolve({ text: t.text.trim() || String(msg.result || '').trim(), toolCalls: t.records, raw: null, model: this.model || this.spec.model, sessionId: this.sessionId, contextTokens: t.contextTokens || 0 });
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
      const u = msg.message?.usage;
      if (u) t.contextTokens = Math.max(t.contextTokens || 0, (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0));
      for (const block of msg.message?.content || []) {
        if (block.type !== 'tool_use' || t.tools.has(block.id)) continue;
        const name = shortTool(block.name);
        if (name === 'approval_prompt') continue;
        if (WEB_TOOLS.includes(name)) approvals.markTainted(t.ctx?.turn, `${name} ${block.input?.url || block.input?.query || ''}`);
        // What a connector returns (emails, documents, tasks, web results) is external content too.
        if (connectors.isConnectorTool(name)) approvals.markTainted(t.ctx?.turn, name);
        t.tools.set(block.id, { name, input: block.input, started: Date.now() });
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
        t.emit({ type: 'tool_end', id: block.tool_use_id, name: info.name, ok: !block.is_error, preview });
        t.records.push({ name: info.name, input: info.input, ok: !block.is_error, preview });
        const ms = Date.now() - info.started;
        if (block.is_error) log.warn('tool failed', { name: info.name, ms, input: JSON.stringify(info.input || {}).slice(0, 300), preview: preview.slice(0, 500) });
        else if (ms > 5000) log.info('tool slow', { name: info.name, ms });
      }
    }
  }
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
  if (settings.web.enabled) allowed.push('WebSearch', 'WebFetch');
  if (settings.code.allowSelfModify) allowed.push('Bash(npm run check)', 'Bash(node scripts/check.js)', 'Bash(npm test*)', 'Bash(node scripts/test.js*)', 'Bash(node scripts/verify.js*)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)');
  // The user's claude.ai connectors and plugins: found with ToolSearch, plugin skills with Skill.
  const withConnectors = Boolean(cc.connectors);
  // Extensions (extensions.js): MCP servers Nexus adds itself; they work with connectors off too.
  const extensionServers = require('./extensions').mcpServers(settings);
  const extensionKeys = Object.keys(extensionServers);
  // Connector and extension tools are never pre-allowed: every call comes to approve(), which checks
  // the user's permission level for that server live (no session restart when a level changes).
  if (withConnectors || extensionKeys.length) {
    builtins.push('ToolSearch');
    allowed.push('ToolSearch');
  }
  if (withConnectors) {
    builtins.push('Skill');
    allowed.push('Skill');
  }
  const toolNames = activeTools.map((t) => t.name);
  const spec = {
    connectors: withConnectors,
    extensions: extensionServers,
    system: '',
    builtins,
    allowed,
    toolNames,
    cwd,
    vault,
    codeRoot: cwd,
    repos,
    readRoots,
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
  spec.keyParts = { config: configKey, builtins, allowed, tools: toolNames, folders: [cwd, vault, repos, ...readRoots], effort: cc.effort, connectors: withConnectors, extensions: extensionServers };
  spec.key = crypto.createHash('sha1').update(JSON.stringify(Object.values(spec.keyParts))).digest('hex');
  return spec;
}

/** Which parts of a session's configuration differ (for tools: which were added or removed). */
function changedParts(before = {}, after = {}) {
  const out = [];
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    if (k === 'tools' && Array.isArray(before[k])) {
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
  const run = (session.ensuring || Promise.resolve()).catch(() => {}).then(() => startOrReuse(session, conv, opts));
  session.ensuring = run;
  try {
    return await run;
  } finally {
    if (session.ensuring === run) session.ensuring = null;
  }
}

async function startOrReuse(session, conv, { settings, configKey, buildPrompt, activeTools, cwd, vault, repos, folders, model, effort }) {
  const spec = sessionSpec({ settings, configKey, activeTools, cwd, vault, repos, folders, model });
  if (session.alive() && session.key === spec.key) {
    session.setModel(model);
    session.setEffort(effort);
    return session;
  }
  // A restart costs a cold start (several seconds); the log says why it happened.
  if (session.alive()) log.info('claude session restarts', { conversation: conv.id, changed: changedParts(session.spec?.keyParts, spec.keyParts) });
  const p = await buildPrompt();
  spec.system = p.stable;
  spec.resume = conv.claudeSessionId || session.sessionId;
  session.memIds = p.memIds;
  if (perf.profile(settings) === 'balanced') closeExcessSessions(conv.id);
  await session.spawn(spec);
  session.setEffort(effort);
  return session;
}

// Balanced performance: at most a few live processes; the least recently used idle ones close (they
// resume their conversation when it is used again).
function closeExcessSessions(keep) {
  const list = [...sessions.entries()].map(([id, s]) => ({ id, alive: s.alive(), busy: Boolean(s.turn && !s.turn.settled), lastUsed: s.lastUsed }));
  for (const id of perf.sessionsToClose(list, perf.BALANCED.sessionCap, keep)) {
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

/**
 * One assistant turn through the conversation's warm Claude Code session. The stable prompt is built
 * once when the process starts; `buildContext(memIds)` supplies what changed since then, every turn.
 */
async function runTurn({ conv, history, buildContext, emit, signal, ctx, images = [], ...opts }) {
  const session0 = sessions.get(conv.id) || new Session(conv.id);
  sessions.set(conv.id, session0);
  const attempt = async () => {
    await session0.interrupting; // the previous, interrupted turn must end first
    const session = await ensureSession(conv, opts);
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
      if (signal.aborted || first.session.gotOutput) throw err;
      log.warn('claude session failed to start; retrying with a fresh session', { conversation: conv.id, error: err.message });
      conv.claudeSessionId = null;
      first.session.sessionId = null;
      first.session.key = '';
      return (await attempt()).result;
    }
  };
  const p = session0.chain.then(run, run);
  session0.chain = p.catch(() => {});
  return p;
}

// Start the process ahead of time (e.g. while the greeting plays) so the first turn is warm.
async function prewarm(conv, opts) {
  if (!conv) return;
  await ensureSession(conv, opts);
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
const ROLLOVER_TOKENS = Number(process.env.NEXUS_ROLLOVER_TOKENS) || 100000; // the variable: tests only
const needsRollover = (contextTokens) => Number(contextTokens) > ROLLOVER_TOKENS;

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
    const st = await fsp.stat(dir).catch(() => null);
    if (st?.isDirectory() && Date.now() - st.mtimeMs > 86400000) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
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
  const m = model || s.claudeCode.model;
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

module.exports = { changedParts, findCli, status, listConnectors, cachedConnectors, sessionSpec, Session, openLogin, installHint, runTurn, prewarm, endSession, rollover, needsRollover, ROLLOVER_TOKENS, shutdown, complete, sweepStaleTemp, liveSessions, closeIdleSessions };
