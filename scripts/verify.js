// Integrity checks across files: the mistakes a syntax check can't see but that break the app at
// runtime. Run by scripts/check.js (and so by code_check and every self-change commit).
//  errors   – IPC handler ↔ preload channel ↔ renderer call, relative imports/requires and the names
//             they import, settings keys the UI binds or the agent may set, duplicate tool names.
//  warnings – conventions (a tool without a chat label).
// Usage: node scripts/verify.js [root]   (exit code 1 on errors)
const fs = require('fs');
const path = require('path');
const codemap = require('../main/codemap');

function verify(root) {
  const errors = [];
  const warnings = [];
  const files = codemap.jsFiles(root);
  const texts = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));

  // IPC: every exposed channel has a handler; every renderer call is exposed.
  const ipc = codemap.ipc(root);
  for (const c of ipc.noHandler) errors.push(`preload.js exposes "${c}" but main/ has no handle('${c}') — the call would fail with "No handler registered".`);
  const called = new Map();
  for (const f of files.filter((x) => x.startsWith('renderer/js/'))) {
    for (const m of texts[f].matchAll(/\bapi\.(\w+)\.(\w+)\(/g)) if (!called.has(`${m[1]}:${m[2]}`)) called.set(`${m[1]}:${m[2]}`, f);
  }
  for (const [c, f] of called) if (!ipc.exposed.includes(c)) errors.push(`${f} calls api.${c.replace(':', '.')}() but preload.js doesn't expose "${c}" (add it to channels, and handle('${c}') in main.js).`);
  for (const h of ipc.notExposed) if (!called.has(h)) warnings.push(`main/ handles "${h}" but preload.js doesn't expose it (unused?).`);

  // Imports and requires resolve, and the named imports exist.
  const exportCache = new Map();
  const exportsOf = (rel) => {
    if (!exportCache.has(rel)) exportCache.set(rel, codemap.exportsOf(fs.readFileSync(path.join(root, rel), 'utf8'), rel));
    return exportCache.get(rel);
  };
  for (const f of files) {
    for (const imp of codemap.importsOf(root, f, texts[f])) {
      if (!imp.target) {
        errors.push(`${f}:${imp.line} imports "${imp.spec}", which doesn't exist.`);
        continue;
      }
      const ex = exportsOf(imp.target);
      if (!ex) continue;
      for (const n of imp.names) if (!ex.has(n)) errors.push(`${f}:${imp.line} imports "${n}" from ${imp.target}, which doesn't export it.`);
    }
  }

  // Settings: keys bound in the Settings view and keys the agent may change exist in DEFAULTS.
  const defaults = codemap.settingsDefaults(root);
  if (!defaults) warnings.push('Could not read DEFAULTS in main/store.js; settings keys not checked.');
  else {
    const settingsJs = texts['renderer/js/settings.js'] || '';
    for (const m of settingsJs.matchAll(/\b(?:toggle|text|select|range|slider|number)\('([a-zA-Z]+\.[\w.]+)'/g)) {
      if (!codemap.hasPath(defaults, m[1])) errors.push(`renderer/js/settings.js binds "${m[1]}", which has no default in main/store.js DEFAULTS.`);
    }
    const settable = /const SETTABLE = \{([\s\S]*?)\n\};/.exec(texts['main/tools.js'] || '');
    if (settable) {
      for (const m of settable[1].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
        for (const k of m[2].matchAll(/'(\w+)'/g)) if (!codemap.hasPath(defaults, `${m[1]}.${k[1]}`)) errors.push(`main/tools.js SETTABLE allows "${m[1]}.${k[1]}", which has no default in DEFAULTS.`);
      }
    }
  }

  // Tools: unique names; a label in the chat for each (convention).
  const { tools, unlabeled } = codemap.toolsInfo(root);
  const seen = new Set();
  for (const t of tools) {
    if (seen.has(t.name)) errors.push(`main/tools.js defines the tool "${t.name}" twice.`);
    seen.add(t.name);
  }
  if (unlabeled.length) warnings.push(`Tools without a label in TOOL_LABELS (renderer/js/chat.js): ${unlabeled.join(', ')}.`);

  return { errors, warnings };
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
  const { errors, warnings } = verify(root);
  for (const w of warnings) console.log(`warn ${w}`);
  for (const e of errors) console.log(`FAIL ${e}`);
  console.log(errors.length ? `verify: ${errors.length} error(s)` : 'ok   integrity checks');
  process.exit(errors.length ? 1 : 0);
}

module.exports = { verify };
