// The agent window's toolbar (main/agentwindow.js shows the page in its own view below it): the address,
// back/forward/reload, who is using the window (the agent while it browses, else you), and notices
// (a blocked address, a download that was refused). Typing in the address bar searches or opens a site.
import { $, api } from './util.js';
import { applyTheme } from './theme.js';

let editing = false;
let agentName = 'Nexus';

function render(st) {
  if (!st?.open) return;
  $('#awBack').disabled = !st.canBack;
  $('#awForward').disabled = !st.canForward;
  $('#awReload').textContent = st.loading ? '✕' : '⟳';
  $('#awReload').title = st.loading ? 'Stop' : 'Reload (F5)';
  if (!editing) $('#awUrl').value = st.url && st.url !== 'about:blank' ? st.url : '';
  document.title = st.title ? `${st.title} · Agent window` : 'Agent window';
  const who = $('#awWho');
  who.classList.toggle('agent', Boolean(st.agent));
  who.querySelector('span').textContent = st.agent ? `${agentName} is browsing` : 'You';
  $('#awNotice').textContent = st.notice || '';
  document.body.classList.toggle('loading', Boolean(st.loading));
}

// The page covers everything below the bar, so problems are shown in the bar itself.
const fail = (err) => ($('#awNotice').textContent = err?.message || String(err));
const run = (p) => Promise.resolve(p).then(render).catch(fail);

$('#awBack').addEventListener('click', () => run(api.agentWindow.back()));
$('#awForward').addEventListener('click', () => run(api.agentWindow.forward()));
$('#awReload').addEventListener('click', () => run(document.body.classList.contains('loading') ? api.agentWindow.stop() : api.agentWindow.reload()));
$('#awHome').addEventListener('click', () => run(api.agentWindow.home()));
const url = $('#awUrl');
url.addEventListener('focus', () => ((editing = true), url.select()));
url.addEventListener('blur', () => (editing = false));
$('#awForm').addEventListener('submit', (e) => {
  e.preventDefault();
  editing = false;
  url.blur();
  run(api.agentWindow.go(url.value));
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'F5') (e.preventDefault(), run(api.agentWindow.reload()));
  else if (e.altKey && e.key === 'ArrowLeft') run(api.agentWindow.back());
  else if (e.altKey && e.key === 'ArrowRight') run(api.agentWindow.forward());
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') (e.preventDefault(), url.focus());
});

api.on('agentWindow:state', render);
api.app.info().then((i) => i.platform === 'darwin' && document.body.classList.add('mac')).catch(() => {});
api.settings
  .get()
  .then((s) => {
    agentName = s.agent?.name || agentName;
    const t = applyTheme(s.appearance?.theme);
    api.win.overlay({ color: t.colors.bg, symbolColor: t.colors.accent }).catch(() => {});
  })
  .catch(() => {});
api.agentWindow.state().then(render).catch(() => {});
