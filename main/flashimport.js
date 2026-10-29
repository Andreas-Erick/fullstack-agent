// Reading flashcard files to import (the parsing is in flashimportcore.js): CSV / TSV / Anki text as
// text, Anki packages (.apkg, .colpkg) by unzipping them, opening the collection read-only with Node's
// built-in SQLite (from a temporary copy that is deleted afterwards), and copying the images and sounds
// the cards use into the vault (Flashcards/media/<Deck>/). The caller checks that the file is one the
// assistant may read (documents.resolveAllowed).
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const core = require('./flashimportcore');

const MAX_FILE = 500 * 1024 * 1024;
const MAX_MEDIA_FILE = 25 * 1024 * 1024;
const MAX_MEDIA_TOTAL = 400 * 1024 * 1024;
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|mp3|ogg|oga|wav|m4a|opus|webm)$/i;
const TEXT_EXT = /\.(csv|tsv|txt)$/i;
const ANKI_EXT = /\.(apkg|colpkg)$/i;

const SUPPORTED = ['.csv', '.tsv', '.txt', '.apkg', '.colpkg'];

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|#^[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

/** The note types of a collection: from the col row (older schemas) or the notetypes tables (newest). */
function readModels(db) {
  const tables = new Set(db.prepare("select name from sqlite_master where type = 'table'").all().map((r) => r.name));
  const col = db.prepare('select * from col limit 1').get() || {};
  const models = {};
  if (tables.has('notetypes')) {
    for (const nt of db.prepare('select id, name, config from notetypes').all()) {
      const fields = db.prepare('select name from fields where ntid = ? order by ord').all(nt.id).map((f) => f.name);
      const templates = db.prepare('select config from templates where ntid = ? order by ord').all(nt.id).map((t) => core.templateConfig(t.config));
      models[String(nt.id)] = { name: nt.name, cloze: core.notetypeIsCloze(nt.config), fields, templates };
    }
  } else if (col.models) {
    for (const [id, m] of Object.entries(JSON.parse(col.models))) {
      models[String(id)] = { name: m.name, cloze: m.type === 1, fields: (m.flds || []).sort((a, b) => a.ord - b.ord).map((f) => f.name), templates: (m.tmpls || []).sort((a, b) => a.ord - b.ord).map((t) => ({ qfmt: t.qfmt, afmt: t.afmt })) };
    }
  }
  let decks = {};
  if (tables.has('decks')) decks = Object.fromEntries(db.prepare('select id, name from decks').all().map((d) => [String(d.id), String(d.name).replace(/\x1f/g, '::')]));
  else if (col.decks) decks = Object.fromEntries(Object.entries(JSON.parse(col.decks)).map(([id, d]) => [String(id), d.name]));
  return { models, decks, crt: Number(col.crt) || 0 };
}

/** An Anki package → { cards, media: Map(name → Buffer), deckNames, format }. */
async function readPackage(buf, now) {
  const entries = core.zipEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const pick = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find((n) => byName.has(n));
  if (!pick) throw new Error('This package has no Anki collection in it.');
  const dbBytes = core.unzstd(core.zipRead(buf, byName.get(pick)));
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'siren-anki-'));
  const file = path.join(tmp, 'collection.sqlite');
  let data;
  try {
    await fsp.writeFile(file, dbBytes);
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const { models, decks, crt } = readModels(db);
      const notes = db.prepare('select id, mid, flds, tags from notes').all();
      const cards = db.prepare('select id, nid, did, ord, type, queue, due, ivl, factor, reps, lapses from cards order by nid, ord').all(); // a note's cards together, in the note's order
      data = core.fromCollection({ models, notes, cards, crt, now, decks });
      data.deckNames = [...new Set(cards.map((c) => decks[String(c.did)]).filter(Boolean))];
    } finally {
      db.close();
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  // Media: the package numbers its files ("0", "1", …); the "media" entry names them.
  const media = new Map();
  const map = byName.has('media') ? core.mediaMap(core.zipRead(buf, byName.get('media'))) : {};
  let total = 0;
  for (const [idx, name] of Object.entries(map)) {
    if (!data.media.has(name) || !MEDIA_EXT.test(name) || !byName.has(idx)) continue;
    const e = byName.get(idx);
    // What is still allowed, enforced while unpacking (the declared sizes can lie: a zip bomb).
    const room = Math.min(MAX_MEDIA_FILE, MAX_MEDIA_TOTAL - total);
    if (room <= 0 || e.size > room) continue;
    let bytes;
    try {
      bytes = core.unzstd(core.zipRead(buf, e, { max: room }), { max: room });
    } catch {
      continue; // too large once unpacked, or damaged: that file is left out
    }
    if (bytes.length > room) continue;
    total += bytes.length;
    media.set(name, bytes);
  }
  return { cards: data.cards, media, deckNames: data.deckNames, format: pick === 'collection.anki21b' ? 'anki (newest format)' : 'anki' };
}

/**
 * Reads an import file (full path, already allowed) → { cards, media: Map, deckName, format, skipped }.
 */
async function read(full, { now = Date.now() } = {}) {
  const ext = path.extname(full).toLowerCase();
  const st = await fsp.stat(full);
  if (!st.isFile()) throw new Error('Not a file.');
  if (st.size > MAX_FILE) throw new Error('The file is too large to import (500 MB at most).');
  const base = safeName(path.basename(full, ext)) || 'Imported';
  if (TEXT_EXT.test(ext)) {
    const r = core.parseText(await fsp.readFile(full, 'utf8'), { name: base });
    return { cards: r.cards, media: new Map(), deckName: safeName(r.deck.split('::').pop()) || base, format: r.format, skipped: r.skipped };
  }
  if (ANKI_EXT.test(ext)) {
    const r = await readPackage(await fsp.readFile(full), now);
    const single = r.deckNames.length === 1 ? safeName(r.deckNames[0].split('::').pop()) : '';
    return { cards: r.cards, media: r.media, deckName: single && single !== 'Default' ? single : base, format: r.format, skipped: 0, decks: r.deckNames };
  }
  throw new Error(`Can't import "${ext}" files. Supported: ${SUPPORTED.join(' ')}`);
}

module.exports = { read, readPackage, readModels, safeName, SUPPORTED, MEDIA_EXT };
