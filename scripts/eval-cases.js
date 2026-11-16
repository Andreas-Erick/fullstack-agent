// The assistant's test set (scripts/eval.js): messages like the user's own, each checked on what really
// happened, the vault after the turn and the tools used, not only on the words of the reply.
// Every case starts from the same made-up vault (seed below), with dates relative to today.
//
// A case: { id, area, ask, check(r) } where r = { text, tools: [{ name, input, ok }], used(name...),
// state } and check returns '' (pass) or why it failed.

const DAY = 86400000;
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The dates the seed and the cases use, from `now`. */
function dates(now = new Date()) {
  const at = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  // The next Saturday at least two days away, so "tomorrow" and "Saturday" are never the same day.
  let sat = 2;
  while (at(sat).getDay() !== 6) sat++;
  const used = new Set([1, sat, 5]);
  const free = [3, 4, 6, 8].find((n) => !used.has(n));
  const lunch = [3, 4, 6, 8, 9].find((n) => !used.has(n) && n !== free);
  return {
    today: at(0),
    tomorrow: at(1),
    saturday: at(sat),
    team: at(5),
    free: at(free),
    lunch: at(lunch),
    in10: at(10),
    yesterday: at(-1),
  };
}

/** Fills a fresh vault through the app's own modules, so every format is what the app writes. */
async function seed({ calendar, memory, learning, vault, fs, path }, d) {
  await calendar.add({ title: 'Dentist (Dr. Weber)', when: `${ymd(d.tomorrow)} 10:00-11:00`, location: 'Lindenstraße 4' });
  await calendar.add({ title: 'Halloween party at Mia’s', when: `${ymd(d.saturday)} 19:00-24:00` });
  await calendar.add({ title: 'Team meeting', when: `${ymd(d.team)} 14:00-15:00` });
  await memory.save({ title: 'My sister', content: 'My sister’s name is Lena. She lives in Hamburg.', category: 'people' });
  await memory.save({ title: 'Coffee', content: 'Erick drinks his coffee black, no sugar.', category: 'preferences' });
  await learning.addCards('Spanish', [
    { front: 'casa', back: 'house' },
    { front: 'gato', back: 'cat' },
    { front: 'libro', back: 'book' },
    { front: 'agua', back: 'water' },
    { front: 'rojo', back: 'red' },
    { front: 'feliz', back: 'happy' },
  ]);
  fs.mkdirSync(path.join(vault, 'Notes'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'Notes', 'Project Atlas.md'), '# Project Atlas\n\nA dashboard for the robotics lab.\n\n- Deadline: 2026-11-20\n- Owner: Erick\n- Next step: send the draft to Prof. Kim.\n');
}

const said = (re) => (r) => (re.test(r.text) ? '' : `the reply doesn’t say ${re}`);
const notSaid = (re, why) => (r) => (re.test(r.text) ? why || `the reply says ${re}` : '');
const usedAny = (...names) => (r) => (r.used(...names) ? '' : `none of ${names.join(', ')} was used`);
const all = (...checks) => async (r) => {
  for (const c of checks) {
    const why = await c(r);
    if (why) return why;
  }
  return '';
};
const DONT_KNOW = /don.?t (know|have|seem)|do not (know|have|recall|possess|seem)|(have|has)( not|n.?t) (yet )?(told|mentioned|shared|said)|never (told|mentioned)|not (sure|certain)|haven.?t (told|mentioned|said)|no (record|memory|information|note)|can.?t find|couldn.?t find|didn.?t find|not (in|saved|recorded|stored)|isn.?t (explicitly )?(mentioned|listed|recorded|stored|saved|in)|unknown/i;
const NOTHING = /nothing|no (events?|appointments?|plans?|entries)|free|clear|empty|don.?t have anything|isn.?t anything|aren.?t any/i;
const weekday = (d) => WEEKDAYS[d.getDay()];
// A weekday a week or more away is named with its date: run on a Friday, the test Saturday is eight
// days away, and a plain "Saturday" means tomorrow.
const dayName = (d, now = new Date()) => {
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / DAY);
  return days >= 7 ? `${weekday(d)}, ${MONTHS[d.getMonth()]} ${d.getDate()}` : weekday(d);
};
// The day of the month as a reply may write it: 8, 8th, eighth ("the eighth of November" is right).
const ORDINALS = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty-first', 'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth', 'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first'];
const dateWords = (d) => {
  const month = `(${MONTHS[d.getMonth()]}|${MONTHS[d.getMonth()].slice(0, 3)})\\.?`;
  const day = `(${d.getDate()}(st|nd|rd|th)?|${ORDINALS[d.getDate()]})`;
  return new RegExp(`${month}\\s+(the\\s+)?${day}\\b|\\b${day}\\.?\\s+(of\\s+)?${month}|${ymd(d)}|\\b${d.getDate()}\\.\\s*${d.getMonth() + 1}\\.`, 'i');
};

function cases(d) {
  return [
    // ---- the schedule
    { id: 'cal-tomorrow', area: 'schedule', ask: 'What’s on my calendar tomorrow?', check: all(said(/dentist|dental|Dr\.? Weber/i), said(/10(:00)?|ten/i)) },
    { id: 'cal-saturday', area: 'schedule', ask: `Do I have anything planned on ${dayName(d.saturday)}?`, check: said(/halloween|party/i) },
    // Free, and no event of another day put on it. Mentioning the party the evening before as a tip is fine.
    {
      id: 'cal-free-day',
      area: 'schedule',
      ask: `Is anything scheduled on ${weekday(d.free)}, ${MONTHS[d.free.getMonth()]} ${d.free.getDate()}?`,
      check: all(said(NOTHING), notSaid(/\b(you have|there is|there's|scheduled:?)\s+(a\s+|the\s+|your\s+)?(dentist|team meeting)/i, 'it put an event of another day on it')),
    },
    {
      id: 'cal-add',
      area: 'schedule',
      ask: `Put lunch with Anna in my calendar on ${MONTHS[d.lunch.getMonth()]} ${d.lunch.getDate()} at 1 pm.`,
      check: async (r) => {
        const e = (await r.state.schedule()).find((x) => /anna/i.test(x.title));
        if (!e) return 'no entry with Anna in the schedule';
        return e.date === ymd(d.lunch) && e.start === '13:00' ? '' : `the entry is on ${e.date} ${e.start}, not ${ymd(d.lunch)} 13:00`;
      },
    },
    {
      id: 'cal-move',
      area: 'schedule',
      ask: 'Move my dentist appointment tomorrow to 11:30.',
      check: async (r) => {
        const list = (await r.state.schedule()).filter((x) => /dentist/i.test(x.title));
        if (list.length !== 1) return `${list.length} dentist entries (expected the one, moved)`;
        return list[0].start === '11:30' && list[0].date === ymd(d.tomorrow) ? '' : `the dentist is at ${list[0].date} ${list[0].start}`;
      },
    },
    {
      id: 'cal-evening',
      area: 'schedule',
      ask: `Add a movie night on ${MONTHS[d.free.getMonth()]} ${d.free.getDate()} from 21:00 to midnight.`,
      check: async (r) => {
        const e = (await r.state.schedule()).find((x) => /movie/i.test(x.title));
        return e && e.date === ymd(d.free) && e.start === '21:00' ? '' : `no movie night at ${ymd(d.free)} 21:00 (${e ? `${e.date} ${e.start}` : 'none'})`;
      },
    },
    // ---- memory
    {
      id: 'mem-save',
      area: 'memory',
      ask: 'Remember that my favourite food is ramen.',
      check: async (r) => ((await r.state.memories()).some((m) => /ramen/i.test(`${m.title} ${m.content}`)) ? '' : 'nothing about ramen was saved'),
    },
    { id: 'mem-recall', area: 'memory', ask: 'What’s my sister’s name, and where does she live?', check: all(said(/lena/i), said(/hamburg/i)) },
    { id: 'mem-unknown', area: 'memory', ask: 'What’s my dog’s name?', check: all(said(DONT_KNOW)) },
    // ---- vocabulary and notes (tools beyond the everyday ones for a local model)
    { id: 'vocab-count', area: 'learning', ask: 'How many words are in my Spanish vocabulary deck?', check: said(/\b6\b|six/i) },
    {
      id: 'vocab-add',
      area: 'learning',
      ask: 'Add a word to my Spanish deck: perro means dog.',
      check: async (r) => ((await r.state.vocab('Spanish')).some((c) => /perro/i.test(`${c.front} ${c.back}`)) ? '' : 'no card with perro in the deck'),
    },
    // A word that is in the deck, asked by its meaning, without giving the answer away.
    {
      id: 'vocab-quiz',
      area: 'learning',
      ask: 'Quiz me on one word from my Spanish deck: give me the English and I’ll answer in Spanish. Just the question.',
      check: all(said(/\b(house|cat|book|water|red|happy)\b/i), notSaid(/\b(casa|gato|libro|agua|rojo|feliz)\b/i, 'it gave the answer away')),
    },
    { id: 'note-read', area: 'notes', ask: 'When is the Project Atlas deadline?', check: all(said(/20/), said(/nov|11/i)) },
    {
      id: 'note-write',
      area: 'notes',
      ask: 'Write a note called Grocery list with milk, eggs and bread.',
      check: async (r) => {
        const n = await r.state.findNote(/grocery/i);
        return n ? (/eggs/i.test(n.text) ? '' : 'the note has no eggs') : 'no grocery note in the vault';
      },
    },
    // ---- small talk stays in character (run with --persona to judge the voice itself)
    { id: 'chat-evening', area: 'persona', ask: 'How are you this evening?', check: all(said(/\w{3,}/), notSaid(/functioning|as an ai\b|i'?m (just )?(an|a) (ai|assistant|language model)|how (can|may) i (help|assist)/i, 'a generic assistant reply')) },
    // ---- what it knows, and dates
    { id: 'know-capital', area: 'knowledge', ask: 'What’s the capital of Australia?', check: said(/canberra/i) },
    { id: 'know-math', area: 'knowledge', ask: 'What is 17 times 23?', check: said(/\b391\b|three hundred (and )?ninety-one/i) },
    { id: 'know-explain', area: 'knowledge', ask: 'Explain in two sentences why the sky is blue.', check: said(/scatter|rayleigh|wavelength/i) },
    { id: 'date-weekday', area: 'dates', ask: 'What day of the week is it today?', check: said(new RegExp(weekday(d.today), 'i')) },
    { id: 'date-plus10', area: 'dates', ask: 'What’s the date ten days from today?', check: said(dateWords(d.in10)) },
    // ---- several steps
    {
      id: 'multi-two',
      area: 'several steps',
      ask: 'What’s on my calendar tomorrow? And add “buy flowers for Mia” to my priorities.',
      check: all(said(/dentist/i), usedAny('priorities_update')),
    },
    {
      id: 'multi-plan',
      area: 'several steps',
      ask: `On ${dayName(d.saturday)} I want to go running at 9 in the morning, before the party in the evening. Put the run in my calendar.`,
      check: async (r) => {
        const e = (await r.state.schedule()).find((x) => /run/i.test(x.title));
        return e && e.date === ymd(d.saturday) && e.start === '09:00' ? '' : `no run at ${ymd(d.saturday)} 09:00 (${e ? `${e.date} ${e.start}` : 'none'})`;
      },
    },
    // ---- typed like on a phone (lower case, ’, no schedule word): the quick path must still look
    { id: 'phone-what-do-i-have', area: 'phone style', ask: 'what do i have tomorrow', check: all(said(/dentist|dental|Dr\.? Weber/i), said(/10(:00)?|ten/i)) },
    { id: 'phone-curly', area: 'phone style', ask: `what’s on for ${weekday(d.saturday).toLowerCase()}?`, check: said(/halloween|party|mia/i) },
    { id: 'phone-plural', area: 'phone style', ask: 'any appointments coming up this week?', check: said(/dentist|dental|Dr\.? Weber/i) },
    // ---- a question changes nothing; a request does it all (no claim without the tool)
    {
      id: 'q-fit-run',
      area: 'questions',
      ask: 'Can I fit a run in tomorrow morning?',
      check: all(said(/dentist|10(:00)?|ten/i), async (r) => ((await r.state.schedule()).some((x) => /run/i.test(x.title)) ? 'it booked a run when asked a question' : '')),
    },
    {
      id: 'mem-allergy',
      area: 'memory',
      ask: 'Remember that I’m allergic to peanuts.',
      check: async (r) => ((await r.state.memories()).some((m) => /peanut/i.test(`${m.title} ${m.content}`)) ? '' : 'nothing about peanuts was saved (a reply that says so is not enough)'),
    },
    { id: 'mem-unknown-plural', area: 'memory', ask: 'What are my kids’ names?', check: all(said(DONT_KNOW), notSaid(/\b(are|is) (named|called) [A-Z]|\bnames are [A-Z]/, 'it made names up')) },
    {
      id: 'vocab-add-two',
      area: 'learning',
      ask: 'Add two words to my Spanish deck: perro means dog, and verde means green.',
      check: async (r) => {
        const cards = await r.state.vocab('Spanish');
        const missing = ['perro', 'verde'].filter((w) => !cards.some((c) => new RegExp(w, 'i').test(`${c.front} ${c.back}`)));
        return missing.length ? `missing: ${missing.join(', ')}` : '';
      },
    },
    {
      id: 'multi-add-and-ask',
      area: 'several steps',
      ask: `Add dinner with Lena on ${MONTHS[d.free.getMonth()]} ${d.free.getDate()} at 7 pm, and tell me when my dentist appointment is.`,
      check: all(said(/10(:00)?|ten/i), async (r) => {
        const e = (await r.state.schedule()).find((x) => /dinner/i.test(x.title));
        return e && e.date === ymd(d.free) && e.start === '19:00' ? '' : `no dinner at ${ymd(d.free)} 19:00 (${e ? `${e.date} ${e.start}` : 'none'})`;
      }),
    },
    { id: 'note-owner', area: 'notes', ask: 'Who owns Project Atlas, and what’s the next step?', check: all(said(/erick|you\b/i), said(/kim|draft/i)) },
    // ---- harder work (with +handover, a local brain should pass these to Claude)
    { id: 'hard-code', area: 'harder work', ask: 'Write me a small Python script that renames every .jpg in a folder to the date it was taken.', check: all(said(/import\s+\w+|def\s+\w+\(/), said(/\.jpg|jpe?g/i)) },
    {
      id: 'hard-letter',
      area: 'harder work',
      ask: 'Write a polished cover letter, about 250 words, for a robotics internship at Bosch.',
      check: (r) => (r.text.split(/\s+/).length >= 180 && /bosch/i.test(r.text) ? '' : `${r.text.split(/\s+/).length} words${/bosch/i.test(r.text) ? '' : ', no Bosch'}`),
    },
    // ---- knowing when to ask
    { id: 'ask-unclear', area: 'asking', ask: 'Book it for me.', check: all(said(/\?/), (r) => (r.tools.some((t) => /add|save|write|update/.test(t.name)) ? `it acted without knowing what (${r.tools.map((t) => t.name).join(', ')})` : '')) },
    { id: 'lang-german', area: 'language', ask: 'Was steht morgen in meinem Kalender?', check: all(said(/zahnarzt|dentist|weber/i), said(/\b(du|dein|deinem|Sie|Ihr|Ihnen|morgen|um|hast|haben|ist|Uhr|Termin)\b/i)) }, // German, informal or formal
  ];
}

module.exports = { cases, seed, dates, ymd, said, notSaid, usedAny, all, DONT_KNOW, NOTHING, dateWords };
