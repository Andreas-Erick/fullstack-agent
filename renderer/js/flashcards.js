// Flashcards view (main/flashcards.js): the decks with Anki's three numbers (new, learning, due), a
// study screen (Space shows the answer, 1–4 grade it with what each button would do, U undoes, E edits,
// Esc goes back), browsing and editing a deck's cards, its options (Anki SM-2 or FSRS, daily limits,
// steps), and importing a file. Vocabulary decks from language learning are studied here too.
import { $, api, el, toast, toastError, renderMarkdown, modal, confirmDialog, promptDialog, on } from './util.js';
import { currentView, switchView } from './nav.js';
import { send } from './chat.js';

const GRADES = [
  ['again', 'Again', 'err'],
  ['hard', 'Hard', 'warn'],
  ['good', 'Good', 'ok'],
  ['easy', 'Easy', 'c2'],
];
let study = null; // { id, data, shown } while studying a deck

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
    body.replaceChildren(el('div', { class: 'fc-empty' }, el('p', {}, 'Flashcards live in your vault, as Markdown notes in Flashcards/. Set up the vault first.'), el('button', { class: 'btn', onclick: () => switchView('settings', 'obsidian') }, 'Set up the vault')));
    return;
  }
  const decks = r.decks;
  const total = decks.reduce((n, d) => n + d.dueNow, 0);
  body.replaceChildren(
    el('p', { class: 'muted' }, decks.length ? `${total ? `${total} card${total === 1 ? '' : 's'} to study today.` : 'Nothing due right now.'} Decks are notes in Flashcards/ in your vault, scheduled like Anki. Drop a CSV or Anki file into your workspace folder and ask her to import it, or use Import.` : ''),
    decks.length ? el('div', { class: 'fc-decks' }, ...decks.map(deckRow)) : emptyState(),
  );
}

function emptyState() {
  return el(
    'div',
    { class: 'fc-empty' },
    el('h3', { class: 'display' }, 'No decks yet'),
    el('p', {}, 'Create a deck, import a CSV or an Anki deck (.apkg), or ask: “Make me flashcards about the Krebs cycle.”'),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', onclick: newDeck }, '＋ New deck'), el('button', { class: 'btn', onclick: () => importFile() }, '📥 Import a file'), el('button', { class: 'btn', onclick: () => (switchView('chat'), send('Import the flashcards in my workspace folder.')) }, 'Ask her to import from the workspace')),
  );
}

const num = (n, cls, title) => el('span', { class: `fc-num ${cls}${n ? '' : ' zero'}`, title }, String(n));

function deckRow(d) {
  return el(
    'div',
    { class: 'fc-deck', tabindex: '0', role: 'button', 'aria-label': `${d.name}: ${d.new} new, ${d.learn} learning, ${d.review} due`, onclick: () => startStudy(d.id), onkeydown: (e) => e.key === 'Enter' && e.target === e.currentTarget && startStudy(d.id) },
    el('div', { class: 'fc-deck-main' }, el('b', {}, d.name), el('div', { class: 'hint' }, `${d.kind === 'vocab' ? '🗣 vocabulary · ' : ''}${d.total} cards · ${d.mature} mature · ${d.scheduler === 'fsrs' ? 'FSRS' : 'SM-2'}${d.studiedToday ? ` · ${d.studiedToday} studied today` : ''}${!d.dueNow && d.nextDue ? ` · next ${d.nextDue}` : ''}`)),
    el('div', { class: 'fc-nums' }, num(d.new, 'n', 'New'), num(d.learn, 'l', 'Learning'), num(d.review, 'r', 'Due')),
    el(
      'div',
      { class: 'row fc-deck-actions', onclick: (e) => e.stopPropagation() },
      el('button', { class: 'btn small', onclick: () => browse(d.id) }, 'Browse'),
      el('button', { class: 'btn small', onclick: () => addDialog(d.id, d.name) }, '＋ Card'),
      d.kind === 'flash' ? el('button', { class: 'btn small', title: 'Deck options', 'aria-label': `Options for ${d.name}`, onclick: () => optionsDialog(d.id) }, '⚙') : null,
    ),
  );
}

// ------------------------------------------------------------ studying
async function startStudy(id) {
  study = { id, data: null, shown: false };
  await load(() => api.flashcards.next(id));
}

async function load(fn) {
  try {
    study.data = await fn();
    study.shown = false;
  } catch (err) {
    toastError(err);
  }
  renderStudy();
}

function stopStudy() {
  study = null;
  refresh();
}

function renderStudy() {
  const body = $('#fcBody');
  const d = study.data;
  if (!d) return body.replaceChildren(el('p', { class: 'muted' }, 'Loading…'));
  const c = d.counts;
  const head = el(
    'div',
    { class: 'fc-study-head' },
    el('button', { class: 'btn small', onclick: stopStudy, title: 'Back to the decks (Esc)' }, '← Decks'),
    el('b', {}, d.name),
    el('div', { class: 'fc-nums', 'aria-label': `${c.new} new, ${c.learn} learning, ${c.review} due` }, num(c.new, 'n', 'New'), num(c.learn, 'l', 'Learning'), num(c.review, 'r', 'Due')),
    el('span', { class: 'hint' }, d.scheduler === 'fsrs' ? 'FSRS' : 'SM-2'),
    d.canUndo ? el('button', { class: 'btn small', onclick: undo, title: 'Undo the last answer (U)' }, '↶ Undo') : null,
  );
  if (!d.card) {
    const later = d.laterAt ? new Date(d.laterAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    body.replaceChildren(head, el('div', { class: 'fc-done glass' }, el('h3', { class: 'display' }, 'Congratulations!'), el('p', {}, later ? `You have finished this deck for now. A card in its learning steps comes back at ${later}.` : 'You have finished this deck for today.'), el('div', { class: 'row' }, el('button', { class: 'btn', onclick: stopStudy }, 'Back to the decks'), later ? el('button', { class: 'btn', onclick: () => load(() => api.flashcards.next(study.id)) }, 'Check again') : null)));
    return;
  }
  const card = d.card;
  const front = el('div', { class: 'fc-side fc-front', html: renderMarkdown(card.front) });
  const parts = [front];
  if (study.shown && card.back) parts.push(el('hr', { class: 'fc-hr' }), el('div', { class: 'fc-side fc-back', html: renderMarkdown(card.back) }));
  const tags = [card.leech ? '🩹 leech' : '', card.status === 'new' ? 'new' : card.status === 'learn' ? 'learning' : '', ...card.tags].filter(Boolean);
  const actions = study.shown
    ? el('div', { class: 'fc-grades' }, ...GRADES.map(([g, label, tone], i) => el('button', { class: `btn fc-grade ${tone}`, onclick: () => grade(g), title: `${label} (${i + 1})` }, el('small', {}, card.preview[g]), el('span', {}, label))))
    : el('div', { class: 'fc-grades' }, el('button', { class: 'btn primary fc-show', onclick: show, title: 'Show the answer (Space)' }, 'Show answer'));
  body.replaceChildren(
    head,
    el('div', { class: 'fc-card glass', 'aria-live': 'polite' }, tags.length ? el('div', { class: 'fc-tags' }, ...tags.map((t) => el('span', { class: 'chip' }, t))) : null, ...parts),
    actions,
    el('div', { class: 'row fc-card-tools' }, el('button', { class: 'btn small', onclick: () => editDialog(study.id, card) }, '✎ Edit (E)'), el('button', { class: 'btn small', onclick: () => suspend(card) }, 'Suspend')),
  );
  if (!study.shown) setTimeout(() => body.querySelector('.fc-show')?.focus(), 0);
}

function show() {
  if (!study?.data?.card) return;
  study.shown = true;
  renderStudy();
  // Sounds on the answer side play once, as in Anki.
  $('#fcBody .fc-back audio')?.play?.().catch(() => {});
}

const grade = (g) => study?.shown && study.data?.card && load(() => api.flashcards.answer(study.id, study.data.card.id, g));
const undo = () => study && load(() => api.flashcards.undo(study.id));

async function suspend(card) {
  await api.flashcards.edit(study.id, card.id, { suspended: true }).catch(toastError);
  toast('Card suspended: it stays in the deck but is not shown until you unsuspend it in Browse.');
  load(() => api.flashcards.next(study.id));
}

function onKey(e) {
  if (currentView !== 'cards' || !study || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '') || !$('#modal').classList.contains('hidden')) return;
  const k = e.key.toLowerCase();
  if ((k === ' ' || k === 'enter') && !study.shown) show();
  else if (study.shown && ['1', '2', '3', '4'].includes(k)) grade(GRADES[Number(k) - 1][0]);
  else if (k === ' ' && study.shown) grade('good');
  else if (k === 'u') undo();
  else if (k === 'e' && study.data?.card) editDialog(study.id, study.data.card);
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

async function importFile(deck = '') {
  try {
    const r = await api.flashcards.import(null, deck);
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
    }).then((changed) => changed && (study ? load(() => api.flashcards.next(study.id)) : refresh()));
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
