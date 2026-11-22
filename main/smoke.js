// `electron . --smoke`: the launch check for Electron upgrades and releases (release.yml runs it before
// publishing). Starts the app on a throwaway data folder, opens the window, waits until the renderer
// says it booted (app:ready), opens every view in the rail once, lets it run a few seconds more, and
// quits with 0, or 1 if the window crashed, logged a console error, the main process threw, or nothing
// booted in time. Prints one line:
// "SMOKE OK …" or "SMOKE FAIL …". Nothing here runs without the flag.
const fs = require('fs');
const os = require('os');
const path = require('path');
const attachcore = require('./attachcore');

const active = process.argv.includes('--smoke');
const TIMEOUT_MS = Number(process.env.NEXUS_SMOKE_TIMEOUT_MS) || 90000;
const CHECKS_MS = 8 * 60000; // the tour, layout and text checks after boot (a slow CI machine takes a few minutes)
let booted = false;
const SETTLE_MS = 4000; // after app:ready: late errors (lazy imports, first timers) still count

const problems = [];
let app = null;
let readyAt = 0;
let finished = false;
// Console errors a scene causes on purpose, while it runs: MARKDOWN_JS's hostile replies carry inline handlers
// (onerror=…), and Chromium reports the window's CSP refusing one as soon as DOMPurify's own parse sees it.
let expectedConsole = null; // (e) => true for such a report
const cspRefusedHandler = (e) => /^Executing inline event handler violates the following Content Security Policy directive 'script-src /.test(String(e.message)) && /\/dompurify\/dist\/purify\.min\.js$/.test(String(e.sourceId || ''));

/** Runs a scene while the console errors `expect` recognises are expected (only during that scene). */
async function expecting(expect, run) {
  expectedConsole = expect;
  try {
    return await run();
  } finally {
    expectedConsole = null;
  }
}

/** Before anything reads the data folder: a fresh one, so the check never touches the user's data. */
function prepare() {
  if (!active) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'siren-smoke-'));
  if (!process.env.NEXUS_USER_DATA) seedChat(path.join(dir, 'data'));
  if (!process.env.NEXUS_USER_DATA && MEM) seedSettings(path.join(dir, 'data'));
  process.env.NEXUS_USER_DATA ||= path.join(dir, 'data');
  process.env.NEXUS_DOCUMENTS ||= path.join(dir, 'documents');
  // The clock starts now, not when the window opens: a main module that fails to load (Electron then
  // shows its error box and waits) still ends the check.
  app = require('electron').app;
  // Only until the app is up: the checks after that have their own limit (CHECKS_MS, in ready()).
  setTimeout(() => booted || finish(false, `no app:ready within ${TIMEOUT_MS / 1000} s`), TIMEOUT_MS).unref?.();
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
  // A message with attachments (main/attachments.js): a PDF with a long name and an image, as chips.
  const lecture = 'Lecture 03 – Signals and Systems, Fourier transforms and the sampling theorem (annotated).pdf';
  const pdfMeta = { kind: 'pdf', name: lecture, size: 4200000, pages: 28, chars: 81000, shown: 30000, path: path.join(data, 'attachments', 'csmoke01', 'Lecture 03.pdf') };
  const attached = attachcore.compose({ prompt: 'What does slide 4 say?', typed: 'What does slide 4 say?', notice: 'EXTERNAL CONTENT', items: [{ ...pdfMeta, text: 'Slide 4: the sampling theorem. '.repeat(40), pagesRead: 12 }, { kind: 'image', name: 'circuit.png', type: 'image/png', width: 1568, height: 882 }] });
  const messages = [
    { id: 'msmoke1', role: 'user', content: `Summarise ${url} ${'please '.repeat(30)}`, createdAt: now - 2000 },
    { id: 'msmoke1a', role: 'user', display: 'What does slide 4 say?', content: attached.content, attachments: attached.meta, createdAt: now - 1500 },
    { id: 'msmoke2', role: 'assistant', persona: 'Siren', content: reply, createdAt: now - 1000, model: 'claude-opus-5-5', provider: 'claude-code', toolCalls: [{ name: 'mcp__claude_ai_Google_Calendar__list_events', input: { calendarId: 'someone.with.a.very.long.address@example.com' }, ok: true }, { name: 'WebFetch', input: { url }, ok: true }] },
    // A message whose reply failed: its plain-words card, Try again and Details (chat.js syncActions).
    { id: 'msmoke3', role: 'user', content: 'And again?', createdAt: now - 500, attempt: { outcome: 'failed', at: now - 500, error: 'LLM error 429: {"error":{"message":"Rate limit reached for requests"}}', tools: [], output: false } },
  ];
  // journaledUpTo: already in the daily notes, so the journal (main/journal.js) never asks a real model
  // to summarize a seeded chat (test/smokemodel.test.js).
  fs.writeFileSync(path.join(conv, 'csmoke01.json'), JSON.stringify({ id: 'csmoke01', title: `A conversation with a very long title ${'that goes on '.repeat(8)}`, createdAt: now - 3000, updatedAt: now, journaledUpTo: messages.length, messages }));
  // An older chat that History's search finds only by what was said ('capacitor' is not in its title).
  const old = now - 9 * 86400000;
  const lab = [
    { id: 'msmoke21', role: 'user', content: 'Lab report questions', createdAt: old },
    { id: 'msmoke22', role: 'assistant', persona: 'Siren', content: `The flux capacitor ${'needs a very long explanation '.repeat(12)} and a token ${'Q9'.repeat(80)} at the end.`, createdAt: old },
  ];
  fs.writeFileSync(path.join(conv, 'csmoke02.json'), JSON.stringify({ id: 'csmoke02', title: 'Lab report', createdAt: old, updatedAt: old, journaledUpTo: lab.length, messages: lab }));
}

// NEXUS_SMOKE_MEM=1: a memory profile instead of the layout and text checks. A set-up install (no
// wizard, the offline voice as the main voice) in the profile NEXUS_SMOKE_PERF names (auto | balanced |
// full; auto = what this computer's check picks), then the app's memory by process kind after boot,
// after opening each view, and after going back to the chat (what a view keeps once it is left).
// The window stays hidden, so screen-sized compositing is smaller than in real use.
const MEM = process.env.NEXUS_SMOKE_MEM === '1';
function seedSettings(data) {
  const mode = process.env.NEXUS_SMOKE_PERF || 'auto';
  fs.mkdirSync(data, { recursive: true });
  // NEXUS_SMOKE_SETTINGS: JSON sections merged in, e.g. {"stt":{"engine":"groq"}} to leave Whisper out.
  const extra = JSON.parse(process.env.NEXUS_SMOKE_SETTINGS || '{}');
  // The brain is named (without an llm section the install counts as one from before 2.0, and LEGACY's
  // FreeLLMAPI brain is measured instead), and no helper app is started for it.
  const s = { onboarded: true, privacy: { acceptedAt: Date.now() }, perf: { mode }, llm: { provider: 'claude-code' }, voice: { engine: 'local', greetOnLaunch: false }, helperApps: { autoStart: false } };
  for (const [k, v] of Object.entries(extra)) s[k] = v && typeof v === 'object' ? { ...s[k], ...v } : v;
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify(s));
}

async function sampleMemory(label) {
  const kb = { Browser: 0, Tab: 0, GPU: 0, other: 0 };
  for (const m of app.getAppMetrics()) {
    const k = m.type in kb ? m.type : 'other';
    kb[k] += m.memory?.privateBytes || m.memory?.workingSetSize || 0;
  }
  const heap = await win.webContents.executeJavaScript('performance.memory ? performance.memory.usedJSHeapSize : 0').catch(() => 0);
  const mb = (n) => Math.round(n / 1024);
  return { label, main: mb(kb.Browser), window: mb(kb.Tab), gpu: mb(kb.GPU), helpers: mb(kb.other), total: mb(kb.Browser + kb.Tab + kb.GPU + kb.other), jsHeap: Math.round(heap / 1048576) };
}

async function memoryTour() {
  const wc = win.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rows = [];
  // The offline voice loads at launch (and downloads on a fresh data folder): wait for it, up to 3 min.
  const t0 = Date.now();
  while (Date.now() - t0 < 180000 && !(await wc.executeJavaScript(`import('./js/voice.js').then((m) => m.offlineVoiceStatus().device)`, true).catch(() => ''))) await wait(1000);
  const device = await wc.executeJavaScript(`import('./js/voice.js').then((m) => m.offlineVoiceStatus().device || 'not loaded')`, true).catch(() => '?');
  const profile = await wc.executeJavaScript(`import('./js/perf.js').then((m) => m.isBalanced() ? 'balanced' : 'full')`, true).catch(() => '?');
  await wait(3000);
  rows.push(await sampleMemory('boot (chat)'));
  const views = await wc.executeJavaScript(`[...document.querySelectorAll('.rail-btn[data-view]')].map((b) => b.dataset.view)`);
  for (const v of views) {
    await wc.executeJavaScript(`document.querySelector('.rail-btn[data-view="${v}"]').click()`, true);
    await wait(4000);
    rows.push(await sampleMemory(v));
  }
  await wc.executeJavaScript(`document.querySelector('.rail-btn[data-view="chat"]').click()`, true);
  await wait(8000);
  rows.push(await sampleMemory('back to chat'));
  const cols = ['label', 'main', 'window', 'gpu', 'helpers', 'total', 'jsHeap'];
  const line = (r) => cols.map((c, i) => String(r[c]).padStart(i ? 8 : 14)).join('');
  process.stdout.write(`SMOKE MEM profile ${profile}, offline voice ${device} (MB, private)\n${line(Object.fromEntries(cols.map((c) => [c, c])))}\n${rows.map(line).join('\n')}\n`);
  return views;
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
  // A check never makes a sound: the tour opens approval prompts, which are read aloud ("Permission
  // needed: …"), and the offline voice and the fillers play through the page. (The OS's own voice,
  // speechSynthesis, isn't muted by this; the smoke install never uses it.)
  w.webContents.setAudioMuted(true);
  w.webContents.on('console-message', (e) => {
    if (e.level === 'error' && !expectedConsole?.(e)) problems.push(`console: ${String(e.message).slice(0, 300)} (${String(e.sourceId || '').replace(/^.*\/renderer\//, 'renderer/')}:${e.lineNumber})`);
  });
  w.webContents.on('preload-error', (_e, p, err) => problems.push(`preload ${p}: ${err?.message || err}`));
  w.webContents.on('did-fail-load', (_e, code, desc, url) => problems.push(`load failed: ${desc} (${code}) ${url}`));
  w.webContents.on('render-process-gone', (_e, d) => finish(false, `the window crashed (${d.reason})`));
}

// After booting, every view in the rail and its More menu is opened once (a view that throws when it opens fails too).
const TOUR = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const opened = [];
  for (const b of document.querySelectorAll('.rail-btn[data-view]')) {
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
  for (const [w, h] of [[1920, 1080], [1280, 800], [1023, 700], [900, 600], [1366, 768], [1440, 850]]) {
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
    // Every view stays reachable: the rail turns compact in a short window (styles.css) before it scrolls.
    const below = [...document.querySelectorAll('#rail .rail-btn')].filter((b) => b.getBoundingClientRect().bottom > innerHeight + 1).map((b) => b.dataset.view || b.id);
    if (below.length) found.push(innerWidth + 'x' + innerHeight + ': rail buttons below the window: ' + below.join(', '));
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

// The window in the background (body.fx-rest: the HUD's loops paused): a reply and a notice that
// arrive then, and a view opened then, must still show. A paused entrance held its first frame,
// opacity 0, until the window got focus. Run inside painting(). Returns the problems found.
const REST = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // The clock moves only when a frame is drawn, and the first one catches it up in one jump: first the
  // entrances on \`nodes\` start, then a second of animation time, longer than any of them. False when
  // no frame came at all.
  const play = async (...nodes) => {
    const until = Date.now() + 20000;
    const t = document.timeline.currentTime;
    const started = () => document.timeline.currentTime !== t && nodes.every((n) => n.getAnimations().every((a) => !a.pending));
    while (!started() && Date.now() < until) await wait(20);
    const t0 = document.timeline.currentTime;
    while (document.timeline.currentTime - t0 < 1000 && Date.now() < until) await wait(50);
    return document.timeline.currentTime !== t;
  };
  const found = [];
  const shows = (what, n) => {
    const o = getComputedStyle(n).opacity;
    if (o !== '1') found.push(what + ' stays invisible while the window is in the background (opacity ' + o + ')');
  };
  const body = document.body;
  const had = ['fx-rest', 'fx-hud', 'fx-still'].filter((c) => body.classList.contains(c));
  body.classList.add('fx-rest', 'fx-hud');
  body.classList.remove('fx-still');
  document.querySelector('.rail-btn[data-view="chat"]').click();
  const probe = (cls, text) => Object.assign(document.createElement('div'), { className: cls, textContent: text });
  const msg = probe('msg assistant', 'A reply that arrived in the background');
  const note = probe('toast', 'A notice that arrived in the background');
  document.getElementById('messages').append(msg);
  document.getElementById('toasts').append(note);
  if (await play(msg, note)) {
    shows('a new message', msg);
    shows('a notice', note);
    document.querySelector('.rail-btn[data-view="memory"]').click();
    await play(document.querySelector('.view.active'));
    shows('the view opened', document.querySelector('.view.active'));
  } else found.push('the hidden window drew no frames, so nothing could be checked');
  msg.remove();
  note.remove();
  body.classList.remove('fx-rest', 'fx-hud', 'fx-still');
  body.classList.add(...had);
  document.querySelector('.rail-btn[data-view="chat"]').click();
  return found;
})()`;

// The check's window is hidden, and a hidden window paints only when asked (see shootTour): without
// frames no animation moves, paused or not. A window in the background on screen does paint, so this
// draws frames (a capture each) while `fn` runs.
async function painting(fn) {
  let on = true;
  const frames = (async () => {
    while (on && !win.isDestroyed()) {
      win.webContents.invalidate();
      await win.webContents.capturePage().catch(() => null); // a frame missed while the window closes
      await new Promise((r) => setTimeout(r, 30));
    }
  })();
  try {
    return await fn();
  } finally {
    on = false;
    await frames;
  }
}

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
  const views = await wc.executeJavaScript(`[...document.querySelectorAll('.rail-btn[data-view]')].map((b) => b.dataset.view)`);
  for (const v of views) {
    await wc.executeJavaScript(`document.querySelector('.rail-btn[data-view="${v}"]').click()`, true);
    await wait(2600);
    await snap(v);
    for (const tab of v === 'settings' ? await settingsTabs(wc) : []) {
      await wc.executeJavaScript(`document.querySelector('#settingsTabs [data-tab="${tab}"]').click()`, true);
      await wait(800);
      await snap(`settings-${tab}`);
    }
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

// The Settings screen's tabs, in order (renderer/js/settingstabs.js).
const settingsTabs = (wc) => wc.executeJavaScript(`[...document.querySelectorAll('#settingsTabs [data-tab]')].map((b) => b.dataset.tab)`);

// Text cut off or spilling out of its box (renderer/js/cliptest.js): every view at a large and a small
// window size, then the prompts the main process opens (approvals of every shape, a secret, a voice
// recording), with long titles, long commands and long labels. Returns the problems found.
const namesJs = (label) => `import('./js/a11ytest.js').then((m) => { const r = document.querySelector('.view.active') || document.body; return m.findUnnamed(r).map((c) => ${JSON.stringify(label)} + ': a control without a name for screen readers: ' + c.where + ' ' + c.html).concat(m.findHiddenInLabels(r).map((c) => ${JSON.stringify(label)} + ': a control hidden from the keyboard: ' + c.where)); })`;
const scanJs = (label) => `import('./js/cliptest.js').then((m) => m.findClippedText().map((c) => ${JSON.stringify(label)} + ': text cut off (' + c.how + ') at ' + c.where + ': "' + c.text + '"'))`;
// The Face layout opening a conversation whose reply just failed: the card shows the reason with Try again
// and Details (replycard.js opened with turnstate's failedCard()), nothing cut off, every control named. Back to Split afterwards.
const FAILED_CARD_JS = (label) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const { setLayout } = await import('./js/layout.js');
  const chat = await import('./js/chat.js');
  document.querySelector('.rail-btn[data-view="chat"]').click();
  setLayout('face');
  for (let i = 0; i < 30 && !document.querySelector('#view-chat.layout-face'); i++) await wait(100);
  await chat.openConversation('csmoke01');
  await wait(600);
  const found = [];
  // The face's state label stays below the header, also where a narrow window wraps it to two rows.
  const faceLabel = document.querySelector('#miniFaceLabel').getBoundingClientRect();
  const chatHeader = document.querySelector('#view-chat .chat-header').getBoundingClientRect();
  if (faceLabel.height && faceLabel.top < chatHeader.bottom - 1) found.push(${JSON.stringify(label)} + ': the chat header covers the face’s state label (' + Math.round(chatHeader.bottom - faceLabel.top) + ' px)');
  const card = document.querySelector('#replyCard');
  if (card.classList.contains('hidden') || !card.querySelector('.reply-error')) found.push(${JSON.stringify(label)} + ': the Face layout shows no card for the failed reply');
  else {
    const clip = await import('./js/cliptest.js');
    for (const c of clip.findClippedText()) found.push(${JSON.stringify(label)} + ': text cut off (' + c.how + ') at ' + c.where + ': "' + c.text + '"');
    const a11y = await import('./js/a11ytest.js');
    for (const c of a11y.findUnnamed(card)) found.push(${JSON.stringify(label)} + ': a control without a name for screen readers: ' + c.where + ' ' + c.html);
  }
  setLayout('split');
  for (let i = 0; i < 30 && document.querySelector('#view-chat.layout-face'); i++) await wait(100);
  await chat.openConversation('csmoke01');
  // The list the other scans read: the failure under the message, ✎ Edit, the code's Copy (chat.js
  // syncActions, decorateCode). Without them those scans would pass on nothing.
  const parts = { 'the failed reply with Try again': '#messages .msg-failed .reply-error .retry-btn', 'its Details': '#messages .msg-failed .reply-error-raw', '✎ Edit on the latest message': '#messages .msg[data-id="msmoke3"] .redo-btn', 'Copy on the code': '#messages .code-block .code-copy' };
  for (const [what, sel] of Object.entries(parts)) if (!document.querySelector(sel)) found.push(${JSON.stringify(label)} + ': the chat shows no ' + what);
  return found;
})()`;
// Rendered Markdown in the real window (util.js renderMarkdown with the real marked, DOMPurify and KaTeX):
// hostile HTML in a reply comes out harmless (no styles, forms, frames, handlers, javascript: links, page
// classes, labels for the app's controls, formulas typeset into SVG, formula placeholders in attributes),
// while formulas keep KaTeX's styles and task lists, code languages, note links and an SVG's own references
// stay; ids from content can't take the app's own (#modal…); then the chat opens
// the chat asked for last, and one that can't be read says so and leaves the open one. Built here and passed
// in as JSON, so the page code needs no escapes. Ends in Split with csmoke01 open. Returns the problems found.
const MD_SVG_TEXT = '<svg><text>$x^2$</text></svg>'; // KaTeX's HTML there would break out of the SVG
const MD_HOSTILE = [
  'x\n\n<style>.rail{display:none}</style>',
  '<div style="position:fixed;inset:0">y</div>',
  '<div class="modal toast">c</div>',
  '<form action="https://example.com"><input name="k"><button>b</button><select><option>o</option></select><textarea>t</textarea></form>',
  '<img src=x onerror=alert(1)>',
  '[x](javascript:alert(1))',
  '<svg><a xlink:href="javascript:alert(1)"><text>t</text></a></svg>',
  String.raw`$\href{javascript:alert(1)}{y}$`,
  '<a href="$javascript:alert(1)$">j</a>',
  '<span data-$x$="1">d</span>',
  '<span class="katex"><div style="position:fixed">z</div></span>',
  '<dialog open>d</dialog><iframe src="https://example.com"></iframe>',
  '<a href=" JaVaScRiPt:alert(1)">s</a><button formaction="https://example.com">f</button>',
  '<p>Answer: <label for="evoRestart">Show the full answer</label></p>', // would click Evolution's Restart now
  MD_SVG_TEXT,
];
const MD_LONG = Array.from({ length: 80 }, (_, i) => `Step ${i}: ${'text that fills a long reply '.repeat(6)}$a_{${i}} + b^{${i}}$`).join('\n\n');
// Right-to-left text, a formula and one ZWJ family emoji (built, so no invisible character sits in this file).
const MD_FAMILY = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467, 0x200d, 0x1f466);
const MD_INTL = `שלום $x$ ${MD_FAMILY}`;
const MD_GRADIENT = '<svg width="4" height="4"><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)" width="4" height="4"/></svg>';
const MARKDOWN_JS = (label) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const found = [];
  const say = (p) => found.push(${JSON.stringify(label)} + ': ' + p);
  const { renderMarkdown, sanitizeHtml } = await import('./js/util.js');
  const chat = await import('./js/chat.js');
  const PH = [String.fromCharCode(0xe000), String.fromCharCode(0xe001)];
  const parse = (html) => {
    const t = document.createElement('template');
    t.innerHTML = html;
    return t.content;
  };
  const show = (s) => JSON.stringify(s).slice(0, 60);
  const harmless = (src, frag) => {
    const bad = (p) => say(show(src) + ': ' + p);
    for (const tag of ['style', 'form', 'button', 'select', 'textarea', 'dialog', 'iframe', 'template', 'link', 'meta', 'base', 'object', 'embed', 'script']) if (frag.querySelector(tag)) bad('a <' + tag + '> got through');
    if (frag.querySelector('input:not([type="checkbox"])')) bad('an input other than a task checkbox got through');
    if (frag.querySelector('[for]')) bad('a label pointing at another element got through');
    for (const n of frag.querySelectorAll('[style]')) if (!n.closest('.katex')) bad('a style outside a formula: ' + n.outerHTML.slice(0, 80));
    for (const n of frag.querySelectorAll('*')) {
      const inFormula = Boolean(n.closest('.katex, .katex-display'));
      for (const a of n.attributes) {
        if (a.value.trim().toLowerCase().startsWith('javascript:')) bad('a javascript: value in ' + a.name);
        if (a.name.toLowerCase().startsWith('on')) bad('a handler ' + a.name);
        if (PH.some((c) => a.name.includes(c) || a.value.includes(c))) bad('a formula placeholder left in ' + a.name);
        if (!inFormula && (a.name.includes('<') || a.value.includes('<'))) bad('markup in an attribute ' + a.name);
      }
      if (!inFormula) for (const c of n.classList) if (c !== 'wikilink' && !c.startsWith('language-')) bad('a page class kept: ' + c);
    }
  };
  const { classList } = document.getElementById('onboarding');
  const hadWizard = !classList.contains('hidden');
  classList.add('hidden');
  const host = document.createElement('div');
  try {
    for (const src of ${JSON.stringify(MD_HOSTILE)}) harmless(src, parse(renderMarkdown(src, { wikilinks: 'open' })));
    // What must keep working.
    const formula = parse(renderMarkdown('$x^2$'));
    if (!formula.querySelector('.katex [style]')) say('a formula lost KaTeX’s inline styles');
    if (parse(renderMarkdown(${JSON.stringify('- [ ] task\n- [x] done')})).querySelectorAll('input[type="checkbox"]').length !== 2) say('a task list lost its checkboxes');
    if (!parse(renderMarkdown('<a title="$x^2$">t</a>')).querySelector('a[title="x^2"]')) say('a formula in an attribute did not become its source text');
    const i18n = parse(renderMarkdown(${JSON.stringify(MD_INTL)}));
    if (!i18n.textContent.includes('שלום') || !i18n.textContent.includes(${JSON.stringify(MD_FAMILY)}) || i18n.querySelectorAll('.katex').length !== 1) say('RTL text, a ZWJ emoji and a formula did not all survive');
    // Inline SVG: a formula in its text stays source text inside it; its own references follow its prefixed ids.
    const svgText = parse(renderMarkdown(${JSON.stringify(MD_SVG_TEXT)}));
    if (svgText.querySelector('.katex') || svgText.querySelector('svg text')?.textContent !== 'x^2') say('a formula in an SVG’s text was typeset into it (or lost)');
    const gradient = parse(renderMarkdown(${JSON.stringify(MD_GRADIENT)}));
    if (!gradient.querySelector('#user-content-g') || !gradient.querySelector('rect[fill="url(#user-content-g)"]')) say('an SVG’s url(#…) no longer finds its gradient');
    const long = ${JSON.stringify(MD_LONG)};
    const many = parse(renderMarkdown(long)).querySelectorAll('.katex').length;
    if (many !== 80) say('a ' + long.length + '-character reply with 80 formulas rendered ' + many);
    if (!parse(renderMarkdown('[[A Note|alias]]', { wikilinks: 'open' })).querySelector('a.wikilink[data-note="A Note"][tabindex="0"]')) say('a note link lost its class, target or keyboard stop');
    if (!parse(renderMarkdown(${JSON.stringify('```js\nconst a = 1;\n```')})).querySelector('code.language-js')) say('a code block lost its language');
    // Ids from content never take the app's own elements.
    const ids = ['modal', 'modalCard', 'toasts', 'approvalModal'];
    const before = ids.map((id) => document.getElementById(id));
    host.hidden = true;
    document.body.prepend(host);
    host.innerHTML = ids.map((id) => renderMarkdown('<div id="' + id + '" name="' + id + '">x</div>')).join('');
    ids.forEach((id, i) => document.getElementById(id) !== before[i] && say('content took the id #' + id));
    if (!host.querySelector('#user-content-modal')) say('a content id was not prefixed');
    if (!parse(sanitizeHtml('<a id="modal" href="#modal">b</a>')).querySelector('a#user-content-modal[href="#user-content-modal"]')) say('a Word document’s bookmark and its link were not prefixed alike');
    // Opening chats: the last asked for wins; New chat wins over an open still loading; a chat that can't be read says so.
    document.querySelector('.rail-btn[data-view="chat"]').click();
    await chat.openConversation('csmoke01');
    const title = document.querySelector('#chatTitle').textContent;
    await chat.openConversation('smoke-no-such-chat');
    if (document.querySelector('#chatTitle').textContent !== title) say('a chat that can’t be opened replaced the open one');
    const notice = [...document.querySelectorAll('#toasts .toast')].find((t) => t.textContent.includes('couldn’t be opened'));
    if (!notice) say('no notice that the chat couldn’t be opened');
    notice?.remove();
    // Two quick opens: whichever load comes back first, the older one is dropped (without openSeq it lands before
    // or after the newer one's answer, and either way changes the title); the newer one can't be read, so the
    // open chat stays and the notice shows again.
    await Promise.all([chat.openConversation('csmoke02'), chat.openConversation('smoke-no-such-chat')]);
    if (document.querySelector('#chatTitle').textContent !== title) say('an older open landed after a newer one was asked for');
    const again = [...document.querySelectorAll('#toasts .toast')].find((t) => t.textContent.includes('couldn’t be opened'));
    if (!again) say('the newer open’s notice is missing');
    again?.remove();
    const pending = chat.openConversation('csmoke02');
    chat.newChat({ focus: false });
    await pending;
    if (document.querySelector('#chatTitle').textContent !== 'New conversation') say('an open still loading landed after New chat');
  } catch (err) {
    say('the check stopped: ' + err.message);
  } finally {
    host.remove();
    await chat.openConversation('csmoke01');
    await wait(300);
    if (hadWizard) classList.remove('hidden');
  }
  return found;
})()`;
// Dialogs and approvals (util.js holdFocus/modal, approval.js): the skill and memory editors say what is
// missing and stay open; an approval over the memory editor with typed text keeps the text and gives the
// focus back; Esc on the edited form asks before discarding; a confirm opened from a button focuses Cancel
// and returns the focus; a dialog opened while an approval shows opens under it. main sends the
// approvals, so each step is its own script with wc.send between.
// Nothing is saved (Discard and Cancel only; main doesn't know the approvals' ids). The setup wizard is set
// aside meanwhile; the window ends in the chat as it was (Split, csmoke01). Returns the problems found.
async function dialogScene(wc, label) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const found = [];
  const ids = ['smoke-dialogs-1', 'smoke-dialogs-2'];
  const step = async (body) => {
    const js = `(async () => {
      const $ = (s) => document.querySelector(s);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const shown = (s) => !$(s).classList.contains('hidden');
      const where = (n) => (n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : '') : 'nothing');
      const esc = () => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      // The first Esc may only silence the spoken prompt (state.playing); the next one answers.
      const escApproval = async () => {
        for (let i = 0; i < 2 && shown('#approvalModal'); i++) (esc(), await wait(150));
      };
      const cancelOf = (card) => [...card.querySelectorAll('.modal-actions .btn')].find((b) => b.textContent === 'Cancel');
      const found = [];
      const say = (p) => found.push(p);
      try {
        ${body}
      } catch (err) {
        say('the check stopped: ' + err.message);
      }
      return found;
    })()`;
    for (const p of await wc.executeJavaScript(js, true)) found.push(`${label}: ${p}`);
  };
  const hadWizard = await wc.executeJavaScript(`(() => { const w = document.querySelector('#onboarding'); const had = !w.classList.contains('hidden'); w.classList.add('hidden'); return had; })()`, true);
  try {
    // 0. The skill editor checks its fields before it closes: Save without steps keeps the editor and the
    // name, says why and puts the focus on the steps; Esc on it asks, Discard closes.
    await step(`
      $('.rail-btn[data-view="skills"]').click();
      await wait(300);
      $('#skillNew').focus();
      $('#skillNew').click();
      await wait(100);
      const name = $('#modalCard input');
      if (!shown('#modal') || !name) return found.concat('the skill editor did not open');
      name.value = 'Smoke skill';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      [...$('#modalCard').querySelectorAll('.modal-actions .btn.primary')].find((b) => b.textContent === 'Save skill').click();
      await wait(100);
      const error = $('#modalCard .test-result.err:not(.hidden)');
      if (!shown('#modal')) return found.concat('Save without steps closed the skill editor');
      if (error?.textContent !== 'Write its steps.') say('the skill editor did not say what is missing (' + (error ? '"' + error.textContent + '"' : 'no message') + ')');
      if (name.value !== 'Smoke skill') say('the skill editor lost the name');
      if (document.activeElement !== $('#modalCard textarea')) say('the focus did not go to the steps (on ' + where(document.activeElement) + ')');
      esc();
      await wait(100);
      const discard = $('#modalCard .modal-discard .btn.danger');
      if (!discard) return found.concat('Esc on the edited skill did not ask "Discard your changes?"');
      discard.click();
      await wait(100);
      if (shown('#modal')) say('Discard did not close the skill editor');
      if (document.activeElement !== $('#skillNew')) say('focus did not go back to ＋ New skill (on ' + where(document.activeElement) + ')');
    `);
    // 1. The memory editor, opened from its button: Save with no content says so and stays; a title typed.
    await step(`
      $('.rail-btn[data-view="memory"]').click();
      await wait(300);
      $('#memAdd').focus();
      $('#memAdd').click();
      await wait(100);
      const input = $('#modalCard input');
      if (!shown('#modal') || !input) return found.concat('the memory editor did not open');
      if (!$('#modalCard').contains(document.activeElement)) say('focus did not move into the memory editor (on ' + where(document.activeElement) + ')');
      const head = document.getElementById($('#modalCard').getAttribute('aria-labelledby') || '-');
      if ($('#modalCard').getAttribute('role') !== 'dialog' || $('#modalCard').getAttribute('aria-modal') !== 'true' || head?.textContent !== 'New memory') say('the memory editor is not a dialog named by its heading');
      [...$('#modalCard').querySelectorAll('.modal-actions .btn.primary')].find((b) => b.textContent === 'Save').click();
      await wait(100);
      if (!shown('#modal')) return found.concat('Save with no content closed the memory editor');
      if ($('#modalCard .test-result.err:not(.hidden)')?.textContent !== 'Write what the agent should remember.') say('the memory editor did not say the content is missing');
      if (document.activeElement !== $('#modalCard textarea')) say('the focus did not go to the content (on ' + where(document.activeElement) + ')');
      input.focus();
      input.value = 'Lab notes';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    `);
    // 2-3. An approval over it: on its own layer, the editor kept and inert; Esc says no, the focus goes
    // back to the field; Esc on the edited form asks, Discard closes it and the focus goes back to ＋.
    wc.send('approval:request', { id: ids[0], kind: 'settings', title: 'Change a setting', timeoutSec: 75, sources: [] });
    await wait(300);
    await step(`
      if (!shown('#approvalModal')) return found.concat('the approval did not show on its own layer');
      if ($('#approvalCard').getAttribute('role') !== 'alertdialog') say('the approval is not an alertdialog');
      if ($('#modalCard input')?.value !== 'Lab notes') say('the memory editor lost its text under the approval');
      if (!$('#approvalCard').contains(document.activeElement)) say('focus is not in the approval (on ' + where(document.activeElement) + ')');
      if (!$('.shell').inert) say('the window behind the approval is not inert');
      if (!$('#modal').inert) say('the editor under the approval is not inert');
      await escApproval();
      if (shown('#approvalModal')) return found.concat('Esc did not answer the approval');
      if (!shown('#modal')) say('the memory editor closed with the approval');
      if (document.activeElement !== $('#modalCard input')) say('focus did not go back to the editor after the approval (on ' + where(document.activeElement) + ')');
      esc();
      await wait(100);
      const discard = $('#modalCard .modal-discard .btn.danger');
      if (!discard) return found.concat(shown('#modal') ? 'Esc on the edited form did not ask "Discard your changes?"' : 'Esc closed the edited form without asking');
      discard.click();
      await wait(100);
      if (shown('#modal')) say('Discard did not close the editor');
      if ($('.shell').inert) say('the window stayed inert after the editor closed');
      if (document.activeElement !== $('#memAdd')) say('focus did not go back to the button that opened the editor (on ' + where(document.activeElement) + ')');
    `);
    // 4. A confirm opened from a focused button: the focus on Cancel, Esc gives null and the focus back.
    await step(`
      const util = await import('./js/util.js');
      $('#memAdd').focus();
      const p = util.confirmDialog('Smoke check', 'Nothing happens.', 'OK', false);
      await wait(50);
      if (document.activeElement !== cancelOf($('#modalCard'))) say('a confirm did not put the focus on Cancel (on ' + where(document.activeElement) + ')');
      esc();
      const r = await Promise.race([p, wait(1000).then(() => 'no answer')]);
      if (r !== null) say('Esc on a confirm gave ' + r + ', not null');
      if (document.activeElement !== $('#memAdd')) say('focus did not go back to the button after the confirm (on ' + where(document.activeElement) + ')');
    `);
    // 5. A confirm opened while an approval shows (as a notice or a timer would): under the approval,
    // which keeps the focus; when the approval closes the focus moves into the confirm.
    wc.send('approval:request', { id: ids[1], kind: 'delete', title: 'Delete a note', timeoutSec: 75, sources: [] });
    await wait(300);
    await step(`
      const util = await import('./js/util.js');
      if (!shown('#approvalModal')) return found.concat('the second approval did not show');
      const p = util.confirmDialog('Smoke check', 'Nothing happens.', 'OK', false);
      await wait(50);
      if (!shown('#modal')) return found.concat('the confirm did not open');
      if ($('#approvalModal').inert) say('the approval became inert under a dialog opened after it');
      if (!$('#modal').inert) say('a dialog opened while an approval shows is not under it');
      if (!$('#approvalCard').contains(document.activeElement)) say('a dialog opened while an approval shows took its focus (on ' + where(document.activeElement) + ')');
      await escApproval();
      if (shown('#approvalModal')) return found.concat('Esc did not answer the second approval');
      if (document.activeElement !== cancelOf($('#modalCard'))) say('focus did not move into the confirm when the approval closed (on ' + where(document.activeElement) + ')');
      esc();
      const r = await Promise.race([p, wait(1000).then(() => 'no answer')]);
      if (r !== null) say('Esc on the confirm gave ' + r + ', not null');
      if ($('.shell').inert) say('the window stayed inert after both closed');
    `);
  } finally {
    for (const id of ids) wc.send('approval:cancel', { id });
    await wait(200);
    await wc.executeJavaScript(`(async () => {
      const $ = (s) => document.querySelector(s);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      if (!$('#modal').classList.contains('hidden')) {
        document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        await wait(100);
        $('#modalCard .modal-discard .btn.danger')?.click();
        await wait(100);
      }
      if (${JSON.stringify(hadWizard)}) $('#onboarding').classList.remove('hidden');
      $('.rail-btn[data-view="chat"]').click();
      await wait(300);
    })()`, true);
  }
  return found;
}
// Settings (settings.js render): two quick openings show every card once and the page never goes empty
// while it redraws; the old cards can't be edited meanwhile; a switch takes the keyboard focus (styles.css
// .toggle) and keeps it through a redraw. No setting is changed; the setup wizard is set aside meanwhile,
// and the window goes back to the chat (Split, csmoke01 open).
const SETTINGS_JS = (label) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const found = [];
  const say = (p) => found.push(${JSON.stringify(label)} + ': ' + p);
  const wizard = document.querySelector('#onboarding');
  const hadWizard = !wizard.classList.contains('hidden');
  wizard.classList.add('hidden');
  try {
    const { switchView } = await import('./js/nav.js');
    const root = document.querySelector('#settingsRoot');
    // Drawn: the cards are in and no redraw is under way (render marks the root aria-busy meanwhile).
    const drawn = async (what) => {
      const until = Date.now() + 10000;
      while (Date.now() < until) {
        if (root.querySelector(':scope > #set-brain') && !root.hasAttribute('aria-busy')) return true;
        await wait(100);
      }
      say(what + ': Settings wasn’t drawn within 10 s');
      return false;
    };
    switchView('settings');
    await drawn('opened');
    let emptied = 0;
    const watch = new MutationObserver(() => {
      if (root.childElementCount === 0) emptied++;
    });
    watch.observe(root, { childList: true });
    switchView('settings', 'brain');
    switchView('settings', 'brain');
    if (!root.inert) say('the old cards stay editable while the new ones are built (a value typed then is lost)');
    await drawn('opened twice');
    watch.disconnect();
    const cards = document.querySelectorAll('#set-brain').length;
    if (cards !== 1) say('the AI brain card shows ' + cards + ' times after two quick openings');
    if (emptied) say('the page went empty ' + emptied + ' time(s) while it redrew');
    if (root.inert) say('the cards stay inert after the redraw');
    const sw = root.querySelector(':scope > .card:not(.tab-hidden) .toggle input[data-setting]');
    if (!sw) say('no switch on the AI brain tab');
    else {
      sw.focus();
      if (document.activeElement !== sw) say('a switch can’t take the keyboard focus');
      if (getComputedStyle(sw).display === 'none') say('a switch is display: none (no keyboard, no screen reader)');
      // A redraw (as a switch whose change redraws the page) gives the focus back to the same switch.
      const setting = sw.dataset.setting;
      switchView('settings');
      await drawn('redrawn');
      if (document.activeElement?.dataset?.setting !== setting) say('the switch “' + setting + '” lost the keyboard focus in a redraw (now on ' + (document.activeElement?.tagName || 'nothing') + ')');
    }
    // Simple / Advanced: advanced fields are hidden in Simple mode, a search shows one with its note, the
    // switch shows them all (and is put back).
    const shownAdv = () => [...root.querySelectorAll(':scope > .card:not(.tab-hidden) [data-advanced]')].filter((n) => n.offsetParent !== null);
    const mode = document.querySelector('#settingsTabs .settings-mode input');
    if (!mode) say('no “Show advanced” switch at the top of Settings');
    else if (mode.checked) say('Settings opens in Advanced mode on a fresh install');
    else {
      if (shownAdv().length) say(shownAdv().length + ' advanced field(s) show in Simple mode');
      if (!root.querySelector('[data-advanced]')) say('no field is marked advanced');
      const search = document.querySelector('#settingsTabs .settings-search');
      search.value = 'how hard it thinks';
      search.dispatchEvent(new Event('input'));
      const hit = shownAdv();
      if (!hit.length) say('the search doesn’t find the advanced field “How hard it thinks”');
      else if (!hit.some((n) => /Advanced setting/.test(n.textContent))) say('a field the search revealed doesn’t say it is an advanced setting');
      search.value = '';
      search.dispatchEvent(new Event('input'));
      if (shownAdv().length) say('advanced fields stay shown after the search is cleared');
      mode.click();
      await wait(300);
      if (!shownAdv().length) say('Show advanced shows no advanced field on the AI brain tab');
      mode.click();
      await wait(300);
      if (shownAdv().length) say('turning Show advanced off leaves advanced fields shown');
    }
  } catch (err) {
    say('the check stopped: ' + err.message);
  } finally {
    if (hadWizard) wizard.classList.remove('hidden');
    document.querySelector('.rail-btn[data-view="chat"]').click();
    await wait(400);
  }
  return found;
})()`;
const PROMPTS = [
  ['approval:request', { kind: 'connector', title: 'Use Google Calendar: create event', detail: '{\n  "summary": "Machine Learning Q&A",\n  "calendarId": "someone.with.a.long.address@example.com"\n}', remember: [{ level: 'read', label: 'Always allow reading Google Calendar' }, { level: 'write', label: 'Always allow Google Calendar (except deleting)' }] }],
  ['approval:request', { kind: 'command', title: 'Run a command on your computer', detail: `powershell -NoProfile -Command "Get-ChildItem -Recurse ${'C:\\Users\\someone\\Documents\\a-folder-with-a-long-name'.repeat(3)} | Sort-Object Length -Descending"` }],
  ['approval:request', { kind: 'self_modify', title: 'Change its own code (renderer/js/notes.js)', tainted: true, sources: [`WebFetch https://example.com/${'segment/'.repeat(30)}?q=${'x'.repeat(80)}`], detail: 'x'.repeat(3000) }],
  ['approval:request', { kind: 'connector_trust', title: `Google Calendar (claude.ai connector for someone.with.a.long.address@example.com): ${'allow everything, deleting included, '.repeat(3)}`, detail: '' }],
  ['secret:request', { label: 'Anthropic API key', hint: 'Paste the key from console.anthropic.com → API keys. It starts with sk-ant-.' }],
  ['record:request', { script: 'The quick brown fox jumps over the lazy dog. '.repeat(8), seconds: 20, title: 'Record a voice sample for your cloned voice', intro: 'This becomes a cloned voice in VoiceStudio. Read this aloud:' }],
];
// History (js/history.js) in a layout at the current size: it opens over the chat where the panel has no
// room (the Face layout, ≤ 980 px), the search finds csmoke02 by what was said ('capacitor'), the list
// passes the clip and name checks, Tab stays inside the drawer and focus survives a redraw, a layout
// change docks it (at 1600), Esc closes it to the message box (docked: clears the search), and a hit
// opens the chat at the message (the Face layout: on the reply card). The setup wizard, which a fresh
// data folder shows (History stands aside behind it), is set aside meanwhile, as on a set-up install.
// Ends in Split with csmoke01 open, so the next size's chat scan still checks the hard content. Returns
// the problems found.
const HISTORY_JS = (layout, label, w) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (s) => document.querySelector(s);
  const found = [];
  const say = (p) => found.push(${JSON.stringify(label)} + ': ' + p);
  const where = (n) => (n ? n.tagName.toLowerCase() + (n.id ? '#' + n.id : '') + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\\s+/).join('.') : '') : 'nothing');
  const { setLayout } = await import('./js/layout.js');
  const chat = await import('./js/chat.js');
  const history = await import('./js/history.js');
  const layout = ${JSON.stringify(layout)};
  const isOpen = () => $('#view-chat').classList.contains('history-open');
  const search = $('#convSearch');
  const type = async (q) => {
    search.value = q;
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(900);
  };
  const check = async () => {
    document.querySelector('.rail-btn[data-view="chat"]').click();
    setLayout(layout);
    await wait(400);
    const drawer = layout === 'face' || innerWidth <= 980;
    $('#historyBtn').click();
    await wait(300);
    await type('capacitor');
    if (drawer && !isOpen()) return say('History did not open over the chat');
    if (!drawer && isOpen()) say('History opened as a drawer although the side panel has room');
    if (!$('#convList .conv-hit')) say('the search found nothing in the messages (no .conv-hit for "capacitor")');
    const clip = await import('./js/cliptest.js');
    for (const c of clip.findClippedText()) say('text cut off (' + c.how + ') at ' + c.where + ': "' + c.text + '"');
    const a11y = await import('./js/a11ytest.js');
    for (const c of a11y.findUnnamed($('#convPanel'))) say('a control without a name for screen readers: ' + c.where + ' ' + c.html);
    if (drawer) {
      // Tab from the last control goes back to the first.
      const list = [...$('#convPanel').querySelectorAll(':is(button, input, [tabindex]):not([tabindex="-1"]):not(:disabled)')].filter((n) => n.getClientRects().length);
      if (!list.length) return say('nothing in History can take the focus');
      list[list.length - 1].focus();
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
      if (document.activeElement !== list[0]) say('Tab from the last control in History went to ' + where(document.activeElement) + ', not back to the first');
      // The list is redrawn after every reply: the focused row keeps the focus.
      const row = $('#convList .conv-open');
      const id = row?.closest('.conv-item')?.dataset.id;
      row?.focus();
      await chat.refreshList();
      await wait(100);
      const now = document.activeElement;
      if (!now?.classList.contains('conv-open') || now.closest('.conv-item')?.dataset.id !== id) say('focus moved to ' + where(now) + ' when the list was redrawn');
      if (${w} === 1600) {
        // A layout with room docks it: closed, nothing inert, focus still in it.
        setLayout('chat');
        await wait(400);
        if (isOpen()) say('History stayed a drawer after the layout changed to Chat');
        if ($('#view-chat .chat-main').inert) say('the chat stayed inert after History docked');
        if (!$('#convPanel').contains(document.activeElement)) say('focus left History when it docked (now on ' + where(document.activeElement) + ')');
        setLayout(layout);
        await wait(400);
        $('#historyBtn').click();
        await wait(300);
      }
    }
    search.focus();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await wait(150);
    if (drawer) {
      if (isOpen()) say('Esc did not close History');
      if (document.activeElement !== $('#input')) say('Esc left the focus on ' + where(document.activeElement) + ', not the message box');
    } else if (search.value) say('Esc in the side panel did not clear the search');
    // A message hit opens its chat at that message.
    $('#historyBtn').click();
    await wait(300);
    await type('capacitor');
    const hit = $('#convList .conv-hit .conv-open');
    if (!hit) return say('no message hit to open');
    hit.click();
    await wait(600);
    if (layout === 'face') {
      const card = $('#replyCard');
      const kicker = card.querySelector('.reply-card-kicker').textContent;
      if (card.classList.contains('hidden')) say('the message found is not on the reply card');
      else if (!/[0-9]{4}/.test(kicker)) say('the reply card does not say when the message was written: "' + kicker + '"');
    } else if (!$('.msg.found[data-id="msmoke22"]')) say('the chat did not open at the message found (no .msg.found for msmoke22)');
    if (isOpen()) say('History stayed open after a chat was chosen');
  };
  const wizard = $('#onboarding');
  const hadWizard = !wizard.classList.contains('hidden');
  wizard.classList.add('hidden');
  try {
    await check();
  } catch (err) {
    say('the check stopped: ' + err.message);
  } finally {
    history.closeHistory({ focus: false });
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    setLayout('split');
    await wait(400);
    await chat.openConversation('csmoke01');
    await wait(300);
    if (hadWizard) wizard.classList.remove('hidden');
  }
  return found;
})()`;
// The More menu opens from its button, takes the focus, lists every other place inside the window, and
// Esc closes it with the focus back on More (left open for the scans that follow; the caller closes it).
const MORE_JS = (label) => `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const found = [];
  const more = document.getElementById('railMore');
  const menu = document.getElementById('moreMenu');
  more.click();
  await wait(150);
  if (more.getAttribute('aria-expanded') !== 'true' || menu.classList.contains('hidden')) found.push('${label}: More does not open its menu');
  if (!menu.contains(document.activeElement)) found.push('${label}: the open menu does not take the focus');
  document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await wait(100);
  if (!menu.classList.contains('hidden') || document.activeElement !== more) found.push('${label}: Esc does not close the menu back to More');
  more.click();
  await wait(150);
  for (const b of menu.querySelectorAll('[role="menuitem"]')) {
    const r = b.getBoundingClientRect();
    if (r.bottom > innerHeight + 1 || r.right > innerWidth + 1 || !r.width) found.push('${label}: ' + b.dataset.view + ' is outside the window');
  }
  return found;
})()`;

async function scanText() {
  const wc = win.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const found = new Set();
  const views = await wc.executeJavaScript(`[...document.querySelectorAll('.rail-btn[data-view]')].map((b) => b.dataset.view)`);
  for (const [w, h] of [[1600, 1000], [1100, 700], [900, 600]]) {
    await wc.executeJavaScript(`window.resizeTo(${w}, ${h})`);
    await wait(500);
    // The first-run wizard makes the window behind it inert (onboarding.js), and a11ytest skips inert
    // controls: it is scanned on its own, then hidden while the views are walked.
    const hadWizard = await wc.executeJavaScript(`!document.querySelector('#onboarding').classList.contains('hidden')`);
    if (hadWizard) for (const p of await wc.executeJavaScript(scanJs(`wizard @${w}`), true)) found.add(p);
    await wc.executeJavaScript(`document.querySelector('#onboarding').classList.add('hidden')`);
    await wait(100);
    for (const v of views) {
      await wc.executeJavaScript(`document.querySelector('.rail-btn[data-view="${v}"]').click()`, true);
      await wait(900);
      for (const p of await wc.executeJavaScript(scanJs(`${v} @${w}`), true)) found.add(p);
      // Controls a screen reader can't name (a11ytest.js): once, at the first size.
      if (w === 1600) for (const p of await wc.executeJavaScript(namesJs(v), true)) found.add(p);
      // Settings shows one tab of cards at a time (settingstabs.js): every tab is checked.
      for (const tab of v === 'settings' ? await settingsTabs(wc) : []) {
        await wc.executeJavaScript(`document.querySelector('#settingsTabs [data-tab="${tab}"]').click()`, true);
        await wait(400);
        for (const p of await wc.executeJavaScript(scanJs(`settings/${tab} @${w}`), true)) found.add(p);
        if (w === 1600) for (const p of await wc.executeJavaScript(namesJs(`settings/${tab}`), true)) found.add(p);
      }
    }
    // The rail's More menu, open (moremenu.js): its places named, nothing cut off, inside the window.
    for (const p of await wc.executeJavaScript(MORE_JS(`more menu @${w}`), true)) found.add(p);
    for (const p of await wc.executeJavaScript(scanJs(`more menu @${w}`), true)) found.add(p);
    if (w === 1600) for (const p of await wc.executeJavaScript(namesJs('more menu'), true)) found.add(p);
    await wc.executeJavaScript(`document.querySelector('#railMore[aria-expanded="true"]')?.click()`, true);
    if (hadWizard) await wc.executeJavaScript(`document.querySelector('#onboarding').classList.remove('hidden')`);
    // History in the Face layout (always a drawer) and the Chat layout (docked where it has room).
    for (const layout of ['face', 'chat']) for (const p of await wc.executeJavaScript(HISTORY_JS(layout, `history ${layout} @${w}`, w), true)) found.add(p);
    for (const [i, [channel, payload]] of PROMPTS.entries()) {
      const id = `smoke-${w}-${i}`;
      wc.send(channel, { id, timeoutSec: 75, sources: [], ...payload });
      await wait(500);
      for (const p of await wc.executeJavaScript(scanJs(`${channel} ${payload.kind || ''} @${w}`), true)) found.add(p);
      wc.send('approval:cancel', { id });
      await wait(200);
    }
    for (const p of await wc.executeJavaScript(FAILED_CARD_JS(`failed reply card @${w}`), true)) found.add(p);
    if (w === 1600) {
      for (const p of await expecting(cspRefusedHandler, () => wc.executeJavaScript(MARKDOWN_JS(`markdown safety @${w}`), true))) found.add(p); // render
      for (const p of await dialogScene(wc, `dialogs @${w}`)) found.add(p);                                                                       // dialogs
      for (const p of await wc.executeJavaScript(SETTINGS_JS(`settings render @${w}`), true)) found.add(p);                                     // settings
    }
  }
  // Zoomed in on the smallest window: 900 × 600 at 150 % is 600 × 400 CSS px (the side lists stack).
  await wc.executeJavaScript(`window.resizeTo(900, 600); import('./js/layout.js').then((m) => m.setZoom(1.5))`, true);
  await wait(800);
  for (const v of ZOOM_VIEWS) {
    await wc.executeJavaScript(`document.querySelector('.rail-btn[data-view="${v}"]').click()`, true);
    await wait(900);
    for (const p of await wc.executeJavaScript(scanJs(`${v} @900x600 zoom 150%`), true)) found.add(p);
  }
  await wc.executeJavaScript(`import('./js/layout.js').then((m) => m.setZoom(1))`, true);
  await wait(500);
  return [...found];
}
// The views with a side list beside a detail pane, which stack when narrow (styles.css, max-width 760px).
const ZOOM_VIEWS = ['knowledge', 'docs', 'evolution'];

// NEXUS_SMOKE_FACE=1: also record the watch's face (main/facecapture.js, ~30 s) and check the pack:
// every state, a steady frame rate, frames that move, and a loop without a jump where it repeats.
async function checkFace() {
  const fc = require('./facecapture');
  const { nativeImage } = require('electron');
  const t0 = Date.now();
  const { header, frames } = fc.unpack((await fc.frames(await require('./store').getSettings())).data);
  const found = [];
  const ms = Date.now() - t0;
  if (header.fps !== fc.FPS) found.push(`face: fps ${header.fps}, expected ${fc.FPS}`);
  // Mean absolute difference of two frames, 0–255.
  const diff = (a, b) => {
    const x = nativeImage.createFromBuffer(a).toBitmap();
    const y = nativeImage.createFromBuffer(b).toBitmap();
    let d = 0;
    for (let i = 0; i < x.length; i += 4) d += Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
    return d / (x.length * 0.75);
  };
  const report = {};
  for (const s of fc.STATES) {
    const list = frames[s] || [];
    if (!list.length) {
      found.push(`face: no frames for ${s}`);
      continue;
    }
    const steps = list.slice(1).map((f, i) => diff(list[i], f));
    const seam = list.length > 1 ? diff(list[list.length - 1], list[0]) : 0;
    const typical = steps.length ? steps.reduce((a, b) => a + b, 0) / steps.length : 0;
    report[s] = { n: list.length, step: +typical.toFixed(2), seam: +seam.toFixed(2) };
    // The jump from the last frame back to the first may be a little bigger than a usual step, never a cut.
    if (typical > 0.05 && seam > Math.max(3 * typical, 2)) found.push(`face: ${s} jumps where the loop repeats (seam ${seam.toFixed(1)} vs step ${typical.toFixed(1)})`);
  }
  process.stdout.write(`SMOKE FACE recorded in ${ms} ms: ${JSON.stringify(report)}
`);
  return found;
}

let win = null;
/** The renderer booted (ipc app:ready, with its boot time in ms). */
function ready(ms) {
  if (!active || booted) return;
  booted = true;
  readyAt = Math.round(Number(ms) || 0);
  setTimeout(() => finish(false, `the checks after boot did not finish within ${CHECKS_MS / 60000} min${problems.length ? `; so far: ${problems.slice(0, 5).join(" | ")}` : ""}`), CHECKS_MS).unref?.();
  const done = () => setTimeout(() => (problems.length ? finish(false, `${problems.length} problem${problems.length > 1 ? 's' : ''} after boot`) : finish(true)), SETTLE_MS);
  if (!win || win.isDestroyed()) return done();
  (MEM ? memoryTour() : SHOTS ? shootTour() : win.webContents.executeJavaScript(TOUR, true))
    .then(async (views) => {
      toured = views;
      if (MEM) return;
      if (!SHOTS) for (const p of await win.webContents.executeJavaScript(STEADY, true)) problems.push(`layout: ${p}`);
      if (!SHOTS) for (const p of await painting(() => win.webContents.executeJavaScript(REST, true))) problems.push(`rest: ${p}`);
      if (!SHOTS) for (const p of await scanText()) problems.push(p);
      if (process.env.NEXUS_SMOKE_FACE === '1') for (const p of await checkFace()) problems.push(p);
    })
    .then(done)
    .catch((err) => (problems.push(`tour: ${err.message}`), done()));
}
let toured = [];

/** An error in the main process (main.js's last-resort handlers). */
function noteError(err) {
  if (active) problems.push(`main: ${String(err?.stack || err).split('\n').slice(0, 3).join(' | ')}`);
}

module.exports = { active, prepare, watch, ready, noteError, seedChat };
