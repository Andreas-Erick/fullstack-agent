// Which screen shows (chat, the schedule, a screen from screens.js), the tablet layout, and Android Back.
import { render as renderScreen, TITLES, screenBack, hasScreenBack, stopLive } from './screens.js';
import { backPlan } from './sync.js';
import { $, android, state } from './state.js';
import { icon } from './ui.js';
import { renderOffline } from './offline.js';
import { closeDrawer } from './conversations.js';
import { setFaceFull } from './face.js';
import { sched, dayOf, weekOf, renderSchedule } from './schedule.js';
import { decode } from './hud.js';

// The tab bar's highlight: More covers every screen that has no tab of its own.
const TABS = ['chat', 'today', 'notes', 'learn', 'more'];

// Android Back (MainActivity calls nexusBack): the top layer closes first (sync.js backPlan); the app
// hears whether there is one (backTarget), so Back leaves it from the bare chat.
function backState() {
  if ($('#main').classList.contains('hidden')) return {}; // the pairing screen: nothing to close, Back leaves the app
  return { offline: Boolean($('#offline')), drawerOpen: !$('#drawer').classList.contains('hidden'), faceFull: document.body.classList.contains('face-full'), screenBack: hasScreenBack(state.view), view: state.view, tabs: TABS, wide: document.body.classList.contains('wide') };
}
export function syncBack() {
  const open = Boolean(backPlan(backState()));
  if (open === state.backOpen) return;
  state.backOpen = open;
  android?.backTarget?.(open);
}
window.nexusBack = () => {
  const plan = backPlan(backState());
  if (plan === 'offline') (state.offlineDismissed = true), renderOffline();
  else if (plan === 'drawer') closeDrawer();
  else if (plan === 'face') setFaceFull(false);
  else if (plan === 'screen') screenBack();
  else if (plan) showView(plan);
  syncBack();
  return Boolean(plan);
};

export function showView(v) {
  // Wide (tablet, DeX): the chat is always on screen, so the side shows Today instead of nothing.
  if (v === 'chat' && wide.matches && state.info?.share) v = 'today';
  state.view = v;
  const panel = v !== 'chat' && v !== 'sched';
  document.body.classList.toggle('view-sched', v === 'sched');
  document.body.classList.toggle('view-panel', panel);
  $('#sched').classList.toggle('hidden', v !== 'sched');
  $('#panel').classList.toggle('hidden', !panel);
  if (!panel) stopLive(); // the village and the map stop drawing behind the chat or the schedule
  const tab = TABS.includes(v) ? v : 'more';
  for (const b of document.querySelectorAll('#tabs button')) {
    b.classList.toggle('on', b.dataset.tab === tab);
    b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
  }
  if (panel) {
    decode($('#convTitle'), TITLES[v] || '');
    renderScreen(v, $('#panel'));
  }
  $('#schedBtn').classList.toggle('on', v === 'sched');
  $('#schedBtn').setAttribute('aria-pressed', String(v === 'sched'));
  $('#schedBtn').replaceChildren(icon(v === 'sched' ? 'chat' : 'calendar'));
  $('#schedBtn').setAttribute('aria-label', v === 'sched' ? 'Back to the chat' : 'Schedule');
  if (!panel) $('#convTitle').textContent = v === 'sched' ? 'Schedule' : state.convTitle || 'New conversation';
  if (v === 'sched') {
    sched.day ||= dayOf(new Date());
    sched.week = weekOf(sched.day);
    renderSchedule();
  }
  syncBack();
}

// Tablets (also upright), Samsung DeX and large windows: the chat beside the screens (styles.css
// body.wide). Not phones turned sideways: they are wide but too short for two panes. Follows rotation,
// split screen and window resizing.
export const wide = matchMedia('(min-width: 760px) and (min-height: 560px)');
export function applyWide() {
  // Without the shared screens (an older computer, or sharing off) there is nothing to put beside the chat.
  document.body.classList.toggle('wide', wide.matches && state.info?.share !== false);
  if (wide.matches && state.view === 'chat' && state.info?.share) showView('today');
}
