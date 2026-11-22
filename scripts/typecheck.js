// Type-checks the pure core modules listed in jsconfig.json (JSDoc types, no build step).
// TypeScript is not a dependency: it is fetched into the npx cache on first use, so this needs npx and,
// the first time, the internet. That is why it is not part of `npm run check` or `npm test`.
const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const TSC = ['-y', '-p', 'typescript@5', 'tsc', '-p', 'jsconfig.json'];
// npx is a .cmd shim on Windows; the arguments are fixed, so the shell sees nothing from outside.
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const run = spawnSync(npx, TSC, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
if (run.error) {
  console.log(`Couldn't run npx (${run.error.code || run.error.message}).`);
  console.log('Type checking needs Node with npx (it comes with npm) and, the first time, the internet to fetch');
  console.log('TypeScript into the npx cache. Nothing is added to package.json. Run it by hand with:');
  console.log(`  npx ${TSC.join(' ')}`);
  process.exit(2);
}
if (run.status === 0) console.log('ok   type check (jsconfig.json)');
else console.log('\nType errors above (or npx could not fetch TypeScript: offline?). Fix them with JSDoc types, not code changes.');
process.exit(run.status ?? 1);
