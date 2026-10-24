// Test helpers: load a main-process module with stand-ins for Electron and for the modules it
// requires (each test file runs in its own process, so stubs never leak between files).
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const stubs = new Map();
const original = Module.prototype.require;
Module.prototype.require = function (id) {
  return stubs.has(id) ? stubs.get(id) : original.apply(this, arguments);
};

/** stub({ './store': {...}, electron: {...} }) — by the exact string passed to require(). */
function stub(map) {
  for (const [id, value] of Object.entries(map)) stubs.set(id, value);
}

/** Requires a file relative to the app root, fresh (not from the module cache). */
function load(rel) {
  const file = require.resolve(path.join(ROOT, rel));
  delete require.cache[file];
  return require(file);
}

function tmpDir(prefix = 'nexus-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const quietLog = { info() {}, warn() {}, error() {}, debug() {}, context: () => ({}), withContext: (_t, fn) => fn(), tail: () => '', recentErrors: () => [] };

/** A ./store stand-in that keeps JSON files in `dir`; `extra` adds or overrides members. */
function fileStore(dir, extra = {}) {
  return {
    dataDir: () => dir,
    readJson: async (f, fallback) => {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch {
        return fallback;
      }
    },
    writeJsonAtomic: async (f, v) => fs.writeFileSync(f, JSON.stringify(v)),
    newId: (p) => `${p}_${Math.random().toString(36).slice(2, 10)}`,
    ...extra,
  };
}

module.exports = { ROOT, stub, load, tmpDir, quietLog, fileStore };
