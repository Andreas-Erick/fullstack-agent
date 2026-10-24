// First-run setup wizard: one question at a time, nothing destructive, an optional hardware check that
// recommends the speech model and the kind of brain that fits, and a "first hello" end-to-end test
// (voice speaks, brain answers, vault writable, mic works) with fixes for anything red.
import { $, api, el, toast, toastError } from './util.js';
import { state, saveSettings } from './state.js';
import { speaker, listMics } from './voice.js';
import { BUILT_IN } from './faces/host.js';
import { scanInto } from './hwscan.js';

const STEPS = ['welcome', 'hardware', 'persona', 'brain', 'voice', 'vault', 'face', 'safety', 'hello'];
const STEP_NAMES = { welcome: 'Welcome', hardware: 'Your computer', persona: 'Personality', brain: 'Brain', voice: 'Voice', vault: 'Memory', face: 'Face', safety: 'Permissions', hello: 'First hello' };
let step = 0;
const draft = {};

export function maybeStartOnboarding() {
  if (!state.settings.onboarded) startOnboarding();
}

export function startOnboarding() {
  step = 0;
  $('#onboarding').classList.remove('hidden');
  render();
}

function finish() {
  $('#onboarding').classList.add('hidden');
  saveSettings({ onboarded: true });
}

function choices(options, value, onPick) {
  const box = el('div', { class: 'ob-choices' });
  const draw = (v) => {
    box.innerHTML = '';
    for (const o of options) {
      box.append(el('button', { class: `ob-choice ${o.value === v ? 'sel' : ''}`, onclick: () => (onPick(o.value), draw(o.value)) }, o.ico ? el('span', { class: 'ico' }, o.ico) : '', el('span', {}, el('b', {}, o.title), el('small', {}, o.desc || ''))));
    }
  };
  draw(value);
  return box;
}

function input(value, placeholder, onInput, type = 'text') {
  const i = el('input', { class: 'input', value: value ?? '', placeholder, type, spellcheck: 'false' });
  i.addEventListener('input', () => onInput(i.value));
  return i;
}

const field = (label, control, hint) => el('div', { class: 'field' }, el('label', {}, label), control, hint ? el('div', { class: 'hint', html: hint }) : '');

async function render() {
  const s = state.settings;
  const card = el('div', { class: 'ob-card glass' });
  const id = STEPS[step];
  card.append(
    el('div', { class: 'ob-head' }, el('span', {}, `Step ${step + 1} of ${STEPS.length}`), el('b', {}, STEP_NAMES[id])),
    el('div', { class: 'ob-steps' }, STEPS.map((_, i) => el('span', { class: i <= step ? 'on' : '' }))),
  );
  const body = el('div', { class: 'field', style: { gap: '12px' } });
  card.append(body);
  let beforeNext = async () => {};

  if (id === 'welcome') {
    draft.name = draft.name || s.agent.name;
    body.append(
      el('h2', {}, 'Let’s build your agent'),
      el('p', { class: 'muted' }, 'A few quick questions, one at a time. You can change everything later in Configuration, and nothing you already have is overwritten.'),
      field('What should your agent be called?', input(draft.name, 'Nexus', (v) => (draft.name = v))),
    );
    beforeNext = () => saveSettings({ agent: { name: draft.name.trim() || 'Nexus' } });
  }

  if (id === 'hardware') {
    const box = el('div', { class: 'field' });
    const scan = el('button', { class: 'btn primary', onclick: async () => ((scan.disabled = true), (draft.hw = await scanInto(box)), (scan.disabled = false)) }, '🖥 Scan my hardware');
    body.append(
      el('h2', {}, 'Check this computer?'),
      el('p', { class: 'muted' }, 'Optional. A quick look at the processor, memory and graphics card tells you which speech model runs best here, and whether a local AI model would run well or a cloud brain is the better choice. Nothing leaves this computer. Skip it with Next.'),
      el('div', { class: 'row' }, scan),
      box,
    );
  }

  if (id === 'persona') {
    draft.persona ||= 'keep';
    const custom = el('div', { class: 'field', style: { display: draft.persona === 'custom' ? '' : 'none' } });
    const prompt = el('textarea', { class: 'input', rows: 6, placeholder: 'Who is your agent? How does it talk, what does it care about, how should it treat you?' });
    prompt.value = s.agent.personality;
    const aesthetic = input(s.agent.aesthetic, 'e.g. 90s cyberpunk terminal, warm solarpunk greenhouse, minimal Scandinavian', () => {});
    custom.append(field('Master prompt', prompt), field('Aesthetic / style (optional)', aesthetic, 'Later, “Generate look & feel” in Configuration restyles the whole app to match.'));
    body.append(
      el('h2', {}, 'Personality'),
      choices(
        [
          { value: 'keep', ico: '🙂', title: 'Use the default persona', desc: 'Warm, sharp co-pilot. You can edit it any time.' },
          { value: 'custom', ico: '✍', title: 'Write my own', desc: 'Your own master prompt and aesthetic.' },
        ],
        draft.persona,
        (v) => ((draft.persona = v), (custom.style.display = v === 'custom' ? '' : 'none')),
      ),
      custom,
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { const img = await api.dialog.pickImage(); if (img) { await saveSettings({ agent: { avatar: img } }); toast('Image set'); } } }, '🖼 Choose an image for the agent (optional)')),
    );
    beforeNext = async () => {
      if (draft.persona === 'custom') await saveSettings({ agent: { personality: prompt.value, aesthetic: aesthetic.value } });
    };
  }

  if (id === 'brain') {
    draft.provider ||= s.llm.provider;
    const area = el('div', { class: 'field' });
    const out = el('div', { class: 'test-result hidden' });
    const drawArea = async () => {
      area.innerHTML = '';
      if (draft.provider === 'claude-code') {
        const st = await api.claude.status().catch(() => ({}));
        if (!st.installed) area.append(el('div', { class: 'test-result err' }, `Claude Code isn’t installed. Install it, then click Re-check:\n  ${await api.claude.installHint()}`));
        else if (!st.loggedIn) area.append(el('div', { class: 'test-result' }, `Claude Code ${st.version} found — connect your account:`), el('button', { class: 'btn primary', onclick: () => api.claude.login() }, 'Connect Claude account'));
        else area.append(el('div', { class: 'test-result ok' }, `✓ Connected as ${st.email} (${st.subscription || st.authMethod} plan)`));
        area.append(el('button', { class: 'btn', onclick: drawArea }, '⟳ Re-check'));
      } else if (draft.provider === 'openai') {
        area.append(
          field('FreeLLMAPI URL', input(s.llm.baseUrl, 'http://localhost:3001/v1', (v) => saveSettings({ llm: { baseUrl: v } }))),
          field('Bearer token', input(s.llm.apiKey, 'optional', (v) => saveSettings({ llm: { apiKey: v } }), 'password')),
        );
      } else {
        area.append(field('Anthropic API key', input(s.anthropic.apiKey, 'sk-ant-…', (v) => saveSettings({ anthropic: { apiKey: v } }), 'password')));
      }
      if (draft.provider === 'auto') {
        area.innerHTML = '';
        area.append(
          el('p', { class: 'muted', style: { margin: 0 } }, 'Uses every provider you set up, best one first, and switches automatically when one hits a rate limit or runs out of credits. Add the keys you have (all optional; your Claude account is used if it is connected). You can rank them and add more later in Configuration → AI brain.'),
          field('Gemini API key (free tier)', input(s.gemini.apiKey, 'optional', (v) => saveSettings({ gemini: { apiKey: v } }), 'password'), 'Get one at <a href="https://aistudio.google.com/apikey">aistudio.google.com</a>.'),
          field('Groq API key (free tier, very fast)', input(s.groq.apiKey, 'optional', (v) => saveSettings({ groq: { apiKey: v } }), 'password'), 'Get one at <a href="https://console.groq.com/keys">console.groq.com</a>.'),
          field('Anthropic API key', input(s.anthropic.apiKey, 'optional', (v) => saveSettings({ anthropic: { apiKey: v } }), 'password')),
        );
      }
    };
    if (draft.hw?.rec?.brain) body.append(el('div', { class: 'rec' }, el('span', {}, el('b', {}, 'From the hardware check: '), draft.hw.rec.brain.why)));
    body.prepend(el('h2', {}, 'The brain'));
    body.append(
      choices(
        [
          { value: 'claude-code', ico: '✦', title: 'My Claude account', desc: 'Recommended. Uses your Claude subscription through Claude Code.' },
          { value: 'auto', ico: '⇄', title: 'Several providers', desc: 'Claude, Gemini, Groq, DeepSeek, Perplexity… with automatic fallback when one hits a limit.' },
          { value: 'openai', ico: '⌂', title: 'FreeLLMAPI / local', desc: 'A local OpenAI-compatible server (also Ollama, LM Studio).' },
          { value: 'anthropic', ico: '🔑', title: 'Anthropic API key', desc: 'Pay-per-use API.' },
        ],
        draft.provider,
        async (v) => ((draft.provider = v), await saveSettings({ llm: { provider: v } }), drawArea()),
      ),
      area,
      el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { out.className = 'test-result'; out.textContent = 'Testing…'; try { const r = await api.llm.test(); out.className = 'test-result ok'; out.textContent = `✓ ${r.model} replied “${r.reply}” in ${r.ms} ms`; } catch (e) { out.className = 'test-result err'; out.textContent = `✕ ${e.message}`; } } }, '⚡ Test')),
      out,
    );
    drawArea();
    beforeNext = () => saveSettings({ llm: { provider: draft.provider } });
  }

  if (id === 'voice') {
    const out = el('div', { class: 'test-result hidden' });
    const meter = el('div', { class: 'mic-meter' }, el('i'));
    const mics = el('select', { class: 'input' });
    listMics().then((list) => {
      mics.innerHTML = '';
      mics.append(el('option', { value: '' }, 'System default'));
      for (const m of list) mics.append(el('option', { value: m.label, selected: m.label === s.stt.micDevice }, m.label));
    });
    mics.addEventListener('change', () => saveSettings({ stt: { micDevice: mics.value } }));
    body.append(
      el('h2', {}, 'Voice'),
      field('VoiceStudio URL (spoken replies)', input(s.voice.baseUrl, 'http://localhost:3900', (v) => saveSettings({ voice: { baseUrl: v } }))),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => { speaker.say(`Hello, I'm ${state.settings.agent.name}.`); out.className = 'test-result'; out.textContent = 'Speaking… (if VoiceStudio is off, the system voice is used)'; } }, '🔊 Test voice')),
      out,
      field('Microphone', mics),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => testMic(meter) }, '🎙 Test mic (3 s)'), el('div', { style: { flex: 1 } }, meter)),
      el('div', {}, el('b', {}, 'How do you want to talk?')),
      choices(
        [
          { value: 'ptt', ico: '🎙', title: 'Push to talk', desc: `Hold ${s.stt.pttKey} or the mic button. Never hears the speakers.` },
          { value: 'open', ico: '👂', title: 'Hands-free', desc: 'Always listening with voice detection. Headphones recommended.' },
        ],
        s.stt.micMode,
        (v) => saveSettings({ stt: { micMode: v } }),
      ),
    );
  }

  if (id === 'vault') {
    const known = await api.obsidian.vaults().catch(() => []);
    const def = await api.obsidian.defaultPath();
    draft.vault ??= s.obsidian.vaultPath || '';
    const opts = [{ value: '', title: 'Create its own vault', desc: def }, ...known.filter((v) => v.exists).map((v) => ({ value: v.path, title: `Use “${v.name}”`, desc: `${v.path} — structure is added, nothing is overwritten` }))];
    body.append(
      el('h2', {}, 'Memory vault'),
      el('p', { class: 'muted' }, 'The agent keeps its long-term memory, notes, daily journal and priorities in an Obsidian vault (plain Markdown files).'),
      choices(opts, draft.vault, (v) => (draft.vault = v)),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { const d = await api.dialog.pickFolder('Vault folder'); if (d) { draft.vault = d; render(); } } }, 'Choose another folder…')),
    );
    draft.register ??= true;
    const reg = el('input', { type: 'checkbox', id: 'obRegister' });
    reg.checked = draft.register;
    reg.addEventListener('change', () => (draft.register = reg.checked));
    body.append(el('label', { class: 'toggle' }, reg, el('span', { class: 'sw' }), el('span', {}, 'Also add it to Obsidian’s vault list (Obsidian must be closed; a backup of its list is kept)')));
    beforeNext = async () => {
      await saveSettings({ obsidian: { vaultPath: draft.vault, enabled: true } });
      if (draft.register) api.obsidian.register().catch((e) => toast(`Not added to Obsidian: ${e.message}`));
    };
  }

  if (id === 'face') {
    body.append(
      el('h2', {}, 'Pick a face'),
      choices(BUILT_IN.map((f) => ({ value: f.id, title: f.title, desc: f.tagline })), s.ui.face, (v) => saveSettings({ ui: { face: v } })),
    );
  }

  if (id === 'safety') {
    body.append(
      el('h2', {}, 'Permissions'),
      el('p', { class: 'muted' }, 'The agent can change its own code, its settings and delete notes. How careful should it be?'),
      choices(
        [
          { value: 'ask', ico: '🛡', title: 'Ask me first', desc: 'Recommended. You approve by click or by saying “yes”.' },
          { value: 'auto', ico: '⚡', title: 'Just do it', desc: 'Still asks before running commands, and before changing its code after reading web pages or documents.' },
        ],
        s.safety.permissionMode,
        (v) => saveSettings({ safety: { permissionMode: v } }),
      ),
    );
  }

  if (id === 'hello') {
    const list = el('div', {});
    body.append(el('h2', {}, 'First hello'), el('p', { class: 'muted' }, 'Testing everything end to end…'), list);
    firstHello(list);
  }

  const nav = el(
    'div',
    { class: 'ob-nav' },
    step === 0 ? el('button', { class: 'btn', onclick: finish }, 'Skip setup') : el('button', { class: 'btn', onclick: () => ((step -= 1), render()) }, '‹ Back'),
    step < STEPS.length - 1
      ? el('button', { class: 'btn primary', onclick: async () => { try { await beforeNext(); step += 1; render(); } catch (e) { toastError(e); } } }, 'Next ›')
      : el('button', { class: 'btn primary', onclick: finish }, 'Finish'),
  );
  card.append(nav);
  $('#onboarding').innerHTML = '';
  $('#onboarding').append(card);
}

async function testMic(meter) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ac = new AudioContext();
    const an = ac.createAnalyser();
    ac.createMediaStreamSource(stream).connect(an);
    const data = new Float32Array(an.fftSize);
    const end = performance.now() + 3000;
    const tick = () => {
      an.getFloatTimeDomainData(data);
      const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length);
      meter.firstChild.style.width = `${Math.min(100, rms * 500)}%`;
      if (performance.now() < end) requestAnimationFrame(tick);
      else {
        stream.getTracks().forEach((t) => t.stop());
        ac.close();
        meter.firstChild.style.width = '0';
      }
    };
    tick();
  } catch (e) {
    toastError(new Error(`Microphone: ${e.message}`));
  }
}

async function firstHello(list) {
  const row = (label) => {
    const r = el('div', { class: 'ob-check' }, el('span', { class: 'ic' }, '…'), el('div', {}, el('b', {}, label), el('div', { class: 'muted' }, '')));
    list.append(r);
    return (ok, detail) => {
      r.querySelector('.ic').textContent = ok === true ? '✓' : ok === null ? '–' : '✕';
      r.querySelector('.ic').style.color = ok === true ? 'rgb(var(--ok))' : ok === null ? 'var(--muted)' : 'rgb(var(--err))';
      r.querySelector('.muted').textContent = detail;
    };
  };
  const s = state.settings;
  const greet = row('Voice speaks the greeting');
  const greeting = s.appearance.greeting || `Hello, I'm ${s.agent.name}. What are we working on today?`;
  speaker.say(greeting);
  const synth = await api.tts.speak('ok').then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
  if (synth.ok) greet(true, `VoiceStudio · “${greeting}”`);
  else if (s.voice.fallbackSystemVoice) greet(null, `VoiceStudio failed (${synth.error}) — speaking with the system voice for now. Fix it in Configuration → Voice output.`);
  else greet(false, `VoiceStudio failed: ${synth.error}. Check its URL in Configuration → Voice output.`);

  const brain = row('Brain answers a question');
  try {
    const r = await api.llm.test();
    brain(true, `${r.model} · “${r.reply}” · ${r.ms} ms`);
  } catch (e) {
    brain(false, e.message);
  }
  const vault = row('Vault is writable');
  const st = await api.obsidian.status().catch(() => ({}));
  vault(Boolean(st.ok), st.ok ? `${st.path} · ${st.count} notes` : 'Vault unavailable — choose a folder in Configuration → Vault.');
  const mic = row('Microphone available');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    mic(true, s.stt.micMode === 'open' ? 'Hands-free mode' : `Hold ${s.stt.pttKey} or the mic button to talk.`);
  } catch (e) {
    mic(false, `${e.message} — allow microphone access for this app.`);
  }
}
