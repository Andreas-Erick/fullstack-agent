// Agent tools: flashcards (flashcards.js): decks in the vault scheduled like Anki, importing CSV and
// Anki files from the workspace folder, adding cards, quizzing the user in the chat.
const { arr, obj, str, int } = require('./common');

const GRADE = { type: 'string', enum: ['again', 'hard', 'good', 'easy'], description: 'Anki’s four buttons: again (forgot), hard, good, easy' };
const DECK = str('The deck id from flashcards_decks ("f:Biology" for a flashcard deck, "v:Spanish" for a vocabulary deck), or a deck name');

// A deck name the user said ("Biology") → its id, when there is one.
async function deckId(fc, ref) {
  const r = String(ref || '').trim();
  if (/^[fv]:/.test(r)) return r;
  const { decks } = await fc.decks();
  const hit = decks.find((d) => d.name.toLowerCase() === r.toLowerCase());
  if (!hit) throw new Error(`No deck called "${r}". Decks: ${decks.map((d) => `${d.name} (${d.id})`).join(', ') || 'none yet'}.`);
  return hit.id;
}

module.exports = [
  {
    name: 'flashcards_decks',
    group: 'learning',
    description: 'The user’s flashcard decks (the Flashcards view; vocabulary decks included) with Anki’s numbers: new, learning and due cards today, mature cards, the scheduler (sm2 or fsrs).',
    parameters: obj({}),
    run: async () => require('../flashcards').decks(),
  },
  {
    name: 'flashcards_import',
    group: 'learning',
    description:
      'Import flashcards from a file in the user’s workspace folder (or a folder they allowed): CSV or TSV (front, back, optional tags column; a header row is recognised), Anki’s “Notes in Plain Text” export (.txt), or an Anki package (.apkg / .colpkg: notes, card templates, cloze cards, images and sounds, and the schedule Anki had). Without a path it lists the files waiting there. Cards are added to the deck you name (or one named after the file); nothing is overwritten. Use it when the user asks to import their flashcards or an Anki deck.',
    parameters: obj({ path: str('The file: its name in the workspace folder, or a full path inside an allowed folder. Leave out to list importable files.'), deck: str('Optional: the deck to add them to (a new deck is created if it doesn’t exist)') }),
    run: async (a) => {
      const fc = require('../flashcards');
      if (!a.path) {
        const files = await fc.importable();
        return { files, note: files.length ? 'Ask which to import (or import the one they meant).' : 'No CSV, TSV, TXT or Anki files in the workspace folder. Ask the user to put the file there (Settings → Documents shows the folder).' };
      }
      return fc.importFile(a.path, { deck: a.deck || '' });
    },
  },
  {
    name: 'flashcards_add',
    group: 'learning',
    description: 'Add flashcards to a deck (created if new). Basic cards: front and back (Markdown, formulas in $…$). Cloze cards: write the text in front with {{c1::hidden part}} (one card per number) and leave back empty or put extra notes there. A front the deck already has is skipped. For words of a language the user practises, vocab_add keeps them in the language deck instead.',
    parameters: obj({ deck: str('Deck id or name'), cards: { type: 'array', items: obj({ front: str('Question, or cloze text'), back: str('Answer (optional for cloze)'), tags: arr('Optional tags') }, ['front']), description: 'The cards' } }, ['deck', 'cards']),
    run: async (a) => {
      const fc = require('../flashcards');
      const ref = String(a.deck || '').trim();
      const id = await deckId(fc, ref).catch(() => ref);
      return fc.addCards(id, (a.cards || []).slice(0, 500));
    },
  },
  {
    name: 'flashcards_next',
    group: 'learning',
    description: 'The next card to study in a deck, as Anki would show it (learning cards, then due reviews, then new cards within the daily limits), with what each button would do. To quiz the user in the chat: show only the front, let them answer, then reveal the back and grade with flashcards_answer.',
    parameters: obj({ deck: DECK }, ['deck']),
    run: async (a) => {
      const fc = require('../flashcards');
      const r = await fc.next(await deckId(fc, a.deck));
      return r.card ? r : { ...r, note: r.laterAt ? `Done for now; a learning card comes back at ${new Date(r.laterAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` : 'Nothing left in this deck today.' };
    },
  },
  {
    name: 'flashcards_answer',
    group: 'learning',
    description: 'Grade a card the user just answered (again / hard / good / easy, as they judge it or as you judge their answer, said aloud) and get the next one. The schedule follows the deck’s scheduler (Anki SM-2 or FSRS).',
    parameters: obj({ deck: DECK, card_id: str('The card id from flashcards_next'), grade: GRADE }, ['deck', 'card_id', 'grade']),
    run: async (a) => {
      const fc = require('../flashcards');
      return fc.answer(await deckId(fc, a.deck), a.card_id, a.grade);
    },
  },
  {
    name: 'flashcards_mixed',
    group: 'learning',
    description:
      'Mixed learning (interleaving): quiz across several decks at once, so each card comes without the context of the one before. action start (mode due: today’s due cards of every deck, scheduled as usual; mode all: every card shuffled, practice that changes no schedule; decks: optional ids or names, default all), then answer with the session id and a grade for the shown card, or next / undo. Show only the front, let the user answer, reveal the back, then grade. Use it for "mixed review", "quiz me on everything", "shuffle all my cards".',
    parameters: obj({ action: { type: 'string', enum: ['start', 'next', 'answer', 'undo'], description: 'start | next | answer | undo' }, mode: { type: 'string', enum: ['due', 'all'], description: 'For start: due (default) or all' }, decks: arr('For start: deck ids or names (default all)'), session: str('The session id from start'), grade: GRADE }, ['action']),
    run: async (a) => {
      const fc = require('../flashcards');
      if (a.action === 'start') return fc.mixStart({ mode: a.mode, decks: a.decks?.length ? await Promise.all(a.decks.map((d) => deckId(fc, d))) : null });
      if (!a.session) throw new Error('Give the session id from start.');
      if (a.action === 'answer') {
        if (!a.grade) throw new Error('Give a grade for the shown card.');
        return fc.mixAnswer(a.session, a.grade);
      }
      return a.action === 'undo' ? fc.mixUndo(a.session) : fc.mixNext(a.session);
    },
  },
  {
    name: 'flashcards_browse',
    group: 'learning',
    description: 'The cards in a deck (optionally matching a search), with each card’s state, due date, interval, ease and lapses; leeches (often forgotten cards) are marked.',
    parameters: obj({ deck: DECK, query: str('Optional search text'), limit: int('Max cards (default 100)') }, ['deck']),
    run: async (a) => {
      const fc = require('../flashcards');
      return fc.browse(await deckId(fc, a.deck), { query: a.query, limit: Math.min(500, a.limit || 100) });
    },
  },
  {
    name: 'flashcards_options',
    group: 'learning',
    description: 'Change a flashcard deck’s options as in Anki’s deck options: scheduler ("sm2" = Anki’s classic SM-2, "fsrs" = FSRS), newPerDay, reviewsPerDay, retention (FSRS desired retention, 0.7–0.99), learnSteps and relearnSteps (minutes, e.g. "1 10"), graduatingIvl, easyIvl, startingEase, easyBonus, hardIvl, ivlModifier, maxIvl, leechThreshold. Only when the user asks.',
    parameters: obj({ deck: DECK, options: { type: 'object', description: 'The options to set (null clears one back to the default)', additionalProperties: true } }, ['deck', 'options']),
    run: async (a) => {
      const fc = require('../flashcards');
      return fc.setOptions(await deckId(fc, a.deck), a.options || {});
    },
  },
];
