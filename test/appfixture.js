// Shared setup for the tests that run the real store, approvals, routines and companion server together,
// without a window: an Electron stand-in with a throwaway data folder and a reversible keychain (so the real
// store seals and unseals conversations), optionally the companion server on a free loopback port with
// main.js's hooks, and helpers to pair a device, read its event stream and answer approvals. Each test file
// runs in its own process, so each gets its own folder, store and server.
const test = require('node:test');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, stub, load, tmpDir, quietLog } = require('./helpers');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

async function untilTrue(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(10);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const s = require('net').createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** setup(name, { server }): call once, at the top of a test file, before anything loads main/ modules. */
module.exports = function setup(name, { server = false } = {}) {
  const dir = tmpDir(`siren-${name}-`);
  let esmDir = null;

  // Electron as a stand-in that accepts anything (as test/modules.test.js), with this file's data folder.
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(`x${s}`), decryptString: (b) => b.toString().slice(1) };
  const electron = new Proxy(function () {}, {
    get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => dir : p === 'getPath' ? () => dir : p === 'safeStorage' ? safeStorage : p === 'isPackaged' ? false : p === 'platform' ? process.platform : p === 'getVersion' ? () => '0.0.0' : electron),
    apply: () => electron,
    construct: () => electron,
  });
  stub({
    electron,
    './logger': quietLog,
    '../logger': quietLog,
    // What the companion server needs besides the store, as in test/companion.test.js.
    './updates': { forDevices: async () => null },
    './voice': {},
    './companiondata': {},
    './facecapture': { frames: async () => ({ key: 'k1', data: Buffer.from('SRF1') }) },
    './faces': { dir: async () => path.join(dir, 'faces'), list: async () => [] },
    './tunnel': { apply: async () => {}, stop() {}, status: () => ({ mode: 'off' }), publicHost: () => '' },
    './calendar': { events: async () => [] },
    // The vault's version history would start git in the test's vault (and hold its folder while it runs).
    './vaultgit': { ensure: async () => {}, commitSoon() {}, flushAll: async () => {}, history: async () => [], showVersion: async () => '', restore: async () => {}, maintain: async () => {} },
  });
  const store = load('main/store.js');
  const approvals = load('main/approvals.js');
  const companion = load('main/companion.js');
  const routines = load('main/routines.js');
  let tools = null;

  const fx = {
    dir,
    store,
    approvals,
    companion,
    routines,
    read,
    load,
    wait,
    escapeRe,
    untilTrue,
    base: '',
    active: new Map(), // main.js activeRequests: requestId -> AbortController
    turns: [], // every turn a device started
    allTools: () => (tools ||= load('main/tools.js')),

    /** A renderer pure module as an ES module (a copy in a folder of its own). */
    async esm(rel) {
      esmDir ||= tmpDir(`siren-${name}-esm-`);
      const copy = path.join(esmDir, `${path.basename(rel, path.extname(rel))}.mjs`);
      fs.copyFileSync(path.join(ROOT, rel), copy);
      return import(pathToFileURL(copy).href);
    },

    /** Approvals answered as they arrive (respond after the sender returns, as a click would); null leaves them open. */
    answering(answer, sent = []) {
      approvals.setSender((channel, payload) => {
        if (channel !== 'approval:request') return;
        sent.push(payload);
        if (answer !== null) setImmediate(() => approvals.respond(payload.id, answer));
      });
      return sent;
    },

    /** What approvals.gate does with one kind in a permission mode, with or without outside content. */
    async decide(kind, { mode, tainted = false, taintGuard = true, turn = null, extra = {}, answer = false } = {}) {
      await store.setSettings({ safety: { permissionMode: mode, taintGuard } });
      const sent = fx.answering(answer);
      const t = turn || approvals.newTurn();
      if (tainted) approvals.markTainted(t, 'web_fetch https://example.org/page');
      const r = await approvals.gate(t, kind, `Test ${kind}`, '', extra);
      return { asked: sent.length === 1, payload: sent[0], allow: r.allow, turn: t };
    },

    post: (p, body, headers = {}) => fetch(`${fx.base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),

    async pairDevice(deviceName) {
      const p = companion.startPairing();
      const r = await fx.post('/api/pair', { code: p.code, name: deviceName });
      return { Authorization: `Bearer ${(await r.json()).token}` };
    },

    /** A device's event stream; until() waits for a pattern (no fixed sleeps), events() parses one kind. */
    async openStream(auth) {
      const ctl = new AbortController();
      const res = await fetch(`${fx.base}/api/events`, { headers: auth, signal: ctl.signal });
      const reader = res.body.getReader();
      const s = { text: '' };
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            s.text += Buffer.from(value).toString();
          }
        } catch {
          /* closed */
        }
      })();
      s.until = async (re, ms = 4000) => {
        const end = Date.now() + ms;
        while (!re.test(s.text)) {
          if (Date.now() > end) throw new Error(`the stream never brought ${re}: ${s.text}`);
          await wait(15);
        }
      };
      s.events = (kind) => [...s.text.matchAll(new RegExp(`event: ${escapeRe(kind)}\\ndata: (.*)\\n`, 'g'))].map((m) => JSON.parse(m[1]));
      s.close = () => ctl.abort();
      await s.until(/: connected/);
      return s;
    },
  };

  if (server) {
    // main.js's companion hooks, with the real approvals behind respondApproval.
    test.before(async () => {
      companion.init({
        startTurn: async (t) => {
          fx.turns.push(t);
          fx.active.set(t.requestId, new AbortController());
          return { conversationId: t.conversationId || 'cNew' };
        },
        abortTurn: (requestId) => fx.active.get(requestId)?.abort(),
        respondApproval: (id, allow, reason) => approvals.respond(id, allow, reason),
        transcribe: async () => '',
        notify() {},
      });
      const port = await freePort();
      await companion.apply({ remote: { enabled: true, lan: false, port } });
      fx.base = `http://127.0.0.1:${port}`;
    });
  }
  test.after(async () => {
    if (server) await companion.stop();
    for (const d of [dir, esmDir]) {
      if (!d) continue;
      try {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* a temp folder Windows still holds: the OS cleans it up */
      }
    }
  });
  return fx;
};
module.exports.read = read;
