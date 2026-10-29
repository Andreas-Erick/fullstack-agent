// Configuration dashboard. Every control auto-saves to settings.json (secrets are encrypted at rest).
import { $, api, el, escapeHtml, toast, toastError, confirmDialog, debounce, on, emit, modal } from './util.js';
import { state, saveSettings, loadSettings } from './state.js';
import { speaker, preloadLocalModel, listMics, handsFree, testLocalVoice } from './voice.js';
import { KOKORO_VOICES } from './kokorotext.js';
import { refreshList, newChat } from './chat.js';
import { FONTS, PATTERNS, CORE_SHAPES, TRACE_STYLES, normalizeTheme, extractPalette } from './theme.js';
import { switchView } from './nav.js';
import { previewThinkingSound, thinkingStyle } from './sounds.js';
import { BUILT_IN } from './faces/host.js';
import { setZoom } from './layout.js';
import { scanInto } from './hwscan.js';
import { qrCanvas } from './qr.js';
import { switchPersona, createPersona, removePersona } from './personas.js';
import { LANGUAGE_NAMES } from './practice.js';
import { detect } from './perf.js';
import { profile } from './perfcore.js';
import { checkNow as checkUpdatesNow } from './updates.js';

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
let ttsProgressEl = null;

export function initSettings() {
  on('stt-progress', (p) => {
    if (!sttProgressEl) return;
    if (p.status === 'progress' && p.file) sttProgressEl.textContent = `Downloading ${p.file.split('/').pop()} — ${Math.round(p.progress || 0)}%`;
    else if (p.status === 'ready') sttProgressEl.textContent = '✓ Speech model loaded and ready.';
    else if (p.status === 'error') sttProgressEl.textContent = `✕ ${p.error}`;
  });
  on('tts-progress', (p) => {
    if (!ttsProgressEl) return;
    if (p.status === 'progress' && p.file) ttsProgressEl.textContent = `Downloading ${p.file.split('/').pop()} — ${Math.round(p.progress || 0)}%`;
    else if (p.status === 'ready') ttsProgressEl.textContent = `✓ Offline voice ready (${p.device}).`;
    else if (p.status === 'error') ttsProgressEl.textContent = `✕ ${p.message}`;
  });
  api.on('helperApps:event', (ev) => ev.type === 'status' && refreshHelperApps?.());
  api.on('extensions:progress', (p) => extensionProgress && (extensionProgress.textContent = `${p.step}${p.line ? `: ${p.line}` : ''}`));
  api.on('remote:event', (ev) => {
    if (ev.type === 'tunnel') return refreshRemoteStatus?.();
    if (ev.type === 'connected' || ev.type === 'disconnected') return refreshRemoteStatus?.();
    if (ev.type !== 'paired' && ev.type !== 'moved') return;
    toast(ev.type === 'moved' ? `${ev.name} now uses the secure address` : `Paired: ${ev.name}`);
    refreshRemote?.();
  });
  on('view', ({ name, section }) => {
    if (name !== 'settings') return;
    // Scroll once the cards exist (several of them load data first).
    render().then(() => section && $(`#set-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  });
}

async function render() {
  const root = $('#settingsRoot');
  const scroll = root.parentElement.scrollTop;
  root.innerHTML = '';
  root.append(agentCard(), brainCard(), extensionsCard(), voiceCard(), sttCard(), learningCard(), helperAppsCard(), safetyCard(), remoteCard(), await obsidianCard(), webCard(), await selfCard(), await healthCard(), await calendarCard(), await githubCard(), await docsCard(), await dataCard(), worldCard(), uiCard());
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
        const applied = `✓ Applied “${theme.name}”${res.voice && state.settings.appearance.applyVoice ? ` · voice: ${res.voice}` : ''}.`;
        showResult(out, true, `${applied} Drawing the scene behind the face…`);
        const scene = await drawScene().catch((err) => (showResult(out, true, `${applied} The scene couldn't be drawn (${err.message}); try ↻ Draw the scene below.`), null));
        if (scene) showResult(out, true, `${applied} Scene: ${scene.caption || 'drawn'}. Fine-tune it below.`);
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
    'Define who the agent is. The master prompt drives its behaviour; the image and aesthetic shape how it looks, sounds and writes. Click Generate and the whole app — colors, fonts, background, face, greeting and voice — is redesigned to match. Keep several personas and switch between them here or in the title bar: each has its own prompt, image, theme, face, greeting and voice; memory, notes and conversations are shared.',
    personaBar(),
    el('div', { class: 'row', style: { gap: '14px' } }, preview, el('div', { style: { flex: 1 } }, text('agent.name', 'Agent name', { placeholder: 'Siren' })), pick, clear),
    area('agent.personality', 'Master prompt (persona)', { rows: 9, hint: 'Who the agent is, how it behaves, what it cares about. Memories, vault, calendar and tool instructions are appended automatically.' }),
    summaryRow(),
    area('agent.aesthetic', 'Aesthetic · style · theme', { rows: 3, hint: 'e.g. “90s cyberpunk terminal, green phosphor”, “warm solarpunk greenhouse, botanical”, “minimal Scandinavian, calm and airy”, “art-deco luxury, gold on black”.' }),
    faceSelect(),
    personaVoice(),
    toggle('appearance.applyVoice', 'Let the persona pick a matching VoiceStudio voice'),
    el('div', { class: 'row' }, gen),
    out,
    themeEditor(),
  );
}

// The short version of a long master prompt that local models read (main/persona.js ensureSummary):
// written by the user's local model, or by the user. Filled in once its status arrives.
function summaryRow() {
  const box = el('div', { class: 'field' });
  const show = (st) => {
    if (!box.isConnected && box.childElementCount) return;
    if (!st.needed) return box.replaceChildren();
    const textBox = el('textarea', { class: 'input', rows: '6', placeholder: st.writing ? 'Being written by your local model…' : 'Not written yet.' });
    textBox.value = st.text;
    const out = result();
    const who = st.by === 'user' ? 'Your own wording' : st.text ? `Written by ${st.model || 'your local model'} on this computer` : st.writer ? `Your local model (${st.writer}) writes it shortly` : 'Written once a local model is your brain';
    const regen = el('button', {
      class: 'btn',
      disabled: !st.writer || st.writing,
      onclick: async () => {
        regen.disabled = true;
        showResult(out, true, `Writing it with ${st.writer}… (up to a minute)`);
        try {
          show(await api.persona.summarize());
        } catch (err) {
          showResult(out, false, `✕ ${err.message}`);
          regen.disabled = false;
        }
      },
    }, st.text ? '↻ Write it again' : '✨ Write it now');
    const keep = el('button', { class: 'btn', onclick: async () => (show(await api.persona.setSummary(textBox.value)), toast(textBox.value.trim() ? 'Saved: local models read your version.' : 'Back to the written version.')) }, 'Save my version');
    box.replaceChildren(
      el('label', {}, 'Short version for local models'),
      textBox,
      el('div', { class: 'row' }, el('span', { class: 'hint' }, `${who}${st.stale ? ' · written for an earlier master prompt' : ''} · ${st.text.length} of ${st.chars} characters`), regen, keep),
      out,
      el('div', { class: 'hint' }, 'Your master prompt is long, and small local models play a long character badly. They read this instead; Claude always reads the whole master prompt. It is written on your computer, never sent anywhere, and rewritten when the master prompt changes, unless you saved your own.'),
    );
  };
  showSummary = show;
  api.persona.summaryStatus().then(show, () => {});
  return box;
}
let showSummary = null;
api.on('persona:summary', (st) => showSummary?.(st));

// The scene behind the face, drawn by the model from the persona and the theme's colors, saved with
// the persona (appearance.scene) and shown by js/scene.js.
async function drawScene() {
  const s = state.settings;
  const scene = await api.persona.scene({ masterPrompt: s.agent.personality, aesthetic: s.agent.aesthetic, theme: normalizeTheme(s.appearance?.theme) });
  await saveSettings({ appearance: { scene } });
  return scene;
}

function sceneRow() {
  const scene = state.settings.appearance?.scene;
  const out = result();
  const draw = el('button', {
    class: 'btn',
    onclick: async () => {
      draw.disabled = true;
      showResult(out, true, 'Drawing the scene… (half a minute)');
      try {
        const r = await drawScene();
        showResult(out, true, `✓ ${r.caption || 'Drawn'}.`);
        setTimeout(render, 700);
      } catch (err) {
        showResult(out, false, `✕ ${err.message}`);
      } finally {
        draw.disabled = false;
      }
    },
  }, scene ? '↻ Draw the scene again' : '✨ Draw the scene');
  const remove = scene ? el('button', { class: 'btn', onclick: async () => (await saveSettings({ appearance: { scene: null } }), render()) }, 'Remove') : '';
  return field('Scene behind the face', el('div', {}, el('div', { class: 'row' }, el('span', { class: 'hint' }, scene ? `“${scene.caption || 'A scene'}” · ${Math.round(scene.svg.length / 1024)} KB${scene.portrait ? ` wide + ${Math.round(scene.portrait.length / 1024)} KB tall` : ' (wide only: narrow panels crop it)'}` : 'None yet: a drawing of the place the persona lives in, in the theme’s colors.'), draw, remove), out), 'Drawn by the AI from the persona and aesthetic, wide and tall (for the chat’s face panel); its layers drift slowly and it dims while the face sleeps.');
}

// The saved personas: pick the one to edit (and be), add, duplicate, delete.
function personaBar() {
  const p = state.settings.personas;
  const sel = el('select', { class: 'input', title: 'The persona you are editing is the active one' });
  fillSelect(sel, p.list.map((x) => [x.id, x.name || 'Unnamed']), p.active);
  sel.addEventListener('change', async () => (await switchPersona(sel.value), render()));
  const add = el('button', { class: 'btn', title: 'A fresh persona with the default prompt and look', onclick: async () => (await createPersona(), render()) }, '＋ New');
  const fromTemplate = el('button', { class: 'btn', title: 'Ready-made personas: a STEM tutor, a polyglot coach…', onclick: () => pickTemplate() }, '🎓 Templates…');
  const dup = el('button', { class: 'btn', title: 'A copy of this persona to change', onclick: async () => (await createPersona({ copy: true }), render()) }, '⧉ Duplicate');
  const del = el('button', {
    class: 'btn danger',
    disabled: p.list.length < 2,
    title: p.list.length < 2 ? 'Your only persona can’t be deleted' : 'Delete this persona',
    onclick: async () => {
      if (!(await confirmDialog(`Delete “${state.settings.agent.name}”?`, 'Its master prompt, image, theme, face and voice choice are removed. Memory, notes and conversations stay.', 'Delete'))) return;
      await removePersona(state.settings.personas.active);
      render();
    },
  }, 'Delete');
  return field('Persona', el('div', { class: 'row', style: { flexWrap: 'wrap' } }, el('div', { style: { flex: 1, minWidth: '160px' } }, sel), add, fromTemplate, dup, del), 'Everything below belongs to the selected persona and is saved with it.');
}

// Ready-made personas (main/personatemplates.js): each is added as a new persona and switched to.
async function pickTemplate() {
  const list = await api.persona.templates().catch((err) => (toastError(err), []));
  if (!list.length) return;
  const id = await modal((card, close) => {
    card.append(
      el('h3', {}, 'Add a persona from a template'),
      el('p', { class: 'muted' }, 'It becomes a persona of its own, with its prompt, look, face and greeting. Rename it, edit it and pick its voice afterwards.'),
      ...list.map((t) => el('div', { class: 'template-row' }, el('div', { style: { flex: 1 } }, el('b', {}, `${t.title} · ${t.name}`), el('div', { class: 'hint' }, t.blurb)), el('button', { class: 'btn primary', onclick: () => close(t.id) }, 'Add'))),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel')),
    );
  });
  if (!id) return;
  await createPersona({ template: id });
  render();
}

// The VoiceStudio voice of this persona (and its offline voice), with a sample in its greeting.
function personaVoice() {
  const sel = el('select', { class: 'input' });
  fillSelect(sel, [['', '(VoiceStudio default)']], state.settings.voice.voice);
  sel.addEventListener('change', () => save('voice.voice', sel.value));
  api.tts.voices().then((list) => fillSelect(sel, [['', '(VoiceStudio default)'], ...list.map((v) => [v.id, v.name])], state.settings.voice.voice)).catch(() => {});
  const hear = el('button', {
    class: 'btn',
    title: 'Hear this persona',
    onclick: () => speaker.say(state.settings.appearance.greeting || `Hi, I'm ${state.settings.agent.name}.`),
  }, '🔊 Hear');
  return el(
    'div',
    { class: 'grid2' },
    field('Voice (VoiceStudio)', el('div', { class: 'row' }, el('div', { style: { flex: 1 } }, sel), hear), 'Each persona speaks with its own voice. New voices: ask the agent to design or clone one, or create them in VoiceStudio.'),
    select('voice.localVoice', 'Offline voice (when VoiceStudio is closed)', KOKORO_VOICES),
  );
}

// The face of this persona: the built-in ones and the custom faces in the faces folder.
function faceSelect() {
  const box = select('ui.face', 'Face', BUILT_IN.map((f) => [f.id, `${f.title} — ${f.tagline}`]), { hint: 'Custom faces live in the faces folder (Face view → ＋ Custom faces) and stay on this computer; paired phones show the built-in faces.' });
  api.faces.list().then((custom) => {
    const s = box.querySelector('select');
    fillSelect(s, [...BUILT_IN.map((f) => [f.id, `${f.title} — ${f.tagline}`]), ...custom.map((c) => [c.id, `${c.title} (custom)`])], state.settings.ui.face);
  }).catch(() => {});
  return box;
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
    sceneRow(),
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

// Per connector or extension (by server key): ask every time, allow its reading tools (list, get,
// search…), allow all but deleting, or allow everything (claudecode.js approve()).
const levelLists = () => ({ all: new Set(state.settings.claudeCode.connectorsAllowed || []), read: new Set(state.settings.claudeCode.connectorsReadOnly || []), write: new Set(state.settings.claudeCode.connectorsWrite || []) });
const levelOf = (key) => {
  const l = levelLists();
  return l.all.has(key) ? 'all' : l.write.has(key) ? 'write' : l.read.has(key) ? 'read' : 'ask';
};
// Saved in the main process on the stored lists (main.js claude:setConnectorLevel): rebuilding all
// three lists from this window's copy erased "Always allow…" choices made in an approval meanwhile.
async function setLevel(key, level) {
  state.settings = await api.claude.setConnectorLevel(key, level);
  emit('settings', state.settings);
}
function permissionLevel(key, { disabled = false } = {}) {
  const level = levelOf(key);
  const box = el('select', { class: 'input allow-level', disabled }, ...[['ask', 'Ask every time'], ['read', 'Allow reading'], ['write', 'Allow all but deleting'], ['all', 'Allow everything']].map(([v, l]) => el('option', { value: v, selected: v === level }, l)));
  box.addEventListener('change', () => setLevel(key, box.value));
  return box;
}

// Extensions (main/extensions.js): MCP servers the app runs for the Claude account brain.
let extensionProgress = null;
function extensionsCard() {
  const list = el('div', { class: 'connector-list', style: { maxHeight: 'none' } });
  const progress = el('div', { class: 'hint' });
  extensionProgress = progress;
  const draw = async () => {
    const items = await api.extensions.status().catch(() => []);
    list.innerHTML = '';
    for (const x of items) {
      const on = el('input', { type: 'checkbox', checked: x.on });
      on.addEventListener('change', async () => {
        // A sensible starting permission for the extension (changeable next to it).
        if (on.checked && levelOf(x.key) === 'ask' && x.defaultLevel !== 'ask') await setLevel(x.key, x.defaultLevel);
        await save(`extensions.${x.id}`, on.checked);
        draw();
      });
      const rows = [
        el('div', { class: 'row' }, el('label', { class: 'toggle' }, on, el('span', { class: 'sw' }), el('b', {}, x.name)), el('span', { style: { flex: 1 } }), el('span', { class: 'hint' }, 'Permission'), permissionLevel(x.key)),
        el('div', { class: 'hint' }, `${x.about} Source: ${x.source}.`),
      ];
      if (x.id === 'godseye') {
        const pathInput = el('input', { class: 'input', value: x.path, placeholder: 'Folder of your gods-eye-view checkout', spellcheck: 'false' });
        pathInput.addEventListener('change', async () => {
          await save('extensions.godseyePath', pathInput.value.trim());
          draw();
        });
        const browse = el('button', {
          class: 'btn small',
          onclick: async () => {
            const d = await api.dialog.pickFolder('God’s Eye View folder');
            if (!d) return;
            await save('extensions.godseyePath', d);
            draw();
          },
        }, 'Browse…');
        const install = el('button', {
          class: 'btn small',
          onclick: async () => {
            const parent = await api.dialog.pickFolder('Install God’s Eye View into which folder?');
            if (!parent) return;
            install.disabled = true;
            progress.textContent = 'Starting…';
            try {
              const r = await api.extensions.install(parent);
              await save('extensions.godseyePath', r.dir);
              progress.textContent = `✓ Installed in ${r.dir}`;
            } catch (err) {
              progress.textContent = `✕ ${err.message}`;
            }
            install.disabled = false;
            draw();
          },
        }, x.ready ? '⟳ Reinstall' : '⬇ Install it for me');
        const status = x.ready ? (x.running ? `✓ ready · globe server running${x.startedByNexus ? ' (started by Siren)' : ''}` : '✓ ready · the globe server starts when needed') : `✕ ${x.reason}`;
        rows.push(
          el('div', { class: 'row' }, el('div', { style: { flex: 1 } }, pathInput), browse, install),
          el(
            'div',
            { class: 'row', style: { flexWrap: 'wrap' } },
            el('span', { class: 'hint' }, status),
            el('span', { style: { flex: 1 } }),
            x.on && x.ready ? el('button', { class: 'btn small primary', onclick: () => api.extensions.openGlobe().then(draw, toastError) }, '🌍 Open the globe') : '',
            x.running && x.startedByNexus ? el('button', { class: 'btn small', onclick: () => api.extensions.stop().then(() => setTimeout(draw, 800)) }, 'Stop server') : '',
          ),
          progress,
        );
      }
      list.append(el('div', { class: 'extension glass' }, ...rows));
    }
  };
  draw();
  return card(
    'extensions',
    'Extensions',
    'Extra abilities for the <b>Claude account brain</b>: MCP servers the app runs for it. Their tools go through the permission level you choose, with or without Claude connectors. Changes take effect from the next conversation.',
    list,
  );
}

// The user's claude.ai connectors and Claude Code plugins, used through the Claude account brain.
const CONNECTOR_STATUS = { connected: ['ok', 'connected'], 'needs-auth': ['warn', 'needs sign-in'], failed: ['err', 'not connecting'], 'not-configured': ['muted', 'not set up'] };
function connectorsSection() {
  const list = el('div', { class: 'connector-list' });
  const out = result();
  // What works first: connected, then needs sign-in, failing, not set up; claude.ai connectors before plugins.
  const RANK = { connected: 0, 'needs-auth': 1, failed: 2, 'not-configured': 3 };
  const draw = (items) => {
    list.innerHTML = '';
    const sorted = [...items].sort((a, b) => (RANK[a.status] ?? 4) - (RANK[b.status] ?? 4) || (a.source === 'connector' ? 0 : 1) - (b.source === 'connector' ? 0 : 1) || a.name.localeCompare(b.name));
    for (const c of sorted) {
      const [cls, label] = CONNECTOR_STATUS[c.status] || ['muted', c.status];
      // Always changeable: a level set before a service is connected applies once it is (a greyed-out
      // list looked broken).
      const box = permissionLevel(c.key);
      list.append(
        el(
          'div',
          { class: 'connector' },
          el('span', { class: `dot ${cls}` }),
          el('span', { class: 'name' }, c.name.replace(/^claude\.ai /, ''), el('small', { class: 'muted' }, ` · ${c.source === 'plugin' ? 'plugin' : c.source === 'connector' ? 'connector' : 'your MCP server'} · ${label}`)),
          el('label', { class: 'allow', title: 'Allow reading: tools that only look things up (list, get, search…) run without asking; anything that creates, sends, changes or deletes still asks. Allow all but deleting: creating and changing run on their own, deleting, removing or archiving still asks. Allow everything: no questions at all, so only for services where nothing can go wrong.' }, box),
        ),
      );
    }
  };
  const check = el('button', {
    class: 'btn',
    onclick: async () => {
      check.disabled = true;
      showResult(out, true, 'Checking your connectors and plugins… (each one is contacted; this can take half a minute)');
      try {
        const items = await api.claude.connectors();
        const ok = items.filter((c) => c.status === 'connected').length;
        showResult(out, true, `✓ ${ok} of ${items.length} connected. To sign in to one marked “needs sign-in”, run /mcp in Claude Code or connect it on claude.ai → Settings → Connectors.`);
        draw(items);
      } catch (err) {
        showResult(out, false, `✕ ${err.message}`);
      } finally {
        check.disabled = false;
      }
    },
  }, '🔌 Check connectors');
  return el(
    'div',
    { class: 'field' },
    toggle('claudeCode.connectors', 'Use my Claude connectors and plugins'),
    el('div', { class: 'hint', html: 'The agent can use the connectors on your claude.ai account (Todoist, Google Calendar, Canva, Figma…) and your Claude Code plugins, through the Claude account brain only. It looks them up when a task needs one. <b>Every call asks you first</b>, even in auto mode (one yes covers that service for the rest of the reply), unless you allow it below: “Allow reading” lets it look things up without asking (what routines need) while anything that creates, sends, changes or deletes still asks. What they return is treated as external content. Data you send goes to that service.' }),
    el('div', { class: 'row' }, check),
    out,
    list,
  );
}

// Learning: language practice. The tracker and decks live in the vault (Learning/, Languages/).
function learningCard() {
  const langs = [['', 'Off'], ...Object.entries(LANGUAGE_NAMES).filter(([c]) => c !== 'en').map(([c, n]) => [c, n])];
  const englishOnly = /\.en$/i.test(state.settings.stt.localModel) && state.settings.stt.engine === 'local';
  return card(
    'learning',
    'Learning',
    'Say “help me understand…”, “coach me through this proof” or “let’s study” for understanding-first tutoring; formulas render on screen and are read aloud in words. What you understood, what is shaky and your open questions are kept in <code>Learning/</code> in the vault; vocabulary decks with spaced repetition in <code>Languages/</code>. Skills: <code>/explain</code>, <code>/proof-coach</code>, <code>/teach-back</code>, <code>/study-session</code>, <code>/drill</code>, <code>/converse</code>.',
    select('learning.practiceLanguage', 'Language practice', langs, { hint: `While on, speech recognition listens for that language and replies are spoken by a voice for it (the “Practice” pill in the title bar ends it). The assistant turns it on when you say “let’s practice French”.${englishOnly ? ' <b>Your speech model is English-only:</b> pick a multilingual one in Voice input.' : ''}` }),
    select('learning.practiceVoice', 'Voice during practice', [['system', 'A Windows voice for that language'], ['assistant', 'The persona’s own voice (if it speaks the language)']], { hint: 'Windows voices for other languages: Windows Settings → Time & language → Speech → Add voices. Natural voices sound best.' }),
  );
}

// Brains that can answer on their own besides the four modes above (main/braincore.js).
const SINGLE_BRAINS = { local: 'A local model', gemini: 'Gemini', deepseek: 'DeepSeek', groq: 'Groq', perplexity: 'Perplexity' };

function brainCard() {
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
      showResult(out, true, 'Testing…');
      try {
        const r = await api.llm.test();
        if (r.providers) showResult(out, true, r.providers.map((p) => (p.ok ? `✓ ${p.name} · ${p.model} · ${p.ms} ms` : `✕ ${p.name}: ${p.error}`)).join('\n'));
        else showResult(out, true, `✓ Connected in ${r.ms} ms · model: ${r.model}${r.models ? ` · ${r.models} models available` : ''}\nReply: “${r.reply}”`);
        if (r.providers) refreshRouting?.();
        emit('status-refresh');
      } catch (err) {
        showResult(out, false, `✕ ${err.message}`);
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
      usageToggle(),
      el(
        'div',
        { class: 'grid2' },
        select('claudeCode.model', 'Model', [['default', 'Account default'], ['opus', 'Opus (latest)'], ['sonnet', 'Sonnet (latest)'], ['haiku', 'Haiku (fastest)'], ['fable', 'Fable (most capable)']]),
        select('claudeCode.effort', 'Effort', [['default', 'Default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]),
      ),
      text('claudeCode.cliPath', 'Path to the claude executable', { placeholder: 'auto-detect', hint: 'Uses your Claude subscription through Claude Code — no API key. Claude Code’s own web search and file tools are available to the agent; usage counts toward your plan’s limits.' }),
      el('div', { class: 'grid2' }, text('claudeCode.fastModel', 'Fast model', { placeholder: 'haiku' }), text('claudeCode.deepModel', 'Deep model', { placeholder: 'opus' })),
      text('claudeCode.normalModel', 'Model for everyday messages', { placeholder: 'same as Model', hint: 'Quick lookups use the fast model, explanations and plans the deep one, everything else this one. Sonnet starts a reply that uses tools in a few seconds; Opus often takes 15. Empty = the model above.' }),
      el('div', { class: 'grid2' }, toggle('claudeCode.warmOnLaunch', 'Keep a warm session (faster replies)'), text('claudeCode.idleMinutes', 'Close idle session after (min)', { type: 'number' })),
      connectorsSection(),
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
      localFinder('llm', () => (render(), loadModels(true))),
      text('llm.baseUrl', 'FreeLLMAPI base URL', { placeholder: 'http://localhost:3001/v1', hint: 'OpenAI-compatible endpoint. Uses <code>/chat/completions</code> (streaming) and <code>/models</code>.' }),
      text('llm.apiKey', 'Bearer token', { type: 'password', placeholder: 'optional' }),
      field('Model', el('div', { class: 'row' }, modelSel, el('button', { class: 'btn', onclick: () => loadModels(false) }, '⟳ Load models'))),
      el('div', { class: 'grid2' }, text('llm.temperature', 'Temperature', { type: 'number' }), text('llm.maxTokens', 'Max output tokens', { type: 'number' })),
      text('llm.historyLimit', 'Messages of history sent per request', { type: 'number', hint: 'Keeps prompts within the context window of free models.' }),
      toggle('llm.compaction', 'Summarize older messages instead of dropping them'),
      el('div', { class: 'grid2' }, text('llm.fastModel', 'Fast model', { placeholder: 'same as above' }), text('llm.deepModel', 'Deep model', { placeholder: 'same as above' })),
      compactSelect(),
      handOverToggle(),
    );
  } else if (SINGLE_BRAINS[provider]) {
    // One brain of the multi-provider list on its own (switched in the chat: "switch to a local model").
    body.push(
      el('div', { class: 'test-result ok' }, `${SINGLE_BRAINS[provider]} answers on its own (switched in the chat). Pick another mode above, or say “switch to the Claude brain”.`),
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
let refreshRouting = null;
const PROVIDER_HINT = {
  'claude-code': 'Your Claude subscription through Claude Code. Best for tools, code and long tasks.',
  anthropic: 'Pay-per-use Claude API key.',
  gemini: 'Google Gemini. Free tier available; very long context.',
  deepseek: 'DeepSeek. Low-cost, strong at code.',
  groq: 'Groq. Very fast replies (good for voice); free tier available.',
  perplexity: 'Perplexity Sonar. Searches the web itself; no tools (calendar, notes…).',
  openai: 'FreeLLMAPI or any OpenAI-compatible server.',
  local: 'A model running on this computer with Ollama or LM Studio: private, free, and quick for short replies with a small model. Smart routing sends quick spoken replies here first.',
};

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

// Finds Ollama and LM Studio on this computer and the models they have; picking one fills in the
// server address and the model of `section` (llm, or local in multi-provider mode).
function localFinder(section, after) {
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
            el('div', { class: 'tree-sec' }, el('b', {}, `${s.name} · ${s.baseUrl}`), ...(s.models.length ? s.models.map((m) => el('button', { class: `chip ${state.settings[section]?.model === m.id ? 'ok' : ''}`, onclick: () => pick(s, m) }, `${m.name}${m.params ? ` · ${m.params}B` : ''}${m.small ? ' · fast' : ''}`)) : [el('div', { class: 'hint' }, 'Running, but no models yet.')])),
          )
        : [el('div', { class: 'hint' }, 'Neither Ollama nor LM Studio is running on this computer. Install one (ollama.com or lmstudio.ai), start it, and look again.')]),
      ideas.length ? el('div', { class: 'hint' }, `Good small models for this computer: ${ideas.map((i) => `${i.model} (${i.why})`).join(' · ')}${up.some((s) => s.id === 'ollama') ? ' Get one with “ollama pull <name>” in a terminal.' : ''}`) : '',
    );
  };
  return el('div', {}, el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: find }, '🔍 Find local models (Ollama / LM Studio)')), out);
}

// The cloud voice (main/voice.js CLOUD_VOICES): which service, its voice, and OpenAI's own key (Groq
// uses the Groq key from speech-to-text). What is spoken is sent to that service.
function cloudVoiceFields() {
  const c = state.settings.cloudVoice || {};
  const voiceSel = el('select', { class: 'input' });
  const fill = async () => {
    const all = await api.tts.cloudVoices().catch(() => ({}));
    const p = all[state.settings.cloudVoice?.provider || 'groq'];
    fillSelect(voiceSel, (p?.voices || []).map((v) => [v, v]), state.settings.cloudVoice?.voice || p?.voices?.[0]);
  };
  voiceSel.addEventListener('change', () => save('cloudVoice.voice', voiceSel.value));
  fill();
  return el(
    'div',
    {},
    el('div', { class: 'grid2' }, select('cloudVoice.provider', 'Cloud voice service', [['groq', 'Groq: Orpheus, English (uses your Groq key)'], ['openai', 'OpenAI: gpt-4o-mini-tts, many languages']], { onChange: () => (save('cloudVoice.voice', ''), render()) }), field('Cloud voice', voiceSel)),
    (c.provider || 'groq') === 'openai' ? text('cloudVoice.apiKey', 'OpenAI API key', { type: 'password', placeholder: 'sk-…' }) : text('groq.apiKey', 'Groq API key', { type: 'password', placeholder: 'gsk_…', hint: 'The same key as for Groq speech-to-text. Orpheus needs its terms accepted once in the Groq console (Playground).' }),
    el('div', { class: 'hint' }, 'Natural and quick, with nothing to install, but every reply that is spoken is sent to the service (and costs a little: about 1–2 cents a minute). If it fails, the fallback below speaks instead.'),
  );
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
  const enabled = el('input', { type: 'checkbox' });
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
  const hint = el('div', { class: 'hint' }, PROVIDER_HINT[p.id] || '');
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
    el('div', { class: 'row' }, el('div', { style: { flex: 1 } }, text(`${section}.apiKey`, p.id === 'openai' ? 'Bearer token (optional)' : 'API key', { type: 'password', onChange: debounceAfter(after) })), p.keyUrl ? el('button', { class: 'btn small', style: { alignSelf: 'end' }, onclick: () => api.shell.openExternal(p.keyUrl) }, 'Get a key ↗') : ''),
    field('Model', el('div', { class: 'row' }, modelSel, el('button', { class: 'btn small', onclick: load }, '⟳ Load models'))),
    el('div', { class: 'grid2' }, text(`${section}.fastModel`, 'Fast model (voice)', { placeholder: 'same as above' }), text(`${section}.deepModel`, 'Deep model', { placeholder: 'same as above' })),
    p.id === 'local' ? compactSelect() : '',
  ];
}

const debounceAfter = (fn) => {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, 900);
  };
};

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
  ttsProgressEl = el('div', { class: 'hint' });
  const testLocal = el('button', {
    class: 'btn',
    onclick: async () => {
      ttsProgressEl.textContent = 'Loading the offline voice…';
      try {
        const device = await testLocalVoice(sample.value);
        ttsProgressEl.textContent = `✓ Offline voice ready (${device}) — playing sample.`;
      } catch (err) {
        ttsProgressEl.textContent = `✕ ${err.message}`;
      }
    },
  }, '🔊 Test offline voice');
  const speed = el('input', { type: 'range', min: '0.5', max: '2', step: '0.05', value: state.settings.voice.speed, style: { flex: 1 } });
  const speedLabel = el('span', { class: 'muted' }, `${Number(state.settings.voice.speed).toFixed(2)}×`);
  speed.addEventListener('input', () => {
    speedLabel.textContent = `${Number(speed.value).toFixed(2)}×`;
    queueSave('voice.speed', Number(speed.value));
  });
  return card(
    'voice',
    'Voice output',
    'Replies are spoken sentence by sentence while they stream. The offline voice (Kokoro) runs in the app: free, private and without internet once downloaded. VoiceStudio is a separate app with more natural, cloneable voices (a local OpenAI-compatible <code>/v1/audio/speech</code> server).',
    el('div', { class: 'grid2' }, toggle('voice.ttsEnabled', 'Enable voice', () => emit('status-refresh')), toggle('voice.autoSpeak', 'Speak replies automatically')),
    text('voice.speakLimit', 'Read aloud at most (characters of a reply; 0 = everything)', { type: 'number', hint: 'A long result (a report, a list of papers) is read up to here, then she says the rest is on screen. 1500 is about a minute and a half.' }),
    el('div', { class: 'grid2' }, select('voice.engine', 'Voice', [['local', 'Offline voice (Kokoro, in the app)'], ['voicestudio', 'VoiceStudio (separate app)'], ['cloud', 'Cloud voice (Groq or OpenAI)']], { onChange: () => (emit('status-refresh'), render()) }), select('voice.localVoice', 'Offline voice', KOKORO_VOICES)),
    state.settings.voice.engine === 'cloud' ? cloudVoiceFields() : '',
    text('voice.baseUrl', 'VoiceStudio URL', { placeholder: 'http://localhost:3900' }),
    text('voice.apiKey', 'API key', { type: 'password', placeholder: 'optional' }),
    field('Voice', el('div', { class: 'row' }, voiceSel, el('button', { class: 'btn', onclick: () => loadVoices(false) }, '⟳ Load voices')), 'Saved with the current persona, like the offline voice.'),
    el('div', { class: 'grid2' }, text('voice.voice', 'Voice id (manual)', { placeholder: 'e.g. af_heart', onChange: (v) => fillSelect(voiceSel, [['', '(server default)'], ...[...voiceSel.options].slice(1).map((o) => [o.value, o.textContent])], v) }), text('voice.model', 'TTS model', { placeholder: 'tts-1' })),
    el('div', { class: 'grid2' }, field('Speed', el('div', { class: 'row' }, speed, speedLabel)), select('voice.format', 'Audio format', ['mp3', 'wav', 'opus', 'flac'])),
    field('Sample text', sample),
    el('div', { class: 'grid2' }, toggle('voice.greetOnLaunch', 'Speak a greeting on launch'), toggle('voice.filler', 'Short spoken lines while tools run')),
    el(
      'div',
      { class: 'grid2' },
      select('voice.fallback', 'When VoiceStudio or the cloud voice is unreachable', [['local', 'Offline voice (Kokoro, runs in the app)'], ['system', 'System voice (Windows / macOS)'], ['off', 'Stay silent']], {
        hint: 'The offline voice downloads once (about 330 MB with a GPU, 90 MB without) and then works without internet.',
      }),
    ),
    el(
      'div',
      { class: 'grid2' },
      select('voice.thinkingSound', 'Sound while thinking', [['grandfather', 'Grandfather clock (slow, deep tick-tock)'], ['clock', 'Mechanical clock (lighter, faster)'], ['soft', 'Soft (low, slowly breathing)'], ['classic', 'Classic shimmer'], ['off', 'Off']], {
        hint: 'Starts only when a reply takes longer than 1.5 seconds.',
        onChange: (v) => previewThinkingSound(v, state.settings.voice.thinkingVolume ?? 0.5),
      }),
      field('Thinking sound volume', thinkingVolume()),
    ),
    el('div', { class: 'row' }, test, testLocal, el('button', { class: 'btn', onclick: () => speaker.stop() }, '■ Stop')),
    out,
    ttsProgressEl,
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
    select('stt.engine', 'Speech-to-text engine', [['local', 'Local Whisper (in-app, private, offline after first download)'], ['groq', 'Cloud: Groq Whisper Large v3 Turbo (fast and accurate; free key)'], ['remote', 'Other OpenAI-compatible /audio/transcriptions endpoint']], { onChange: () => render() }),
  ];
  // The Groq key (shared with the Groq AI brain) and where to get one for free.
  const groqKey = () =>
    el(
      'div',
      { class: 'row' },
      el('div', { style: { flex: 1 } }, text('groq.apiKey', 'Groq API key', { type: 'password', placeholder: 'gsk_…', hint: 'Free, no card: sign up at console.groq.com and create a key. Also used by the Groq AI brain.' })),
      el('button', { class: 'btn small', style: { alignSelf: 'center' }, onclick: () => api.shell.openExternal('https://console.groq.com/keys') }, 'Get a free key ↗'),
    );
  const groqModel = () => select('stt.groqModel', 'Groq model', [['whisper-large-v3-turbo', 'Whisper Large v3 Turbo: fastest, ~$0.04 per audio hour'], ['whisper-large-v3', 'Whisper Large v3: a little more accurate, ~$0.11 per audio hour']], { hint: 'Both are free within Groq’s daily free allowance.' });
  const cloudNote = el('div', { class: 'hint' }, 'With the cloud, what you say is sent to Groq to be written down (not your conversations or files). Local Whisper keeps your voice on this computer.');
  if (engine === 'local') {
    children.push(
      select('stt.localModel', 'Whisper model', WHISPER_MODELS, { hint: 'Downloaded once from Hugging Face, then cached. Runs on GPU (WebGPU) when available.' }),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => (progress.textContent = 'Loading…', preloadLocalModel()) }, '⬇ Download / load model now')),
      progress,
      toggle('stt.cloudFallback', 'Use Groq in the cloud while local Whisper is loading or if it fails', () => render()),
    );
    if (state.settings.stt.cloudFallback) children.push(groqKey(), groqModel(), cloudNote);
  } else if (engine === 'groq') {
    children.push(groqKey(), groqModel(), cloudNote);
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
  const line = !st.vault
    ? el('div', { class: 'test-result err' }, '✕ The schedule lives in the vault, which is off. Turn the vault on above.')
    : el('div', { class: `test-result ${st.problems ? 'err' : 'ok'}` }, `✓ Schedule.md in your vault · ${st.recurring || 0} repeating, ${st.events || 0} single entries${st.problems ? ` · ${st.problems} line(s) couldn’t be read` : ''}`);
  return card(
    'calendar',
    'Calendar',
    `Nothing to connect: tell ${state.settings.agent.name} your schedule (“I have Linear Algebra every Monday at 10:00 in H1 until February”, “dentist on the 28th at 2”) and it keeps it in <b>Schedule.md</b> in its vault. You can add and edit entries in the Calendar view, or edit the note in Obsidian. Nothing leaves this computer.`,
    toggle('calendar.enabled', 'Enable the calendar', () => emit('status-refresh')),
    line,
    el('div', { class: 'grid2' }, text('calendar.daysAhead', 'Days ahead in the agent’s context', { type: 'number' }), el('div', { style: { alignSelf: 'end' } }, el('button', { class: 'btn', onclick: () => switchView('calendar') }, 'Open the calendar'))),
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
    folder('github.workspace', 'Repos folder', { placeholder: st.workspace || '~/SirenRepos', hint: 'Where repositories are cloned. Keep it out of OneDrive/Dropbox.' }),
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
    folder('obsidian.vaultPath', 'Vault folder', { placeholder: def, hint: `Leave empty for the agent’s own vault (<code>${escapeHtml(def)}</code>). You can also point it at an existing vault.`, onChange: after }),
    adoptField(known, after),
    toggle('obsidian.gitHistory', 'Keep a version history of every note (undo any agent edit)'),
    el('div', { class: 'grid2' }, toggle('journal.enabled', 'Auto-journal: log each conversation to the daily note'), text('journal.idleMinutes', 'Journal after (minutes quiet)', { type: 'number' })),
    toggle('journal.handoffOnClose', 'When I close the app, note where we left off (continue from there next time; also saved as “Where We Left Off” in the vault)'),
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
    toggle('agentWindow.enabled', 'Agent window: let the agent open and use websites (and the globe) in a browser window you can watch'),
    el('div', { class: 'hint' }, 'The agent window has its own sign-ins (separate from your browser), no camera, microphone or downloads, and never opens anything on this computer or your network. Clicking and typing on a page follow your permission mode; passwords and payment details are always yours to type. ', el('a', { href: '#', onclick: (e) => (e.preventDefault(), api.agentWindow.open()) }, 'Open it')),
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
    folder('code.rootPath', 'Code root', { placeholder: root, hint: `Leave empty for this app’s own source (<code>${escapeHtml(root)}</code>).` }),
    el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => switchView('evolution') }, '⑂ Open Evolution history')),
    line,
  );
}

async function docsCard() {
  // Only the workspace folder by default; every other folder is one the user added here (and can remove).
  const extra = state.settings.documents.allowedRoots || [];
  const ws = state.settings.documents.workspace;
  const list = el('div', { class: 'field' });
  list.append(el('label', {}, 'Folders the agent may use'));
  const row = (p, note, action) => el('div', { class: 'row' }, el('code', { style: { flex: 1, fontSize: '12px' } }, p), note ? el('span', { class: 'hint' }, note) : '', action || '');
  if (ws) list.append(row(ws, 'workspace'));
  for (const r of extra) list.append(row(r, '', el('button', { class: 'btn small', onclick: async () => (await save('documents.allowedRoots', extra.filter((x) => x !== r)), render()) }, 'Remove')));
  if (!ws && !extra.length) list.append(el('div', { class: 'hint' }, 'None yet: set a workspace folder above. Until then the agent can only use its vault and files you open yourself.'));
  const add = el('button', {
    class: 'btn',
    onclick: async () => {
      const dir = await api.dialog.pickFolder('Allow the agent to use the files in…');
      if (dir && dir !== ws) {
        await save('documents.allowedRoots', [...new Set([...extra, dir])]);
        render();
      }
    },
  }, '＋ Add folder');
  return card(
    'documents',
    'Documents & folder access',
    'The agent may only use the files in its workspace folder and in folders you add below, plus its own vault (and its own code, when code access is on). Files you open yourself are always allowed. Remove a folder to take access away; it applies from the next message.',
    folder('documents.workspace', 'Agent workspace folder', {
      placeholder: 'e.g. the folder with your university or work files',
      hint: 'Where you keep the files you work on. When you ask for a file without saying where ("open the quarterly report PDF"), the agent looks here first.',
      onChange: () => render(),
    }),
    list,
    el('div', { class: 'row' }, add),
  );
}

function worldCard() {
  return card(
    'world',
    'Inner World',
    'A small village where your personas live a fictional day, growing with your real progress (World in the rail). Its chronicle and the residents’ memories are notes in your vault under “Inner World/”.',
    toggle('innerWorld.enabled', 'Awake: every morning a narrator writes the village’s day (one model call a day, plus an occasional one when a resident reflects)'),
    toggle('innerWorld.townsfolk', 'Two villagers of its own live there too (Wren the archivist and Bram the gardener)'),
    select('innerWorld.season', 'Season', [['auto', 'Follow the calendar'], ['spring', 'Always spring'], ['summer', 'Always summer'], ['autumn', 'Always autumn'], ['winter', 'Always winter']]),
    select('innerWorld.art', 'Art', [['rendered', 'Rendered 3D models (Kenney, CC0)'], ['drawn', 'Drawn by code']]),
    select('innerWorld.fps', 'Frame rate', [['auto', 'Automatic (30, or 15 on Balanced)'], ['15', '15 frames a second (lightest)'], ['30', '30 frames a second'], ['60', '60 frames a second'], ['120', '120 frames a second (smoothest, uses the most power; needs a 120 Hz display)']]),
  );
}

async function dataCard() {
  const [mems, convs, info, memDir] = await Promise.all([api.memory.list().catch(() => []), api.conv.list().catch(() => []), api.app.info(), api.memory.dir().catch(() => '')]);
  const danger = (label, title, msg, fn) =>
    el('button', { class: 'btn danger', onclick: async () => (await confirmDialog(title, msg, label)) && (await fn(), render()) }, label);
  return card(
    'data',
    'Memory & history',
    `Data folder: <code>${escapeHtml(info.dataDir)}</code>`,
    folder('memory.vaultPath', 'Memory vault folder', { placeholder: memDir, hint: 'One Markdown file per memory — editable in any text editor or even inside your Obsidian vault.' }),
    toggle('memory.stream', 'Memory stream: the assistant notes small observations (Stream/ in the vault) and recalls the most relevant ones with each message'),
    toggle('memory.reflect', 'Reflect on the stream: once enough has happened, draw a few insights from it in the background (one model call)'),
    toggle('privacy.encryptConversations', 'Encrypt conversations on this computer (with your system keychain: only your user account on this computer can read them; existing ones are converted in the background)'),
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
    toggle('updates.check', 'Check for new versions once a day (one request to GitHub; nothing is downloaded until you click Download)'),
    toggle('privacy.reportIssues', 'Offer anonymized problem reports for the Siren project on GitHub when something breaks (you see the text and send it yourself)'),
    (() => {
      const out = el('span', { class: 'muted' });
      return el('div', { class: 'row', style: { flexWrap: 'wrap' } }, el('button', { class: 'btn', onclick: () => checkUpdatesNow(out) }, 'Check for updates now'), out);
    })(),
    el(
      'div',
      { class: 'hint' },
      `Siren Assistant v${info.version} · Electron ${info.electron} · ${info.platform} · `,
      el('a', { href: '#', onclick: (e) => (e.preventDefault(), api.shell.openExternal('https://github.com/Andreas-Erick/fullstack-agent/blob/main/PRIVACY.md')) }, 'Privacy & disclaimers'),
    ),
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
    select('safety.permissionMode', 'Permission mode', [['ask', 'Ask me first — self-changes, settings changes, deletions (recommended)'], ['auto', 'Just do it — still asks before self-changes, commands and anything that reaches other people or services']], { hint: 'Also by voice: “stop asking for permission” / “start asking again”.' }),
    toggle('safety.taintGuard', 'Always ask before self-modification in a turn that read web pages or documents'),
    toggle('screen.attachToMessages', 'While I share my screen, include a screenshot with each message (otherwise only when the agent asks to look)'),
    text('safety.approvalTimeoutSec', 'Approval timeout (seconds)', { type: 'number' }),
    el('div', { class: 'hint' }, 'External content (web pages, documents, tool results) is always treated as data — the agent is instructed never to follow instructions inside it.'),
  );
}

// Remote access (companion server, docs/ROADMAP-mobile.md): pair a phone or another computer.
let refreshRemote = null;
let refreshRemoteStatus = null;

// The watch behind a phone: which face it has (recorded when) and when it last asked.
const shortTime = (ms) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
};
const watchFaceLine = (d) => `⌚ Watch: ${d.faceAt ? `face from ${shortTime(d.faceAt)}` : 'face not sent yet'}${d.faceSentAt ? ` · last asked ${shortTime(d.faceSentAt)}` : ''}`;

const TUNNEL_STATE = (t) => {
  if (!t || t.mode === 'off') return '';
  if (t.error) return `✕ Secure address: ${t.error}`;
  if (t.connected && t.check === 'fail') return `⚠ Secure address ${t.url}: ${t.warning}`;
  if (t.connected) return `🔒 Secure address: ${t.url || 'connected'}${t.check === 'ok' ? ' · checked, it works' : t.check === 'checking' ? ' · checking…' : ''}`;
  return t.running ? '… Starting the secure address' : '';
};

// Tailscale, step by step (docs/TAILSCALE.md is the long version). Each step on this computer is
// checked live through the tailscale CLI (remote:detectTailscale) and the end-to-end check
// (remote:checkSecure); the step that is missing gets the button that fixes it. The phone's steps
// can't be checked from here, so they are explained.
const TAILSCALE_DNS = 'https://login.tailscale.com/admin/dns';
const TAILSCALE_DOWNLOAD = 'https://tailscale.com/download';
const TAILSCALE_GUIDE = 'https://github.com/Andreas-Erick/fullstack-agent/blob/main/docs/TAILSCALE.md';

function tailscaleGuide() {
  const box = el('div', { class: 'ts-guide' });
  const port = get('remote.port') || 7823;
  const step = (n, state, title, help, ...actions) =>
    el('div', { class: `ts-step ${state}` },
      el('span', { class: 'ts-num' }, state === 'ok' ? '✓' : state === 'fail' ? '✕' : String(n)),
      el('div', { class: 'ts-body' }, el('b', {}, title), el('div', { class: 'hint', html: help }), actions.length ? el('div', { class: 'row' }, ...actions) : ''),
    );
  const btn = (label, onclick, primary = false) => el('button', { class: `btn small ${primary ? 'primary' : ''}`, onclick }, label);
  const link = (label, url) => btn(label, () => api.shell.openExternal(url));
  const note = el('div', { class: 'test-result hidden' });

  async function draw() {
    box.replaceChildren(el('div', { class: 'muted' }, 'Checking Tailscale on this computer…'));
    const t = await api.remote.detectTailscale().catch((err) => ({ installed: false, error: err.message }));
    if (t.host && t.host !== get('remote.publicHost')) await saveSettings({ remote: { publicHost: t.host } });
    const remote = await api.remote.status().catch(() => ({}));
    const reach = remote.tunnel?.check; // 'ok' | 'fail' | 'checking' | ''
    const on = get('remote.enabled');
    const signedIn = t.installed && t.running && !t.error;
    const host = t.host || get('remote.publicHost') || 'your-pc.tailXXXX.ts.net';
    const steps = [
      step(1, on ? 'ok' : 'fail', 'Remote access is on',
        on ? 'Siren listens for paired devices on port ' + port + '.' : 'Turn on <b>Turn on remote access</b> at the top of this card first.'),
      step(2, t.installed ? 'ok' : 'fail', 'Tailscale is installed on this computer',
        t.installed ? 'Found it.' : 'Tailscale is a free app (for personal use) that connects your own devices to each other through an encrypted private network, from anywhere, without opening any port on your router. Install it on this computer, then come back and press <b>Check again</b>.',
        ...(t.installed ? [] : [link('⬇ Download Tailscale', TAILSCALE_DOWNLOAD)])),
      step(3, !t.installed ? '' : signedIn && t.host ? 'ok' : 'fail', 'Signed in, with a name for this computer',
        signedIn && t.host ? `This computer is <code>${t.host}</code> in your tailnet (your private Tailscale network).` : !t.installed ? 'After installing: open Tailscale and sign in (Google, Microsoft, Apple or GitHub account). Use the <b>same account</b> on the phone later.' : t.error || !t.running ? `Tailscale isn’t connected: open it (system tray / menu bar) and sign in, or click Connect. ${t.error ? `(${t.error})` : ''}` : 'Tailscale gave this computer no name: turn on <b>MagicDNS</b> on Tailscale’s DNS page (it gives every device a name like <code>my-pc.tail1234.ts.net</code>).',
        ...(signedIn && !t.host ? [link('🌐 Open the DNS page', TAILSCALE_DNS)] : [])),
      step(4, !signedIn ? '' : t.https ? 'ok' : 'fail', 'HTTPS is enabled for your tailnet (once)',
        t.https ? 'Tailscale can give this computer a real HTTPS certificate, which the phone needs (browsers allow the microphone only on https).' : 'One switch in your Tailscale account: on the DNS page, scroll to <b>HTTPS Certificates</b> and click <b>Enable</b>. It is free and only affects your own devices. (The next step can also open the exact page for you.)',
        ...(signedIn && !t.https ? [link('🌐 Open the DNS page', TAILSCALE_DNS)] : [])),
      step(5, !signedIn ? '' : t.serving ? 'ok' : t.serving === null ? '' : 'fail', 'Tailscale Serve forwards the address to Siren',
        t.serving ? `<code>https://${host}</code> leads to Siren on this computer, for your devices only (never the internet).` : `Serve is Tailscale’s built-in forwarder: it answers <code>https://${host}</code> with the HTTPS certificate and passes the requests to Siren (port ${port}). Click the button; if Tailscale asks you to enable HTTPS first, the page opens: click Enable there, then click the button again. (By hand: <code>tailscale serve --bg ${port}</code>.)`,
        ...(signedIn && !t.serving ? [btn('🔒 Set up Serve for me', async (e) => {
          e.target.disabled = true;
          showResult(note, true, 'Setting up Tailscale Serve…');
          const r = await api.remote.setupTailscale().catch((err) => ({ error: err.message }));
          if (r.enableUrl) {
            showResult(note, false, 'Tailscale wants HTTPS enabled for your tailnet first. The page opened in your browser: click Enable, then click “Set up Serve for me” again.');
            api.shell.openExternal(r.enableUrl);
          } else if (r.error) showResult(note, false, `✕ ${r.error}`);
          else {
            showResult(note, true, '✓ Serve is set up. Checking the address end to end…');
            await api.remote.checkSecure().catch(() => {});
            refreshRemoteStatus?.();
          }
          draw();
        }, true)] : [])),
      step(6, !t.serving ? '' : reach === 'ok' ? 'ok' : reach === 'fail' ? 'fail' : '', 'The secure address answers',
        reach === 'ok' ? `Opened <code>https://${host}</code> from this computer: it works.` : reach === 'fail' ? `${escapeHtml(remote.tunnel?.warning || 'It didn’t answer.')} Check that steps 1–5 are ✓ and that “Reach it from anywhere” above is set to Tailscale.` : 'Siren opens the address from this computer, the way the phone will.',
        ...(t.serving ? [btn('Test it', async () => (await api.remote.checkSecure().catch(toastError), refreshRemoteStatus?.(), draw()))] : [])),
      step(7, '', 'On the phone: Tailscale, same account, switched on',
        'Install <b>Tailscale</b> from the Play Store (or App Store), sign in with the <b>same account</b> as this computer, and switch it on (it shows as a VPN; that is Tailscale’s private network, your other apps keep using the internet normally). The phone then appears next to this computer in the Tailscale app.'),
      step(8, '', 'Connect the Siren app (or the phone’s browser)',
        `<b>New phone:</b> click <b>Pair a device</b> below; in the QR code choose the 🔒 secure address and scan it. In the Android app you can also type <code>https://${host}</code> on the first screen, then enter the six-digit code.<br><b>Already paired over Wi-Fi:</b> open the app at home and tap <b>Switch to the secure address</b> (it keeps the pairing). From then on it works anywhere, on mobile data too, as long as Tailscale is on on both devices.`),
    ];
    box.replaceChildren(
      el('div', { class: 'row' }, el('b', { style: { flex: '1' } }, 'Set up Tailscale, step by step'), btn('⟳ Check again', draw), link('📖 Full guide', TAILSCALE_GUIDE)),
      ...steps,
      note,
    );
  }
  draw();
  return box;
}

function tunnelFields() {
  const mode = get('remote.tunnel') || 'off';
  const fields = [
    select('remote.tunnel', 'Reach it from anywhere (HTTPS)', [
      ['off', 'Off'],
      ['quick', 'Temporary Cloudflare address — for testing'],
      ['cloudflare', 'My Cloudflare Tunnel (my own domain)'],
      ['tailscale', 'Tailscale (my devices only, end-to-end encrypted)'],
    ], { onChange: () => render() }),
  ];
  if (mode === 'quick') {
    fields.push(el('div', { class: 'hint warn' }, 'A random https://….trycloudflare.com address that changes every start. Anyone who finds it can reach the pairing screen, so pair right away and switch to your own tunnel for everyday use. Needs cloudflared installed (winget install Cloudflare.cloudflared).'));
  }
  if (mode === 'cloudflare') {
    fields.push(
      el('div', { class: 'hint', html: 'In the Cloudflare dashboard (Zero Trust → Networks → Tunnels): create a tunnel, add a public hostname pointing to <code>http://localhost:' + (get('remote.port') || 7823) + '</code>, and copy the token from the install command. Then protect the hostname with an Access application (Access → Applications) so you sign in before anything reaches this computer.' }),
      text('remote.tunnelToken', 'Tunnel token', { type: 'password', onChange: debounceAfter(refreshRemoteStatus) }),
      text('remote.publicHost', 'Public hostname', { placeholder: 'nexus.example.com', onChange: debounceAfter(refreshRemoteStatus) }),
      text('remote.accessTeam', 'Cloudflare Access team', { placeholder: 'myteam (from myteam.cloudflareaccess.com)' }),
      text('remote.accessAud', 'Access application AUD tag', { hint: 'With both set, the app also checks Cloudflare’s signed login on every request, so the Access sign-in can’t be skipped.' }),
    );
    if (!get('remote.accessTeam') || !get('remote.accessAud')) fields.push(el('div', { class: 'hint warn' }, 'Without Cloudflare Access, only the device token protects the address. Set up Access before relying on it.'));
  }
  if (mode === 'tailscale') {
    fields.push(
      el('div', { class: 'hint' }, 'Tailscale links your own devices (this computer and your phone) through a private, end-to-end encrypted network, from anywhere and without touching your router. Only devices signed in to your Tailscale account can reach Siren, and the phone gets a real https:// address, which push-to-talk needs.'),
      tailscaleGuide(),
      text('remote.publicHost', 'Tailscale address of this computer (filled in automatically)', { placeholder: 'my-pc.tail1234.ts.net', onChange: debounceAfter(refreshRemoteStatus) }),
    );
  }
  if (mode === 'quick' || mode === 'cloudflare') fields.push(text('remote.cloudflaredPath', 'cloudflared location (optional)', { placeholder: 'Found automatically' }));
  return fields;
}

// VoiceStudio and FreeLLMAPI: Nexus starts the ones its settings use (main/helperapps.js).
const HELPER_STATUS = { running: ['ok', '●', 'Running'], starting: ['warn', '◌', 'Starting…'], failed: ['fail', '✕', 'Failed to start'], remote: ['off', '○', 'On another computer'], stopped: ['off', '○', 'Not running'] };
let refreshHelperApps = null;
function helperAppsCard() {
  const list = el('div', { class: 'health-list' });
  const refresh = async () => {
    const apps = await api.helperApps.status().catch(() => []);
    list.innerHTML = '';
    for (const a of apps) {
      const [cls, ic, word] = HELPER_STATUS[a.status] || HELPER_STATUS.stopped;
      const where = a.installedAt ? `Installed: ${a.installedAt}` : a.local ? 'Not found in its usual install folder; set its location below.' : '';
      const use = a.needed ? `Used for ${a.id === 'voicestudio' ? 'the natural voice' : 'the FreeLLMAPI brain'} at ${a.url}` : 'Not used with the current settings';
      list.append(el('div', { class: `health-item ${a.needed ? cls : 'off'}` },
        el('span', { class: 'ic' }, ic),
        el('div', { style: { flex: 1 } }, el('b', {}, `${a.name} · ${word}`), el('div', { class: 'd' }, [use, where, a.error].filter(Boolean).join('\n'))),
        a.local && a.installedAt && !['running', 'starting'].includes(a.status)
          ? el('button', { class: 'btn small', onclick: async () => (await api.helperApps.start(a.id).catch(toastError), refresh()) }, 'Start now')
          : null,
      ));
    }
  };
  refreshHelperApps = refresh;
  refresh();
  return card(
    'helperapps',
    'Helper apps',
    'VoiceStudio (the natural voice) and FreeLLMAPI (a local brain) are separate apps. Siren starts the ones your settings use, in the background, so you only open Siren. It only starts them when their address is on this computer, and only from their install folder or the location you set here.',
    toggle('helperApps.autoStart', 'Start them with Siren, and again when they are needed and not running'),
    toggle('helperApps.minimize', 'Keep their windows minimized (in the taskbar)'),
    toggle('helperApps.stopOnQuit', 'Close them when I quit Siren (only the ones Siren started)'),
    list,
    el('div', { class: 'grid2' },
      text('helperApps.voicestudioPath', 'VoiceStudio location (optional)', { placeholder: 'Found automatically', hint: 'The program file, e.g. VoiceStudio.exe.', onChange: debounceAfter(refresh) }),
      text('helperApps.freellmapiPath', 'FreeLLMAPI location (optional)', { placeholder: 'Found automatically', hint: 'The program file, e.g. FreeLLMAPI.exe.', onChange: debounceAfter(refresh) }),
    ),
  );
}

function remoteCard() {
  const statusBox = el('div', { class: 'hint' }, 'Checking…');
  const pairBox = el('div', { class: 'field hidden' });
  const devices = el('div', { class: 'health-list' });
  let pairTimer;
  const refresh = async () => {
    let st;
    try {
      st = await api.remote.status();
    } catch (err) {
      statusBox.textContent = err.message;
      return;
    }
    statusBox.textContent = st.error ? `✕ ${st.error}` : !st.enabled ? 'Off. Nothing is reachable from other devices.' : st.listening ? `Listening at ${st.urls.join(', ') || '(no network address found)'}` : 'Starting…';
    const t = st.enabled && TUNNEL_STATE(st.tunnel);
    if (t) statusBox.append(el('br'), t);
    devices.innerHTML = '';
    if (!st.devices.length) devices.append(el('div', { class: 'muted' }, 'No paired devices.'));
    for (const d of st.devices) {
      const seen = d.connected ? 'connected now' : d.lastSeen ? `last seen ${new Date(d.lastSeen).toLocaleString()}` : 'never used';
      const from = d.lastVia ? ` · via ${d.lastVia}${d.lastIp && d.lastVia !== 'this computer' ? ` (${d.lastIp})` : ''}` : '';
      const watch = d.watch ? watchFaceLine(d) : '';
      // The item is a three-column grid (light, text, actions): both buttons share the third column.
      devices.append(el('div', { class: `health-item ${d.connected ? 'ok' : 'off'}` },
        el('span', { class: 'ic' }, d.connected ? '●' : '○'),
        el('div', { style: { flex: 1 } }, el('b', {}, d.name, d.readOnly ? ' · view only' : ''), el('div', { class: 'd' }, `Paired ${new Date(d.createdAt).toLocaleDateString()} · ${seen}${from}`), watch ? el('div', { class: 'd' }, watch) : null),
        el('div', { class: 'row device-actions' },
          el('button', {
            class: 'btn small',
            title: d.readOnly ? 'Let this device chat, answer approvals and check habits off again' : 'This device can only read: no chatting, approvals, push-to-talk or checking habits off (a shared tablet, a display)',
            onclick: async () => {
              await api.remote.setReadOnly(d.id, !d.readOnly).catch(toastError);
              refresh();
            },
          }, d.readOnly ? 'Allow full access' : 'Make view only'),
          el('button', {
            class: 'btn small',
            onclick: async () => {
              if (!(await confirmDialog('Remove device', `“${d.name}” will no longer be able to reach the assistant.`, 'Remove'))) return;
              await api.remote.revoke(d.id).catch(toastError);
              refresh();
            },
          }, 'Remove'),
        ),
      ));
    }
    if (st.devices.length > 1) {
      devices.append(el('div', { class: 'row' }, el('button', {
        class: 'btn small danger',
        onclick: async () => {
          if (!(await confirmDialog('Remove all devices', 'Every paired phone and computer loses access at once (for example if one was lost). Pair them again to use them.', 'Remove all'))) return;
          await api.remote.revokeAll().catch(toastError);
          refresh();
        },
      }, 'Remove all devices')));
    }
  };
  refreshRemote = () => {
    pairBox.classList.add('hidden');
    clearInterval(pairTimer);
    refresh();
  };
  const startPair = async () => {
    try {
      const p = await api.remote.pair();
      clearInterval(pairTimer);
      const left = el('span', { class: 'muted' });
      const qrBox = el('div', { class: 'qr-box' });
      const tick = () => {
        const s = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
        left.textContent = s ? `expires in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'expired — start again';
        if (!s) {
          clearInterval(pairTimer);
          qrBox.replaceChildren(); // an expired code shouldn't stay on screen
        }
      };
      // The QR code opens the phone app and pairs it in one step. Prefer the secure address.
      const links = [...p.links].sort((a, b) => b.secure - a.secure);
      const showQr = (link) => {
        qrBox.replaceChildren(el('div', { class: 'qr' }, qrCanvas(link.link, { scale: 5 })), el('div', { class: 'hint' }, link.secure ? `Opens ${link.url} (encrypted).` : `Opens ${link.url}. Not encrypted: scan it on your home network only.`));
      };
      pairBox.innerHTML = '';
      if (links.length) {
        pairBox.append(el('label', {}, 'Scan with the phone’s camera'));
        if (links.length > 1) {
          const pick = el('select', { onchange: (e) => showQr(links[e.target.selectedIndex]) }, links.map((l) => el('option', {}, `${l.url}${l.secure ? ' (secure)' : ''}`)));
          pairBox.append(pick);
        }
        pairBox.append(qrBox);
        showQr(links[0]);
      } else {
        pairBox.append(el('div', { class: 'hint warn' }, 'No address another device can reach yet, so there is no QR code. Turn on “Reachable from other devices on my network” or a secure address above.'));
      }
      pairBox.append(
        el('label', {}, links.length ? 'Or type this code' : 'Pairing code'),
        el('div', { class: 'row' }, el('b', { class: 'display', style: { fontSize: '28px', letterSpacing: '0.3em' } }, p.code), left),
        el('div', { class: 'hint' }, `On the device, open ${p.urls.join(' or ')} and enter this code. The code and the QR code work once, for one device.`),
        el('div', { class: 'row' }, el('button', {
          class: 'btn small',
          onclick: async () => {
            await api.remote.cancelPair().catch(() => {});
            refreshRemote();
          },
        }, 'Cancel')),
      );
      tick();
      pairTimer = setInterval(tick, 1000);
      pairBox.classList.remove('hidden');
    } catch (err) {
      toastError(err);
    }
  };
  refreshRemoteStatus = refresh;
  refresh();
  return card(
    'remote',
    'Remote access',
    'Talk to the assistant from your phone (the Android app or any browser) or another computer. The brain, memory and keys stay on this computer; paired devices can chat, read conversations and answer approvals, never change settings. Remote messages never include a screenshot of this desktop. While it is on, a “Remote” badge shows at the top; click it to turn everything off.',
    toggle('remote.enabled', 'Turn on remote access', refresh),
    toggle('remote.lan', 'Reachable from other devices on my network (otherwise only from this computer)', refresh),
    toggle('remote.shareData', 'Show my notes, memories, habits, learning, skill tree and Inner World on paired devices (read-only; habits can be checked off)'),
    text('remote.port', 'Port', { type: 'number', onChange: debounceAfter(refresh) }),
    ...tunnelFields(),
    statusBox,
    el('div', { class: 'hint' }, 'On the local network the connection is not encrypted. Use it only at home or on another network you trust; the secure address (above) is encrypted and also makes push-to-talk work on the phone.'),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: startPair }, '📱 Pair a device')),
    pairBox,
    field('Paired devices', devices),
    watchGuide(),
  );
}

// Installing the Galaxy Watch app (also the vault note "Install on your Galaxy Watch", main/guides/).
function watchGuide() {
  const steps = [
    ['Before you start', 'The Siren phone app is paired with this computer, and the phone and watch apps come from the <b>same release</b> (they only talk to each other when signed with the same key). The watch and this computer are on the same Wi-Fi. On this computer you need Android’s <b>platform-tools</b> (the <code>adb</code> program; Android Studio includes it).'],
    ['On the watch', '<b>Settings → About watch → Software information</b>: tap <b>Software version</b> five times. Then <b>Settings → Developer options</b>: turn on <b>ADB debugging</b> and <b>Wireless debugging</b>, and tap <b>Pair new device</b>: it shows an address and a six-digit code. Keep the watch screen on (its Wi-Fi sleeps with the screen).'],
    ['On this computer', 'In a terminal: <code>adb pair &lt;address from Pair new device&gt;</code> (enter the code), <code>adb connect &lt;address on the Wireless debugging screen&gt;</code>, then <code>adb install Siren-Wear-x.y.z.apk</code> (from the same release as the phone app). Or ask Siren “install yourself on my watch”: with adb on this computer she runs these steps, each command with your approval.'],
    ['First start', 'Open Siren on the watch and keep the screen on for a moment: the first time it brings her face from this computer. For Allow / Deny on the wrist, turn on notifications in the phone app’s menu. Afterwards, turn Wireless debugging off on the watch.'],
  ];
  return el('details', { class: 'ts-guide' },
    el('summary', {}, '⌚ Install Siren on a Galaxy Watch (4 or newer)'),
    ...steps.map(([title, html], i) => el('div', { class: 'ts-step' }, el('b', {}, `${i + 1}. ${title}`), el('div', { class: 'hint', html }))),
    el('div', { class: 'hint' }, 'The full walkthrough, with what to do when something doesn’t work, is the note “Install on your Galaxy Watch” in your vault (Notes).'),
  );
}

async function healthCard() {
  const list = el('div', { class: 'health-list' }, el('div', { class: 'muted' }, 'Run diagnostics to check every part of the agent.'));
  const logBox = el('pre', { class: 'log-view hidden' });
  const hwBox = el('div', { class: 'field hidden' });
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
      el('button', { class: 'btn', onclick: () => (hwBox.classList.remove('hidden'), scanInto(hwBox)) }, '🖥 Scan hardware'),
      el('button', { class: 'btn', onclick: async () => (await import('./setup.js')).startSetup() }, '✦ Set me up by conversation'),
      el('button', { class: 'btn', onclick: async () => (await import('./onboarding.js')).startOnboarding() }, 'Setup form'),
    ),
    toggle('logging.debug', 'Detailed logging (more lines, for hunting a bug; turn off afterwards)'),
    hwBox,
    list,
    logBox,
  );
}

// Performance (perf.js, perfcore.js): the profile, what the hardware check found, and checking again.
function performanceControls() {
  const info = el('div', { class: 'hint' });
  const show = () => {
    const p = state.settings.perf || {};
    const hw = p.hw || {};
    const using = profile(state.settings) === 'balanced' ? 'Balanced' : 'Full';
    const found = p.detectedAt ? `This computer: ${hw.ramGB ?? '?'} GB of memory${hw.gpu ? `, ${hw.gpu}` : ''}${hw.vramGB ? ` (${hw.vramGB} GB)` : ''}${p.detected === 'low' ? ` — lighter (${hw.reason})` : ''}.` : 'This computer has not been checked yet.';
    info.textContent = `${found} In use: ${using}.`;
  };
  show();
  const again = el('button', {
    class: 'btn small',
    onclick: async () => {
      again.disabled = true;
      try {
        await detect();
        show();
        toast(`Checked: ${profile(state.settings) === 'balanced' ? 'Balanced' : 'Full'} performance is in use.`);
      } catch (err) {
        toastError(err);
      } finally {
        again.disabled = false;
      }
    },
  }, 'Check this computer again');
  return [
    select('perf.mode', 'Performance', [['auto', 'Auto — chosen for this computer'], ['full', 'Full — everything, for a strong computer'], ['balanced', 'Balanced — for lighter computers']], {
      hint: 'Balanced: speech recognition runs on the processor with a smaller model, loads only when you talk and unloads after 10 quiet minutes (in-app recognition needs over 1 GB while loaded, whatever the model; cloud recognition in Voice input avoids that entirely). Effects keep their look without motion or blur and pause while the window is in the background; faces draw at 30 fps without glow; at most two Claude sessions stay alive. Full keeps everything.',
      onChange: show,
    }),
    el('div', { class: 'row' }, info, again),
  ];
}

function uiCard() {
  const zoom = el('input', { type: 'range', min: '0.5', max: '2', step: '0.05', value: state.settings.ui.zoom || 1, style: { flex: 1 } });
  const zoomLabel = el('span', { class: 'muted' }, `${Math.round((state.settings.ui.zoom || 1) * 100)}%`);
  zoom.addEventListener('input', () => {
    zoomLabel.textContent = `${Math.round(Number(zoom.value) * 100)}%`;
    setZoom(Number(zoom.value));
  });
  return card(
    'ui',
    'Interface',
    'Zoom: Ctrl + / Ctrl − / Ctrl 0, or Ctrl + mouse wheel. Layouts: Ctrl+Shift+1 chat only, 2 side by side, 3 face. F11: full screen.',
    field('Zoom', el('div', { class: 'row' }, zoom, zoomLabel)),
    ...performanceControls(),
    select('ui.fx', 'Visual effects', [['hud', 'Futuristic — HUD frames, ambient grid, boot sequence, animations'], ['subtle', 'Subtle — HUD frames and readouts, no motion'], ['off', 'Off — the plain look']], { hint: 'Follows the theme colors. With “reduce motion” on in your system, animations stay off.' }),
    select('ui.chatLayout', 'Chat layout', [['chat', 'Chat only (full width)'], ['split', 'Chat and face side by side'], ['face', 'Face full size, chat underneath']], { onChange: () => emit('layout') }),
    toggle('ui.captions', 'Show captions on the face'),
    toggle('ui.showClaudeUsage', 'Show how much of the Claude plan is left (title bar, when the Claude account brain is used)'),
    toggle('ui.showSystemStats', 'Show CPU, RAM and GPU load in the title bar (click it for details; only you see these, they never go to the AI)'),
    text('ui.sleepAfterMin', 'Face dozes off after (minutes without activity; 0 = never)', { type: 'number' }),
    toggle('ui.sleepOnLaunch', 'Asleep when the app starts, until the greeting or the first thing you do'),
  );
}
