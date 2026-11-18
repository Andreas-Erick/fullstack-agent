// Documents: load files for on-screen display and extract their text for the agent.
const fsp = require('fs').promises;
const path = require('path');
const { app } = require('electron');
const store = require('./store');
const obsidian = require('./obsidian');
const { isInside } = require('./files');
const doctext = require('./doctext');
const attachcore = require('./attachcore');

const MD_EXTS = ['.md', '.markdown'];
const HTML_EXTS = ['.html', '.htm'];
const IMG_EXTS = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp' };
// Every type the chat accepts as text (attachcore.TEXT_EXTS) is read as text here too, so a copy of an
// attached file opens and reads again; .svg and .html files elsewhere keep their own kind.
const TEXT_EXTS = [...new Set(['.txt', '.log', '.csv', '.tsv', '.json', '.xml', '.yml', '.yaml', '.ini', '.toml', '.js', '.ts', '.py', '.css', '.sh', '.bat', '.ps1', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.sql', ...attachcore.TEXT_EXTS.map((e) => `.${e}`)])].filter((e) => !MD_EXTS.includes(e) && !HTML_EXTS.includes(e) && !IMG_EXTS[e]);
const SUPPORTED = ['.pdf', '.docx', ...TEXT_EXTS, ...MD_EXTS, ...HTML_EXTS, ...Object.keys(IMG_EXTS)];
const MAX_BYTES = 80 * 1024 * 1024;

const userApproved = new Set(); // files the user explicitly picked in a dialog this session
// Copies of files attached in the chat (main/attachments.js): reached through their conversation.
const attachmentsRoot = () => require('./datadir').attachmentsFolder();
const isAttachment = (full) => isInside(attachmentsRoot(), full);

function kindOf(ext) {
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (MD_EXTS.includes(ext)) return 'markdown';
  if (HTML_EXTS.includes(ext)) return 'html';
  if (IMG_EXTS[ext]) return 'image';
  if (TEXT_EXTS.includes(ext)) return 'text';
  return null;
}

// The agent's workspace folder (Settings → Documents): searched first, always allowed.
async function workspace() {
  const s = await store.getSettings();
  return s.documents.workspace ? path.resolve(s.documents.workspace) : null;
}

/**
 * The user's folders the agent may use: the workspace folder, then the folders the user added in
 * Settings → Documents. Nothing else by default; removing a folder from the list takes access away.
 */
function userFolders(settings) {
  const d = settings?.documents || {};
  const list = [d.workspace, ...(Array.isArray(d.allowedRoots) ? d.allowedRoots : [])].filter((p) => typeof p === 'string' && p.trim() && path.isAbsolute(p.trim()));
  return [...new Set(list.map((p) => path.resolve(p.trim())))];
}

// Plus the vault (the agent's own memory), Documents/Siren Exports (only PDFs the app made, when no
// workspace folder is set) and the copies of files attached in the chat (the app's own folder).
async function allowedRoots() {
  const roots = userFolders(await store.getSettings());
  const vault = await obsidian.vaultPath();
  if (vault) roots.push(vault);
  roots.push(require('./datadir').exportsFolder());
  roots.push(require('./datadir').attachmentsFolder());
  return [...new Set(roots.filter(Boolean))];
}

// Resolve an agent/user supplied path and make sure it's allowed.
async function resolveAllowed(p, { fromUser = false } = {}) {
  if (!p) throw new Error('A file path is required');
  let full = String(p).replace(/^~(?=$|[/\\])/, app.getPath('home'));
  if (!path.isAbsolute(full)) {
    // A relative path: the workspace folder first (if the file is there), then the vault.
    const ws = await workspace();
    const vault = await obsidian.vaultPath();
    const inWs = ws && path.join(ws, full);
    if (inWs && (await fsp.stat(inWs).catch(() => null))) full = inWs;
    else if (vault) full = path.join(vault, full);
    else if (ws) full = inWs;
  }
  full = path.resolve(full);
  if (fromUser) userApproved.add(full);
  const roots = await allowedRoots();
  if (!userApproved.has(full) && !roots.some((r) => isInside(r, full))) {
    const s = await store.getSettings();
    throw new Error(
      `Access to "${full}" is not allowed. The agent may only use ${s.documents.workspace ? 'the workspace folder and the folders the user added' : 'the folders the user allowed (no workspace folder is set yet)'}: ${roots.join(', ')} (and files the user opens in the app). Only the user can allow another folder, in Settings → Documents → Add folder; ask them to, don't look elsewhere.`,
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
    doctext.checkDocx(buf); // a zip bomb (a dropped file's copy opens here) is refused before it is unpacked
    const mammoth = require('mammoth');
    const res = await mammoth.convertToHtml({ buffer: buf });
    doc.data = res.value;
  } else doc.data = doctext.asText(buf); // UTF-16 by its byte-order mark, like read_document
  // A chat attachment's copy is reached through its conversation, not the recent list.
  if (!isAttachment(full)) await addRecent(doc);
  return doc;
}

async function extractText(p, { maxChars = 30000, fromUser = false } = {}) {
  const full = await resolveAllowed(p, { fromUser });
  const ext = path.extname(full).toLowerCase();
  const kind = kindOf(ext);
  if (!kind) throw new Error(`Unsupported file type "${ext}"`);
  const buf = await fsp.readFile(full);
  const { text, pages } = await doctext.textOf(buf, kind, { maxChars });
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

// ------------------------------------------------------------- finding files
// "Open the quarterly report PDF": find files by name in the workspace folder first, then the other
// document folders. Bounded (depth, entries, time) and skipping system/build folders, so a vague
// request never turns into a minute-long crawl of the whole disk.
const SKIP_DIRS = /^(\.|node_modules$|__pycache__$|\$recycle\.bin$|appdata$|venv$|site-packages$|windows$|program files)/i;
const FILLER = new Set('a an the my me of in on at from for to about and or please open show find file files document documents doc docs folder called named this that one some'.split(' '));
const KIND_WORDS = { pdf: ['.pdf'], word: ['.docx'], docx: ['.docx'], image: Object.keys(IMG_EXTS), picture: Object.keys(IMG_EXTS), photo: Object.keys(IMG_EXTS), png: ['.png'], jpg: ['.jpg', '.jpeg'], markdown: MD_EXTS, note: MD_EXTS, text: ['.txt'] };

// "DT_Master-Summary2.pdf" → ['dt', 'master', 'summary', '2']
const words = (t) =>
  String(t)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

// At least half the words must match. Words in the file name count most; a file whose folder
// matches the whole request ("the machine learning pdf" → Machine Learning/…) counts too, lower.
function score(queryWords, file, root) {
  const name = words(path.basename(file, path.extname(file)));
  const folders = words(path.relative(root, path.dirname(file)));
  let total = 0;
  let inName = 0;
  let inFolder = 0;
  for (const q of queryWords) {
    if (name.includes(q)) (total += 2), inName++;
    else if (q.length >= 3 && name.some((n) => n.startsWith(q) || (n.length >= 3 && q.startsWith(n)))) (total += 1.2), inName++;
    else if (folders.includes(q) || (q.length >= 4 && folders.some((n) => n.startsWith(q)))) (total += 0.8), inFolder++;
  }
  if (inName + inFolder < Math.ceil(queryWords.length / 2)) return 0;
  if (inName) return total;
  return inFolder === queryWords.length ? total * 0.6 : 0;
}

// Without a kind in the request ("pdf", "image"…), code and config files are not candidates.
const DOC_EXTS = ['.pdf', '.docx', '.txt', '.csv', ...MD_EXTS, ...HTML_EXTS, ...Object.keys(IMG_EXTS)];

async function walk(root, visit, { maxDepth = 8, maxEntries = 40000, deadline }) {
  let seen = 0;
  let queue = [root];
  for (let depth = 0; depth <= maxDepth && queue.length; depth++) {
    const next = [];
    for (const dir of queue) {
      if (seen > maxEntries || Date.now() > deadline) return false;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        seen++;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.test(e.name)) next.push(path.join(dir, e.name));
        } else if (e.isFile()) visit(path.join(dir, e.name));
      }
    }
    queue = next;
  }
  return true;
}

async function findDocuments(query, { limit = 8 } = {}) {
  const all = words(query);
  const exts = all.flatMap((w) => KIND_WORDS[w] || []);
  const queryWords = all.filter((w) => !FILLER.has(w) && !KIND_WORDS[w]);
  if (!queryWords.length) throw new Error('Say what the file is called or what it is about.');
  const ws = await workspace();
  // Not the copies of chat attachments: those are reached through their conversation, not by name.
  const roots = (await allowedRoots()).filter((r) => !isAttachment(r));
  const searched = [];
  const hits = new Map();
  for (const root of roots) {
    if (!(await fsp.stat(root).catch(() => null))?.isDirectory()) continue;
    const isWs = root === ws;
    const complete = await walk(root, (file) => {
      const ext = path.extname(file).toLowerCase();
      if (exts.length ? !exts.includes(ext) : !DOC_EXTS.includes(ext)) return;
      const s = score(queryWords, file, root);
      if (s > 0 && !hits.has(file)) hits.set(file, { path: file, score: s + (isWs ? 0.5 : 0), inWorkspace: isWs });
    }, { deadline: Date.now() + (isWs ? 5000 : 2500) });
    searched.push(complete ? root : `${root} (partly: too large)`);
    // Good matches in the workspace end the search there.
    if (isWs && [...hits.values()].some((h) => h.score >= queryWords.length * 1.5)) break;
  }
  const ranked = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  const matches = await Promise.all(
    ranked.map(async (h) => {
      const st = await fsp.stat(h.path).catch(() => null);
      return { path: h.path, name: path.basename(h.path), modified: st ? new Date(st.mtimeMs).toISOString().slice(0, 10) : undefined, inWorkspace: h.inWorkspace || undefined };
    }),
  );
  return { workspace: ws || '(not set)', searched, matches };
}

/** A file the system's own app may open (docs:openExternal): any allowed file, but from the attachments
 *  folder only documents and data (attachcore.OPENABLE), never a page, a picture with code or a script. */
async function externalPath(p) {
  const full = await resolveAllowed(p);
  if (isAttachment(full) && !attachcore.canOpenExternally(full)) throw new Error('Siren opens this attached file only inside the app.');
  return full;
}

// The document windows and monitors (docwindows.js, set up by main.js).
let popup = null;
const setPopup = (p) => (popup = p);
const getPopup = () => {
  if (!popup) throw new Error('No app window is open to show documents in.');
  return popup;
};

module.exports = { load, extractText, recent, clearRecent, userFolders, allowedRoots, resolveAllowed, externalPath, workspace, findDocuments, kindOf, SUPPORTED, setPopup, popup: getPopup };
