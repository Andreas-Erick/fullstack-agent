// The launch check and the phone-client browser test never make a sound. They open approval prompts,
// which are read aloud ("Permission needed: Use Google Calendar: create event. Say yes or no."), and
// with several checks running (a self-change, parallel worktrees) the computer kept talking.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the smoke check mutes its window as soon as it watches it', () => {
  const src = read('main/smoke.js');
  const watch = src.slice(src.indexOf('function watch('), src.indexOf('// After booting'));
  assert.ok(watch.length > 50, 'watch() found');
  assert.match(watch, /w\.webContents\.setAudioMuted\(true\)/);
});

test('the browser test mutes every window it opens', () => {
  assert.match(read('test/browser/remoteclient.js'), /app\.on\('browser-window-created', \(_e, w\) => w\.webContents\.setAudioMuted\(true\)\)/);
});
