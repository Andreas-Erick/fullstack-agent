// Syntax-checks every main-process (CommonJS) and renderer (ES module) source file.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const cjs = ['preload.js', ...fs.readdirSync(path.join(root, 'main')).map((f) => `main/${f}`)];
// Renderer modules (recursively), plus the custom-face API.
const esm = [];
(function walk(dir) {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.isDirectory()) walk(`${dir}/${e.name}`);
    else esm.push(`${dir}/${e.name}`);
  }
})('renderer/js');
cjs.push('renderer/faces/core.js', 'scripts/recover.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-check-'));
let failed = 0;

function check(file, asModule) {
  let target = path.join(root, file);
  if (asModule) {
    target = path.join(tmp, path.basename(file).replace(/\.js$/, '.mjs'));
    fs.copyFileSync(path.join(root, file), target);
  }
  try {
    execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
    console.log(`ok   ${file}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${file}\n${err.stderr.toString()}`);
  }
}

cjs.filter((f) => f.endsWith('.js')).forEach((f) => check(f, false));
esm.filter((f) => f.endsWith('.js')).forEach((f) => check(f, true));
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
