// Documents: load files for on-screen display and extract their text for the agent.
const fsp = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const store = require('./store');
const obsidian = require('./obsidian');
const { isInside } = require('./files');

const TEXT_EXTS = ['.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.yml', '.yaml', '.ini', '.toml', '.js', '.ts', '.py', '.css', '.sh', '.bat', '.ps1', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.sql'];
const MD_EXTS = ['.md', '.markdown'];
const HTML_EXTS = ['.html', '.htm'];
const IMG_EXTS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
const SUPPORTED = ['.pdf', '.docx', ...TEXT_EXTS, ...MD_EXTS, ...HTML_EXTS, ...Object.keys(IMG_EXTS)];
const MAX_BYTES = 80 * 1024 * 1024;

const userApproved = new Set(); // files the user explicitly picked in a dialog this session
let pdfjsPromise = null;

function kindOf(ext) {
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (MD_EXTS.includes(ext)) return 'markdown';
  if (HTML_EXTS.includes(ext)) return 'html';
  if (IMG_EXTS[ext]) return 'image';
  if (TEXT_EXTS.includes(ext)) return 'text';
  return null;
}

async function allowedRoots() {
  const s = await store.getSettings();
  const roots = s.documents.allowedRoots?.length
    ? [...s.documents.allowedRoots]
    : ['documents', 'desktop', 'downloads'].map((k) => {
        try {
          return app.getPath(k);
        } catch {
          return null;
        }
      });
  const vault = await obsidian.vaultPath();
  if (vault) roots.push(vault);
  return roots.filter(Boolean);
}

// Resolve an agent/user supplied path and make sure it's allowed.
async function resolveAllowed(p, { fromUser = false } = {}) {
  if (!p) throw new Error('A file path is required');
  let full = String(p).replace(/^~(?=$|[/\\])/, app.getPath('home'));
  if (!path.isAbsolute(full)) {
    // Treat relative paths as Obsidian vault notes/files first.
    const vault = await obsidian.vaultPath();
    if (vault) full = path.join(vault, full);
    else full = path.resolve(app.getPath('documents'), full);
  }
  full = path.resolve(full);
  if (fromUser) userApproved.add(full);
  const roots = await allowedRoots();
  if (!userApproved.has(full) && !roots.some((r) => isInside(r, full))) {
    throw new Error(
      `Access to "${full}" is not allowed. The agent can open files in: ${roots.join(', ')} (or files you open yourself). Add folders in Settings → Documents.`,
    );
  }
  return full;
}

async function load(p, opts = {}) {
  const full = await resolveAllowed(p, opts);
  const st = await fsp.stat(full);
  if (!st.isFile()) throw new Error('Not a file');
  if (st.size > MAX_BYTES) throw new Error('File is too large to display (80 MB max)');
  const ext = path.extname(full).toLowerCase();
  const kind = kindOf(ext);
  if (!kind) throw new Error(`Unsupported file type "${ext}". Supported: ${SUPPORTED.join(' ')}`);
  const doc = { path: full, name: path.basename(full), ext, kind, size: st.size, modified: st.mtimeMs };
  const buf = await fsp.readFile(full);
  if (kind === 'pdf') doc.data = new Uint8Array(buf);
  else if (kind === 'image') doc.data = `data:${IMG_EXTS[ext]};base64,${buf.toString('base64')}`;
  else if (kind === 'docx') {
    const mammoth = require('mammoth');
    const res = await mammoth.convertToHtml({ buffer: buf });
    doc.data = res.value;
  } else doc.data = buf.toString('utf8');
  await addRecent(doc);
  return doc;
}

async function getPdfjs() {
  pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function pdfText(buf, maxChars) {
  const pdfjs = await getPdfjs();
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  let out = '';
  for (let i = 1; i <= pdf.numPages && out.length < maxChars; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    out += `\n\n--- Page ${i} ---\n` + tc.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join('');
  }
  const pages = pdf.numPages;
  await pdf.destroy();
  return { text: out.trim(), pages };
}

async function extractText(p, { maxChars = 30000, fromUser = false } = {}) {
  const full = await resolveAllowed(p, { fromUser });
  const ext = path.extname(full).toLowerCase();
  const kind = kindOf(ext);
  if (!kind) throw new Error(`Unsupported file type "${ext}"`);
  const buf = await fsp.readFile(full);
  let text = '';
  let pages;
  if (kind === 'pdf') ({ text, pages } = await pdfText(buf, maxChars));
  else if (kind === 'docx') text = (await require('mammoth').extractRawText({ buffer: buf })).value;
  else if (kind === 'image') text = '[Image file — no text content available]';
  else if (kind === 'html') text = buf.toString('utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  else text = buf.toString('utf8');
  const truncated = text.length > maxChars;
  return {
    path: full,
    name: path.basename(full),
    kind,
    pages,
    chars: text.length,
    text: truncated ? `${text.slice(0, maxChars)}\n…[truncated; ${text.length} chars total]` : text,
  };
}

function recentFile() {
  return path.join(store.dataDir(), 'recent-documents.json');
}

async function recent() {
  return store.readJson(recentFile(), []);
}

async function addRecent(doc) {
  const list = (await recent()).filter((d) => d.path !== doc.path);
  list.unshift({ path: doc.path, name: doc.name, kind: doc.kind, openedAt: Date.now() });
  await store.writeJsonAtomic(recentFile(), list.slice(0, 30));
}

async function clearRecent() {
  await store.writeJsonAtomic(recentFile(), []);
}

module.exports = { load, extractText, recent, clearRecent, allowedRoots, resolveAllowed, SUPPORTED };
