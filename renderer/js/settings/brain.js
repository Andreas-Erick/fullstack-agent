// The AI brain card: the provider modes, the multi-provider list, the local model finder and the connection test.
import { api, el, toast, toastError, emit, plainError } from '../util.js';
import { testFailure } from '../chatcore.js';
import { ownEndpoint, brain, name as brainName } from '../braintable.mjs';
import { state } from '../state.js';
import { save, render } from './core.js';
import { text, toggle, select, fillSelect, field, card, result, showResult, showFailure, debounceAfter } from './fields.js';
import { connectorsSection } from './connectors.js';

const CLAUDE_MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (default)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
  ['claude-fable-5-1', 'Claude Fable 5.1'],
];

export function brainCard() {
  const provider = state.settings.llm.provider;
  const seg = el(
    'div',
    { class: 'seg' },
    [['auto', 'Multi-provider'], ['claude-code', 'Claude account'], ['openai', 'FreeLLMAPI / local'], ['anthropic', 'Claude API key']].map(([v, l]) =>
      el('button', { class: provider === v ? 'active' : '', onclick: async () => (await save('llm.provider', v), render(), emit('status-refresh')) }, l),
    ),
  );
  const out = result();
  const test = el('button', {
    class: 'btn primary',
    onclick: async () => {
      // A real model call (every provider in multi-provider mode): one at a time.
      if (test.disabled) return;
      test.disabled = true;
      test.textContent = '⏳ Testing…';
      showResult(out, true, 'Testing…');
      try {
        const r = await api.llm.test();
        const o = testOutcome(r);
        showResult(out, o.ok, o.text, o.raw);
        if (r.providers) refreshRouting?.();
        emit('status-refresh');
      } catch (err) {
        showFailure(out, err);
      } finally {
        test.disabled = false;
        test.textContent = '⚡ Test connection';
      }
    },
  }, '⚡ Test connection');

  const body = [];
  // The plan meter (title bar), wherever the Claude account brain can answer; also under Interface.
  const usageToggle = () => toggle('ui.showClaudeUsage', 'Show how much of my Claude plan is left (in the title bar)');
  if (provider === 'auto') {
    body.push(...routingSection(), usageToggle());
  } else if (provider === 'claude-code') {
    const line = el('div', { class: 'test-result' }, 'Checking Claude Code…');
    const actions = el('div', { class: 'row', style: { flexWrap: 'wrap' } });
    const refreshStatus = async () => {
      line.className = 'test-result';
      line.textContent = 'Checking Claude Code…';
      actions.innerHTML = '';
      // The catalogue's word on the account (main/brains.js claudeState), with a fresh sign-in check. A
      // check that failed (timed out, crashed) says nothing about the sign-in: it isn't "not installed".
      const b = await api.llm.brains({ fresh: true }).then((r) => r.current).catch((e) => ({ state: 'unchecked', claude: { installed: true, checked: false, error: e.message } }));
      const st = b.claude || {};
      const connect = (cls) => el('button', { class: cls, onclick: () => connectClaude() }, 'Connect Claude account');
      if (b.state === 'missing') {
        const hint = await api.claude.installHint();
        line.className = 'test-result err';
        line.textContent = `✕ Claude Code is not installed (or not found on PATH).\nInstall it with:\n  ${hint}\nthen click Refresh — or set the path to the claude executable below.`;
      } else if (b.state === 'unchecked') {
        line.className = 'test-result err';
        line.textContent = `Couldn’t check your Claude account: ${st.error}`;
        actions.append(connect('btn'));
      } else if (b.state !== 'ready') {
        line.className = 'test-result err';
        line.textContent = `Claude Code ${st.version} found, but no Claude account is connected.`;
        actions.append(connect('btn primary'));
      } else {
        line.className = 'test-result ok';
        line.textContent = `✓ Connected as ${st.email || 'your Claude account'} · ${st.subscription ? `${st.subscription} plan` : st.authMethod} · Claude Code ${st.version}`;
      }
      actions.append(el('button', { class: 'btn', onclick: () => (refreshStatus(), emit('status-refresh')) }, '⟳ Refresh'));
      // Sign out opens Claude Code's own window: say what happens next, and keep it apart from Refresh.
      if (b.state === 'ready') actions.append(el('button', { class: 'btn danger', style: { marginLeft: '12px' }, onclick: () => api.claude.logout().then(() => toast('Finish signing out in the window that opened, then click Refresh.', 'info', 8000), (e) => toastError(plainError(e))) }, 'Sign out'));
    };
    refreshStatus();
    body.push(
      line,
      actions,
      usageToggle(),
      el(
        'div',
        { class: 'grid2' },
        select('claudeCode.model', 'Model', [['default', 'Account default'], ['opus', 'Opus (latest)'], ['sonnet', 'Sonnet (latest)'], ['haiku', 'Haiku (fastest)'], ['fable', 'Fable (most capable)']]),
        select('claudeCode.effort', 'Effort', [['default', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]),
      ),
      text('claudeCode.cliPath', 'Path to the claude executable', { path: true, placeholder: 'auto-detect', hint: 'Uses your Claude subscription through Claude Code — no API key. Claude Code’s own web search and file tools are available to the agent; usage counts toward your plan’s limits.' }),
      el('div', { class: 'grid2' }, text('claudeCode.fastModel', 'Fast model', { placeholder: 'haiku' }), text('claudeCode.deepModel', 'Deep model', { placeholder: 'opus' })),
      text('claudeCode.normalModel', 'Model for everyday messages', { placeholder: 'same as Model', hint: 'Quick lookups use the fast model, explanations and plans the deep one, everything else this one. Sonnet starts a reply that uses tools in a few seconds; Opus often takes 15. Empty = the model above.' }),
      el('div', { class: 'grid2' }, toggle('claudeCode.warmOnLaunch', 'Keep a warm session (faster replies)'), text('claudeCode.idleMinutes', 'Close idle session after (min)', { type: 'number' })),
      toggle('claudeCode.warmCache', 'Get the first reply ready ahead of time'),
      el('div', { class: 'hint' }, 'After launch, when you open a chat and after a persona switch, one tiny hidden message gets the conversation ready, so your first message is answered a few seconds sooner. Each counts toward your plan like a very short message.'),
      toggle('claudeCode.keepModelWarm', 'Stay on the warm model instead of switching to a faster one'),
      el('div', { class: 'hint' }, 'Each model keeps its own copy of the conversation ready. Switching to the fast model for a quick message makes it read the whole conversation from scratch, which is slower than letting the model that is already warm answer. Routines never change the chat’s model.'),
      toggle('claudeCode.toolsOnRequest', 'Load less-used tools only when a message needs them'),
      el('div', { class: 'hint' }, 'The everyday tools (calendar, memory, notes, web search…) go with every message; the rest (PDFs, GitHub, the agent window…) are looked up when needed. Every message is about 25,000 tokens lighter: quicker to start, less of your plan.'),
      connectorsSection(),
    );
  } else if (provider === 'openai') {
    const modelSel = el('select', { class: 'input' });
    fillSelect(modelSel, [['', '(server default / first available)']], state.settings.llm.model);
    modelSel.addEventListener('change', () => save('llm.model', modelSel.value));
    // Why the models didn't load, in words, with a Start button when it's FreeLLMAPI that isn't running.
    const modelNote = el('div', { class: 'hint hidden', role: 'status' });
    const loadModels = async (quiet) => {
      try {
        const models = await api.llm.models();
        fillSelect(modelSel, [['', '(server default / first available)'], ...models.map((m) => [m.id, m.name])], state.settings.llm.model);
        modelNote.classList.add('hidden');
        if (!quiet) toast(`${models.length} models loaded`);
      } catch (err) {
        const msg = String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        const startable = /FreeLLMAPI isn't running/.test(msg) && !/Starting it now/.test(msg);
        const start = el('button', { class: 'btn small', onclick: async () => {
          start.disabled = true;
          start.textContent = 'Starting…';
          try {
            await api.helperApps.start('freellmapi');
            await loadModels(false);
          } catch (e) {
            toastError(e);
            start.disabled = false;
            start.textContent = '▶ Start FreeLLMAPI';
          }
        } }, '▶ Start FreeLLMAPI');
        modelNote.replaceChildren(el('span', {}, `✕ ${msg} `), startable ? start : '');
        modelNote.classList.remove('hidden');
        if (!quiet && !startable) toastError(new Error(msg));
      }
    };
    loadModels(true);
    body.push(
      localFinder('llm', () => (render(), loadModels(true))),
      text('llm.baseUrl', 'FreeLLMAPI base URL', { placeholder: 'http://localhost:3001/v1', hint: 'OpenAI-compatible endpoint. Uses <code>/chat/completions</code> (streaming) and <code>/models</code>.' }),
      text('llm.apiKey', 'Bearer token', { type: 'password', placeholder: 'optional' }),
      field('Model', el('div', { class: 'row' }, modelSel, el('button', { class: 'btn', onclick: () => loadModels(false) }, '⟳ Load models'))),
      modelNote,
      el('div', { class: 'grid2' }, text('llm.temperature', 'Temperature', { type: 'number', decimal: true }), text('llm.maxTokens', 'Max output tokens', { type: 'number' })),
      text('llm.historyLimit', 'Messages of history sent per request', { type: 'number', hint: 'Keeps prompts within the context window of free models.' }),
      toggle('llm.compaction', 'Summarize older messages instead of dropping them'),
      el('div', { class: 'grid2' }, text('llm.fastModel', 'Fast model', { placeholder: 'same as above' }), text('llm.deepModel', 'Deep model', { placeholder: 'same as above' })),
      compactSelect(),
      handOverToggle(),
    );
  } else if (ownEndpoint(provider)) {
    // One brain of the multi-provider list on its own (switched in the chat: "switch to a local model").
    body.push(
      el('div', { class: 'test-result ok' }, `${brainName(provider)} answers on its own (switched in the chat). Pick another mode above, or say “switch to the Claude brain”.`),
      ...(provider === 'local' ? [localFinder('local', () => (render(), emit('status-refresh')))] : []),
      text(`${provider}.model`, 'Model', { hint: provider === 'local' ? '' : 'Its API key is under Multi-provider.' }),
    );
  } else {
    body.push(
      text('anthropic.apiKey', 'Anthropic API key', { type: 'password', placeholder: 'sk-ant-…', hint: 'Stored encrypted with your OS keychain.' }),
      el(
        'div',
        { class: 'grid2' },
        select('anthropic.model', 'Model', CLAUDE_MODELS),
        select('anthropic.effort', 'Effort', [['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']], { hint: 'Higher effort = deeper thinking, slower & pricier.' }),
      ),
      toggle('anthropic.fallbacks', 'Server-side fallback when a request is declined by safety classifiers'),
      el('div', { class: 'grid2' }, select('anthropic.fastModel', 'Fast model', CLAUDE_MODELS), select('anthropic.deepModel', 'Deep model', CLAUDE_MODELS)),
      select('anthropic.normalModel', 'Model for everyday messages', [['', 'Same as Model'], ...CLAUDE_MODELS], { hint: 'Quick lookups use the fast model, explanations and plans the deep one, everything else this one.' }),
    );
  }
  body.push(
    el(
      'div',
      { class: 'grid2' },
      select('llm.modelMode', 'Model mode', [['default', 'Default'], ['fast', 'Fast'], ['deep', 'Deep']], { hint: 'Also by voice: “switch to the fast / deep model”.' }),
      el('div', { style: { alignSelf: 'center' } }, toggle('llm.voiceUsesFast', 'Use the fast model for spoken turns')),
    ),
    toggle('llm.autoPace', 'Match thinking to the message: quick lookups (“what’s on tomorrow?”) get the fast model, explanations get more thought'),
    el('div', { class: 'hint' }, 'Decided on this computer in an instant, per message, with no restart. Only in model mode Default.'),
    toggle('llm.useTools', 'Enable tools (memory, calendar, notes, code, documents)'),
    text('llm.maxToolRounds', 'Max tool rounds per reply', { type: 'number' }),
    el('div', { class: 'row' }, test),
    out,
  );
  return card('brain', 'AI brain', 'Pick the model provider: several at once with automatic fallback (Multi-provider), your Claude account (via Claude Code), a local FreeLLMAPI server, or an Anthropic API key.', seg, ...body);
}

// ------------------------------------------------------- multi-provider
// The ranked provider list: drag (or ▲▼) to set the fallback order, switch providers on and off,
// expand one to add its key and pick its model.
// Each provider's line under it is its row's `blurb` in the brain table.
let refreshRouting = null;

// A local brain passes what it can't do well to Claude (main/llm.js runSingle). Off by default: it sends
// those messages off this computer.
const handOverToggle = () =>
  el(
    'div',
    {},
    toggle('llm.handOver', 'Hand hard messages to Claude'),
    el('div', { class: 'hint' }, 'A local model answers what it can; messages that need code, a connected service, several steps or careful reasoning go to your Claude account (or Claude API key) instead, and the chat says so. Those messages, with the conversation so far, then leave this computer. It never hands over after it already changed something in that turn.'),
  );

// Small local models: a short prompt and the everyday tools (main/localcore.js compactWanted).
const compactSelect = () =>
  select('llm.compactPrompt', 'Prompt for local models', [['auto', 'Automatic (compact for every local model)'], ['on', 'Always compact'], ['off', 'Always the full prompt']], {
    hint: 'A local model re-reads the whole prompt with every message. The compact one (the everyday tools, a few hundred words) answers in a second or two; the full one has every tool and is slow on most computers, and can overflow a local model’s memory. Quick and normal messages are answered without hidden thinking; deep questions may think.',
  });

// Connect Claude account (Settings, the setup wizard): opens Claude Code's sign-in window and says what to do
// next. recheck: the label of the button that checks again there.
export function connectClaude(recheck = 'Refresh') {
  return api.claude.login().then(() => toast(`Finish signing in in the terminal/browser window, then click ${recheck}.`, 'info', 8000), (e) => toastError(plainError(e)));
}

// A connection test's outcome (Settings, the setup wizard): one line per provider in multi-provider mode, a
// failure in plain words with the provider's own text under Details (chatcore.testFailure).
export function testOutcome(r) {
  if (!r.providers) return { ok: true, text: `✓ Connected in ${r.ms} ms · model: ${r.model}${r.models ? ` · ${r.models} models available` : ''}\nReply: “${r.reply}”`, raw: '' };
  const failed = new Map(r.providers.filter((p) => !p.ok).map((p) => [p, testFailure(String(p.error || ''), { label: p.name, settings: state.settings })]));
  return {
    ok: r.providers.some((p) => p.ok),
    text: r.providers.map((p) => (p.ok ? `✓ ${p.name} · ${p.model} · ${p.ms} ms` : failed.get(p).line)).join('\n'),
    raw: [...failed.values()].map((f) => f.raw).filter(Boolean).join('\n\n'),
  };
}

// Finds Ollama and LM Studio on this computer and the models they have; picking one fills in the
// server address and the model of `section` (llm, or local in multi-provider mode).
export function localFinder(section, after) {
  const out = el('div', { class: 'local-found' });
  const find = async () => {
    out.replaceChildren(el('div', { class: 'hint' }, 'Looking on this computer…'));
    const servers = await api.llm.localModels().catch((err) => (toastError(err), []));
    const up = servers.filter((s) => s.running);
    const hw = state.settings.perf?.hw || {};
    const ideas = await api.llm.localSuggest({ vramGb: hw.vramGB || 0, ramGb: hw.ramGB || 0 }).catch(() => []);
    const pick = async (s, m) => {
      await save(`${section}.baseUrl`, s.baseUrl);
      await save(`${section}.model`, m.id);
      toast(`Using ${m.name} through ${s.name}`);
      after?.();
    };
    out.replaceChildren(
      ...(up.length
        ? up.map((s) =>
            el('div', { class: 'tree-sec' }, el('b', {}, `${s.name} · ${s.baseUrl}`), ...(s.models.length ? s.models.map((m) => el('button', { class: `chip ${state.settings[section]?.model === m.id ? 'on' : ''}`, 'aria-pressed': String(state.settings[section]?.model === m.id), onclick: () => pick(s, m) }, `${m.name}${m.params ? ` · ${m.params}B` : ''}${m.small ? ' · fast' : ''}`)) : [el('div', { class: 'hint' }, 'Running, but no models yet.')])),
          )
        : [el('div', { class: 'hint' }, 'Neither Ollama nor LM Studio is running on this computer. Install one (ollama.com or lmstudio.ai), start it, and look again.')]),
      ideas.length ? el('div', { class: 'hint' }, `Good small models for this computer: ${ideas.map((i) => `${i.model} (${i.why})`).join(' · ')}${up.some((s) => s.id === 'ollama') ? ' Get one with “ollama pull <name>” in a terminal.' : ''}`) : '',
    );
  };
  return el('div', {}, el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: find }, '🔍 Find local models (Ollama / LM Studio)')), out);
}

function routingSection() {
  const list = el('div', { class: 'prov-list' });
  const opened = new Set();
  const draw = async () => {
    const rows = await api.llm.routerStatus().catch(() => []);
    list.innerHTML = '';
    rows.forEach((p, i) => list.append(providerRow(p, i, rows, opened, draw)));
  };
  refreshRouting = draw;
  draw();
  return [
    el('div', { class: 'hint' }, 'Each message goes to the first provider that is ready. When one hits a rate limit, a usage cap or runs out of credits, the next one answers and the limited one is skipped for a while. Drag to reorder; click a provider to set it up.'),
    list,
    el('div', { class: 'grid2' }, el('div', { style: { alignSelf: 'center' } }, toggle('routing.smart', 'Pick the best provider for each task')), text('routing.cooldownMin', 'Skip a limited provider for (minutes)', { type: 'number' })),
    el('div', { class: 'hint' }, 'Smart routing: code → Claude or DeepSeek, web questions → Perplexity, quick spoken replies → a local model or Groq, very long inputs → Gemini, deep mode → Claude. Only providers you switched on are used; the rest of your order is the fallback.'),
  ];
}

function providerRow(p, index, rows, opened, redraw) {
  const order = rows.map((r) => r.id);
  const move = async (to) => {
    const next = order.filter((id) => id !== p.id);
    next.splice(Math.max(0, Math.min(next.length, to)), 0, p.id);
    await save('routing.order', next);
    redraw();
  };
  const enabled = el('input', { type: 'checkbox', 'aria-label': `Use ${p.name}` });
  enabled.checked = p.enabled;
  enabled.addEventListener('click', (e) => e.stopPropagation());
  enabled.addEventListener('change', async () => {
    const off = new Set(state.settings.routing.disabled || []);
    enabled.checked ? off.delete(p.id) : off.add(p.id);
    await save('routing.disabled', [...off]);
    redraw();
  });
  const status = !p.configured
    ? el('span', { class: 'st warn' }, p.id === 'claude-code' ? 'Not connected' : 'Not set up: add a key')
    : p.resting
      ? el('span', { class: 'st warn' }, `Skipped for ${p.resting.minutes} min: ${p.resting.reason}`)
      : el('span', { class: 'st ok' }, p.enabled ? 'Ready' : 'Ready (switched off)');
  const stop = (fn) => (e) => (e.preventDefault(), e.stopPropagation(), fn());
  const summary = el(
    'summary',
    { draggable: 'true' },
    el('span', { class: 'grip', title: 'Drag to reorder' }, '⋮⋮'),
    el('span', { class: 'rank' }, String(index + 1)),
    el('span', { class: 'nm' }, el('span', {}, p.name), status),
    el(
      'span',
      { class: 'ctl' },
      p.resting ? el('button', { class: 'icon-btn', title: 'Try it again now', onclick: stop(async () => (await api.llm.routerReset(p.id), redraw())) }, '↺') : '',
      el('button', { class: 'icon-btn', title: 'Move up', disabled: index === 0, onclick: stop(() => move(index - 1)) }, '▲'),
      el('button', { class: 'icon-btn', title: 'Move down', disabled: index === rows.length - 1, onclick: stop(() => move(index + 1)) }, '▼'),
      el('label', { class: 'toggle', title: 'Use this provider', onclick: (e) => e.stopPropagation() }, enabled, el('span', { class: 'sw' })),
    ),
  );
  const row = el('details', { class: `prov ${p.enabled ? '' : 'off'}`, 'data-id': p.id, open: opened.has(p.id) }, summary, el('div', { class: 'prov-config' }, ...providerConfig(p)));
  row.addEventListener('toggle', () => (row.open ? opened.add(p.id) : opened.delete(p.id)));
  // Drag and drop
  summary.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', p.id);
    row.classList.add('dragging');
  });
  summary.addEventListener('dragend', () => row.classList.remove('dragging'));
  row.addEventListener('dragover', (e) => (e.preventDefault(), row.classList.add('over')));
  row.addEventListener('dragleave', () => row.classList.remove('over'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    row.classList.remove('over');
    const id = e.dataTransfer.getData('text/plain');
    if (!id || id === p.id) return;
    const next = order.filter((x) => x !== id);
    next.splice(next.indexOf(p.id), 0, id);
    await save('routing.order', next);
    redraw();
  });
  return row;
}

function providerConfig(p) {
  const hint = el('div', { class: 'hint' }, brain(p.id)?.blurb || '');
  const after = () => refreshRouting?.();
  if (p.id === 'claude-code') {
    return [
      hint,
      el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: async () => (await api.claude.login(), toast('Finish signing in in the terminal/browser window, then reopen this list.', 'info', 8000)) }, 'Connect Claude account')),
      el('div', { class: 'grid2' }, select('claudeCode.model', 'Model', [['default', 'Account default'], ['opus', 'Opus (latest)'], ['sonnet', 'Sonnet (latest)'], ['haiku', 'Haiku (fastest)'], ['fable', 'Fable (most capable)']]), text('claudeCode.fastModel', 'Fast model', { placeholder: 'haiku' })),
      connectorsSection(),
    ];
  }
  if (p.id === 'anthropic') {
    return [hint, text('anthropic.apiKey', 'Anthropic API key', { type: 'password', placeholder: 'sk-ant-…', onChange: debounceAfter(after) }), el('div', { class: 'grid2' }, select('anthropic.model', 'Model', CLAUDE_MODELS), select('anthropic.fastModel', 'Fast model', CLAUDE_MODELS))];
  }
  const section = p.id === 'openai' ? 'llm' : p.id;
  const modelSel = el('select', { class: 'input' });
  fillSelect(modelSel, [['', '(provider default)']], state.settings[section].model);
  modelSel.addEventListener('change', () => save(`${section}.model`, modelSel.value));
  const load = async () => {
    try {
      const models = await api.llm.models({ llm: { provider: p.id } });
      fillSelect(modelSel, [['', '(provider default)'], ...models.map((m) => [m.id, m.name])], state.settings[section].model);
      toast(`${models.length} models`);
    } catch (err) {
      toastError(err);
    }
  };
  return [
    hint,
    p.id === 'openai' ? text('llm.baseUrl', 'Server URL', { placeholder: 'http://localhost:3001/v1' }) : '',
    p.id === 'local' ? localFinder('local', after) : '',
    p.id === 'local' ? text('local.baseUrl', 'Server URL', { placeholder: 'http://localhost:11434/v1', hint: 'Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1', onChange: debounceAfter(after) }) : '',
    el('div', { class: 'row' }, el('div', { style: { flex: 1 } }, text(`${section}.apiKey`, p.id === 'openai' ? 'Bearer token (optional)' : 'API key', { type: 'password', onChange: debounceAfter(after) })), p.keyUrl ? el('button', { class: 'btn small', style: { alignSelf: 'flex-end' }, onclick: () => api.shell.openExternal(p.keyUrl) }, 'Get a key ↗') : ''),
    field('Model', el('div', { class: 'row' }, modelSel, el('button', { class: 'btn small', onclick: load }, '⟳ Load models'))),
    el('div', { class: 'grid2' }, text(`${section}.fastModel`, 'Fast model (voice)', { placeholder: 'same as above' }), text(`${section}.deepModel`, 'Deep model', { placeholder: 'same as above' })),
    p.id === 'local' ? compactSelect() : '',
  ];
}
