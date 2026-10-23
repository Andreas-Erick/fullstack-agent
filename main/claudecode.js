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

  async spawn(spec) {
    this.kill();
    const cli = await findCli();
    if (!cli) throw new Error('Claude Code is not installed. Install it, then connect your Claude account in Settings â†’ AI brain.');
    const b = await bridge.start();
    this.spec = spec;
    this.dead = false;
    this.stderr = '';
    this.sentAny = false;
    this.tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'nexus-cc-'));
    const bridgeId = crypto.randomUUID();
    this.unregister = bridge.registerSession(bridgeId, {
      allowed: spec.toolNames,
      getCtx: () => this.turn?.ctx || null,
      approve: (req) => this.approve(req),
    });
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
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr.on('data', (d) => (this.stderr = (this.stderr + d).slice(-4000)));
    child.on('error', (err) => this.onExit(null, err));
    child.on('close', (code) => this.onExit(code));
    log.info('claude session started', { conversation: this.convId, model: spec.model, resume: resume || null, pid: child.pid });
    this.resetIdle();
  }

  onExit(code, err) {
    clearTimeout(this.idleTimer);
    this.unregister?.();
    if (this.tmp) fsp.rm(this.tmp, { recursive: true, force: true }).catch(() => {});
    const wasDead = this.dead;
    this.dead = true;
    if (this.turn && !this.turn.settled) {
      const detail = err?.message || this.stderr.trim() || `Claude Code exited (code ${code})`;
      log.error('claude session exited mid-turn', { conversation: this.convId, code, detail: detail.slice(0, 500) });
      this.turn.reject(new Error(/log ?in|auth|credential/i.test(detail) ? `${detail}\nConnect your Claude account in Settings â†’ AI brain.` : detail));
    } else if (!wasDead && code) log.warn('claude session exited', { conversation: this.convId, code, stderr: this.stderr.slice(-300) });
  }

  kill() {
    clearTimeout(this.idleTimer);
    if (this.alive()) {
      this.dead = true;
      killTree(this.child);
      this.unregister?.();
      log.info('claude session stopped', { conversation: this.convId });
    }
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
    const { codeRoot, vault, allowSelfModify } = this.spec;
    if (EDIT_TOOLS.includes(tool)) {
      const file = input.file_path || input.notebook_path || '';
      if (vault && inside(vault, file)) return { behavior: 'allow', updatedInput: input };
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

  send(text, { emit, signal, ctx }) {
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
      this.child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`);
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
      if (msg.is_error && !t.text) {
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
        t.tools.set(block.id, { name, input: block.input });
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
        if (block.is_error) log.warn('tool failed', { name: info.name, preview: preview.slice(0, 300) });
      }
    }
  }
}

function sessionSpec({ settings, configKey, activeTools, cwd, vault, model }) {
  const cc = settings.claudeCode;
  const builtins = ['Read', 'Glob', 'Grep'];
  if (settings.web.enabled) builtins.push('WebSearch', 'WebFetch');
  if (settings.code.allowSelfModify) builtins.push('Edit', 'Write', 'Bash');
  const allowed = ['Read', 'Glob', 'Grep', 'mcp__nexus'];
  if (settings.web.enabled) allowed.push('WebSearch', 'WebFetch');
  if (settings.code.allowSelfModify) allowed.push('Bash(npm run check)', 'Bash(node scripts/check.js)', 'Bash(git status*)', 'Bash(git diff*)', 'Bash(git log*)');
  const toolNames = activeTools.map((t) => t.name);
  const spec = {
    system: '',
    builtins,
    allowed,
    toolNames,
    cwd,
    vault,
    codeRoot: cwd,
    addDirs: vault ? [vault] : [],
    model,
    effort: cc.effort,
    allowSelfModify: settings.code.allowSelfModify,
    idleMinutes: cc.idleMinutes,
  };
  // The session restarts only when configuration changes (persona, tools, model…), not when the
  // vault or memories change; those reach the agent through the per-turn context.
  spec.key = crypto.createHash('sha1').update(JSON.stringify([configKey, builtins, allowed, toolNames, cwd, vault, model, cc.effort])).digest('hex');
  return spec;
}

async function ensureSession(conv, { settings, configKey, buildPrompt, activeTools, cwd, vault, model }) {
  let session = sessions.get(conv.id);
  if (!session) {
    session = new Session(conv.id);
    sessions.set(conv.id, session);
  }
  const spec = sessionSpec({ settings, configKey, activeTools, cwd, vault, model });
  if (session.alive() && session.key === spec.key) return session;
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
async function runTurn({ conv, history, buildContext, emit, signal, ctx, ...opts }) {
  const session0 = sessions.get(conv.id) || new Session(conv.id);
  sessions.set(conv.id, session0);
  const run = async () => {
    const session = await ensureSession(conv, opts);
    const context = await buildContext(session.memIds);
    let prompt = history[history.length - 1].content;
    if (context) prompt = `<context>\n${context}\n</context>\n\n${prompt}`;
    if (!session.resumed && !session.sentAny) prompt = transcript(history) + prompt;
    session.sentAny = true;
    return session.send(prompt, { emit, signal, ctx });
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

module.exports = { findCli, status, openLogin, installHint, runTurn, prewarm, endSession, shutdown, complete };
