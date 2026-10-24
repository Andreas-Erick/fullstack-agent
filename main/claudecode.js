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

  async spawn(spec) {
    // The old process must be gone before the conversation is resumed in a new one.
    await this.kill();
    const cli = await findCli();
    if (!cli) throw new Error('Claude Code is not installed. Install it, then connect your Claude account in Settings → AI brain.');
    const b = await bridge.start();
    this.spec = spec;
    this.requestedModel = spec.model || 'default';
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
      JSON.stringify({ mcpServers: { nexus: { command: process.execPath, args: [MCP_SERVER], env: { ELECTRON_RUN_AS_NODE: '1', NEXUS_BRIDGE_URL: b.url, NEXUS_BRIDGE_TOKEN: b.token, NEXUS_TURN: bridgeId } } } }),
      'utf8',
    );
    const args = [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--system-prompt-snapshot', 'off',
      '--append-system-prompt-file', sysFile,
      '--mcp-config', mcpFile, '--strict-mcp-config',
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
    if (this.turn && !this.turn.settled) {
      const detail = err?.message || this.stderr.trim() || `Claude Code exited (code ${code})`;
      log.error('claude session exited mid-turn', { conversation: this.convId, code, detail: detail.slice(0, 500) });
      this.turn.reject(new Error(/log ?in|auth|credential/i.test(detail) ? `${detail}\nConnect your Claude account in Settings → AI brain.` : detail));
    } else if (!wasDead && code) log.warn('claude session exited', { conversation: this.convId, code, stderr: this.stderr.slice(-300) });
  }

  // Stops the process; resolves once it has exited (at most 5 seconds).
  kill() {
    clearTimeout(this.idleTimer);
    const child = this.child;
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
        if (/^(node_modules|\.git)(\/|$)/.test(rel)) return { behavior: 'deny', message: 'node_modules/ and .git/ must not be modified.' };
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
    if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') {
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
    if (/^\.git(\/|$)/.test(rel)) return { behavior: 'deny', message: '.git must not be modified.' };
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
      const onAbort = () => {
        // Interrupt = stop the process; the session id is kept, so the next turn resumes it.
        this.kill();
        const e = new Error('Stopped');
        e.name = 'AbortError';
        turn.reject(e);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
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
    if (!t || t.settled) return;
    if (msg.type === 'result') {
      // A plan's usage limit can come back as the reply text itself; it is an error (so multi-provider mode falls back).
      const limitHit = /usage limit reached/i.test(String(msg.result || '')) && t.text.trim().length < 200;
      if ((msg.is_error && !t.text) || limitHit) {
        if (limitHit && t.text) t.emit({ type: 'retract', chars: t.text.length });
        t.reject(new Error(String(msg.result || msg.errors?.join('; ') || 'Claude Code error')));
        return;
      }
      t.resolve({ text: t.text.trim() || String(msg.result || '').trim(), toolCalls: t.records, raw: null, model: this.model || this.spec.model, sessionId: this.sessionId });
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
      for (const block of msg.message?.content || []) {
        if (block.type !== 'tool_use' || t.tools.has(block.id)) continue;
        const name = shortTool(block.name);
        if (name === 'approval_prompt') continue;
        if (WEB_TOOLS.includes(name)) approvals.markTainted(t.ctx?.turn, `${name} ${block.input?.url || block.input?.query || ''}`);
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

function sessionSpec({ settings, configKey, activeTools, cwd, vault, repos, model }) {
  const cc = settings.claudeCode;
  const builtins = ['Read', 'Glob', 'Grep'];
  if (settings.web.enabled) builtins.push('WebSearch', 'WebFetch');
  if (settings.code.allowSelfModify) builtins.push('Edit', 'Write', 'Bash');
  else if (repos) builtins.push('Edit', 'Write');
  const allowed = ['Read', 'Glob', 'Grep', 'mcp__nexus'];
  if (settings.web.enabled) allowed.push('WebSearch', 'WebFetch');
  if (settings.code.allowSelfModify) allowed.push('Bash(npm run check)', 'Bash(node scripts/check.js)', 'Bash(npm test*)', 'Bash(node scripts/test.js*)', 'Bash(node scripts/verify.js*)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)');
  const toolNames = activeTools.map((t) => t.name);
  const spec = {
    system: '',
    builtins,
    allowed,
    toolNames,
    cwd,
    vault,
    codeRoot: cwd,
    repos,
    addDirs: [vault, repos].filter(Boolean),
    model,
    effort: cc.effort,
    allowSelfModify: settings.code.allowSelfModify,
    idleMinutes: cc.idleMinutes,
  };
  // The session restarts only when configuration changes (persona, tools…), not when the vault or
  // memories change (those reach the agent through the per-turn context) and not for a model switch
  // (Session.setModel changes it in place).
  spec.key = crypto.createHash('sha1').update(JSON.stringify([configKey, builtins, allowed, toolNames, cwd, vault, repos, cc.effort])).digest('hex');
  return spec;
}

async function ensureSession(conv, { settings, configKey, buildPrompt, activeTools, cwd, vault, repos, model }) {
  let session = sessions.get(conv.id);
  if (!session) {
    session = new Session(conv.id);
    sessions.set(conv.id, session);
  }
  const spec = sessionSpec({ settings, configKey, activeTools, cwd, vault, repos, model });
  if (session.alive() && session.key === spec.key) {
    session.setModel(model);
    return session;
  }
  const p = await buildPrompt();
  spec.system = p.stable;
  spec.resume = conv.claudeSessionId || session.sessionId;
  session.memIds = p.memIds;
  await session.spawn(spec);
  return session;
}

/**
 * One assistant turn through the conversation's warm Claude Code session. The stable prompt is built
 * once when the process starts; `buildContext(memIds)` supplies what changed since then, every turn.
 */
async function runTurn({ conv, history, buildContext, emit, signal, ctx, images = [], ...opts }) {
  const session0 = sessions.get(conv.id) || new Session(conv.id);
  sessions.set(conv.id, session0);
  const attempt = async () => {
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
async function complete(prompt, { imagePath, model } = {}) {
  const cli = await findCli();
  if (!cli) throw new Error('Claude Code is not installed.');
  const s = await store.getSettings();
  const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config', '--permission-prompts', 'none'];
  const m = model || s.claudeCode.model;
  if (m && m !== 'default') args.push('--model', m);
  if (imagePath) args.push('--tools', 'Read', '--allowedTools', 'Read');
  else args.push('--tools', '');
  const r = await collect(cli, args, { cwd: imagePath ? path.dirname(imagePath) : os.tmpdir(), input: imagePath ? `${prompt}\n\nThe agent's image is at: ${imagePath} (read it with the Read tool).` : prompt, timeout: 240000 });
  let json;
  try {
    json = JSON.parse(r.out);
  } catch {
    throw new Error((r.err || r.out || 'Claude Code returned no output').trim().slice(0, 500));
  }
  if (json.is_error) throw new Error(String(json.result || 'Claude Code error'));
  return String(json.result || '');
}

module.exports = { findCli, status, openLogin, installHint, runTurn, prewarm, endSession, shutdown, complete, sweepStaleTemp };
