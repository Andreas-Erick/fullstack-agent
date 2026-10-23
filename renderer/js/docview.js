// Renders one document (PDF, Word, Markdown, HTML, image, text) into a scrolling container.
// Shared by the Documents view and the pop-up document window.
import { el, renderMarkdown, sanitizeHtml } from './util.js';

let pdfjs = null;

async function getPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('app://bundle/node_modules/pdfjs-dist/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'app://bundle/node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
  }
  return pdfjs;
}

/** Renders doc into viewer (the scrolling element); PDF zoom controls go into ctl. */
export async function renderDocument(doc, viewer, ctl) {
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
  const pdf = await lib.getDocument({ data: doc.data, isEvalSupported: false }).promise;
  // Per document: a newer render (zoom change) makes older page draws stop.
  const view = { zoom: 1.25, token: 0 };
  const pages = el('div', { class: 'pdf-pages' });
  viewer.append(pages);
  const label = el('span', { class: 'muted' });
  const rerender = () => {
    label.textContent = `${pdf.numPages} pages · ${Math.round(view.zoom * 100)}%`;
    renderPages(pdf, pages, viewer, view, ++view.token);
  };
  ctl.prepend(
    label,
    el('button', { class: 'btn small', onclick: () => ((view.zoom = Math.max(0.5, view.zoom - 0.25)), rerender()) }, '−'),
    el('button', { class: 'btn small', onclick: () => ((view.zoom = Math.min(4, view.zoom + 0.25)), rerender()) }, '+'),
  );
  rerender();
}

// Lazily render pages as they scroll into view.
async function renderPages(pdf, container, root, view, token) {
  container.innerHTML = '';
  const first = await pdf.getPage(1);
  const base = first.getViewport({ scale: view.zoom });
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || entry.target.dataset.done) continue;
        entry.target.dataset.done = '1';
        drawPage(pdf, Number(entry.target.dataset.page), entry.target, view, token);
      }
    },
    { root, rootMargin: '800px 0px' },
  );
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = el('canvas', { 'data-page': i });
    c.style.width = `${base.width}px`;
    c.style.height = `${base.height}px`;
    container.append(c);
    observer.observe(c);
  }
}

async function drawPage(pdf, n, canvas, view, token) {
  if (token !== view.token) return;
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: view.zoom });
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(vp.width * dpr);
  canvas.height = Math.floor(vp.height * dpr);
  canvas.style.width = `${vp.width}px`;
  canvas.style.height = `${vp.height}px`;
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
}
