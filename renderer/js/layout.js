// Window-level UI: zoom, the chat view's layout (chat only · split · face), the resizable face panel,
// full screen, screen sharing (picker, live preview, stop) and the quick-note box.
import { $, $$, api, el, toast, toastError, modal, on, emit, debounce } from './util.js';
import { state, saveSettings, noteActivity } from './state.js';
import { switchView } from './nav.js';
import { currentConversationId } from './chat.js';

const ZOOM_STEP = 0.1;
let appliedZoom = null;
let faceHost = null;

export function initLayout({ miniFace }) {
  faceHost = miniFace;

  // Zoom: buttons, Ctrl + / Ctrl − / Ctrl 0, Ctrl + wheel (a document under the pointer zooms itself instead).
  $('#zoomIn').onclick = () => zoomBy(1);
  $('#zoomOut').onclick = () => zoomBy(-1);
  $('#zoomReset').onclick = () => setZoom(1);
  window.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  // Layout segmented control + resizable face panel.
  $$('#layoutSeg button').forEach((b) => (b.onclick = () => setLayout(b.dataset.layout)));
  initSplitter();
  $('#windowFull').onclick = toggleAppFullscreen;
  api.on('win:fullscreen', showFullscreen);

  // Chat ⋯ menu
  const menu = $('#chatMenu');
  $('#chatMore').onclick = (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  };
  document.addEventListener('click', () => menu.classList.remove('open'));
  menu.onclick = async (e) => {
    const act = e.target.dataset.act;
    if (act === 'pdf') exportChatPdf();
    if (act === 'note') quickNote();
    if (act === 'skills') switchView('skills');
  };

  initScreenShare();
  initTitlebarFit();

  // Activity keeps the face awake.
  for (const ev of ['keydown', 'pointerdown', 'wheel']) window.addEventListener(ev, noteActivity, { passive: true });
  on('agent-state', (s) => !['idle', 'sleeping', 'happy'].includes(s) && noteActivity());
}

// ------------------------------------------------------------------ zoom
const clamp = (z) => Math.round(Math.min(2, Math.max(0.5, z)) * 100) / 100;
const saveZoom = debounce((z) => saveSettings({ ui: { zoom: z } }), 300);

export function zoomBy(dir) {
  setZoom((state.settings.ui.zoom || 1) + dir * ZOOM_STEP);
}

export function setZoom(z) {
  z = clamp(z);
  state.settings.ui.zoom = z;
  applyZoom(z);
  saveZoom(z);
}

function applyZoom(z) {
  if (z === appliedZoom) return;
  appliedZoom = z;
  api.win.zoom(z).catch(() => {});
  $('#zoomReset').textContent = `${Math.round(z * 100)}%`;
  // The OS window buttons don't scale with the page: keep the title bar their height (the
  // titleBarOverlay height in main/main.js).
  document.documentElement.style.setProperty('--titlebar', `${44 / z}px`);
  $('.titlebar').style.paddingRight = `${150 / z}px`;
}

// ------------------------------------------------------------- title bar fit
// The title bar folds step by step when its contents don't fit (a narrow window, a high zoom, alerts,
// a long persona name), so nothing overlaps: the levels are data-fold 1..FOLDS in styles.css.
const FOLDS = 5;
let fitFrame = 0;

function initTitlebarFit() {
  const bar = $('.titlebar');
  const refit = () => fitFrame || (fitFrame = requestAnimationFrame(fitTitlebar));
  new ResizeObserver(refit).observe(bar);
  // Pills appear and change (alerts, the system meter, the persona's name).
  const watch = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] };
  new MutationObserver(refit).observe($('.status-pills'), watch);
  new MutationObserver(refit).observe($('.brand'), watch);
  document.fonts?.ready.then(refit);
  refit();
}

function fitTitlebar() {
  fitFrame = 0;
  const bar = $('.titlebar');
  const brand = $('.brand');
  const pills = $('.status-pills');
  const crowded = () => brand.getBoundingClientRect().right + 10 > pills.getBoundingClientRect().left || bar.scrollWidth > bar.clientWidth + 1;
  let level = 0;
  bar.dataset.fold = '0';
  while (level < FOLDS && crowded()) bar.dataset.fold = String(++level);
}

// ---------------------------------------------------------------- layout
export function setLayout(layout) {
  saveSettings({ ui: { chatLayout: layout, ...(layout === 'split' ? { showVisualizerInChat: true } : {}) } });
}

export function currentLayout() {
  const s = state.settings.ui;
  const l = ['chat', 'split', 'face'].includes(s.chatLayout) ? s.chatLayout : 'split';
  return l === 'split' && s.showVisualizerInChat === false ? 'chat' : l;
}

/** Applies zoom and layout from the settings (called whenever they change). */
export function applyLayout() {
  const s = state.settings.ui;
  applyZoom(clamp(s.zoom || 1));
  const layout = currentLayout();
  const view = $('#view-chat');
  for (const l of ['chat', 'split', 'face']) view.classList.toggle(`layout-${l}`, l === layout);
  $$('#layoutSeg button').forEach((b) => b.classList.toggle('active', b.dataset.layout === layout));
  view.style.setProperty('--face-w', `${Math.max(200, Number(s.facePanelWidth) || 300)}px`);
  requestAnimationFrame(() => faceHost?.resize());
}

function initSplitter() {
  const bar = $('#faceSplitter');
  const view = $('#view-chat');
  let dragging = false;
  bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('drag');
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = view.getBoundingClientRect();
    const w = Math.round(Math.min(r.width * 0.65, Math.max(200, r.right - e.clientX - 14)));
    view.style.setProperty('--face-w', `${w}px`);
    faceHost?.resize();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('drag');
    const w = parseInt(getComputedStyle(view).getPropertyValue('--face-w'), 10);
    if (w) saveSettings({ ui: { facePanelWidth: w } });
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', () => saveSettings({ ui: { facePanelWidth: 300 } }));
}

// ------------------------------------------------------------ full screen
// The window goes full screen (main process, win:fullscreen); the title bar and rail hide only once it
// really is, so a failed attempt can't leave the app without them. `fullMode` says what to show then:
// the whole app, or the face alone (face view's button).
let fullMode = 'app';
let isFull = false;

function showFullscreen(on) {
  isFull = Boolean(on);
  document.body.classList.toggle('fullscreen-app', isFull && fullMode === 'app');
  document.body.classList.toggle('fullscreen-face', isFull && fullMode === 'face');
  if (!isFull) fullMode = 'app';
  emit('fullscreen', isFull);
}

export const isFullscreen = () => isFull;

/** mode 'app' | 'face' enters full screen, null leaves it. */
export function setFullscreen(mode) {
  if (mode) fullMode = mode;
  if (mode && isFull) return showFullscreen(true); // already full screen: just switch what shows
  api.win.fullscreen(Boolean(mode)).catch((err) => toastError(err));
}

export function toggleAppFullscreen() {
  setFullscreen(isFull ? null : 'app');
}

// ------------------------------------------------------- screen sharing
let previewTimer = null;

function initScreenShare() {
  $('#shareBtn').onclick = async () => ((await api.screen.state()).active ? api.screen.stop() : pickScreen());
  $('#pillScreen').onclick = () => api.screen.stop();
  api.on('screen:state', showShareState);
  api.screen.state().then(showShareState).catch(() => {});
}

function showShareState(st) {
  const btn = $('#shareBtn');
  btn.textContent = st.active ? '■ Stop sharing' : '🖥 Share screen';
  btn.classList.toggle('live', Boolean(st.active));
  const pill = $('#pillScreen');
  pill.classList.toggle('hidden', !st.active);
  pill.querySelector('span').textContent = st.active ? `Sharing: ${st.name}` : '';
  const thumb = $('#screenThumb');
  thumb.classList.toggle('hidden', !st.active);
  clearInterval(previewTimer);
  if (st.active) {
    const tick = () => api.screen.preview().then((url) => url && (thumb.src = url)).catch(() => {});
    tick();
    previewTimer = setInterval(tick, 3000);
  } else if (st.reason === 'source gone') toast('The shared window was closed, so screen sharing stopped.');
}

async function pickScreen() {
  const st = await api.screen.state();
  if (st.permission === 'denied' || st.permission === 'restricted') {
    toast('Screen sharing needs permission: System Settings → Privacy & Security → Screen Recording → allow Nexus Agent, then restart the app.', 'error', 12000);
    return;
  }
  let sources;
  try {
    sources = await api.screen.sources();
  } catch (err) {
    return toastError(err);
  }
  const choice = await modal((card, close) => {
    const grid = el('div', { class: 'screen-grid' });
    const group = (label, list) => {
      if (!list.length) return;
      grid.append(el('div', { class: 'picker-group' }, label));
      for (const s of list) grid.append(el('button', { class: 'screen-src', title: s.name, onclick: () => close(s) }, el('img', { src: s.thumb, alt: '' }), el('span', {}, s.name)));
    };
    group('Screens', sources.filter((s) => s.kind === 'screen'));
    group('Windows', sources.filter((s) => s.kind === 'window' && !/^Nexus Agent|· Nexus Agent$/.test(s.name)));
    card.classList.add('wide');
    card.append(
      el('h3', {}, 'Share your screen'),
      el('p', { class: 'muted', style: { margin: 0 } }, `Pick what ${state.settings.agent.name} may see. While you share, each message you send includes a screenshot of it, and it can look again when it needs to. Nothing is recorded or kept, and you can stop any time (the red “Sharing” badge at the top).`),
      grid,
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel')),
    );
  });
  if (!choice) return;
  try {
    await api.screen.start({ id: choice.id, name: choice.name });
    toast(`Sharing “${choice.name}”. ${state.settings.agent.name} sees it with each message.`);
  } catch (err) {
    toastError(err);
  }
}

// ------------------------------------------------------- notes & PDF
export async function quickNote(prefill = '') {
  const res = await modal((c, close) => {
    const title = el('input', { class: 'input', placeholder: 'Title (optional)' });
    const text = el('textarea', { class: 'input', rows: 8, placeholder: 'Jot it down… (Markdown works). Ctrl+Enter saves.' });
    text.value = prefill;
    text.addEventListener('keydown', (e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && close({ title: title.value, text: text.value }));
    c.append(
      el('h3', {}, 'Quick note'),
      el('p', { class: 'muted', style: { margin: 0 } }, 'Saved to the Inbox folder of your vault, with today’s date.'),
      title,
      text,
      el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), el('button', { class: 'btn primary', onclick: () => close({ title: title.value, text: text.value }) }, 'Save note')),
    );
    setTimeout(() => text.focus(), 0);
  });
  if (!res || !res.text.trim()) return;
  try {
    const r = await api.notes.quick(res.text, res.title);
    toast(`Saved to ${r.path}`);
  } catch (err) {
    toastError(err);
  }
}

export async function exportChatPdf() {
  const id = currentConversationId();
  if (!id) return toast('Start a conversation first.');
  try {
    toast('Creating the PDF…');
    const r = await api.pdf.fromConversation(id);
    toast(`Saved ${r.path}`);
  } catch (err) {
    toastError(err);
  }
}
