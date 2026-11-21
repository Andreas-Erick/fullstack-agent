// Attachments in the chat: the pure rules shared by the window (js/attach.js, js/chat.js) and the main
// process (main/attachments.js, main/turns.js, llm.js), which requires this file through
// main/attachcore.js (the chartcore pattern). What may be attached and how big, safe file names, the
// <attachment> blocks a message carries before the user's words, and reading them back. No DOM and no
// Node here: Uint8Array, TextDecoder and atob only (test/attachments.test.js, test/attachflow.test.js).

export const LIMITS = {
  files: 6, // attachments per message
  images: 4, // images per message
  imageBytes: 3932160, // an image as main accepts it (after the window redrew it)
  imageKeepBytes: 1572864, // a redrawn PNG above this becomes a JPEG
  imageEdge: 1568, // the long edge an image is redrawn to
  imageDecodeBytes: 50 * 1048576, // an image file the window refuses to decode
  fileBytes: 25 * 1048576,
  textReadBytes: 1048576, // the part of a text file read for the message
  fileChars: 30000, // characters of one file in a message
  messageChars: 60000, // characters of all files in a message
  localChars: 8000, // a local model gets this much of the newest message's files
  thumbEdge: 160,
  thumbChars: 22000,
  heldBytes: 150 * 1048576, // prepared, not yet sent (main/attachments.js)
  heldItems: 24,
  ttlMs: 30 * 60000,
  nameChars: 100,
  extractMs: 20000, // PDF/Word text extraction in its worker thread
  extractHeapMb: 512,
  // Unpacked data (ArrayBuffers) lives outside the worker's heap, in the app's own memory: the process may
  // grow by this much while a file is read, then the thread is ended (main/attachments.js extract).
  extractGrowthMb: 1024,
  unpackedBytes: 300 * 1048576, // a Word file whose zip says it unpacks to more isn't opened (a zip bomb)
  unpackedRatio: 1000, // … nor one that says it unpacks to this many times its own size
  fullAttachmentMessages: 2, // the Claude API keeps the files' text of this many messages
};

/** What main accepts as an image: the window redraws every picture as one of these. */
export const IMAGE_OUT = ['image/png', 'image/jpeg'];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'gif', 'webp', 'bmp', 'avif', 'ico'];

/** Read as text (documents.js reads every one of them too). */
export const TEXT_EXTS = [
  ...['txt', 'log', 'csv', 'tsv', 'json', 'xml', 'yml', 'yaml', 'ini', 'toml', 'js', 'ts', 'py', 'css', 'sh', 'bat', 'ps1', 'java', 'c', 'cpp', 'h', 'cs', 'go', 'rs', 'rb', 'php', 'sql'],
  ...['md', 'markdown', 'html', 'htm', 'svg', 'tex', 'bib', 'm', 'r', 'ipynb', 'jsonl', 'cfg', 'conf', 'env', 'mjs', 'cjs', 'tsx', 'jsx', 'scss', 'kt', 'hpp', 'cc', 'v', 'sv', 'vhd', 'vhdl', 'lua', 'swift', 'dart', 'gradle', 'properties'],
];
/** Text files known by their whole name. */
export const TEXT_NAMES = ['makefile', 'dockerfile', 'readme', 'license'];
/** A saved copy keeps its extension only when it is one of these (documents, data, code Windows doesn't run). */
export const SAFE_EXTS = ['pdf', 'docx', 'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'jsonl', 'log', 'tex', 'bib', 'm', 'r', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'java', 'kt', 'go', 'rs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'sql', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'gradle', 'lua', 'swift', 'dart', 'v', 'sv', 'vhd', 'vhdl', 'ipynb'];
/** What docs:openExternal may open from the attachments folder: never a page, a picture with code, or a script. */
export const OPENABLE = ['pdf', 'docx', 'txt', 'md', 'csv', 'tsv', 'json', 'log'];

const refuse = (exts, why) => Object.fromEntries(exts.map((e) => [e, why]));
/** Types refused before reading, with the fix in plain words (`%s` = the file's name). */
export const REFUSED = {
  ...refuse(['pptx', 'ppt', 'pps', 'ppsx', 'key', 'odp'], '%s is a slide deck Siren can’t read here. Export it as PDF and attach that.'),
  ...refuse(['xlsx', 'xls', 'xlsm', 'xlsb', 'ods', 'numbers'], '%s is a spreadsheet Siren can’t read here. Save the sheet as CSV and attach that.'),
  ...refuse(['doc', 'odt', 'pages', 'wpd'], '%s is in an older document format. Save it as .docx or PDF and attach that.'),
  ...refuse(['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'jar'], '%s is an archive. Unpack it and attach the files inside.'),
  ...refuse(['exe', 'msi', 'msix', 'appx', 'dll', 'com', 'scr', 'sys', 'dmg', 'pkg', 'deb', 'rpm', 'apk', 'iso', 'img', 'lnk'], '%s is a program or installer, not a document. Siren doesn’t take those.'),
  ...refuse(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'oga', 'opus', 'wma', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'm4v', 'mpeg', 'mpg'], '%s is a sound or video file. Siren reads images and documents.'),
  ...refuse(['mat', 'fig', 'mlx'], '%s is a MATLAB file Siren can’t read. Export the data as CSV (or the code as .m) and attach that.'),
  ...refuse(['heic', 'heif', 'tif', 'tiff', 'raw', 'cr2', 'nef', 'arw', 'dng', 'psd'], '%s can’t be opened here. Save it as JPEG or PNG and try again.'),
};
const REFUSED_TYPES = { 'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff' };

// ------------------------------------------------------------------ names and sizes
const baseName = (name) => String(name ?? '').split(/[\\/]/).pop();
/** 'notes.MD' → 'md'; a name without one → ''. A name that is only an extension ('.env') counts as one. */
export function extOf(name) {
  const b = baseName(name);
  const i = b.lastIndexOf('.');
  return i >= 0 && i < b.length - 1 ? b.slice(i + 1).toLowerCase() : '';
}
const quoted = (name) => {
  const b = baseName(name);
  return `“${b.length > 60 ? `${b.slice(0, 57)}…` : b}”`;
};

/** 4200000 → '4 MB' (as Explorer counts: 1 MB = 1024 KB). */
export function formatBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${Math.round(b / 1024)} KB`;
  const mb = b / 1048576;
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, '') : Math.round(mb)} MB`;
}
const count = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');

/**
 * What a picked, pasted or dropped file is: { kind: 'image'|'text'|'pdf'|'docx'|'unknown' } (unknown: main
 * looks at its bytes), or { error } in a full sentence naming the file.
 */
export function classify({ name, type = '', size = 0 }) {
  const ext = extOf(name);
  const mime = String(type || '').toLowerCase();
  const tooBig = (limit) => ({ error: `${quoted(name)} is too big (${formatBytes(size)}). ${limit === LIMITS.fileBytes ? 'Files' : 'Images'} can be up to ${formatBytes(limit)}.` });
  if (!(Number(size) > 0)) return { error: `${quoted(name)} is empty.` };
  // Own keys only: 'x.constructor' or 'y.__proto__' must not find Object.prototype's members.
  const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);
  const refused = own(REFUSED, ext) || own(REFUSED, own(REFUSED_TYPES, mime));
  if (refused) return { error: refused.replace('%s', () => quoted(name)) }; // a function: a "$&" in a name stays as it is
  const kind =
    IMAGE_EXTS.includes(ext) ? 'image'
    : ext === 'pdf' ? 'pdf'
    : ext === 'docx' ? 'docx'
    : TEXT_EXTS.includes(ext) || TEXT_NAMES.includes(baseName(name).toLowerCase()) ? 'text'
    : mime.startsWith('image/') && mime !== 'image/svg+xml' ? 'image'
    : mime === 'application/pdf' ? 'pdf'
    : mime.startsWith('text/') ? 'text'
    : 'unknown';
  if (kind === 'image') return size > LIMITS.imageDecodeBytes ? tooBig(LIMITS.imageDecodeBytes) : { kind };
  return size > LIMITS.fileBytes ? tooBig(LIMITS.fileBytes) : { kind };
}

/** Windows' reserved device names, with or without an extension. */
const DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A name that is safe as a file name on every system: the base name only, ≤ 100 characters (extension kept). */
export function safeName(name) {
  let n = baseName(name)
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '') // invisible and direction marks ('photo', U+202E, 'gnp.exe' shows as photoexe.png)
    .trim()
    .replace(/[. ]+$/, '');
  if (n.length > LIMITS.nameChars) {
    const ext = extOf(n);
    const tail = ext && ext.length <= 12 ? n.slice(-(ext.length + 1)) : '';
    n = `${n.slice(0, LIMITS.nameChars - tail.length).replace(/[. ]+$/, '')}${tail}`;
  }
  if (!n || /^\.+$/.test(n)) return 'attachment';
  return DEVICE.test(n) ? `_${n}` : n;
}

/** The copy's name: a script, a web page or a type Windows might run gets '.txt' appended. */
export function savedName(name) {
  const n = safeName(name);
  return SAFE_EXTS.includes(extOf(n)) ? n : `${n}.txt`;
}

/** 'notes.md' when free, else 'notes (2).md', 'notes (3).md'… (compared as Windows does, ignoring case). */
export function uniqueName(name, taken = new Set()) {
  const has = (n) => taken.has(n) || taken.has(n.toLowerCase());
  if (!has(name)) return name;
  const ext = extOf(name) ? name.slice(-(extOf(name).length + 1)) : ''; // as written: 'A.TXT' → 'A (2).TXT'
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; ; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!has(n)) return n;
  }
}

/** A pasted picture has no name: 'Pasted image 14-32-05.png'. */
export function pastedName(type, date = new Date()) {
  const ext = { 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' }[String(type || '').toLowerCase()] || 'png';
  const t = [date.getHours(), date.getMinutes(), date.getSeconds()].map((x) => String(x).padStart(2, '0')).join('-');
  return `Pasted image ${t}.${ext}`;
}

/** The same file twice (same name and size) in one tray. */
export const isDuplicate = (list, { name, size }) => (list || []).some((x) => x.name === name && x.size === size);

// ------------------------------------------------------------------ bytes
const startsWith = (b, sig, at = 0) => sig.every((x, i) => b[at + i] === x);
/** The picture a file really is, from its first bytes, or ''. */
export function sniffImage(bytes) {
  const b = bytes || [];
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return '';
}
/** A PDF says so in its first kilobyte. */
export function isPdf(bytes) {
  const b = bytes || [];
  const end = Math.min(b.length, 1024) - 5;
  for (let i = 0; i <= end; i++) if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d], i)) return true;
  return false;
}
/** A .docx is a zip. */
export const isZip = (bytes) => startsWith(bytes || [], [0x50, 0x4b, 0x03, 0x04]);

/**
 * What a zip says it unpacks to, from its central directory: { entries, bytes } (a ZIP64 size counts as
 * Infinity), or null when there is no directory to read here. The sizes are only what the file claims:
 * main/attachments.js also watches the memory while the text is read.
 */
export function zipUnpacked(bytes) {
  const b = bytes || new Uint8Array(0);
  if (!(b.length >= 22) || !b.buffer) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // The end-of-central-directory record: in the last 22 bytes, or before a comment of up to 65,535.
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const entries = dv.getUint16(end + 10, true);
  const size = dv.getUint32(end + 12, true);
  const offset = dv.getUint32(end + 16, true);
  if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) return { entries: Infinity, bytes: Infinity };
  if (offset + size > b.length) return null;
  let total = 0;
  for (let n = 0, p = offset; n < entries; n++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) return null;
    const unpacked = dv.getUint32(p + 24, true);
    if (unpacked === 0xffffffff) return { entries, bytes: Infinity };
    total += unpacked;
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
  return { entries, bytes: total };
}

/** A Word file whose zip says it unpacks to more than a document would (a zip bomb): its text isn't read. */
export function unpacksTooFar(bytes) {
  const z = zipUnpacked(bytes);
  return Boolean(z) && (z.bytes > LIMITS.unpackedBytes || z.bytes > LIMITS.unpackedRatio * bytes.length);
}

const decoder = (label) => {
  try {
    return new TextDecoder(label);
  } catch {
    return null; // a runtime without that encoding
  }
};

/**
 * Text from a file's bytes: { text, binary, cut }. A byte-order mark picks UTF-16 (and is dropped). A NUL in
 * the first 8 KB, or more than 2% undecodable characters, means it isn't text. A file with no valid UTF-8
 * beyond ASCII is read as Windows-1252 (how Excel and older editors save), not as replacement characters.
 */
export function decodeText(bytes, { maxBytes = Infinity } = {}) {
  const all = bytes || new Uint8Array(0);
  const cut = all.length > maxBytes;
  let b = cut ? all.subarray(0, maxBytes) : all;
  const opts = { stream: cut }; // a cut in the middle of a character is no undecodable one
  for (const [sig, label] of [[[0xff, 0xfe], 'utf-16le'], [[0xfe, 0xff], 'utf-16be']]) {
    if (startsWith(b, sig) && decoder(label)) return { text: decoder(label).decode(b.subarray(2), opts), binary: false, cut };
  }
  if (startsWith(b, [0xef, 0xbb, 0xbf])) b = b.subarray(3);
  if (b.subarray(0, 8192).includes(0)) return { text: '', binary: true, cut };
  const text = new TextDecoder('utf-8').decode(b, opts);
  const bad = text.split('�').length - 1;
  if (!bad) return { text, binary: false, cut };
  if (!/[^\x00-\x7f�]/.test(text) && decoder('windows-1252')) {
    const legacy = decoder('windows-1252').decode(b);
    const controls = (legacy.match(/[\x00-\x08\x0e-\x1f]/g) || []).length;
    return { text: legacy, binary: controls / Math.max(1, legacy.length) > 0.02, cut };
  }
  return { text, binary: bad / Math.max(1, text.length) > 0.02, cut };
}

/** A Jupyter notebook's cell sources (outputs left out), or null when it isn't one. */
export function notebookText(json) {
  let nb;
  try {
    nb = typeof json === 'string' ? JSON.parse(json) : json;
  } catch {
    return null;
  }
  if (!Array.isArray(nb?.cells)) return null;
  return nb.cells
    .map((c) => `# [${c?.cell_type === 'markdown' ? 'markdown' : c?.cell_type === 'raw' ? 'raw' : 'code'}]\n${Array.isArray(c?.source) ? c.source.join('') : String(c?.source ?? '')}`.trimEnd())
    .join('\n\n');
}

/** A thumbnail main keeps with a message: a small JPEG data URL, nothing else. */
export function isThumb(s) {
  if (typeof s !== 'string' || s.length > LIMITS.thumbChars || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(s)) return false;
  try {
    const head = atob(s.slice(23, 27));
    return head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ images
/** The size an image is drawn at: its long edge at most `edge`, never larger than it was. */
export function fitImage(w, h, edge = LIMITS.imageEdge) {
  const width = Math.max(1, Math.round(Number(w) || 1));
  const height = Math.max(1, Math.round(Number(h) || 1));
  const long = Math.max(width, height);
  if (long <= edge) return { width, height };
  const k = edge / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** How a notice names what was left out: 'the shared screen', 'your image', 'your 2 images'… */
export function imageNoun({ screen = false, images = 0 } = {}) {
  const mine = images === 1 ? 'your image' : images > 1 ? `your ${images} images` : '';
  if (screen && mine) return `the shared screen and ${mine}`;
  return screen ? 'the shared screen' : mine;
}

/** A PDF read only partly: its length guessed from the pages read (said as "about"). */
export const estimateChars = ({ chars = 0, pages = 0, pagesRead = 0 } = {}) => (pagesRead && pages > pagesRead ? Math.round((chars * pages) / pagesRead) : chars);

// ------------------------------------------------------------------ the message
const OPEN = '<attachment ';
const CLOSE = '</attachment>';
/** The words the message carries when the user sent files and nothing else. */
export const NO_MESSAGE = '[The user sent only these attachments, without a message.]';
const NOT_REPEATED = '[Not repeated here: read the saved file if you need it again.]';
const NOT_INCLUDED = 'Not included here to keep the message short: read the saved file.';
const COPY = 'This is a copy kept with this conversation (changing it doesn’t change the user’s file).';
// The line before a file's text says what it is; fitBlocks finds the text after it by these openings.
const DESCRIPTIONS = ['Text extracted from', 'The file’s text.', 'The notebook’s cells', 'This PDF has no text layer', 'No text could be read', NOT_INCLUDED];

const attr = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** A file's text can't close its block, open another, end the per-turn context or the compact prompt's notes. */
export function neutralise(text) {
  return String(text ?? '')
    .replace(/<(\/?)(attachment|context)/gi, '‹$1$2')
    .replace(/End of notes\. The user['’]s message:/gi, 'End of notes (quoted). The user’s message (quoted):');
}

function header(i, item) {
  const parts = [`index="${i}"`, `kind="${item.kind}"`, `name="${attr(item.name)}"`];
  if (item.kind === 'image') {
    if (item.width && item.height) parts.push(`size="${item.width}×${item.height}"`);
    return `${OPEN}${parts.join(' ')} />`;
  }
  parts.push(`size="${formatBytes(item.size)}"`);
  if (item.pages) parts.push(`pages="${Number(item.pages)}"`);
  if (item.path) parts.push(`saved="${attr(item.path)}"`);
  return `${OPEN}${parts.join(' ')}>`;
}

// "pages 1–12 of 28": the last page marker (doctext.js "--- Page N ---") in what is shown.
function pagesShown(body, pages) {
  const all = [...String(body).matchAll(/--- Page (\d+) ---/g)];
  const last = all.length ? Number(all[all.length - 1][1]) : 0;
  return last && pages ? `pages 1–${last} of ${pages}` : '';
}

function description(item, { cut, body }) {
  const read = `read_document on the saved path gives the full text`;
  if (item.kind === 'pdf') {
    const span = cut ? pagesShown(body, item.pages) : item.pages ? `${item.pages} page${item.pages === 1 ? '' : 's'}` : '';
    return `Text extracted from the PDF${span ? ` (${span})` : ''}; figures, diagrams and equations may be missing or garbled. ${COPY} ${read}; with the Claude account brain, Read on it shows the pages as they look.`;
  }
  if (item.kind === 'docx') return `Text extracted from the Word document; tables, figures and equations may be missing or garbled. ${COPY} ${read}.`;
  if (extOf(item.name) === 'ipynb') return `The notebook’s cells (their sources; outputs left out). ${COPY} ${read}.`;
  return `The file’s text. ${COPY} ${read}.`;
}

function fileBlock(i, item, room, notice) {
  const lines = [header(i, item)];
  if (notice) lines.push(notice);
  const text = String(item.text || '');
  if (item.note === 'no-text' || !text.trim()) {
    lines.push(item.kind === 'pdf' ? 'This PDF has no text layer (it may be scanned, or it couldn’t be read here): read the saved file to see its pages.' : 'No text could be read from this file here: read the saved file.');
    return { block: [...lines, CLOSE].join('\n'), shown: 0 };
  }
  if (room <= 0) return { block: [...lines, NOT_INCLUDED, CLOSE].join('\n'), shown: 0 };
  const shown = Math.min(text.length, LIMITS.fileChars, room);
  const body = neutralise(text.slice(0, shown));
  const total = Math.max(Number(item.chars) || 0, text.length);
  const cut = shown < total;
  lines.push(description(item, { cut, body }), body);
  if (cut) {
    const where = item.kind === 'pdf' ? pagesShown(body, item.pages) : '';
    lines.push(`[Cut: ${count(shown)} characters shown (${where ? `${where}, ` : ''}about ${count(total)} in all). The rest is in the saved file.]`);
  }
  return { block: [...lines, CLOSE].join('\n'), shown };
}

/**
 * The message for a turn with attachments: one block per item (files with their text, images as a header
 * line), a blank line, then `prompt` (the user's words, or a skill's steps). Returns { content, display,
 * title, meta, images, taint }: what is stored and sent, what the chat shows, the conversation title when
 * nothing was typed, the attachments as kept with the message (no text, no picture), the images to send,
 * and one outside-content source per item (approvals.markTainted).
 */
export function compose({ prompt = '', typed = '', items = [], notice = '' }) {
  const blocks = [];
  const meta = [];
  const images = [];
  const taint = [];
  let room = LIMITS.messageChars;
  items.forEach((item, n) => {
    if (item.kind === 'image') {
      blocks.push(header(n + 1, item));
      if (item.dataUrl) images.push(item.dataUrl);
      meta.push({ kind: 'image', name: item.name, type: item.type, width: item.width, height: item.height, ...(isThumb(item.thumb) ? { thumb: item.thumb } : {}) });
      taint.push(`attached image "${item.name}"`);
      return;
    }
    const { block, shown } = fileBlock(n + 1, item, room, notice);
    room -= shown;
    blocks.push(block);
    const chars = Math.max(Number(item.chars) || 0, String(item.text || '').length);
    meta.push({ kind: item.kind, name: item.name, size: item.size, chars, shown, ...(item.pages ? { pages: item.pages } : {}), path: item.path });
    taint.push(`attached file "${item.name}"`);
  });
  const said = String(typed || '').trim();
  return {
    content: `${blocks.join('\n')}\n\n${String(prompt || '').trim() ? prompt : NO_MESSAGE}`,
    display: said,
    title: said || summary(meta),
    meta,
    images,
    taint,
  };
}

/**
 * A message run again (Try again, Regenerate, Edit): its file blocks as they were, new words after them.
 * Its pictures are gone (never stored). null when the message had no files.
 */
export function recompose(user, { prompt = '', typed = '' } = {}) {
  const files = (user?.attachments || []).filter((a) => a.kind !== 'image');
  if (!files.length) return null;
  const { blocks } = splitBlocks(String(user.content || ''));
  const kept = blocks.filter((b) => !b.image).map((b) => b.text);
  const said = String(typed || '').trim();
  return {
    content: `${kept.join('\n')}\n\n${String(prompt || '').trim() ? prompt : NO_MESSAGE}`,
    display: said,
    title: said || summary(files),
    meta: files,
    images: [],
    taint: files.map((f) => `attached file "${f.name}"`),
    hadImages: (user.attachments || []).some((a) => a.kind === 'image'),
  };
}

// ------------------------------------------------------------------ reading it back
// The leading run of blocks: [{ start, end, text, image, head, inner }] and where the user's words begin.
function splitBlocks(content) {
  const s = String(content ?? '');
  const blocks = [];
  let p = 0;
  while (s.startsWith(OPEN, p) && /^<attachment index="\d+" kind="(image|pdf|docx|text|unknown)"/.test(s.slice(p, p + 80))) {
    const eol = s.indexOf('\n', p);
    const line = s.slice(p, eol < 0 ? s.length : eol);
    let end;
    if (line.endsWith(' />')) end = p + line.length;
    else {
      const close = s.indexOf(CLOSE, p);
      if (close < 0) break;
      end = close + CLOSE.length;
    }
    blocks.push({ start: p, end, text: s.slice(p, end), image: line.endsWith(' />'), head: line });
    p = end;
    if (s[p] === '\n') p++;
  }
  if (blocks.length && s[p] === '\n') p++; // the blank line before the user's words
  return { blocks, rest: blocks.length ? s.slice(p) : s };
}

/** The user's own words (or a skill's steps), without the attachment blocks before them. */
export const withoutBlocks = (content) => splitBlocks(content).rest;
/** How many characters the attachments take in a message (routing and pace treat it as text to read). */
export const attachedChars = (content) => String(content ?? '').length - withoutBlocks(content).length;

// A file block's parts: the notice, the line that says what the text is, the text, the cut note. `text`
// is false for a block without one (not included, no text layer).
function blockParts(b) {
  const inner = b.text.slice(b.head.length + 1, b.text.length - CLOSE.length - 1);
  const lines = inner.split('\n');
  const d = lines.findIndex((l) => DESCRIPTIONS.some((x) => l.startsWith(x)));
  const body = d >= 0 ? lines.slice(d + 1) : lines;
  if (body.length && /^\[Cut: /.test(body[body.length - 1])) body.pop();
  const text = d >= 0 && !lines[d].startsWith(NOT_INCLUDED) && !lines[d].startsWith('This PDF') && !lines[d].startsWith('No text');
  return { notice: d >= 0 ? lines.slice(0, d) : [], description: d >= 0 ? lines[d] : '', body: body.join('\n'), text };
}

const rebuild = (content, blocks, mapBlock) => {
  const { rest } = splitBlocks(content);
  return `${blocks.map(mapBlock).join('\n')}\n\n${rest}`;
};

/** Older messages: each file's text gives way to a note (the header, with the saved path, stays). */
export function headersOnly(content) {
  const { blocks } = splitBlocks(content);
  if (!blocks.length) return String(content ?? '');
  return rebuild(content, blocks, (b) => (b.image ? b.text : `${b.head}\n${NOT_REPEATED}\n${CLOSE}`));
}

/** The files' text shortened, in order, to `maxChars` in all (a local model's small context), each cut noted. */
export function fitBlocks(content, maxChars) {
  const { blocks } = splitBlocks(content);
  if (!blocks.length || !(maxChars < Infinity)) return String(content ?? '');
  let room = Math.max(0, maxChars);
  return rebuild(content, blocks, (b) => {
    if (b.image) return b.text;
    const p = blockParts(b);
    if (!p.text || p.body.length <= room) {
      room -= p.text ? p.body.length : 0;
      return b.text;
    }
    const keep = p.body.slice(0, room);
    room = 0;
    const rest = keep ? [p.description, keep, `[Cut: ${count(keep.length)} characters shown here. The rest is in the saved file.]`] : [NOT_INCLUDED];
    return [b.head, ...p.notice, ...rest, CLOSE].join('\n');
  });
}

// ------------------------------------------------------------------ showing it
const names = (list) => (list || []).map((a) => a.name).join(', ');

/** A message with attachments as plain text: what was typed, then the file names (journal, handoff, PDF). */
export function plainText(m) {
  const said = String(m?.display ?? '').trim();
  if (!m?.attachments?.length) return String(m?.display || m?.content || '');
  return `${said}${said ? ' ' : ''}[attached: ${names(m.attachments)}]`;
}

/** The same with where each file's copy is (transcripts, summaries, history_search): the words come first. */
export function summaryLine(m) {
  const said = String(m?.display ?? '').trim();
  if (!m?.attachments?.length) return String(m?.display || m?.content || '');
  const files = m.attachments.map((a) => (a.path ? `${a.name} → ${a.path}` : a.name)).join('; ');
  return `${said}${said ? ' ' : ''}[attached: ${files}]`;
}

/** What a paired device sees of a message's attachments: names only. */
export const forDevice = (list) => (Array.isArray(list) ? list : []).map((a) => ({ kind: String(a?.kind || 'file'), name: String(a?.name || '').slice(0, 120) }));

const ICONS = { image: '🖼', pdf: '📄', docx: '📘', text: '📝' };
/** A chip for one attachment (the composer's tray, a sent message): icon or thumbnail, name, detail, path. */
export function chipFor(meta) {
  const m = meta || {};
  let detail;
  if (m.kind === 'image') detail = `Image${m.width && m.height ? ` · ${m.width}×${m.height}` : ''}`;
  else {
    const kind = m.kind === 'pdf' ? 'PDF' : m.kind === 'docx' ? 'Word' : 'Text';
    const parts = [kind];
    if (m.pages) parts.push(`${m.pages} page${m.pages === 1 ? '' : 's'}`);
    let size = m.size ? formatBytes(m.size) : '';
    if (Number(m.chars) === 0 && m.kind !== 'text') size = [size, 'no text found'].filter(Boolean).join(', ');
    else if (m.shown != null && m.shown < m.chars) size = `${size}, first ${count(m.shown)} characters sent`;
    if (size) parts.push(size);
    detail = parts.join(' · ');
  }
  return { icon: ICONS[m.kind] || '📎', name: String(m.name || 'attachment'), detail, thumb: isThumb(m.thumb) ? m.thumb : '', path: typeof m.path === 'string' ? m.path : '' };
}

/** '📎 a.pdf, b.png' (the caption, a title with no words). */
export const summary = (meta) => `📎 ${names(meta)}`;

// ------------------------------------------------------------------ brains and pictures
/** Which brains see images (main/router.js PROVIDERS vision); null = it depends on the model. */
export const SEES_IMAGES = { 'claude-code': true, anthropic: true, gemini: true, deepseek: false, groq: false, perplexity: false, local: false, openai: null, auto: null };

/** The warning on an image chip for the current brain, or ''. */
export function visionHint(provider) {
  const sees = SEES_IMAGES[provider];
  if (sees === false) return 'Your current brain can’t see images: it gets only the name. Switch to Claude to ask about it.';
  if (sees === null && provider === 'openai') return 'Your current brain may not see images, depending on the model.';
  return '';
}

/** An attached copy opened in the system's own app: documents and data only. */
export const canOpenExternally = (file) => OPENABLE.includes(extOf(file));

/**
 * What Enter does with the composer: 'hold' (a send already waits for its files, or a message waits for the
 * reply being stopped: the words stay in the box, so neither goes out of order), 'none' (nothing to send),
 * 'wait' (files are still being read: the words stay in the box), 'queue' (a reply is running), 'send'.
 */
export function sendPlan({ text = '', files = 0, reading = false, active = false, waiting = false } = {}) {
  if (waiting) return 'hold';
  if (!String(text).trim() && !files) return 'none';
  if (reading) return 'wait';
  if (active) return 'queue';
  return 'send';
}
