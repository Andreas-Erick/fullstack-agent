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
// --suite basic (the single messages, default) | scenarios (six kinds of users, persona switches) | all
const suite = opt('suite')[0] || 'basic';
if (!['basic', 'scenarios', 'all'].includes(suite)) throw new Error('--suite basic | scenarios | all');
// --persona <file> [--name <name>]: run with that master prompt (how well a brain stays in character).
const personaFile = opt('persona')[0] || '';
const personaName = opt('name')[0] || 'Siren';
let personaShown = false;
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
  if (personaFile) {
    const personality = fs.readFileSync(personaFile, 'utf8');
    // --summary <file>: the short version local models read (else they get the digest).
    const summary = opt('summary')[0] ? { text: fs.readFileSync(opt('summary')[0], 'utf8').trim(), for: require(path.join(ROOT, 'main/personacore')).fingerprint(personality), by: 'model' } : null;
    base.agent = { name: personaName, personality, personaSummary: summary };
  }
  await store.setSettings(base);
  const d = dates();
  const scen = require('./eval-scenarios');
  const persona = require(path.join(ROOT, 'main/persona'));
  // The suites' made-up worlds, each seeded once; every case gets its own copy of its vault.
  const templates = {};
  if (suite !== 'scenarios') {
    templates.basic = path.join(tmp, 'vault-basic');
    await store.setSettings({ obsidian: { enabled: true, vaultPath: templates.basic } });
    await seed({ calendar, habits, memory, flashcards, vault: templates.basic, fs, path }, d);
  }
  const sd = scen.scenarioDates();
  if (suite !== 'basic') {
    templates.scenarios = path.join(tmp, 'vault-scenarios');
    await store.setSettings({ obsidian: { enabled: true, vaultPath: templates.scenarios } });
    await scen.seedScenarios({ calendar, habits, memory, flashcards, vault: templates.scenarios, fs, path }, sd);
    // The test personas, made the way the Persona studio makes them; the first persona stays active.
    const first = (await store.getSettings()).personas.active;
    for (const p of scen.PERSONAS) {
      await persona.create({ name: p.name, activate: true });
      await store.setSettings({ agent: { name: p.name, personality: p.personality } });
    }
    await persona.activate(first);
  }
  const homePersona = (await store.getSettings()).personas.active;
  const list = [
    ...(templates.basic ? cases(d).map((c) => ({ ...c, world: 'basic' })) : []),
    ...(templates.scenarios ? scen.scenarios(sd).map((c) => ({ ...c, world: 'scenarios' })) : []),
  ].filter((c) => !only.size || only.has(c.id) || only.has(c.area));
  const results = [];
  for (const brain of brains) {
    const brainPatch = brainSettings(brain);
    say(`\n=== ${brain} (${list.length} cases)`);
    for (const c of list) {
      const vault = path.join(tmp, 'vaults', `${brain.replace(/[^\w.-]+/g, '_')}-${c.id}`);
      // Without the template's note history: it may still be writing it in the background (vaultgit).
      fs.cpSync(templates[c.world], vault, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
      await store.setSettings({ ...brainPatch, obsidian: { enabled: true, vaultPath: vault } });
      await persona.activate(homePersona);
      if (personaFile && !personaShown) {
        const a = (await store.getSettings()).agent;
        personaShown = true;
        say(`persona: ${a.name}, ${a.personality.length} chars; local models get ${require(path.join(ROOT, 'main/personacore')).forSmallModels(a).length}`);
      }
      const conv = await store.createConversation();
      const steps = c.steps || [{ ask: c.ask, check: c.check, voice: c.voice }];
      const state = {
        schedule: async () => (await calendar.entries()).entries,
        // Occurrences, repeat rules expanded: [{ title, start (ISO), end, … }] between two YYYY-MM-DD dates.
        events: (start, end) => calendar.events({ start, end }),
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
      const allTools = [];
      let first = null;
      let why = '';
      let lastText = '';
      let handedOver = '';
      const started = Date.now();
      let n = 0;
      for (const step of steps) {
        if (step.persona) {
          await persona.activate(step.persona);
          continue;
        }
        n++;
        // What the app does around a turn (main.js startTurn): the message in, the reply stored with
        // its persona, the Claude session kept or dropped, loaded tool groups kept.
        const settings = await store.getSettings();
        conv.messages.push({ id: store.newId('m'), role: 'user', content: step.ask, createdAt: Date.now() });
        const tools = [];
        const emit = (ev) => {
          if (ev.type === 'text' && first === null) first = Date.now() - started;
          if (ev.type === 'tool_start') tools.push({ id: ev.id, name: ev.name, input: ev.input, ok: null });
          if (ev.type === 'tool_end') {
            const t = tools.find((x) => x.id === ev.id) || tools.find((x) => x.name === ev.name && x.ok === null);
            if (t) Object.assign(t, { ok: ev.ok, preview: ev.preview });
          }
        };
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), TURN_MS);
        let text = '';
        let error = '';
        try {
          const r = await llm.runTurn({ settings, conv, history: conv.messages, emit, signal: ac.signal, voice: Boolean(step.voice), images: [] });
          text = r.text || '';
          handedOver ||= r.handedOver || '';
          for (const t of r.toolCalls || []) if (!tools.some((x) => x.name === t.name && x.ok !== null)) tools.push({ name: t.name, input: t.input, ok: t.ok });
          conv.messages.push({ id: store.newId('m'), role: 'assistant', content: text, provider: r.provider || settings.llm.provider, persona: settings.agent.name, model: r.model, createdAt: Date.now() });
          if (r.rollover) conv.claudeSessionId = null;
          else if (r.sessionId) conv.claudeSessionId = r.sessionId;
          if (r.freshTokens) conv.claudeFreshTokens = r.freshTokens;
          if (r.convPatch) Object.assign(conv, r.convPatch);
        } catch (err) {
          error = ac.signal.aborted ? `no reply within ${TURN_MS / 1000} s` : err.message;
        } finally {
          clearTimeout(timer);
        }
        lastText = text;
        allTools.push(...tools);
        const used = (...names) => tools.some((t) => names.includes(t.name));
        let stepWhy = error;
        if (!stepWhy) {
          try {
            stepWhy = await step.check({ text, tools, used, state });
          } catch (err) {
            stepWhy = `check failed: ${err.message}`;
          }
        }
        if (stepWhy) {
          why = steps.length > 1 ? `message ${n} (“${step.ask.slice(0, 50)}”): ${stepWhy}` : stepWhy;
          break;
        }
      }
      claudecode.endSession(conv.id);
      const ms = Date.now() - started;
      const row = { brain, id: c.id, area: c.area, pass: !why, why, firstMs: first, ms, messages: n, handedOver, tools: allTools.map((t) => `${t.name}${t.ok === false ? '✗' : ''}`), text: lastText.slice(0, 400) };
      results.push(row);
      say(`${row.pass ? 'PASS' : 'FAIL'} ${c.id.padEnd(22)} ${String(first ?? '-').padStart(6)} ms first · ${String(ms).padStart(6)} ms${n > 1 ? ` · ${n} messages` : ''} · ${row.tools.join(',') || '-'}${handedOver ? ` · → Claude (${handedOver})` : ''}${why ? `\n     ${why}\n     reply: ${JSON.stringify(lastText.slice(0, 160))}` : ''}${why ? allTools.map((t) => `\n     ${t.ok === false ? '✗' : '·'} ${t.name} ${JSON.stringify(t.input || {}).slice(0, 150)}${t.ok === false ? ` → ${String(t.preview || '').replace(/\s+/g, ' ').slice(0, 200)}` : ''}`).join('') : ''}`);
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
