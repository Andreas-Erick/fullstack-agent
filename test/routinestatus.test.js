// Every status main/routines.js writes for a routine run has words in the Routines view and a chip on the
// phone's routines screen, which gets the status as main wrote it.
const test = require('node:test');
const assert = require('node:assert');
const { read } = require('./appfixture');

test('every routine status main writes has words on the desktop and a chip on the phone', () => {
  const written = new Set();
  for (const m of read('main/routines.js').matchAll(/lastStatus: ([^,}]+)/g)) for (const q of m[1].matchAll(/'(\w+)'/g)) written.add(q[1]);
  for (const s of ['running', 'stopped', 'waiting', 'ok', 'error', 'skipped', 'interrupted']) assert.ok(written.has(s), `routines.js no longer writes ${s}`);
  const desktop = /const STATUS_TEXT = \{([^}]*)\}/.exec(read('renderer/js/routines.js'));
  const phone = /const ROUTINE_CHIP = new Map\(Object\.entries\(\{([^}]*)\}\)\)/.exec(read('renderer/remote/screens.js'));
  assert.ok(desktop && phone);
  const keys = (block) => new Set([...block.matchAll(/(\w+):/g)].map((m) => m[1]));
  for (const s of [...written].filter((x) => x !== 'ok')) {
    assert.ok(keys(desktop[1]).has(s), `the Routines view shows nothing for ${s}`);
    assert.ok(keys(phone[1]).has(s), `the phone shows no chip for ${s}`);
  }
  // The phone gets the status as main wrote it.
  assert.match(read('main/companiondata.js'), /lastStatus: r\.lastStatus \|\| ''/);
});
