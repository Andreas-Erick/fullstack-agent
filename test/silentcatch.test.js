// The silent-catch rule (main/codemap.js silentCatches, scripts/verify.js): an error dropped without a
// reason fails the check; a comment or ignore(reason) passes; renderer/remote/ is only warned about.
// Also the ignore() helper itself (main/ignore.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpDir, load, stub } = require('./helpers');
const codemap = require('../main/codemap');
const { verify, catchFiles } = require('../scripts/verify');

const lines = (text) => codemap.silentCatches(text).map((h) => h.line);

test('bare silent catches are found', () => {
  const src = [
    'p.catch(() => {});',
    'p.catch(() => null);',
    'p.catch(() => undefined);',
    'p.catch(() => false);',
    'p.catch((e) => {});',
    'p.catch(_ => {});',
    'try { a(); } catch {}',
    'try { a(); } catch (e) {}',
    'try {',
    '  a();',
    '} catch (err) {',
    '}',
    'const x = await p',
    '  .catch(() => null)',
    '  .then(f);',
  ].join('\n');
  assert.deepStrictEqual(lines(src), [1, 2, 3, 4, 5, 6, 7, 8, 11, 14]);
});

test('a reason, a handled error or quoted code passes', () => {
  const src = [
    'p.catch(() => {}); // the caller already got the error',
    'p.catch(() => null); /* missing file reads as none */',
    'p.catch(ignore("cache only"));',
    'p.catch(ignore("no vault", null));',
    'p.catch(() => {/* nothing to stop */});',
    'p.catch((e) => log.warn("x", e));',
    'p.catch(() => []);',
    'try { a(); } catch {} // a destroyed page: denied',
    'try { a(); } catch {',
    '  // storage blocked: one launch without it',
    '}',
    'try { a(); } catch (e) { return null; }',
    '// never write p.catch(() => {}) without a reason',
  ].join('\n');
  assert.deepStrictEqual(lines(src), []);
});

test('verify fails on a silent catch in main/ and renderer/, warns in renderer/remote/', () => {
  const dir = tmpDir('nexus-catch-');
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('preload.js', 'try { x(); } catch {}\n');
  put('main/a.js', 'p.catch(() => {});\nq.catch(() => null); // fine\n');
  put('main/tools/b.js', 'p.catch(() => false);\n');
  put('renderer/js/c.mjs', 'p.catch(() => undefined);\n');
  put('renderer/remote/d.js', 'p.catch(() => {});\n');
  assert.deepStrictEqual(catchFiles(dir).sort(), ['main/a.js', 'main/tools/b.js', 'preload.js', 'renderer/js/c.mjs', 'renderer/remote/d.js']);
  const { errors, warnings } = verify(dir);
  const silent = errors.filter((e) => e.includes('drops an error'));
  assert.deepStrictEqual(silent.map((e) => e.split(' ')[0]).sort(), ['main/a.js:1', 'main/tools/b.js:1', 'preload.js:1', 'renderer/js/c.mjs:1']);
  assert.ok(warnings.some((w) => w.startsWith('renderer/remote/d.js:1 drops an error')));
  assert.ok(!errors.some((e) => e.startsWith('renderer/remote/')));
});

test('ignore(reason) logs at debug and yields the fallback', async () => {
  const debug = [];
  stub({ './logger': { debug: (event, data) => debug.push({ event, data }) } });
  const { ignore } = load('main/ignore.js');
  const err = new Error('gone');
  assert.strictEqual(await Promise.reject(err).catch(ignore('cache only')), undefined);
  assert.strictEqual(await Promise.reject(err).catch(ignore('no vault', null)), null);
  assert.deepStrictEqual(debug, [
    { event: 'ignored', data: { reason: 'cache only', error: err } },
    { event: 'ignored', data: { reason: 'no vault', error: err } },
  ]);
  // A logger stub without debug (some tests) never turns the catch into a failure.
  stub({ './logger': {} });
  const bare = load('main/ignore.js');
  assert.strictEqual(await Promise.reject(err).catch(bare.ignore('x', 0)), 0);
});
