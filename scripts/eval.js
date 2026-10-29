// The assistant's test set, run against real brains: `npm run eval -- --brain <brain> [--brain …]
// [--only id,id] [--out file.json]`. An Electron main script without a window: a throwaway data folder
// and vault (never the user's), seeded with made-up data (scripts/eval-cases.js), then every case as
// a real turn through llm.runTurn with the real prompt and tools, each in a fresh copy of that vault.
// Brains:
//   local:<model>[+deep:<model>][+handover]  Ollama on this computer, e.g. local:qwen3:8b+deep:qwen3.8:27b;
//                                 +handover: hard messages go to the Claude account (llm.handOver)
//   claude:<haiku|sonnet|opus>    the Claude account (Claude Code), that model for every message
//   claude:auto                   the Claude account as the app runs it (Haiku / Sonnet / Opus by message)
// Local runs are free; Claude runs count toward the user's plan. Approvals are automatic except the
// kinds that always ask (connectors are off), which are declined: no window is open to ask.
// The npm script puts a "--" before the arguments: without it, some combinations (e.g. --brain
// local:qwen3:8b --only cal-tomorrow) made Electron exit at once with code 127, before this file ran.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const opt = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : [])).filter(Boolean);
const brains = opt('brain');
const only = new Set(opt('only').flatMap((s) => s.split(',')));
const outFile = opt('out')[0] || '';
const TURN_MS = 240000;
// Electron's main process: console.log is not always shown in a terminal on Windows (as in smoke.js).
const say = (line) => (process.stdout.write(`${line}\n`), process.env.NEXUS_EVAL_LOG && fs.appendFileSync(process.env.NEXUS_EVAL_LOG, `${line}\n`));
say(`eval: data in ${os.tmpdir()} (throwaway)`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siren-eval-'));
process.env.NEXUS_USER_DATA = path.join(tmp, 'data');
process.env.NEXUS_DOCUMENTS = path.join(tmp, 'documents');

const { app } = require('electron');
require(path.join(ROOT, 'main/datadir')).setup();
app.on('window-all-closed', () => {}); // no window: keep running until done

function brainSettings(spec) {
  const [kind, ...rest] = spec.split(':');
  const value = rest.join(':');
  if (kind === 'local') {
    const handOver = /\+handover\b/.test(value);
    const [model, deep] = value.replace(/\+handover\b/, '').split('+deep:');
    if (!model) throw new Error('local:<model>, e.g. local:qwen3:8b');
    return { llm: { provider: 'openai', baseUrl: 'http://localhost:11434/v1', apiKey: '', model, fastModel: model, deepModel: deep || model, handOver }, claudeCode: { model: 'default', fastModel: 'haiku', normalModel: 'sonnet', deepModel: 'opus', warmOnLaunch: false, connectors: false } };
  }
  if (kind === 'claude') {
    if (value === 'auto') return { llm: { provider: 'claude-code' }, claudeCode: { model: 'default', fastModel: 'haiku', normalModel: 'sonnet', deepModel: 'opus', warmOnLaunch: false, connectors: false } };
    if (!/^(haiku|sonnet|opus|fable)$/.test(value)) throw new Error('claude:<haiku|sonnet|opus|fable|auto>');
    return { llm: { provider: 'claude-code' }, claudeCode: { model: value, fastModel: value, normalModel: value, deepModel: value, warmOnLaunch: false, connectors: false } };
  }
  throw new Error(`Unknown brain "${spec}". Use local:<model> or claude:<model>.`);
}

async function main() {
  if (!brains.length) throw new Error('Say which brain: --brain local:qwen3:8b, --brain claude:sonnet …');
  const store = require(path.join(ROOT, 'main/store'));
  const llm = require(path.join(ROOT, 'main/llm'));
  const calendar = require(path.join(ROOT, 'main/calendar'));
  const habits = require(path.join(ROOT, 'main/habits'));
  const memory = require(path.join(ROOT, 'main/memory'));
  const flashcards = require(path.join(ROOT, 'main/flashcards'));
  const claudecode = require(path.join(ROOT, 'main/claudecode'));
  const { cases, seed, dates } = require('./eval-cases');

  const base = { onboarded: true, privacy: { acceptedAt: Date.now(), encryptConversations: false }, safety: { permissionMode: 'auto' }, llm: { useTools: true, autoPace: true, modelMode: 'default', voiceUsesFast: true, compactPrompt: 'auto' }, memory: { stream: false }, journal: { enabled: false, handoffOnClose: false } };
  await store.setSettings(base);
  const d = dates();
  // The made-up vault, once; every case gets its own copy.
  const template = path.join(tmp, 'vault-template');
  await store.setSettings({ obsidian: { enabled: true, vaultPath: template } });
  await seed({ calendar, habits, memory, flashcards, vault: template, fs, path }, d);

  const list = cases(d).filter((c) => !only.size || only.has(c.id));
  const results = [];
  for (const brain of brains) {
    const brainPatch = brainSettings(brain);
    say(`\n=== ${brain} (${list.length} cases)`);
    for (const c of list) {
      const vault = path.join(tmp, 'vaults', `${brain.replace(/[^\w.-]+/g, '_')}-${c.id}`);
      fs.cpSync(template, vault, { recursive: true });
      await store.setSettings({ ...brainPatch, obsidian: { enabled: true, vaultPath: vault } });
      const settings = await store.getSettings();
      const conv = await store.createConversation();
      conv.messages.push({ id: store.newId('m'), role: 'user', content: c.ask, createdAt: Date.now() });
      const tools = [];
      let first = null;
      const started = Date.now();
      const emit = (ev) => {
        if (ev.type === 'text' && first === null) first = Date.now() - started;
        if (ev.type === 'tool_start') tools.push({ id: ev.id, name: ev.name, input: ev.input, ok: null });
        if (ev.type === 'tool_end') {
          const t = tools.find((x) => x.id === ev.id) || tools.find((x) => x.name === ev.name && x.ok === null);
          if (t) t.ok = ev.ok;
        }
      };
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TURN_MS);
      let text = '';
      let error = '';
      let handedOver = '';
      try {
        const r = await llm.runTurn({ settings, conv, history: conv.messages, emit, signal: ac.signal, voice: false, images: [] });
        text = r.text || '';
        handedOver = r.handedOver || '';
        for (const t of r.toolCalls || []) if (!tools.some((x) => x.name === t.name && x.ok !== null)) tools.push({ name: t.name, input: t.input, ok: t.ok });
      } catch (err) {
        error = ac.signal.aborted ? `no reply within ${TURN_MS / 1000} s` : err.message;
      } finally {
        clearTimeout(timer);
        claudecode.endSession(conv.id);
      }
      const ms = Date.now() - started;
      const state = {
        schedule: async () => (await calendar.entries()).entries,
        habits: async () => (await habits.status()).habits,
        habitDone: async (name) => Boolean((await habits.status()).habits.find((h) => h.name.toLowerCase() === name.toLowerCase())?.doneToday),
        memories: () => memory.list(),
        cards: async (deck) => (await flashcards.browse(`f:${deck}`)).cards,
        findNote: async (re) => {
          const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name.startsWith('.') ? [] : walk(path.join(dir, e.name))) : [path.join(dir, e.name)]));
          const hit = walk(vault).find((f) => f.endsWith('.md') && re.test(path.basename(f)));
          return hit ? { path: hit, text: fs.readFileSync(hit, 'utf8') } : null;
        },
      };
      const used = (...names) => tools.some((t) => names.includes(t.name));
      let why = error;
      if (!why) {
        try {
          why = await c.check({ text, tools, used, state });
        } catch (err) {
          why = `check failed: ${err.message}`;
        }
      }
      const row = { brain, id: c.id, area: c.area, pass: !why, why, firstMs: first, ms, handedOver, tools: tools.map((t) => `${t.name}${t.ok === false ? '✗' : ''}`), text: text.slice(0, 400) };
      results.push(row);
      say(`${row.pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(14)} ${String(first ?? '-').padStart(6)} ms first · ${String(ms).padStart(6)} ms · ${row.tools.join(',') || '-'}${handedOver ? ` · → Claude (${handedOver})` : ''}${why ? `\n     ${why}\n     reply: ${JSON.stringify(text.slice(0, 160))}` : ''}`);
    }
  }
  // Summary per brain and area.
  say('\n=== Summary');
  for (const brain of brains) {
    const mine = results.filter((r) => r.brain === brain);
    const pass = mine.filter((r) => r.pass).length;
    const med = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : '-');
    const areas = [...new Set(mine.map((r) => r.area))].map((a) => `${a} ${mine.filter((r) => r.area === a && r.pass).length}/${mine.filter((r) => r.area === a).length}`);
    say(`${brain}: ${pass}/${mine.length} passed · median first word ${med(mine.map((r) => r.firstMs).filter((x) => x != null))} ms · median turn ${med(mine.map((r) => r.ms))} ms${mine.some((r) => r.handedOver) ? ` · ${mine.filter((r) => r.handedOver).length} handed to Claude` : ''}\n  ${areas.join(' · ')}`);
  }
  if (outFile) fs.writeFileSync(outFile, JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
}

app.whenReady().then(main).then(
  async () => {
    await Promise.resolve(require(path.join(ROOT, 'main/claudecode')).shutdown?.()).catch(() => {});
    // Windows may still hold a file open for a moment (a Claude process just ended): leave it then.
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      say(`(the throwaway folder ${tmp} could not be removed yet; it is in the system's temp folder)`);
    }
    app.exit(0);
  },
  (err) => {
    say(`EVAL FAIL ${err.stack || err.message}`);
    app.exit(1);
  },
);
