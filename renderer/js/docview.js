// Renders one document (PDF, Word, Markdown, HTML, image, text) into a scrolling container, with a
// toolbar: zoom out / zoom level / zoom in, fit to width, and for PDFs the page you're on (type a
// number to jump). Ctrl + mouse wheel over the document zooms it. Shared by the Documents view and
// the pop-up document window.
import { el, renderMarkdown, sanitizeHtml } from './util.js';

let pdfjs = null;
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

async function getPdfjs() {
  if (!pdfjs) {
    pdfjs = await import('app://bundle/node_modules/pdfjs-dist/build/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = 'app://bundle/node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
  }
  return pdfjs;
}

const nextZoom = (z, dir) => (dir > 0 ? ZOOMS.find((v) => v > z + 0.001) || ZOOMS[ZOOMS.length - 1] : [...ZOOMS].reverse().find((v) => v < z - 0.001) || ZOOMS[0]);

/**
 * Renders doc into viewer (the scrolling element); the toolbar goes at the start of ctl.
 * Returns a controller { zoomBy(dir), setZoom(z), fit(), page(n) } for keyboard shortcuts.
 */
export async function renderDocument(doc, viewer, ctl) {
  const tools = el('div', { class: 'doc-tools' });
  ctl.prepend(tools);
  let controller = null;
  try {
    if (doc.kind === 'pdf') controller = await showPdf(doc, viewer, tools);
    else {
      let node;
      if (doc.kind === 'docx') node = el('div', { class: 'doc-html paper', html: sanitizeHtml(doc.data) });
      else if (doc.kind === 'markdown') node = el('div', { class: 'doc-html', html: renderMarkdown(doc.data, { wikilinks: true }) });
      // HTML pages and diagrams keep their own styles in a sandboxed frame: no scripts, no access to the app.
      else if (doc.kind === 'html') node = el('iframe', { class: 'doc-frame', sandbox: '', referrerpolicy: 'no-referrer', srcdoc: doc.data, title: doc.name });
      else if (doc.kind === 'image') node = el('div', { class: 'doc-image' }, el('img', { src: doc.data, alt: doc.name }));
      else node = el('pre', { class: 'doc-text' }, doc.data);
      controller = showZoomable(node, viewer, tools, doc.kind === 'image');
    }
  } catch (err) {
    viewer.append(el('p', { class: 'muted', style: { padding: '20px' } }, `Could not display this document: ${err.message}`));
  }
  if (controller) {
    viewer.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        controller.zoomBy(e.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
  }
  viewer.scrollTop = 0;
  return controller;
}

function zoomButtons(tools, { onZoom, onFit, fitLabel = 'Fit width' }) {
  const label = el('button', { class: 'tb zoom-val', title: 'Reset to 100%' }, '100%');
  tools.append(
    el('button', { class: 'tb', title: 'Zoom out (Ctrl −, Ctrl + wheel)', onclick: () => onZoom(-1) }, '−'),
    label,
    el('button', { class: 'tb', title: 'Zoom in (Ctrl +, Ctrl + wheel)', onclick: () => onZoom(1) }, '+'),
    el('button', { class: 'tb', title: `${fitLabel} (Ctrl 0)`, onclick: onFit }, '⤢'),
  );
  return label;
}

// Word, Markdown, HTML, text, images: CSS zoom on the content keeps text crisp.
function showZoomable(node, viewer, tools, isImage) {
  const stage = el('div', { class: 'doc-stage' }, node);
  viewer.append(stage);
  let zoom = 1;
  const apply = () => {
    const ratio = viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
    stage.style.zoom = String(zoom);
    if (isImage) node.classList.toggle('actual', zoom !== 1);
    label.textContent = `${Math.round(zoom * 100)}%`;
    viewer.scrollTop = ratio * viewer.scrollHeight;
  };
  const ctl = {
    zoomBy: (dir) => ((zoom = nextZoom(zoom, dir)), apply()),
    setZoom: (z) => ((zoom = z), apply()),
    fit: () => ((zoom = 1), apply()),
    page: () => {},
  };
  const label = zoomButtons(tools, { onZoom: ctl.zoomBy, onFit: ctl.fit, fitLabel: isImage ? 'Fit to window' : 'Reset' });
  label.onclick = ctl.fit;
  return ctl;
}

async function showPdf(doc, viewer, tools) {
  const lib = await getPdfjs();
  const pdf = await lib.getDocument({ data: doc.data, isEvalSupported: false }).promise;
  const first = await pdf.getPage(1);
  const baseWidth = first.getViewport({ scale: 1 }).width;
  // Per document: a newer render (zoom change) makes older page draws stop.
  const view = { zoom: 1.25, token: 0 };
  const pages = el('div', { class: 'pdf-pages' });
  viewer.append(pages);

  const pageInput = el('input', { class: 'tb-page', type: 'number', min: 1, max: pdf.numPages, value: 1, title: 'Go to page' });
  const pageOf = el('span', { class: 'tb-of' }, `/ ${pdf.numPages}`);
  const goto = (n) => {
    const target = pages.children[Math.max(0, Math.min(pdf.numPages, n) - 1)];
    target?.scrollIntoView({ block: 'start' });
  };
  pageInput.addEventListener('change', () => goto(Number(pageInput.value)));
  tools.append(
    el('button', { class: 'tb', title: 'Previous page (Page Up)', onclick: () => goto(current() - 1) }, '‹'),
    pageInput,
    pageOf,
    el('button', { class: 'tb', title: 'Next page (Page Down)', onclick: () => goto(current() + 1) }, '›'),
    el('span', { class: 'tb-sep' }),
  );
  const current = () => {
    const mid = viewer.scrollTop + viewer.clientHeight / 3;
    let n = 1;
    for (const c of pages.children) if (c.offsetTop <= mid) n = Number(c.dataset.page);
    return n;
  };
  viewer.addEventListener('scroll', () => {
    if (document.activeElement !== pageInput) pageInput.value = current();
  });

  const rerender = () => {
    const ratio = viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
    label.textContent = `${Math.round(view.zoom * 100)}%`;
    renderPages(pdf, pages, viewer, view, ++view.token).then(() => (viewer.scrollTop = ratio * viewer.scrollHeight));
  };
  const ctl = {
    zoomBy: (dir) => ((view.zoom = nextZoom(view.zoom, dir)), rerender()),
    setZoom: (z) => ((view.zoom = z), rerender()),
    fit: () => ((view.zoom = Math.max(0.5, Math.min(4, (viewer.clientWidth - 48) / baseWidth))), rerender()),
    page: (n) => goto(n === 'next' ? current() + 1 : n === 'prev' ? current() - 1 : n),
  };
  const label = zoomButtons(tools, { onZoom: ctl.zoomBy, onFit: ctl.fit });
  label.onclick = () => ctl.setZoom(1);
  rerender();
  return ctl;
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
