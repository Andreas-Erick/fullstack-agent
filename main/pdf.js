// PDF export: Markdown (a note, a reply, a whole conversation, or text the agent wrote) rendered to
// a clean printable page and saved as a PDF. The page is rendered in a hidden window with scripts
// off and every network request blocked, so nothing in the content can run or phone home.
const fsp = require('fs').promises;
const path = require('path');
const { app, BrowserWindow, session } = require('electron');
const store = require('./store');
const log = require('./logger');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Where exports go: the workspace folder if one is set, else Documents/Nexus Exports. */
async function exportsDir() {
  const s = await store.getSettings();
  return s.documents.workspace ? path.resolve(s.documents.workspace) : path.join(app.getPath('documents'), 'Nexus Exports');
}

function safeName(title) {
  return String(title || 'Export').replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Export';
}

// Never overwrite: "Plan.pdf", "Plan (2).pdf", …
async function freePath(dir, base) {
  for (let i = 1; ; i++) {
    const file = path.join(dir, `${base}${i > 1 ? ` (${i})` : ''}.pdf`);
    if (!(await fsp.stat(file).catch(() => null))) return file;
  }
}

const PRINT_CSS = `
  @page { margin: 18mm 16mm; }
  body { font: 11pt/1.6 "Segoe UI", system-ui, -apple-system, Roboto, sans-serif; color: #15181f; margin: 0; }
  header { border-bottom: 2px solid #1f6feb; padding-bottom: 8px; margin-bottom: 18px; }
  header h1 { margin: 0; font-size: 20pt; }
  header .meta { color: #667085; font-size: 9pt; margin-top: 4px; }
  h1, h2, h3 { line-height: 1.25; page-break-after: avoid; } h2 { border-bottom: 1px solid #e4e7ec; padding-bottom: 3px; }
  pre { background: #f5f7fa; border: 1px solid #e4e7ec; border-radius: 6px; padding: 10px; white-space: pre-wrap; font-size: 9pt; }
  code { font-family: Consolas, "JetBrains Mono", monospace; font-size: 9.5pt; background: #f5f7fa; padding: 1px 4px; border-radius: 4px; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 8px 0; } th, td { border: 1px solid #d0d5dd; padding: 4px 8px; } th { background: #f5f7fa; }
  blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid #d0d5dd; color: #475467; }
  img { max-width: 100%; }
  .turn { margin: 0 0 14px; page-break-inside: avoid; } .turn .who { font-weight: 600; font-size: 9pt; color: #667085; text-transform: uppercase; letter-spacing: .05em; }
  .turn.user .body { background: #eef4ff; border-radius: 8px; padding: 6px 10px; white-space: pre-wrap; }
`;

// Markdown → HTML with formulas as MathML, which Chromium draws without scripts or fonts (the PDF
// window allows neither). The math parsing is the renderer's (renderer/js/mathtext.js): an ES module
// without imports in a CommonJS package, so it is loaded from its source as a data: module.
let mathtext = null;
async function loadMathtext() {
  const src = await fsp.readFile(path.join(__dirname, '..', 'renderer', 'js', 'mathtext.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
}

async function markdownHtml(markdown) {
  const { marked } = await import('marked');
  mathtext ||= loadMathtext();
  const { extractMath, restoreMath } = await mathtext;
  const katex = require('katex');
  const { text, items } = extractMath(String(markdown || ''));
  const html = marked.parse(text, { gfm: true, breaks: true });
  return restoreMath(html, items, (tex, displayMode) => {
    try {
      return katex.renderToString(tex, { displayMode, output: 'mathml', throwOnError: false, strict: 'ignore', trust: false });
    } catch {
      return `<code>${esc(tex)}</code>`;
    }
  });
}

async function toHtml({ title, markdown, html }) {
  // Remote images are never fetched (the page is offline); a note stands in for them.
  const body = (html ?? (await markdownHtml(markdown))).replace(/<img\b[^>]*\bsrc="(?!data:)[^"]*"[^>]*>/gi, (tag) => `<em>[image${(tag.match(/\balt="([^"]*)"/i) || [])[1] ? `: ${tag.match(/\balt="([^"]*)"/i)[1]}` : ''}]</em>`);
  const when = new Date().toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${PRINT_CSS}</style></head><body><header><h1>${esc(title)}</h1><div class="meta">${esc(when)}</div></header>${body}</body></html>`;
}

let printSession = null;
function isolatedSession() {
  if (printSession) return printSession;
  printSession = session.fromPartition('nexus-print');
  printSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith('data:') }));
  printSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  return printSession;
}

/** Renders and saves a PDF; returns { path, pages? }. `dir` defaults to exportsDir(). */
async function create({ title, markdown, html, dir, file }) {
  const page = await toHtml({ title: title || 'Export', markdown, html });
  const win = new BrowserWindow({ show: false, width: 900, height: 1200, webPreferences: { javascript: false, sandbox: true, session: isolatedSession(), images: true } });
  try {
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(page, 'utf8').toString('base64')}`);
    const letter = /^en-(US|CA)$|^es-(MX|US)$/i.test(app.getLocale());
    const pdf = await win.webContents.printToPDF({
      pageSize: letter ? 'Letter' : 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="font-size:8px;color:#98a2b3;width:100%;text-align:center"><span class="title"></span> · <span class="pageNumber"></span>/<span class="totalPages"></span></div>`,
    });
    const outDir = dir || (await exportsDir());
    await fsp.mkdir(outDir, { recursive: true });
    const target = file || (await freePath(outDir, safeName(title)));
    await fsp.writeFile(target, pdf);
    log.info('pdf created', { file: target, kb: Math.round(pdf.length / 1024) });
    return { path: target, kb: Math.round(pdf.length / 1024) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/** A conversation as a printable transcript. */
async function conversationHtml(conv) {
  const turns = (conv.messages || []).filter((m) => !m.hidden && (m.role === 'user' || m.role === 'assistant'));
  const bodies = await Promise.all(turns.map((m) => (m.role === 'user' ? esc(m.display || m.content) : markdownHtml(m.content))));
  return turns
    .map((m, i) => `<div class="turn ${m.role}"><div class="who">${m.role === 'user' ? 'You' : 'Assistant'} · ${esc(new Date(m.createdAt || conv.updatedAt).toLocaleString())}</div><div class="body">${bodies[i]}</div></div>`)
    .join('\n');
}

module.exports = { create, exportsDir, conversationHtml };
