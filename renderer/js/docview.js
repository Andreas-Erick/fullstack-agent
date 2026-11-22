// Renders one document (PDF, Word, Markdown, HTML, image, text) into a scrolling container, with a
// toolbar: zoom out / zoom level / zoom in, fit to width, and for PDFs the page you're on (type a
// number to jump). Ctrl + mouse wheel over the document zooms it. Shared by the Documents view and
// the pop-up document window. One document per viewer element: showing the next one lets go of the
// last (its listeners, page observer, page draws and pdf.js document with its worker).
import { el, renderMarkdown, sanitizeHtml, logEvent, plainError } from './util.js';

let pdfjs = null;
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
const showing = new WeakMap(); // viewer element → dispose() of the document it shows

/** Lets go of the document shown in `viewer`: its listeners, page observer, render tasks and pdf.js document (and worker). */
export function disposeDocument(viewer) {
  showing.get(viewer)?.();
}

/** What to do with a page the observer reports: draw it, give its bitmap back, or nothing. */
export function pageAction(intersecting, drawn) {
  return intersecting && !drawn ? 'draw' : !intersecting && drawn ? 'release' : 'none';
}

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
  disposeDocument(viewer);
  const ac = new AbortController();
  const { signal } = ac;
  const parts = { task: null, observer: null, tasks: new Map() }; // tasks: canvas → its pdf.js render task
  showing.set(viewer, () => {
    ac.abort();
    parts.observer?.disconnect();
    for (const t of parts.tasks.values()) t.cancel();
    parts.tasks.clear();
    parts.task?.destroy().catch(() => {});
    showing.delete(viewer);
  });
  const tools = el('div', { class: 'doc-tools' });
  ctl.prepend(tools);
  let controller = null;
  try {
    if (doc.kind === 'pdf') controller = await showPdf(doc, viewer, tools, { signal, parts });
    else {
      let node;
      if (doc.kind === 'docx') node = el('div', { class: 'doc-html paper', html: sanitizeHtml(doc.data) });
      else if (doc.kind === 'markdown') node = el('div', { class: 'doc-html', html: renderMarkdown(doc.data, { wikilinks: true }) });
      // HTML pages and diagrams keep their own styles in a sandboxed frame: no scripts, no access to the app.
      // A chart with parameters or a diagram in steps becomes live (livedoc.js), still running nothing of its own.
      else if (doc.kind === 'html') node = await htmlNode(doc);
      else if (doc.kind === 'image') node = el('div', { class: 'doc-image' }, el('img', { src: doc.data, alt: doc.name }));
      else node = el('pre', { class: 'doc-text' }, doc.data);
      if (signal.aborted) return null; // another document was asked for meanwhile
      controller = showZoomable(node, viewer, tools, doc.kind === 'image');
    }
  } catch (err) {
    if (signal.aborted) return null; // replaced meanwhile (its loading task was destroyed)
    viewer.append(el('p', { class: 'muted', style: { padding: '20px' } }, `Could not display this document: ${plainError(err)}`));
  }
  if (signal.aborted) return null;
  if (controller) {
    viewer.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        controller.zoomBy(e.deltaY < 0 ? 1 : -1);
      },
      { passive: false, signal },
    );
  }
  viewer.scrollTop = 0;
  return controller;
}

async function htmlNode(doc) {
  const live = await import('./livedoc.js');
  const spec = live.chartSpecFrom(doc.data);
  if (spec) {
    try {
      return live.liveChart(spec);
    } catch {
      /* a description the engine can't use: the saved picture, as before */
    }
  }
  if (live.stepCount(doc.data) > 1) return live.steppedDiagram(doc.data, doc.name);
  return el('iframe', { class: 'doc-frame', sandbox: '', referrerpolicy: 'no-referrer', srcdoc: doc.data, title: doc.name });
}

function zoomButtons(tools, { onZoom, onFit, fitLabel = 'Fit width' }) {
  const label = el('button', { class: 'tb zoom-val', title: 'Reset to 100%', 'aria-label': 'Zoom level, reset to 100%' }, '100%');
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

// signal: aborted when another document replaces this one; parts: what disposeDocument lets go of.
async function showPdf(doc, viewer, tools, { signal, parts }) {
  const lib = await getPdfjs();
  if (signal.aborted) return null;
  parts.task = lib.getDocument({ data: doc.data, isEvalSupported: false });
  const pdf = await parts.task.promise;
  const first = await pdf.getPage(1);
  if (signal.aborted) return null; // nothing of it was added to the viewer yet
  const baseWidth = first.getViewport({ scale: 1 }).width;
  // Per document: a newer render (zoom change) makes older page draws stop. ratio: where the reader was,
  // kept while zooms follow each other faster than the pages are laid out.
  const view = { zoom: 1.25, token: 0, ratio: null };
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
  // The page number follows the scrolling, one lookup a frame; the listener goes with the document.
  let pending = false;
  viewer.addEventListener(
    'scroll',
    () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (document.activeElement !== pageInput) pageInput.value = current();
      });
    },
    { signal },
  );

  const rerender = () => {
    view.ratio ??= viewer.scrollHeight ? viewer.scrollTop / viewer.scrollHeight : 0;
    label.textContent = `${Math.round(view.zoom * 100)}%`;
    const token = ++view.token;
    renderPages(pdf, pages, viewer, view, token, { signal, parts })
      .then(() => {
        if (signal.aborted || token !== view.token) return; // replaced, or zoomed again meanwhile
        viewer.scrollTop = view.ratio * viewer.scrollHeight;
        view.ratio = null;
      })
      .catch((err) => {
        if (token === view.token) view.ratio = null; // the next zoom measures again
        if (!signal.aborted) logEvent('warn', 'pdf pages not laid out', { error: err?.message });
      });
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

// Lazily render pages as they scroll into view; pages far from it give their bitmaps back.
async function renderPages(pdf, container, root, view, token, { signal, parts }) {
  parts.observer?.disconnect(); // a zoom: the old pages go, with their draws
  for (const t of parts.tasks.values()) t.cancel();
  parts.tasks.clear();
  container.innerHTML = '';
  const first = await pdf.getPage(1);
  if (signal.aborted || token !== view.token) return; // replaced, or zoomed again meanwhile
  const base = first.getViewport({ scale: view.zoom });
  let draws = 0;
  parts.observer = new IntersectionObserver(
    (entries) => {
      for (const { target: c, isIntersecting } of entries) {
        const act = pageAction(isIntersecting, Boolean(c.dataset.done));
        if (act === 'draw') {
          c.dataset.done = String(++draws); // this draw's mark: a release (or a newer draw) makes it stop
          drawPage(pdf, Number(c.dataset.page), c, view, token, { signal, parts, mark: c.dataset.done });
        } else if (act === 'release') {
          // Far from view: its bitmap goes back (the style size stays, so nothing moves); drawn again when it comes back.
          parts.tasks.get(c)?.cancel();
          c.width = c.height = 0;
          delete c.dataset.done;
        }
      }
    },
    { root, rootMargin: '800px 0px' },
  );
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = el('canvas', { 'data-page': i });
    c.style.width = `${base.width}px`;
    c.style.height = `${base.height}px`;
    container.append(c);
    parts.observer.observe(c);
  }
}

async function drawPage(pdf, n, canvas, view, token, { signal, parts, mark }) {
  try {
    if (token !== view.token || signal.aborted) return;
    const page = await pdf.getPage(n);
    if (token !== view.token || signal.aborted || canvas.dataset.done !== mark) return; // zoomed, replaced or released meanwhile
    const vp = page.getViewport({ scale: view.zoom });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${vp.width}px`;
    canvas.style.height = `${vp.height}px`;
    const task = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
    parts.tasks.set(canvas, task);
    try {
      await task.promise;
    } finally {
      if (parts.tasks.get(canvas) === task) parts.tasks.delete(canvas);
    }
  } catch (err) {
    if (signal.aborted || err?.name === 'RenderingCancelledException') return;
    logEvent('warn', 'pdf page not drawn', { error: err?.message });
  }
}
