// The agent window's toolbar and frame (main/agentwindow.js shows the page in its own view inside the
// frame): the address, back/forward/reload, who is using the window (the agent while it browses, else
// you), and notices (a blocked address, a download that was refused). Typing in the address bar searches
// or opens a site. It wears the active persona's theme and effects level, re-read whenever it gets focus.
import { $, api } from './util.js';
import { applyTheme } from './theme.js';
import { effectsLevel } from './perfcore.js';

const GLOBE_PORT = 4173; // God's Eye View's local server (main/agentwindowcore.js)
const ICONS = {
  secure: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></svg>',
  insecure: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 7.5-2" /></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" /></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></svg>',
};

let editing = false;
let agentName = 'Siren';
let current = '';
let noticeTimer = null;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// What the address is: a secure site, a plain-http one, the globe on this computer, or nothing yet.
function kindOf(url) {
  try {
    const u = new URL(url);
    if (['localhost', '127.0.0.1'].includes(u.hostname) && Number(u.port) === GLOBE_PORT) return { kind: 'globe', host: "God's Eye View", rest: '', title: "God's Eye View (on this computer)" };
    const host = u.hostname.replace(/^www\./, '');
    const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
    if (u.protocol === 'https:') return { kind: 'secure', host, rest, title: `Secure connection to ${u.hostname}` };
    return { kind: 'insecure', host, rest, title: `Not secure: ${u.hostname} doesn't use HTTPS` };
  } catch {
    return { kind: 'search', host: '', rest: '', title: 'Search or type a web address' };
  }
}

function showAddress(url) {
  current = url && url !== 'about:blank' ? url : '';
  const k = kindOf(current);
  const sec = $('#awSec');
  sec.className = `aw-sec ${k.kind}`;
  sec.innerHTML = ICONS[k.kind];
  sec.title = k.title;
  const pretty = $('#awPretty');
  pretty.firstChild.textContent = k.host;
  pretty.lastChild.textContent = k.rest;
  document.body.classList.toggle('has-url', Boolean(k.host));
  if (!editing) $('#awUrl').value = current;
}

function render(st) {
  if (!st?.open) return;
  $('#awBack').disabled = !st.canBack;
  $('#awForward').disabled = !st.canForward;
  $('#awReload').title = st.loading ? 'Stop (Esc)' : 'Reload (F5)';
  $('#awReload').setAttribute('aria-label', st.loading ? 'Stop' : 'Reload');
  showAddress(st.url);
  document.title = st.title ? `${st.title} · Agent window` : 'Agent window';
  const who = $('#awWho');
  who.classList.toggle('agent', Boolean(st.agent));
  who.querySelector('span').textContent = st.agent ? `${agentName} is browsing` : 'You';
  document.body.classList.toggle('agent', Boolean(st.agent));
  document.body.classList.toggle('loading', Boolean(st.loading));
  notice(st.notice);
}

function notice(text) {
  const n = $('#awNotice');
  if (!text) return n.classList.remove('show');
  n.textContent = text;
  n.title = text;
  n.classList.add('show');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => n.classList.remove('show'), 8000);
}

// The page covers everything inside the frame, so problems are shown in the bar itself.
const fail = (err) => notice(err?.message || String(err));
const run = (p) => Promise.resolve(p).then(render).catch(fail);
const loading = () => document.body.classList.contains('loading');

$('#awBack').addEventListener('click', () => run(api.agentWindow.back()));
$('#awForward').addEventListener('click', () => run(api.agentWindow.forward()));
$('#awReload').addEventListener('click', () => run(loading() ? api.agentWindow.stop() : api.agentWindow.reload()));
$('#awHome').addEventListener('click', () => run(api.agentWindow.home()));
const url = $('#awUrl');
url.addEventListener('focus', () => {
  editing = true;
  document.body.classList.add('editing');
  url.value = current;
  url.select();
});
url.addEventListener('blur', () => {
  editing = false;
  document.body.classList.remove('editing');
  url.value = current;
});
$('#awForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = url.value;
  url.blur();
  run(api.agentWindow.go(text));
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'F5') (e.preventDefault(), run(api.agentWindow.reload()));
  else if (e.key === 'Escape' && editing) url.blur();
  else if (e.key === 'Escape' && loading()) run(api.agentWindow.stop());
  else if (e.altKey && e.key === 'ArrowLeft') run(api.agentWindow.back());
  else if (e.altKey && e.key === 'ArrowRight') run(api.agentWindow.forward());
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') (e.preventDefault(), url.focus());
});

// The active persona's theme, name and effects level (Settings → Interface → Visual effects).
function wear(s) {
  agentName = s.agent?.name || agentName;
  $('#awName').textContent = agentName;
  const t = applyTheme(s.appearance?.theme);
  const fx = effectsLevel(s); // Balanced performance: the look without motion
  document.body.classList.toggle('fx-hud', fx === 'hud');
  document.body.classList.toggle('fx-subtle', fx === 'subtle');
  document.body.classList.toggle('fx-still', fx !== 'off' && reduceMotion.matches);
  api.win.overlay({ color: t.colors.bg, symbolColor: t.colors.accent }).catch(() => {});
}
const rewear = () => api.settings.get().then(wear).catch(() => {});

api.on('agentWindow:state', render);
window.addEventListener('focus', rewear);
reduceMotion.addEventListener?.('change', rewear);
api.app.info().then((i) => i.platform === 'darwin' && document.body.classList.add('mac')).catch(() => {});
showAddress('');
rewear();
api.agentWindow.state().then(render).catch(() => {});
