// The pop-up document window: shows one document (opened by the agent or with "Pop out") in its own
// movable window, under a custom title bar: what kind of file it is, its name and folder, zoom and
// page controls, and actions. The main process sends a new path to show another document in the
// same window.
import { $, api, el, toast, toastError } from './util.js';
import { applyTheme } from './theme.js';
import { renderDocument } from './docview.js';

const viewer = document.getElementById('popupViewer');
const KIND = { pdf: 'PDF', docx: 'WORD', markdown: 'MD', html: 'HTML', image: 'IMAGE', text: 'TEXT' };
let controller = null;

const folderOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '');

async function show(path) {
  viewer.innerHTML = '';
  controller = null;
  const ctl = $('#docCtl');
  ctl.innerHTML = '';
  try {
    const doc = await api.docs.load(path);
    document.title = doc.name;
    $('#docKind').textContent = KIND[doc.kind] || 'FILE';
    $('#docKind').dataset.kind = doc.kind;
    $('#docName').textContent = doc.name;
    $('#docName').title = doc.path;
    $('#docPath').textContent = folderOf(doc.path);
    const actions = el('div', { class: 'doc-act' });
    actions.append(
      el('button', { class: 'tb', title: 'Show in folder', onclick: () => api.docs.showInFolder(doc.path) }, '📁'),
      el('button', { class: 'tb', title: 'Open in its default app', onclick: () => api.docs.openExternal(doc.path).catch(toastError) }, '↗'),
    );
    if (doc.kind === 'markdown' || doc.kind === 'text') {
      actions.prepend(
        el('button', {
          class: 'tb',
          title: 'Save as PDF',
          onclick: async () => {
            try {
              const r = await api.pdf.fromMarkdown(doc.name.replace(/\.[^.]+$/, ''), doc.kind === 'text' ? `\`\`\`\n${doc.data}\n\`\`\`` : doc.data);
              toast(`Saved ${r.path}`);
            } catch (err) {
              toastError(err);
            }
          },
        }, 'PDF'),
      );
    }
    ctl.append(actions);
    controller = await renderDocument(doc, viewer, ctl);
    $('#docFoot').textContent = [doc.pages ? `${doc.pages} pages` : '', doc.size ? sizeLabel(doc.size) : '', 'Ctrl + wheel to zoom · Esc closes'].filter(Boolean).join(' · ');
    viewer.focus();
  } catch (err) {
    $('#docName').textContent = 'Could not open this document';
    viewer.append(el('p', { class: 'muted', style: { padding: '20px' } }, err.message));
  }
}

const sizeLabel = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// The window buttons (drawn by the OS over the title bar) take the theme's colors.
function themeWindow(settings) {
  const t = applyTheme(settings.appearance?.theme);
  api.win.overlay({ color: t.colors.bg, symbolColor: t.colors.accent }).catch(() => {});
}

api.app.info().then((i) => i.platform === 'darwin' && document.body.classList.add('mac')).catch(() => {});
api.settings.get().then(themeWindow).catch(() => {});
api.on('docpopup:show', show);
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (e.key === 'Escape') window.close();
  else if (mod && (e.key === '=' || e.key === '+')) (e.preventDefault(), controller?.zoomBy(1));
  else if (mod && e.key === '-') (e.preventDefault(), controller?.zoomBy(-1));
  else if (mod && e.key === '0') (e.preventDefault(), controller?.fit());
});
const first = new URLSearchParams(location.search).get('path');
if (first) show(first);
