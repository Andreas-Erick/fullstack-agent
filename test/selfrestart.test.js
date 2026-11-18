// "Restart now" after a self-change (main.js self:restart). Regression: it called app.exit(0), which skips
// before-quit, so the processes the app started (God's Eye's server, the GPU reader, Claude sessions)
// were never stopped.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'main', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const block = (start) => {
  const at = src.indexOf(start);
  assert.ok(at >= 0, `${start} is in main.js`);
  return src.slice(at, src.indexOf('\n  });', at));
};

test('restarting goes through the normal quit, without a handoff note', () => {
  const restart = block("handle('self:restart'");
  assert.match(restart, /handoffDone = true;/, 'no "where we left off" note for a restart');
  assert.match(restart, /app\.relaunch\(\);\s*app\.quit\(\);/);
  assert.doesNotMatch(restart, /app\.exit/);
});
