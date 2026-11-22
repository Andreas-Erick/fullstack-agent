// Voice output and voice input: the speaking voices (VoiceStudio, cloud, offline), speech-to-text, the
// microphone and hands-free controls.
import { api, el, toast, toastError, confirmDialog, emit } from '../util.js';
import { state } from '../state.js';
import { speaker, preloadLocalModel, listMics, handsFree, testLocalVoice, forgetVoiceLines } from '../voice.js';
import { KOKORO_VOICES } from '../kokorotext.js';
import { previewThinkingSound, thinkingStyle } from '../sounds.js';
import { speechPlan } from '../perfcore.js';
import { LANGUAGE_NAMES } from '../practice.js';
import { voiceStudioShown, accelerator, acceleratorLabel } from '../settingsmode.js';
import { save, queueSave, render } from './core.js';
import { text, toggle, select, fillSelect, field, card, result, showResult } from './fields.js';

const WHISPER_MODELS = [
  ['', 'Automatic: chosen for this computer (recommended)'],
  ['onnx-community/whisper-large-v3-turbo', 'Whisper large-v3 turbo (~1.6 GB; needs a strong computer: 32 GB of memory and an 8 GB graphics card, or Performance set to Full)'],
  ['Xenova/whisper-tiny.en', 'Whisper tiny (English, ~40 MB)'],
  ['Xenova/whisper-base.en', 'Whisper base (English, ~80 MB, best without a GPU)'],
  ['Xenova/whisper-small.en', 'Whisper small (English, ~250 MB)'],
  ['Xenova/whisper-base', 'Whisper base (multilingual)'],
  ['Xenova/whisper-small', 'Whisper small (multilingual)'],
];

// The model download lines of the latest render's cards (index.js fills them in on stt-progress / tts-progress).
export let sttProgressEl = null;
export let ttsProgressEl = null;

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

export function voiceCard() {
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
  if (voiceStudioShown(state.settings.voice.engine)) loadVoices(true);
  const sample = el('input', { class: 'input', value: `Hello, I'm ${state.settings.agent.name}. All systems are online.` });
  const out = result();
  // "Test voice" asks the voice service in use (VoiceStudio or the cloud); the offline voice has its own test.
  const engine = state.settings.voice.engine;
  const service = engine === 'cloud' ? (state.settings.cloudVoice?.provider === 'openai' ? 'OpenAI' : 'Groq') : 'VoiceStudio';
  const test = engine === 'local' ? '' : el('button', {
    class: 'btn primary',
    onclick: async () => {
      showResult(out, true, 'Synthesizing…');
      try {
        const t0 = performance.now();
        await api.tts.speak('test');
        showResult(out, true, `✓ ${service} responded in ${Math.round(performance.now() - t0)} ms — playing sample.`);
        speaker.say(sample.value);
        emit('status-refresh');
      } catch (err) {
        showResult(out, false, `✕ ${err.message}`);
      }
    },
  }, '🔊 Test voice');
  ttsProgressEl = el('div', { class: 'hint' });
  const testLocal = el('button', {
    class: engine === 'local' ? 'btn primary' : 'btn',
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
  const speedLabel = el('span', { class: 'muted num' }, `${Number(state.settings.voice.speed).toFixed(2)}×`);
  speed.addEventListener('input', () => {
    speedLabel.textContent = `${Number(speed.value).toFixed(2)}×`;
    queueSave('voice.speed', Number(speed.value));
  });
  return card(
    'voice',
    'Voice output',
    'Replies are spoken sentence by sentence while they stream. The offline voice runs in the app: free, private and without internet once downloaded. A cloud voice sounds natural with nothing to install; VoiceStudio is a separate app with voices you can clone.',
    el('div', { class: 'grid2' }, toggle('voice.ttsEnabled', 'Enable voice', () => emit('status-refresh')), toggle('voice.autoSpeak', 'Speak replies automatically')),
    text('voice.speakLimit', 'Read aloud at most (characters of a reply; 0 = everything)', { type: 'number', hint: 'A long result (a report, a list of papers) is read up to here, then she says the rest is on screen. 1500 is about a minute and a half.' }),
    el('div', { class: 'grid2' }, select('voice.engine', 'Which voice speaks', [['local', 'Offline voice (Kokoro, in the app)'],['voicestudio', 'VoiceStudio (separate app)'], ['cloud', 'Cloud voice (Groq or OpenAI)']], { onChange: () => (emit('status-refresh'), render()) }), select('voice.localVoice', 'Offline voice', KOKORO_VOICES)),
    state.settings.voice.engine === 'cloud' ? cloudVoiceFields() : '',
    // VoiceStudio's own fields, only when it is the voice (in either mode); its address and keys are advanced.
    ...(voiceStudioShown(engine) ? [
      text('voice.baseUrl', 'VoiceStudio address', { placeholder: 'http://localhost:3900', advanced: true }),
      text('voice.apiKey', 'VoiceStudio access key', { type: 'password', placeholder: 'optional', advanced: true }),
      field('VoiceStudio voice', el('div', { class: 'row' }, voiceSel, el('button', { class: 'btn', onclick: () => loadVoices(false) }, '⟳ Load voices')), 'Saved with the current persona, like the offline voice.'),
      el('div', { class: 'grid2' }, text('voice.voice', 'Voice id (manual)', { placeholder: 'e.g. af_heart', advanced: true, onChange: (v) => fillSelect(voiceSel, [['', '(server default)'], ...[...voiceSel.options].slice(1).map((o) => [o.value, o.textContent])], v) }), text('voice.model', 'Speech model', { placeholder: 'tts-1', advanced: true })),
    ] : []),
    el('div', { class: 'grid2' }, field('Speed', el('div', { class: 'row' }, speed, speedLabel)), select('voice.format', 'Audio format', ['mp3', 'wav', 'opus', 'flac'], { advanced: true })),
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
    el(
      'div',
      { class: 'row' },
      test,
      testLocal,
      el('button', { class: 'btn', onclick: () => speaker.stop() }, '■ Stop'),
      el('button', { class: 'btn', title: 'Siren keeps the audio of lines she says often (her greeting, the short "one moment" lines) so they play at once. Forget them if one ever sounds wrong; they are made again.', onclick: async () => toast((await forgetVoiceLines()) ? 'Saved voice lines forgotten; they are made again.' : 'No saved voice lines yet.') }, 'Forget saved voice lines'),
    ),
    out,
    ttsProgressEl,
  );
}

export function sttCard() {
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
  // The button sits level with the input (the hint goes under both), as the brain's 'Get a key ↗' does.
  const groqKey = () => {
    const key = text('groq.apiKey', 'Groq API key', { type: 'password', placeholder: 'gsk_…' });
    const input = key.querySelector('input');
    input.setAttribute('aria-describedby', `${input.id}-hint`);
    return el(
      'div',
      { class: 'field' },
      el('div', { class: 'row' }, el('div', { style: { flex: 1 } }, key), el('button', { class: 'btn small', style: { alignSelf: 'flex-end' }, onclick: () => api.shell.openExternal('https://console.groq.com/keys') }, 'Get a free key ↗')),
      el('div', { class: 'hint', id: `${input.id}-hint` }, 'Free, no card: sign up at console.groq.com and create a key. Also used by the Groq AI brain.'),
    );
  };
  const groqModel = () => select('stt.groqModel', 'Groq model', [['whisper-large-v3-turbo', 'Whisper Large v3 Turbo: fastest, ~$0.04 per audio hour'], ['whisper-large-v3', 'Whisper Large v3: a little more accurate, ~$0.11 per audio hour']], { hint: 'Both are free within Groq’s daily free allowance.' });
  const cloudNote = el('div', { class: 'hint' }, 'With the cloud, what you say is sent to Groq to be written down (not your conversations or files). Local Whisper keeps your voice on this computer.');
  if (engine === 'local') {
    children.push(
      select('stt.localModel', 'Speech recognition model (Whisper)', WHISPER_MODELS, { advanced: true, hint: `Downloaded once from Hugging Face, then cached. Runs on GPU (WebGPU) when available. On this computer it uses <b>${speechPlan(state.settings).model.split('/').pop()}</b>. It loads at launch only if you used voice input this week, otherwise when you first press the talk key.`, onChange: () => render() }),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => (progress.textContent = 'Loading…', preloadLocalModel()) }, '⬇ Download / load model now')),
      progress,
      toggle('stt.cloudFallback', 'Use Groq in the cloud while local Whisper is loading or if it fails', () => render()),
    );
    if (state.settings.stt.cloudFallback) children.push(groqKey(), groqModel(), cloudNote);
  } else if (engine === 'groq') {
    children.push(groqKey(), groqModel(), cloudNote);
  } else {
    children.push(
      el('div', { class: 'hint' }, 'Your own speech-to-text server: its address, key and model are under Show advanced.'),
      text('stt.remoteUrl', 'Speech-to-text server address', { placeholder: 'defaults to the FreeLLMAPI URL', hint: 'POSTs to <code>{url}/audio/transcriptions</code>.', advanced: true }),
      el('div', { class: 'grid2' }, text('stt.remoteKey', 'Access key', { type: 'password', placeholder: 'defaults to the FreeLLMAPI token', advanced: true }), text('stt.remoteModel', 'Model', { placeholder: 'whisper-1', advanced: true })),
    );
  }
  children.push(
    el('div', { class: 'grid2' }, select('stt.language', 'Language you speak', [['', 'Not chosen (English)'], ...LANGUAGES], { hint: 'What speech is written down in (not chosen: English on this computer; a cloud service works it out). Language practice listens for its own language.' }), field('Push-to-talk key (hold)', keyBtn, 'Works anywhere in the app.')),
    shortcutField(),
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

// The languages speech can be written down in, by name (the setting keeps the code, 'en').
const LANGUAGES = Object.entries(LANGUAGE_NAMES).sort((a, b) => a[1].localeCompare(b[1]));

// The voice shortcut (stt.globalShortcut), recorded by pressing the keys (settingsmode.js accelerator) and
// saved as the Electron accelerator main registers; a refusal (keys another app holds) is main's log line.
function shortcutField() {
  const mac = /Mac/.test(navigator.platform || navigator.userAgent || '');
  const label = (a) => acceleratorLabel(a, { mac });
  const btn = el('button', { class: 'btn', type: 'button', 'data-setting': 'stt.globalShortcut' }, label(state.settings.stt.globalShortcut));
  const note = el('div', { class: 'hint', role: 'status' }, 'Press once to start listening from anywhere (even when the app is in the background), again to stop.');
  const field_ = field('Shortcut to start listening from anywhere', btn);
  const title = field_.querySelector('label');
  title.id = `set-shortcut-${Math.random().toString(36).slice(2, 8)}`;
  btn.id = `${title.id}-btn`;
  btn.setAttribute('aria-labelledby', `${title.id} ${btn.id}`);
  let handler = null;
  const stop = (text) => {
    window.removeEventListener('keydown', handler, true);
    btn.removeEventListener('blur', cancel);
    handler = null;
    btn.textContent = text;
    btn.removeAttribute('aria-pressed');
  };
  const cancel = () => handler && stop(label(state.settings.stt.globalShortcut));
  btn.addEventListener('click', () => {
    if (handler) return;
    btn.textContent = 'Press the keys…';
    btn.setAttribute('aria-pressed', 'true');
    note.textContent = 'Hold Ctrl or Alt and press a key (a function key works alone). Esc keeps the old one; Backspace turns it off.';
    handler = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = accelerator(e, { mac });
      if (r.waiting) return void (r.why && (note.textContent = `${r.why} to that key: alone it would fire while you type.`));
      if (r.cancel) return cancel();
      stop('Saving…');
      const ok = await save('stt.globalShortcut', r.accel);
      btn.textContent = label(ok ? r.accel : state.settings.stt.globalShortcut);
      note.textContent = ok ? (r.accel ? `Saved: ${label(r.accel)}. If another app already uses these keys, the shortcut won’t work; pick others.` : 'The shortcut is off.') : 'Not saved.';
    };
    window.addEventListener('keydown', handler, true);
    btn.addEventListener('blur', cancel);
  });
  field_.append(note);
  return field_;
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
    class: 'btn small danger',
    onclick: async () => {
      if (!(await confirmDialog('Forget the calibration?', 'The corrections and words it learned from your voice go. You can calibrate again any time.', 'Forget'))) return;
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
  info.append(el('div', { class: 'row' }, clear));
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
  const label = el('span', { class: 'muted num' }, `${(value / 1000).toFixed(1)} s`);
  const r = el('input', { type: 'range', min: '300', max: '2000', step: '100', value, style: { width: '100%' } });
  r.addEventListener('input', () => {
    label.textContent = `${(Number(r.value) / 1000).toFixed(1)} s`;
    queueSave('stt.endSilenceMs', Number(r.value));
  });
  return el('div', {}, r, label);
}
