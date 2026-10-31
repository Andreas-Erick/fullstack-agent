// The assistant's judgement without a model call, over a corpus of real-sounding messages and replies:
// how much thought a message needs (pace.js), whether it is code work (engineering.js), what a local
// brain gets offered (localcore.js hints, read-only tools, hand-over), when a reply gave up or claimed an
// action no tool did, and which memories and notes a message is matched with (prompt.js sharesWord).
// Each table holds what people actually type and say; the comments name the bugs these caught. Add a
// line when a real conversation goes wrong. (The same, with real brains: npm run eval.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir } = require('./helpers');

stub({ electron: { app: { getPath: () => tmpDir('nexus-intel-'), getVersion: () => '0.0.0' } } });
const pace = load('main/pace.js');
const eng = load('main/engineering.js');
const core = load('main/localcore.js');
const { sharesWord } = load('main/prompt.js');

const each = (cases, fn, want) => {
  const wrong = cases.filter((c) => fn(c) !== want);
  assert.deepStrictEqual(wrong, [], `expected ${JSON.stringify(want)} for these`);
};
// Every tool the app has, by name and group, read from the tool files (no module loading needed).
const TOOLS = fs
  .readdirSync(path.join(ROOT, 'main/tools'))
  .filter((f) => f.endsWith('.js'))
  .flatMap((f) => [...fs.readFileSync(path.join(ROOT, 'main/tools', f), 'utf8').matchAll(/^\s+name: '([a-z_]+)',\s*\n\s+group: '([a-z_]+)'/gm)].map((m) => ({ name: m[1], group: m[2] })));

// ------------------------------------------------------------------ pace
test('pace: lookups in the user’s own things, small commands and small talk are quick', () => {
  each([
    'whats on my calendar today', 'any meetings this afternoon?', 'when is my dentist appointment?', 'do I have class on Monday?',
    'how many cards are due today?', 'show me my habits', 'what are my plans for the weekend?', 'do I have anything due this week?',
    'what time is it', 'what day is it', 'add gym tomorrow at 7', 'remind me to call mum at 6', 'log my run', 'check off reading',
    'mark meditation done', 'move my dentist appointment to Friday', 'delete the meeting on Tuesday', 'cancel lunch with Sam',
    'remember that I like oat milk', 'set a timer for 10 minutes', 'open the calendar', 'Remind me to water the plants every Sunday',
    'thanks!', 'thank you so much', 'good morning', 'hey', 'how are you?', 'how is it going', 'bye',
    'was steht morgen an?', 'erinnere mich an den Arzttermin', 'hab ich morgen Termine?',
    // Regressions: a phone keyboard's ’ made these "normal" (the patterns only knew ').
    'what’s on my schedule tomorrow?', 'What’s my next lecture?', 'how’s it going', 'When’s my exam?',
    // Regressions: a lookup with no schedule word, and "is my …".
    'what do I have tomorrow?', 'What do I have on Friday?', 'what do I have this afternoon', 'is my streak still alive?', 'are my cards due?',
  ], pace.classify, 'quick');
});

test('pace: understanding, planning, writing and code are deep', () => {
  each([
    'explain how photosynthesis works', 'why is the sky blue?', 'how does a transformer work?', 'compare React and Vue',
    'help me plan my week', 'should I take the job?', 'quiz me on biology', 'write an email to my landlord', 'summarize this article',
    'study plan for the physics exam', 'what should I study next?', 'erklär mir Integrale', 'walk me through the proof',
    'what are the pros and cons of renting?', 'brainstorm names for my podcast', 'fix the bug in the habits view',
    'the phone app doesnt sync properly', 'the app crashes when I open settings', 'write a python script to rename files',
    'is my essay good?', 'x'.repeat(1300),
  ], pace.classify, 'deep');
});

test('pace: the rest is normal, and a bare "yes" is never taken for small talk', () => {
  each([
    'ok', 'yes', 'yes do it', 'sounds good, go ahead', 'what is the capital of Peru?', 'what is entropy?', 'tell me a joke',
    'what is 15% of 80?', 'translate "good night" to German', 'what did we talk about yesterday?', 'I feel stressed about my exams',
    'can you make the font bigger?', 'what do I have to know about tax returns?', '',
    // Not a lookup of the user's own things despite the opener.
    'what are the events that led to WW1?', 'when is the next solar eclipse?',
  ], pace.classify, 'normal');
});

test('pace: what each pace changes', () => {
  const s = { llm: {} };
  assert.deepStrictEqual(pace.plan(s, { text: 'what’s on my calendar today?' }), { pace: 'quick', mode: 'fast', effort: 'low' });
  assert.deepStrictEqual(pace.plan(s, { text: 'explain eigenvalues', base: 'low' }), { pace: 'deep', mode: 'deep', effort: 'high' });
  assert.strictEqual(pace.plan(s, { text: 'tell me a joke' }).mode, 'normal');
  assert.strictEqual(pace.plan(s, { text: 'explain eigenvalues', voice: true }).mode, 'deep', 'voice alone changes nothing');
  assert.strictEqual(pace.plan({ llm: { voiceUsesFast: true } }, { text: 'explain eigenvalues', voice: true }).mode, 'fast');
  assert.strictEqual(pace.plan({ llm: { autoPace: false } }, { text: 'thanks' }).pace, 'off');
  assert.strictEqual(pace.plan(s, { text: 'thanks', setup: true }).pace, 'off');
  assert.strictEqual(pace.plan(s, { text: 'thanks', engineering: true }).pace, 'deep');
});

// ------------------------------------------------------------------ engineering
test('engineering: code and the app’s own trouble are engineering work', () => {
  each([
    'fix the bug in the habits view', 'the app crashes when I open settings', 'there is an error in the log', 'improve yourself',
    'add a new feature to show weather', 'write a python script to rename files', 'my code doesn’t work', 'my code doesn\'t work',
    'investigate why the voice is slow', 'what is a stack trace?', 'The voice is broken again', 'fix the calendar sync',
    'why does it crash on startup?', 'the phone app doesnt sync', 'the phone app doesn’t sync', 'notifications are not working',
    'the mic isn’t working', 'the vault won’t load', 'refactor the router', 'implement dark mode', 'change how you answer emails in your code',
    'the Android app won’t connect', 'Siren is broken', 'the face doesn\'t show',
  ], eng.isEngineeringTask, true);
});

test('engineering: everyday trouble is not (it was a 40-round deep turn, and went to Claude as code work)', () => {
  each([
    'I made an error in my essay', 'can you fix my sleep schedule?', 'my bike is broken', 'I want to fix my diet',
    'my phone screen is broken', 'there’s an error in my bank statement', 'help me fix my CV', 'my heart is broken',
    'explain recursion', 'what’s on my calendar today?', 'tell me a joke', 'remind me to call mom', 'how is the weather',
    'the dishwasher is not working', 'I found an error in your summary',
  ], eng.isEngineeringTask, false);
});

// ------------------------------------------------------------------ a reply that gave up without looking
test('gave up without looking: every way a model says it (then it is asked once to look)', () => {
  each([
    'I don’t have any information about Project Atlas.', 'I do not recall you mentioning that.', 'Let me check your calendar.',
    'I can’t find that in your notes.', 'I don’t know.', 'I have no record of that.', 'I can look that up for you if you like.',
    'Unfortunately, I don’t have access to your calendar.', 'I’m not sure what you mean by that — could you clarify?',
    // Regressions: these slipped through.
    'You haven’t told me yet.', 'I couldn’t find anything in your notes or memory about that.', 'Sorry, I have no idea.',
    'Hmm, that’s not something I know.', 'Should I look it up?', 'You haven\'t mentioned your sister\'s name.',
  ], core.gaveUpUnlooked, true);
});

test('gave up: an answer is not giving up, and a long reply is left alone', () => {
  each([
    'Your deadline for Project Atlas is Friday.', 'Canberra.', 'Your next lecture is Thermodynamics at 10:00 in H1.',
    'You have three habits left today: reading, stretching and Spanish.', 'I don’t think you have anything on Friday.',
    `I don't know ${'x'.repeat(400)}`,
  ], core.gaveUpUnlooked, false);
});

// ------------------------------------------------------------------ a reply that claims an action no tool did
test('claims an action: past, promised, or a bare "done" (checked when no tool changed anything)', () => {
  each([
    'I’ve added gym to your schedule for 7:00.', 'Done! Your run is logged.', 'Noted.', 'I added it.', 'I have scheduled your meeting.',
    'I’ve updated your priorities.', 'Logged!', 'Icelandic practice done.', 'Your workout is logged.',
    // Regressions: promises and confirmations that changed nothing.
    'I’ll add that now.', 'I will add it to your calendar.', 'Got it, saved.', 'Okay — logged.', 'All set — gym is on your calendar for tomorrow.',
    'That’s done.', 'I’ve set a reminder.', 'I will remember that.', 'Okay, I’ll remember that you like oat milk.', 'I\'ll go ahead and book it.',
  ], core.claimsAction, true);
});

test('claims an action: answers, offers and denials are not claims', () => {
  each([
    'Your dentist appointment is at 10:00.', 'Your dentist is scheduled for 10:00.', 'You added three cards yesterday.',
    'Would you like me to add it?', 'I can add that if you want.', 'I have not added anything yet.', 'I didn’t save it.',
    'Your reminder is set for 6 pm.', 'Reading is checked off for today.', 'Shall I schedule it?', 'The gym is open until 10.',
  ], core.claimsAction, false);
});

test('a question about the user’s own situation is not a request to change it', () => {
  each([
    'Can I fit a gym session in on Sunday?', 'Do I have time for lunch tomorrow?', 'Is there anything on Friday?', 'Should I move the dentist?',
    'Am I free at 3?', 'Did I log my run?', 'Have I done my reading today?', 'Do I need to study today?', 'Could we meet on Tuesday?',
  ], core.questionOnly, true);
  each([
    'Can you add gym on Sunday?', 'Add gym on Sunday', 'Can I fit a gym session in on Sunday? If so add it', 'Please log my run.',
    'Will it rain tomorrow?', 'Is my streak alive', 'Could you move the dentist to Friday?', '',
  ], core.questionOnly, false);
});

// ------------------------------------------------------------------ what a local brain gets offered
test('tool hints: the obvious group from the first round', () => {
  const personas = ['Captain Vega', 'Ada'];
  const cases = {
    'quiz me on my Spanish vocab': ['learning'],
    'every morning give me a briefing': ['routines'],
    'make a PDF of my notes': ['documents', 'notes'],
    'how is my reading streak?': ['habits'],
    'open the website of my university': ['browser'],
    'change your theme to purple': ['looks'],
    'open a pull request': ['github'],
    'run the summarize skill': ['skills'],
    'something is not working': ['diagnostics'],
    'what errors are in the log?': ['diagnostics'],
    'move my dentist appointment to Friday': ['calendar'],
    'reschedule the meeting': ['calendar'],
    'what do you remember about my sister?': ['memory'],
    'switch to Captain Vega': ['looks'],
    'can you change your voice to something deeper?': ['voice'],
    // Regression: "log" loaded the diagnostics tools for a workout (habit_log is an everyday tool).
    'log my workout': [],
    'log my run and my reading': [],
    'turn the volume down': [],
    'tell me a joke': [],
  };
  for (const [text, want] of Object.entries(cases)) assert.deepStrictEqual(core.hintGroups(text, { personas }), want, text);
});

test('the toolbox and the hints name real tool groups; the everyday tools exist', () => {
  assert.ok(TOOLS.length > 100, `read ${TOOLS.length} tools`);
  const groups = new Set(TOOLS.map((t) => t.group));
  for (const [box, list] of Object.entries(core.TOOLBOX)) for (const g of list) assert.ok(groups.has(g), `TOOLBOX.${box}: no tool group ${g}`);
  for (const box of ['learning', 'routines', 'documents', 'habits', 'browser', 'looks', 'github', 'skills', 'diagnostics', 'notes', 'calendar', 'memory', 'voice']) {
    assert.ok(core.TOOLBOX[box], `a hint names ${box}, which the toolbox does not have`);
  }
  const names = new Set(TOOLS.map((t) => t.name));
  for (const n of core.COMPACT_TOOLS) assert.ok(names.has(n), `everyday tool ${n} does not exist`);
  // Code changes, self-changes and connectors need the Claude brain: never offered to a local one.
  for (const g of Object.values(core.TOOLBOX).flat()) assert.ok(!['code', 'selfmod', 'connectors', 'engineering', 'engineering_run'].includes(g), g);
});

test('read-only tools: no tool that changes anything counts as one (a hand-over would run it twice)', () => {
  // Verbs that change something ("log" and "note" are also nouns: read_app_log, vault_read_note; those
  // writes are named below).
  const WRITE = /(^|_)(write|save|add|update|delete|remove|commit|push|change|edit|answer|switch|run|create|import|clone|set|start|open|close|move|grade|review|observe|reflect|simulate|pause|calibrate|design|permission|complete|configure|register|request|profile|lesson|practice|mixed|resident|act|restore|branch|pick|generate|check|scan|identify|hand)(_|$)/;
  const misread = TOOLS.filter((t) => (WRITE.test(t.name) || ['habit_log', 'daily_note_log', 'quick_note'].includes(t.name)) && core.isReadTool(t.name)).map((t) => t.name);
  assert.deepStrictEqual(misread, []);
  // …and the lookups are read-only, so a turn that only looked can still be handed over.
  const lookups = ['memory_search', 'memory_get', 'calendar_get_events', 'calendar_list_entries', 'vault_read_note', 'vault_search', 'vault_list_notes', 'vault_links',
    'habit_status', 'flashcards_decks', 'flashcards_next', 'flashcards_browse', 'web_search', 'web_fetch', 'app_guide', 'learning_overview', 'history_search', 'stream_recall',
    'skilltree_view', 'routine_list', 'persona_list', 'code_read_file', 'code_search', 'code_grep', 'code_map', 'code_outline', 'find_document', 'browser_read', 'browser_look',
    'skill_file', 'github_issues', 'github_pull_requests', 'github_read_file', 'diagnose', 'analyze_errors', 'look_at_screen', 'tools_more'];
  for (const n of lookups) {
    assert.ok(TOOLS.some((t) => t.name === n), `${n} is not a tool any more`);
    assert.ok(core.isReadTool(n), n);
  }
  for (const n of ['code_write_file', 'code_edit_file', 'github_change_file', 'github_create_pull_request', 'browser_act', 'self_change_commit', 'tasks_save', 'hand_over']) assert.ok(!core.isReadTool(n), n);
});

test('hand-over: a connected service by its whole name, code work, or a very long text', () => {
  const services = ['TickTick', 'Google Calendar', 'Notion', 'Gmail'];
  const cases = {
    'add this to TickTick': 'it needs TickTick',
    'what’s on my google calendar?': 'it needs Google Calendar',
    'what’s on my googlecalendar?': 'it needs Google Calendar',
    'check notion': 'it needs Notion',
    'send it via gmail': 'it needs Gmail',
    'I like ticks': '',
    'what’s on my calendar?': '',
    'remind me': '',
    'notional value of the bond': '',
  };
  for (const [text, want] of Object.entries(cases)) assert.strictEqual(core.handOverHint(text, { services }), want, text);
  assert.strictEqual(core.handOverHint('anything', { services, engineering: true }), 'code work');
  assert.strictEqual(core.handOverHint('x'.repeat(4001), { services }), 'a long text');
  assert.strictEqual(core.neededService('ab', ['ab']), '', 'too short to be a name');
});

// ------------------------------------------------------------------ which memories and notes a message meets
test('a message meets its memories, schedule entries and notes, in singular or plural', () => {
  const meets = [
    // Regressions: "es" was cut from every plural, so "lectures" never met "Lecture".
    ['When are my lectures?', 'Lecture: Thermodynamics'],
    ['what about my house?', 'Houses I looked at'],
    ['When are my classes?', 'Class schedule'],
    ['the dates', 'Date of the exam'],
    ['my studies', 'Study plan'],
    ['my address', 'Addresses'],
    ['Wann sind meine Termine?', 'Termin beim Arzt'],
    ['buses', 'bus'],
    ['What is my dog called?', 'Dog: Rex'],
    ['the incident', 'Incident report'],
    ['my thermodynamics exam', 'Thermodynamics exam (H1)'],
    ['Wie heißt meine Schwester?', 'Meine Schwester heißt Lena'],
    ['my Control Systems Lab 3 note', 'Control Systems Lab 3'],
    ['allergies', 'Allergy: peanuts'],
    ['Café on Friday', 'Cafe meetup'],
  ];
  for (const [q, t] of meets) assert.strictEqual(sharesWord(q, t), true, `${q} ⇄ ${t}`);
});

test('…but not through words that say nothing about which one is meant', () => {
  const apart = [
    ['my dog’s name', 'Sister: Lena'], // "name" matched every memory with a name in it
    ['what does she like', 'She likes tea'],
    ['who is that', 'Who to call: Sam'],
    ['tell me what you remember', 'Remember: passport renewal'],
    ['when is it', 'Lecture: Thermodynamics'],
    ['', 'anything'],
    ['abc', ''],
  ];
  for (const [q, t] of apart) assert.strictEqual(sharesWord(q, t), false, `${q} ⇄ ${t}`);
});
