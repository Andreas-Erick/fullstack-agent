// `electron . --smoke`: the launch check for Electron upgrades and releases (release.yml runs it before
// publishing). Starts the app on a throwaway data folder, opens the window, waits until the renderer
// says it booted (app:ready), opens every view in the rail once, lets it run a few seconds more, and
// quits with 0, or 1 if the window crashed, logged a console error, the main process threw, or nothing
// booted in time. Prints one line:
// "SMOKE OK …" or "SMOKE FAIL …". Nothing here runs without the flag.
const fs = require('fs');
const os = require('os');
const path = require('path');

const active = process.argv.includes('--smoke');
const TIMEOUT_MS = Number(process.env.NEXUS_SMOKE_TIMEOUT_MS) || 90000;
const SETTLE_MS = 4000; // after app:ready: late errors (lazy imports, first timers) still count

const problems = [];
let app = null;
let readyAt = 0;
let finished = false;

/** Before anything reads the data folder: a fresh one, so the check never touches the user's data. */
function prepare() {
  if (!active) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siren-smoke-'));
  if (!process.env.NEXUS_USER_DATA) seedChat(path.join(dir, 'data'));
  process.env.NEXUS_USER_DATA ||= path.join(dir, 'data');
  process.env.NEXUS_DOCUMENTS ||= path.join(dir, 'documents');
  // The clock starts now, not when the window opens: a main module that fails to load (Electron then
  // shows its error box and waits) still ends the check.
  app = require('electron').app;
  setTimeout(() => finish(false, `no app:ready within ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS).unref?.();
}

// A conversation with what people paste and models write that is hard to lay out: a long link, a long
// unbroken token, a wide table, a long code line, a long formula, a long title and tool chips. The chat
// opens it on start, so the text scan (scanText) checks the chat with content in it.
function seedChat(data) {
  const conv = path.join(data, 'conversations');
  fs.mkdirSync(conv, { recursive: true });
  const url = `https://www.example.com/${'very-long-path-segment/'.repeat(12)}?q=${'x'.repeat(120)}`;
  const reply = [
    `The link: ${url}`,
    `A token: ${'A1b2C3d4'.repeat(30)}`,
    ['| Lecture | Room | Time | Lecturer | Notes | Credits | Exam | Language | Semester |', '|---|---|---|---|---|---|---|---|---|', '| Machine Learning Q&A | Hörsaal 1 (Hauptgebäude, Erdgeschoss links) | 12:00–13:30 | Prof. Dr. Maximilian Mustermann-Schmidt | Bring sheet 7 | 6 ECTS | Written, 90 minutes | English | Winter 2026/27 |'].join('\n'),
    ['```python', `result = some_function(argument="${'value'.repeat(30)}", other=[1, 2, 3, 4, 5, 6, 7, 8, 9, 10])`, '```'].join('\n'),
    String.raw`$$\sigma(x) = \frac{1}{1 + e^{-x}} = \frac{e^{x}}{e^{x} + 1} = 1 - \sigma(-x) = \frac{1}{2} + \frac{1}{2}\tanh\left(\frac{x}{2}\right) = \sum_{k=0}^{\infty} \frac{x^k}{k!} \cdot 0 + \int_0^1 t\,dt$$`,
    '- `inline_code_that_is_very_long_and_has_no_spaces_at_all_anywhere_in_it_whatsoever` and someone.with.a.very.long.address@subdomain.example-university.edu',
  ].join('\n\n');
  const now = Date.now();
  const messages = [
    { role: 'user', content: `Summarise ${url} ${'please '.repeat(30)}`, at: now - 2000 },
    { role: 'assistant', content: reply, at: now - 1000, model: 'claude-opus-5-5', provider: 'claude-code', toolCalls: [{ name: 'mcp__claude_ai_Google_Calendar__list_events', input: { calendarId: 'someone.with.a.very.long.address@example.com' }, ok: true }, { name: 'WebFetch', input: { url }, ok: true }] },
  ];
  fs.writeFileSync(path.join(conv, 'csmoke01.json'), JSON.stringify({ id: 'csmoke01', title: `A conversation with a very long title ${'that goes on '.repeat(8)}`, createdAt: now - 3000, updatedAt: now, messages }));
}

function finish(ok, why) {
  if (finished) return;
  finished = true;
  const line = ok ? `SMOKE OK booted in ${readyAt} ms, opened ${toured.length} views` : `SMOKE FAIL ${why}${problems.length ? `\n  ${problems.slice(0, 20).join('\n  ')}` : ''}`;
  (ok ? process.stdout : process.stderr).write(`${line}\n`);
  app.exit(ok ? 0 : 1);
}

/** Watches the main window; call right after it is created. */
function watch(electronApp, w) {
  if (!active) return;
  app = electronApp;
  win = w;
  w.webContents.on('console-message', (e) => {
    if (e.level === 'error') problems.push(`console: ${String(e.message).slice(0, 300)} (${String(e.sourceId || '').replace(/^.*\/renderer\//, 'renderer/')}:${e.lineNumber})`);
  });
  w.webContents.on('preload-error', (_e, p, err) => problems.push(`preload ${p}: ${err?.message || err}`));
  w.webContents.on('did-fail-load', (_e, code, desc, url) => problems.push(`load failed: ${desc} (${code}) ${url}`));
  w.webContents.on('render-process-gone', (_e, d) => finish(false, `the window crashed (${d.reason})`));
}

// After booting, every view in the rail is opened once (a view that throws when it opens fails too).
const TOUR = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const opened = [];
  for (const b of document.querySelectorAll('.rail-btn')) {
    b.click();
    opened.push(b.dataset.view);
    await wait(700);
  }
  document.querySelector('.rail-btn[data-view="chat"]')?.click();
  return opened;
})()`;

// Windowed sizes: once the layout has settled, the title bar's fold level and the position of its two
// sides must hold still, and the content must fit (layout.js fitTitlebar). Catches the title bar
// flipping between levels, which an animated HUD layer once caused. Returns the problems found.
const STEADY = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const bar = document.querySelector('.titlebar');
  const pills = document.querySelector('.status-pills');
  const brand = document.querySelector('.brand');
  const over = () => pills.getBoundingClientRect().right - (bar.getBoundingClientRect().left + bar.clientLeft + bar.clientWidth - (parseFloat(getComputedStyle(bar).paddingRight) || 0));
  const state = () => [bar.dataset.fold, Math.round(brand.getBoundingClientRect().right), Math.round(pills.getBoundingClientRect().left)].join(' ');
  const found = [];
  for (const [w, h] of [[1920, 1080], [1280, 800], [1023, 700], [900, 600], [1366, 768]]) {
    window.resizeTo(w, h);
    await wait(1500);
    // Jitter is flip-flopping: going back to a state it had, or the fold level changing more than once.
    // One late change (a pill appearing when its data arrives) is fine.
    const seen = [state()];
    let folds = 0;
    for (let i = 0; i < 40; i++) {
      await wait(50);
      const s = state();
      if (s === seen[seen.length - 1]) continue;
      if (s.split(' ')[0] !== seen[seen.length - 1].split(' ')[0]) folds++;
      if (seen.includes(s) || folds > 1) {
        found.push(innerWidth + 'x' + innerHeight + ': the title bar flips between layouts (' + [...seen, s].join(' → ') + ')');
        break;
      }
      seen.push(s);
    }
    if (over() > 1) found.push(innerWidth + 'x' + innerHeight + ': the title bar content is cut off by ' + Math.round(over()) + ' px');
  }
  // The cause seen before, on purpose: something transformed past the bar's edge (like the HUD scan
  // line mid-sweep) while the bar is fitted again. The fold must not change.
  const ghost = document.createElement('i');
  ghost.style.cssText = 'position:absolute;right:0;top:0;width:40px;height:2px;transform:translateX(600px);pointer-events:none';
  const fold = bar.dataset.fold;
  bar.append(ghost);
  window.resizeTo(1365, 768);
  await wait(600);
  window.resizeTo(1366, 768);
  await wait(900);
  if (bar.dataset.fold !== fold) found.push('the title bar folds when a moving HUD layer sticks out past its edge (fold ' + fold + ' → ' + bar.dataset.fold + ')');
  ghost.remove();
  return found;
})()`;

// NEXUS_SHOTS=<folder>: also a PNG of every view (for design work), plus the scenes in
// NEXUS_SHOTS_SCENES (a JSON file of [{ name, js, send: { channel, payload }, wait }]: then a picture).
const SHOTS = process.env.NEXUS_SHOTS || '';
async function shootTour() {
  const wc = win.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(SHOTS, { recursive: true });
  // A hidden window paints only when asked: a forced repaint, then the picture (else it lags a step).
  const snap = async (name) => {
    wc.invalidate();
    await wc.capturePage();
    await wait(250);
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), (await wc.capturePage()).toPNG());
  };
  // Still pictures: the app's reduce-motion look, so no view is caught halfway through fading in.
  await wc.executeJavaScript(`document.body.classList.add('fx-still')`);
  const views = await wc.executeJavaScript(`[...document.querySelectorAll('.rail-btn')].map((b) => b.dataset.view)`);
  for (const v of views) {
    await wc.executeJavaScript(`document.querySelector('.rail-btn[data-view="${v}"]').click()`, true);
    await wait(2600);
    await snap(v);
  }
  const scenes = process.env.NEXUS_SHOTS_SCENES ? JSON.parse(fs.readFileSync(process.env.NEXUS_SHOTS_SCENES, 'utf8')) : [];
  for (const s of scenes) {
    // `send`: an event from the main process, as the app sends it (an approval request, a toast…).
    if (s.send) wc.send(s.send.channel, s.send.payload);
    if (s.js) await wc.executeJavaScript(`(async () => { ${s.js} })()`, true).catch((err) => problems.push(`scene ${s.name}: ${err.message}`));
    await wait(s.wait || 1200);
    await snap(s.name);
  }
  return views;
}

// Text cut off or spilling out of its box (renderer/js/cliptest.js): every view at a large and a small
// window size, then the prompts the main process opens (approvals of every shape, a secret, a voice
// recording), with long titles, long commands and long labels. Returns the problems found.
const scanJs = (label) => `import('./js/cliptest.js').then((m) => m.findClippedText().map((c) => ${JSON.stringify(label)} + ': text cut off (' + c.how + ') at ' + c.where + ': "' + c.text + '"'))`;
const PROMPTS = [
  ['approval:request', { kind: 'connector', title: 'Use Google Calendar: create event', detail: '{\n  "summary": "Machine Learning Q&A",\n  "calendarId": "someone.with.a.long.address@example.com"\n}', remember: [{ level: 'read', label: 'Always allow reading Google Calendar' }, { level: 'write', label: 'Always allow Google Calendar (except deleting)' }] }],
  ['approval:request', { kind: 'command', title: 'Run a command on your computer', detail: `powershell -NoProfile -Command "Get-ChildItem -Recurse ${'C:\\Users\\someone\\Documents\\a-folder-with-a-long-name'.repeat(3)} | Sort-Object Length -Descending"` }],
  ['approval:request', { kind: 'self_modify', title: 'Change its own code (renderer/js/flashcards.js)', tainted: true, sources: [`WebFetch https://example.com/${'segment/'.repeat(30)}?q=${'x'.repeat(80)}`], detail: 'x'.repeat(3000) }],
  ['approval:request', { kind: 'connector_trust', title: `Google Calendar (claude.ai connector for someone.with.a.long.address@example.com): ${'allow everything, deleting included, '.repeat(3)}`, detail: '' }],
  ['secret:request', { label: 'Anthropic API key', hint: 'Paste the key from console.anthropic.com → API keys. It starts with sk-ant-.' }],
  ['record:request', { script: 'The quick brown fox jumps over the lazy dog. '.repeat(8), seconds: 20, title: 'Record a voice sample for your cloned voice', intro: 'This becomes a cloned voice in VoiceStudio. Read this aloud:' }],
];
async function scanText() {
  const wc = win.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const found = new Set();
  const views = await wc.executeJavaScript(`[...document.querySelectorAll('.rail-btn')].map((b) => b.dataset.view)`);
  for (const [w, h] of [[1600, 1000], [1100, 700], [900, 600]]) {
    await wc.executeJavaScript(`window.resizeTo(${w}, ${h})`);
    await wait(500);
    for (const v of views) {
      await wc.executeJavaScript(`document.querySelector('.rail-btn[data-view="${v}"]').click()`, true);
      await wait(900);
      for (const p of await wc.executeJavaScript(scanJs(`${v} @${w}`), true)) found.add(p);
    }
    for (const [i, [channel, payload]] of PROMPTS.entries()) {
      const id = `smoke-${w}-${i}`;
      wc.send(channel, { id, timeoutSec: 75, sources: [], ...payload });
      await wait(500);
      for (const p of await wc.executeJavaScript(scanJs(`${channel} ${payload.kind || ''} @${w}`), true)) found.add(p);
      wc.send('approval:cancel', { id });
      await wait(200);
    }
  }
  return [...found];
}

let win = null;
/** The renderer booted (ipc app:ready, with its boot time in ms). */
function ready(ms) {
  if (!active || readyAt) return;
  readyAt = Math.round(Number(ms) || 0);
  const done = () => setTimeout(() => (problems.length ? finish(false, `${problems.length} problem${problems.length > 1 ? 's' : ''} after boot`) : finish(true)), SETTLE_MS);
  if (!win || win.isDestroyed()) return done();
  (SHOTS ? shootTour() : win.webContents.executeJavaScript(TOUR, true))
    .then(async (views) => {
      toured = views;
      if (!SHOTS) for (const p of await win.webContents.executeJavaScript(STEADY, true)) problems.push(`layout: ${p}`);
      if (!SHOTS) for (const p of await scanText()) problems.push(p);
    })
    .then(done)
    .catch((err) => (problems.push(`tour: ${err.message}`), done()));
}
let toured = [];

/** An error in the main process (main.js's last-resort handlers). */
function noteError(err) {
  if (active) problems.push(`main: ${String(err?.stack || err).split('\n').slice(0, 3).join(' | ')}`);
}

module.exports = { active, prepare, watch, ready, noteError };
