// First-run setup: a guided wizard, one topic at a time, nothing destructive. It introduces the
// assistant, asks the user to read and accept the privacy and safety notice, sets up the brain, the
// voice (the offline voice by default), the vault, goals, connectors and the persona, shows a tour of
// everything the app can do (from main/guide.js, the same entries the agent uses for "how can I use
// you?"), and ends with a "first hello" test; then it offers the agent's get-to-know-you interview.
// "Quick start" is the welcome, the privacy step and the brain finder; an install set up without accepting
// the notice sees that step alone at launch (onboardcore.js stepsFor / launchMode). The brain finder
// (onboardcore brainPlan) preselects what works here, offers the free Gemini card otherwise, and says
// plainly when she can't answer yet: on Next (once), and on First hello ("Fix this", "Set up a brain first").
import { $, api, el, toast, toastError, on, dialogOpen, modal, ignore, plainError } from './util.js';
import { testFailure } from './chatcore.js';
import { state, saveSettings, loadSettings } from './state.js';
import { ROUTINE_TEMPLATES } from './routines.js';
import { speaker, listMics, testLocalVoice } from './voice.js';
import { BUILT_IN, FaceHost } from './faces/host.js';
import { scanInto } from './hwscan.js';
import { KOKORO_VOICES } from './kokorotext.js';
import { connectClaude, testOutcome, showResult, showFailure } from './settings.js';
import { speechPlan } from './perfcore.js';
import { faceChoices, stepsFor, finishPatch, launchMode, accepted, brainPlan, brainPatch, detectionFrom, FREE_KEY_URL, FREE_KEY_STEPS, CLAUDE_CODE_URL, CLAUDE_CODE_LINE, HELLO_BRAIN_FAILED, wizardProgress, PRIVACY_POINTS, SAVES_LINE, registerOffer } from './onboardcore.js';

const STEP_NAMES = { welcome: 'Welcome', privacy: 'Privacy & safety', hardware: 'Your computer', brain: 'Brain', voice: 'Voice', vault: 'Notes & files', goals: 'What you want', connect: 'Link services', persona: 'Personality & face', tour: 'What I can do', hello: 'First hello' };
const PRIVACY_URL = 'https://github.com/Andreas-Erick/fullstack-agent/blob/main/PRIVACY.md';
const CONNECTORS_URL = 'https://claude.ai/settings/connectors';

// What the user wants help with → the ready-made persona that fits (main/personatemplates.js) and
// the Claude connectors worth suggesting for it (none come with the app: docs/CONNECTORS.md).
const GOALS = [
  { value: 'study', ico: '🎓', title: 'Understanding hard things', desc: 'Math, proofs, science, tech: intuition first, then rigor', template: 'stem-tutor', persona: 'Ada', connectors: ['Wolfram (math you can trust)', 'Consensus (research papers)'] },
  { value: 'languages', ico: '🗣', title: 'Learning languages', desc: 'Conversation practice, vocabulary with spaced repetition', template: 'polyglot-coach', persona: 'Mira', connectors: ['DeepL (translation)'] },
  { value: 'life', ico: '🌱', title: 'Goals and reflection', desc: 'A coach for small steps, plans and weekly reviews', template: 'life-coach', persona: 'Sol', connectors: ['Todoist or TickTick (tasks)', 'Google Calendar'] },
  { value: 'work', ico: '🗂', title: 'Work and projects', desc: 'Notes, documents, schedule, tasks, research', connectors: ['Gmail', 'Google Drive', 'Notion', 'Slack'] },
];

// Icons for the tour (main/guide.js FEATURES ids).
const TOUR_ICONS = { talk: '🎙', personas: '🎭', memory: '🧠', learning: '🎓', languages: '🗣', coaching: '🌱', innerworld: '🏡', routines: '⏰', schedule: '📅', connectors: '🔌', documents: '📄', folders: '📁', 'agent-window': '🌐', architecture: '🏛', performance: '⚡', system: '📊', 'local-brain': '💻', 'switch-brain': '🔀', usage: '⏳', skills: '✨', diagrams: '📐', extensions: '🧩', 'web-code': '💻', remote: '📱', watch: '⌚', keyboard: '⌨', updates: '⬆', safety: '🛡' };

// How the privacy step opens, by the way through the wizard (onboardcore stepsFor).
const PRIVACY_LEAD = {
  full: 'Five points, the short version of the full privacy policy. Open any of them for the details.',
  quick: 'Five points, the short version of the full privacy policy. Then she finds a brain to think with, and you can start. Everything else can wait for Settings.',
  missed: 'One thing we missed: you haven’t accepted the privacy and safety notice yet. Five points, the short version of the full privacy policy; everything else stays as you set it up.',
};

let step = 0; // the index in stepsFor(mode)
let mode = 'full'; // full | quick | missed
let afterFinish = null; // what runs once the wizard is done (the launch greeting after a missed step)
let moving = false; // a step change in progress: a double click moves one step
let shownStep = null; // the step whose heading last took the focus (a redraw of the same step keeps it)
const draft = {};
let faceHost = null;
// The brain finder's state for this run of the wizard: what was found (detectionFrom; null until checked),
// the Claude status behind it, the card picked, the brain whose test answered, whether the "no working
// brain" warning was shown, and whether First hello's brain check failed.
const NOTHING_FOUND = { claude: 'unchecked', local: [], keys: {} };
const finder = { detection: null, claude: null, chosen: null, tested: null, warned: false, helloFailed: false };
const resetFinder = () => Object.assign(finder, { detection: null, claude: null, chosen: null, tested: null, warned: false, helloFailed: false });
const brainNow = () => brainPlan(finder.detection || NOTHING_FOUND, state.settings, finder);

// At launch: the whole wizard on a first run; an install set up without accepting the privacy notice
// (an older one, or one that skipped it) gets that step alone, once, and `then` runs after it.
// Returns what it opened: 'full', 'missed' or '' (nothing).
export function maybeStartOnboarding({ then } = {}) {
  const how = launchMode(state.settings);
  if (how) startOnboarding(how, how === 'missed' ? then : null);
  return how;
}

export function startOnboarding(how = 'full', after = null) {
  mode = ['quick', 'missed'].includes(how) ? how : 'full';
  afterFinish = after;
  step = 0;
  shownStep = null;
  resetFinder();
  watchBehind();
  $('#onboarding').classList.remove('hidden');
  render();
}

function closeWizard() {
  faceHost?.teardown();
  faceHost = null;
  shownStep = null;
  $('#onboarding').classList.add('hidden');
}

// While the wizard shows, the window behind it is out of reach for the keyboard and screen readers. A dialog
// over the wizard (util.js holdFocus) clears the window's inert when it closes, so a watch on the wizard's
// class and on those nodes puts it back while the wizard is still up, and takes it away once it is hidden.
const BEHIND = ['.titlebar', '.shell'];
let behindWatch = null;
function syncBehind() {
  const up = !$('#onboarding').classList.contains('hidden');
  if (!up && dialogOpen()) return; // a dialog governs the window now
  for (const q of BEHIND) for (const n of document.querySelectorAll(q)) if (n.inert !== up) n.inert = up;
}
function watchBehind() {
  if (behindWatch) return syncBehind();
  behindWatch = new MutationObserver(syncBehind);
  behindWatch.observe($('#onboarding'), { attributes: true, attributeFilter: ['class'] });
  for (const q of BEHIND) for (const n of document.querySelectorAll(q)) behindWatch.observe(n, { attributes: true, attributeFilter: ['inert'] });
  syncBehind();
}

// Every way out of the wizard ends here, and none without the privacy acceptance: back to that step.
async function finish({ interview = false } = {}) {
  const patch = finishPatch(state.settings);
  if (!patch) {
    step = stepsFor(mode).indexOf('privacy');
    return render();
  }
  closeWizard();
  await saveSettings(patch);
  const after = afterFinish;
  afterFinish = null;
  after?.();
  if (interview) (await import('./setup.js')).startInterview();
}

// Going on without a brain that answered: said once per run of the wizard. True = continue anyway.
async function warnOnce(text) {
  if (finder.warned) return true;
  const go = await modal((card, close) => {
    card.append(
      el('h3', {}, 'She can’t answer yet'),
      el('p', { class: 'muted' }, text),
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(true) }, 'Continue anyway'), el('button', { class: 'btn primary', onclick: () => close(false) }, 'Set it up now')),
    );
  });
  if (go) finder.warned = true;
  return Boolean(go);
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
  const steps = stepsFor(mode);
  const id = steps[step];
  // The progress: the whole setup in three phases ("about 3 minutes"), Quick start as one step after privacy.
  const progress = wizardProgress(mode, id);
  card.append(el('div', { class: 'ob-head' }, el('span', {}, progress.label), el('b', { id: 'obTitle' }, STEP_NAMES[id])));
  if (progress.phases.length) card.append(el('ol', { class: 'ob-steps ob-phases', 'aria-label': 'Setup progress' }, progress.phases.map((p) => el('li', { class: p.state === 'todo' ? '' : 'on', 'aria-current': p.state === 'current' ? 'step' : null }, p.name))));
  else if (mode === 'quick') card.append(el('div', { class: 'ob-steps' }, steps.map((_, i) => el('span', { class: i <= step ? 'on' : '' }))));
  const body = el('div', { class: 'field', style: { gap: '12px' } });
  card.append(body);
  let beforeNext = async () => {}; // returns false to stay on the step
  let canNext = () => true;
  let redrawNav = () => {}; // set once the nav is built: a step's checks can change its buttons
  let saveFound = async () => {}; // the brain step: keep a brain found here that was only preselected

  if (id === 'welcome') {
    draft.name = draft.name || s.agent.name;
    const stage = el('div', { class: 'ob-face' });
    body.append(
      el('div', { class: 'ob-hero' }, stage, el('div', {}, el('h2', {}, `Meet ${s.agent.name || 'Siren'}`), el('p', { class: 'muted' }, 'Your personal assistant on this computer: she talks and listens, remembers what matters to you, keeps your notes and schedule, teaches, coaches you toward your goals, works on the web and in your documents, and comes along on your phone.'), el('p', { class: 'muted' }, 'This setup takes about 3 minutes, one topic at a time. You can change everything later in Settings (the gear at the bottom of the left rail), and nothing you already have is overwritten.'))),
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
      el('p', { class: 'muted' }, PRIVACY_LEAD[mode] || PRIVACY_LEAD.full),
      // One line per point; its details fold out (a native <details>: keyboard and screen readers included).
      el('div', { class: 'ob-points' }, PRIVACY_POINTS.map((p) => el('details', { class: 'ob-point' }, el('summary', {}, el('span', { class: 'ico', 'aria-hidden': 'true' }, p.ico), el('b', {}, p.line)), el('p', {}, p.more)))),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => api.shell.openExternal(PRIVACY_URL) }, '📄 Read the full privacy policy')),
      el('div', {}, el('b', {}, 'How careful should she be?')),
      choices(
        [
          { value: 'ask', ico: '🛡', title: 'Ask me first', desc: 'Recommended. You approve by click or by saying “yes”.' },
          { value: 'auto', ico: '⚡', title: 'Just do it', desc: 'Still asks before code changes, commands, publishing to GitHub, invitations and services you haven’t allowed.' },
        ],
        s.safety.permissionMode,
        (v) => saveSettings({ safety: { permissionMode: v } }),
      ),
      // The one request the app makes on its own (main/updates.js; PRIVACY.md "Update check").
      checkbox(s.updates?.check !== false, 'Tell me about new versions (a daily check with GitHub; nothing downloads by itself)', (v) => saveSettings({ updates: { check: v } })),
      // Off unless ticked: nothing is ever sent by the app (main/issues.js; PRIVACY.md "Problem reports").
      checkbox(s.privacy?.reportIssues === true, 'Help fix bugs: offer me an anonymized problem report that I read and send myself, or not', (v) => saveSettings({ privacy: { reportIssues: v } })),
      checkbox(draft.accepted, 'I have read this and agree to the privacy policy and disclaimers', (v) => {
        draft.accepted = v;
        next()?.toggleAttribute('disabled', !v);
      }),
    );
    canNext = () => draft.accepted;
    // The time of the first acceptance stays (PRIVACY.md: the app records when you accepted).
    beforeNext = async () => {
      if (!accepted(state.settings)) await saveSettings({ privacy: { acceptedAt: Date.now() } });
    };
  }

  if (id === 'hardware') {
    const box = el('div', { class: 'field' });
    const scan = el('button', { class: 'btn', onclick: async () => ((scan.disabled = true), (draft.hw = await scanInto(box)), (scan.disabled = false)) }, '🖥 Scan my hardware');
    body.append(
      el('h2', {}, 'Check this computer?'),
      el('p', { class: 'muted' }, 'Optional. A quick look at the processor, memory and graphics card tells you which speech model runs best here, and whether a local AI model would run well or a cloud brain is the better choice. Nothing leaves this computer. Skip it with Next.'),
      el('div', { class: 'row' }, scan),
      box,
    );
  }

  if (id === 'brain') {
    const status = el('div', { class: 'hint', role: 'status' }, 'Checking this computer…');
    const cards = el('div', {});
    const area = el('div', { class: 'field' });
    const out = el('div', { class: 'test-result hidden', role: 'status' });
    const testBtn = el('button', { class: 'btn', onclick: (ev) => testBrain(ev) }, '⚡ Test');
    const chosen = () => brainNow().chosen;
    // A detected local model to write with the card, unless one is set up already (kept as it is).
    const localPick = () => (state.settings.local?.model && state.settings.local?.baseUrl ? null : finder.detection?.local[0] || null);
    // Something changed about the chosen brain: its old test no longer counts.
    const untested = () => {
      finder.tested = null;
      out.className = 'test-result hidden';
      redrawNav();
    };
    const pick = async (v) => {
      finder.chosen = v;
      await saveSettings(brainPatch(v, { local: v === 'local' ? localPick() : null }));
      untested();
      drawCards();
      drawArea();
    };
    // The same outcome as Settings' Test connection: plain words, the provider's own text under Details.
    const testBrain = async (ev) => {
      const btn = ev.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      out.className = 'test-result';
      out.textContent = 'Asking her a test question…';
      const id = chosen();
      try {
        if (state.settings.llm.provider !== id) await saveSettings(brainPatch(id, { local: id === 'local' ? localPick() : null }));
        const o = testOutcome(await api.llm.test());
        showResult(out, o.ok, o.ok ? `${o.text}\nShe can answer. You’re ready to start.` : o.text, o.raw);
        finder.tested = o.ok ? id : null;
      } catch (e) {
        showFailure(out, e);
        finder.tested = null;
      } finally {
        btn.disabled = false;
        redrawNav();
      }
    };
    const detect = async () => {
      status.textContent = 'Checking this computer…';
      const [catalogue, servers] = await Promise.all([api.llm.brains({ fresh: true, all: true }).catch(ignore('brain check failed', null)), api.llm.localModels().catch(ignore('no local model servers', []))]);
      finder.claude = catalogue?.brains?.find((b) => b.id === 'claude-code')?.claude || null;
      finder.detection = detectionFrom(catalogue, servers);
      const d = finder.detection;
      const found = [d.claude === 'ready' && 'your Claude plan', d.local.length && `${d.local.length === 1 ? 'a model' : `${d.local.length} models`} on this computer (${d.local[0].server})`].filter(Boolean);
      status.textContent = found.length ? `Found ${found.join(' and ')}.` : 'Nothing set up yet, so here’s a free option that needs nothing installed.';
    };
    const drawCards = () => {
      const plan = brainNow();
      cards.replaceChildren(
        choices(
          plan.cards.map((c) => ({ value: c.id, ico: c.ico, title: c.works ? `${c.title} · ✓ found` : c.title, desc: c.desc })),
          plan.chosen,
          pick,
        ),
      );
    };
    const drawArea = async () => {
      area.innerHTML = '';
      const id = chosen();
      if (id === 'claude-code') {
        // The buttons sit in a row under the result, never stretched across the field.
        const actions = el('div', { class: 'row' });
        const recheck = el('button', { class: 'btn', onclick: async () => (await detect(), drawCards(), drawArea()) }, '⟳ Re-check');
        const st = finder.claude || {};
        const claudeNow = finder.detection?.claude;
        if (claudeNow === 'ready') area.append(el('div', { class: 'test-result ok' }, `✓ Connected as ${st.email || 'your Claude account'}${st.subscription || st.authMethod ? ` (${st.subscription || st.authMethod} plan)` : ''}`));
        else if (claudeNow === 'signedOut') area.append(el('div', { class: 'test-result' }, 'Claude Code is on this computer. Connect your Claude account (a window opens where you sign in), then click Re-check.')), actions.append(el('button', { class: 'btn', onclick: () => connectClaude('Re-check') }, 'Connect Claude account'));
        else if (claudeNow === 'unchecked') area.append(el('div', { class: 'test-result' }, 'Couldn’t check your Claude account just now. Connect it again, or try Re-check in a moment.')), actions.append(el('button', { class: 'btn', onclick: () => connectClaude('Re-check') }, 'Connect Claude account'));
        else {
          // Claude Code missing: one plain line and the official page; the terminal command only folded away.
          area.append(el('div', { class: 'test-result' }, CLAUDE_CODE_LINE));
          actions.append(el('button', { class: 'btn', onclick: () => api.shell.openExternal(CLAUDE_CODE_URL) }, '🌐 Open the download page'));
          const how = el('details', {}, el('summary', {}, 'Install it from a terminal instead'), el('pre', { class: 'hint' }, ''));
          api.claude.installHint().then((h) => (how.querySelector('pre').textContent = h), ignore('no install hint'));
          area.append(how);
        }
        actions.append(recheck);
        area.append(actions);
        if (claudeNow !== 'ready') area.append(el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => pick('gemini') }, 'No Claude plan? Choose the free option instead')));
      } else if (id === 'local') {
        const found = finder.detection?.local || [];
        const current = state.settings.llm.provider === 'local' ? state.settings.local?.model : localPick()?.model;
        if (found.length) {
          area.append(
            el('div', { class: 'hint' }, 'Pick the model she thinks with:'),
            el('div', { class: 'row', style: { flexWrap: 'wrap' } }, ...found.map((m) => el('button', { class: `chip ${m.model === current ? 'on' : ''}`, 'aria-pressed': String(m.model === current), onclick: async () => (await saveSettings(brainPatch('local', { local: m })), (finder.chosen = 'local'), untested(), drawArea()) }, `${m.name} · ${m.server}`))),
            checkbox(state.settings.llm.handOver, 'Hand hard messages to my Claude account (code, connected services, long or careful work). Those messages then leave this computer.', (v) => saveSettings({ llm: { handOver: v } })),
          );
        } else {
          area.append(el('div', { class: 'test-result' }, 'No model found on this computer yet. Install Ollama (ollama.com) or LM Studio (lmstudio.ai), start it and download a model, then click Look again.'));
        }
        area.append(el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => (await detect(), drawCards(), drawArea()) }, '⟳ Look again')));
      } else if (id === 'gemini') {
        // The guided free key: where to click, what to copy, where to paste.
        const key = input(state.settings.gemini?.apiKey, 'Paste your key here', (v) => {
          finder.chosen = 'gemini';
          if (finder.detection) finder.detection.keys.gemini = Boolean(v.trim());
          if (v.trim()) saveSettings(brainPatch('gemini', { key: v })).catch(toastError);
          untested();
        }, 'password');
        key.setAttribute('aria-label', 'Your free Gemini key');
        area.append(
          el('ol', { class: 'muted', style: { margin: 0, paddingLeft: '20px' } },...FREE_KEY_STEPS.map((t) => el('li', {}, t))),
          el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: () => api.shell.openExternal(FREE_KEY_URL) }, '🔑 Get my free key')),
          field('Your key', key, 'Then click Test. Google’s free tier has daily limits; your messages go to Google.'),
        );
      } else if (id === 'auto') {
        area.append(
          el('p', { class: 'muted', style: { margin: 0 } }, 'Uses every provider you set up, best one first, and switches automatically when one hits a rate limit or runs out of credits. Add the keys you have (all optional; your Claude account is used if it is connected). You can rank them and add more later in Settings → AI brain.'),
          field('Gemini API key (free tier)', input(s.gemini.apiKey, 'optional', (v) => (saveSettings({ gemini: { apiKey: v } }), untested()), 'password'), 'Get one at <a href="https://aistudio.google.com/apikey">aistudio.google.com</a>.'),
          field('Groq API key (free tier, very fast)', input(s.groq.apiKey, 'optional', (v) => (saveSettings({ groq: { apiKey: v } }), untested()), 'password'), 'Get one at <a href="https://console.groq.com/keys">console.groq.com</a>.'),
          field('Anthropic API key', input(s.anthropic.apiKey, 'optional', (v) => (saveSettings({ anthropic: { apiKey: v } }), untested()), 'password')),
        );
      } else if (id === 'openai') {
        area.append(
          field('Server address', input(state.settings.llm.baseUrl, 'http://localhost:3001/v1', (v) => (saveSettings({ llm: { baseUrl: v } }), untested())), 'FreeLLMAPI or any OpenAI-compatible server.'),
          field('Bearer token', input(state.settings.llm.apiKey, 'optional', (v) => (saveSettings({ llm: { apiKey: v } }), untested()), 'password')),
        );
      } else {
        area.append(field('Anthropic API key', input(s.anthropic.apiKey, 'sk-ant-…', (v) => (saveSettings(brainPatch('anthropic', { key: v })), (finder.chosen = 'anthropic'), untested()), 'password')));
      }
    };
    body.append(el('h2', {}, 'Let’s give her a brain'), el('p', { class: 'muted' }, 'The AI she thinks with. Your messages go to the one you pick here. You can switch any time in Settings → AI brain.'));
    if (draft.hw?.rec?.brain) body.append(el('div', { class: 'rec' }, el('span', {}, el('b', {}, 'From the hardware check: '), draft.hw.rec.brain.why)));
    body.append(status, cards, area, el('div', { class: 'row' }, testBtn), out);
    (async () => {
      if (!finder.detection) await detect();
      else status.textContent = '';
      drawCards();
      drawArea();
      redrawNav();
    })().catch(toastError);
    // Next without a brain that answered: say so once (Continue anyway / Set it up now). A brain that
    // works here but was only preselected is saved, so going on keeps what was found.
    beforeNext = async () => {
      const plan = brainNow();
      if (!plan.canStart && mode === 'full' && !(await warnOnce(plan.warn))) return false;
      await saveFound(plan);
    };
    saveFound = async (plan) => {
      const card = plan.cards.find((c) => c.id === plan.chosen);
      if (card?.works && state.settings.llm.provider !== plan.chosen) await saveSettings(brainPatch(plan.chosen, { local: plan.chosen === 'local' ? localPick() : null }));
    };
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
    // How she hears you: Whisper on this computer (the model fits it: perfcore speechPlan) or Groq's.
    const sttArea = el('div', { class: 'field' });
    const drawStt = () => {
      sttArea.innerHTML = '';
      const now = state.settings;
      if (now.stt.engine === 'groq') {
        const shared = draft.engine === 'cloud' && now.cloudVoice?.provider !== 'openai';
        if (shared) sttArea.append(el('div', { class: 'hint' }, 'Uses the Groq key above.'));
        else sttArea.append(field('Groq API key', input(now.groq.apiKey, 'gsk_…', (v) => saveSettings({ groq: { apiKey: v } }), 'password'), 'Free, no card: get one at <a href="https://console.groq.com/keys">console.groq.com</a>.'));
        sttArea.append(el('div', { class: 'hint' }, 'What you say is sent to Groq to be written down (not your conversations or files).'));
      } else if (now.stt.engine === 'remote') {
        sttArea.append(el('div', { class: 'hint' }, 'You use your own transcription address (Settings → Voice input).'));
      } else {
        sttArea.append(el('div', { class: 'hint' }, `Runs on this computer with a speech model chosen to fit it, downloaded the first time you talk (${speechPlan(now).model.split('/').pop()}). Change it in Settings → Voice input.`));
      }
    };
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
          el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { progress.textContent = 'Loading the offline voice…'; try { await testLocalVoice(`Hello, I'm ${state.settings.agent.name}. Lovely to meet you.`); } catch (e) { progress.textContent = `✕ ${e.message}`; } } }, '🔊 Download and play')),
          progress,
        );
      } else if (draft.engine === 'cloud') {
        // main/voice.js CLOUD_VOICES; the voice itself is chosen later in Settings → Voice output.
        const cv = state.settings.cloudVoice || {};
        const openai = cv.provider === 'openai';
        engineArea.append(
          field(
            'Service',
            choices(
              [
                { value: 'groq', title: 'Groq', desc: 'English. Free key, the same one that can write down what you say. (Voice model: Orpheus)' },
                { value: 'openai', title: 'OpenAI', desc: 'Many languages. Needs an OpenAI key (paid per use).' },
              ],
              cv.provider || 'groq',
              async (v) => (await saveSettings({ cloudVoice: { provider: v, voice: '' } }), drawEngine()),
            ),
          ),
          openai
            ? field('OpenAI API key', input(cv.apiKey, 'sk-…', (v) => saveSettings({ cloudVoice: { apiKey: v } }), 'password'))
            : field('Groq key', input(state.settings.groq.apiKey, 'gsk_…', (v) => saveSettings({ groq: { apiKey: v } }), 'password'), 'Free, no card: get one at <a href="https://console.groq.com/keys">console.groq.com</a>. The first time, accept the voice’s terms once in Groq’s Playground.'),
          el('div', { class: 'hint' }, 'Every reply that is spoken is sent to that service and costs a little (about 1–2 cents a minute). If it fails, the offline voice speaks instead.'),
          el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => speaker.say(`Hello, I'm ${state.settings.agent.name}.`) }, '🔊 Test voice')),
        );
      } else {
        engineArea.append(
          field('Address of the voice app', input(s.voice.baseUrl, 'http://localhost:3900', (v) => saveSettings({ voice: { baseUrl: v } })), 'VoiceStudio, a separate app with more natural voices and voice cloning. If it isn’t reachable, the voice on this computer speaks instead.'),
          el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => speaker.say(`Hello, I'm ${state.settings.agent.name}.`) }, '🔊 Test voice')),
        );
      }
      drawStt();
    };
    const name = s.agent.name || 'Siren';
    body.append(
      el('h2', {}, 'Voice'),
      checkbox(s.voice.ttsEnabled, 'Speak replies out loud', (v) => saveSettings({ voice: { ttsEnabled: v } })),
      el('div', {}, el('b', {}, 'Where her voice comes from')),
      // Plain choices first; the product names only as small print.
      choices(
        [
          { value: 'local', ico: '🌊', title: 'A voice on this computer', desc: 'Recommended. Free and private, and works without internet once downloaded. (Kokoro)' },
          { value: 'cloud', ico: '☁', title: 'A voice from the internet', desc: 'Natural and quick with nothing to install, on slower computers too. Spoken replies go to Groq or OpenAI.' },
          { value: 'voicestudio', ico: '🎚', title: 'A separate voice app (advanced)', desc: 'More natural voices and voice cloning. (VoiceStudio)' },
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
      el('div', {}, el('b', {}, `How ${name} hears you`)),
      choices(
        [
          { value: 'local', ico: '🔒', title: 'On this computer', desc: 'Recommended. Private and free; uses over 1 GB of memory while it listens. (Whisper)' },
          { value: 'groq', ico: '☁', title: 'Over the internet', desc: 'Light and fast, on slower computers too. What you say goes to Groq to be written down.' },
        ],
        s.stt.engine,
        async (v) => (await saveSettings({ stt: { engine: v } }), drawStt()),
      ),
      sttArea,
    );
    drawEngine();
    beforeNext = async () => {
      await saveSettings({ voice: { engine: draft.engine } });
      // Without a key the cloud can't hear anything: stay local rather than leave the mic silently broken.
      if (state.settings.stt.engine === 'groq' && !state.settings.groq?.apiKey) {
        await saveSettings({ stt: { engine: 'local' } });
        toast('No Groq key yet, so speech recognition stays on this computer.');
      }
    };
  }

  if (id === 'vault') {
    const known = await api.obsidian.vaults().catch(ignore('no Obsidian vault list', []));
    const def = await api.obsidian.defaultPath();
    // The "Obsidian's vault list" option only for someone who has Obsidian, and off unless ticked.
    const offer = registerOffer(await api.obsidian.installed().catch(ignore('Obsidian check failed', false)), draft.register);
    draft.register = offer.checked;
    draft.vault ??= s.obsidian.vaultPath || '';
    const name = s.agent.name || 'Siren';
    const opts = [{ value: '', title: 'A new folder for her', desc: def }, ...known.filter((v) => v.exists).map((v) => ({ value: v.path, title: `Use your Obsidian vault “${v.name}”`, desc: `${v.path} — her folders are added, nothing is overwritten` }))];
    body.append(
      el('h2', {}, `Where ${name} keeps your notes and memories`),
      el('p', { class: 'muted' }, 'A folder of ordinary text files on this PC. You own them, and every change can be undone. Her memory, your notes, a daily journal, your priorities, your schedule and what you learn all go there.'),
      el('p', { class: 'hint' }, 'The files are Markdown, so apps such as Obsidian can open them too. You don’t need any of them.'),
      choices(opts, draft.vault, (v) => (draft.vault = v)),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { const d = await api.dialog.pickFolder('Notes folder'); if (d) { draft.vault = d; render(); } } }, 'Choose another folder…')),
    );
    if (offer.show) body.append(checkbox(draft.register, 'Also add it to Obsidian’s vault list (Obsidian must be closed; a backup of its list is kept)', (v) => (draft.register = v)));
    // The one folder of the user's she may use by default (documents.userFolders).
    const workspace = state.settings.documents?.workspace;
    body.append(
      el('div', {}, el('b', {}, 'Where do you keep your files?')),
      el('p', { class: 'muted' }, 'Optional. Your university, work or projects folder becomes her workspace: she looks there first when you ask for a file. Without one she uses only her vault and the files you open yourself. She can’t use your other folders unless you add them in Settings → Documents & folder access.'),
      el('div', { class: 'row' }, el('button', { class: 'btn', onclick: async () => { const d = await api.dialog.pickFolder('Workspace folder'); if (d) { await saveSettings({ documents: { workspace: d } }); render(); } } }, workspace ? 'Choose another workspace…' : 'Choose a workspace folder…'), workspace ? el('span', { class: 'hint path' }, workspace) : ''),
    );
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
      el('p', { class: 'hint' }, 'The briefing is a routine: she prepares today’s schedule, priorities and what’s due while the app is open. More routines are in the Skills view.'),
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
    const customFaces = await api.faces.list().catch(() => []);
    const custom = el('div', { class: 'field', style: { display: draft.persona === 'custom' ? '' : 'none' } });
    const prompt = el('textarea', { class: 'input', rows: 6, placeholder: 'Who is your assistant? How does she talk, what does she care about, how should she treat you?' });
    prompt.value = s.agent.personality;
    const aesthetic = input(s.agent.aesthetic, 'e.g. 90s cyberpunk terminal, warm solarpunk greenhouse, minimal Scandinavian', () => {});
    custom.append(field('Describe her personality', prompt, 'Write it as you would describe a person: who she is, how she talks, what she cares about.'), field('Her style (optional)', aesthetic, 'Later, “Generate look & feel” in Settings restyles the whole app to match.'));
    body.append(
      el('h2', {}, 'Personality and face'),
      choices(
        [
          { value: 'keep', ico: '🧜', title: `Keep ${s.agent.name || 'Siren'} as she is`, desc: 'Warm, candid and capable: a chief of staff, tutor and good friend in one. You can change her personality any time in Settings.' },
          { value: 'custom', ico: '✍', title: 'Describe my own', desc: 'Her personality and style, in your own words.' },
        ],
        draft.persona,
        (v) => ((draft.persona = v), (custom.style.display = v === 'custom' ? '' : 'none')),
      ),
      custom,
      el('div', {}, el('b', {}, 'Her face')),
      choices(faceChoices(s.ui.face, customFaces, BUILT_IN), s.ui.face, (v) => saveSettings({ ui: { face: v } })),
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
    finder.helloFailed = false;
    body.append(el('h2', {}, 'First hello'), el('p', { class: 'muted' }, 'Testing everything end to end…'), el('div', { class: 'ob-hello' }));
  }

  const last = step === steps.length - 1;
  const then = (next) => async () => {
    if (moving) return;
    moving = true;
    try {
      if ((await beforeNext()) === false) return;
      await next();
    } catch (e) {
      toastError(e);
    } finally {
      moving = false;
    }
  };
  // Quick start: the privacy step and the brain finder, then done. Back to the welcome is the whole setup again.
  const quick = () => {
    mode = 'quick';
    go(1);
  };
  const back = () => {
    if (mode === 'quick' && step === 1) mode = 'full';
    go(-1);
  };
  const toBrain = () => {
    draft.cleanup?.();
    draft.cleanup = null;
    step = stepsFor(mode).indexOf('brain');
    render();
  };
  // Quick start's brain step: "Start" leads once the test answered; "Do this later" says she can't answer yet.
  const later = async () => {
    if (moving) return;
    const plan = brainNow();
    await saveFound(plan);
    await finish();
    if (!plan.canStart && plan.warn) toast(plan.warn, 'info', 10000);
  };
  const lastButtons = () => {
    if (mode === 'missed') return el('button', { class: 'btn primary', disabled: !canNext(), onclick: then(finish) }, 'Continue');
    if (mode === 'quick') {
      const ready = brainNow().canStart;
      return el('div', { class: 'row' }, el('button', { class: 'btn', onclick: later }, 'Do this later'), el('button', { class: 'btn primary', disabled: !ready, title: ready ? '' : 'Test the brain first: Start lights up once she answers.', onclick: then(finish) }, 'Start ›'));
    }
    // The whole setup ends on First hello: with a brain that didn't answer, the main button fixes that
    // instead of starting an interview that can't run.
    if (finder.helloFailed) return el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => finish() }, 'Start without a brain'), el('button', { class: 'btn primary', onclick: toBrain }, 'Set up a brain first ›'));
    return el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => finish() }, 'Start using her'), el('button', { class: 'btn primary', onclick: () => finish({ interview: true }) }, '💬 Let’s get to know each other'));
  };
  // On the first page: Quick start, or Close once the notice is accepted (the wizard opened from Settings).
  const first = mode !== 'full' ? el('span') : accepted(s) ? el('button', { class: 'btn', title: 'Keep everything as it is. Set things up later in Settings.', onclick: () => finish() }, 'Close') : el('button', { class: 'btn', title: 'The privacy step and a brain, then start. Set up the rest later in Settings.', onclick: then(quick) }, 'Quick start');
  const buildNav = () => el(
    'div',
    { class: 'ob-nav' },
    step > 0 ? el('button', { class: 'btn', onclick: back }, '‹ Back') : first,
    !last ? el('button', { class: 'btn primary', disabled: !canNext(), onclick: then(() => go(1)) }, 'Next ›') : lastButtons(),
    // Reassurance under the buttons: every control saves at once, nothing leaves this PC, setup can run again.
    el('p', { class: 'ob-saves' }, SAVES_LINE),
  );
  let nav = buildNav();
  redrawNav = () => {
    if (nav.parentNode !== card) return; // not shown yet (drawn with the card), or the wizard moved on
    const fresh = buildNav();
    nav.replaceWith(fresh);
    nav = fresh;
  };
  if (id === 'hello') firstHello(body.querySelector('.ob-hello'), { onBrain: () => redrawNav(), fix: toBrain });
  card.append(nav);
  $('#onboarding').innerHTML = '';
  $('#onboarding').append(card);
  $('#onboarding').scrollTop = 0; // the overlay scrolls (long steps); each step starts at its top
  // A new step takes the focus to its heading (the old card, and the focus in it, is gone), unless a
  // dialog or an approval over the wizard holds it.
  if (shownStep !== id && !dialogOpen()) {
    const head = card.querySelector('h2') || card.querySelector('#obTitle');
    head.tabIndex = -1;
    head.focus({ preventScroll: true });
  }
  shownStep = id;
}

function go(delta) {
  draft.cleanup?.();
  draft.cleanup = null;
  step = Math.max(0, Math.min(stepsFor(mode).length - 1, step + delta));
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
    el('h2', {}, 'Link Gmail, Calendar and more (optional, later)'),
    el('p', { class: 'muted' }, 'All of this is optional. Skip it with Next; you can link services any time later.'),
    point('✅', 'Built in, nothing to set up', 'Your schedule, notes, memory, learning tracker, vocabulary decks, web search, documents and PDFs, diagrams, routines and the Inner World all run inside the app. GitHub works once the GitHub CLI is signed in.'),
    point('✨', `${skills.length} skills included`, 'Ready-made workflows such as /explain, /proof-coach, /study-session, /weekly-review and /tour. Add your own, or import more from GitHub, in the Skills view.'),
  ];
  if (claudeBrain) {
    parts.push(
      point('🔌', 'Gmail, Calendar, Notion and more, through your Claude plan', 'With your Claude account, she can use the services you connected on claude.ai (Gmail, Google Calendar, Todoist, Notion, Canva…) and your Claude Code plugins. None come with the app: you choose them on claude.ai. Every call asks you first unless you allow a service in Settings → AI brain, and what they return is treated as data.'),
      checkbox(s.claudeCode.connectors, 'Use the services I linked on claude.ai (connectors and plugins)', (v) => saveSettings({ claudeCode: { connectors: v } })),
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
    parts.push(point('🔌', 'Gmail, Calendar, Notion and more', 'Services like Gmail, Todoist or Notion work through the Claude account brain. If you switch to it later, turn them on in Settings → AI brain.'));
  }
  parts.push(
    point('🧩', 'Extensions (optional, off)', 'REA explains how apps and websites work; God’s Eye View is a live globe of public world data. Turn them on in Settings → Extensions when you want them.'),
    point('📱', 'Your phone', 'Pair the Android app or your phone’s browser to talk to her away from the desk: Settings → Remote access, over Wi-Fi or a secure Tailscale address.'),
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
      meter.firstChild.style.transform = `scaleX(${Math.min(1, rms * 5)})`; // transform, not width: no layout per frame
      if (performance.now() < end) requestAnimationFrame(tick);
      else {
        stream.getTracks().forEach((t) => t.stop());
        ac.close();
        meter.firstChild.style.transform = 'scaleX(0)';
      }
    };
    tick();
  } catch (e) {
    toastError(new Error(`Microphone: ${e.message}`));
  }
}

// onBrain: the brain check settled (finder.helloFailed says how); fix: back to the brain step.
async function firstHello(list, { onBrain = () => {}, fix = () => {} } = {}) {
  const row = (label) => {
    const r = el('div', { class: 'ob-check' }, el('span', { class: 'ic' }, '…'), el('div', {}, el('b', {}, label), el('div', { class: 'muted' }, '')));
    list.append(r);
    const set = (ok, detail) => {
      r.querySelector('.ic').textContent = ok === true ? '✓' : ok === null ? '–' : '✕';
      r.querySelector('.ic').style.color = ok === true ? 'rgb(var(--ok))' : ok === null ? 'var(--muted)' : 'rgb(var(--err))';
      r.querySelector('.muted').textContent = detail;
    };
    set.action = (button) => r.lastChild.append(el('div', { class: 'row' }, button));
    return set;
  };
  const s = state.settings;
  const greet = row('Voice speaks the greeting');
  const greeting = s.appearance.greeting || `Hello, I'm ${s.agent.name}. What are we working on today?`;
  // The voice runs alongside the other checks: its first download can take a minute.
  const voiceDone = (async () => {
    if (!s.voice.ttsEnabled) greet(null, 'Voice is off. Turn it on any time in Settings → Voice output.');
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
      const name = s.voice.engine === 'cloud' ? 'The cloud voice' : 'VoiceStudio';
      speaker.say(greeting);
      const synth = await api.tts.speak('ok').then(() => ({ ok: true }), (e) => ({ ok: false, error: e.message }));
      if (synth.ok) greet(true, `${name} · “${greeting}”`);
      else if (s.voice.fallback !== 'off') greet(null, `${name} failed (${synth.error}) — speaking with the ${s.voice.fallback === 'system' ? 'system' : 'offline'} voice for now. Fix it in Settings → Voice output.`);
      else greet(false, `${name} failed: ${synth.error}. Check it in Settings → Voice output.`);
    }
  })();

  const brain = row('Brain answers a question');
  try {
    const r = await api.llm.test();
    brain(true, `${r.model} · “${r.reply}” · ${r.ms} ms`);
    finder.helloFailed = false;
  } catch (e) {
    // Plain words first, the provider's own words after (chatcore.testFailure), and the way to fix it.
    brain(false, `${HELLO_BRAIN_FAILED} ${testFailure(plainError(e), { settings: state.settings }).line.replace(/^✕ /, '')}`);
    brain.action(el('button', { class: 'btn small', onclick: fix }, 'Fix this'));
    finder.helloFailed = true;
  }
  onBrain();
  const vault = row('Her notes folder can be saved to');
  const st = await api.obsidian.status().catch(ignore('notes folder status failed', {}));
  vault(Boolean(st.ok), st.ok ? `${st.path} · ${st.count} notes` : 'Her notes folder isn’t available. Choose one in Settings → Knowledge.');
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
