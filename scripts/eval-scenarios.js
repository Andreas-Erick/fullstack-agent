// The scenario suite (npm run eval -- --suite scenarios): how six kinds of users really use the
// assistant (a STEM student, an engineering student, a tech worker, a language learner, a lifelong
// learner, a busy person) and constant persona switches, each case checked on what really happened.
//
// A scenario: { id, area, steps } where a step is
//   { ask, check, voice? }     a message in the scenario's one conversation, checked like a basic case
//   { persona: 'Name' }        the user switches persona in the app (persona.activate, as the title bar does)
// A case with one message may use { ask, check } directly. Dates are spelled out ("Thursday, 5 November")
// so no case depends on which weekday the suite runs on.

const { ymd, said, notSaid, usedAny, all, DONT_KNOW, dateWords } = require('./eval-cases');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const spoken = (d) => `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]}`;
const words = (text) => String(text).split(/\s+/).filter(Boolean).length;
const atMostWords = (n) => (r) => (words(r.text) <= n ? '' : `${words(r.text)} words (at most ${n})`);

/** The scenario world's dates, from `now`: one-off days that never fall on a weekday rule's day. */
function scenarioDates(now = new Date()) {
  const at = (n) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  const weekend = (from) => {
    let n = from;
    while (![0, 6].includes(at(n).getDay())) n++;
    return at(n);
  };
  return { today: at(0), tomorrow: at(1), sarah: at(2), freeze: at(3), dinner: at(4), grandma: at(6), labDue: at(7), exam: at(12), brunch: weekend(2), yesterday: at(-1) };
}

// The test personas: each addresses the user its own way, so who is speaking is checkable.
const PERSONAS = [
  {
    name: 'Professor Quill',
    address: /dear student/i,
    personality: 'You are Professor Quill, a kindly Victorian scholar of natural philosophy who now serves as a personal assistant. You speak in measured, slightly old-fashioned British English, love a precise definition, and are delighted by curiosity. Always address the user as "my dear student" at least once in every reply. Never use emoji.',
  },
  {
    name: 'Captain Vega',
    address: /\bensign\b/i,
    personality: 'You are Captain Vega, the calm commander of a deep-space exploration vessel, now serving as the user’s personal assistant. You speak crisply, in short confident sentences, with the occasional nautical or space metaphor. Always address the user as "Ensign" at least once in every reply. You are warm underneath the discipline.',
  },
  {
    name: 'Nova',
    address: /\bchamp\b/i,
    personality: 'You are Nova, an upbeat personal coach and assistant. You are energetic, encouraging and practical, and you keep things simple. Always address the user as "champ" at least once in every reply.',
  },
];
const persona = (name) => PERSONAS.find((p) => p.name === name);
const NOT_A_COSTUME = /costume|a role I play|character I play|I('m| am) (just |only )?(an AI|a language model|Claude|Siren)\b/i;

/** The reply is by `name`: its way of addressing the user, none of the others', never "a costume". */
function inCharacter(name) {
  const me = persona(name);
  const others = PERSONAS.filter((p) => p !== me);
  return all(
    said(me.address),
    ...others.map((o) => notSaid(o.address, `it addressed the user like ${o.name}`)),
    ...others.map((o) => notSaid(new RegExp(`\\bI(’|')?m ${o.name}|\\bI am ${o.name}|\\bmy name is ${o.name}`, 'i'), `it said it is ${o.name}`)),
    notSaid(NOT_A_COSTUME, 'it stepped out of character (costume, role, "just an AI")'),
  );
}
const whoAmI = (name) => all(said(new RegExp(name.split(' ').pop(), 'i')), inCharacter(name));

/** The scenario world, through the app's own modules (the formats are what the app writes). */
async function seedScenarios({ calendar, habits, memory, flashcards, vault, fs, path }, d) {
  // A student who also works part-time, learns Icelandic and has a full life.
  await calendar.add({ title: 'Linear Algebra lecture', when: 'every Monday, Wednesday 10:15-11:45', location: 'Hörsaal 2' });
  await calendar.add({ title: 'Control Systems lab', when: 'every Thursday 14:00-17:00' });
  await calendar.add({ title: 'Sprint planning', when: 'every Tuesday 09:30-10:30' });
  await calendar.add({ title: 'Thermodynamics exam', when: `${ymd(d.exam)} 09:00-11:00`, location: 'Audimax' });
  await calendar.add({ title: '1:1 with Sarah', when: `${ymd(d.sarah)} 11:00-11:30` });
  await calendar.add({ title: 'Call with the landlord', when: `${ymd(d.tomorrow)} 08:30-09:00` });
  await calendar.add({ title: 'Pick up dry cleaning', when: `${ymd(d.tomorrow)} 17:00-17:15` });
  await calendar.add({ title: 'Brunch with Tom', when: `${ymd(d.brunch)} 10:00-11:00` });
  await habits.add({ name: 'Icelandic practice', target: 7, note: '15 minutes' });
  await habits.add({ name: 'Gym', target: 3 });
  await habits.add({ name: 'Deep work', target: 5, note: '90-minute block' });
  await memory.save({ title: 'Studies', content: 'Erick studies mechanical engineering at TU Munich, 5th semester.', category: 'facts' });
  await memory.save({ title: 'Job', content: 'Erick works part-time as a backend developer at Finlytics (Python, PostgreSQL). His manager is Sarah Klein.', category: 'facts' });
  await memory.save({ title: 'Thesis', content: 'Erick’s bachelor thesis is about model predictive control (MPC) for quadcopter drones.', category: 'facts' });
  await memory.save({ title: 'Icelandic goal', content: 'Erick is learning Icelandic: level A2 now, goal B1 by next summer.', category: 'goals' });
  await memory.save({ title: 'Allergy', content: 'Erick is allergic to peanuts.', category: 'health' });
  await memory.save({ title: 'Explanations', content: 'Erick prefers explanations that start with a concrete example.', category: 'preferences' });
  await flashcards.addCards('Thermo', [
    { front: 'First law of thermodynamics', back: 'ΔU = Q − W' },
    { front: 'Carnot efficiency', back: 'η = 1 − T_c / T_h' },
  ]);
  await flashcards.addCards('Icelandic', [
    { front: 'kaffi', back: 'coffee' },
    { front: 'vatn', back: 'water' },
    { front: 'takk', back: 'thanks' },
  ]);
  const note = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(vault, rel)), { recursive: true });
    fs.writeFileSync(path.join(vault, rel), text);
  };
  note('Notes/Thermodynamics exam topics.md', '# Thermodynamics exam topics\n\n- First law and internal energy\n- Entropy and the second law\n- Carnot cycle and efficiency\n- Ideal gas processes (isothermal, adiabatic)\n- Rankine cycle\n');
  note('Notes/Control Systems Lab 3.md', '# Control Systems Lab 3: step response\n\nDC motor, unit step on the input at t = 0.\n\n| t (s) | output (V) |\n|---|---|\n| 0.0 | 0.00 |\n| 0.1 | 1.20 |\n| 0.2 | 2.10 |\n| 0.3 | 2.50 |\n| 0.4 | 2.30 |\n| 0.6 | 2.05 |\n| 1.0 | 2.00 |\n| 2.0 | 2.00 |\n\nSteady state 2.00 V. Report due one week after the lab.\n');
  note('Notes/Incident 2026-10-27.md', '# Incident 2026-10-27: payments API timeouts\n\n- 14:02 alerts: p99 latency 12 s on /payments\n- Cause: the database connection pool was exhausted; a new nightly export job held 40 connections open and never released them.\n- Fix: export job moved to a read replica, pool size alarm added.\n- Follow-up: load test the export job (owner: Erick).\n');
  note('Notes/Thinking, Fast and Slow.md', '# Thinking, Fast and Slow (Kahneman)\n\nMy takeaways:\n- System 1 is fast and intuitive, System 2 slow and effortful; most errors come from trusting System 1 where System 2 is needed.\n- Anchoring: the first number I hear drags my estimate toward it.\n- Loss aversion: losses feel about twice as strong as equal gains.\n');
}

function scenarios(d) {
  return [
    // ================================================================ STEM student
    { id: 'stem-explain', area: 'stem student', ask: 'Explain the Carnot efficiency in two or three sentences and give the formula.', check: all(said(/T_?\{?c\}?|T_?\{?C\}?|cold/i), said(/1\s*[-−–]|1 minus/i)) },
    { id: 'stem-compute', area: 'stem student', ask: 'A Carnot engine runs between 500 K and 300 K. What is its efficiency?', check: said(/\b40\s?%|\b0\.4\b|forty percent/i) },
    { id: 'stem-exam', area: 'stem student', ask: 'When is my thermodynamics exam, and what topics are on it?', check: all(said(dateWords(d.exam)), said(/entropy/i), said(/rankine/i)) },
    {
      id: 'stem-study-plan',
      area: 'stem student',
      ask: `Put three 90-minute study sessions for thermodynamics in my calendar before my exam on ${spoken(d.exam)}, in the evenings at 19:00, on days with no other evening plans.`,
      // Sessions, not entries: one repeat rule for three evenings is as good as three entries.
      check: async (r) => {
        const list = (await r.state.events(ymd(d.today), ymd(d.exam))).filter((x) => /thermo|study/i.test(x.title) && !/exam/i.test(x.title));
        if (list.length < 3) return `${list.length} study sessions before the exam (expected 3)`;
        const hm = (iso) => String(iso).slice(11, 16);
        const bad = list.find((x) => hm(x.start) !== '19:00' || hm(x.end) !== '20:30');
        return bad ? `a session is at ${bad.start}–${bad.end} (expected 19:00–20:30)` : '';
      },
    },
    {
      id: 'stem-cards',
      area: 'stem student',
      ask: 'Make three flashcards for my Thermo deck from my exam topics note, on topics the deck doesn’t cover yet.',
      check: async (r) => {
        const cards = await r.state.cards('Thermo');
        return cards.length >= 5 ? '' : `the Thermo deck has ${cards.length} cards (expected 2 + 3)`;
      },
    },
    {
      id: 'stem-quiz',
      area: 'stem student',
      steps: [
        { ask: 'Quiz me: one short question on the second law of thermodynamics. Just the question.', check: said(/\?/) },
        { ask: 'Heat flows by itself from a cold body to a hot body.', check: all(said(/\b(no|not|incorrect|wrong|actually|isn.?t|opposite|reverse|hot.{0,20}to.{0,20}cold)\b/i), notSaid(/^\s*(correct|right|exactly|yes)\b/i, 'it accepted a wrong answer')) },
      ],
    },
    // ================================================================ engineering student
    { id: 'eng-overshoot', area: 'engineering student', ask: 'From my Control Systems Lab 3 note: what is the percent overshoot of the step response?', check: said(/\b25\s?\\?%|25 percent|twenty-five percent/i) }, // 25 % or LaTeX 25\%
    { id: 'eng-units', area: 'engineering student', ask: 'Convert 3.5 bar to psi, rounded to one decimal.', check: said(/50\.8/) },
    { id: 'eng-code', area: 'engineering student', ask: 'Write a short Python function that returns the RMS value of a list of numbers.', check: all(said(/def\s+\w+\s*\(/), said(/sqrt|\*\*\s*0?\.5/)) },
    { id: 'eng-thesis', area: 'engineering student', ask: 'Remind me, what is my thesis about?', check: all(said(/model predictive control|\bMPC\b/i), said(/drone|quadcopter/i)) },
    {
      id: 'eng-deadline',
      area: 'engineering student',
      ask: `My Lab 3 report is due on ${spoken(d.labDue)} at 23:59. Put it in my calendar.`,
      check: async (r) => {
        const e = (await r.state.schedule()).find((x) => /report|lab 3/i.test(x.title));
        return e && e.date === ymd(d.labDue) ? '' : `no report deadline on ${ymd(d.labDue)} (${e ? e.date : 'none'})`;
      },
    },
    // ================================================================ tech worker
    { id: 'work-incident', area: 'tech worker', ask: 'In one sentence: what was the root cause of last week’s payments incident?', check: all(said(/connection pool|pool (was )?exhaust|held \d+ (database )?connections|connections open/i), atMostWords(80)) },
    { id: 'work-sql', area: 'tech worker', ask: 'Write a PostgreSQL query for the 5 customers with the highest total order amount. Tables: customers(id, name), orders(customer_id, amount).', check: all(said(/group by/i), said(/order by/i), said(/limit 5/i), said(/sum\s*\(/i)) },
    { id: 'work-next-1on1', area: 'tech worker', ask: 'When is my next 1:1 with Sarah?', check: all(said(dateWords(d.sarah)), said(/\b11(:00)?\b|eleven/i)) },
    { id: 'work-email', area: 'tech worker', ask: 'Draft a short email to my manager asking to move our next 1:1 by one day. Under 80 words, no subject line.', check: all(said(/sarah/i), atMostWords(110)) },
    {
      id: 'work-freeze',
      area: 'tech worker',
      ask: `Add a deploy freeze to my calendar from ${spoken(d.freeze)} at 18:00 until 08:00 the next morning.`,
      check: async (r) => {
        const e = (await r.state.schedule()).find((x) => /freeze/i.test(x.title));
        return e && e.date === ymd(d.freeze) && e.start === '18:00' ? '' : `no freeze at ${ymd(d.freeze)} 18:00 (${e ? `${e.date} ${e.start}` : 'none'})`;
      },
    },
    {
      id: 'work-remember',
      area: 'tech worker',
      ask: 'Remember that the on-call rotation switches every Monday at 9:00.',
      check: async (r) => ((await r.state.memories()).some((m) => /on.?call/i.test(`${m.title} ${m.content}`)) ? '' : 'nothing about on-call was saved'),
    },
    // ================================================================ language learner
    { id: 'lang-translate', area: 'language learner', ask: 'How do I say “I would like a coffee, please” in Icelandic?', check: said(/kaffi/i) },
    { id: 'lang-correct', area: 'language learner', ask: 'Correct my Icelandic and explain briefly: “Ég er að læra íslensku síðan tvö ár.”', check: said(/í tvö ár|hef (verið að )?læ?r/i) },
    {
      id: 'lang-vocab',
      area: 'language learner',
      ask: 'Add bók (book) and hús (house) to my Icelandic deck.',
      check: async (r) => {
        const fronts = (await r.state.cards('Icelandic')).map((c) => `${c.front} ${c.back}`).join(' | ');
        return /bók/i.test(fronts) && /hús/i.test(fronts) ? '' : `the Icelandic deck has: ${fronts.slice(0, 120)}`;
      },
    },
    { id: 'lang-habit', area: 'language learner', ask: 'I practised Icelandic for 20 minutes today.', check: async (r) => ((await r.state.habitDone('Icelandic practice')) ? '' : 'Icelandic practice is not checked off for today') },
    { id: 'lang-colours-de', area: 'language learner', ask: 'Kannst du mir drei isländische Wörter für Farben nennen?', check: all(said(/rauð|blá|græn|gul|svart|hvít/i), said(/\b(und|ist|rot|blau|grün|gelb|schwarz|weiß|Farbe)\b/i)) },
    { id: 'lang-goal', area: 'language learner', ask: 'What level am I aiming for in Icelandic, and by when?', check: all(said(/\bB1\b/), said(/summer/i)) },
    // ================================================================ lifelong learner
    { id: 'life-book', area: 'lifelong learner', ask: 'What were my main takeaways from Thinking, Fast and Slow?', check: all(said(/system 1|system one/i), said(/anchor/i)) },
    { id: 'life-eli12', area: 'lifelong learner', ask: 'Explain how mRNA vaccines work, like I’m 12, in under 100 words.', check: all(said(/protein|instruction|recipe|blueprint/i), atMostWords(130)) },
    { id: 'life-plan', area: 'lifelong learner', ask: 'Give me a 4-week plan to learn the basics of astronomy, one line per week.', check: all(said(/week\s*1|1\./i), said(/week\s*4|4\./i), atMostWords(220)) },
    {
      id: 'life-topic',
      area: 'lifelong learner',
      ask: 'I want to start learning the history of the Roman Republic. Start tracking it as a learning topic.',
      check: async (r) => ((await r.state.findNote(/roman/i)) ? '' : 'no learning topic note about Rome'),
    },
    { id: 'life-example-first', area: 'lifelong learner', ask: 'Explain what a derivative is, briefly.', check: said(/for example|e\.g\.|imagine|say you|speed|car|slope of/i) },
    // ================================================================ busy person
    { id: 'busy-tomorrow', area: 'busy person', ask: 'What does tomorrow look like?', check: all(said(/landlord/i), said(/dry cleaning/i)) },
    { id: 'busy-fit', area: 'busy person', ask: `Can I fit a 2-hour gym session on ${spoken(d.brunch)} between 9:00 and 13:00?`, check: all(said(/\b11(:00)?\b/), said(/brunch|tom/i)) },
    {
      id: 'busy-two',
      area: 'busy person',
      ask: `Dinner with my parents on ${spoken(d.dinner)} at 19:30, and remind me to buy flowers that afternoon at 15:00.`,
      check: async (r) => {
        const day = (await r.state.schedule()).filter((x) => x.date === ymd(d.dinner));
        const dinner = day.find((x) => /dinner|parents/i.test(x.title));
        const flowers = day.find((x) => /flower/i.test(x.title));
        if (!dinner || !flowers) return `on ${ymd(d.dinner)}: ${day.map((x) => `${x.start} ${x.title}`).join(', ') || 'nothing'}`;
        return dinner.start === '19:30' && flowers.start === '15:00' ? '' : `dinner ${dinner.start}, flowers ${flowers.start}`;
      },
    },
    { id: 'busy-allergy', area: 'busy person', ask: 'I’m ordering Thai food tonight. Anything I should keep in mind?', check: said(/peanut/i) },
    { id: 'busy-voice-week', area: 'busy person', voice: true, ask: 'Quick overview of my week, please.', check: all(atMostWords(130), notSaid(/\|.*\|/, 'a table in a spoken reply')) },
    { id: 'busy-unknown', area: 'busy person', ask: 'What’s my gym membership number?', check: all(said(DONT_KNOW), notSaid(/\b\d{5,}\b/, 'it made up a number')) },
    // ================================================================ persona switches
    {
      id: 'persona-roll-call',
      area: 'persona switches',
      steps: [
        { persona: 'Professor Quill' },
        { ask: 'Who are you?', check: whoAmI('Professor Quill') },
        { persona: 'Captain Vega' },
        { ask: 'Who are you?', check: whoAmI('Captain Vega') },
        { persona: 'Nova' },
        { ask: 'And who are you?', check: whoAmI('Nova') },
        { persona: 'Professor Quill' },
        { ask: 'Tell me about yourself in two sentences.', check: whoAmI('Professor Quill') },
      ],
    },
    {
      id: 'persona-rapid',
      area: 'persona switches',
      steps: [
        { persona: 'Captain Vega' },
        { ask: 'What is 12 times 12?', check: all(said(/144|hundred and forty-four|gross/i), inCharacter('Captain Vega')) },
        { persona: 'Nova' },
        { ask: 'What is the capital of Canada?', check: all(said(/ottawa/i), inCharacter('Nova')) },
        { persona: 'Professor Quill' },
        { ask: 'How many legs does a spider have?', check: all(said(/\b8\b|eight/i), inCharacter('Professor Quill')) },
        { persona: 'Captain Vega' },
        { ask: 'What is the boiling point of water at sea level in Celsius?', check: all(said(/100|hundred/i), inCharacter('Captain Vega')) },
        { persona: 'Nova' },
        { ask: 'Name one planet with rings.', check: all(said(/saturn|jupiter|uranus|neptune/i), inCharacter('Nova')) },
      ],
    },
    {
      id: 'persona-continuity',
      area: 'persona switches',
      steps: [
        { persona: 'Nova' },
        { ask: 'Just for this chat, no need to save it: my bike is the green one with the basket.', check: inCharacter('Nova') },
        { persona: 'Professor Quill' },
        { ask: 'Which bike is mine?', check: all(said(/green/i), inCharacter('Professor Quill')) },
      ],
    },
    {
      id: 'persona-shared-memory',
      area: 'persona switches',
      steps: [
        { persona: 'Captain Vega' },
        { ask: 'Remember that my favourite composer is Arvo Pärt.', check: async (r) => ((await r.state.memories()).some((m) => /p(ä|a)rt/i.test(m.content)) ? '' : 'nothing about Arvo Pärt was saved') },
        { persona: 'Nova' },
        { ask: 'Who is my favourite composer?', check: all(said(/p(ä|a)rt/i), inCharacter('Nova')) },
      ],
    },
    {
      id: 'persona-shared-calendar',
      area: 'persona switches',
      steps: [
        { persona: 'Professor Quill' },
        {
          ask: `Put “Call grandma” in my calendar on ${spoken(d.grandma)} at 18:00.`,
          check: async (r) => ((await r.state.schedule()).some((x) => /grandma/i.test(x.title) && x.date === ymd(d.grandma)) ? '' : `no call with grandma on ${ymd(d.grandma)}`),
        },
        { persona: 'Captain Vega' },
        { ask: `What’s in my calendar on ${spoken(d.grandma)}?`, check: all(said(/grandma/i), inCharacter('Captain Vega')) },
      ],
    },
    {
      id: 'persona-by-chat',
      area: 'persona switches',
      steps: [
        { persona: 'Nova' },
        { ask: 'Switch to Captain Vega, please.', check: usedAny('persona_switch') },
        { ask: 'Status report: what do I have tomorrow?', check: all(said(/landlord/i), inCharacter('Captain Vega')) },
      ],
    },
    {
      id: 'persona-no-costume',
      area: 'persona switches',
      steps: [
        { persona: 'Professor Quill' },
        { ask: 'Hello! How are you today?', check: inCharacter('Professor Quill') },
        { persona: 'Captain Vega' },
        { ask: 'Tell me about yourself.', check: whoAmI('Captain Vega') },
        { ask: 'Weren’t you a professor a minute ago?', check: all(inCharacter('Captain Vega'), notSaid(/\bI (was|am) (a |the )?professor/i, 'it took on the earlier persona')) },
      ],
    },
  ];
}

module.exports = { scenarios, seedScenarios, scenarioDates, PERSONAS };
