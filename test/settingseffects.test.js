// settingseffects.js: what a settings save sets in motion beyond the file, for every save (the window, a
// tool, a persona switch, a reset), through the real store's onChange with stand-ins for the effects.
const test = require('node:test');
const assert = require('node:assert');
const { stub, load, tmpDir, quietLog } = require('./helpers');

const dir = tmpDir('siren-effects-');
const electron = new Proxy(function () {}, {
  get: (_t, p) => (p === 'then' ? undefined : p === 'getPath' ? () => dir : p === 'isPackaged' ? false : p === 'safeStorage' ? { isEncryptionAvailable: () => false } : electron),
  apply: () => electron,
  construct: () => electron,
});
stub({ electron, './logger': quietLog });
const store = load('main/store.js');
const braincore = load('main/braincore.js');
const effects = load('main/settingseffects.js');

// Records what ran; `fail` names effects that throw (or reject).
function setup({ fail = [] } = {}) {
  const did = [];
  const warned = [];
  const boom = (name) => {
    if (fail.includes(name)) throw new Error(`${name} broke`);
  };
  effects.init(
    {
      store,
      log: { ...quietLog, warn: (event, data) => warned.push({ event, data }), setDebug: (on) => (boom('logging'), did.push(`logging:${on}`)) },
      companion: {
        apply: async (s) => {
          await new Promise((r) => setTimeout(r, 20));
          if (fail.includes('remote')) throw new Error('remote broke');
          did.push(`remote:${s.remote.enabled}`);
        },
        settingsChanged: () => (boom('devices'), did.push('devices')),
      },
      helperApps: { ensureAll: (s, reason) => (boom('helper apps'), did.push(`helper apps:${reason}`)) },
      router: { reset: () => (boom('router'), did.push('router')) },
      registerShortcut: async () => did.push('shortcut'),
      toWindow: (ch, v) => did.push(`${ch}:${JSON.stringify(v)}`),
      persona: { ensureSummary: async () => ({ ok: true }) },
    },
    { summaryAfterStartMs: null },
  );
  return { did, warned };
}

test.afterEach(() => effects.stop());

test('the router sections come from router.js', () => {
  for (const k of ['claudeCode', 'anthropic', 'gemini', 'deepseek', 'groq', 'perplexity', 'local']) assert.ok(effects.ROUTER_SECTIONS.includes(k), k);
  assert.ok(!effects.ROUTER_SECTIONS.includes('llm'), 'llm counts only by its own routing fields');
});

// Regression: brain_switch saved through store.setSettings, which never ran main.js's applySaved, so the
// router kept the old brain's cooldowns and plan.
test('a brain switch from a tool resets the router', async () => {
  const { did } = setup();
  await store.setSettings(braincore.patchFor('gemini', { model: 'gemini-2.5-flash' }));
  await effects.settled();
  assert.ok(did.includes('router'));
  did.length = 0;
  await store.setSettings({ llm: { autoPace: false } });
  assert.ok(!did.includes('router'), 'a field of llm that has nothing to do with routing leaves the cooldowns');
});

// Regression: setup_check_service wrote llm.baseUrl / voice.baseUrl but never started the helper app.
test('a helper app address saved by a tool starts the app', async () => {
  const { did } = setup();
  await store.setSettings({ voice: { baseUrl: 'http://127.0.0.1:8000', ttsEnabled: true } });
  assert.ok(did.includes('helper apps:settings'));
  did.length = 0;
  await store.setSettings({ llm: { baseUrl: 'http://127.0.0.1:3001/v1' } });
  assert.deepStrictEqual(did.filter((d) => d !== 'devices').sort(), ['helper apps:settings', 'router']);
});

test('a remote patch starts remote access, and settled() waits for it', async () => {
  const { did } = setup();
  await store.setSettings({ remote: { enabled: false, port: 7823 } });
  assert.ok(!did.includes('remote:false'), 'still starting');
  await effects.settled();
  assert.ok(did.includes('remote:false'), 'settled once companion.apply finished');
});

test('a reset (every section as the patch) triggers every effect', async () => {
  const { did } = setup();
  await store.resetSettings();
  await effects.settled();
  for (const e of ['shortcut', 'logging:false', 'remote:false', 'devices', 'helper apps:settings', 'router']) assert.ok(did.includes(e), e);
  assert.ok(did.some((d) => d.startsWith('claude:connectorLevels:')), 'the window gets the connector levels');
});

test('an effect that throws or rejects does not stop the others', async () => {
  const { did, warned } = setup({ fail: ['logging', 'devices', 'remote'] });
  await store.setSettings({ logging: { debug: true }, remote: { port: 7824 }, routing: { smart: true } });
  await effects.settled();
  assert.ok(did.includes('router') && did.includes('helper apps:settings'));
  assert.deepStrictEqual(warned.filter((w) => w.event === 'settings effect failed').map((w) => w.data.effect).sort(), ['devices', 'logging', 'remote access']);
  assert.ok(warned.every((w) => w.data.error instanceof Error), 'the Error itself is logged');
});

test('a refused voice shortcut is logged as data, never as a failed effect with an Error', async () => {
  const warned = [];
  effects.init(
    {
      store,
      log: { ...quietLog, warn: (event, data) => warned.push({ event, data }), setDebug() {} },
      companion: { apply: async () => {}, settingsChanged() {} },
      helperApps: { ensureAll() {} },
      router: { reset() {} },
      registerShortcut: async () => {
        throw new Error('Foo+Bar is not a valid accelerator');
      },
      toWindow() {},
      persona: { ensureSummary: async () => ({}) },
    },
    { summaryAfterStartMs: null },
  );
  await store.setSettings({ stt: { globalShortcut: 'Foo+Bar' } });
  await effects.settled();
  assert.deepStrictEqual(warned, [{ event: 'voice shortcut not registered', data: { accel: 'Foo+Bar', reason: 'Foo+Bar is not a valid accelerator' } }]);
});

test('a dropped persona save triggers nothing', async () => {
  const { did } = setup();
  const active = (await store.getSettings()).personas.active;
  await assert.rejects(store.setSettings({ agent: { personality: 'x' }, llm: { provider: 'gemini' } }, { persona: `${active}-not` }), { code: store.PERSONA_CHANGED });
  await store.setSettings(() => null); // nothing to save
  assert.deepStrictEqual(did, []);
});

test('connector levels saved elsewhere reach the window', async () => {
  const { did } = setup();
  await store.setSettings({ claudeCode: { connectorsReadOnly: ['Slack'] } });
  const line = did.find((d) => d.startsWith('claude:connectorLevels:'));
  assert.ok(line && JSON.parse(line.slice('claude:connectorLevels:'.length)).connectorsReadOnly.includes('Slack'));
});
