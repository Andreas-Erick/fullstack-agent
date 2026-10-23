// Document viewer: PDFs (pdf.js), Word (.docx → HTML), Markdown, text/code, HTML and images.
import { $, api, el, renderMarkdown, sanitizeHtml, toast, toastError, timeAgo, on } from './util.js';
import { switchView } from './nav.js';

let pdfjs = null;
let current = null;
let zoom = 1.25;
let renderToken = 0;

async function getPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('app://bundle/node_modules/pdfjs-dist/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'app://bundle/node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
  }
  return pdfjs;
}

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
  ctl.append(el('button', { class: 'btn small', onclick: () => api.docs.showInFolder(doc.path) }, 'Show in folder'));
  refreshRecent();

  try {
    if (doc.kind === 'pdf') await showPdf(doc, viewer, ctl);
    else if (doc.kind === 'docx') viewer.append(el('div', { class: 'doc-html paper', html: sanitizeHtml(doc.data) }));
    else if (doc.kind === 'markdown') viewer.append(el('div', { class: 'doc-html', html: renderMarkdown(doc.data, { wikilinks: true }) }));
    else if (doc.kind === 'html') viewer.append(el('div', { class: 'doc-html paper', html: sanitizeHtml(doc.data) }));
    else if (doc.kind === 'image') viewer.append(el('div', { class: 'doc-image' }, el('img', { src: doc.data, alt: doc.name })));
    else viewer.append(el('pre', { class: 'doc-text' }, doc.data));
  } catch (err) {
    viewer.append(el('p', { class: 'muted', style: { padding: '20px' } }, `Could not display this document: ${err.message}`));
  }
  viewer.scrollTop = 0;
}

async function showPdf(doc, viewer, ctl) {
  const lib = await getPdfjs();
  const token = ++renderToken;
  const pdf = await lib.getDocument({ data: doc.data, isEvalSupported: false }).promise;
  const pages = el('div', { class: 'pdf-pages' });
  viewer.append(pages);
  const label = el('span', { class: 'muted' }, `${pdf.numPages} pages · ${Math.round(zoom * 100)}%`);
  const rerender = () => {
    label.textContent = `${pdf.numPages} pages · ${Math.round(zoom * 100)}%`;
    renderPages(pdf, pages, ++renderToken);
  };
  ctl.prepend(
    label,
    el('button', { class: 'btn small', onclick: () => ((zoom = Math.max(0.5, zoom - 0.25)), rerender()) }, '−'),
    el('button', { class: 'btn small', onclick: () => ((zoom = Math.min(4, zoom + 0.25)), rerender()) }, '+'),
  );
  renderPages(pdf, pages, token);
}

// Lazily render pages as they scroll into view.
async function renderPages(pdf, container, token) {
  container.innerHTML = '';
  const first = await pdf.getPage(1);
  const base = first.getViewport({ scale: zoom });
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.target.dataset.done) continue;
        entry.target.dataset.done = '1';
        drawPage(pdf, Number(entry.target.dataset.page), entry.target, token);
      }
    },
    { root: $('#docViewer'), rootMargin: '800px 0px' },
  );
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = el('canvas', { 'data-page': i });
    c.style.width = `${base.width}px`;
    c.style.height = `${base.height}px`;
    container.append(c);
    observer.observe(c);
  }
}

async function drawPage(pdf, n, canvas, token) {
  if (token !== renderToken) return;
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: zoom });
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${vp.width}px`;
  canvas.style.height = `${vp.height}px`;
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
}
