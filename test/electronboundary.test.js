// The Electron boundary, read statically from main/*.js and main/tools/*.js so a later change (the agent
// edits its own code) can't quietly undo it: every window and view is sandboxed, every window with the
// app's preload is guarded against navigation, the guard itself, every place that opens something outside
// the app (shell.openExternal / openPath) is a known line, and every raw IPC handler checks its sender.
// Each rule is a function (file, src) → problems; each is shown to fail on a broken fixture.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');

const lineOf = (src, i) => src.slice(0, i).split('\n').length;

// The index of the bracket that closes the one at `open`, skipping strings, template literals and line
// comments (an apostrophe in a comment or a ")" in a string doesn't count).
function closing(src, open, o = '(', c = ')') {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      if (i < 0) return -1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      for (i++; i < src.length && src[i] !== ch; i++) if (src[i] === '\\') i++;
    } else if (ch === o) depth++;
    else if (ch === c && --depth === 0) return i;
  }
  return -1;
}

const nextLines = (src, from, n) => src.slice(from).split('\n').slice(0, n + 1).join('\n');

// The text without its comments (strings kept as they are), so a comment can't stand in for an option.
function withoutComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      if (end < 0) break;
      i = end - 1;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      for (; j < text.length && text[j] !== ch; j++) if (text[j] === '\\') j++;
      out += text.slice(i, j + 1);
      i = j;
    } else out += ch;
  }
  return out;
}

/** Every `new BrowserWindow(` / `new WebContentsView(`: its variable, options code (no comments) and where it ends. */
function windowsIn(src) {
  const out = [];
  for (const m of src.matchAll(/new (BrowserWindow|WebContentsView)\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closing(src, open);
    const lineStart = src.lastIndexOf('\n', m.index) + 1;
    const v = /(\w+)\s*=\s*$/.exec(src.slice(lineStart, m.index))?.[1] || '';
    out.push({ kind: m[1], v, opts: close < 0 ? '' : withoutComments(src.slice(open, close + 1)), line: lineOf(src, m.index), close });
  }
  return out;
}

// 1. Sandboxed, isolated, no Node, no <webview>. `sandbox: false` anywhere fails too (a second key wins).
function sandboxRule(file, src) {
  const problems = [];
  for (const w of windowsIn(src)) {
    const at = `${file}:${w.line}: new ${w.kind}`;
    if (!w.opts) problems.push(`${at}: its options could not be read`);
    if (!/\bsandbox:\s*true\b/.test(w.opts)) problems.push(`${at} without sandbox: true`);
    if (/\bsandbox:\s*false\b/.test(w.opts)) problems.push(`${at} with sandbox: false`);
    if (/\bnodeIntegration(InSubFrames|InWorker)?:\s*true\b/.test(w.opts)) problems.push(`${at} with nodeIntegration on`);
    if (/\bcontextIsolation:\s*false\b/.test(w.opts)) problems.push(`${at} with contextIsolation off`);
    if (/\bwebviewTag\b/.test(w.opts)) problems.push(`${at} with webviewTag`);
  }
  return problems;
}

// 2. A window with the preload (the app's IPC) is guarded; one without runs no script, handles its own
//    navigation and new windows, or only ever shows a data: page.
function guardRule(file, src) {
  const problems = [];
  for (const w of windowsIn(src)) {
    const at = `${file}:${w.line}: new ${w.kind}`;
    const after = (n) => nextLines(src, w.close < 0 ? 0 : w.close, n);
    if (/\bpreload:/.test(w.opts)) {
      const guarded = w.v && new RegExp(`(?:\\bguardNavigation|\\bctx\\.guard)\\(${w.v}\\.webContents\\)`).test(after(40));
      if (!guarded) problems.push(`${at} has the app's preload but no guardNavigation(${w.v || '?'}.webContents) within 40 lines`);
      continue;
    }
    if (/\bjavascript:\s*false\b/.test(w.opts)) continue;
    const near = after(25);
    if (near.includes('setWindowOpenHandler(') && near.includes("'will-navigate'")) continue;
    const loads = w.v ? [...near.matchAll(new RegExp(`\\b${w.v}\\.(loadURL|loadFile)\\(([^\\n]*)`, 'g'))] : [];
    if (loads.length && loads.every((l) => l[1] === 'loadURL' && /^`data:text\/html[;,]/.test(l[2]))) continue;
    problems.push(`${at} without the preload runs scripts but neither handles navigation and new windows nor shows only a data: page`);
  }
  return problems;
}

// 3. The guard: web links to the browser only, every navigation decided by navguard.js.
function guardFunctionRule(file, src) {
  const i = src.indexOf('function guardNavigation(');
  if (i < 0) return file === 'main/main.js' ? [`${file}: function guardNavigation is missing`] : [];
  const body = src.slice(i, closing(src, src.indexOf('{', i), '{', '}') + 1);
  const problems = [];
  if (!/\bnavDecision\(/.test(body)) problems.push(`${file}:${lineOf(src, i)}: guardNavigation doesn't decide with navDecision()`);
  const h = body.indexOf('setWindowOpenHandler(');
  const handler = h < 0 ? '' : body.slice(h, closing(body, body.indexOf('(', h)) + 1);
  if (!handler.includes('/^https?:/i.test(url)') || !handler.includes("action: 'deny'")) problems.push(`${file}:${lineOf(src, i)}: guardNavigation's window-open handler must test /^https?:/ and deny`);
  return problems;
}

// 4. Opening something outside the app: only these lines, each as often as listed.
const OPENERS = {
  'main/main.js': [
    'if (/^https?:/i.test(url)) shell.openExternal(url);',
    "if (d === 'external') shell.openExternal(url);",
    'return shell.openExternal(String(url));',
    'return shell.openExternal(`obsidian://open?path=${encodeURIComponent(target)}`);',
    'return shell.openExternal(url);',
    "handle('memory:openDir', async () => opened(await shell.openPath(await memory.vaultDir())));",
    "handle('docs:openExternal', async (p) => opened(await shell.openPath(await documents.externalPath(p))));",
    "handle('obsidian:openFolder', async () => opened(await shell.openPath(await obsidian.vaultPath())));",
    'return opened(await shell.openPath(skills.dir()));',
    "handle('faces:openFolder', async () => opened(await shell.openPath(await facesDir())));",
  ],
  'main/issues.js': ["await require('electron').shell.openExternal(url);"],
};
function openersRule(file, src) {
  const left = [...(OPENERS[file] || [])];
  const problems = [];
  for (const m of src.matchAll(/\bshell\.open(External|Path)\(/g)) {
    const start = src.lastIndexOf('\n', m.index) + 1;
    const end = src.indexOf('\n', m.index);
    const line = src.slice(start, end < 0 ? undefined : end).trim();
    const k = left.indexOf(line);
    if (k >= 0) left.splice(k, 1);
    else problems.push(`${file}:${lineOf(src, m.index)}: shell.open${m[1]} not on the list: ${line.slice(0, 120)}`);
  }
  return problems;
}

// 5. IPC: everything through handle() (which checks the sender); the three raw window handlers check it first.
function ipcRule(file, src) {
  const problems = [];
  for (const m of src.matchAll(/\bipcMain\.(\w+)\(/g)) {
    const lines = src.slice(m.index).split('\n');
    const prev = src.slice(0, m.index).split('\n').slice(-2, -1)[0]?.trim() || '';
    const at = `${file}:${lineOf(src, m.index)}`;
    const line = lines[0].trim();
    const first = (lines[1] || '').trim();
    if (line === 'ipcMain.handle(channel, async (e, ...args) => {' && prev === 'function handle(channel, fn) {') {
      if (first !== 'if (!fromApp(e)) {') problems.push(`${at}: handle() must check fromApp(e) first`);
      continue;
    }
    if (!/^ipcMain\.handle\('win:(zoom|fullscreen|overlay)', \(e(, \w+)?\) => \{$/.test(line)) {
      problems.push(`${at}: ipcMain.${m[1]} outside handle(): ${line.slice(0, 80)}`);
      continue;
    }
    if (!/^if \(!fromApp\(e\)\) return /.test(first)) problems.push(`${at}: ${line.split(',')[0]}) must start with if (!fromApp(e)) return …`);
  }
  return problems;
}

// 6. "Open in its default app" goes through documents.externalPath (only documents, data, pictures), and
//    the renderer's link opener only takes web links.
function openExternalRule(file, src) {
  if (file !== 'main/main.js') return [];
  const problems = [];
  if (!src.includes("handle('docs:openExternal', async (p) => opened(await shell.openPath(await documents.externalPath(p))));")) problems.push(`${file}: docs:openExternal must be shell.openPath(await documents.externalPath(p))`);
  if (!/handle\('shell:openExternal', \(url\) => \{\n\s*if \(!\/\^https\?:\\\/\\\/\/i\.test\(url\)\) throw/.test(src)) problems.push(`${file}: shell:openExternal must refuse anything but http(s) first`);
  return problems;
}

const RULES = { sandboxRule, guardRule, guardFunctionRule, openersRule, ipcRule, openExternalRule };

function mainFiles() {
  const list = (dir) => fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.js')).map((f) => `${dir}/${f}`);
  return [...list('main'), ...list('main/tools')].map((file) => ({ file, src: fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n') }));
}

test('the real code keeps every rule', () => {
  const files = mainFiles();
  const problems = files.flatMap(({ file, src }) => Object.values(RULES).flatMap((rule) => rule(file, src)));
  assert.deepStrictEqual(problems, []);
  // The reader found what is there (a parser that finds nothing would pass every rule).
  const found = files.flatMap(({ file, src }) => windowsIn(src).map((w) => `${file} ${w.kind} ${w.v}`));
  for (const want of ['main/main.js BrowserWindow win', 'main/agentwindow.js BrowserWindow win', 'main/agentwindow.js WebContentsView view', 'main/docwindows.js BrowserWindow win', 'main/docwindows.js BrowserWindow w', 'main/facecapture.js BrowserWindow win', 'main/pdf.js BrowserWindow win']) assert.ok(found.includes(want), `${want} in ${found.join('; ')}`);
  const openers = files.reduce((n, { src }) => n + [...src.matchAll(/\bshell\.open(External|Path)\(/g)].length, 0);
  assert.strictEqual(openers, Object.values(OPENERS).flat().length, 'every listed opener is still there');
});

test('each rule catches a broken window, guard, opener or handler', () => {
  const cases = [
    ['sandboxRule', 'main/x.js', "win = new BrowserWindow({ webPreferences: { preload: p, contextIsolation: true } });\nguardNavigation(win.webContents);", /without sandbox: true/],
    ['sandboxRule', 'main/x.js', 'const w = new BrowserWindow({ webPreferences: { sandbox: true, nodeIntegration: true } });', /nodeIntegration on/],
    ['sandboxRule', 'main/x.js', 'const w = new BrowserWindow({ webPreferences: { sandbox: true, contextIsolation: false } });', /contextIsolation off/],
    ['sandboxRule', 'main/x.js', 'const v = new WebContentsView({ webPreferences: { sandbox: true, webviewTag: true } });', /webviewTag/],
    ['sandboxRule', 'main/x.js', "const w = new BrowserWindow({ title: 'a (b', webPreferences: { sandbox: false } }); // )", /main\/x\.js:1: new BrowserWindow without sandbox/],
    // A comment or a second key can't stand in for the real value.
    ['sandboxRule', 'main/x.js', 'win = new BrowserWindow({ webPreferences: { preload: p, contextIsolation: true, sandbox: false }, // was sandbox: true\n});', /without sandbox: true/],
    ['sandboxRule', 'main/x.js', 'win = new BrowserWindow({ webPreferences: { preload: p, contextIsolation: true, /* sandbox: true */ sandbox: false } });', /with sandbox: false/],
    ['sandboxRule', 'main/x.js', 'win = new BrowserWindow({ webPreferences: { sandbox: true, preload: p, sandbox: false } });', /with sandbox: false/],
    ['guardRule', 'main/x.js', "const w = new BrowserWindow({ webPreferences: { sandbox: true } }); // javascript: false\nw.loadURL('https://example.com');", /neither handles navigation/],
    ['guardRule', 'main/x.js', "const w = new BrowserWindow({ webPreferences: { sandbox: true, // javascript: false\n} });\nw.loadURL('https://example.com');", /neither handles navigation/],
    ['guardRule', 'main/x.js', "win = new BrowserWindow({ webPreferences: { preload: p, sandbox: true } });\nwin.loadURL('app://bundle/renderer/index.html');", /main\/x\.js:1: .*no guardNavigation\(win\.webContents\)/],
    ['guardRule', 'main/x.js', "win = new BrowserWindow({ webPreferences: { preload: p, sandbox: true } });\nguardNavigation(other.webContents);", /no guardNavigation/],
    ['guardRule', 'main/x.js', "const w = new BrowserWindow({ webPreferences: { sandbox: true } });\nw.loadURL('https://example.com');", /neither handles navigation/],
    ['guardRule', 'main/x.js', "const w = new BrowserWindow({ webPreferences: { sandbox: true } });\nw.loadURL(`data:text/html,${x}`);\nw.loadURL(url);", /neither handles navigation/],
    ['guardRule', 'main/x.js', "const w = new BrowserWindow({ webPreferences: { sandbox: true } });\nw.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));", /neither handles navigation/],
    ['guardFunctionRule', 'main/main.js', "function guardNavigation(wc) {\n  wc.setWindowOpenHandler(({ url }) => {\n    shell.openExternal(url);\n    return { action: 'deny' };\n  });\n}", /navDecision/],
    ['guardFunctionRule', 'main/main.js', "function guardNavigation(wc) {\n  wc.setWindowOpenHandler(({ url }) => {\n    shell.openExternal(url);\n    return { action: 'deny' };\n  });\n  wc.on('will-navigate', (e, url) => navDecision(wc.getURL(), url));\n}", /must test \/\^https\?:\//],
    ['guardFunctionRule', 'main/main.js', '// no guard here', /guardNavigation is missing/],
    ['openersRule', 'main/main.js', "handle('x', (p) => shell.openPath(p));", /main\/main\.js:1: shell\.openPath not on the list/],
    ['openersRule', 'main/tools/web.js', "run: async (a) => require('electron').shell.openExternal(a.url),", /main\/tools\/web\.js:1: shell\.openExternal not on the list/],
    ['openersRule', 'main/main.js', 'return shell.openExternal(url);\nreturn shell.openExternal(url);', /main\/main\.js:2: shell\.openExternal not on the list/],
    ['ipcRule', 'main/main.js', "ipcMain.on('x', (e) => {\n  e.returnValue = 1;\n});", /ipcMain\.on outside handle\(\)/],
    ['ipcRule', 'main/main.js', "  ipcMain.handle('win:zoom', (e, factor) => {\n    const z = clampZoom(factor);", /must start with if \(!fromApp\(e\)\) return/],
    ['ipcRule', 'main/main.js', "  ipcMain.handle('win:secret', (e) => {\n    if (!fromApp(e)) return { ok: false };", /outside handle\(\)/],
    ['ipcRule', 'main/tools/x.js', "require('electron').ipcMain.handleOnce('y', () => 1);", /main\/tools\/x\.js:1: ipcMain\.handleOnce/],
    ['ipcRule', 'main/main.js', 'function handle(channel, fn) {\n  ipcMain.handle(channel, async (e, ...args) => {\n    try {', /handle\(\) must check fromApp/],
    ['openExternalRule', 'main/main.js', "handle('docs:openExternal', async (p) => shell.openPath(await documents.resolveAllowed(p)));", /docs:openExternal must be/],
    ['openExternalRule', 'main/main.js', "handle('shell:openExternal', (url) => {\n    return shell.openExternal(url);\n  });", /shell:openExternal must refuse/],
  ];
  for (const [rule, file, src, want] of cases) {
    const problems = RULES[rule](file, src);
    assert.ok(problems.some((p) => want.test(p)), `${rule} on ${JSON.stringify(src.slice(0, 70))}: ${JSON.stringify(problems)}`);
  }
  // A fixture that keeps the rules passes them (the rules aren't simply always failing).
  const good = "win = new BrowserWindow({ webPreferences: { preload: p, contextIsolation: true, sandbox: true } });\nguardNavigation(win.webContents);\nconst pdf = new BrowserWindow({ webPreferences: { javascript: false, sandbox: true } });";
  assert.deepStrictEqual([...sandboxRule('main/x.js', good), ...guardRule('main/x.js', good)], []);
  // A string that looks like a comment is kept (a URL in a title isn't the end of the line).
  const urlTitle = "const w = new BrowserWindow({ title: 'see https://x.org', webPreferences: { sandbox: true, javascript: false } });";
  assert.deepStrictEqual([...sandboxRule('main/x.js', urlTitle), ...guardRule('main/x.js', urlTitle)], []);
});
