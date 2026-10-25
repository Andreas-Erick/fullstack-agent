// One read-modify-write at a time per note. Two quick check-offs in the Habits view, or a routine and a
// click at the same moment, must not both read the old Habits.md and overwrite each other's change.
// (store.writeJsonAtomic orders the writes; this orders the whole read → change → write.)
const chains = new Map();

function withLock(key, fn) {
  const run = (chains.get(key) || Promise.resolve()).then(fn);
  const tail = run.catch(() => {}); // a failed change must not block the next one
  chains.set(key, tail);
  tail.then(() => chains.get(key) === tail && chains.delete(key));
  return run;
}

module.exports = { withLock };
