// The pure wording of the title-bar lights (app.js setPill, usage.js): the assistant (brain), voice,
// calendar, notes library and Claude plan usage. A red or amber light says in one plain sentence what is
// wrong and ends with "Click to fix." (the click opens the right settings card, app.js pillTargets). Raw
// errors, addresses, file names and product names never show here: Settings → Health has them. The Remote
// pill keeps remotecore.js pillState. Tested in test/statuscore.test.js.

export const NAMES = { brain: 'Assistant', voice: 'Voice', calendar: 'Calendar', notes: 'Notes library', usage: 'Claude plan usage' };

const FIX = ' Click to fix.';
const count = (n) => (Number.isFinite(n) && n >= 0 ? Math.round(n) : null);

// [level, text or (detail) => text]. Levels: 'ok', '' (off, no colour), 'warn', 'err'.
const WORDS = {
  brain: {
    ready: ['ok', 'The assistant is ready.'],
    partial: ['warn', 'The assistant works, but has no backup if it hits a limit.'],
    unchecked: ['warn', 'The assistant’s sign-in couldn’t be checked.'],
    noModel: ['warn', 'The assistant has no model picked yet.'],
    missing: ['err', 'The assistant isn’t set up on this computer yet.'],
    signedOut: ['err', 'The assistant isn’t signed in.'],
    noKey: ['err', 'The assistant needs a key to work.'],
    unreachable: ['err', 'The assistant can’t think right now.'],
  },
  voice: {
    ready: ['ok', 'Voice is working.'],
    off: ['', 'Voice is turned off.'],
    failed: ['err', 'Voice isn’t working right now.'],
    noKey: ['err', 'Voice needs a key to work.'],
    unreachable: ['err', 'Voice isn’t working right now.'],
  },
  calendar: {
    ready: ['ok', 'Your calendar is ready.'],
    off: ['', 'The calendar is turned off.'],
    unreadable: ['warn', 'Your schedule couldn’t be read.'],
    problems: ['warn', 'Some calendar entries couldn’t be read.'],
    needsNotes: ['warn', 'The calendar needs the notes library turned on.'],
  },
  notes: {
    ready: ['ok', (d) => (count(d.count) === null ? 'Your notes library is ready.' : `Your notes library has ${count(d.count)} note${count(d.count) === 1 ? '' : 's'}.`)],
    off: ['', 'The notes library is turned off.'],
    missing: ['warn', 'Your notes library’s folder can’t be found.'],
  },
  usage: {
    ok: ['ok', (d) => (count(d.left) === null ? 'Your Claude plan has room left.' : `${Math.min(100, count(d.left))}% of your Claude plan left.`)],
    low: ['warn', 'Your Claude plan is running low.'],
    limited: ['err', 'You’ve reached your Claude plan’s limit for now.'],
  },
};

/** The states each light knows (for the tests and callers). */
export const STATES = Object.fromEntries(Object.entries(WORDS).map(([pill, w]) => [pill, Object.keys(w)]));

/**
 * The wording of one light: { level, text, aria }. `detail` carries only counts (`count` notes, `left`
 * percent); nothing else in it is ever shown. An unknown state is a plain problem with a fix.
 */
export function pillText(pill, state, detail = {}) {
  const name = NAMES[pill] || 'This light';
  const entry = WORDS[pill]?.[state];
  const [level, words] = entry || ['err', pill === 'brain' ? 'The assistant isn’t working right now.' : `${name === 'This light' ? 'Something' : name} isn’t working right now.`];
  const base = typeof words === 'function' ? words(detail || {}) : words;
  const text = level === 'err' || level === 'warn' ? `${base}${FIX}` : base;
  return { level, text, aria: `${name}: ${text}` };
}

/**
 * Settings → Health's row for the offline voice, which runs in the window (main's checks can't see it):
 * the reason it failed to load, or null while it works. The light only says that it failed.
 */
export function offlineVoiceHealth(error) {
  if (!error) return null;
  return { status: 'fail', label: 'Offline voice', detail: `It failed to load: ${String(error).slice(0, 300)}`, fix: 'It tries again by itself a minute later, with the next sentence. If it keeps failing, choose another voice engine in Settings → Voice output.' };
}
