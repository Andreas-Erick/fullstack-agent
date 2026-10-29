// Importing flashcards (main/flashimportcore.js, main/flashimport.js) and the whole flow through the
// vault (main/flashcards.js): CSV, Anki text, and real Anki packages built here (the legacy schema with
// JSON note types, and the newest one: zstd-compressed, note types in protobuf tables).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');
const { stub, load, tmpDir, quietLog, fileStore } = require('./helpers');
const core = require('../main/flashimportcore');

// ------------------------------------------------------------- building test packages
function zip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data0] of Object.entries(files)) {
    const data = Buffer.from(data0);
    const deflate = name.endsWith('.anki2');
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(deflate ? 8 : 0, 8);
    h.writeUInt32LE(body.length, 18);
    h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26);
    locals.push(h, n, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const dir = tmpDir('nexus-flashimport-');
const crt = Math.floor(Date.parse('2026-01-01T04:00:00') / 1000);
let dbNo = 0;
const dbFile = (name) => path.join(dir, `${dbNo++}-${name}`);

function legacyCollection() {
  const file = dbFile('legacy.anki2');
  const db = new DatabaseSync(file);
  db.exec('create table col (id integer primary key, crt integer, models text, decks text); create table notes (id integer primary key, mid integer, flds text, tags text); create table cards (id integer primary key, nid integer, did integer, ord integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer)');
  const models = {
    1: { name: 'Basic (and reversed card)', type: 0, flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }], tmpls: [{ ord: 0, qfmt: '{{Front}}', afmt: '{{FrontSide}}<hr id=answer>{{Back}}' }, { ord: 1, qfmt: '{{Back}}', afmt: '{{FrontSide}}<hr id=answer>{{Front}}' }] },
    2: { name: 'Cloze', type: 1, flds: [{ name: 'Text', ord: 0 }, { name: 'Back Extra', ord: 1 }], tmpls: [{ ord: 0, qfmt: '{{cloze:Text}}', afmt: '{{cloze:Text}}<br>{{Back Extra}}' }] },
  };
  db.prepare('insert into col values (1, ?, ?, ?)').run(crt, JSON.stringify(models), JSON.stringify({ 10: { name: 'Biology' } }));
  db.prepare('insert into notes values (?, ?, ?, ?)').run(100, 1, ['<b>ATP</b>&nbsp;is…<br><img src="atp.png">', 'the energy currency'].join('\x1f'), ' cell energy ');
  db.prepare('insert into notes values (?, ?, ?, ?)').run(200, 2, ['The {{c1::nucleus}} holds {{c2::DNA}}.', 'Basics'].join('\x1f'), '');
  const card = db.prepare('insert into cards values (?, ?, 10, ?, ?, ?, ?, ?, ?, ?, ?)');
  card.run(1, 100, 0, 2, 2, 300, 12, 2300, 6, 1); // review, due day 300 after crt
  card.run(2, 100, 1, 0, 0, 1, 0, 0, 0, 0); // new (reversed)
  card.run(3, 200, 0, 0, -1, 2, 0, 0, 0, 0); // new, suspended
  card.run(4, 200, 1, 0, 0, 3, 0, 0, 0, 0);
  db.close();
  return fs.readFileSync(file);
}

// The newest schema's protobuf bits: CardTemplate.Config { 1: qfmt, 2: afmt }, Notetype.Config { 1: kind }.
const pbString = (no, s) => {
  const b = Buffer.from(s);
  return Buffer.concat([Buffer.from([(no << 3) | 2, b.length]), b]);
};
function newestCollection() {
  const file = dbFile('newest.anki21b');
  const db = new DatabaseSync(file);
  db.exec('create table col (id integer primary key, crt integer, models text, decks text); create table notetypes (id integer primary key, name text, config blob); create table fields (ntid integer, ord integer, name text); create table templates (ntid integer, ord integer, name text, config blob); create table decks (id integer primary key, name text); create table notes (id integer primary key, mid integer, flds text, tags text); create table cards (id integer primary key, nid integer, did integer, ord integer, type integer, queue integer, due integer, ivl integer, factor integer, reps integer, lapses integer)');
  db.prepare('insert into col values (1, ?, ?, ?)').run(crt, '', '');
  db.prepare('insert into notetypes values (7, ?, ?)').run('Vocab', Buffer.from([0x08, 0x00]));
  db.prepare('insert into fields values (7, 0, ?), (7, 1, ?), (7, 2, ?)').run('Word', 'Meaning', 'Audio');
  db.prepare('insert into templates values (7, 0, ?, ?)').run('Card 1', Buffer.concat([pbString(1, '{{Word}}{{#Audio}} {{Audio}}{{/Audio}}'), pbString(2, '{{FrontSide}}<hr id=answer>{{Meaning}}')]));
  db.prepare('insert into decks values (5, ?)').run('Languages\x1fSpanish');
  db.prepare('insert into notes values (?, ?, ?, ?)').run(300, 7, ['el perro', 'the dog', '[sound:perro.mp3]'].join('\x1f'), 'animals');
  db.prepare('insert into cards values (1, 300, 5, 0, 0, 0, 1, 0, 0, 0, 0)').run();
  db.close();
  return fs.readFileSync(file);
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cf00000301010018dd8db00000000049454e44ae426082', 'hex');

// ------------------------------------------------------------- pure parts
test('CSV and TSV: quotes, header rows, tags; Anki’s text export with its header lines', () => {
  const csv = 'Question,Answer,Tags\n"Capital of France","Paris, the city of light",geo europe\n"Multi\nline","with ""quotes""",\n,empty front,\n';
  const r = core.parseText(csv);
  assert.deepStrictEqual(r.cards, [{ front: 'Capital of France', back: 'Paris, the city of light', tags: ['geo', 'europe'] }, { front: 'Multi\nline', back: 'with "quotes"', tags: [] }]);
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(core.parseText('Hund\tdog\nKatze\tcat\n').cards.length, 2);
  assert.strictEqual(core.parseText('Hund;Hond\nKatze;Kat').cards[1].back, 'Kat', 'semicolons are sniffed');
  const ankiTxt = '#separator:tab\n#html:true\n#deck:Languages::German\n#tags column:3\n<b>Hund</b>\tdog<br>(animal)\tde animals\n';
  const t = core.parseText(ankiTxt);
  assert.deepStrictEqual(t.cards, [{ front: '**Hund**', back: 'dog\n(animal)', tags: ['de', 'animals'] }]);
  assert.strictEqual(t.deck, 'Languages::German');
});

test('a first line that only explains the columns is skipped when asked', () => {
  const csv = 'Spanish word,English meaning\nperro,dog\ngato,cat\n';
  assert.strictEqual(core.parseText(csv, { name: 'd' }).cards[0].front, 'Spanish word', 'kept by default: it could be a card');
  const r = core.parseText(csv, { name: 'd', skipFirst: true });
  assert.deepStrictEqual(r.cards.map((c) => c.front), ['perro', 'gato']);
  // A recognised header is dropped once, not twice.
  assert.deepStrictEqual(core.parseText('Front,Back\nperro,dog\ngato,cat\n', { name: 'd', skipFirst: true }).cards.map((c) => c.front), ['perro', 'gato']);
});

test('Anki HTML becomes Markdown; media references are collected; templates are filled in', () => {
  const r = core.htmlToMarkdown('<div>Hello&nbsp;<b>world</b></div><div><i>x</i> &lt;3 <img src="a b.png"> [sound:s.mp3]<script>bad()</script></div>');
  assert.strictEqual(r.text, 'Hello **world**\n*x* <3 ![[a b.png]] ![[s.mp3]]');
  assert.deepStrictEqual(r.media, ['s.mp3', 'a b.png']);
  // Escaped tags in a field stay text in the note (Obsidian would otherwise render them as HTML).
  assert.strictEqual(core.htmlToMarkdown('&lt;img src=x onerror=alert(1)&gt; &lt;/div&gt; a &lt; b').text, '&lt;img src=x onerror=alert(1)> &lt;/div> a < b');
  assert.strictEqual(core.parseText('one\tuno\n<script>x()</script>\tback\n', { name: 'd' }).cards[1].front, '&lt;script>x()&lt;/script>');
  assert.strictEqual(core.fillTemplate('{{#Extra}}[{{Extra}}]{{/Extra}}{{^Extra}}none{{/Extra}} {{text:Front}}', { Front: '<b>F</b>', Extra: '' }), 'none F');
  assert.strictEqual(core.fillTemplate('{{FrontSide}}|{{Back}}{{Tags}}{{type:Back}}', { Back: 'b' }, { frontSide: 'q' }), 'q|b');
});

test('protobuf and media lists of the newest packages', () => {
  const f = core.protoFields(Buffer.concat([pbString(1, 'qq'), Buffer.from([0x10, 0x96, 0x01]), pbString(3, 'zz')]));
  assert.deepStrictEqual(f.map((x) => [x.no, typeof x.value === 'number' ? x.value : x.value.toString()]), [[1, 'qq'], [2, 150], [3, 'zz']]);
  const entries = Buffer.concat([0, 1].map((i) => { const e = pbString(1, ['a.png', 'b.mp3'][i]); return Buffer.concat([Buffer.from([0x0a, e.length]), e]); }));
  assert.deepStrictEqual(core.mediaMap(zlib.zstdCompressSync(entries)), { 0: 'a.png', 1: 'b.mp3' });
  assert.deepStrictEqual(core.mediaMap(Buffer.from('{"0":"x.jpg"}')), { 0: 'x.jpg' });
});

// ------------------------------------------------------------- packages
test('a legacy .apkg: reversed and cloze cards, HTML, the schedule it had, suspension, media', async () => {
  const fi = load('main/flashimport.js');
  const pkg = zip({ 'collection.anki2': legacyCollection(), media: JSON.stringify({ 0: 'atp.png' }), 0: PNG });
  const file = path.join(dir, 'Biology.apkg');
  fs.writeFileSync(file, pkg);
  const r = await fi.read(file, { now: Date.parse('2026-10-27T10:00:00') });
  assert.strictEqual(r.deckName, 'Biology');
  assert.strictEqual(r.cards.length, 4);
  const [fwd, rev, c1, c2] = r.cards;
  assert.strictEqual(fwd.front, '**ATP** is…\n![[atp.png]]');
  assert.strictEqual(fwd.back, 'the energy currency', 'the answer side without {{FrontSide}} (the view shows the question above it)');
  assert.deepStrictEqual([fwd.sched.type, fwd.sched.ivl, fwd.sched.ease, fwd.sched.due], ['review', 12, 2.3, '2026-10-28']);
  assert.deepStrictEqual(fwd.tags, ['cell', 'energy']);
  assert.strictEqual(rev.front, 'the energy currency');
  assert.deepStrictEqual([c1.cloze, c2.cloze, c1.front, c1.back], [1, 2, 'The {{c1::nucleus}} holds {{c2::DNA}}.', 'Basics']);
  assert.strictEqual(c1.sched.suspended, true);
  assert.deepStrictEqual([...r.media.keys()], ['atp.png']);
});

test('the newest .apkg (zstd, protobuf note types, nested deck name, sounds)', async () => {
  const fi = load('main/flashimport.js');
  const z = (b) => zlib.zstdCompressSync(Buffer.from(b));
  const entry = (name) => { const e = pbString(1, name); return Buffer.concat([Buffer.from([0x0a, e.length]), e]); };
  const pkg = zip({ 'collection.anki21b': z(newestCollection()), 'collection.anki2': legacyCollection(), media: z(entry('perro.mp3')), 0: z(Buffer.from('ID3fake-mp3')) });
  const file = path.join(dir, 'export.apkg');
  fs.writeFileSync(file, pkg);
  const r = await fi.read(file);
  assert.strictEqual(r.format, 'anki (newest format)');
  assert.strictEqual(r.deckName, 'Spanish', 'the last part of "Languages::Spanish"');
  assert.deepStrictEqual(r.cards.map((c) => [c.front, c.back]), [['el perro ![[perro.mp3]]', 'the dog']]);
  assert.strictEqual(r.media.get('perro.mp3').toString(), 'ID3fake-mp3');
  await assert.rejects(fi.read(path.join(dir, 'nope.docx')), /ENOENT|Can't import/);
});

// ------------------------------------------------------------- through the vault
test('import from the workspace, study, undo, edit; vocabulary decks show up too', async () => {
  const vault = path.join(dir, 'vault');
  const ws = path.join(dir, 'workspace');
  fs.mkdirSync(path.join(vault, 'Languages'), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(vault, 'Languages', 'German.md'), '# German\n\n- **der Hund** — the dog <!-- srs due=2026-01-01 ivl=3 ease=2.50 reps=2 lapses=0 -->\n');
  fs.writeFileSync(path.join(ws, 'capitals.csv'), 'front,back\nFrance,Paris\nItaly,Rome\n');
  fs.writeFileSync(path.join(ws, 'Biology.apkg'), zip({ 'collection.anki2': legacyCollection(), media: JSON.stringify({ 0: 'atp.png' }), 0: PNG }));
  const notes = (rel) => path.join(vault, rel);
  stub({
    './logger': quietLog,
    './store': fileStore(dir, { getSettings: async () => ({ documents: { workspace: ws } }) }),
    './obsidian': {
      vaultPath: async () => vault,
      readOptional: async (rel) => fs.readFileSync(notes(rel), 'utf8').toString().replace(/^/, '') || '',
      writeNote: async (rel, text, mode) => {
        if (mode === 'create' && fs.existsSync(notes(rel))) throw new Error('exists');
        fs.mkdirSync(path.dirname(notes(rel)), { recursive: true });
        fs.writeFileSync(notes(rel), text);
        return { path: rel };
      },
      deleteNote: async (rel) => fs.rmSync(notes(rel)),
      ymd: () => '2026-10-27',
    },
    './documents': {
      userFolders: () => [ws],
      resolveAllowed: async (p) => {
        const full = path.isAbsolute(p) ? p : path.join(ws, p);
        if (!full.startsWith(ws)) throw new Error('Access not allowed');
        return full;
      },
    },
  });
  // readOptional must return '' for a missing note.
  const ob = require('module').prototype.require.call(module, './obsidian');
  const read = ob.readOptional;
  ob.readOptional = async (rel) => (fs.existsSync(notes(rel)) ? read(rel) : '');
  const fc = load('main/flashcards.js');

  assert.deepStrictEqual((await fc.importable()).map((f) => f.name).sort(), ['Biology.apkg', 'capitals.csv']);
  const imp = await fc.importFile('capitals.csv');
  assert.deepStrictEqual([imp.deck, imp.added, imp.format], ['f:capitals', 2, 'csv']);
  assert.strictEqual((await fc.importFile('capitals.csv')).added, 0, 'importing again adds nothing twice');
  await assert.rejects(fc.importFile(path.join(dir, 'outside.csv')), /not allowed/);
  const bio = await fc.importFile('Biology.apkg');
  assert.deepStrictEqual([bio.deck, bio.added, bio.media], ['f:Biology', 4, 1]);
  assert.ok(fs.existsSync(path.join(vault, 'Flashcards', 'media', 'Biology', 'atp.png')));
  assert.match(fs.readFileSync(notes('Flashcards/Biology.md'), 'utf8'), /!\[\[Flashcards\/media\/Biology\/atp\.png\]\]/);

  const { decks } = await fc.decks();
  assert.deepStrictEqual(decks.map((d) => d.id), ['f:Biology', 'f:capitals', 'v:German']);
  assert.strictEqual(decks.find((d) => d.id === 'f:capitals').new, 2);

  let n = await fc.next('f:Biology');
  assert.ok(n.card, 'a card to study');
  const first = await fc.next('f:capitals');
  assert.strictEqual(first.card.front, 'France');
  assert.deepStrictEqual(first.card.preview, { again: '1m', hard: '6m', good: '10m', easy: '4d' });
  const after = await fc.answer('f:capitals', first.card.id, 'easy');
  assert.strictEqual(after.card.front, 'Italy');
  assert.strictEqual(after.canUndo, true);
  const back = await fc.undoLast('f:capitals');
  assert.strictEqual(back.card.front, 'France', 'undo brings the card back');

  // A media card carries the picture as a data URL.
  const withPic = (await fc.browse('f:Biology')).cards.find((c) => /atp\.png/.test(c.front));
  assert.ok(withPic);
  n = await fc.next('f:Biology');
  if (/ATP/.test(n.card.front)) assert.match(n.card.front, /!\[atp\.png\]\(data:image\/png;base64,/);

  // The vocabulary deck: studied with the same scheduler, written back in its own format.
  const v = await fc.next('v:German');
  assert.strictEqual(v.card.front, 'der Hund');
  await fc.answer('v:German', v.card.id, 'again');
  assert.match(fs.readFileSync(notes('Languages/German.md'), 'utf8'), /- \*\*der Hund\*\* — the dog <!-- srs due=\d{4}-\d{2}-\d{2} .*lapses=1 type=relearn/);

  await fc.editCard('f:capitals', first.card.id, { back: 'Paris!', tags: ['geo'] });
  assert.match(fs.readFileSync(notes('Flashcards/capitals.md'), 'utf8'), /France\n\?\nParis!/);
  await fc.setOptions('f:capitals', { scheduler: 'fsrs', newPerDay: 1 });
  const opts = (await fc.browse('f:capitals')).options;
  assert.deepStrictEqual([opts.scheduler, opts.newPerDay], ['fsrs', 1]);
  const ev = await fc.evidence();
  assert.deepStrictEqual(ev.map((d) => d.name), ['Biology', 'capitals', 'German']);
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
