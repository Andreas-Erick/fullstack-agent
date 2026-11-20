// The window's start (renderer/js/app.js boot): after the faces exist, every part starts through
// start(), so one that throws (a view after a bad self-change) is logged and shown on its view while the
// rail, approvals, voice, the self-change notice and Evolution still start. app.js needs the window, so
// its source is read; start() and startFailed() themselves run here against a stand-in document.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');

const src = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8').replace(/\r\n/g, '\n');
const fnSource = (name) => {
  const i = src.indexOf(`function ${name}(`);
  assert.ok(i >= 0, `app.js has function ${name}`);
  return src.slice(i, src.indexOf('\n}\n', i) + 2);
};
const bootStart = src.indexOf('async function boot() {');
const body = src.slice(bootStart, src.indexOf('\n}\n', bootStart));

test('boot() calls no init or setup function directly', () => {
  assert.ok(bootStart > 0);
  assert.doesNotMatch(body, /^ {2}(init|setup)\w*\(/m);
});

test('after the faces, every part of boot() starts through start()', () => {
  const from = body.indexOf('  await refreshFaceList();\n');
  assert.ok(from > 0, 'boot() awaits refreshFaceList()');
  const lines = body.slice(from).split('\n').slice(1).filter((l) => /^ {2}\S/.test(l));
  assert.ok(lines.length > 30, `found ${lines.length} lines`);
  for (const line of lines) assert.match(line, /^ {2}(start\(|\}|\/\/)/, `outside start(): ${line.trim()}`);
  assert.doesNotMatch(src, /bootScreen|boot\.done/, 'the boot screen is gone (it was never shown)');
});

test('every view and part imported by app.js is started in boot()', () => {
  const imported = [...src.matchAll(/import \{([^}]*)\} from/g)].flatMap((x) => x[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0])).filter((n) => /^init\w+$/.test(n));
  assert.ok(imported.length >= 18, `found ${imported.length} init functions`);
  for (const name of imported) assert.ok(body.includes(name), `${name} is imported but never started`);
});

test('what gets you out of a broken start comes first: the rail, notices, approvals, Evolution', () => {
  const at = (s) => {
    const i = body.indexOf(s);
    assert.ok(i > 0, `boot() has ${s}`);
    return i;
  };
  for (const early of ['.rail-btn', "api.on('app:notice'", "api.on('vault:changed'", 'initApprovals', 'initEvolution']) {
    for (const later of ['initSettings', 'initChat']) assert.ok(at(early) < at(later), `${early} before ${later}`);
  }
});

test('every view a part names is on the page, so its error has somewhere to show', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer/index.html'), 'utf8');
  const views = [...body.matchAll(/start\('[^']+', [^,]+, '([a-z]+)'\)/g)].map((x) => x[1]);
  assert.ok(views.length >= 12, `found ${views.length} views`);
  for (const v of views) assert.ok(html.includes(`id="view-${v}"`), `index.html has no #view-${v}`);
});

test('the status lights are wired inside boot(), not at module level', () => {
  assert.strictEqual(src.split('Object.entries(pillTargets)').length - 1, 1);
  assert.ok(body.includes('Object.entries(pillTargets)'));
  assert.match(body, /document\.getElementById\(id\)\?\.addEventListener/);
});

test('start() catches a throw and a rejection; startFailed() logs it and shows it on the view', () => {
  assert.match(fnSource('start'), /^function start\(name, fn, view = null\) \{\s*try \{[\s\S]*\.catch\(/);
  assert.match(fnSource('startFailed'), /console\.error\(/, 'a failed part fails the launch check');
  // The two functions as they are in app.js, with stand-ins for the window around them.
  const reported = [];
  const toasts = [];
  const consoled = [];
  const views = { 'view-chat': { prepended: [] } };
  const document = { getElementById: (id) => (views[id] ? { prepend: (n) => views[id].prepended.push(n) } : null) };
  const el = (tag, attrs, ...children) => ({ tag, attrs, children });
  const text = (n) => (typeof n === 'string' ? n : n ? n.children.map(text).join(' ') : '');
  const console = { error: (...a) => consoled.push(a) };
  const make = new Function('reportUiError', 'document', 'el', 'toast', 'switchView', 'location', 'console', `${fnSource('start')}\n${fnSource('startFailed')}\nreturn start;`);
  const start = make((kind, err) => reported.push([kind, err]), document, el, (...a) => toasts.push(a), () => {}, { reload() {} }, console);
  return (async () => {
    let ran = 0;
    start('chat', () => {
      throw new Error('initChat is not a function');
    }, 'chat');
    start('next part', () => ran++); // the parts after a failing one still start
    assert.strictEqual(ran, 1);
    assert.deepStrictEqual(reported.map((r) => r[0]), ['init chat']);
    const box = views['view-chat'].prepended[0];
    assert.strictEqual(box.attrs.class, 'view-error');
    assert.strictEqual(box.attrs.role, 'alert');
    assert.match(text(box), /chat couldn’t start: initChat is not a function/);
    assert.match(text(box), /Reload/);
    assert.match(text(box), /Open Evolution/);
    // On the console too: the launch check (main/smoke.js) fails on console errors, as it did when a
    // throwing init rejected boot(); caught and only logged, a broken view passed it.
    assert.strictEqual(consoled.length, 1);
    assert.strictEqual(consoled[0][0], 'chat couldn’t start');
    assert.match(consoled[0][1].message, /initChat is not a function/, 'the error itself, with its stack');

    // A part without a view (a title-bar widget) that fails later, asynchronously: a notice.
    start('updates', () => Promise.reject(new Error('later')));
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(reported.map((r) => r[0]), ['init chat', 'init updates']);
    assert.match(toasts[0][0], /updates couldn’t start: later/);
    assert.strictEqual(toasts[0][1], 'error');

    // Odd things thrown, and a view that isn't on the page: still contained.
    for (const odd of [null, undefined, 'a string', { code: 7 }, 0]) {
      assert.doesNotThrow(() => start('odd', () => {
        throw odd;
      }, 'missing-view'));
    }
    assert.strictEqual(reported.length, 7);
    assert.strictEqual(toasts.length, 6);
    assert.strictEqual(consoled.length, 7, 'every failure reaches the console');
    // A part that returns something that isn't a promise is fine.
    assert.doesNotThrow(() => start('plain', () => ({ catch: 'not a function' })));
    assert.strictEqual(reported.length, 7);
  })();
});
