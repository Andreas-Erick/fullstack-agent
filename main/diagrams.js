// Diagrams and other self-contained HTML pages the agent makes (e.g. with the diagram-design skill):
// saved in the vault's Diagrams/ folder and shown in a document window. What runs is removed before
// saving (scripts, event handlers, javascript: links, frames, embeds, external stylesheets); the viewer
// also shows HTML in a sandboxed frame with scripts off (renderer/js/docview.js).
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const obsidian = require('./obsidian');
const { resolveInside } = require('./files');

const FOLDER = 'Diagrams';
const MAX_BYTES = 2000000;

// The first thing in every saved page: nothing runs and nothing loads from outside, also when the file
// is opened in a browser ("Open in its default app"), whatever the cleaning below missed (security
// review 2026-10-29 found handlers and split <script> tags that got through it).
const PAGE_CSP = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; form-action \'none\'; base-uri \'none\'">';

function sanitizeOnce(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<\/?script\b[^>]*>/gi, '')
    .replace(/<(iframe|frame|frameset|object|embed|applet|base|foreignObject)\b[\s\S]*?(<\/\1\s*>|\/?>)/gi, '')
    .replace(/<\/?(iframe|frame|frameset|object|embed|applet|base|foreignObject)\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '') // external stylesheets and preloads; the page carries its own styles
    .replace(/@import\b[^;]*;?/gi, '')
    // SVG animation that rewrites a link into javascript:.
    .replace(/<(animate|set)\b[^>]*attributeName\s*=\s*["']?(xlink:)?href\b[^>]*>(\s*<\/\1\s*>)?/gi, '')
    // Handlers after a space, a slash or a quote (<svg/onload=…>, src="x"onerror=…).
    .replace(/(?<=[\s/"'])on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href|action|formaction)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, '$1="#"');
}

/** The page without anything that could run: cleaned until nothing changes (a removed tag can't rebuild one). */
function sanitize(html) {
  let page = String(html || '');
  for (let i = 0; i < 6; i++) {
    const next = sanitizeOnce(page);
    if (next === page) break;
    page = next;
  }
  return page;
}

/** The page with PAGE_CSP as the first element of its <head>. */
function withCsp(doc) {
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (h) => `${h}${PAGE_CSP}`);
  if (/<html\b[^>]*>/i.test(doc)) return doc.replace(/<html\b[^>]*>/i, (h) => `${h}<head>${PAGE_CSP}</head>`);
  return `${PAGE_CSP}${doc}`;
}

const fileName = (title) => {
  const t = String(title || '').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!t) throw new Error('Give the diagram a short title.');
  return t;
};

/** Saves the page as Diagrams/<date> <title>.html in the vault; returns its path. */
async function save(title, html) {
  // The size first: cleaning a huge page with unclosed tags takes minutes.
  if (Buffer.byteLength(String(html || '')) > MAX_BYTES) throw new Error('The page is over 2 MB; simplify it.');
  const page = sanitize(html);
  if (!/<(svg|html|body|div)\b/i.test(page)) throw new Error('That is not an HTML page or SVG drawing.');
  const root = await obsidian.vaultPath();
  if (!root) throw new Error('Diagrams are saved in your vault, and no vault is set up.');
  const rel = `${FOLDER}/${obsidian.ymd()} ${fileName(title)}.html`;
  const full = resolveInside(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  const doc = withCsp(/<html\b/i.test(page) ? page : `<!doctype html>\n<html><head><meta charset="utf-8"><title>${fileName(title)}</title></head><body>\n${page}\n</body></html>\n`);
  await fsp.writeFile(full, doc, 'utf8');
  return { path: full, vaultPath: rel, bytes: Buffer.byteLength(doc) };
}

// ------------------------------------------------------------------ in PDFs
// A saved diagram or chart goes into a PDF as an image of its SVG (a data: URL): its own styles can't
// restyle the document, and nothing in it can run. A page with several drawings gives each one; a page
// without SVG (HTML-only) can't be shown in a PDF and says so.
const EMBED = /!\[\[([^\]|]+?\.(?:html?|svg))(?:\|([^\]]*))?\]\]/gi;

/** The <svg> drawings in a saved page, each made standalone (xmlns, the page's <style> carried inside). */
function svgsOf(page) {
  const styles = [...String(page).matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]).join('\n');
  return [...sanitize(page).matchAll(/<svg\b[\s\S]*?<\/svg\s*>/gi)].map(([svg]) => {
    let s = /\bxmlns=/.test(svg.slice(0, svg.indexOf('>'))) ? svg : svg.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
    if (styles && !/<style\b/i.test(s)) s = s.replace(/^(<svg\b[^>]*>)/i, `$1<style>${styles.replace(/<\/?style/gi, '')}</style>`);
    return s;
  });
}

/**
 * Markdown with ![[Diagrams/….html]] (or .svg) references → { markdown, embeds }: each reference
 * becomes a placeholder paragraph and `embeds[i]` the HTML for it. `read(rel)` returns the file's
 * text (only files in the vault's Diagrams/ folder are read).
 */
async function embedDiagrams(markdown, read) {
  const embeds = [];
  const parts = [];
  let last = 0;
  for (const m of String(markdown || '').matchAll(EMBED)) {
    parts.push(markdown.slice(last, m.index));
    last = m.index + m[0].length;
    const ref = m[1].trim().replace(/\\/g, '/');
    const caption = (m[2] || '').trim();
    const rel = ref.startsWith(`${FOLDER}/`) ? ref : `${FOLDER}/${ref}`;
    let html;
    try {
      if (rel.includes('..')) throw new Error('outside');
      const svgs = svgsOf(await read(rel));
      if (!svgs.length) throw new Error('no drawing');
      const alt = caption || path.basename(ref).replace(/\.\w+$/, '');
      html = `<figure class="diagram">${svgs.map((s) => `<img alt="${alt.replace(/"/g, '&quot;')}" src="data:image/svg+xml;base64,${Buffer.from(s, 'utf8').toString('base64')}">`).join('')}${caption ? `<figcaption>${caption.replace(/[<>&]/g, '')}</figcaption>` : ''}</figure>`;
    } catch {
      html = `<p><em>[diagram not found or not drawable in a PDF: ${ref.replace(/[<>&]/g, '')}]</em></p>`;
    }
    parts.push(`\n\n%%DIAGRAM-${embeds.length}%%\n\n`);
    embeds.push(html);
  }
  parts.push(String(markdown || '').slice(last));
  return { markdown: parts.join(''), embeds };
}

module.exports = { FOLDER, sanitize, save, svgsOf, embedDiagrams };
