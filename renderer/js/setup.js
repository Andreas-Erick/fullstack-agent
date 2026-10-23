// First-run setup by conversation. The agent asks one question at a time and configures itself.
// Phase 1 (scripted, needs no model): find or connect a brain — Claude account, FreeLLMAPI or API key.
// Phase 2 (the agent itself): an interview in a dedicated "setup" conversation, using setup tools to
// apply each answer (name, persona, look, voice, mic mode, vault, face, permissions, profile…).
import { $, api, el, renderMarkdown, toast, toastError, on, logEvent } from './util.js';
import { state, saveSettings, loadSettings } from './state.js';
import { speaker } from './voice.js';
import { switchView } from './nav.js';
import { newChat, continueIn, send, refreshList } from './chat.js';
import { shrinkImage } from './settings.js';

let pending = null; // { choices, input, resolve } — the scripted question waiting for an answer

export function initSetup() {
  on('setup-complete', async (summary) => {
    state.setupMode = false;
    await loadSettings();
    refreshList();
    toast('✓ Setup complete — I’m ready.');
    logEvent('info', 'setup complete', summary);
  });
  on('setup-pick-image', async () => {
    const img = await api.dialog.pickImage().catch(() => null);
    if (!img) return toast('No image chosen.');
    await saveSettings({ agent: { avatar: await shrinkImage(img, 384) } });
    toast('Image set.');
  });
}

export async function startSetup() {
  state.setupMode = true;
  switchView('chat');
  newChat();
  $('#chatTitle').textContent = 'First-run setup';
  const box = $('#messages');
  box.innerHTML = '';
  try {
    const ok = await bootstrapBrain();
    if (!ok) return;
    const id = await api.setup.start();
    continueIn(id, 'First-run setup');
    send('Hi! You have just been installed on my computer. Please set yourself up with me.', { hidden: true });
  } catch (err) {
    toastError(err);
  }
}

// ---------------------------------------------------------- chat bubbles
function bubble(text) {
  const wrap = el('div', { class: 'msg assistant' });
  const avatar = el('div', { class: 'avatar' }, (state.settings.agent.name || 'N')[0].toUpperCase());
  const body = el('div', { class: 'msg-body' }, el('div', { class: 'bubble', html: renderMarkdown(text) }));
  wrap.append(avatar, body);
  $('#messages').append(wrap);
  $('#messages').scrollTop = $('#messages').scrollHeight;
  if (state.settings.voice.ttsEnabled) speaker.say(text.replace(/\*\*/g, ''));
  return body;
}

function userBubble(text) {
  const wrap = el('div', { class: 'msg user' }, el('div', { class: 'avatar' }, 'Y'), el('div', { class: 'msg-body' }, el('div', { class: 'bubble' }, text)));
  $('#messages').append(wrap);
}

const say = (text) => bubble(text);

// Ask a scripted question with quick replies and/or a text input. Resolves with the chosen value.
function ask(text, { choices = [], input = null } = {}) {
  const body = bubble(text);
  return new Promise((resolve) => {
    const row = el('div', { class: 'suggestions', style: { justifyContent: 'flex-start', marginTop: '8px' } });
    const done = (value, label) => {
      row.remove();
      pending = null;
      if (label) userBubble(label);
      resolve(value);
    };
    for (const c of choices) row.append(el('button', { class: 'suggestion', onclick: () => done(c.value, c.label) }, c.label));
    if (input) {
      const field = el('input', { class: 'input', type: input.type || 'text', value: input.value || '', placeholder: input.placeholder || '', style: { minWidth: '320px' } });
      field.addEventListener('keydown', (e) => e.key === 'Enter' && done(field.value.trim(), input.type === 'password' ? '••••••' : field.value.trim() || '(skip)'));
      row.prepend(field, el('button', { class: 'suggestion', onclick: () => done(field.value.trim(), input.type === 'password' ? '••••••' : field.value.trim() || '(skip)') }, 'OK'));
      setTimeout(() => field.focus(), 50);
    }
    body.append(row);
    pending = { choices, input, done };
  });
}

// Spoken answers during the scripted part: match a quick reply by its words, or fill the input.
export function handleSetupVoice(text) {
  if (!pending) return false;
  const t = text.toLowerCase();
  const yes = /^(yes|yeah|yep|sure|ok|okay|use it|do it)\b/.test(t);
  const pick = pending.choices.find((c) => (yes && c.yes) || c.label.toLowerCase().split(/\W+/).filter((w) => w.length > 3).some((w) => t.includes(w)));
  if (pick) pending.done(pick.value, text);
  else if (pending.input && pending.input.type !== 'password') pending.done(text.trim(), text);
  else toast('Please click one of the options.');
  return true;
}

// Guided FreeLLMAPI connection: check, explain what's wrong, walk through the fix, repeat.
async function connectFreeLLMAPI() {
  await saveSettings({ llm: { provider: 'openai' } });
  say('**FreeLLMAPI** is a small server on your computer that gives me free language models through an OpenAI-compatible address (it ends in `/v1`). Let me see if it’s running…');
  for (;;) {
    const r = await api.setup.checkService('freellmapi').catch((e) => ({ ok: false, status: 'error', detail: e.message, steps: [] }));
    if (r.ok) {
      say(`✓ Found it at \`${r.url}\` — ${r.detail}`);
      return testBrain();
    }
    const steps = (r.steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
    const choices = [{ label: 'Check again', value: 'again', yes: true }, { label: 'Use a different address', value: 'url' }];
    if (r.status === 'auth') choices.unshift({ label: 'Enter the token', value: 'token', yes: true });
    choices.push({ label: 'Use something else', value: 'back' });
    const next = await ask(`${r.detail}\n\nHere’s how to fix it:\n${steps}`, { choices });
    if (next === 'back') return false;
    if (next === 'url') {
      const url = await ask('What address does FreeLLMAPI show? (usually ends in /v1)', { input: { value: state.settings.llm.baseUrl, placeholder: 'http://localhost:3001/v1' } });
      if (url) await saveSettings({ llm: { baseUrl: url } });
    }
    if (next === 'token') {
      const token = await ask('Paste the token from FreeLLMAPI’s configuration (stored encrypted on this computer).', { input: { type: 'password', placeholder: 'token' } });
      if (token) await saveSettings({ llm: { apiKey: token } });
    }
  }
}

// ------------------------------------------------------------ the brain
async function testBrain() {
  const line = bubble('Let me check that I can think…');
  try {
    const r = await api.llm.test();
    line.querySelector('.bubble').innerHTML = renderMarkdown(`✓ My brain works (${r.model}).`);
    return true;
  } catch (err) {
    line.querySelector('.bubble').innerHTML = renderMarkdown(`That didn't work: \`${err.message.slice(0, 300)}\``);
    return false;
  }
}

async function bootstrapBrain() {
  const first = await ask(
    `Hi! I'm your new assistant. I'll set myself up by asking you a few questions — one at a time. You can type or hold **${state.settings.stt.pttKey}** to answer by voice.\n\nFirst I need a *brain* — the language model I think with. Shall I look for one?`,
    { choices: [{ label: 'Yes, let’s start', value: 'go', yes: true }, { label: 'I prefer a settings form', value: 'form' }, { label: 'Skip setup', value: 'skip' }] },
  );
  if (first === 'form') {
    state.setupMode = false;
    (await import('./onboarding.js')).startOnboarding();
    return false;
  }
  if (first === 'skip') {
    state.setupMode = false;
    await api.setup.skip();
    await loadSettings();
    say('Okay — everything can be configured later in **Config**.');
    return false;
  }

  for (;;) {
    const st = await api.claude.status().catch(() => ({ installed: false }));
    let choice;
    if (st.loggedIn) {
      choice = await ask(`I found your **Claude account** (${st.email || 'signed in'}${st.subscription ? `, ${st.subscription} plan` : ''}) through Claude Code. Shall I use it as my brain?`, {
        choices: [{ label: 'Use my Claude account', value: 'claude', yes: true }, { label: 'Use something else', value: 'other' }],
      });
      if (choice === 'claude') {
        await saveSettings({ llm: { provider: 'claude-code' } });
        if (await testBrain()) return true;
        continue;
      }
    } else if (st.installed) {
      choice = await ask('Claude Code is installed, but no Claude account is connected. Connect yours? A window opens where you sign in.', {
        choices: [{ label: 'Connect my Claude account', value: 'login', yes: true }, { label: 'Use something else', value: 'other' }],
      });
      if (choice === 'login') {
        await api.claude.login().catch(toastError);
        await ask('Finish signing in in the window that just opened, then tell me.', { choices: [{ label: 'I’m signed in', value: 'done', yes: true }] });
        continue;
      }
    } else {
      choice = await ask(
        `I recommend using your **Claude account** through Claude Code, but it isn't installed yet. You can install it with:\n\n\`${await api.claude.installHint()}\`\n\nOr use another brain.`,
        { choices: [{ label: 'I installed it — check again', value: 'again', yes: true }, { label: 'Use FreeLLMAPI', value: 'openai' }, { label: 'Use an Anthropic API key', value: 'anthropic' }] },
      );
      if (choice === 'again') continue;
    }
    if (choice === 'other') {
      choice = await ask('Which brain should I use instead?', {
        choices: [{ label: 'FreeLLMAPI (local)', value: 'openai' }, { label: 'Anthropic API key', value: 'anthropic' }, { label: 'Back to Claude account', value: 'again' }],
      });
      if (choice === 'again') continue;
    }
    if (choice === 'openai') {
      if (await connectFreeLLMAPI()) return true;
      continue;
    }
    if (choice === 'anthropic') {
      const key = await ask('Paste your Anthropic API key (it’s stored encrypted on this computer).', { input: { type: 'password', placeholder: 'sk-ant-…' } });
      await saveSettings({ llm: { provider: 'anthropic' }, anthropic: { apiKey: key } });
      if (await testBrain()) return true;
    }
  }
}
