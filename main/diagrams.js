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

/** The page without anything that could run. */
function sanitize(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<(iframe|frame|frameset|object|embed|applet|base)\b[\s\S]*?(<\/\1\s*>|\/?>)/gi, '')
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, '')
    .replace(/<link\b[^>]*>/gi, '') // external stylesheets and preloads; the page carries its own styles
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href|action|formaction)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'\s>]*\2/gi, '$1="#"');
}

const fileName = (title) => {
  const t = String(title || '').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!t) throw new Error('Give the diagram a short title.');
  return t;
};

/** Saves the page as Diagrams/<date> <title>.html in the vault; returns its path. */
async function save(title, html) {
  const page = sanitize(html);
  if (!/<(svg|html|body|div)\b/i.test(page)) throw new Error('That is not an HTML page or SVG drawing.');
  if (Buffer.byteLength(page) > MAX_BYTES) throw new Error('The page is over 2 MB; simplify it.');
  const root = await obsidian.vaultPath();
  if (!root) throw new Error('Diagrams are saved in your vault, and no vault is set up.');
  const rel = `${FOLDER}/${obsidian.ymd()} ${fileName(title)}.html`;
  const full = resolveInside(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  const doc = /<html\b/i.test(page) ? page : `<!doctype html>\n<html><head><meta charset="utf-8"><title>${fileName(title)}</title></head><body>\n${page}\n</body></html>\n`;
  await fsp.writeFile(full, doc, 'utf8');
  return { path: full, vaultPath: rel, bytes: Buffer.byteLength(doc) };
}

module.exports = { FOLDER, sanitize, save };
