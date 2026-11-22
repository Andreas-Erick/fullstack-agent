// Window-level UI: zoom, the chat view's layout (chat only · split · face), the resizable face panel,
// full screen, screen sharing (picker, live preview, stop) and the quick-note box.
import { $, $$, api, el, toast, toastError, modal, on, emit, debounce, ignore } from './util.js';
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
  // Chat ⋯ menu: opens with the focus on its first item; ↑ ↓ move, Esc closes it back to the button.
  const menu = $('#chatMenu');
  const more = $('#chatMore');
  const items = () => [...menu.querySelectorAll('button')];
  const setMenu = (open, { focus = false } = {}) => {
    const was = menu.classList.contains('open');
    menu.classList.toggle('open', open);
    more.setAttribute('aria-expanded', String(open));
    if (open && !was) items()[0]?.focus();
    if (!open && was && focus) more.focus();
  };
  more.onclick = (e) => {
    e.stopPropagation();
    setMenu(!menu.classList.contains('open'), { focus: true });
  };
  document.addEventListener('click', () => setMenu(false));
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const at = list.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // the menu only: not the reply, the voice or full screen
      setMenu(false, { focus: true });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      list[(at + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
    } else if (e.key === 'Tab') {
      setMenu(false);
    }
  });
  menu.addEventListener('focusout', (e) => {
    if (!menu.contains(e.relatedTarget) && e.relatedTarget !== more) setMenu(false);
  });
  menu.onclick = async (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act) setMenu(false);
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
  api.win.zoom(z).then(() => requestAnimationFrame(fitTitlebar), () => {});
  $('#zoomReset').textContent = `${Math.round(z * 100)}%`;
  // The OS window buttons don't scale with the page: keep the title bar their height (the
  // titleBarOverlay height in main/main.js).
  document.documentElement.style.setProperty('--titlebar', `${44 / z}px`);
  $('.titlebar').style.paddingRight = `${150 / z}px`;
  requestAnimationFrame(fitTitlebar);
}

// ------------------------------------------------------------- title bar fit
// The title bar folds step by step when its contents don't fit (a narrow window, a high zoom, alerts,
// a long persona name), so nothing overlaps: the levels are data-fold 1..FOLDS in styles.css.
const FOLDS = 6;
let fitFrame = 0;

const STATE_WORDS = ['idle', 'listening', 'thinking', 'working', 'speaking', 'happy', 'sleeping', 'alert'];
let measure = null;

function initTitlebarFit() {
  const bar = $('.titlebar');
  const refit = () => fitFrame || (fitFrame = requestAnimationFrame(fitTitlebar));
  // A resize fits at once, inside the observer's callback (after layout, before paint): waiting for the
  // next animation frame showed the old fold for a frame, and in a hidden or background window, where
  // frames come about once a second, the labels stayed cut off past the edge for up to a second.
  const fitNow = () => {
    if (fitFrame) cancelAnimationFrame(fitFrame);
    fitTitlebar();
  };
  new ResizeObserver(fitNow).observe(bar);
  // Pills appear and change (alerts, the system meter, the persona's name).
  const watch = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] };
  new MutationObserver(refit).observe($('.status-pills'), watch);
  new MutationObserver(refit).observe($('.brand'), watch);
  // The state capsule's font changes with the theme and the effects level.
  on('settings', refit);
  on('theme', refit);
  document.fonts?.ready.then(refit);
  refit();
}

// The agent's state name ("idle", "speaking"…) changes many times during a spoken reply. Its capsule is
// kept as wide as the longest name, so the bar's width (and so its folding) doesn't follow the state.
function reserveStateWidth() {
  const el = $('#brandState');
  if (!el) return;
  const cs = getComputedStyle(el);
  measure ||= document.createElement('canvas').getContext('2d');
  measure.font = cs.font || `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const spacing = parseFloat(cs.letterSpacing) || 0;
  const upper = cs.textTransform === 'uppercase';
  let widest = 0;
  for (const word of STATE_WORDS) {
    const t = upper ? word.toUpperCase() : word;
    widest = Math.max(widest, measure.measureText(t).width + spacing * t.length);
  }
  // The HUD look adds a dot before the name (hud.css ::before: 5px + 6px gap).
  const hud = document.body.classList.contains('fx-hud') || document.body.classList.contains('fx-subtle');
  const px = `${Math.ceil(widest) + (hud ? 11 : 0)}px`;
  if (el.style.minWidth !== px) el.style.minWidth = px;
}

function fitTitlebar() {
  fitFrame = 0;
  const bar = $('.titlebar');
  const brand = $('.brand');
  const pills = $('.status-pills');
  reserveStateWidth();
  // Free space between the two sides; negative when the bar overflows (overflow is hidden). Measured on
  // the content itself, never with scrollWidth: the HUD's scan line (.titlebar::after, a transform that
  // sweeps past the right edge every few seconds) inflates scrollWidth, and a fit at that moment folded
  // the bar for nothing, which then unfolded or stuck folded: the title bar's jitter.
  const slack = () => {
    const box = bar.getBoundingClientRect();
    const end = box.left + bar.clientLeft + bar.clientWidth - (parseFloat(getComputedStyle(bar).paddingRight) || 0);
    const over = pills.getBoundingClientRect().right - end;
    return over > 1 ? -over : pills.getBoundingClientRect().left - brand.getBoundingClientRect().right;
  };
  const slackAt = (level) => ((bar.dataset.fold = String(level)), slack());
  const before = Number(bar.dataset.fold) || 0;
  let level = 0;
  while (level < FOLDS && slackAt(level) < 10) level++;
  // Hysteresis: unfolding needs comfortable room, so a bar that barely fits doesn't flip between two
  // levels (labels appearing and vanishing) as a counter or a name changes by a few pixels.
  if (level < before) {
    let keep = before;
    for (let l = level; l < before; l++) {
      if (slackAt(l) >= 40) {
        keep = l;
        break;
      }
    }
    level = keep;
  }
  bar.dataset.fold = String(level);
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
  setFaceWidth(storedFaceWidth());
  requestAnimationFrame(() => faceHost?.resize());
}

// The Split layout's face panel: never so wide that the chat column (History docked beside it or not)
// falls under CHAT_MIN. The stored width is the wish; a narrow window shows less of it without saving that.
const FACE_MIN = 200;
const CHAT_MIN = 380;
const SPLIT_STEP = 20;
const storedFaceWidth = () => Math.max(FACE_MIN, Number(state.settings.ui.facePanelWidth) || 300);

function faceRoom() {
  const view = $('#view-chat');
  const face = $('#facePanel');
  const main = view.querySelector('.chat-main');
  if (!view.classList.contains('layout-split') || !face?.offsetWidth || !main) return Infinity;
  // The two share the row (the chat column is flex: 1), so their sum doesn't depend on the face's width.
  return Math.max(FACE_MIN, Math.min(view.clientWidth * 0.65, face.offsetWidth + main.offsetWidth - CHAT_MIN));
}

function setFaceWidth(want) {
  const view = $('#view-chat');
  const room = faceRoom();
  const fit = Math.min(want, room);
  const w = Math.round(Math.max(FACE_MIN, Number.isFinite(fit) ? fit : storedFaceWidth()));
  view.style.setProperty('--face-w', `${w}px`);
  const bar = $('#faceSplitter');
  bar.setAttribute('aria-valuemin', String(FACE_MIN));
  bar.setAttribute('aria-valuenow', String(w));
  if (Number.isFinite(room)) bar.setAttribute('aria-valuemax', String(Math.round(room)));
  return w;
}

const currentFaceWidth = () => parseInt(getComputedStyle($('#view-chat')).getPropertyValue('--face-w'), 10) || 0;
const saveFaceWidth = debounce((w) => saveSettings({ ui: { facePanelWidth: w } }), 400);

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
    setFaceWidth(view.getBoundingClientRect().right - e.clientX - 14);
    faceHost?.resize();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('drag');
    const w = currentFaceWidth();
    if (w) saveSettings({ ui: { facePanelWidth: w } });
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', () => saveSettings({ ui: { facePanelWidth: 300 } }));
  // ← widens the face (the splitter moves left), → narrows it; Home/End go to the limits.
  bar.addEventListener('keydown', (e) => {
    const now = currentFaceWidth();
    const want = { ArrowLeft: now + SPLIT_STEP, ArrowRight: now - SPLIT_STEP, Home: FACE_MIN, End: Infinity }[e.key];
    if (want === undefined) return;
    e.preventDefault();
    const w = setFaceWidth(want);
    faceHost?.resize();
    if (w !== now) saveFaceWidth(w);
  });
  // A window made narrower (or History docked again) gives the chat its room back; wider, the wish returns.
  let splitFrame = 0;
  new ResizeObserver(() => {
    if (dragging || splitFrame) return;
    splitFrame = requestAnimationFrame(() => {
      splitFrame = 0;
      if (view.classList.contains('layout-split')) setFaceWidth(storedFaceWidth());
    });
  }).observe(view);
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
let previewTick = null; // while sharing: refreshes the thumbnail

function initScreenShare() {
  $('#shareBtn').onclick = async () => ((await api.screen.state()).active ? api.screen.stop() : pickScreen());
  $('#pillScreen').onclick = () => api.screen.stop();
  api.on('screen:state', showShareState);
  api.screen.state().then(showShareState).catch(ignore('screen share state not read'));
  // A hidden window shows no thumbnail: the capture waits, and runs once when the window is back.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) previewTick?.();
  });
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
  previewTick = null;
  if (st.active) {
    const tick = () => {
      if (document.hidden) return; // each capture grabs every window's thumbnail
      api.screen.preview().then((url) => url && (thumb.src = url)).catch(() => {}); // a missed preview frame; the next one follows
    };
    previewTick = tick;
    tick();
    previewTimer = setInterval(tick, 3000);
  } else if (st.reason === 'source gone') toast('The shared window was closed, so screen sharing stopped.');
}

async function pickScreen() {
  const st = await api.screen.state();
  if (st.permission === 'denied' || st.permission === 'restricted') {
    toast('Screen sharing needs permission: System Settings → Privacy & Security → Screen Recording → allow Siren Assistant, then restart the app.', 'error', 12000);
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
    group('Windows', sources.filter((s) => s.kind === 'window' && !/^(Siren Assistant|Nexus Agent)|· (Siren Assistant|Nexus Agent)$/.test(s.name)));
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
// A quick note is the Notes view's brain-dump page (notes.js), from the chat menu as from Ctrl+Shift+N.
export function quickNote(prefill = '') {
  return import('./notes.js').then((m) => m.openDump(prefill));
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
