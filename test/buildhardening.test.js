// Build and release hardening: Electron fuses in package.json, pinned actions in the workflows.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');

test('Electron fuses: Node options, inspector and file:// privileges off; run-as-node kept on purpose', () => {
  const f = require(path.join(ROOT, 'package.json')).build.electronFuses;
  assert.strictEqual(f.enableNodeOptionsEnvironmentVariable, false);
  assert.strictEqual(f.enableNodeCliInspectArguments, false);
  assert.strictEqual(f.grantFileProtocolExtraPrivileges, false);
  assert.strictEqual(f.enableCookieEncryption, true);
  // The MCP bridge and self-change checks run the app's own binary as Node (ELECTRON_RUN_AS_NODE).
  assert.strictEqual(f.runAsNode, true);
  assert.ok(fs.readFileSync(path.join(ROOT, 'main', 'claudecode.js'), 'utf8').includes("ELECTRON_RUN_AS_NODE: '1'"), 'if this goes away, turn the runAsNode fuse off');
});

test('every GitHub Action is pinned to a commit', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  for (const name of fs.readdirSync(dir)) {
    for (const line of fs.readFileSync(path.join(dir, name), 'utf8').split(/\r?\n/)) {
      const m = /uses:\s*([^\s#]+)/.exec(line);
      if (m) assert.match(m[1], /@[0-9a-f]{40}$/, `${name}: ${m[1]}`);
    }
  }
});
