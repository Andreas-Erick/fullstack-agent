// Configuration dashboard. Every control auto-saves to settings.json (secrets are encrypted at rest).
import { $, api, el, toast, toastError, confirmDialog, debounce, on, emit } from './util.js';
import { state, saveSettings, loadSettings } from './state.js';
import { speaker, preloadLocalModel, listMics, handsFree } from './voice.js';
import { refreshList, newChat } from './chat.js';
import { FONTS, PATTERNS, CORE_SHAPES, TRACE_STYLES, normalizeTheme, extractPalette } from './theme.js';
import { switchView } from './nav.js';
import { previewThinkingSound, thinkingStyle } from './sounds.js';

const CLAUDE_MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5 (default)'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5'],
  ['claude-fable-5-1', 'Claude Fable 5.1'],
];
const WHISPER_MODELS = [
  ['onnx-community/whisper-large-v3-turbo', 'Whisper large-v3 turbo (~1.6 GB, recommended with a GPU: fastest and most accurate there)'],
  ['Xenova/whisper-tiny.en', 'Whisper tiny (English, ~40 MB)'],
  ['Xenova/whisper-base.en', 'Whisper base (English, ~80 MB, best without a GPU)'],
  ['Xenova/whisper-small.en', 'Whisper small (English, ~250 MB)'],
  ['Xenova/whisper-base', 'Whisper base (multilingual)'],
  ['Xenova/whisper-small', 'Whisper small (multilingual)'],
];

const get = (p) => p.split('.').reduce((o, k) => o?.[k], state.settings);
function patchFor(p, value) {
  const [section, key] = p.split('.');
  return { [section]: { [key]: value } };
}

let savedTimer;
async function save(p, value) {
  try {
    await saveSettings(patchFor(p, value));
    const s = $('#saveState');
    s.textContent = '✓ Saved';
    s.classList.add('show');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => s.classList.remove('show'), 1400);
  } catch (err) {
    toastError(err);
  }
}
const saveDebounced = {};
function queueSave(p, value) {
  saveDebounced[p] ||= debounce((v) => save(p, v), 400);
  saveDebounced[p](value);
}

// ---------------------------------------------------------- field builders
function text(p, label, { type = 'text', placeholder = '', hint = '', onChange } = {}) {
  const input = el('input', { class: 'input', type, value: get(p) ?? '', placeholder, spellcheck: 'false', step: type === 'number' ? 'any' : null });
  input.addEventListener('input', () => {
    const v = type === 'number' ? Number(input.value) : input.value;
    queueSave(p, v);
    onChange?.(v);
  });
  return field(label, input, hint);
}

function area(p, label, { rows = 6, hint = '' } = {}) {
  const t = el('textarea', { class: 'input', rows });
  t.value = get(p) ?? '';
  t.addEventListener('input', () => queueSave(p, t.value));
  return field(label, t, hint);
}

function toggle(p, label, onChange) {
  const input = el('input', { type: 'checkbox' });
  input.checked = Boolean(get(p));
  input.addEventListener('change', async () => {
    await save(p, input.checked);
    onChange?.(input.checked);
  });
  return el('label', { class: 'toggle' }, input, el('span', { class: 'sw' }), el('span', {}, label));
}

function select(p, label, options, { hint = '', onChange } = {}) {
  const s = el('select', { class: 'input' });
  fillSelect(s, options, get(p));
  s.addEventListener('change', async () => {
    await save(p, s.value);
    onChange?.(s.value);
  });
  return field(label, s, hint);
}

function fillSelect(s, options, value) {
  s.innerHTML = '';
  const list = options.map((o) => (Array.isArray(o) ? o : [o, o]));
  if (value && !list.some(([v]) => v === value)) list.unshift([value, value]);
  for (const [v, l] of list) s.append(el('option', { value: v, selected: v === value }, l));
}

function field(label, control, hint) {
  return el('div', { class: 'field' }, el('label', {}, label), control, hint ? el('div', { class: 'hint', html: hint }) : '');
}

function folder(p, label, { hint = '', placeholder = '', onChange } = {}) {
  const input = el('input', { class: 'input', value: get(p) || '', placeholder, spellcheck: 'false' });
  input.addEventListener('change', async () => {
    await save(p, input.value.trim());
    onChange?.();
  });
  const browse = el('button', {
    class: 'btn',
    onclick: async () => {
      const dir = await api.dialog.pickFolder(label);
      if (dir) {
        input.value = dir;
        await save(p, dir);
        onChange?.();
      }
    },
  }, 'Browse…');
  return field(label, el('div', { class: 'row' }, input, browse), hint);
}

function card(id, title, desc, ...children) {
  return el('section', { class: 'card glass', id: `set-${id}` }, el('h3', {}, el('span', { class: 'dot' }), title), desc ? el('p', { class: 'desc', html: desc }) : '', ...children);
}

function result() {
  return el('div', { class: 'test-result hidden' });
}
function showResult(box, ok, msg) {
  box.classList.remove('hidden', 'ok', 'err');
  box.classList.add(ok ? 'ok' : 'err');
  box.textContent = msg;
}

// ------------------------------------------------------------------- render
let sttProgressEl = null;

export function initSettings() {
  on('stt-progress', (p) => {
    if (!sttProgressEl) return;
    if (p.status === 'progress' && p.file) sttProgressEl.textContent = `Downloading ${p.file.split('/').pop()} — ${Math.round(p.progress || 0)}%`;
    else if (p.status === 'ready') sttProgressEl.textContent = '✓ Speech model loaded and ready.';
    else if (p.status === 'error') sttProgressEl.textContent = `✕ ${p.error}`;
  });
  on('view', ({ name, section }) => {
    if (name !== 'settings') return;
    render();
    if (section) setTimeout(() => $(`#set-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  });
}

async function render() {
  const root = $('#settingsRoot');
  const scroll = root.parentElement.scrollTop;
  root.innerHTML = '';
  root.append(agentCard(), brainCard(), voiceCard(), sttCard(), safetyCard(), await obsidianCard(), webCard(), await selfCard(), await healthCard(), await calendarCard(), await githubCard(), await docsCard(), await dataCard(), uiCard());
  root.parentElement.scrollTop = scroll;
}

// Persona Studio: master prompt + image + aesthetic → the agent's behaviour, look & feel and voice.
function agentCard() {
  const preview = el('div', { class: 'avatar-preview' });
  const setPreview = () => (preview.style.backgroundImage = state.settings.agent.avatar ? `url(${state.settings.agent.avatar})` : '');
  setPreview();
  const pick = el('button', {
    class: 'btn',
    onclick: async () => {
      const dataUrl = await api.dialog.pickImage();
      if (!dataUrl) return;
      await save('agent.avatar', await shrinkImage(dataUrl, 384));
      setPreview();
    },
  }, 'Choose image…');
  const clear = el('button', { class: 'btn', onclick: async () => (await save('agent.avatar', null), setPreview()) }, 'Remove');

  const out = result();
  const gen = el('button', {
    class: 'btn primary',
    onclick: async () => {
      gen.disabled = true;
      showResult(out, true, `Designing ${state.settings.agent.name}'s look & feel… (this can take a minute)`);
      try {
        const [palette, voices] = await Promise.all([extractPalette(state.settings.agent.avatar), api.tts.voices().catch(() => [])]);
        const res = await api.persona.generate({
          masterPrompt: state.settings.agent.personality,
          aesthetic: state.settings.agent.aesthetic,
          palette,
          image: state.settings.agent.avatar,
          voices: voices.map((v) => v.id),
          options: { fonts: Object.keys(FONTS), patterns: PATTERNS, cores: CORE_SHAPES, traces: TRACE_STYLES },
        });
        const theme = normalizeTheme(res.theme);
        await saveSettings({ appearance: { theme, personaNotes: res.personaNotes, greeting: res.greeting } });
        if (res.voice && state.settings.appearance.applyVoice) await saveSettings({ voice: { voice: res.voice } });
        showResult(out, true, `✓ Applied “${theme.name}”${res.voice && state.settings.appearance.applyVoice ? ` · voice: ${res.voice}` : ''}. Fine-tune it below.`);
        setTimeout(render, 900);
      } catch (err) {
        showResult(out, false, `✕ ${err.message}`);
      } finally {
        gen.disabled = false;
      }
    },
  }, '✨ Generate look & feel from persona');

  return card(
    'agent',
    'Persona studio',
    'Define who the agent is. The master prompt drives its behaviour; the image and aesthetic shape how it looks, sounds and writes. Click Generate and the whole app — colors, fonts, background, face, greeting and voice — is redesigned to match.',
    el('div', { class: 'row', style: { gap: '14px' } }, preview, el('div', { style: { flex: 1 } }, text('agent.name', 'Agent name', { placeholder: 'Nexus' })), pick, clear),
    area('agent.personality', 'Master prompt (persona)', { rows: 9, hint: 'Who the agent is, how it behaves, what it cares about. Memories, vault, calendar and tool instructions are appended automatically.' }),
    area('agent.aesthetic', 'Aesthetic · style · theme', { rows: 3, hint: 'e.g. “90s cyberpunk terminal, green phosphor”, “warm solarpunk greenhouse, botanical”, “minimal Scandinavian, calm and airy”, “art-deco luxury, gold on black”.' }),
    toggle('appearance.applyVoice', 'Let the persona pick a matching VoiceStudio voice'),
    el('div', { class: 'row' }, gen),
    out,
    themeEditor(),
  );
}

// Live fine-tuning of the active theme (colors, fonts, background, face).
function themeEditor() {
  const theme = normalizeTheme(state.settings.appearance?.theme);
  const isDefault = !state.settings.appearance?.theme;
  const update = async (mutate) => {
    const t = normalizeTheme(state.settings.appearance?.theme);
    mutate(t);
    await saveSettings({ appearance: { theme: t } });
  };
  const swatches = el('div', { class: 'swatches' });
  for (const [key, label] of [['bg', 'Background'], ['surface', 'Cards'], ['text', 'Text'], ['accent', 'Accent'], ['accent2', 'Accent 2'], ['accent3', 'Accent 3'], ['success', 'Listening / OK'], ['danger', 'Error']]) {
    const input = el('input', { type: 'color', value: theme.colors[key], title: label });
    input.addEventListener('change', () => update((t) => {
      t.colors[key] = input.value;
      t.face.states = null; // re-derive face colors from the palette
    }));
    swatches.append(el('label', { class: 'swatch', title: label, style: { background: theme.colors[key] } }, input));
  }
  const sel = (label, options, value, apply) => {
    const s = el('select', { class: 'input' });
    fillSelect(s, options, value);
    s.addEventListener('change', () => update((t) => apply(t, s.value)));
    return field(label, s);
  };
  const notes = el('textarea', { class: 'input', rows: 3 });
  notes.value = state.settings.appearance?.personaNotes || '';
  notes.addEventListener('input', () => queueSave('appearance.personaNotes', notes.value));
  return el(
    'div',
    { class: 'field' },
    el('div', { class: 'theme-preview' }, el('div', { class: 'meta' }, el('b', {}, theme.name), el('div', {}, `${theme.fonts.display} / ${theme.fonts.body} · ${theme.background.pattern} background · ${theme.face.core} core, ${theme.face.traces} traces`)), swatches),
    el(
      'div',
      { class: 'grid2' },
      sel('Display font', Object.keys(FONTS), theme.fonts.display, (t, v) => (t.fonts.display = v)),
      sel('Body font', Object.keys(FONTS), theme.fonts.body, (t, v) => (t.fonts.body = v)),
      sel('Background pattern', PATTERNS, theme.background.pattern, (t, v) => (t.background.pattern = v)),
      sel('Face core', CORE_SHAPES, theme.face.core, (t, v) => (t.face.core = v)),
      sel('Face traces', TRACE_STYLES, theme.face.traces, (t, v) => (t.face.traces = v)),
      sel('Headings', [['true', 'UPPERCASE'], ['false', 'Normal case']], String(theme.uppercaseDisplay), (t, v) => (t.uppercaseDisplay = v === 'true')),
    ),
    field('Voice & tone notes (from the aesthetic)', notes, 'Added to the system prompt so the agent writes in the matching style.'),
    text('appearance.greeting', 'Welcome greeting'),
    isDefault ? '' : el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => (await saveSettings({ appearance: { theme: null } }), render()) }, '↺ Reset to the default theme')),
  );
}

export function shrinkImage(dataUrl, size) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const g = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      g.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function brainCard() {
  const provider = state.settings.llm.provider;
  const seg = el(
    'div',
    { class: 'seg' },
    [['claude-code', 'Claude account'], ['openai', 'FreeLLMAPI'], ['anthropic', 'Claude API key']].map(([v, l]) =>
      el('button', { class: provider === v ? 'active' : '', onclick: async () => (await save('llm.provider', v), render(), emit('status-refresh')) }, l),
    ),
  );
  const out = result();
  const test = el('button', {
    class: 'btn primary',
    onclick: async () => {
      showResult(out, true, 'Testing…');
      try {
        const r = await api.llm.test();
        showResult(out, true, `✓ Connected in ${r.ms} ms · model: ${r.model}${r.models ? ` · ${r.models} models available` : ''}\nReply: “${r.reply}”`);
        emit('status-refresh');
      } catch (err) {
        showResult(out, false, `✕ ${err.message}`);
      }
    },
  }, '⚡ Test connection');

  const body = [];
  if (provider === 'claude-code') {
    const line = el('div', { class: 'test-result' }, 'Checking Claude Code…');
    const actions = el('div', { class: 'row', style: { flexWrap: 'wrap' } });
    const refreshStatus = async () => {
      line.className = 'test-result';
      line.textContent = 'Checking Claude Code…';
      actions.innerHTML = '';
      const st = await api.claude.status().catch((e) => ({ installed: false, error: e.message }));
      if (!st.installed) {
        const hint = await api.claude.installHint();
        line.className = 'test-result err';
        line.textContent = `✕ Claude Code is not installed (or not found on PATH).\nInstall it with:\n  ${hint}\nthen click Refresh — or set the path to the claude executable below.`;
      } else if (!st.loggedIn) {
        line.className = 'test-result err';
        line.textContent = `Claude Code ${st.version} found, but no Claude account is connected.`;
        actions.append(el('button', { class: 'btn primary', onclick: async () => (await api.claude.login(), toast('Finish signing in in the terminal/browser window, then click Refresh.', 'info', 8000)) }, 'Connect Claude account'));
      } else {
        line.className = 'test-result ok';
        line.textContent = `✓ Connected as ${st.email || 'your Claude account'} · ${st.subscription ? `${st.subscription} plan` : st.authMethod} · Claude Code ${st.version}`;
        actions.append(el('button', { class: 'btn', onclick: () => api.claude.logout() }, 'Sign out'));
      }
      actions.append(el('button', { class: 'btn', onclick: () => (refreshStatus(), emit('status-refresh')) }, '⟳ Refresh'));
    };
    refreshStatus();
    body.push(
      line,
      actions,
      el(
        'div',
        { class: 'grid2' },
        select('claudeCode.model', 'Model', [['default', 'Account default'], ['opus', 'Opus (latest)'], ['sonnet', 'Sonnet (latest)'], ['haiku', 'Haiku (fastest)'], ['fable', 'Fable (most capable)']]),
        select('claudeCode.effort', 'Effort', [['default', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]),
      ),
      text('claudeCode.cliPath', 'Path to the claude executable', { placeholder: 'auto-detect', hint: 'Uses your Claude subscription through Claude Code — no API key. Claude Code’s own web search and file tools are available to the agent; usage counts toward your plan’s limits.' }),
      el('div', { class: 'grid2' }, text('claudeCode.fastModel', 'Fast model', { placeholder: 'haiku' }), text('claudeCode.deepModel', 'Deep model', { placeholder: 'opus' })),
      el('div', { class: 'grid2' }, toggle('claudeCode.warmOnLaunch', 'Keep a warm session (faster replies)'), text('claudeCode.idleMinutes', 'Close idle session after (min)', { type: 'number' })),
    );
  } else if (provider === 'openai') {
    const modelSel = el('select', { class: 'input' });
    fillSelect(modelSel, [['', '(server default / first available)']], state.settings.llm.model);
    modelSel.addEventListener('change', () => save('llm.model', modelSel.value));
    const loadModels = async (quiet) => {
      try {
        const models = await api.llm.models();
        fillSelect(modelSel, [['', '(server default / first available)'], ...models.map((m) => [m.id, m.name])], state.settings.llm.model);
        if (!quiet) toast(`${models.length} models loaded`);
      } catch (err) {
        if (!quiet) toastError(err);
      }
    };
    loadModels(true);
    body.push(
      text('llm.baseUrl', 'FreeLLMAPI base URL', { placeholder: 'http://localhost:3001/v1', hint: 'OpenAI-compatible endpoint. Uses <code>/chat/completions</code> (streaming) and <code>/models</code>.' }),
      text('llm.apiKey', 'Bearer token', { type: 'password', placeholder: 'optional' }),
      field('Model', el('div', { class: 'row' }, modelSel, el('button', { class: 'btn', onclick: () => loadModels(false) }, '⟳ Load models'))),
      el('div', { class: 'grid2' }, text('llm.temperature', 'Temperature', { type: 'number' }), text('llm.maxTokens', 'Max output tokens', { type: 'number' })),
      text('llm.historyLimit', 'Messages of history sent per request', { type: 'number', hint: 'Keeps prompts within the context window of free models.' }),
      toggle('llm.compaction', 'Summarize older messages instead of dropping them'),
      el('div', { class: 'grid2' }, text('llm.fastModel', 'Fast model', { placeholder: 'same as above' }), text('llm.deepModel', 'Deep model', { placeholder: 'same as above' })),
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
    );
  }
  body.push(
    el(
      'div',
      { class: 'grid2' },
      select('llm.modelMode', 'Model mode', [['default', 'Default'], ['fast', 'Fast'], ['deep', 'Deep']], { hint: 'Also by voice: “switch to the fast / deep model”.' }),
      el('div', { style: { alignSelf: 'center' } }, toggle('llm.voiceUsesFast', 'Use the fast model for spoken turns')),
    ),
    toggle('llm.useTools', 'Enable tools (memory, calendar, notes, code, documents)'),
    text('llm.maxToolRounds', 'Max tool rounds per reply', { type: 'number' }),
    el('div', { class: 'row' }, test),
    out,
  );
  return card('brain', 'AI brain', 'Pick the model provider: your Claude account (via Claude Code, like the original fullstack-agent), a local FreeLLMAPI server, or an Anthropic API key.', seg, ...body);
}

function voiceCard() {
  const voiceSel = el('select', { class: 'input' });
  fillSelect(voiceSel, [['', '(server default)']], state.settings.voice.voice);
  voiceSel.addEventListener('change', () => save('voice.voice', voiceSel.value));
  const loadVoices = async (quiet) => {
    try {
      const list = await api.tts.voices();
      fillSelect(voiceSel, [['', '(server default)'], ...list.map((v) => [v.id, v.name])], state.settings.voice.voice);
      if (!quiet) toast(list.length ? `${list.length} voices found` : 'No voice list endpoint found — type a voice id below.');
    } catch (err) {
      if (!quiet) toastError(err);
    }
  };
  loadVoices(true);
  const sample = el('input', { class: 'input', value: `Hello, I'm ${state.settings.agent.name}. All systems are online.` });
  const out = result();
  const test = el('button', {
    class: 'btn primary',
    onclick: async () => {
      showResult(out, true, 'Synthesizing…');
      try {
        const t0 = performance.now();
        await api.tts.speak('test');
        showResult(out, true, `✓ VoiceStudio responded in ${Math.round(performance.now() - t0)} ms — playing sample.`);
        speaker.say(sample.value);
        emit('status-refresh');
      } catch (err) {
        showResult(out, false, `✕ ${err.message}`);
      }
    },
  }, '🔊 Test voice');
  const speed = el('input', { type: 'range', min: '0.5', max: '2', step: '0.05', value: state.settings.voice.speed, style: { flex: 1 } });
  const speedLabel = el('span', { class: 'muted' }, `${Number(state.settings.voice.speed).toFixed(2)}×`);
  speed.addEventListener('input', () => {
    speedLabel.textContent = `${Number(speed.value).toFixed(2)}×`;
    queueSave('voice.speed', Number(speed.value));
  });
  return card(
    'voice',
    'Voice output · VoiceStudio',
    'Local OpenAI-compatible TTS (<code>/v1/audio/speech</code>). Replies are spoken sentence-by-sentence while they stream.',
    el('div', { class: 'grid2' }, toggle('voice.ttsEnabled', 'Enable voice', () => emit('status-refresh')), toggle('voice.autoSpeak', 'Speak replies automatically')),
    text('voice.baseUrl', 'VoiceStudio URL', { placeholder: 'http://localhost:3900' }),
    text('voice.apiKey', 'API key', { type: 'password', placeholder: 'optional' }),
    field('Voice', el('div', { class: 'row' }, voiceSel, el('button', { class: 'btn', onclick: () => loadVoices(false) }, '⟳ Load voices'))),
    el('div', { class: 'grid2' }, text('voice.voice', 'Voice id (manual)', { placeholder: 'e.g. af_heart', onChange: (v) => fillSelect(voiceSel, [['', '(server default)'], ...[...voiceSel.options].slice(1).map((o) => [o.value, o.textContent])], v) }), text('voice.model', 'TTS model', { placeholder: 'tts-1' })),
    el('div', { class: 'grid2' }, field('Speed', el('div', { class: 'row' }, speed, speedLabel)), select('voice.format', 'Audio format', ['mp3', 'wav', 'opus', 'flac'])),
    field('Sample text', sample),
    el('div', { class: 'grid2' }, toggle('voice.greetOnLaunch', 'Speak a greeting on launch'), toggle('voice.filler', 'Short spoken lines while tools run'), toggle('voice.fallbackSystemVoice', 'Fall back to the system voice')),
    el(
      'div',
      { class: 'grid2' },
      select('voice.thinkingSound', 'Sound while thinking', [['grandfather', 'Grandfather clock (slow, deep tick-tock)'], ['clock', 'Mechanical clock (lighter, faster)'], ['soft', 'Soft (low, slowly breathing)'], ['classic', 'Classic shimmer'], ['off', 'Off']], {
        hint: 'Starts only when a reply takes longer than 1.5 seconds.',
        onChange: (v) => previewThinkingSound(v, state.settings.voice.thinkingVolume ?? 0.5),
      }),
      field('Thinking sound volume', thinkingVolume()),
    ),
    el('div', { class: 'row' }, test, el('button', { class: 'btn', onclick: () => speaker.stop() }, '■ Stop')),
    out,
  );
}

function sttCard() {
  const engine = state.settings.stt.engine;
  const progress = el('div', { class: 'hint' });
  sttProgressEl = progress;
  const keyBtn = el('button', { class: 'btn' }, state.settings.stt.pttKey || 'F8');
  keyBtn.onclick = () => {
    keyBtn.textContent = 'Press a key…';
    const handler = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', handler, true);
      const code = e.code === 'Escape' ? state.settings.stt.pttKey : e.code;
      await save('stt.pttKey', code);
      keyBtn.textContent = code;
      emit('ptt-key', code);
    };
    window.addEventListener('keydown', handler, true);
  };
  const children = [
    el('div', { class: 'grid2' }, toggle('stt.enabled', 'Enable voice input'), toggle('stt.autoSend', 'Send automatically after speaking')),
    select('stt.engine', 'Speech-to-text engine', [['local', 'Local Whisper (in-app, offline after first download)'], ['remote', 'OpenAI-compatible /audio/transcriptions endpoint']], { onChange: () => render() }),
  ];
  if (engine === 'local') {
    children.push(
      select('stt.localModel', 'Whisper model', WHISPER_MODELS, { hint: 'Downloaded once from Hugging Face, then cached. Runs on GPU (WebGPU) when available.' }),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => (progress.textContent = 'Loading…', preloadLocalModel()) }, '⬇ Download / load model now')),
      progress,
    );
  } else {
    children.push(
      text('stt.remoteUrl', 'Transcription base URL', { placeholder: 'defaults to the FreeLLMAPI URL', hint: 'POSTs to <code>{url}/audio/transcriptions</code>.' }),
      el('div', { class: 'grid2' }, text('stt.remoteKey', 'API key', { type: 'password', placeholder: 'defaults to the FreeLLMAPI token' }), text('stt.remoteModel', 'Model', { placeholder: 'whisper-1' })),
    );
  }
  children.push(
    el('div', { class: 'grid2' }, text('stt.language', 'Language code', { placeholder: 'en' }), field('Push-to-talk key (hold)', keyBtn, 'Works anywhere in the app.')),
    text('stt.globalShortcut', 'Global toggle shortcut', { placeholder: 'CommandOrControl+Alt+Space', hint: 'Press once to start listening from anywhere (even when the app is in the background), again to stop.' }),
    select('stt.micMode', 'Microphone mode', [['ptt', 'Push to talk (mic closed between presses)'], ['open', 'Hands-free (always listening, voice detection)']], { hint: 'Also by voice: “go hands free” / “push to talk”.' }),
    micField(),
    el('div', { class: 'grid2' }, toggle('stt.headphones', 'I use headphones (lets me talk over the agent hands-free)'), field('Voice detection sensitivity', sensitivity())),
    el(
      'div',
      { class: 'grid2' },
      select('stt.vadEngine', 'Voice detector (hands-free)', [['neural', 'Neural (Silero) — ignores breathing and noise'], ['energy', 'Basic (loudness + voicing)']], {
        hint: 'The neural detector downloads a 2 MB model once; until it loads, or if it can’t, the basic one is used.',
        onChange: () => handsFree.running && handsFree.restart(),
      }),
      field('Pause that ends your turn', endSilence(), 'How long you can pause before it stops listening and answers.'),
    ),
    calibrationInfo(),
    el('div', { class: 'hint' }, 'Voice commands (spoken on their own): “go hands free”, “push to talk”, “switch to the fast/deep model”, “stop asking for permission”, “start asking again”, “clear the session”, “stop”, “mute” / “unmute”.'),
  );
  return card('stt', 'Voice input · speech-to-text', 'Hold the push-to-talk key or the mic button, speak, release.', ...children);
}

async function calendarCard() {
  const st = await api.calendar.status().catch(() => ({}));
  const access = st.canWrite ? ' · can add and change events' : ' · read-only';
  const statusLine = el('div', { class: `test-result ${st.signedIn ? 'ok' : ''}` }, st.signedIn ? `✓ Connected${st.email ? ` as ${st.email}` : ''}${access}` : st.configured ? 'Not signed in.' : 'Add your OAuth client to connect.');
  const signIn = (label) => el('button', {
    class: 'btn primary',
    onclick: async () => {
      statusLine.className = 'test-result';
      statusLine.textContent = 'Complete the sign-in in your browser…';
      try {
        await api.calendar.signIn();
        toast('Google Calendar connected');
        emit('status-refresh');
        render();
      } catch (err) {
        statusLine.className = 'test-result err';
        statusLine.textContent = `✕ ${err.message}`;
      }
    },
  }, label);
  const signOut = el('button', { class: 'btn', onclick: async () => (await api.calendar.signOut(), emit('status-refresh'), render()) }, 'Sign out');
  const reconnect = st.needsReconnect
    ? el('div', { class: 'test-result err' }, 'This sign-in only allows reading. Reconnect and allow calendar access in Google’s screen so the agent can add and change events.')
    : '';
  return card(
    'calendar',
    'Google Calendar',
    'Create an OAuth client of type <b>Desktop app</b> in Google Cloud Console (enable the Google Calendar API), then paste it here. Today’s and upcoming events are injected into the agent’s context. When changes are allowed, the agent can add, move and delete events; it asks first according to your permission mode, and always asks before anything that emails other people.',
    toggle('calendar.enabled', 'Enable calendar', () => emit('status-refresh')),
    text('calendar.clientId', 'OAuth Client ID', { placeholder: '…apps.googleusercontent.com' }),
    text('calendar.clientSecret', 'OAuth Client Secret', { type: 'password' }),
    el('div', { class: 'grid2' }, text('calendar.daysAhead', 'Days ahead in context', { type: 'number' }), el('div', { style: { alignSelf: 'end' } }, toggle('calendar.allCalendars', 'Include all my calendars'))),
    toggle('calendar.allowWrite', 'Let the agent add, change and delete events', () => render()),
    reconnect,
    el('div', { class: 'row' }, st.signedIn ? signOut : signIn('Sign in with Google'), st.needsReconnect ? signIn('Reconnect') : ''),
    statusLine,
  );
}

async function githubCard() {
  const st = await api.github.status().catch((e) => ({ connected: false, error: e.message }));
  const line = el('div', { class: `test-result ${st.connected ? 'ok' : 'err'}` }, st.connected ? `✓ Connected as ${st.login} (through the GitHub CLI)` : `✕ ${st.error || 'Not connected'}`);
  return card(
    'github',
    'GitHub',
    `Lets ${state.settings.agent.name} read your repositories, issues and pull requests, and work on them when you ask: it clones a repo into the folder below, changes it on a new branch and commits there (approved per your permission mode). <b>Pushing and opening a pull request always ask you first</b>, it never touches the default branch directly and never merges. Uses the GitHub CLI: install it and run <code>gh auth login</code> once.`,
    toggle('github.enabled', 'Enable GitHub', () => render()),
    folder('github.workspace', 'Repos folder', { placeholder: st.workspace || '~/NexusRepos', hint: 'Where repositories are cloned. Keep it out of OneDrive/Dropbox.' }),
    line,
  );
}

async function obsidianCard() {
  const [st, def, known] = await Promise.all([api.obsidian.status().catch(() => ({})), api.obsidian.defaultPath().catch(() => ''), api.obsidian.vaults().catch(() => [])]);
  const line = el('div', { class: `test-result ${st.ok ? 'ok' : 'err'}` }, st.ok ? `✓ ${st.count} notes in ${st.path}` : st.enabled === false ? 'Vault disabled.' : '✕ Vault folder unavailable');
  const after = () => (emit('status-refresh'), render());
  return card(
    'obsidian',
    `${state.settings.agent.name}'s Obsidian vault`,
    'The agent’s own second brain: a real Obsidian vault it reads <b>and writes</b> — research, notes, journal, its memories (Memory/) and a changelog of its self-changes. Open it in Obsidian any time.',
    toggle('obsidian.enabled', 'Enable the vault', after),
    folder('obsidian.vaultPath', 'Vault folder', { placeholder: def, hint: `Leave empty for the agent’s own vault (<code>${def}</code>). You can also point it at an existing vault.`, onChange: after }),
    adoptField(known, after),
    toggle('obsidian.gitHistory', 'Keep a version history of every note (undo any agent edit)'),
    el('div', { class: 'grid2' }, toggle('journal.enabled', 'Auto-journal: log each conversation to the daily note'), text('journal.idleMinutes', 'Journal after (minutes quiet)', { type: 'number' })),
    el(
      'div',
      { class: 'row', style: { flexWrap: 'wrap' } },
      el('button', { class: 'btn', onclick: () => api.obsidian.openInObsidian().catch(toastError) }, '◆ Open in Obsidian'),
      el('button', { class: 'btn', onclick: () => api.obsidian.openFolder() }, '📁 Open folder'),
      st.registered ? '' : el('button', { class: 'btn', onclick: async () => { try { await api.obsidian.register(); toast('Registered — the vault now appears in Obsidian’s vault list.'); render(); } catch (e) { toastError(e); } } }, 'Register in Obsidian'),
    ),
    line,
  );
}

// Adopt one of the vaults Obsidian already knows (structure is added; nothing is overwritten).
function adoptField(known, after) {
  if (!known.length) return '';
  const sel = el('select', { class: 'input' });
  fillSelect(sel, [['', '— use one of your Obsidian vaults —'], ...known.filter((v) => v.exists).map((v) => [v.path, `${v.name} (${v.path})`])], '');
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    if (!(await confirmDialog('Use this vault?', `The agent will use “${sel.value}” as its vault. It adds its structure (VAULT-INDEX, Profile, Active Priorities, Daily Notes, Jobs, Memory…) without overwriting anything.`, 'Use it', false))) return;
    await save('obsidian.vaultPath', sel.value);
    after();
  });
  return field('Or adopt an existing Obsidian vault', sel);
}

function webCard() {
  const p = state.settings.web.provider;
  const out = result();
  const extra = [];
  if (p === 'searxng') extra.push(text('web.searxngUrl', 'SearXNG URL', { placeholder: 'http://localhost:8080', hint: 'Self-hosted, free. JSON output must be enabled in its settings.yml.' }));
  if (p === 'brave') extra.push(text('web.braveKey', 'Brave Search API key', { type: 'password' }));
  if (p === 'tavily') extra.push(text('web.tavilyKey', 'Tavily API key', { type: 'password' }));
  return card(
    'web',
    'Internet',
    'Lets the agent search the web and read pages. With the Claude account provider, Claude Code’s built-in web search is used instead.',
    toggle('web.enabled', 'Allow internet access'),
    select('web.provider', 'Search provider', [['duckduckgo', 'DuckDuckGo (free, no key)'], ['searxng', 'SearXNG (self-hosted)'], ['brave', 'Brave Search API'], ['tavily', 'Tavily API']], { onChange: () => render() }),
    ...extra,
    el('div', { class: 'row' }, el('button', {
      class: 'btn primary',
      onclick: async () => {
        showResult(out, true, 'Searching…');
        try {
          const r = await api.web.search('latest news today');
          showResult(out, true, `✓ ${r.results.length} results via ${r.provider}\n${r.results.slice(0, 3).map((x) => `• ${x.title}`).join('\n')}`);
        } catch (err) {
          showResult(out, false, `✕ ${err.message}`);
        }
      },
    }, '🌐 Test search')),
    out,
  );
}

async function selfCard() {
  const [st, root] = await Promise.all([api.self.status().catch((e) => ({ available: false, reason: e.message })), api.code.root().catch(() => '')]);
  const line = el(
    'div',
    { class: `test-result ${st.available && st.isRepo ? 'ok' : st.available ? '' : 'err'}` },
    !st.available ? `✕ ${st.reason}` : st.isRepo ? `✓ Change history active (git) · current version ${st.head}${st.dirty?.length ? ` · ${st.dirty.length} uncommitted file(s)` : ''}` : 'History will start on the first change.',
  );
  return card(
    'code',
    'Self-improvement',
    'Ask the agent for new features and it implements them by editing its own source code. Every change is syntax-checked and recorded so you can review, revert or restore any version from the <b>Evolution</b> view.',
    toggle('code.enabled', 'Let the agent read its own source code'),
    toggle('code.allowSelfModify', 'Let the agent modify its own code (tracked & revertible)', () => render()),
    folder('code.rootPath', 'Code root', { placeholder: root, hint: `Leave empty for this app’s own source (<code>${root}</code>).` }),
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => switchView('evolution') }, '⑂ Open Evolution history')),
    line,
  );
}

async function docsCard() {
  const roots = await api.docs.roots().catch(() => []);
  const list = el('div', { class: 'field' });
  const custom = state.settings.documents.allowedRoots || [];
  const renderList = () => {
    list.innerHTML = '';
    list.append(el('label', {}, custom.length ? 'Allowed folders' : 'Allowed folders (defaults)'));
    for (const r of custom.length ? custom : roots) {
      list.append(
        el(
          'div',
          { class: 'row' },
          el('code', { style: { flex: 1, fontSize: '12px' } }, r),
          custom.length ? el('button', { class: 'btn small', onclick: async () => (await save('documents.allowedRoots', custom.filter((x) => x !== r)), render()) }, 'Remove') : '',
        ),
      );
    }
  };
  renderList();
  const add = el('button', {
    class: 'btn',
    onclick: async () => {
      const dir = await api.dialog.pickFolder('Allow the agent to open documents in…');
      if (dir) {
        await save('documents.allowedRoots', [...new Set([...(custom.length ? custom : roots), dir])]);
        render();
      }
    },
  }, '＋ Add folder');
  return card(
    'documents',
    'Documents',
    'Folders the agent may open and read documents from (files you open yourself are always allowed). The Obsidian vault is always included.',
    folder('documents.workspace', 'Agent workspace folder', {
      placeholder: 'e.g. the folder with your university or work files',
      hint: 'Where you keep the files you work on. When you ask for a file without saying where ("open the decision tree PDF"), the agent looks here first. It is always allowed.',
      onChange: () => render(),
    }),
    list,
    el('div', { class: 'row' }, add),
  );
}

async function dataCard() {
  const [mems, convs, info, memDir] = await Promise.all([api.memory.list().catch(() => []), api.conv.list().catch(() => []), api.app.info(), api.memory.dir().catch(() => '')]);
  const danger = (label, title, msg, fn) =>
    el('button', { class: 'btn danger', onclick: async () => (await confirmDialog(title, msg, label)) && (await fn(), render()) }, label);
  return card(
    'data',
    'Memory & history',
    `Data folder: <code>${info.dataDir}</code>`,
    folder('memory.vaultPath', 'Memory vault folder', { placeholder: memDir, hint: 'One Markdown file per memory — editable in any text editor or even inside your Obsidian vault.' }),
    el('div', { class: 'row' }, el('span', { class: 'muted', style: { flex: 1 } }, `${mems.length} memories · ${convs.length} conversations`)),
    el(
      'div',
      { class: 'row', style: { flexWrap: 'wrap' } },
      el('button', { class: 'btn', onclick: () => api.memory.openDir() }, 'Open vault folder'),
      el('button', { class: 'btn', onclick: async () => (await api.memory.export('md')) && toast('Memory exported') }, 'Export memory'),
      el('button', { class: 'btn', onclick: async () => (await api.conv.export()) && toast('History exported') }, 'Export history'),
    ),
    el(
      'div',
      { class: 'row', style: { flexWrap: 'wrap' } },
      danger('Clear history', 'Clear all conversations', 'Delete every conversation? This cannot be undone.', async () => (await api.conv.clear(), newChat(), refreshList())),
      danger('Clear memory', 'Clear memory vault', 'Delete every memory? This cannot be undone.', async () => (await api.memory.clear(), emit('memory-changed'))),
      danger('Reset settings', 'Reset settings', 'Restore all settings to defaults (memories and history are kept)?', async () => (await api.settings.reset(), await loadSettings())),
    ),
    el('div', { class: 'hint' }, `Nexus Agent v${info.version} · Electron ${info.electron} · ${info.platform}`),
  );
}

function micField() {
  const sel = el('select', { class: 'input' });
  fillSelect(sel, [['', 'System default']], state.settings.stt.micDevice);
  listMics().then((mics) => fillSelect(sel, [['', 'System default'], ...mics.map((m) => [m.label, m.label])], state.settings.stt.micDevice));
  sel.addEventListener('change', async () => {
    await save('stt.micDevice', sel.value);
    if (handsFree.running) handsFree.restart();
  });
  return field('Microphone', sel, 'Pinned by name; if it disappears the system default is used (and logged). Re-opened automatically when headsets connect or disconnect.');
}

function sensitivity() {
  const r = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: state.settings.stt.vadSensitivity, style: { width: '100%' } });
  r.addEventListener('input', () => queueSave('stt.vadSensitivity', Number(r.value)));
  return r;
}

// What voice calibration learned: misheard words it now fixes, and the words it listens for.
function calibrationInfo() {
  const stt = state.settings.stt;
  const fixes = stt.corrections || [];
  const words = stt.vocabulary || [];
  if (!stt.calibratedAt && !fixes.length && !words.length) {
    return el('div', { class: 'hint' }, `Voice calibration: not done yet. Ask ${state.settings.agent.name || 'the agent'} to “calibrate my voice” — you read a short script and it learns how your names and words come through.`);
  }
  const clear = el('button', {
    class: 'btn',
    onclick: async () => {
      await save('stt.corrections', []);
      await save('stt.vocabulary', []);
      render();
    },
  }, 'Forget what it learned');
  const info = field(
    `Voice calibration${stt.calibratedAt ? ` · ${new Date(stt.calibratedAt).toLocaleDateString()}` : ''}`,
    el(
      'div',
      { class: 'test-result' },
      fixes.length ? `Fixes: ${fixes.map((c) => `“${c.heard}” → ${c.meant}`).join(', ')}` : 'No misheard words to fix.',
      el('br'),
      words.length ? `Listens for: ${words.join(', ')}` : '',
    ),
    'Corrections apply to whole words in everything you say. Ask the agent to calibrate again any time.',
  );
  info.append(clear);
  return info;
}

function thinkingVolume() {
  const r = el('input', { type: 'range', min: '0.1', max: '1', step: '0.05', value: state.settings.voice.thinkingVolume ?? 0.5, style: { width: '100%' } });
  r.addEventListener('input', () => queueSave('voice.thinkingVolume', Number(r.value)));
  r.addEventListener('change', () => previewThinkingSound(thinkingStyle(state.settings.voice.thinkingSound), Number(r.value)));
  return r;
}

function endSilence() {
  const value = state.settings.stt.endSilenceMs ?? 600;
  const label = el('span', { class: 'muted' }, `${(value / 1000).toFixed(1)} s`);
  const r = el('input', { type: 'range', min: '300', max: '2000', step: '100', value, style: { width: '100%' } });
  r.addEventListener('input', () => {
    label.textContent = `${(Number(r.value) / 1000).toFixed(1)} s`;
    queueSave('stt.endSilenceMs', Number(r.value));
  });
  return el('div', {}, r, label);
}

function safetyCard() {
  return card(
    'safety',
    'Safety & permissions',
    'What the agent may do without asking. Approve requests by clicking or by saying a yes on its own — “yes”, “yeah”, “okay”, “go ahead” (anything else declines; no answer counts as no).',
    select('safety.permissionMode', 'Permission mode', [['ask', 'Ask me first — self-changes, settings changes, deletions (recommended)'], ['auto', 'Just do it — still asks before commands and after reading external content']], { hint: 'Also by voice: “stop asking for permission” / “start asking again”.' }),
    toggle('safety.taintGuard', 'Always ask before self-modification in a turn that read web pages or documents'),
    text('safety.approvalTimeoutSec', 'Approval timeout (seconds)', { type: 'number' }),
    el('div', { class: 'hint' }, 'External content (web pages, documents, tool results) is always treated as data — the agent is instructed never to follow instructions inside it.'),
  );
}

async function healthCard() {
  const list = el('div', { class: 'health-list' }, el('div', { class: 'muted' }, 'Run diagnostics to check every part of the agent.'));
  const logBox = el('pre', { class: 'log-view hidden' });
  const ICON = { ok: '✓', warn: '!', fail: '✕', off: '–' };
  const run = async () => {
    list.innerHTML = '<div class="muted">Checking…</div>';
    try {
      const results = await api.diag.run();
      list.innerHTML = '';
      for (const r of results) {
        list.append(el('div', { class: `health-item ${r.status}` }, el('span', { class: 'ic' }, ICON[r.status] || '?'), el('div', {}, el('b', {}, r.label), el('div', { class: 'd' }, r.detail), r.fix ? el('div', { class: 'f' }, `Fix: ${r.fix}`) : '')));
      }
    } catch (err) {
      list.innerHTML = '';
      list.append(el('div', { class: 'test-result err' }, err.message));
    }
  };
  return card(
    'health',
    'Health & the mechanic',
    'The agent is its own mechanic: it can run these checks, read its log and fix its configuration. Ask it “what’s wrong with your voice?” — or check here.',
    el('div', { class: 'row', style: { flexWrap: 'wrap' } },
      el('button', { class: 'btn primary', onclick: run }, '🩺 Run diagnostics'),
      el('button', { class: 'btn', onclick: async () => { logBox.classList.toggle('hidden'); logBox.textContent = await api.log.tail(300); logBox.scrollTop = logBox.scrollHeight; } }, '📜 Show log'),
      el('button', { class: 'btn', onclick: () => api.log.open() }, 'Open log folder'),
      el('button', {
        class: 'btn',
        title: 'One file with the environment, health checks, recent errors and log, and settings without secrets',
        onclick: async () => {
          try {
            const r = await api.log.report('');
            toast(`Bug report saved (${r.problemsLast24h} problems in the last 24 h).`);
          } catch (err) {
            toastError(err);
          }
        },
      }, '🐞 Create bug report'),
      el('button', { class: 'btn', onclick: async () => (await import('./setup.js')).startSetup() }, '✦ Set me up by conversation'),
      el('button', { class: 'btn', onclick: async () => (await import('./onboarding.js')).startOnboarding() }, 'Setup form'),
    ),
    toggle('logging.debug', 'Detailed logging (more lines, for hunting a bug; turn off afterwards)'),
    list,
    logBox,
  );
}

function uiCard() {
  return card(
    'ui',
    'Interface',
    '',
    toggle('ui.showVisualizerInChat', 'Show the face panel next to the chat', () => emit('layout')),
    toggle('ui.captions', 'Show captions on the full-screen face'),
    select('ui.face', 'Face', [['circuit', 'Circuit Board'], ['radial', 'Radial'], ['rain', 'Code Rain'], ['neural', 'Neural Core']], { hint: 'Custom faces (and a demo) are in the Face view.' }),
  );
}
