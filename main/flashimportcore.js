// Importing flashcards, pure (flashimport.js reads the files): CSV / TSV, Anki's "Notes in Plain Text"
// export, and Anki packages (.apkg / .colpkg: a zip with an SQLite collection; the zip and the bits of
// protobuf the newest format uses are read here, the database by flashimport.js). Anki's HTML fields
// become Markdown, its card templates are filled in, media references are collected.
const zlib = require('zlib');
const anki = require('./ankicore');

const MAX_CARDS = 50000;

// ------------------------------------------------------------------ CSV / TSV / Anki text
/** RFC 4180 rows (quoted fields with commas, quotes and newlines), with a given delimiter. */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delim) row.push(field), (field = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** The delimiter a file most likely uses: tab, semicolon, comma or pipe (the most consistent one). */
function sniff(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).slice(0, 20);
  let best = ',';
  let score = -1;
  for (const d of ['\t', ';', ',', '|']) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const min = Math.min(...counts);
    const s = min > 0 ? min * 10 - (Math.max(...counts) - min) : -1;
    if (s > score) (score = s), (best = d);
  }
  return best;
}

const HEADER_FRONT = /^(front|question|q|term|word|prompt|vorderseite|frage|recto|pregunta|domanda)$/i;
const HEADER_BACK = /^(back|answer|a|definition|meaning|translation|rückseite|antwort|verso|respuesta|risposta)$/i;
const HEADER_TAGS = /^(tags?|labels?|schlagwörter)$/i;

/**
 * CSV / TSV / Anki "Notes in Plain Text" → { cards: [{ front, back, tags }], deck, format, skipped }.
 * Anki's header lines (#separator:tab, #html:true, #tags column:3, #deck:…) are honoured; otherwise the
 * first two columns are front and back (a header row naming them is recognised), a "tags" column is kept.
 */
function parseText(text, { name = '' } = {}) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const head = {};
  while (lines.length && /^#[\w ]+:/.test(lines[0])) {
    const [, k, v] = /^#([\w ]+):(.*)$/.exec(lines.shift());
    head[k.trim().toLowerCase()] = v.trim();
  }
  const body = lines.join('\n');
  const sep = { tab: '\t', comma: ',', semicolon: ';', space: ' ', pipe: '|', colon: ':' }[head.separator] || (head.separator?.length === 1 ? head.separator : sniff(body));
  let rows = parseDelimited(body, sep);
  const html = head.html === 'true' || /<(br|div|b|i|img|span|p)\b/i.test(body);
  let front = 0;
  let back = 1;
  let tagsCol = head['tags column'] ? Number(head['tags column']) - 1 : -1;
  const first = rows[0] || [];
  if (first.some((h) => HEADER_FRONT.test(h.trim())) || first.some((h) => HEADER_BACK.test(h.trim()))) {
    front = Math.max(0, first.findIndex((h) => HEADER_FRONT.test(h.trim())));
    const b = first.findIndex((h) => HEADER_BACK.test(h.trim()));
    back = b >= 0 ? b : front === 0 ? 1 : 0;
    const t = first.findIndex((h) => HEADER_TAGS.test(h.trim()));
    if (t >= 0) tagsCol = t;
    rows = rows.slice(1);
  }
  const conv = (s) => (html ? htmlToMarkdown(s).text : String(s || '').trim());
  let skipped = 0;
  const cards = [];
  for (const r of rows.slice(0, MAX_CARDS)) {
    const f = conv(r[front]);
    const b = conv(r[back]);
    if (!f) {
      skipped++;
      continue;
    }
    const tags = tagsCol >= 0 && r[tagsCol] ? r[tagsCol].split(/\s+/).filter(Boolean).slice(0, 20) : [];
    cards.push({ front: f, back: b, tags });
  }
  return { cards, deck: head.deck || name, format: head.separator || head.html ? 'anki-text' : sep === '\t' ? 'tsv' : 'csv', skipped };
}

// ------------------------------------------------------------------ HTML (Anki fields) → Markdown
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', shy: '' };
const decode = (s) => s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));

/** An Anki field → { text (Markdown), media: [file names it shows or plays] }. */
function htmlToMarkdown(html) {
  const media = [];
  let s = String(html || '');
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/\[sound:([^\]]+)\]/g, (_m, f) => (media.push(f.trim()), `![[${f.trim()}]]`));
  s = s.replace(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi, (_m, dq, sq, bare) => {
    const f = decode(dq ?? sq ?? bare ?? '');
    if (/^(https?:|data:)/i.test(f)) return '';
    media.push(f);
    return `![[${f}]]`;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|li|tr|h\d)>/gi, '\n').replace(/<li\b[^>]*>/gi, '- ');
  s = s.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, x) => (x.trim() ? `**${x.trim()}**` : x));
  s = s.replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, x) => (x.trim() ? `*${x.trim()}*` : x));
  s = s.replace(/<(sub|sup|u|code)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, t, x) => (t.toLowerCase() === 'code' ? `\`${x}\`` : x));
  s = s.replace(/<[^>]+>/g, '');
  s = decode(s)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: s, media };
}

// ------------------------------------------------------------------ Anki card templates
/**
 * Fills in an Anki template ({{Field}}, {{FrontSide}}, {{#Field}}…{{/Field}}, {{^Field}}…, filters like
 * {{text:Field}}, {{cloze:Text}}, {{hint:Field}}, {{type:Field}} (shown plainly)). fields: name → value.
 */
function fillTemplate(tpl, fields, { frontSide = '' } = {}) {
  let s = String(tpl || '');
  const has = (name) => String(fields[name] ?? '').replace(/<[^>]*>/g, '').trim() !== '';
  // Sections, innermost first, a few rounds for nesting.
  for (let round = 0; round < 5; round++) {
    const next = s.replace(/\{\{([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g, (_m, kind, name, inner) => ((kind === '#') === has(name) ? inner : ''));
    if (next === s) break;
    s = next;
  }
  return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr) => {
    if (expr === 'FrontSide') return frontSide;
    const parts = expr.split(':');
    const name = parts.pop().trim();
    const filters = parts.map((p) => p.trim().toLowerCase());
    if (name === 'Tags' || name === 'Deck' || name === 'Subdeck' || name === 'Card' || name === 'Type') return '';
    if (filters.includes('type')) return '';
    let v = String(fields[name] ?? '');
    if (filters.includes('text')) v = v.replace(/<[^>]*>/g, '');
    return v;
  });
}

// ------------------------------------------------------------------ zip (Anki packages)
/** The entries of a zip file (from its central directory): [{ name, method, size, offset }]. */
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file (an Anki package is a zip).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), method, csize, size, local });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

const MAX_ENTRY = 400 * 1024 * 1024;

/** One zip entry's bytes (stored or deflated). */
function zipRead(buf, e) {
  if (e.size > MAX_ENTRY) throw new Error(`"${e.name}" in the package is too large.`);
  const p = e.local;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('Damaged zip file.');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY });
  throw new Error(`Unsupported compression in the package (method ${e.method}).`);
}

const ZSTD_MAGIC = 0xfd2fb528;
/** Anki's newest packages compress their files with zstd; older ones don't. */
function unzstd(b) {
  if (b.length >= 4 && b.readUInt32LE(0) === ZSTD_MAGIC) {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('This Anki package uses zstd compression, which needs a newer Node.js.');
    return zlib.zstdDecompressSync(b, { maxOutputLength: MAX_ENTRY });
  }
  return b;
}

// ------------------------------------------------------------------ protobuf (Anki's newest format)
/** The fields of one protobuf message: [{ no, wire, value }] (value: number or Buffer). */
function protoFields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let x = 0;
    let shift = 0;
    for (;;) {
      if (i >= buf.length) throw new Error('Damaged protobuf');
      const b = buf[i++];
      x += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return x;
      shift += 7;
    }
  };
  while (i < buf.length) {
    const key = varint();
    const no = Math.floor(key / 8);
    const wire = key & 7;
    if (wire === 0) out.push({ no, wire, value: varint() });
    else if (wire === 2) {
      const len = varint();
      out.push({ no, wire, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === 1) i += 8;
    else if (wire === 5) i += 4;
    else throw new Error('Unsupported protobuf');
  }
  return out;
}
const protoString = (fields, no) => {
  const f = fields.find((x) => x.no === no && x.wire === 2);
  return f ? f.value.toString('utf8') : '';
};

/** The media list of a package: index in the zip → file name (JSON in older packages, protobuf in newer). */
function mediaMap(buf) {
  const raw = unzstd(buf);
  const text = raw.toString('utf8');
  if (/^\s*\{/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }
  // MediaEntries { repeated MediaEntry entries = 1 } with MediaEntry { string name = 1; … }
  const out = {};
  protoFields(raw)
    .filter((f) => f.no === 1 && f.wire === 2)
    .forEach((f, i) => (out[String(i)] = protoString(protoFields(f.value), 1)));
  return out;
}

/** A template's question and answer formats in the newest format (CardTemplate.Config: 1 = q, 2 = a). */
function templateConfig(blob) {
  const f = protoFields(Buffer.from(blob));
  return { qfmt: protoString(f, 1), afmt: protoString(f, 2) };
}
/** A note type's kind in the newest format (Notetype.Config field 1: 0 normal, 1 cloze). */
function notetypeIsCloze(blob) {
  const f = protoFields(Buffer.from(blob)).find((x) => x.no === 1 && x.wire === 0);
  return f?.value === 1;
}

// ------------------------------------------------------------------ Anki notes → cards
/**
 * Turns a collection's notes and cards into flashcards.
 * models: { id: { name, cloze, fields: [names], templates: [{ qfmt, afmt }] } }
 * notes: [{ id, mid, flds (\x1f-separated), tags }]; cards: [{ nid, ord, type, queue, due, ivl, factor,
 * reps, lapses }]; crt: the collection's creation (seconds), for review due dates; now (ms).
 * Returns { cards: [{ front, back, cloze, tags, src, sched }], media: Set }.
 */
function fromCollection({ models, notes, cards, crt, now, decks = {} }) {
  const byNote = new Map(notes.map((n) => [String(n.id), n]));
  const media = new Set();
  const out = [];
  const md = (html) => {
    const r = htmlToMarkdown(html);
    r.media.forEach((m) => media.add(m));
    return r.text;
  };
  const crtDay = anki.dayOf((Number(crt) || 0) * 1000);
  for (const c of cards.slice(0, MAX_CARDS)) {
    const n = byNote.get(String(c.nid));
    const m = n && models[String(n.mid)];
    if (!m) continue;
    const values = String(n.flds).split('\x1f');
    const fields = Object.fromEntries(m.fields.map((name, i) => [name, values[i] ?? '']));
    let front;
    let back;
    let cloze = 0;
    if (m.cloze) {
      // Cloze notes: the text field (the one the template's {{cloze:…}} names) keeps its {{cN::}} markers.
      const tpl = m.templates[0] || {};
      const fieldName = /\{\{cloze:([^}]+)\}\}/.exec(tpl.qfmt || '')?.[1]?.trim() || m.fields[0];
      cloze = Number(c.ord) + 1;
      front = md(fields[fieldName] || '');
      const extra = m.fields.filter((f) => f !== fieldName).map((f) => md(fields[f])).filter(Boolean);
      back = extra.join('\n\n');
    } else {
      const tpl = m.templates[Number(c.ord)] || m.templates[0];
      if (!tpl) continue;
      const q = fillTemplate(tpl.qfmt, fields);
      const a = fillTemplate(tpl.afmt, fields, { frontSide: '' }).replace(/<hr\s+id\s*=\s*["']?answer["']?\s*\/?>/gi, '');
      front = md(q);
      back = md(a);
      if (!back || back === front) back = md(values[1] || '');
    }
    if (!front) continue;
    // The schedule Anki had: review cards keep interval, ease and due date; learning cards start over.
    const sched = { type: 'new', reps: Number(c.reps) || 0, lapses: Number(c.lapses) || 0 };
    if (Number(c.type) === 2 && Number(c.ivl) > 0) {
      Object.assign(sched, { type: 'review', ivl: Number(c.ivl), ease: (Number(c.factor) || 2500) / 1000, due: anki.addDays(crtDay, Number(c.due)) });
    } else if (Number(c.type) === 1 || Number(c.type) === 3) Object.assign(sched, { type: 'learn', step: 0, dueAt: now, ease: (Number(c.factor) || 2500) / 1000 || 2.5 });
    if (Number(c.queue) === -1) sched.suspended = true;
    const tags = String(n.tags || '').trim().split(/\s+/).filter(Boolean).slice(0, 20);
    out.push({ front, back, cloze, tags, src: `anki:${c.nid}:${c.ord}`, sched, deck: decks[String(c.did)] || '' });
  }
  return { cards: out, media };
}

module.exports = { parseDelimited, sniff, parseText, htmlToMarkdown, fillTemplate, zipEntries, zipRead, unzstd, protoFields, mediaMap, templateConfig, notetypeIsCloze, fromCollection, MAX_CARDS };
