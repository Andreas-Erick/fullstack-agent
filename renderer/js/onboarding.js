// First-run setup: a guided wizard, one topic at a time, nothing destructive. It introduces the
// assistant, asks the user to read and accept the privacy and safety notice, sets up the brain, the
// voice (the offline voice by default), the vault, goals, connectors and the persona, shows a tour of
// everything the app can do (from main/guide.js, the same entries the agent uses for "how can I use
// you?"), and ends with a "first hello" test; then it offers the agent's get-to-know-you interview.
import { $, api, el, toast, toastError, on } from './util.js';
import { state, saveSettings, loadSettings } from './state.js';
import { ROUTINE_TEMPLATES } from './habits.js';
import { speaker, listMics, testLocalVoice } from './voice.js';
import { BUILT_IN, FaceHost } from './faces/host.js';
import { scanInto } from './hwscan.js';
import { KOKORO_VOICES } from './kokorotext.js';

const STEPS = ['welcome', 'privacy', 'hardware', 'brain', 'voice', 'vault', 'goals', 'connect', 'persona', 'tour', 'hello'];
const STEP_NAMES = { welcome: 'Welcome', privacy: 'Privacy & safety', hardware: 'Your computer', brain: 'Brain', voice: 'Voice', vault: 'Memory', goals: 'What you want', connect: 'Connectors & extras', persona: 'Personality & face', tour: 'What I can do', hello: 'First hello' };
const PRIVACY_URL = 'https://github.com/Andreas-Erick/fullstack-agent/blob/main/PRIVACY.md';
const CONNECTORS_URL = 'https://claude.ai/settings/connectors';

// What the user wants help with → the ready-made persona that fits (main/personatemplates.js) and
// the Claude connectors worth suggesting for it (none come with the app: docs/CONNECTORS.md).
const GOALS = [
  { value: 'study', ico: '🎓', title: 'Understanding hard things', desc: 'Math, proofs, science, tech: intuition first, then rigor', template: 'stem-tutor', persona: 'Ada', connectors: ['Wolfram (math you can trust)', 'Consensus (research papers)'] },
  { value: 'languages', ico: '🗣', title: 'Learning languages', desc: 'Conversation practice, vocabulary with spaced repetition', template: 'polyglot-coach', persona: 'Mira', connectors: ['DeepL (translation)'] },
  { value: 'life', ico: '🌱', title: 'Goals and habits', desc: 'A coach for small steps, habits and weekly reviews', template: 'life-coach', persona: 'Sol', connectors: ['Todoist or TickTick (tasks)', 'Google Calendar'] },
  { value: 'work', ico: '🗂', title: 'Work and projects', desc: 'Notes, documents, schedule, tasks, research', connectors: ['Gmail', 'Google Drive', 'Notion', 'Slack'] },
];

// Icons for the tour (main/guide.js FEATURES ids).
const TOUR_ICONS = { talk: '🎙', personas: '🎭', memory: '🧠', learning: '🎓', languages: '🗣', coaching: '🌱', skilltree: '🌳', innerworld: '🏡', routines: '⏰', schedule: '📅', connectors: '🔌', documents: '📄', folders: '📁', 'agent-window': '🌐', architecture: '🏛', performance: '⚡', system: '📊', usage: '⏳', skills: '✨', diagrams: '📐', extensions: '🧩', 'web-code': '💻', remote: '📱', safety: '🛡' };

let step = 0;
const draft = {};
let faceHost = null;

export function maybeStartOnboarding() {
  if (!state.settings.onboarded) startOnboarding();
}

export function startOnboarding() {
  step = 0;
  $('#onboarding').classList.remove('hidden');
  render();
}

function closeWizard() {
  faceHost?.teardown();
  faceHost = null;
  $('#onboarding').classList.add('hidden');
}

async function finish({ interview = false } = {}) {
  closeWizard();
  await saveSettings({ onboarded: true });
  if (interview) (await import('./setup.js')).startInterview();
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

function checkbox(checked, label, onChange) {
  const box = el('input', { type: 'checkbox' });
  box.checked = Boolean(checked);
  box.addEventListener('change', () => onChange(box.checked));
  return el('label', { class: 'toggle' }, box, el('span', { class: 'sw' }), el('span', {}, label));
}

const field = (label, control, hint) => el('div', { class: 'field' }, el('label', {}, label), control, hint ? el('div', { class: 'hint', html: hint }) : '');
const point = (ico, title, text) => el('div', { class: 'ob-point' }, el('span', { class: 'ico' }, ico), el('div', {}, el('b', {}, title), el('p', {}, text)));

async function render() {
  const s = state.settings;
  faceHost?.teardown();
  faceHost = null;
  const card = el('div', { class: 'ob-card glass' });
  const id = STEPS[step];
  card.append(
    el('div', { class: 'ob-head' }, el('span', {}, `Step ${step + 1} of ${STEPS.length}`), el('b', {}, STEP_NAMES[id])),
    el('div', { class: 'ob-steps' }, STEPS.map((_, i) => el('span', { class: i <= step ? 'on' : '' }))),
  );
  const body = el('div', { class: 'field', style: { gap: '12px' } });
  card.append(body);
  let beforeNext = async () => {};
  let canNext = () => true;

  if (id === 'welcome') {
    draft.name = draft.name || s.agent.name;
    const stage = el('div', { class: 'ob-face' });
    body.append(
      el('div', { class: 'ob-hero' }, stage, el('div', {}, el('h2', {}, `Meet ${s.agent.name || 'Siren'}`), el('p', { class: 'muted' }, 'Your personal assistant on this computer: she talks and listens, remembers what matters to you, keeps your notes and schedule, teaches, coaches your habits, works on the web and in your documents, and comes along on your phone.'), el('p', { class: 'muted' }, 'This setup takes a few minutes, one topic at a time. You can change everything later in Config, and nothing you already have is overwritten.'))),
      field('What should your assistant be called?', input(draft.name, 'Siren', (v) => (draft.name = v)), 'The name she answers to and uses for herself. Every persona can have its own.'),
    );
    faceHost = new FaceHost(stage, { compact: true });
    faceHost.set(s.ui.face || 'siren', { name: s.agent.name, avatar: s.agent.avatar });
    beforeNext = () => saveSettings({ agent: { name: draft.name.trim() || 'Siren' } });
  }

  if (id === 'privacy') {
    draft.accepted ??= Boolean(s.privacy?.acceptedAt);
    const next = () => card.querySelector('.ob-nav .btn.primary');
    body.append(
      el('h2', {}, 'Privacy and safety'),
      el('p', { class: 'muted' }, 'Please read this once. It is the short version of the full privacy policy.'),
      el(
        'div',
        { class: 'ob-points' },
        point('🏠', 'Your data stays on this computer', 'Settings, conversations, memories, notes and your schedule live in your data folder and your vault, as plain files you own. There is no account, no server of ours, no analytics. Keys are encrypted with your system’s keychain.'),
        point('☁', 'What goes to your AI provider', 'Your messages, the conversation, relevant memories and notes, your schedule for the next days, tool results, and screenshots while you share your screen go to the AI brain you choose (for example Anthropic). Their privacy terms apply to it.'),
        point('🛡', 'You stay in control', 'Consequential actions ask you first: changing her own code, settings, deleting, commands, pushing to GitHub, anything in your connected services. Screen sharing only starts from your click. Pages, documents and tool results are treated as data, never as instructions.'),
        point('⚠', 'AI can be wrong', 'Language models make mistakes and can sound sure about false things. Check what matters (medical, legal, financial, safety) with a qualified source. Siren is not a professional adviser, and the app is provided as is, without warranty (MIT License): no software is perfectly secure, and the authors are not liable for damage from its use.'),
        point('💳', 'Services and costs are yours', 'You are responsible for the terms and charges of every service you connect (AI providers, connectors) and for what you approve.'),
      ),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => api.shell.openExternal(PRIVACY_URL) }, '📄 Read the full privacy policy')),
      el('div', {}, el('b', {}, 'How careful should she be?')),
      choices(
        [
          { value: 'ask', ico: '🛡', title: 'Ask me first', desc: 'Recommended. You approve by click or by saying “yes”.' },
          { value: 'auto', ico: '⚡', title: 'Just do it', desc: 'Still asks before self-changes, commands and anything that reaches other people or services.' },
        ],
        s.safety.permissionMode,
        (v) => saveSettings({ safety: { permissionMode: v } }),
      ),
      checkbox(draft.accepted, 'I have read this and agree to the privacy policy and disclaimers', (v) => {
        draft.accepted = v;
        next()?.toggleAttribute('disabled', !v);
      }),
    );
    canNext = () => draft.accepted;
    beforeNext = () => saveSettings({ privacy: { acceptedAt: Date.now() } });
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
      } else if (draft.provider === 'auto') {
        area.append(
          el('p', { class: 'muted', style: { margin: 0 } }, 'Uses every provider you set up, best one first, and switches automatically when one hits a rate limit or runs out of credits. Add the keys you have (all optional; your Claude account is used if it is connected). You can rank them and add more later in Config → AI brain.'),
          field('Gemini API key (free tier)', input(s.gemini.apiKey, 'optional', (v) => saveSettings({ gemini: { apiKey: v } }), 'password'), 'Get one at <a href="https://aistudio.google.com/apikey">aistudio.google.com</a>.'),
          field('Groq API key (free tier, very fast)', input(s.groq.apiKey, 'optional', (v) => saveSettings({ groq: { apiKey: v } }), 'password'), 'Get one at <a href="https://console.groq.com/keys">console.groq.com</a>.'),
          field('Anthropic API key', input(s.anthropic.apiKey, 'optional', (v) => saveSettings({ anthropic: { apiKey: v } }), 'password')),
        );
      } else {
        area.append(field('Anthropic API key', input(s.anthropic.apiKey, 'sk-ant-…', (v) => saveSettings({ anthropic: { apiKey: v } }), 'password')));
      }
    };
    body.append(el('h2', {}, 'The brain'), el('p', { class: 'muted' }, 'The language model she thinks with. Your messages go to the provider you pick here.'));
    if (draft.hw?.rec?.brain) body.append(el('div', { class: 'rec' }, el('span', {}, el('b', {}, 'From the hardware check: '), draft.hw.rec.brain.why)));
    body.append(
      choices(
        [
          { value: 'claude-code', ico: '✦', title: 'My Claude account', desc: 'Recommended. Uses your Claude subscription through Claude Code, with your connectors and plugins.' },
          { value: 'auto', ico: '⇄', title: 'Several providers', desc: 'Claude, Gemini, Groq, DeepSeek, Perplexity… with automatic fallback when one hits a limit.' },
          { value: 'openai', ico: '⌂', title: 'FreeLLMAPI / local', desc: 'A local OpenAI-compatible server (also Ollama, LM Studio). Keeps everything on this computer.' },
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
    draft.engine ||= s.voice.engine || 'local';
    const meter = el('div', { class: 'mic-meter' }, el('i'));
    const mics = el('select', { class: 'input' });
    listMics().then((list) => {
      mics.innerHTML = '';
      mics.append(el('option', { value: '' }, 'System default'));
      for (const m of list) mics.append(el('option', { value: m.label, selected: m.label === s.stt.micDevice }, m.label));
    });
    mics.addEventListener('change', () => saveSettings({ stt: { micDevice: mics.value } }));
    const engineArea = el('div', { class: 'field' });
    const progress = el('div', { class: 'hint' });
    const off = on('tts-progress', (p) => {
      if (p.status === 'progress' && p.file) progress.textContent = `Downloading the voice — ${Math.round(p.progress || 0)}% (${p.file.split('/').pop()})`;
      else if (p.status === 'ready') progress.textContent = `✓ The offline voice is ready (${p.device}).`;
      else if (p.status === 'error') progress.textContent = `✕ ${p.message}`;
    });
    draft.cleanup = off;
    const drawEngine = () => {
      engineArea.innerHTML = '';
      if (draft.engine === 'local') {
        const voices = el('select', { class: 'input' }, ...KOKORO_VOICES.map(([v, label]) => el('option', { value: v, selected: v === s.voice.localVoice }, label)));
        voices.addEventListener('change', () => saveSettings({ voice: { localVoice: voices.value } }));
        engineArea.append(
          field('Her voice', voices, 'Downloaded once (about 90 MB, more with a graphics card), then it works without internet.'),
          el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: async () => { progress.textContent = 'Loading the offline voice…'; try { await testLocalVoice(`Hello, I'm ${state.settings.agent.name}. Lovely to meet you.`); } catch (e) { progress.textContent = `✕ ${e.message}`; } } }, '🔊 Download and play')),
          progress,
        );
      } else {
        engineArea.append(
          field('VoiceStudio URL', input(s.voice.baseUrl, 'http://localhost:3900', (v) => saveSettings({ voice: { baseUrl: v } })), 'VoiceStudio is a separate app with more natural voices and voice cloning. If it isn’t reachable, the offline voice speaks instead.'),
          el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => speaker.say(`Hello, I'm ${state.settings.agent.name}.`) }, '🔊 Test voice')),
        );
      }
    };
    body.append(
      el('h2', {}, 'Voice'),
      checkbox(s.voice.ttsEnabled, 'Speak replies aloud', (v) => saveSettings({ voice: { ttsEnabled: v } })),
      choices(
        [
          { value: 'local', ico: '🌊', title: 'Offline voice', desc: 'Recommended. Runs in the app: free, private, no internet once downloaded.' },
          { value: 'voicestudio', ico: '🎚', title: 'VoiceStudio', desc: 'A separate app with more natural and cloneable voices.' },
        ],
        draft.engine,
        async (v) => ((draft.engine = v), await saveSettings({ voice: { engine: v } }), drawEngine()),
      ),
      engineArea,
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
    drawEngine();
    beforeNext = () => saveSettings({ voice: { engine: draft.engine } });
  }

  if (id === 'vault') {
    const known = await api.obsidian.vaults().catch(() => []);
    const def = await api.obsidian.defaultPath();
    draft.vault ??= s.obsidian.vaultPath || '';
    const opts = [{ value: '', title: 'Create her own vault', desc: def }, ...known.filter((v) => v.exists).map((v) => ({ value: v.path, title: `Use “${v.name}”`, desc: `${v.path} — structure is added, nothing is overwritten` }))];
    body.append(
      el('h2', {}, 'Memory vault'),
      el('p', { class: 'muted' }, 'She keeps her long-term memory, your notes, a daily journal, your priorities, your schedule, what you learn and your habits in an Obsidian vault: plain Markdown files you own, with a version history so any change can be undone. Obsidian itself is optional.'),
      choices(opts, draft.vault, (v) => (draft.vault = v)),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { const d = await api.dialog.pickFolder('Vault folder'); if (d) { draft.vault = d; render(); } } }, 'Choose another folder…')),
    );
    draft.register ??= true;
    body.append(checkbox(draft.register, 'Also add it to Obsidian’s vault list (Obsidian must be closed; a backup of its list is kept)', (v) => (draft.register = v)));
    beforeNext = async () => {
      await saveSettings({ obsidian: { vaultPath: draft.vault, enabled: true } });
      if (draft.register) api.obsidian.register().catch((e) => toast(`Not added to Obsidian: ${e.message}`));
    };
  }

  if (id === 'goals') {
    draft.goals ||= new Set();
    draft.addPersonas ??= true;
    draft.briefing ??= true;
    draft.briefingTime ||= '07:45';
    const picks = el('div', { class: 'ob-choices' });
    const drawPicks = () => {
      picks.innerHTML = '';
      for (const g of GOALS) {
        picks.append(el('button', { class: `ob-choice ${draft.goals.has(g.value) ? 'sel' : ''}`, onclick: () => (draft.goals.has(g.value) ? draft.goals.delete(g.value) : draft.goals.add(g.value), drawPicks()) }, el('span', { class: 'ico' }, g.ico), el('span', {}, el('b', {}, g.title), el('small', {}, g.desc))));
      }
    };
    drawPicks();
    const time = el('input', { class: 'input', type: 'time', value: draft.briefingTime, style: { width: '120px' } });
    time.addEventListener('change', () => (draft.briefingTime = time.value || '07:45'));
    body.append(
      el('h2', {}, 'What do you want help with?'),
      el('p', { class: 'muted' }, 'Pick any. It decides what gets set up for you now; everything else stays available (ask “how can I use you?” any time).'),
      picks,
      checkbox(draft.addPersonas, 'Add the matching ready-made personas (Ada, Mira, Sol) to switch to from the title bar', (v) => (draft.addPersonas = v)),
      el('div', { class: 'row' }, checkbox(draft.briefing, 'A daily briefing every morning at', (v) => (draft.briefing = v)), time),
      el('p', { class: 'hint' }, 'The briefing is a routine: she prepares today’s schedule, priorities, habits and what’s due while the app is open. More routines, habits and the skill tree are in the Habits and Tree views.'),
    );
    beforeNext = async () => {
      const s2 = state.settings;
      if (draft.addPersonas) {
        for (const g of GOALS.filter((x) => x.template && draft.goals.has(x.value))) {
          if (!s2.personas.list.some((p) => p.name === g.persona)) await api.persona.create({ template: g.template, activate: false });
        }
        await loadSettings();
      }
      if (draft.briefing) {
        const existing = await api.routines.list().catch(() => []);
        const t = ROUTINE_TEMPLATES.find((x) => x.name === 'Morning briefing');
        if (t && !existing.some((r) => r.name === 'Daily briefing')) await api.routines.save({ name: 'Daily briefing', schedule: { kind: 'daily', time: draft.briefingTime }, instructions: t.instructions });
      }
    };
  }

  if (id === 'connect') body.append(...(await connectStep(s)));

  if (id === 'persona') {
    draft.persona ||= 'keep';
    const custom = el('div', { class: 'field', style: { display: draft.persona === 'custom' ? '' : 'none' } });
    const prompt = el('textarea', { class: 'input', rows: 6, placeholder: 'Who is your assistant? How does she talk, what does she care about, how should she treat you?' });
    prompt.value = s.agent.personality;
    const aesthetic = input(s.agent.aesthetic, 'e.g. 90s cyberpunk terminal, warm solarpunk greenhouse, minimal Scandinavian', () => {});
    custom.append(field('Master prompt', prompt), field('Aesthetic / style (optional)', aesthetic, 'Later, “Generate look & feel” in Config restyles the whole app to match.'));
    body.append(
      el('h2', {}, 'Personality and face'),
      choices(
        [
          { value: 'keep', ico: '🧜', title: `Keep ${s.agent.name || 'Siren'} as she is`, desc: 'Warm, candid and capable: a chief of staff, tutor and good friend in one. You can edit her master prompt any time.' },
          { value: 'custom', ico: '✍', title: 'Write my own', desc: 'Your own master prompt and aesthetic.' },
        ],
        draft.persona,
        (v) => ((draft.persona = v), (custom.style.display = v === 'custom' ? '' : 'none')),
      ),
      custom,
      el('div', {}, el('b', {}, 'Her face')),
      choices(BUILT_IN.map((f) => ({ value: f.id, title: f.title, desc: f.tagline })), s.ui.face, (v) => saveSettings({ ui: { face: v } })),
      el('p', { class: 'hint' }, 'Want a face of your own? Your vault has a note, “Make Your Own Face”, with a prompt you can give any AI app to design one. Custom faces go in the faces folder (Face view → ＋ Custom faces).'),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { const img = await api.dialog.pickImage(); if (img) { await saveSettings({ agent: { avatar: img } }); toast('Image set'); } } }, '🖼 Choose a picture for her (optional)')),
    );
    beforeNext = async () => {
      if (draft.persona === 'custom') await saveSettings({ agent: { personality: prompt.value, aesthetic: aesthetic.value } });
    };
  }

  if (id === 'tour') {
    const grid = el('div', { class: 'ob-tour' });
    body.append(el('h2', {}, 'What I can do'), el('p', { class: 'muted' }, 'A quick look at everything. Click a card for things to say. You never need to remember this: ask “how can I use you?” whenever you like.'), grid);
    const features = await api.guide.features().catch(() => []);
    for (const f of features) {
      const card2 = el('button', { class: 'ob-feature', onclick: () => card2.classList.toggle('open') }, el('span', { class: 'ico' }, TOUR_ICONS[f.id] || '•'), el('b', {}, f.title), el('p', {}, f.what), el('div', { class: 'ob-feature-more' }, el('small', {}, 'Try: ', f.say.join(' · ')), el('small', {}, `Where: ${f.where}`), f.status ? el('small', { class: 'st' }, `Now: ${f.status}`) : ''));
      grid.append(card2);
    }
  }

  if (id === 'hello') {
    const list = el('div', {});
    body.append(el('h2', {}, 'First hello'), el('p', { class: 'muted' }, 'Testing everything end to end…'), list);
    firstHello(list);
  }

  const last = step === STEPS.length - 1;
  const nav = el(
    'div',
    { class: 'ob-nav' },
    step === 0 ? el('button', { class: 'btn', onclick: () => finish() }, 'Skip setup') : el('button', { class: 'btn', onclick: () => go(-1) }, '‹ Back'),
    last
      ? el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => finish() }, 'Start using her'), el('button', { class: 'btn primary', onclick: () => finish({ interview: true }) }, '💬 Let’s get to know each other'))
      : el('button', { class: 'btn primary', disabled: !canNext(), onclick: async () => { try { await beforeNext(); go(1); } catch (e) { toastError(e); } } }, 'Next ›'),
  );
  card.append(nav);
  $('#onboarding').innerHTML = '';
  $('#onboarding').append(card);
  $('#onboarding').scrollTop = 0; // the overlay scrolls (long steps); each step starts at its top
}

function go(delta) {
  draft.cleanup?.();
  draft.cleanup = null;
  step += delta;
  render();
}

// Connectors, plugins, skills, extensions and the phone: what comes with the app, what is optional
// (docs/CONNECTORS.md explains the choice). Nothing third-party is turned on here without a click.
async function connectStep(s) {
  const claudeBrain = s.llm.provider === 'claude-code' || (s.llm.provider === 'auto' && !(s.routing?.disabled || []).includes('claude-code'));
  const picked = GOALS.filter((g) => draft.goals?.has(g.value));
  const ideas = [...new Set((picked.length ? picked : GOALS).flatMap((g) => g.connectors))];
  const out = el('div', { class: 'test-result hidden' });
  const skills = await api.skills.list().catch(() => []);
  const parts = [
    el('h2', {}, 'Connectors and extras'),
    point('✅', 'Built in, nothing to set up', 'Your schedule, notes, memory, habits, learning tracker, web search, documents and PDFs, diagrams, routines and the Inner World all run inside the app. GitHub works once the GitHub CLI is signed in.'),
    point('✨', `${skills.length} skills included`, 'Ready-made workflows such as /explain, /proof-coach, /study-session, /weekly-review and /tour. Add your own, or import more from GitHub, in the Skills view.'),
  ];
  if (claudeBrain) {
    parts.push(
      point('🔌', 'Your Claude connectors and plugins (optional)', 'With your Claude account, she can use the services you connected on claude.ai (Gmail, Google Calendar, Todoist, Notion, Canva…) and your Claude Code plugins. None come with the app: you choose them on claude.ai. Every call asks you first unless you allow a service in Config → AI brain, and what they return is treated as data.'),
      checkbox(s.claudeCode.connectors, 'Use my Claude connectors and plugins', (v) => saveSettings({ claudeCode: { connectors: v } })),
      el('div', { class: 'hint' }, `Worth connecting for what you picked: ${ideas.join(', ')}.`),
      el(
        'div',
        { class: 'row' },
        el('button', { class: 'btn', onclick: () => api.shell.openExternal(CONNECTORS_URL) }, '🌐 Browse connectors on claude.ai'),
        el('button', {
          class: 'btn',
          onclick: async (e) => {
            e.target.disabled = true;
            out.className = 'test-result';
            out.textContent = 'Checking your connectors… (this can take half a minute)';
            try {
              const items = await api.claude.connectors();
              const ok = items.filter((c) => c.status === 'connected');
              out.className = 'test-result ok';
              out.textContent = items.length ? `✓ ${ok.length} of ${items.length} connected: ${items.map((c) => `${c.name}${c.status === 'connected' ? '' : ' (needs sign-in)'}`).join(', ')}` : 'No connectors yet. Add some on claude.ai, then check again.';
            } catch (err) {
              out.className = 'test-result err';
              out.textContent = `✕ ${err.message}`;
            } finally {
              e.target.disabled = false;
            }
          },
        }, '🔍 Check what I have'),
      ),
      out,
    );
  } else {
    parts.push(point('🔌', 'Claude connectors and plugins', 'Services like Gmail, Todoist or Notion work through the Claude account brain. If you switch to it later, turn them on in Config → AI brain.'));
  }
  parts.push(
    point('🧩', 'Extensions (optional, off)', 'REA explains how apps and websites work; God’s Eye View is a live globe of public world data. Turn them on in Config → Extensions when you want them.'),
    point('📱', 'Your phone', 'Pair the Android app or your phone’s browser to talk to her away from the desk: Config → Remote access, over Wi-Fi or a secure Tailscale address.'),
  );
  return parts;
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
  // The voice runs alongside the other checks: its first download can take a minute.
  const voiceDone = (async () => {
    if (!s.voice.ttsEnabled) greet(null, 'Voice is off. Turn it on any time in Config → Voice output.');
    else if (s.voice.engine === 'local') {
      greet(null, 'Loading the offline voice…');
      const off = on('tts-progress', (p) => p.status === 'progress' && p.file && greet(null, `Downloading the voice once — ${Math.round(p.progress || 0)}%`));
      try {
        await testLocalVoice(greeting);
        greet(true, `The offline voice · “${greeting}”`);
      } catch (e) {
        greet(false, `The offline voice didn’t load (${e.message}). It retries on the next sentence; check your internet for the first download.`);
      } finally {
        off();
      }
    } else {
      speaker.say(greeting);
      const synth = await api.tts.speak('ok').then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
      if (synth.ok) greet(true, `VoiceStudio · “${greeting}”`);
      else if (s.voice.fallback !== 'off') greet(null, `VoiceStudio failed (${synth.error}) — speaking with the ${s.voice.fallback === 'system' ? 'system' : 'offline'} voice for now. Fix it in Config → Voice output.`);
      else greet(false, `VoiceStudio failed: ${synth.error}. Check its URL in Config → Voice output.`);
    }
  })();

  const brain = row('Brain answers a question');
  try {
    const r = await api.llm.test();
    brain(true, `${r.model} · “${r.reply}” · ${r.ms} ms`);
  } catch (e) {
    brain(false, e.message);
  }
  const vault = row('Vault is writable');
  const st = await api.obsidian.status().catch(() => ({}));
  vault(Boolean(st.ok), st.ok ? `${st.path} · ${st.count} notes` : 'Vault unavailable — choose a folder in Config → Vault.');
  const mic = row('Microphone available');
  try {
    if (!(await api.mic.request())) throw new Error('access was not granted');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    mic(true, s.stt.micMode === 'open' ? 'Hands-free mode' : `Hold ${s.stt.pttKey} or the mic button to talk.`);
  } catch (e) {
    mic(false, `${e.message} — allow microphone access for this app${navigator.platform.startsWith('Mac') ? ' (System Settings → Privacy & Security → Microphone)' : ''}.`);
  }
  await voiceDone;
  list.append(el('p', { class: 'muted', style: { marginTop: '12px' } }, 'All set. Want her to get to know you? A short conversation about your work, goals and how you like to be helped, which she keeps in your profile.'));
}
