// One read-modify-write at a time per note. Two quick check-offs in the Habits view, or a routine and a
// click at the same moment, must not both read the old Habits.md and overwrite each other's change.
// (store.writeJsonAtomic orders the writes; this orders the whole read → change → write.)
//
// It also guards against edits made outside the app (Obsidian, a text editor) between the read and the
// write: while a locked change runs, obsidian.readOptional notes the note's modification time and
// obsidian.writeNote refuses to write if it has changed since (NOTE_CHANGED); the change then runs
// again on the fresh text, up to three times.
const { AsyncLocalStorage } = require('async_hooks');

const chains = new Map();
const guard = new AsyncLocalStorage();
const ATTEMPTS = 3;

function withLock(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).then(() => guarded(key, fn));
  const tail = run.catch(() => {}); // a failed change must not block the next one
  chains.set(key, tail);
  tail.then(() => chains.get(key) === tail && chains.delete(key));
  return run;
}

async function guarded(key, fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      // mtime: undefined = not read yet, null = the note didn't exist when read.
      return await guard.run({ key, mtime: undefined }, fn);
    } catch (err) {
      if (err?.code !== 'NOTE_CHANGED' || attempt >= ATTEMPTS) throw err;
    }
  }
}

/** The running locked change, if any: { key, mtime }. */
const current = () => guard.getStore() || null;

function changedError(rel) {
  const err = new Error(`"${rel}" was changed outside the app while it was being updated; try again.`);
  err.code = 'NOTE_CHANGED';
  return err;
}

module.exports = { withLock, current, changedError };
