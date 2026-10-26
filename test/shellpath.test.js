// macOS/Linux PATH for apps started from the Dock (main/shellpath.js): the login shell's PATH and the
// usual install folders are added once each, after what was there.
const test = require('node:test');
const assert = require('node:assert');
const { mergePath, parseShellPath } = require('../main/shellpath');

test('the login shell PATH is read between the markers, banners ignored', () => {
  assert.deepStrictEqual(parseShellPath('Welcome!\n__SIREN_PATH__/opt/homebrew/bin:/usr/bin:/Users/me/.local/bin__SIREN_PATH__'), ['/opt/homebrew/bin', '/usr/bin', '/Users/me/.local/bin']);
  assert.deepStrictEqual(parseShellPath(''), []);
});

test('merging keeps the order and drops duplicates and blanks', () => {
  assert.strictEqual(mergePath('/usr/bin:/bin', ['/opt/homebrew/bin', '/usr/bin', '', '/Users/me/.local/bin']), '/usr/bin:/bin:/opt/homebrew/bin:/Users/me/.local/bin');
  assert.strictEqual(mergePath('', ['/a']), '/a');
});
