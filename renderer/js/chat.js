// Chat view: conversation history, streaming messages, tool-call chips, voice integration.
import { $, api, el, renderMarkdown, timeAgo, toast, toastError, confirmDialog, promptDialog, on, emit } from './util.js';
import { bargeIn, bargeInOver } from './bargein.js';
import { practiceLanguage, quoteFilter } from './practice.js';
import { state, setFlag, setCaption, ttsActive, saveSettings, loadSettings, raiseAlert, celebrate } from './state.js';
import { logEvent } from './util.js';
import { speaker } from './voice.js';
import { handoffSlot } from './handoff.js';

let currentId = null;
let conversations = [];
let active = null;
let queued = null; // message waiting for the interrupted turn to finish // { requestId, bubble, text, tools: Map, wrap, renderQueued }

const messagesEl = () => $('#messages');

export function initChat() {
  emptyTemplate = $('#emptyState').cloneNode(true);
  $('#emptyState').replaceWith(emptyStateNode());
  const input = $('#input');
  input.addEventListener('input', autosize);
  input.addEventListener('input', suggestSkills);
  input.addEventListener('keydown', (e) => {
    if (slashPick(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendFromInput();
    }
  });
  $('#sendBtn').onclick = sendFromInput;
  $('#stopBtn').onclick = stop;
  $('#newChatBtn').onclick = newChat;
  $('#convSearch').addEventListener('input', renderConvList);
  $('#chatTitle').ondblclick = renameCurrent;
  document.querySelectorAll('.suggestion').forEach((b) => (b.onclick = () => send(b.textContent)));

  $('#speakToggle').onclick = async () => {
    await saveSettings({ voice: { autoSpeak: !state.settings.voice.autoSpeak } });
    if (!state.settings.voice.autoSpeak) speaker.stop();
  };
  on('settings', updateSpeakToggle);

  api.on('chat:event', handleEvent);
  loadSkillList();
  on('skills-changed', loadSkillList);

  // "↓ Latest" appears when you scrolled up away from the newest message.
  const box = messagesEl();
  const latest = $('#scrollLatest');
  box.addEventListener('scroll', () => latest.classList.toggle('hidden', box.scrollHeight - box.scrollTop - box.clientHeight < 300));
  latest.onclick = () => {
    box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    latest.classList.add('hidden');
  };
  // Talking over the agent silences the rest of this reply, unless it answers an approval or turns out
  // to be nothing (bargein.js).
  on('barge-in', () => bargeIn(active, { approvalPending: Boolean(state.approvalPending) }));
  on('barge-in-over', () => bargeInOver(active));

  refreshList().then(() => {
    if (conversations[0]) openConversation(conversations[0].id);
  });
}

function updateSpeakToggle() {
  const b = $('#speakToggle');
  const on_ = state.settings.voice.ttsEnabled && state.settings.voice.autoSpeak;
  b.textContent = on_ ? '🔊 Voice on' : '🔇 Voice off';
  b.classList.toggle('off', !on_);
}

function autosize() {
  const t = $('#input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(220, t.scrollHeight)}px`;
}

function sendFromInput() {
  const input = $('#input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosize();
  send(text);
}

// ------------------------------------------------------------- conversations
export async function refreshList() {
  conversations = await api.conv.list().catch(() => []);
  renderConvList();
}

function renderConvList() {
  const q = $('#convSearch').value.toLowerCase();
  const list = $('#convList');
  list.innerHTML = '';
  const startToday = new Date().setHours(0, 0, 0, 0);
  const groups = [
    ['Today', (c) => c.updatedAt >= startToday],
    ['Yesterday', (c) => c.updatedAt >= startToday - 86400000 && c.updatedAt < startToday],
    ['This week', (c) => c.updatedAt >= startToday - 7 * 86400000 && c.updatedAt < startToday - 86400000],
    ['Earlier', (c) => c.updatedAt < startToday - 7 * 86400000],
  ];
  const filtered = conversations.filter((c) => !q || (c.title || '').toLowerCase().includes(q));
  for (const [label, test] of groups) {
    const items = filtered.filter(test);
    if (!items.length) continue;
    list.append(el('li', { class: 'conv-group' }, label));
    for (const c of items) {
      list.append(
        el(
          'li',
          { class: `conv-item ${c.id === currentId ? 'active' : ''}`, onclick: () => openConversation(c.id), title: c.title },
          el('div', { class: 't' }, c.title || 'Untitled'),
          el('div', { class: 'd' }, `${c.count} messages · ${timeAgo(c.updatedAt)}`),
          el('button', { class: 'x', title: 'Delete', onclick: (e) => (e.stopPropagation(), deleteConversation(c)) }, '✕'),
        ),
      );
    }
  }
  if (!filtered.length) list.append(el('li', { class: 'muted', style: { padding: '10px', fontSize: '13px' } }, q ? 'No matches.' : 'No conversations yet.'));
}

async function deleteConversation(c) {
  if (!(await confirmDialog('Delete conversation', `Delete “${c.title}”? This cannot be undone.`, 'Delete'))) return;
  await api.conv.delete(c.id);
  if (c.id === currentId) newChat();
  refreshList();
}

async function renameCurrent() {
  if (!currentId) return;
  const title = await promptDialog('Rename conversation', $('#chatTitle').textContent);
  if (!title) return;
  await api.conv.rename(currentId, title);
  $('#chatTitle').textContent = title;
  refreshList();
}

export function newChat() {
  if (active) stop();
  currentId = null;
  $('#chatTitle').textContent = 'New conversation';
  messagesEl().innerHTML = '';
  messagesEl().append(emptyStateNode());
  renderConvList();
  $('#input').focus();
}

let emptyTemplate = null;
function emptyStateNode() {
  const node = emptyTemplate.cloneNode(true);
  node.querySelectorAll('.suggestion').forEach((b) => (b.onclick = () => send(b.textContent)));
  const name = state.settings?.agent?.name || 'Nexus';
  node.querySelector('#welcomeTitle').textContent = `${name} online`;
  node.querySelector('#welcomeGreeting').textContent = state.settings?.appearance?.greeting || '';
  node.querySelector('#pttHint').textContent = state.settings?.stt?.pttKey || 'F8';
  node.querySelector('.suggestions').before(handoffSlot(openConversation)); // "Where we left off"
  return node;
}

export async function openConversation(id) {
  if (active) return toast('Wait for the current reply to finish (or press stop).');
  const conv = await api.conv.get(id).catch(() => null);
  if (!conv) return newChat();
  currentId = conv.id;
  $('#chatTitle').textContent = conv.title;
  const box = messagesEl();
  box.innerHTML = '';
  if (!conv.messages.length) box.append(emptyStateNode());
  for (const m of conv.messages) if (!m.hidden) box.append(messageNode(m));
  box.scrollTop = box.scrollHeight;
  renderConvList();
  api.llm.prewarm(conv.id).catch(() => {});
}

// ------------------------------------------------------------------ messages
function avatarNode(role) {
  const a = el('div', { class: 'avatar' });
  if (role === 'assistant') {
    if (state.settings.agent.avatar) a.style.backgroundImage = `url(${state.settings.agent.avatar})`;
    else a.textContent = (state.settings.agent.name || 'N')[0].toUpperCase();
  } else a.textContent = 'YOU'.slice(0, 1);
  return a;
}

function toolChip(t) {
  const chip = el(
    'details',
    { class: `tool-chip ${t.ok === undefined ? '' : t.ok ? 'ok' : 'fail'}` },
    el('summary', {}, el('span', { class: 'st' }), el('span', {}, prettyTool(t.name)), el('span', { class: 'muted' }, briefInput(t.input))),
    el('pre', {}, `input: ${JSON.stringify(t.input, null, 1)}\n\n${t.preview ? `result: ${t.preview}` : 'running…'}`),
  );
  return chip;
}

const TOOL_LABELS = {
  create_pdf: '📄 Created a PDF',
  quick_note: '📝 Jotted a note',
  skill_list: '⚡ Listed skills',
  skill_run: '⚡ Ran a skill',
  skill_save: '⚡ Saved a skill',
  skill_delete: '⚡ Deleted a skill',
  look_at_screen: '🖥 Looked at your screen',
  learning_update: '🎓 Updated your learning tracker',
  learning_overview: '🎓 Checked your learning',
  vocab_add: '🗂 Added to your deck',
  vocab_review: '🗂 Picked cards to review',
  vocab_grade: '🗂 Graded a card',
  language_practice: '🗣 Language practice',
  habit_status: '✅ Checked your habits',
  habit_log: '✅ Ticked off a habit',
  habit_add: '✅ Started tracking a habit',
  habit_pause: '✅ Paused a habit',
  skilltree_view: '🌌 Looked at your skill tree',
  skilltree_update: '🌌 Updated your skill tree',
  skilltree_remove: '🌌 Removed a skill',
  routine_list: '⏰ Listed routines',
  routine_save: '⏰ Saved a routine',
  routine_delete: '⏰ Deleted a routine',
  routine_run: '⏰ Ran a routine',
  app_guide: '🧭 Looked up what I can do',
  setup_add_persona: '🎭 Added a persona',
  persona_list: '🎭 Listed personas',
  persona_switch: '🎭 Switched persona',
  theme_get: '🎨 Checked my look',
  theme_update: '🎨 Changed my look',
  setup_scan_hardware: '🖥 Checked the hardware',
  memory_save: '🧠 Saved memory',
  memory_update: '🧠 Updated memory',
  memory_delete: '🧠 Deleted memory',
  memory_search: '🧠 Searched memory',
  calendar_get_events: '📅 Checked schedule',
  calendar_list_entries: '📅 Looked up schedule',
  calendar_add_event: '📅 Added to schedule',
  calendar_update_event: '📅 Changed schedule',
  calendar_delete_event: '📅 Removed from schedule',
  voice_list: '🎙 Listed voices',
  voice_design: '🎙 Designed a voice',
  voice_clone: '🎙 Cloned a voice',
  voice_calibrate: '🎙 Calibrated your voice',
  github_list_repos: '🐙 Listed repositories',
  github_repo: '🐙 Looked at a repository',
  github_issues: '🐙 Read issues',
  github_pull_requests: '🐙 Read pull requests',
  github_read_file: '🐙 Read a file',
  github_search: '🐙 Searched code',
  github_clone: '🐙 Cloned a repository',
  github_start_branch: '🐙 Started a branch',
  github_status: '🐙 Checked repo status',
  github_change_file: '🐙 Changed a file',
  github_commit: '🐙 Committed',
  github_push: '🐙 Pushed to GitHub',
  github_create_pull_request: '🐙 Opened a pull request',
  voice_delete: '🎙 Deleted a voice',
  vault_search: '🔎 Searched vault',
  vault_read_note: '📓 Read note',
  vault_list_notes: '📓 Listed notes',
  vault_write_note: '✍ Wrote note',
  vault_delete_note: '🗑 Deleted note',
  web_search: '🌐 Searched the web',
  web_fetch: '🌐 Read web page',
  WebSearch: '🌐 Searched the web',
  WebFetch: '🌐 Read web page',
  ToolSearch: '🔌 Looked up a connector',
  connectors_list: '🔌 Checked your connectors',
  Skill: '⚡ Loaded a plugin skill',
  code_list_files: '💾 Listed source files',
  code_read_file: '💾 Read source',
  code_search: '💾 Searched source',
  code_grep: '💾 Searched source (exact)',
  code_outline: '💾 Outlined a file',
  code_map: '🗺 Mapped its architecture',
  code_diff: '🛠 Reviewed its changes',
  run_tests: '🧪 Ran its tests',
  code_edit_file: '🛠 Edited own code',
  code_write_file: '🛠 Wrote own code',
  code_check: '🛠 Checked code',
  self_change_commit: '✦ Recorded self-change',
  self_change_plan: '✦ Proposed a self-change',
  setup_get_state: '⚙ Checked its setup',
  setup_configure: '⚙ Configured itself',
  setup_profile: '👤 Noted about you',
  setup_generate_look: '✨ Redesigned its look',
  setup_pick_image: '🖼 Asked for an image',
  setup_register_vault: '◆ Added vault to Obsidian',
  setup_check_service: '🔌 Checked a connection',
  setup_request_secret: '🔒 Asked for a key (secure field)',
  setup_complete: '✓ Finished setup',
  memory_get: '🧠 Recalled memories',
  daily_note_log: '📔 Logged to daily note',
  priorities_update: '📌 Updated priorities',
  profile_update: '👤 Updated your profile',
  job_save: '🧭 Saved a job procedure',
  job_add_lesson: '🧭 Added a lesson',
  vault_note_history: '⟲ Checked note history',
  vault_restore_note: '⟲ Restored a note',
  history_search: '🔎 Searched past chats',
  diagnose: '🩺 Ran diagnostics',
  read_app_log: '🩺 Read its log',
  analyze_errors: '🩺 Analyzed its errors',
  helper_app_start: '🔌 Started a helper app',
  settings_read: '⚙ Read its settings',
  settings_update: '⚙ Changed a setting',
  Read: '💾 Read file',
  Edit: '🛠 Edited file',
  Write: '🛠 Wrote file',
  Glob: '💾 Listed files',
  Grep: '💾 Searched files',
  Bash: '⌨ Ran command',
  open_document: '📄 Opened document',
  close_document: '📄 Closed document',
  find_document: '🔎 Looked for a file',
  list_monitors: '🖥 Checked monitors',
  identify_monitors: '🖥 Showed monitor numbers',
  move_window: '🖥 Moved a window',
  set_window_state: '🖥 Changed a window',
  create_bug_report: '🐞 Wrote a bug report',
  read_document: '📄 Read document',
  list_recent_documents: '📄 Recent documents',
};
// Connector tools (mcp__<server>__<tool>, see main/connectors.js): "🔌 Todoist · find tasks".
function connectorLabel(n) {
  const m = /^mcp__(.+?)__(.+)$/.exec(n);
  if (!m || m[1] === 'nexus') return '';
  const service = m[1].replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/_/g, ' ');
  return `🔌 ${service} · ${m[2].replace(/[-_]+/g, ' ')}`;
}
const prettyTool = (n) => TOOL_LABELS[n] || connectorLabel(n) || `🔧 ${n}`;

const FILLERS = {
  web: ['Let me look that up.', 'Searching the web.', 'One moment, checking online.'],
  calendar: ['Checking your calendar.', 'Let me look at your schedule.'],
  vault: ['Let me check my notes.', 'Looking through the vault.'],
  code: ['Let me look at my code.', 'Checking how I work.'],
  doc: ['Opening that now.', 'Reading the document.'],
  other: ['One moment.', 'On it.', 'Give me a second.'],
};
function fillerFor(name) {
  const g = /web|Web/.test(name) ? 'web' : /calendar/.test(name) ? 'calendar' : /vault|daily|priorit|job|profile/.test(name) ? 'vault' : /code|Read|Grep|Glob|Edit|Write|self/.test(name) ? 'code' : /document/.test(name) ? 'doc' : 'other';
  const list = FILLERS[g];
  return list[Math.floor(Math.random() * list.length)];
}
function briefInput(input) {
  if (!input) return '';
  const v = input.title || input.query || input.path || input.file_path || input.url || input.pattern || input.command || input.summary || input.setting || input.section || input.service || input.id || input.start_date || input.folder || '';
  if (!v) return '';
  let s = String(v);
  if (/^([a-z]:)?[\\/]/i.test(s)) s = s.split(/[\\/]/).filter(Boolean).slice(-2).join('/'); // long absolute paths → last segments
  return `· ${s.slice(0, 60)}`;
}

function messageNode(m) {
  const wrap = el('div', { class: `msg ${m.role}`, 'data-id': m.id });
  const body = el('div', { class: 'msg-body' });
  if (m.toolCalls?.length) body.append(el('div', { class: 'tools' }, m.toolCalls.map(toolChip)));
  const bubble = el('div', { class: 'bubble' });
  if (m.role === 'assistant') {
    bubble.innerHTML = renderMarkdown(m.content || '');
    bubble.dataset.stamp = stamp(m);
  } else bubble.textContent = m.display || m.content;
  const tags = [m.skill && `⚡ skill /${m.skill}`, m.screen && '🖥 screen shared'].filter(Boolean);
  if (tags.length) body.append(el('div', { class: 'msg-tag' }, tags.map((t) => el('span', {}, t))));
  body.append(bubble);
  body.append(metaNode(m));
  wrap.append(avatarNode(m.role), body);
  return wrap;
}

// The telemetry line the HUD shows on a reply (hud.css): "NEXUS · 14:32:05 · OPUS 5.5".
const agentName = () => state.settings?.agent?.name || 'Nexus';
function stamp(m) {
  const time = new Date(m.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const model = String(m.model || '').replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2').replace(/-/g, ' ');
  return [agentName(), time, model].filter(Boolean).join(' · ');
}

function metaNode(m) {
  const meta = el('div', { class: 'msg-meta' }, el('span', {}, new Date(m.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  if (m.model) meta.append(el('span', {}, m.model));
  meta.append(el('button', { onclick: () => (navigator.clipboard.writeText(m.content || ''), toast('Copied')) }, 'Copy'));
  if (m.role === 'assistant') {
    meta.append(
      el('button', { onclick: () => speaker.say(m.content || '') }, 'Speak'),
      el('button', { title: 'Save this reply as a note in your vault Inbox', onclick: () => api.notes.quick(m.content || '').then((r) => toast(`Saved to ${r.path}`), toastError) }, 'Save as note'),
      el('button', {
        title: 'Save this reply as a PDF',
        onclick: () => {
          const title = `${$('#chatTitle').textContent || 'Reply'} – ${new Date(m.createdAt || Date.now()).toLocaleDateString()}`;
          api.pdf.fromMarkdown(title, m.content || '').then((r) => toast(`Saved ${r.path}`), toastError);
        },
      }, 'PDF'),
    );
  }
  return meta;
}

function scrollToBottom(force = false) {
  const box = messagesEl();
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
}

// --------------------------------------------------------------------- send
// Spoken input: interrupts a reply in progress (the old turn is stopped and drained), then sends.
export function sendVoice(text) {
  if (!state.settings.stt.autoSend) {
    const input = $('#input');
    input.value = (input.value ? `${input.value} ` : '') + text;
    autosize();
    input.focus();
    return;
  }
  if (active) {
    queued = { text, voice: true };
    stop();
    return;
  }
  send(text, { voice: true });
}

export async function send(text, { voice = false, hidden = false } = {}) {
  text = String(text || '').trim();
  if (!text) return;
  if (active) {
    queued = { text, voice };
    toast('Interrupting the current reply…');
    stop();
    return;
  }
  speaker.stop();
  $('#emptyState')?.remove();
  messagesEl().querySelector('.empty-state')?.remove();

  const requestId = `r${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const sharing = !$('#screenThumb').classList.contains('hidden') && state.settings.screen?.attachToMessages !== false;
  const slash = text.match(/^\/([\w-]+)/);
  if (!hidden) messagesEl().append(messageNode({ id: 'pending-user', role: 'user', content: text, createdAt: Date.now(), screen: sharing, skill: slash && skillList.some((x) => x.slug === slash[1].toLowerCase()) ? slash[1].toLowerCase() : null }));
  const wrap = el('div', { class: 'msg assistant' });
  const body = el('div', { class: 'msg-body' });
  const tools = el('div', { class: 'tools' });
  const bubble = el('div', { class: 'bubble streaming', 'data-stamp': `${agentName()} · live` });
  body.append(tools, bubble);
  wrap.append(avatarNode('assistant'), body);
  messagesEl().append(wrap);
  scrollToBottom(true);

  // During language practice, notes in a blockquote are shown but not spoken (practice.js).
  active = { requestId, wrap, body, bubble, toolsEl: tools, text: '', tools: new Map(), muted: false, speech: practiceLanguage(state.settings) ? quoteFilter() : (d) => d };
  setFlag('generating', true);
  setFlag('streamingText', false);
  setCaption(text, 'user');
  $('#sendBtn').classList.add('hidden');
  $('#stopBtn').classList.remove('hidden');

  try {
    const res = await api.chat.send({ conversationId: currentId, text, requestId, voice, hidden });
    currentId = res.conversationId;
  } catch (err) {
    finish();
    bubble.classList.add('error-bubble');
    bubble.textContent = err.message;
  }
}

function stop() {
  if (active) api.chat.abort(active.requestId).catch(() => {});
  speaker.stop();
}

function renderActive() {
  if (!active || active.renderQueued) return;
  active.renderQueued = true;
  requestAnimationFrame(() => {
    if (!active) return;
    active.renderQueued = false;
    active.bubble.innerHTML = renderMarkdown(active.text);
    scrollToBottom();
  });
}

function handleEvent(ev) {
  if (!active || ev.requestId !== active.requestId) return;
  switch (ev.type) {
    case 'start':
      currentId = ev.conversationId;
      $('#chatTitle').textContent = ev.title || 'Conversation';
      refreshList();
      break;
    case 'text':
      active.text += ev.delta;
      if (!state.streamingText) setFlag('streamingText', true);
      if (ttsActive() && !active.muted) speaker.feed(active.speech(ev.delta));
      else setCaption(active.text.slice(-280), 'assistant');
      renderActive();
      break;
    case 'retract':
      active.text = active.text.slice(0, Math.max(0, active.text.length - ev.chars));
      speaker.stop();
      renderActive();
      break;
    case 'thinking':
      break;
    case 'tool_start': {
      setFlag('toolsRunning', state.toolsRunning + 1);
      const chip = toolChip({ name: ev.name, input: ev.input });
      active.tools.set(ev.id, { chip, input: ev.input });
      if (ttsActive() && state.settings.voice.filler && !active.muted && !active.text.trim()) speaker.filler(fillerFor(ev.name));
      active.toolsEl.append(chip);
      scrollToBottom();
      break;
    }
    case 'tool_end': {
      setFlag('toolsRunning', Math.max(0, state.toolsRunning - 1));
      const prev = active.tools.get(ev.id);
      const chip = toolChip({ name: ev.name, input: prev?.input, ok: ev.ok, preview: ev.preview });
      prev ? prev.chip.replaceWith(chip) : active.toolsEl.append(chip);
      active.tools.set(ev.id, { chip, input: prev?.input });
      break;
    }
    case 'notice':
      active.body.insertBefore(el('div', { class: 'notice' }, `⚠ ${ev.message}`), active.bubble);
      break;
    case 'memory_changed':
      emit('memory-changed');
      break;
    case 'open_document':
      emit('open-document', ev.path);
      break;
    case 'vault_changed':
      emit('vault-changed', ev.path);
      break;
    case 'self_changed':
      emit('self-changed', ev.change);
      break;
    case 'setup_complete':
      emit('setup-complete', ev.summary);
      break;
    case 'setup_pick_image':
      emit('setup-pick-image');
      break;
    case 'settings_changed':
      loadSettings();
      break;
    case 'calendar_changed':
      emit('calendar-changed');
      break;
    case 'skills_changed':
      emit('skills-changed');
      break;
    case 'habits_changed':
      emit('habits-changed');
      break;
    case 'skilltree_changed':
      emit('skilltree-changed');
      break;
    case 'voice_preview':
      if (state.settings.voice.ttsEnabled) speaker.say(ev.text, { voice: ev.voice });
      break;
    case 'done': {
      const m = ev.message;
      active.bubble.classList.remove('streaming');
      active.bubble.innerHTML = renderMarkdown(m.content || '');
      active.bubble.dataset.stamp = stamp(m);
      active.body.append(metaNode(m));
      if (ttsActive() && !active.muted) speaker.flush();
      finish();
      if (!ttsActive()) celebrate();
      refreshList();
      break;
    }
    case 'error':
    case 'aborted':
      active.bubble.classList.remove('streaming');
      if (ev.type === 'error') {
        active.bubble.classList.add('error-bubble');
        active.bubble.innerHTML = renderMarkdown(`${active.text ? `${active.text}\n\n---\n` : ''}**Error:** ${ev.message}`);
        toastError(new Error(ev.message));
        raiseAlert(ev.message);
        logEvent('error', 'reply failed', ev.message);
      } else active.bubble.innerHTML = renderMarkdown(active.text || '*(stopped)*');
      finish();
      refreshList();
      break;
  }
}

function finish() {
  active = null;
  state.toolsRunning = 0;
  if (queued) {
    const q = queued;
    queued = null;
    setTimeout(() => send(q.text, { voice: q.voice }), 0);
  }
  setFlag('generating', false);
  setFlag('streamingText', false);
  if (!speaker.busy) setCaption('');
  $('#sendBtn').classList.remove('hidden');
  $('#stopBtn').classList.add('hidden');
}

export function currentConversationId() {
  return currentId;
}

// Continue in an existing conversation without re-rendering the message list (used by the setup
// flow, so the scripted first exchange stays on screen as the agent takes over).
export function continueIn(id, title) {
  currentId = id;
  if (title) $('#chatTitle').textContent = title;
  refreshList();
}

// ------------------------------------------------------- /skill commands
// Typing "/" shows the saved skills; Tab or Enter completes the highlighted one.
let skillList = [];
let picker = null;

export async function loadSkillList() {
  skillList = await api.skills.list().catch(() => []);
}

function suggestSkills() {
  const input = $('#input');
  const m = input.value.match(/^\/([\w-]*)$/);
  picker?.el.remove();
  picker = null;
  if (!m) return;
  const matches = skillList.filter((s) => s.slug.startsWith(m[1].toLowerCase()) || s.name.toLowerCase().includes(m[1].toLowerCase())).slice(0, 6);
  if (!matches.length) return;
  const list = el('div', { class: 'dropdown-menu open slash-menu' });
  matches.forEach((s, i) => list.append(el('button', { class: i === 0 ? 'sel' : '', onclick: () => complete(s) }, el('b', {}, `/${s.slug}`), el('span', { class: 'muted' }, ` ${s.description || s.name}`))));
  $('.composer').append(list);
  picker = { el: list, matches, index: 0 };
}

function complete(s) {
  const input = $('#input');
  input.value = `/${s.slug} `;
  picker?.el.remove();
  picker = null;
  input.focus();
}

function slashPick(e) {
  if (!picker) return false;
  if (e.key === 'Escape') {
    picker.el.remove();
    picker = null;
    return true;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    picker.index = (picker.index + (e.key === 'ArrowDown' ? 1 : picker.matches.length - 1)) % picker.matches.length;
    [...picker.el.children].forEach((b, i) => b.classList.toggle('sel', i === picker.index));
    return true;
  }
  if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
    e.preventDefault();
    complete(picker.matches[picker.index]);
    return true;
  }
  return false;
}
