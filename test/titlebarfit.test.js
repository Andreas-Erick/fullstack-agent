// The title bar's fold (renderer/js/layout.js fitTitlebar, data-fold rules in styles.css). The smoke check
// once found the "Notes library" light cut off by 66 px right after the window narrowed: the fit waited for
// the next animation frame after the resize, and a hidden or background window draws about once a second.
// layout.js needs the window, so its source is read.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const layout = read('renderer/js/layout.js');
const css = read('renderer/styles.css');
const html = read('renderer/index.html');

const initSource = () => {
  const i = layout.indexOf('function initTitlebarFit(');
  assert.ok(i >= 0, 'layout.js has initTitlebarFit');
  return layout.slice(i, layout.indexOf('\n}\n', i) + 2);
};

test('a resize fits the title bar at once, not on a later animation frame', () => {
  const src = initSource();
  const m = src.match(/new ResizeObserver\((\w+)\)/);
  assert.ok(m, 'the title bar is watched by a ResizeObserver');
  const cb = m[1];
  const def = src.match(new RegExp(`const ${cb} = \\(\\) => (\\{[\\s\\S]*?\\n  \\};|[^\\n]*;)`));
  assert.ok(def, `${cb} is defined in initTitlebarFit`);
  assert.match(def[1], /fitTitlebar\(\)/, 'the observer calls fitTitlebar itself');
  assert.doesNotMatch(def[1], /requestAnimationFrame\(/, 'the observer never defers the fit to a frame');
});

test('every connection light has its words hidden from the first fold on', () => {
  const group = html.match(/<div class="tb-group tb-systems">([\s\S]*?)<\/div>/);
  assert.ok(group, 'index.html has the connections group');
  const ids = [...group[1].matchAll(/<button[^>]*id="(pill\w+)"/g)].map((x) => x[1]);
  assert.ok(ids.includes('pillKb'), 'the notes library light is in the group');
  // Fold 1 turns the group's words off (font-size 0), so a long plain label like "Notes library" never
  // needs its own rule; this pins that the rule covers the whole group.
  assert.match(css, /\.titlebar\[data-fold\]:not\(\[data-fold='0'\]\) \.tb-systems \.pill \{[^}]*font-size: 0/);
});
