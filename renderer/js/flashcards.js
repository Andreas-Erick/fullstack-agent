// Flashcards view (main/flashcards.js): today at a glance (what is due across every deck, how far you
// got), the decks as tiles with Anki's three numbers (new, learning, due) and how mature they are, a
// study screen (Space shows the answer, 1–4 grade it with what each button would do, U undoes, E edits,
// Esc goes back), mixed learning across decks (interleaved due cards, or every card shuffled as
// practice: flashcards.js mixStart), browsing and editing a deck's cards, its options (Anki SM-2 or
// FSRS, daily limits, steps), and importing a file. Vocabulary decks from language learning are here too.
import { $, api, el, toast, toastError, renderMarkdown, modal, confirmDialog, promptDialog, on } from './util.js';
import { currentView, switchView } from './nav.js';
import { send } from './chat.js';

const GRADES = [
  ['again', 'Again', 'err'],
  ['hard', 'Hard', 'warn'],
  ['good', 'Good', 'ok'],
  ['easy', 'Easy', 'c2'],
];
// While studying: { mode: 'deck' | 'mix', id (deck id or session id), data, shown, answered }.
let study = null;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function initFlashcards() {
  $('#fcNewDeck').onclick = newDeck;
  $('#fcImport').onclick = () => importFile();
  on('vault-changed', (p) => currentView === 'cards' && !study && /^(Flashcards|Languages)\//.test(p || '') && refresh());
  document.addEventListener('keydown', onKey);
}

export async function refresh() {
  if (study) return renderStudy();
  const body = $('#fcBody');
  let r;
  try {
    r = await api.flashcards.decks();
  } catch (err) {
    body.replaceChildren(el('p', { class: 'muted' }, err.message));
    return;
  }
  if (!r.vault) {
    body.replaceChildren(el('div', { class: 'fc-empty' }, el('div', { class: 'fc-empty-icon', 'aria-hidden': 'true' }, '🗂'), el('h3', { class: 'display' }, 'Set up your vault first'), el('p', {}, 'Flashcards live in your vault, as Markdown notes in Flashcards/, readable in Obsidian.'), el('button', { class: 'btn primary', onclick: () => switchView('settings', 'obsidian') }, 'Set up the vault')));
    return;
  }
  const decks = r.decks;
  if (!decks.length) return body.replaceChildren(emptyState());
  body.replaceChildren(
    todayPanel(decks),
    el('div', { class: 'fc-section-head' }, el('h3', { class: 'display' }, 'Decks'), el('span', { class: 'hint' }, `${plural(decks.length, 'deck')} · ${plural(decks.reduce((n, d) => n + d.total, 0), 'card')}`)),
    el('div', { class: 'fc-decks' }, ...decks.map(deckTile), el('button', { class: 'fc-deck fc-deck-new', onclick: newDeck }, el('span', { class: 'fc-plus', 'aria-hidden': 'true' }, '＋'), el('b', {}, 'New deck'), el('span', { class: 'hint' }, 'or import a CSV / Anki file'))),
    el('p', { class: 'hint fc-foot' }, 'Decks are notes in Flashcards/ in your vault, scheduled like Anki. Drop a CSV or Anki file into your workspace folder and ask her to import it, or use Import.'),
  );
}

// Today: everything due across the decks, a ring for what is already done, and the two mixed modes.
function todayPanel(decks) {
  const sum = (k) => decks.reduce((n, d) => n + (d[k] || 0), 0);
  const due = sum('dueNow');
  const done = sum('studiedToday');
  const share = done + due ? done / (done + due) : 1;
  const ring = el('div', { class: 'fc-ring', style: { '--p': share.toFixed(3) }, role: 'img', 'aria-label': `${Math.round(share * 100)}% of today's cards done` }, el('b', {}, due ? String(due) : '✓'), el('small', {}, due ? 'to study' : 'all done'));
  const title = due ? `${plural(due, 'card')} waiting today` : done ? 'You are done for today' : 'Nothing due right now';
  const sub = due ? `${done ? `${done} studied so far. ` : ''}Mix them all: every card comes from another deck than the last.` : done ? `${plural(done, 'card')} studied. Shuffle everything for extra practice; it changes no schedule.` : 'Shuffle everything to practise without changing any schedule.';
  return el(
    'section',
    { class: 'fc-today glass' },
    ring,
    el(
      'div',
      { class: 'fc-today-main' },
      el('div', { class: 'fc-kicker' }, 'Today'),
      el('h3', { class: 'display' }, title),
      el('p', {}, sub),
      el('div', { class: 'fc-pills' }, pill(sum('new'), 'new', 'n'), pill(sum('learn'), 'learning', 'l'), pill(sum('review'), 'review', 'r')),
    ),
    el(
      'div',
      { class: 'fc-today-actions' },
      el('button', { class: 'btn primary fc-cta', disabled: !due, onclick: () => startMix('due'), title: 'Today’s due cards from every deck, interleaved' }, el('span', { 'aria-hidden': 'true' }, '🔀'), ' Mixed review'),
      el('button', { class: 'btn', onclick: () => mixDialog(decks), title: 'Every card, shuffled across decks, as practice' }, el('span', { 'aria-hidden': 'true' }, '🎲'), ' Shuffle everything…'),
    ),
  );
}

const pill = (n, label, cls) => el('span', { class: `fc-pill ${cls}${n ? '' : ' zero'}` }, el('b', {}, String(n)), ` ${label}`);
const num = (n, cls, title) => el('span', { class: `fc-num ${cls}${n ? '' : ' zero'}`, title }, String(n));

function emptyState() {
  return el(
    'div',
    { class: 'fc-empty' },
    el('div', { class: 'fc-empty-icon', 'aria-hidden': 'true' }, '🗂'),
    el('h3', { class: 'display' }, 'No decks yet'),
    el('p', {}, 'Create a deck, import a CSV or an Anki deck (.apkg), or just ask: “Make me flashcards about the Krebs cycle.”'),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: newDeck }, '＋ New deck'), el('button', { class: 'btn', onclick: () => importFile() }, '📥 Import a file'), el('button', { class: 'btn', onclick: () => (switchView('chat'), send('Import the flashcards in my workspace folder.')) }, 'Ask her to import from the workspace')),
  );
}

// A deck tile: name, kind, the three numbers with labels, a bar of how mature its cards are.
function deckTile(d) {
  const seen = d.total || 1;
  const bar = el(
    'div',
    { class: 'fc-mature', role: 'img', 'aria-label': `${d.mature} mature, ${d.young} young, ${d.unseen} not seen yet` },
    el('i', { class: 'm', style: { width: `${(d.mature / seen) * 100}%` } }),
    el('i', { class: 'y', style: { width: `${(d.young / seen) * 100}%` } }),
  );
  const when = d.dueNow ? `${d.dueNow} to study` : d.nextDue ? `Next review ${d.nextDue}` : 'Up to date';
  return el(
    'div',
    { class: `fc-deck${d.dueNow ? ' due' : ''}`, tabindex: '0', role: 'button', 'aria-label': `${d.name}: ${d.new} new, ${d.learn} learning, ${d.review} due`, onclick: () => startStudy(d.id), onkeydown: (e) => e.key === 'Enter' && e.target === e.currentTarget && startStudy(d.id) },
    el(
      'div',
      { class: 'fc-deck-top' },
      el('div', { class: 'fc-deck-main' }, el('b', {}, d.name), el('div', { class: 'hint' }, `${d.kind === 'vocab' ? 'Vocabulary · ' : ''}${plural(d.total, 'card')} · ${d.scheduler === 'fsrs' ? 'FSRS' : 'SM-2'}`)),
      el(
        'div',
        { class: 'fc-deck-actions', onclick: (e) => e.stopPropagation() },
        el('button', { class: 'icon-btn', title: 'Browse cards', 'aria-label': `Browse ${d.name}`, onclick: () => browse(d.id) }, '☰'),
        el('button', { class: 'icon-btn', title: 'Add a card', 'aria-label': `Add a card to ${d.name}`, onclick: () => addDialog(d.id, d.name) }, '＋'),
        d.kind === 'flash' ? el('button', { class: 'icon-btn', title: 'Deck options', 'aria-label': `Options for ${d.name}`, onclick: () => optionsDialog(d.id) }, '⚙') : null,
      ),
    ),
    el('div', { class: 'fc-counts' }, count(d.new, 'New', 'n'), count(d.learn, 'Learning', 'l'), count(d.review, 'Due', 'r')),
    bar,
    el('div', { class: 'fc-deck-foot' }, el('span', { class: 'hint' }, `${d.mature} mature${d.studiedToday ? ` · ${d.studiedToday} today` : ''}`), el('span', { class: `fc-when${d.dueNow ? ' on' : ''}` }, when)),
  );
}

const count = (n, label, cls) => el('div', { class: `fc-count ${cls}${n ? '' : ' zero'}` }, el('b', {}, String(n)), el('small', {}, label));

// ------------------------------------------------------------ mixed learning
function mixDialog(decks) {
  modal((box, close) => {
    let mode = 'all';
    const picks = decks.map((d) => ({ d, box: el('input', { type: 'checkbox', checked: true }) }));
    const option = (value, icon, title, text) => {
      const b = el('button', { class: `fc-mode${value === mode ? ' on' : ''}`, type: 'button', 'aria-pressed': String(value === mode), onclick: () => ((mode = value), box.querySelectorAll('.fc-mode').forEach((x) => (x.classList.toggle('on', x === b), x.setAttribute('aria-pressed', String(x === b)))), update()) }, el('span', { class: 'fc-mode-icon', 'aria-hidden': 'true' }, icon), el('b', {}, title), el('span', { class: 'hint' }, text));
      return b;
    };
    const go = el('button', { class: 'btn primary' }, 'Start');
    const update = () => {
      const chosen = picks.filter((p) => p.box.checked).map((p) => p.d);
      const n = chosen.reduce((s, d) => s + (mode === 'due' ? d.dueNow : d.total), 0);
      go.disabled = !n;
      go.textContent = n ? `Start · ${plural(n, 'card')}` : mode === 'due' ? 'Nothing due in these decks' : 'Pick a deck';
    };
    for (const p of picks) p.box.addEventListener('change', update);
    go.onclick = () => (close(true), startMix(mode, picks.filter((p) => p.box.checked).map((p) => p.d.id)));
    box.append(
      el('h3', { class: 'display' }, 'Mixed learning'),
      el('p', { class: 'muted' }, 'Cards from different decks, one after another: each answer has to come without the context of the last one. Harder in the moment, better remembered.'),
      el('div', { class: 'fc-modes' }, option('all', '🎲', 'Shuffle everything', 'Every card, in random order. Practice: no schedule changes.'), option('due', '🔀', 'Mixed review', 'Today’s due cards, interleaved. Counts for your schedule.')),
      el('div', { class: 'field' }, el('label', {}, 'Decks'), el('div', { class: 'fc-picks' }, ...picks.map((p) => el('label', { class: 'fc-pick' }, p.box, el('span', {}, p.d.name), el('small', { class: 'hint' }, `${p.d.total}`))))),
      el('div', { class: 'row', style: { justifyContent: 'flex-end' } }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), go),
    );
    update();
  });
}

async function startMix(mode, decks = null) {
  study = { mode: 'mix', id: null, data: null, shown: false, answered: 0 };
  renderStudy();
  try {
    study.data = await api.flashcards.mixStart({ mode, decks });
    study.id = study.data.session;
  } catch (err) {
    toastError(err);
    return stopStudy();
  }
  renderStudy();
}

// ------------------------------------------------------------ studying
async function startStudy(id) {
  study = { mode: 'deck', id, data: null, shown: false, answered: 0 };
  await load(() => api.flashcards.next(id));
}

// One request at a time (keys pressed quickly send one answer), and a reply that arrives after the user
// left the study screen (Esc) or started another session is dropped.
async function load(fn) {
  const s = study;
  if (!s || s.busy) return;
  s.busy = true;
  try {
    const data = await fn();
    if (study !== s) return;
    s.data = data;
    s.shown = false;
  } catch (err) {
    if (study === s) toastError(err);
  } finally {
    s.busy = false;
  }
  if (study === s) renderStudy();
}

const reload = () => study && load(() => (study.mode === 'mix' ? api.flashcards.mixNext(study.id) : api.flashcards.next(study.id)));

function stopStudy() {
  study = null;
  refresh();
}

// What the screen shows, whichever way we study: a deck, mixed due cards, or a shuffled practice round.
function viewModel(d) {
  const practice = study.mode === 'mix' && d.mode === 'all';
  const c = d.counts || {};
  const left = practice ? c.left || 0 : (c.new || 0) + (c.learn || 0) + (c.review || 0);
  const answered = practice ? d.stats?.answered || 0 : study.mode === 'mix' ? d.stats?.answered || 0 : study.answered;
  return {
    practice,
    title: study.mode === 'mix' ? (practice ? 'Shuffle everything' : 'Mixed review') : d.name,
    sub: study.mode === 'mix' ? `${plural(d.decks || 0, 'deck')}${practice ? ' · practice, no schedule changes' : ' · interleaved'}` : `${d.kind === 'vocab' ? 'Vocabulary · ' : ''}${d.scheduler === 'fsrs' ? 'FSRS' : 'SM-2'}`,
    deck: study.mode === 'mix' ? d.deck : { id: d.id, name: d.name },
    left,
    answered,
    right: d.stats?.right,
    progress: answered + left ? answered / (answered + left) : 1,
  };
}

function renderStudy() {
  const body = $('#fcBody');
  const d = study.data;
  if (!d) return body.replaceChildren(el('div', { class: 'fc-loading' }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Shuffling your cards…'));
  const vm = viewModel(d);
  const c = d.counts || {};
  const head = el(
    'div',
    { class: 'fc-study-head' },
    el('button', { class: 'btn small', onclick: stopStudy, title: 'Back to the decks (Esc)' }, '← Decks'),
    el('div', { class: 'fc-study-title' }, el('b', {}, vm.title), el('span', { class: 'hint' }, vm.sub)),
    vm.practice
      ? el('div', { class: 'fc-pills' }, el('span', { class: 'fc-pill r' }, el('b', {}, String(vm.left)), ' left'), vm.answered ? el('span', { class: 'fc-pill n' }, el('b', {}, `${Math.round(((vm.right || 0) / vm.answered) * 100)}%`), ' right') : null)
      : el('div', { class: 'fc-pills', 'aria-label': `${c.new} new, ${c.learn} learning, ${c.review} due` }, pill(c.new || 0, 'new', 'n'), pill(c.learn || 0, 'learning', 'l'), pill(c.review || 0, 'due', 'r')),
    d.canUndo ? el('button', { class: 'btn small', onclick: undo, title: 'Undo the last answer (U)' }, '↶ Undo') : null,
  );
  const progress = el('div', { class: 'fc-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(vm.progress * 100)), 'aria-label': 'Session progress' }, el('i', { style: { width: `${vm.progress * 100}%` } }));
  if (!d.card) return body.replaceChildren(head, progress, doneCard(d, vm));
  const card = d.card;
  const tags = [card.leech ? '🩹 leech' : '', ...card.tags].filter(Boolean);
  const status = { new: 'New', learn: 'Learning', due: 'Review', later: 'Review' }[card.status] || '';
  const sides = [el('div', { class: 'fc-side fc-front', html: renderMarkdown(card.front) })];
  if (study.shown && card.back) sides.push(el('div', { class: 'fc-divider' }, el('span', {}, 'Answer')), el('div', { class: 'fc-side fc-back', html: renderMarkdown(card.back) }));
  const actions = study.shown
    ? el('div', { class: 'fc-grades' }, ...GRADES.map(([g, label, tone], i) => el('button', { class: `fc-grade ${tone}`, onclick: () => grade(g), title: `${label} (${i + 1})` }, el('kbd', {}, String(i + 1)), el('span', {}, label), el('small', {}, card.preview[g]))))
    : el('div', { class: 'fc-grades' }, el('button', { class: 'btn primary fc-show', onclick: show, title: 'Show the answer (Space)' }, 'Show answer', el('kbd', {}, 'Space')));
  body.replaceChildren(
    head,
    progress,
    el(
      'article',
      { class: `fc-card glass${study.shown ? ' revealed' : ''}`, 'aria-live': 'polite' },
      el(
        'header',
        { class: 'fc-card-top' },
        study.mode === 'mix' && vm.deck ? el('span', { class: 'fc-from' }, vm.deck.name) : el('span'),
        el('span', { class: 'fc-card-meta' }, ...tags.map((t) => el('span', { class: 'chip' }, t)), status ? el('span', { class: `fc-status ${card.status}` }, status) : null),
      ),
      el('div', { class: 'fc-sides' }, ...sides),
      el('footer', { class: 'fc-card-tools' }, el('button', { class: 'icon-btn', title: 'Edit this card (E)', 'aria-label': 'Edit this card', onclick: () => editDialog(vm.deck.id, card) }, '✎'), el('button', { class: 'icon-btn', title: 'Suspend: keep it, but stop showing it', 'aria-label': 'Suspend this card', onclick: () => suspend(vm.deck.id, card) }, '⏸')),
    ),
    actions,
    el('p', { class: 'hint fc-keys' }, el('kbd', {}, 'Space'), ' answer · ', el('kbd', {}, '1'), '–', el('kbd', {}, '4'), ' grade · ', el('kbd', {}, 'U'), ' undo · ', el('kbd', {}, 'E'), ' edit · ', el('kbd', {}, 'Esc'), ' back'),
  );
  if (!study.shown) setTimeout(() => body.querySelector('.fc-show')?.focus(), 0);
}

function doneCard(d, vm) {
  const later = d.laterAt ? new Date(d.laterAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const stats = vm.answered ? el('div', { class: 'fc-done-stats' }, el('div', {}, el('b', {}, String(vm.answered)), el('small', {}, 'answered')), vm.right != null ? el('div', {}, el('b', {}, `${Math.round((vm.right / vm.answered) * 100)}%`), el('small', {}, 'right')) : null) : null;
  const text = vm.practice ? 'You went through every card. Your schedules are unchanged.' : later ? `Done for now. A card in its learning steps comes back at ${later}.` : study.mode === 'mix' ? 'Every deck you mixed is done for today.' : 'You have finished this deck for today.';
  return el(
    'div',
    { class: 'fc-done glass' },
    el('div', { class: 'fc-done-icon', 'aria-hidden': 'true' }, '✦'),
    el('h3', { class: 'display' }, vm.answered ? 'Well done' : 'All caught up'),
    stats,
    el('p', {}, text),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: stopStudy }, 'Back to the decks'), later ? el('button', { class: 'btn', onclick: reload }, 'Check again') : null, !vm.practice ? el('button', { class: 'btn', onclick: () => startMix('all') }, '🎲 Shuffle everything') : null),
  );
}

function show() {
  if (!study?.data?.card) return;
  study.shown = true;
  renderStudy();
  // Sounds on the answer side play once, as in Anki.
  $('#fcBody .fc-back audio')?.play?.().catch(() => {});
}

function grade(g) {
  if (!study?.shown || !study.data?.card || study.busy) return;
  const { id, mode } = study;
  const cardId = study.data.card.id;
  study.answered++;
  load(() => (mode === 'mix' ? api.flashcards.mixAnswer(id, g, cardId) : api.flashcards.answer(id, cardId, g)));
}

function undo() {
  if (!study || study.busy || !study.data?.canUndo) return;
  const { id, mode } = study;
  study.answered = Math.max(0, study.answered - 1);
  load(() => (mode === 'mix' ? api.flashcards.mixUndo(id) : api.flashcards.undo(id)));
}

async function suspend(deckId, card) {
  await api.flashcards.edit(deckId, card.id, { suspended: true }).catch(toastError);
  toast('Card suspended: it stays in the deck but is not shown until you unsuspend it in Browse.');
  reload();
}

function onKey(e) {
  if (currentView !== 'cards' || !study || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || !$('#modal').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if ((k === ' ' || k === 'enter') && !study.shown) show();
  else if (study.shown && ['1', '2', '3', '4'].includes(k)) grade(GRADES[Number(k) - 1][0]);
  else if (k === ' ' && study.shown) grade('good');
  else if (k === 'u') undo();
  else if (k === 'e' && study.data?.card) editDialog(viewModel(study.data).deck.id, study.data.card);
  else if (k === 'escape') stopStudy();
  else return;
  e.preventDefault();
}

// ------------------------------------------------------------ decks, cards, options, import
async function newDeck() {
  const name = await promptDialog('Name of the new deck', '');
  if (!name) return;
  try {
    const r = await api.flashcards.create(name);
    toast(r.created ? `Deck “${name}” created.` : `“${name}” already exists.`);
    await refresh();
    addDialog(r.id, name);
  } catch (err) {
    toastError(err);
  }
}

const SKIP_FIRST_KEY = 'fc.import.skipFirst';

// Choose the options, then the file. The first-line option applies to CSV, TSV and text files.
function importFile(deck = '') {
  let remembered = false;
  try {
    remembered = localStorage.getItem(SKIP_FIRST_KEY) === '1';
  } catch {}
  modal((box, close) => {
    const skip = el('input', { type: 'checkbox', checked: remembered });
    const choose = async () => {
      try {
        localStorage.setItem(SKIP_FIRST_KEY, skip.checked ? '1' : '0');
      } catch {}
      close(true);
      await runImport(deck, { skipFirst: skip.checked });
    };
    box.append(
      el('h3', { class: 'display' }, 'Import flashcards'),
      el('p', { class: 'hint' }, 'CSV, TSV or text files (front, back, optional tags), or Anki packages (.apkg, .colpkg).'),
      el('label', { class: 'fc-pick wrap' }, skip, el('span', {}, 'Skip the first line: it only names the columns'), el('small', { class: 'hint' }, 'CSV · TSV · TXT')),
      el('p', { class: 'hint' }, 'A first line like “Front, Back” is recognised and skipped either way.'),
      el('div', { class: 'row', style: { justifyContent: 'flex-end' } }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), el('button', { class: 'btn primary', onclick: choose }, 'Choose file…')),
    );
  });
}

async function runImport(deck, opts) {
  try {
    const r = await api.flashcards.import(null, deck, opts);
    if (!r) return;
    toast(`📥 ${r.added} card${r.added === 1 ? '' : 's'} imported into “${r.name}”${r.media ? ` with ${r.media} media file${r.media === 1 ? '' : 's'}` : ''}${r.skipped ? ` (${r.skipped} skipped: empty or already there)` : ''}.`);
    if (r.note) toast(r.note);
    refresh();
  } catch (err) {
    toastError(err);
  }
}

function cardFields(card = {}) {
  const front = el('textarea', { class: 'input', rows: '4', placeholder: 'Front: a question, or cloze text like “The {{c1::nucleus}} holds the DNA”' });
  front.value = card.front || '';
  const back = el('textarea', { class: 'input', rows: '4', placeholder: 'Back (Markdown; formulas in $…$; images as ![[file.png]])' });
  back.value = card.back || '';
  const tags = el('input', { class: 'input', placeholder: 'Tags, separated by spaces' });
  tags.value = (card.tags || []).filter((t) => t !== 'leech').join(' ');
  return { front, back, tags, value: () => ({ front: front.value, back: back.value, tags: tags.value.split(/\s+/).filter(Boolean) }) };
}

function addDialog(id, name) {
  modal((card, close) => {
    const f = cardFields();
    const add = async (again) => {
      const v = f.value();
      if (!v.front.trim()) return f.front.focus();
      try {
        const r = await api.flashcards.add(id, [v]);
        toast(r.added ? 'Card added.' : 'That card is already in the deck.');
        if (!again) return close(true), refresh();
        f.front.value = '';
        f.back.value = '';
        f.front.focus();
      } catch (err) {
        toastError(err);
      }
    };
    card.append(
      el('h3', { class: 'display' }, `Add to ${name}`),
      el('div', { class: 'field' }, el('label', {}, 'Front'), f.front),
      el('div', { class: 'field' }, el('label', {}, 'Back'), f.back),
      el('div', { class: 'field' }, el('label', {}, 'Tags'), f.tags),
      el('div', { class: 'row', style: { justifyContent: 'flex-end' } }, el('button', { class: 'btn', onclick: () => (close(null), refresh()) }, 'Done'), el('button', { class: 'btn', onclick: () => add(true) }, 'Add another'), el('button', { class: 'btn primary', onclick: () => add(false) }, 'Add')),
    );
    setTimeout(() => f.front.focus(), 0);
  });
}

function editDialog(id, card) {
  if (id.startsWith('v:')) return toast('Vocabulary cards are edited in their note (Languages/ in the vault), or ask her to.');
  // The card as written in the note (cloze markers and ![[media]] included), not as shown while studying.
  return api.flashcards.card(id, card.id).then((full) => {
    modal((box, close) => {
      const f = cardFields(full);
      box.append(
        el('h3', { class: 'display' }, 'Edit card'),
        el('div', { class: 'field' }, el('label', {}, 'Front'), f.front),
        el('div', { class: 'field' }, el('label', {}, 'Back'), f.back),
        el('div', { class: 'field' }, el('label', {}, 'Tags'), f.tags),
        el(
          'div',
          { class: 'row', style: { justifyContent: 'space-between', flexWrap: 'wrap' } },
          el('div', { class: 'row' }, el('button', { class: 'btn small danger', onclick: async () => (await confirmDialog('Delete card', 'Delete this card and its history?', 'Delete')) && (await api.flashcards.edit(id, card.id, { remove: true }).catch(toastError), close(true)) }, 'Delete'), el('button', { class: 'btn small', onclick: async () => (await confirmDialog('Forget card', 'Start this card over as new?', 'Forget', false)) && (await api.flashcards.edit(id, card.id, { reset: true }).catch(toastError), close(true)) }, 'Forget')),
          el('div', { class: 'row' }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), el('button', { class: 'btn primary', onclick: async () => (await api.flashcards.edit(id, card.id, f.value()).catch(toastError), close(true)) }, 'Save')),
        ),
      );
    }).then((changed) => changed && (study ? reload() : refresh()));
  }, toastError);
}

async function browse(id) {
  let data;
  try {
    data = await api.flashcards.browse(id, { limit: 2000 });
  } catch (err) {
    return toastError(err);
  }
  modal((box, close) => {
    box.classList.add('wide');
    const search = el('input', { class: 'input', type: 'search', placeholder: 'Search cards and tags', 'aria-label': 'Search cards' });
    const list = el('div', { class: 'fc-browse' });
    const STATUS = { new: 'new', learn: 'learning', due: 'due', later: 'review', suspended: 'suspended' };
    const draw = () => {
      const q = search.value.toLowerCase().trim();
      const cards = data.cards.filter((c) => !q || `${c.front} ${c.back} ${c.tags.join(' ')}`.toLowerCase().includes(q));
      list.replaceChildren(
        ...cards.slice(0, 400).map((c) =>
          el(
            'div',
            { class: `fc-brow ${c.suspended ? 'off' : ''}` },
            el('div', { class: 'fc-brow-text' }, el('b', {}, c.front.replace(/\n/g, ' ').slice(0, 160)), el('div', { class: 'hint' }, c.back.replace(/\n/g, ' ').slice(0, 160))),
            el('span', { class: 'chip' }, STATUS[c.status] || c.status),
            el('span', { class: 'hint fc-brow-meta' }, c.reps ? `${c.ivl}d · ${Math.round((c.ease || 2.5) * 100)}% · ${c.lapses} lapses${c.leech ? ' · leech' : ''}` : '—'),
            data.kind === 'flash'
              ? el('div', { class: 'row' }, el('button', { class: 'btn small', onclick: () => (close(null), editDialog(id, c)) }, 'Edit'), el('button', { class: 'btn small', onclick: async () => (await api.flashcards.edit(id, c.id, { suspended: !c.suspended }).catch(toastError), (c.suspended = !c.suspended), (c.status = c.suspended ? 'suspended' : c.status), draw()) }, c.suspended ? 'Unsuspend' : 'Suspend'))
              : null,
          ),
        ),
        cards.length > 400 ? el('p', { class: 'muted' }, `and ${cards.length - 400} more: search to narrow it down.`) : '',
      );
    };
    search.addEventListener('input', draw);
    box.append(el('h3', { class: 'display' }, `${data.name} · ${data.total} cards`), el('p', { class: 'hint' }, `In your vault: ${data.path}`), search, list, el('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '10px' } }, data.kind === 'flash' ? el('button', { class: 'btn danger small', onclick: async () => (await confirmDialog('Delete deck', `Move “${data.name}” to the vault’s trash?`, 'Delete')) && (await api.flashcards.delete(id).catch(toastError), close(null), refresh()) }, 'Delete deck') : null, el('button', { class: 'btn', onclick: () => close(null) }, 'Close')));
    draw();
    setTimeout(() => search.focus(), 0);
  }).then(() => refresh());
}

function optionsDialog(id) {
  api.flashcards.browse(id, { limit: 1 }).then((b) => {
    const o = b.options;
    modal((box, close) => {
      const sched = el('select', { class: 'input' }, el('option', { value: 'sm2' }, 'Anki SM-2 (classic)'), el('option', { value: 'fsrs' }, 'FSRS (Anki’s newer scheduler)'));
      sched.value = o.scheduler;
      const field = (label, value, hint) => {
        const input = el('input', { class: 'input', value: String(value) });
        return { input, node: el('div', { class: 'field' }, el('label', {}, label), input, hint ? el('div', { class: 'hint' }, hint) : '') };
      };
      const f = {
        newPerDay: field('New cards per day', o.newPerDay),
        reviewsPerDay: field('Maximum reviews per day', o.reviewsPerDay),
        learnSteps: field('Learning steps (minutes)', o.learnSteps.join(' '), 'Anki’s default: 1 10'),
        relearnSteps: field('Relearning steps (minutes)', o.relearnSteps.join(' ')),
        retention: field('Desired retention (FSRS)', o.retention, 'How likely you remember a card when it comes back: 0.9 is Anki’s default. Higher means more reviews.'),
        graduatingIvl: field('Graduating interval (days)', o.graduatingIvl),
        easyIvl: field('Easy interval (days)', o.easyIvl),
        startingEase: field('Starting ease', o.startingEase),
        maxIvl: field('Maximum interval (days)', o.maxIvl),
      };
      box.append(
        el('h3', { class: 'display' }, `${b.name}: options`),
        el('div', { class: 'field' }, el('label', {}, 'Scheduler'), sched, el('div', { class: 'hint' }, 'Both work like Anki. FSRS models your memory and usually needs fewer reviews for the same retention; switching keeps every card’s history.')),
        el('div', { class: 'fc-opts' }, ...Object.values(f).map((x) => x.node)),
        el('div', { class: 'row', style: { justifyContent: 'flex-end' } }, el('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'), el('button', { class: 'btn primary', onclick: async () => {
          const opts = { scheduler: sched.value, ...Object.fromEntries(Object.entries(f).map(([k, x]) => [k, x.input.value.trim()])) };
          try {
            await api.flashcards.options(id, opts);
            toast('Options saved.');
            close(true);
            refresh();
          } catch (err) {
            toastError(err);
          }
        } }, 'Save')),
      );
    });
  }, toastError);
}
