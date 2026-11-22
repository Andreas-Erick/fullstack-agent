// Persona studio: the saved personas, master prompt, image, face, voice, the scene behind the face and the
// theme editor. Every change is saved for the persona whose cards were on screen (core.js renderedPersona).
import { api, el, toast, toastError, confirmDialog, modal } from '../util.js';
import { state, loadSettings } from '../state.js';
import { speaker } from '../voice.js';
import { KOKORO_VOICES } from '../kokorotext.js';
import { FONTS, PATTERNS, CORE_SHAPES, TRACE_STYLES, normalizeTheme, extractPalette } from '../theme.js';
import { BUILT_IN } from '../faces/host.js';
import { switchPersona, createPersona, removePersona } from '../personas.js';
import { renderedPersona, PERSONA_CHANGED, saveForPersona, switchedAway, save, queueSave, flushSaves, render } from './core.js';
import { text, area, toggle, select, fillSelect, field, card, result, showResult } from './fields.js';

// Persona Studio: master prompt + image + aesthetic → the agent's behaviour, look & feel and voice.
export function agentCard() {
  const preview = el('div', { class: 'avatar-preview' });
  const setPreview = () => (preview.style.backgroundImage = state.settings.agent.avatar ? `url(${state.settings.agent.avatar})` : '');
  setPreview();
  const pick = el('button', {
    class: 'btn',
    style: { alignSelf: 'flex-end' }, // level with the name's input, not its label
    onclick: async () => {
      const persona = renderedPersona; // the picker can stay open while the persona changes elsewhere
      const dataUrl = await api.dialog.pickImage();
      if (!dataUrl) return;
      await save('agent.avatar', await shrinkImage(dataUrl, 384), persona);
      setPreview();
    },
  }, 'Choose image…');
  const clear = el('button', { class: 'btn', style: { alignSelf: 'flex-end' }, onclick: async () => (await save('agent.avatar', null), setPreview()) }, 'Remove');

  const out = result();
  const gen = el('button', {
    class: 'btn primary',
    onclick: async () => {
      const persona = renderedPersona; // the model takes a minute: the result belongs to this persona
      gen.disabled = true;
      try {
        if (await switchedAway('appearance.theme', persona)) return; // drawn for a persona no longer active: nothing asked
        showResult(out, true, `Designing ${state.settings.agent.name}'s look & feel… (this can take a minute)`);
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
        // The voice (persona-synced too) goes in the same save, so no switch can land between the two.
        const voice = res.voice && state.settings.appearance.applyVoice ? res.voice : '';
        if (!(await saveForPersona({ appearance: { theme, personaNotes: res.personaNotes, greeting: res.greeting }, ...(voice ? { voice: { voice } } : {}) }, persona))) return showResult(out, false, '✕ Not applied: the persona changed meanwhile.');
        const applied = `✓ Applied “${theme.name}”${voice ? ` · voice: ${voice}` : ''}.`;
        showResult(out, true, `${applied} Drawing the scene behind the face…`);
        const scene = await drawScene(persona).catch((err) => (showResult(out, true, `${applied} The scene couldn't be drawn (${err.message}); try ↻ Draw the scene below.`), undefined));
        if (scene) showResult(out, true, `${applied} Scene: ${scene.caption || 'drawn'}. Fine-tune it below.`);
        else if (scene === null) showResult(out, true, `${applied} The scene wasn’t saved: the persona changed meanwhile.`);
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
    const keep = el('button', {
      class: 'btn',
      onclick: async () => {
        try {
          const persona = renderedPersona;
          const r = await api.persona.setSummary(textBox.value, persona); // main checks the persona inside its save queue
          if (r?.dropped) {
            toast(PERSONA_CHANGED, 'error');
            return void loadSettings().catch(() => {});
          }
          show(r);
          toast(textBox.value.trim() ? 'Saved: local models read your version.' : 'Back to the written version.');
        } catch (err) {
          toastError(err);
        }
      },
    }, 'Save my version');
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
// the persona (appearance.scene) and shown by js/scene.js. null when the persona changed while it was
// drawn (nothing saved).
async function drawScene(persona = renderedPersona) {
  if (await switchedAway('appearance.scene', persona)) return null; // nothing asked for a persona no longer active
  const s = state.settings;
  const scene = await api.persona.scene({ masterPrompt: s.agent.personality, aesthetic: s.agent.aesthetic, theme: normalizeTheme(s.appearance?.theme) });
  return (await saveForPersona({ appearance: { scene } }, persona)) ? scene : null;
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
        const r = await drawScene(renderedPersona);
        if (!r) return showResult(out, false, '✕ Not saved: the persona changed meanwhile.');
        showResult(out, true, `✓ ${r.caption || 'Drawn'}.`);
        setTimeout(render, 700);
      } catch (err) {
        showResult(out, false, `✕ ${err.message}`);
      } finally {
        draw.disabled = false;
      }
    },
  }, scene ? '↻ Draw the scene again' : '✨ Draw the scene');
  const remove = scene ? el('button', { class: 'btn danger', style: { marginLeft: '4px' }, onclick: () => saveFromClick({ appearance: { scene: null } }, renderedPersona, ['Remove the scene?', 'The drawing behind the face goes. You can draw a new one any time.', 'Remove']) }, 'Remove') : '';
  return field('Scene behind the face', el('div', {}, el('div', { class: 'row' }, el('span', { class: 'hint', style: { flex: '1 1 220px', minWidth: 0 } }, scene ? `“${scene.caption || 'A scene'}” · ${Math.round(scene.svg.length / 1024)} KB${scene.portrait ? ` wide + ${Math.round(scene.portrait.length / 1024)} KB tall` : ' (wide only: narrow panels crop it)'}` : 'None yet: a drawing of the place the persona lives in, in the theme’s colors.'), draw, remove), out), 'Drawn by the AI from the persona and aesthetic, wide and tall (for the chat’s face panel); its layers drift slowly and it dims while the face sleeps.');
}

// The saved personas: pick the one to edit (and be), add, duplicate, delete. Each saves what was just
// typed first (into the persona it was typed for); the new active persona redraws the studio (initSettings).
function personaBar() {
  const p = state.settings.personas;
  const sel = el('select', { class: 'input', title: 'The persona you are editing is the active one' });
  fillSelect(sel, p.list.map((x) => [x.id, x.name || 'Unnamed']), p.active);
  sel.addEventListener('change', async () => {
    await flushSaves();
    await switchPersona(sel.value);
    sel.value = state.settings.personas.active;
  });
  const add = el('button', { class: 'btn', title: 'A fresh persona with the default prompt and look', onclick: async () => (await flushSaves(), await createPersona()) }, '＋ New');
  const fromTemplate = el('button', { class: 'btn', title: 'Ready-made personas: a STEM tutor, a polyglot coach…', onclick: () => pickTemplate() }, '🎓 Templates…');
  const dup = el('button', { class: 'btn', title: 'A copy of this persona to change', onclick: async () => (await flushSaves(), await createPersona({ copy: true })) }, '⧉ Duplicate');
  const del = el('button', {
    class: 'btn danger',
    disabled: p.list.length < 2,
    title: p.list.length < 2 ? 'Your only persona can’t be deleted' : 'Delete this persona',
    onclick: async () => {
      await flushSaves();
      const id = state.settings.personas.active; // the one named in the question, even if a switch lands meanwhile
      if (!(await confirmDialog(`Delete “${state.settings.agent.name}”?`, 'Its master prompt, image, theme, face and voice choice are removed. Memory, notes and conversations stay.', 'Delete'))) return;
      await removePersona(id);
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
      ...list.map((t) => el('div', { class: 'template-row' }, el('div', { style: { flex: 1 } }, el('b', {}, `${t.title} · ${t.name}`), el('div', { class: 'hint' }, t.blurb)), el('button', { class: 'btn', onclick: () => close(t.id) }, 'Add'))),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel')),
    );
  });
  if (!id) return;
  await flushSaves();
  await createPersona({ template: id });
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

// A persona-field change made with a button (Remove the scene, Reset the theme): for the persona whose cards
// were on screen at the click, dropped with a notice when it is no longer active; the cards redraw when saved.
// `ask` = [title, message, button]: a confirm first. The persona is still the one at the click, taken before it.
async function saveFromClick(patch, persona = renderedPersona, ask = null) {
  try {
    if (ask && !(await confirmDialog(...ask))) return;
    if (await saveForPersona(patch, persona)) render();
  } catch (err) {
    toastError(err);
  }
}

let themeEdits = Promise.resolve(); // the theme editor's edits, in order (themeEditor update)

// Live fine-tuning of the active theme (colors, fonts, background, face).
function themeEditor() {
  const theme = normalizeTheme(state.settings.appearance?.theme);
  const isDefault = !state.settings.appearance?.theme;
  // One edit at a time, each on the theme the one before saved: two quick edits both read the same theme,
  // and the second saved over the first. The persona is the one the editor was drawn for, taken at the edit.
  const update = (mutate) => {
    const persona = renderedPersona;
    themeEdits = themeEdits.then(async () => {
      try {
        const t = normalizeTheme(state.settings.appearance?.theme);
        mutate(t);
        await saveForPersona({ appearance: { theme: t } }, persona);
      } catch (err) {
        toastError(err);
      }
    });
    return themeEdits;
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
    isDefault ? '' : el('div', { class: 'row' }, el('button', { class: 'btn danger', onclick: () => saveFromClick({ appearance: { theme: null } }, renderedPersona, ['Reset the theme?', 'Your colors, fonts, background and face settings for this persona go back to the default theme.', 'Reset']) }, '↺ Reset to the default theme')),
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
