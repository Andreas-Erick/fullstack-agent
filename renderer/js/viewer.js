// The pop-up document window: shows one document (opened by the agent or with "Pop out") in its own
// movable window, under a custom title bar: what kind of file it is, its name and folder, zoom and
// page controls, and actions. The main process sends a new path to show another document in the
// same window.
import { $, api, el, toast, toastError, installErrorTrap, plainError } from './util.js';
import { applyTheme } from './theme.js';
import { renderDocument, disposeDocument } from './docview.js';

installErrorTrap(); // uncaught errors in this window go to the log

const viewer = document.getElementById('popupViewer');
const KIND = { pdf: 'PDF', docx: 'WORD', markdown: 'MD', html: 'HTML', image: 'IMAGE', text: 'TEXT' };
let controller = null;
let showSeq = 0; // the latest show(): a slower load before it never lands under it

const folderOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '');

async function show(path) {
  disposeDocument(viewer); // one still loading stops here instead of appending under the next
  const seq = ++showSeq;
  viewer.innerHTML = '';
  controller = null;
  const ctl = $('#docCtl');
  ctl.innerHTML = '';
  // The last document's header goes at once; "Opening…" shows until this one is drawn.
  $('#docKind').textContent = '';
  delete $('#docKind').dataset.kind;
  $('#docName').textContent = 'Opening…';
  $('#docName').title = '';
  $('#docPath').textContent = '';
  $('#docFoot').textContent = '';
  const opening = el('p', { class: 'muted', role: 'status', style: { padding: '20px' } }, 'Opening…');
  viewer.append(opening);
  try {
    const doc = await api.docs.load(path);
    if (seq !== showSeq) return; // another document was asked for meanwhile
    document.title = doc.name;
    $('#docKind').textContent = KIND[doc.kind] || 'FILE';
    $('#docKind').dataset.kind = doc.kind;
    $('#docName').textContent = doc.name;
    $('#docName').title = doc.path;
    $('#docPath').textContent = folderOf(doc.path);
    const actions = el('div', { class: 'doc-act' });
    actions.append(
      el('button', { class: 'tb', title: 'Show in folder', 'aria-label': 'Show in folder', onclick: () => api.docs.showInFolder(doc.path) }, '📁'),
      el('button', { class: 'tb', title: 'Open in its default app', 'aria-label': 'Open in its default app', onclick: () => api.docs.openExternal(doc.path).catch(toastError) }, '↗'),
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
    const shown = await renderDocument(doc, viewer, ctl);
    opening.remove();
    if (seq !== showSeq) return;
    controller = shown;
    $('#docFoot').textContent = [doc.pages ? `${doc.pages} pages` : '', doc.size ? sizeLabel(doc.size) : '', 'Ctrl + wheel to zoom · Esc closes'].filter(Boolean).join(' · ');
    viewer.focus();
  } catch (err) {
    if (seq !== showSeq) return;
    opening.remove();
    document.title = 'Document';
    $('#docName').textContent = 'Could not open this document';
    viewer.append(el('p', { class: 'muted', role: 'alert', style: { padding: '20px' } }, plainError(err)));
  }
}

const sizeLabel = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// The window buttons (drawn by the OS over the title bar) take the theme's colors.
function themeWindow(settings) {
  const t = applyTheme(settings.appearance?.theme);
  api.win.overlay({ color: t.colors.bg, symbolColor: t.colors.accent }).catch(() => {}); // the overlay colours are cosmetic; the window works without them
}

api.app.info().then((i) => i.platform === 'darwin' && document.body.classList.add('mac')).catch(() => {}); // the platform class is cosmetic
api.settings.get().then(themeWindow).catch(() => {}); // the window keeps the default look
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
