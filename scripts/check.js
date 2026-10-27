// Syntax-checks every main-process (CommonJS) and renderer (ES module) source file.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
// Every file under a folder, recursively (main/tools/, test/browser/… included).
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (e.isDirectory()) walk(`${dir}/${e.name}`, out);
    else out.push(`${dir}/${e.name}`);
  }
  return out;
};
const cjs = ['preload.js', ...walk('main')];
// Renderer modules (recursively), plus the custom-face API.
const esm = walk('renderer/js');
// The phone client (renderer/remote): app.js is a module, the service worker a classic script.
esm.push('renderer/remote/app.js');
cjs.push('renderer/faces/core.js', 'renderer/remote/sw.js', ...fs.readdirSync(path.join(root, 'scripts')).map((f) => `scripts/${f}`));
if (fs.existsSync(path.join(root, 'test'))) cjs.push(...walk('test'));
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

// Then the cross-file integrity checks (scripts/verify.js), once every file parses.
if (!failed) {
  const { errors, warnings } = require('./verify').verify(root);
  for (const w of warnings) console.log(`warn ${w}`);
  for (const e of errors) console.log(`FAIL ${e}`);
  if (errors.length) failed++;
  else console.log('ok   integrity checks');
}
process.exit(failed ? 1 : 0);
