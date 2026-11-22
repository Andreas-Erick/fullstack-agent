// The getting-started card's pure part: four things to try once (ask, add to the calendar, save a note,
// talk out loud), each ticked off when the user really does it, and the card gone for good once all four
// are done or the user hid it. No DOM, no storage: gettingstarted.js keeps the state in localStorage and
// draws the card; test/gettingstarted.test.js drives this module.

/** The steps in the order the card shows them. `example` goes into the message box on Try (none: a hint instead). */
export const STEPS = [
  { id: 'ask', title: 'Ask anything', text: 'A question, a plan, an explanation.', example: 'How can I use you?' },
  { id: 'event', title: 'Add to your calendar', text: 'Say it the way you would to a person.', example: 'Remind me Friday at 3 to call the dentist' },
  { id: 'note', title: 'Save a note', text: 'Ask here, or write one in Notes.', example: 'Save a note: ideas for the weekend' },
  { id: 'voice', title: 'Talk out loud', text: 'Hold the mic button and speak.', example: '' },
];

const IDS = STEPS.map((s) => s.id);

// Which event ticks which step. 'hide' is not a step: it puts the card away for good.
const EVENTS = { 'reply-done': 'ask', 'tool:calendar_add_event': 'event', 'note-saved': 'note', 'spoken-turn': 'voice' };

/** The state before anything happened: every step at 0 (not done), not hidden. */
export function initial() {
  return { ask: 0, event: 0, note: 0, voice: 0, hidden: 0 };
}

/** A stored state read back (anything else, damaged or missing, is the initial state). */
export function fromStored(raw) {
  const out = initial();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const k of [...IDS, 'hidden']) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/**
 * The state after `event` at time `now`. Each event ticks exactly its step, once (the first time is kept);
 * an event that changes nothing, or that isn't known, returns the same state object, so the host can tell
 * whether to save and redraw.
 */
export function step(state, event, now = Date.now()) {
  const s = state || initial();
  const key = event === 'hide' ? 'hidden' : Object.hasOwn(EVENTS, String(event)) ? EVENTS[event] : null;
  if (!key || s[key]) return s;
  return { ...s, [key]: now || 1 };
}

/** The card's progress: every step with whether (and when) it was done, and how many are done. */
export function progress(state) {
  const s = state || initial();
  const steps = STEPS.map((x) => ({ ...x, done: Boolean(s[x.id]), at: s[x.id] || 0 }));
  const done = steps.filter((x) => x.done).length;
  return { steps, done, total: STEPS.length, complete: done === STEPS.length };
}

/** Whether the card shows: not hidden and not every step done. */
export function visible(state) {
  const s = state || initial();
  return !s.hidden && !progress(s).complete;
}

/**
 * The event a finished tool call stands for, or null. The app's own tools come prefixed on the Claude Code
 * path (mcp__nexus__…, mcp__nexus_more__…). A call that failed counts for nothing; the assistant writing a
 * note (quick_note, vault_write_note) counts as a saved note, like the Notes view's own save.
 */
export function eventForTool(name, ok) {
  if (ok === false) return null;
  const bare = String(name || '').replace(/^mcp__nexus(?:_more)?__/, '');
  if (bare === 'calendar_add_event') return 'tool:calendar_add_event';
  if (bare === 'quick_note' || bare === 'vault_write_note') return 'note-saved';
  return null;
}
