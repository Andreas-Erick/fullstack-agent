// Run by test/remoteclient.browser.test.js as an Electron main script: Electron is the browser
// (Chromium, nothing to install). Starts the real companion server (main/companion.js) on a throwaway
// data folder, pairs a device, loads the real phone client (renderer/remote/) at phone and tablet
// sizes, opens every screen (Inner World and Architecture included) and prints one line:
// RESULT {"ok":…,"problems":[…],"screens":{…}}. Any console error or uncaught exception is a problem.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siren-browser-'));
process.env.NEXUS_USER_DATA = path.join(tmp, 'data');
process.env.NEXUS_DOCUMENTS = path.join(tmp, 'documents');
app.setPath('userData', process.env.NEXUS_USER_DATA);
app.setPath('documents', process.env.NEXUS_DOCUMENTS);

const SIZES = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 1180, height: 820 },
];
const TABS = ['chat', 'today', 'habits', 'learn', 'more'];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const screens = {};

function freePort() {
  return new Promise((resolve) => {
    const s = require('net').createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function until(wc, expr, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await wc.executeJavaScript(expr).catch(() => false)) return true;
    await wait(150);
  }
  return false;
}

// NEXUS_SHOTS=<folder>: a PNG of every screen at every size too (for design work).
const SHOTS = process.env.NEXUS_SHOTS || '';
async function shot(wc, label) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await wait(1800); // entrance animations
  // A hidden window paints only when asked: a forced repaint, then the picture (else it lags a step).
  wc.invalidate();
  await wc.capturePage();
  await wait(250);
  fs.writeFileSync(path.join(SHOTS, `${label.replace(/[^\w-]+/g, '_')}.png`), (await wc.capturePage()).toPNG());
}

// The screen in #panel finished loading (or the chat is showing); canvases get until PAINT_MS to draw
// (the village loads its art first; a CI machine without a graphics card is several times slower).
const PAINT_MS = 15000;
async function settled(wc, label) {
  const ok = await until(wc, `!document.querySelector('#panel .panel-loading')`);
  if (!ok) problems.push(`${label}: still loading after 15 s`);
  await wait(800);
  const end = Date.now() + PAINT_MS;
  do {
    await measure(wc, label);
    if (screens[label].canvas.every((c) => c.painted < 0 || c.painted >= 5)) break;
    await wait(500);
  } while (Date.now() < end);
  for (const c of screens[label].canvas) if (c.painted >= 0 && c.painted < 5) problems.push(`${label}: the ${c.size} canvas is blank (${c.painted}% painted) after ${PAINT_MS / 1000} s`);
  await clipped(wc, label);
  await shot(wc, label);
}

// Text cut off on the screen (renderer/js/cliptest.js, the same check the desktop's launch check runs;
// the phone page doesn't serve it, so its code is sent along).
const CLIPTEST = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'js', 'cliptest.js'), 'utf8').replace(/^export /gm, '');
async function clipped(wc, label) {
  const found = await wc.executeJavaScript(`(() => { ${CLIPTEST}\nreturn findClippedText(); })()`).catch((err) => [{ where: 'cliptest', text: err.message, how: 'failed' }]);
  for (const c of found) problems.push(`${label}: text cut off (${c.how}) at ${c.where}: "${c.text}"`);
}

async function measure(wc, label) {
  screens[label] = await wc.executeJavaScript(`(() => {
    const p = document.querySelector('#panel');
    const shown = p && !p.classList.contains('hidden');
    const text = shown ? p.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160) : 'chat';
    // How much of each canvas is painted (not near-black): a black village or map is a failure.
    const painted = (c) => {
      try {
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        let n = 0;
        for (let i = 0; i < d.length; i += 4 * 97) (n++, d[i] + d[i + 1] + d[i + 2] > 90 && lit++);
        return n ? Math.round((lit / n) * 100) : 0;
      } catch {
        return -1;
      }
    };
    const canvas = shown ? [...p.querySelectorAll('canvas')].map((c) => ({ size: c.width + 'x' + c.height, painted: painted(c) })) : [];
    return { text, canvas, wide: document.body.classList.contains('wide') };
  })()`);
}

async function run() {
  const store = require('../../main/store');
  const companion = require('../../main/companion');
  await store.setSettings({ onboarded: true, remote: { shareData: true }, innerWorld: { enabled: true } });
  // A flashcard deck to study on the phone (main/flashcards.js, in the throwaway vault).
  const fc = require('../../main/flashcards');
  const deck = (await fc.createDeck('Browser deck')).id;
  await fc.addCards(deck, [{ front: 'What is $2+2$?', back: '**4**' }, { front: 'Capital of Italy', back: 'Rome' }, { front: 'The {{c1::heart}} pumps blood.' }]);
  companion.init({
    startTurn: async () => ({ conversationId: null }),
    abortTurn() {},
    respondApproval: () => false,
    transcribe: async () => '',
    synthesize: async () => Buffer.alloc(0),
    notify() {},
  });
  const port = await freePort();
  await companion.apply({ remote: { enabled: true, lan: false, port, shareData: true } });
  const base = `http://127.0.0.1:${port}`;
  const pair = companion.startPairing();
  const res = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pair.code, name: 'Browser test' }) });
  const { token } = await res.json();
  if (!token) throw new Error(`pairing failed (${res.status})`);

  for (const size of SIZES) {
    const win = new BrowserWindow({ show: false, width: size.width, height: size.height, useContentSize: true, webPreferences: { backgroundThrottling: false } });
    const wc = win.webContents;
    wc.on('console-message', (e) => {
      if (e.level === 'error') problems.push(`${size.name} console: ${String(e.message).slice(0, 300)} (${String(e.sourceId || '').replace(/^.*\/\/[^/]+/, '')}:${e.lineNumber})`);
    });
    wc.on('render-process-gone', (_e, d) => problems.push(`${size.name}: the page crashed (${d.reason})`));
    await win.loadURL(`${base}/`);
    await wc.executeJavaScript(`localStorage.setItem('nexus.token', ${JSON.stringify(token)})`);
    await win.loadURL(`${base}/`);
    if (!(await until(wc, `!document.querySelector('#tabs').classList.contains('hidden')`))) {
      problems.push(`${size.name}: the tabs never showed (not paired?)`);
      win.destroy();
      continue;
    }
    for (const tab of TABS) {
      await wc.executeJavaScript(`document.querySelector('#tabs [data-tab="${tab}"]').click()`, true);
      await settled(wc, `${size.name}/${tab}`);
    }
    const tiles = await wc.executeJavaScript(`[...document.querySelectorAll('.more-tile b')].map((b) => b.textContent)`);
    if (!tiles.length) problems.push(`${size.name}: the More screen has no tiles`);
    for (const [i, name] of tiles.entries()) {
      await wc.executeJavaScript(`document.querySelector('#tabs [data-tab="more"]').click()`, true);
      await until(wc, `document.querySelectorAll('.more-tile').length > ${i}`);
      await wc.executeJavaScript(`document.querySelectorAll('.more-tile')[${i}].click()`, true);
      await settled(wc, `${size.name}/more/${name}`);
    }
    // Studying: open the deck, show the answer, grade it; the computer must have the answer.
    await wc.executeJavaScript(`document.querySelector('#tabs [data-tab="more"]').click()`, true);
    await until(wc, `[...document.querySelectorAll('.more-tile b')].some((b) => b.textContent === 'Flashcards')`);
    await wc.executeJavaScript(`[...document.querySelectorAll('.more-tile')].find((t) => t.textContent.includes('Flashcards')).click()`, true);
    const label = `${size.name}/flashcards study`;
    if (!(await until(wc, `!!document.querySelector('#panel .fc-deck')`))) problems.push(`${label}: no deck on the screen`);
    else {
      const before = (await fc.next(deck)).studiedToday;
      await wc.executeJavaScript(`document.querySelector('#panel .fc-deck').click()`, true);
      if (!(await until(wc, `!!document.querySelector('#panel .fc-show')`))) problems.push(`${label}: no "Show answer"`);
      await wc.executeJavaScript(`document.querySelector('#panel .fc-show').click()`, true);
      if (!(await until(wc, `document.querySelectorAll('#panel .fc-grade').length === 4`))) problems.push(`${label}: no grade buttons after showing the answer`);
      await clipped(wc, label);
      await shot(wc, label);
      const previews = await wc.executeJavaScript(`[...document.querySelectorAll('#panel .fc-grade small')].map((s) => s.textContent)`);
      if (previews.join(' ') !== '1m 6m 10m 4d') problems.push(`${label}: unexpected button intervals ${previews.join(' ')}`);
      await wc.executeJavaScript(`document.querySelector('#panel .fc-grade.good').click()`, true);
      await until(wc, `!!document.querySelector('#panel .fc-show') || !document.querySelector('#panel .fc-grade')`);
      if ((await fc.next(deck)).studiedToday !== before + 1) problems.push(`${label}: the answer did not reach the computer`);
      screens[label] = await wc.executeJavaScript(`document.querySelector('#panel').innerText.replace(/\\s+/g, ' ').slice(0, 160)`);
    }
    // Mixed learning: Shuffle all from the Flashcards screen; a card from a deck, answered "again".
    const mixLabel = `${size.name}/flashcards mixed`;
    await wc.executeJavaScript(`document.querySelector('#panel .fc-head .btn')?.click()`, true);
    if (!(await until(wc, `!!document.querySelector('#panel .fc-today-actions')`))) problems.push(`${mixLabel}: no mixed learning buttons`);
    else {
      await wc.executeJavaScript(`document.querySelectorAll('#panel .fc-today-actions .btn')[1].click()`, true);
      if (!(await until(wc, `!!document.querySelector('#panel .fc-show')`))) problems.push(`${mixLabel}: no card`);
      else {
        const from = await wc.executeJavaScript(`document.querySelector('#panel .fc-from')?.textContent || ''`);
        if (from !== 'Browser deck') problems.push(`${mixLabel}: the card doesn't say its deck (${from})`);
        await wc.executeJavaScript(`document.querySelector('#panel .fc-show').click()`, true);
        await until(wc, `document.querySelectorAll('#panel .fc-grade').length === 4`);
        await clipped(wc, mixLabel);
        await shot(wc, mixLabel);
        const left = () => wc.executeJavaScript(`document.querySelector('#panel .fc-pill b')?.textContent`);
        const before = await left();
        await wc.executeJavaScript(`document.querySelector('#panel .fc-grade.again').click()`, true);
        await until(wc, `!!document.querySelector('#panel .fc-show')`);
        if ((await left()) !== before) problems.push(`${mixLabel}: "again" in practice should keep the card in the round (${before} → ${await left()})`);
      }
    }
    // An approval card with a long title and detail: readable, with a heading, nothing cut off.
    const apLabel = `${size.name}/approval`;
    const id = `browser-${size.name}`;
    companion.publish('approval:request', { id, kind: 'connector', title: 'Use Google Calendar (someone.with.a.long.address@example.com): create an event “Machine Learning Q&A with the whole study group”', detail: JSON.stringify({ summary: 'Machine Learning Q&A', start: '2026-10-28T12:00:00', attendees: ['a@example.com', 'b@example.com'] }, null, 2), timeoutSec: 60, sources: [] });
    if (!(await until(wc, `!!document.querySelector('#approvals .approval')`))) problems.push(`${apLabel}: the card never showed`);
    else {
      const kind = await wc.executeJavaScript(`document.querySelector('#approvals .approval .kind').firstChild.textContent`);
      if (/connector/.test(kind)) problems.push(`${apLabel}: the heading shows the raw kind "${kind}"`);
      await wait(1000);
      await clipped(wc, apLabel);
      await shot(wc, apLabel);
    }
    companion.publish('approval:cancel', { id });
    win.destroy();
  }

  // The computer goes away (Siren closed, computer asleep): the phone shows what is going on and what
  // to check, a screen opened meanwhile says it is out of reach, and nothing throws.
  const win = new BrowserWindow({ show: false, width: 390, height: 844, useContentSize: true, webPreferences: { backgroundThrottling: false } });
  const wc = win.webContents;
  wc.on('console-message', (e) => {
    if (e.level === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED/.test(e.message)) problems.push(`offline console: ${String(e.message).slice(0, 300)}`);
  });
  await win.loadURL(`${base}/`);
  await wc.executeJavaScript(`localStorage.setItem('nexus.token', ${JSON.stringify(token)})`);
  await win.loadURL(`${base}/`);
  await until(wc, `!document.querySelector('#tabs').classList.contains('hidden')`);
  await until(wc, `document.querySelector('#conn')?.classList.contains('ok')`);
  await companion.stop();
  if (!(await until(wc, `!!document.querySelector('#offline .offline-card')`, 20000))) problems.push('offline: no "can’t reach your computer" screen within 20 s');
  else {
    const text = await wc.executeJavaScript(`document.querySelector('#offline').innerText`);
    if (!/Can’t reach your computer/i.test(text) || !/Try again now/i.test(text)) problems.push(`offline: unexpected screen text: ${text.slice(0, 200)}`);
    await clipped(wc, 'phone/offline');
    await shot(wc, 'phone/offline');
    await wc.executeJavaScript(`[...document.querySelectorAll('#offline button')].find((b) => /Try again now/.test(b.textContent)).click()`, true);
    await wc.executeJavaScript(`[...document.querySelectorAll('#offline button')].find((b) => /Continue offline/.test(b.textContent)).click()`, true);
    if (await wc.executeJavaScript(`!!document.querySelector('#offline')`)) problems.push('offline: "Continue offline" did not close the screen');
    await wc.executeJavaScript(`document.querySelector('#tabs [data-tab="habits"]').click()`, true);
    if (!(await until(wc, `!!document.querySelector('#panel .panel-offline')`))) problems.push('offline: a screen opened while offline shows no "out of reach" card');
    else await shot(wc, 'phone/offline screen');
    screens['phone/offline'] = await wc.executeJavaScript(`document.querySelector('#panel').innerText.replace(/\\s+/g, ' ').slice(0, 160)`);
  }
  win.destroy();
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await run();
  } catch (err) {
    problems.push(`harness: ${err.stack || err}`);
  }
  if (problems.length) code = 1;
  process.stdout.write(`RESULT ${JSON.stringify({ ok: !problems.length, problems, screens })}\n`);
  // Chromium may still hold files in it; the system's temp cleanup gets them then.
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  } catch {}
  app.exit(code);
});
app.on('window-all-closed', () => {}); // keep running between the sizes
