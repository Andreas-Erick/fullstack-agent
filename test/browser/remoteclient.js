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
    win.destroy();
  }
  await companion.stop();
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
