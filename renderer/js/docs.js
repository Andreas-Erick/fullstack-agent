// Documents view: open files, recent list, and the viewer (rendering lives in docview.js, shared with
// the pop-up document window the agent opens).
import { $, api, el, toast, toastError, timeAgo, on, confirmDialog, plainError } from './util.js';
import { switchView } from './nav.js';
import { renderDocument } from './docview.js';

let current = null;
let openSeq = 0; // the latest open: a slow docs:load never replaces a document asked for after it

export function initDocs() {
  const pick = async () => {
    try {
      const doc = await api.docs.pick();
      if (!doc) return;
      openSeq++; // a load still running doesn't land over the picked file
      show(doc);
    } catch (err) {
      toastError(err);
    }
  };
  $('#docOpen').onclick = pick;
  $('#docOpenEmpty').onclick = pick; // the empty viewer's first step (spec #17); gone once a document shows
  $('#docExternal').onclick = () => current && api.docs.openExternal(current.path).catch(toastError);
  $('#docAsk').onclick = () => {
    if (!current) return;
    switchView('chat');
    const input = $('#input');
    input.value = `About the document "${current.name}" (${current.path}): `;
    input.dispatchEvent(new Event('input')); // the box grows and the send button wakes, as when typed
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };
  // The list can't be brought back, so it asks first (only the list goes: the files stay where they are).
  $('#docClearRecent').onclick = async () => {
    if (!$('#docRecent .doc-recent')) return;
    if (!(await confirmDialog('Clear recent documents', 'The list of recently opened documents is emptied. The files themselves stay where they are.', 'Clear'))) return;
    try {
      await api.docs.clearRecent();
    } catch (err) {
      toastError(plainError(err));
    }
    refreshRecent();
  };
  on('open-document', (path) => {
    openDocument(path);
    toast('The agent opened a document');
  });
  refreshRecent();
}

export async function openDocument(path) {
  const seq = ++openSeq;
  try {
    const doc = await api.docs.load(path); // a large PDF or a Word file takes a while: a later open may finish first
    if (seq !== openSeq) return; // a newer open or a picked file wins
    switchView('docs');
    show(doc);
  } catch (err) {
    if (seq === openSeq) toastError(err);
  }
}

async function refreshRecent() {
  const list = await api.docs.recent().catch(() => []);
  const ul = $('#docRecent');
  ul.innerHTML = '';
  if (!list.length) ul.append(el('li', { class: 'muted' }, 'Nothing opened yet.'));
  for (const d of list) {
    ul.append(el('li', {}, el('button', { type: 'button', class: 'doc-recent', title: d.path, onclick: () => openDocument(d.path) }, el('span', { class: 'k' }, d.kind), el('span', { class: 'n' }, d.name), el('span', { class: 'muted', style: { marginLeft: 'auto', fontSize: '11px', flex: 'none' } }, timeAgo(d.openedAt)))));
  }
}

async function show(doc) {
  current = doc;
  $('#docAsk').disabled = false;
  $('#docExternal').disabled = false;
  const viewer = $('#docViewer');
  viewer.innerHTML = '';
  const ctl = el('div', { class: 'ctl' });
  const title = el('div', { class: 'doc-title' }, el('span', { class: 'name', title: doc.path }, doc.name), ctl);
  const opening = el('p', { class: 'muted doc-opening', role: 'status' }, 'Opening…');
  viewer.append(title, opening);
  ctl.append(
    el('button', { class: 'btn small', onclick: () => api.docs.showInFolder(doc.path) }, 'Show in folder'),
    el('button', { class: 'btn small', title: 'Open in its own window', onclick: () => api.docs.popup(doc.path).catch(toastError) }, 'Pop out'),
  );
  refreshRecent();
  try {
    await renderDocument(doc, viewer, ctl);
  } finally {
    opening.remove();
    // A diagram's sticky step bar and a page's frame size themselves under the title (styles.css #docViewer).
    if (title.isConnected) viewer.style.setProperty('--doc-title-h', `${title.offsetHeight}px`);
  }
}
