// Documents view: open files, recent list, and the viewer (rendering lives in docview.js, shared with
// the pop-up document window the agent opens).
import { $, api, el, toast, toastError, timeAgo, on } from './util.js';
import { switchView } from './nav.js';
import { renderDocument } from './docview.js';

let current = null;

export function initDocs() {
  $('#docOpen').onclick = async () => {
    try {
      const doc = await api.docs.pick();
      if (doc) show(doc);
    } catch (err) {
      toastError(err);
    }
  };
  $('#docExternal').onclick = () => current && api.docs.openExternal(current.path).catch(toastError);
  $('#docAsk').onclick = () => {
    if (!current) return;
    switchView('chat');
    const input = $('#input');
    input.value = `About the document "${current.name}" (${current.path}): `;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  };
  $('#docClearRecent').onclick = async () => {
    await api.docs.clearRecent();
    refreshRecent();
  };
  on('open-document', (path) => {
    openDocument(path);
    toast('The agent opened a document');
  });
  refreshRecent();
}

export async function openDocument(path) {
  try {
    const doc = await api.docs.load(path);
    switchView('docs');
    show(doc);
  } catch (err) {
    toastError(err);
  }
}

async function refreshRecent() {
  const list = await api.docs.recent().catch(() => []);
  const ul = $('#docRecent');
  ul.innerHTML = '';
  if (!list.length) ul.append(el('li', { class: 'muted' }, 'Nothing opened yet.'));
  for (const d of list) {
    ul.append(el('li', { title: d.path, onclick: () => openDocument(d.path) }, el('span', { class: 'k' }, d.kind), el('span', { class: 'n' }, d.name), el('span', { class: 'muted', style: { marginLeft: 'auto', fontSize: '11px', flex: 'none' } }, timeAgo(d.openedAt))));
  }
}

async function show(doc) {
  current = doc;
  $('#docAsk').disabled = false;
  $('#docExternal').disabled = false;
  const viewer = $('#docViewer');
  viewer.innerHTML = '';
  const ctl = el('div', { class: 'ctl' });
  viewer.append(el('div', { class: 'doc-title' }, el('span', { class: 'name', title: doc.path }, doc.name), ctl));
  ctl.append(
    el('button', { class: 'btn small', onclick: () => api.docs.showInFolder(doc.path) }, 'Show in folder'),
    el('button', { class: 'btn small', title: 'Open in its own window', onclick: () => api.docs.popup(doc.path).catch(toastError) }, 'Pop out'),
  );
  refreshRecent();
  await renderDocument(doc, viewer, ctl);
}
