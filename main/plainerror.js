// What the window shows when an IPC call fails (main.js handle()): a file-system failure in words, naming
// only the file. Node's own text carries the code and the whole path, and the path holds the user's name.
// Anything else keeps its message (the app's own errors are already written for the user).
const path = require('path');

const FS_WORDS = {
  ENOENT: "isn't there any more",
  EACCES: "can't be opened: Windows refused access",
  EPERM: "can't be changed: Windows refused access (is it read-only, or open in another app?)",
  EBUSY: 'is in use by another app (close it there and try again)',
  ENOSPC: "can't be saved: the disk is full",
  EMFILE: "can't be opened right now: too many files are open (try again in a moment)",
};

function plainIpcError(err) {
  const words = Object.hasOwn(FS_WORDS, String(err?.code)) ? FS_WORDS[err.code] : '';
  if (!words || typeof err?.path !== 'string' || !err.path) return err?.message || String(err);
  return `“${path.basename(err.path).slice(0, 120)}” ${words}.`;
}

module.exports = { plainIpcError, FS_WORDS };
