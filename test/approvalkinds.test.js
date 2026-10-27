// Every kind of approval the app can ask for has a readable heading in the desktop dialog
// (renderer/js/approval.js KIND_LABEL) and on the phone's approval card (renderer/remote/app.js KIND),
// so nobody sees a raw id like "connector" (regression: the phone showed it).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');

function sources(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (e.name.endsWith('.js')) out.push(fs.readFileSync(p, 'utf8'));
  }
  return out;
}

const kindsUsed = () => {
  const code = sources(path.join(ROOT, 'main')).join('\n');
  const kinds = new Set();
  for (const m of code.matchAll(/(?:approvals\.gate|\bgate|requireApproval)\(\s*[\w.?]+,\s*'([a-z_]+)'/g)) kinds.add(m[1]);
  return kinds;
};
const labels = (file, name) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const block = new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`).exec(src)[1];
  return new Set([...block.matchAll(/(\w+):\s*'/g)].map((m) => m[1]));
};

test('the approval kinds are found in the code', () => {
  const k = kindsUsed();
  for (const known of ['self_modify', 'command', 'connector', 'connector_trust', 'delete']) assert.ok(k.has(known), known);
});

test('the desktop dialog has a heading for every kind', () => {
  const have = labels('renderer/js/approval.js', 'KIND_LABEL');
  const missing = [...kindsUsed()].filter((k) => !have.has(k));
  assert.deepStrictEqual(missing, []);
});

test('the phone\'s approval card has a heading for every kind', () => {
  const have = labels('renderer/remote/app.js', 'KIND');
  const missing = [...kindsUsed()].filter((k) => !have.has(k));
  assert.deepStrictEqual(missing, []);
});
