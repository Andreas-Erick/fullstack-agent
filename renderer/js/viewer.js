// The pop-up document window: shows one document (opened by the agent or with "Pop out") in its own
// movable window. The main process sends a new path to show another document in the same window.
import { api, el, toastError } from './util.js';
import { applyTheme } from './theme.js';
import { renderDocument } from './docview.js';

const viewer = document.getElementById('popupViewer');

async function show(path) {
  viewer.innerHTML = '';
  try {
    const doc = await api.docs.load(path);
    document.title = doc.name;
    const ctl = el('div', { class: 'ctl' });
    ctl.append(
      el('button', { class: 'btn small', onclick: () => api.docs.showInFolder(doc.path) }, 'Show in folder'),
      el('button', { class: 'btn small', onclick: () => api.docs.openExternal(doc.path).catch(toastError) }, 'Open in default app'),
      el('button', { class: 'btn small', onclick: () => window.close() }, 'Close'),
    );
    viewer.append(el('div', { class: 'doc-title' }, el('span', { class: 'name', title: doc.path }, doc.name), ctl));
    await renderDocument(doc, viewer, ctl);
  } catch (err) {
    viewer.append(el('p', { class: 'muted', style: { padding: '20px' } }, `Could not open this document: ${err.message}`));
  }
}

api.settings.get().then((s) => applyTheme(s.appearance?.theme)).catch(() => {});
api.on('docpopup:show', show);
window.addEventListener('keydown', (e) => e.key === 'Escape' && window.close());
const first = new URLSearchParams(location.search).get('path');
if (first) show(first);
