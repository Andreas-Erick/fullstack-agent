// The first-run setup stays true to the app: the wizard's face list keeps the default face, the tour
// names the voice in use, the setup conversation's script matches how voices and approvals work now,
// and every view's advertised shortcut really works.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, stub, load, tmpDir, quietLog } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const dir = tmpDir('nexus-onboard-');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function loadCore() {
  const copy = path.join(dir, 'onboardcore.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/js/onboardcore.js'), copy);
  return import(pathToFileURL(copy).href);
}

const BUILT = [{ id: 'siren', title: 'Siren', tagline: 'older' }, { id: 'radial', title: 'Radial', tagline: 'bars' }];
const OWN = [{ id: 'custom:siren', title: 'Siren', tagline: 'on her rock' }];

test('the wizard lists the default custom face first, selectable, and tells the two Sirens apart', async () => {
  const { faceChoices } = await loadCore();
  const list = faceChoices('custom:siren', OWN, BUILT);
  assert.deepStrictEqual(list.map((f) => f.value), ['custom:siren', 'siren', 'radial']);
  assert.strictEqual(list[0].title, 'Siren');
  assert.strictEqual(list[1].title, 'Siren (built-in)');
  assert.strictEqual(list[2].title, 'Radial');
});

test('the face in use is always offered, even if its folder could not be listed', async () => {
  const { faceChoices } = await loadCore();
  const list = faceChoices('custom:siren', [], BUILT);
  assert.strictEqual(list[0].value, 'custom:siren');
  assert.strictEqual(faceChoices('radial', [], BUILT).length, 2);
});

test('the face in use comes first, ahead of example faces', async () => {
  const { faceChoices } = await loadCore();
  const list = faceChoices('custom:siren', [{ id: 'custom:rings', title: 'Pulse Rings' }, ...OWN], BUILT);
  assert.deepStrictEqual(list.map((f) => f.value), ['custom:siren', 'custom:rings', 'siren', 'radial']);
  assert.strictEqual(faceChoices('radial', OWN, BUILT)[0].value, 'radial');
});

// Regression: "Skip setup" on the first page set `onboarded` without the privacy and safety notice ever
// being accepted, and nothing asked for it again.
test('every way through the wizard passes the privacy step before it can finish', async () => {
  const { STEPS, stepsFor, finishPatch } = await loadCore();
  for (const mode of ['full', 'quick', 'missed', undefined]) {
    const steps = stepsFor(mode);
    assert.ok(steps.includes('privacy'), `${mode}: has the privacy step`);
    assert.ok(steps.every((s) => STEPS.includes(s)), `${mode}: only real steps`);
  }
  assert.deepStrictEqual(stepsFor('quick'), ['welcome', 'privacy', 'brain'], 'Quick start: privacy, then the brain finder');
  assert.ok(stepsFor('quick').indexOf('privacy') < stepsFor('quick').indexOf('brain'), 'privacy before the brain');
  assert.deepStrictEqual(stepsFor('missed'), ['privacy']);
  assert.strictEqual(finishPatch({ privacy: { acceptedAt: 0 } }), null, 'not accepted: not onboarded');
  assert.strictEqual(finishPatch({}), null);
  assert.deepStrictEqual(finishPatch({ privacy: { acceptedAt: 1763000000000 } }), { onboarded: true });
});

test('an install set up without accepting the notice sees that step once at launch', async () => {
  const { launchMode } = await loadCore();
  assert.strictEqual(launchMode({ onboarded: false, privacy: { acceptedAt: 0 } }), 'full', 'first run: the whole wizard');
  assert.strictEqual(launchMode({ onboarded: true, privacy: { acceptedAt: 0 } }), 'missed');
  assert.strictEqual(launchMode({ onboarded: true }), 'missed', 'an install from before the notice');
  assert.strictEqual(launchMode({ onboarded: true, privacy: { acceptedAt: 1763000000000 } }), '', 'accepted: nothing');
  // The memory-profile smoke run (NEXUS_SMOKE_MEM) starts set up and accepted, so it measures the app,
  // not this screen; a plain smoke run starts with no settings and meets the whole wizard ('full').
  assert.match(read('main/smoke.js'), /onboarded: true, privacy: \{ acceptedAt: Date\.now\(\) \}/);
});

test('the wizard saves `onboarded` only through the helper, and boots through the launch check', () => {
  const src = read('renderer/js/onboarding.js');
  assert.ok(!/onboarded: true/.test(src), 'no path sets onboarded by itself');
  assert.match(src, /const patch = finishPatch\(state\.settings\);\s*if \(!patch\)/);
  assert.match(src, /await saveSettings\(patch\);/);
  assert.ok(!src.includes('Skip setup'), 'nothing offers to skip the privacy step');
  // Close on the first page only once the notice is accepted; a double click moves one step, never past the last.
  assert.match(src, /accepted\(s\) \? el\('button', \{[^}]*onclick: \(\) => finish\(\) \}, 'Close'\)/);
  assert.match(src, /step = Math\.max\(0, Math\.min\(stepsFor\(mode\)\.length - 1, step \+ delta\)\);/);
  // The first acceptance's time stays when the step is passed again.
  assert.match(src, /if \(!accepted\(state\.settings\)\) await saveSettings\(\{ privacy: \{ acceptedAt: Date\.now\(\) \} \}\);/);
  // Boot: the launch greeting waits until the missed privacy step is accepted (not spoken over it).
  const app = read('renderer/js/app.js');
  assert.match(app, /const setupOpen = maybeStartOnboarding\(\{ then: greetOnLaunch \}\);/);
  assert.match(app, /if \(!setupOpen\) greetOnLaunch\(\);/);
  assert.match(src, /if \(how\) startOnboarding\(how, how === 'missed' \? then : null\);\s*return how;/);
});

test('the wizard speaks of Settings only, and its face list comes from the helper', () => {
  const src = read('renderer/js/onboarding.js');
  assert.ok(!src.includes('Config →'));
  assert.match(src, /choices\(faceChoices\(/);
  assert.match(src, /documents: \{ workspace: d \}/, 'the wizard offers the workspace folder');
  assert.match(src, /stt: \{ engine: v \}/, 'the wizard offers cloud speech recognition');
});

test('the tour names the voice engine in use', () => {
  stub({ './store': { getSettings: async () => ({}) }, './logger': quietLog });
  const { FEATURES } = load('main/guide.js');
  const talk = FEATURES.find((f) => f.id === 'talk');
  const status = (engine) => talk.status({ voice: { ttsEnabled: true, engine }, stt: { enabled: true, micMode: 'ptt', pttKey: 'F8' } });
  assert.match(status('local'), /offline voice/);
  assert.match(status('cloud'), /cloud voice/);
  assert.match(status('voicestudio'), /VoiceStudio/);
  assert.match(talk.what, /cloud voice/);
  assert.match(FEATURES.find((f) => f.id === 'safety').what, /problem report/);
});

test('the setup conversation describes today\'s voices, faces and approvals', () => {
  const src = read('main/prompt.js');
  const script = src.slice(src.indexOf('function buildSetup'));
  assert.ok(!/built-in voice/.test(script), 'the offline voice is the fallback, not the system voice');
  assert.match(script, /offline voice/);
  assert.match(script, /voice\.engine to "voicestudio"/);
  assert.match(script, /custom:siren/);
  assert.match(script, /always ask before changing your own code/);
});

test('the setup conversation can pick a voice engine, but never the cloud voice', () => {
  const tools = read('main/tools.js');
  assert.match(/const SETUP_SETTABLE = \[([\s\S]*?)\];/.exec(tools)[1], /'voice\.engine'/);
  assert.match(tools, /a\.setting === 'voice\.engine' && !\['local', 'voicestudio'\]\.includes\(value\)/);
});

test('the setup conversation offers local models and the form for several providers', () => {
  const src = read('renderer/js/setup.js');
  assert.match(src, /value: 'local'/);
  assert.match(src, /value: 'form'/);
  assert.match(src, /api\.llm\.localModels\(\)/);
});

test('every shortcut a rail button advertises opens that view', () => {
  const html = read('renderer/index.html');
  const app = read('renderer/js/app.js');
  const views = JSON.parse(/const views = (\[[^\]]*\]);/.exec(app)[1].replace(/'/g, '"'));
  const top = Math.max(...[...app.matchAll(/Digit\[1-(\d)\]/g)].map((m) => Number(m[1])));
  const buttons = [...html.matchAll(/data-view="(\w+)" title="[^"]*\(Ctrl\+(\d)\)"/g)];
  assert.ok(buttons.length >= 9);
  for (const [, view, key] of buttons) {
    assert.strictEqual(views[Number(key) - 1], view, `Ctrl+${key}`);
    assert.ok(Number(key) <= top, `Ctrl+${key} is handled (keys up to ${top})`);
  }
});

// The brain finder (spec #17): what the first-run wizard preselects, offers and says, from what was found
// on this computer. A fresh install's settings: the default brain (claude-code), no keys, nothing local.
const FRESH = { llm: { provider: 'claude-code' }, local: { baseUrl: '', model: '' }, gemini: { apiKey: '' }, groq: { apiKey: '' }, anthropic: { apiKey: '' } };
const NOTHING = { claude: 'missing', local: [], keys: { gemini: false, groq: false, anthropic: false } };
const OLLAMA = [{ server: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2:3b' }];

test('the brain finder preselects a signed-in Claude account', async () => {
  const { brainPlan } = await loadCore();
  const plan = brainPlan({ ...NOTHING, claude: 'ready' }, FRESH);
  assert.strictEqual(plan.preselect, 'claude-code');
  assert.strictEqual(plan.cards[0].id, 'claude-code', 'what works comes first');
  assert.strictEqual(plan.cards[0].works, true);
});

test('signed out or missing Claude, with an Ollama model running: the local model is preselected', async () => {
  const { brainPlan } = await loadCore();
  for (const claude of ['signedOut', 'missing', 'unchecked']) {
    const plan = brainPlan({ ...NOTHING, claude, local: OLLAMA }, FRESH);
    assert.strictEqual(plan.preselect, 'local', claude);
    assert.strictEqual(plan.cards[0].id, 'local');
  }
});

test('nothing found: the free Gemini card is preselected and comes first', async () => {
  const { brainPlan } = await loadCore();
  const plan = brainPlan(NOTHING, FRESH);
  assert.strictEqual(plan.preselect, 'gemini');
  assert.strictEqual(plan.cards[0].id, 'gemini');
  assert.strictEqual(plan.cards[0].free, true);
  assert.match(plan.cards[0].title, /^Free, nothing to install/);
  assert.ok(plan.cards.every((c) => !c.works), 'nothing claims to work');
  assert.ok(plan.cards.some((c) => c.id === 'claude-code'), 'the Claude plan is still offered');
  assert.ok(!plan.cards.some((c) => c.id === 'openai'), 'the advanced server card only for those who use it');
});

test('a saved Gemini key is preselected; what works comes before the free option and the rest', async () => {
  const { brainPlan } = await loadCore();
  const plan = brainPlan({ ...NOTHING, keys: { gemini: true } }, { ...FRESH, gemini: { apiKey: 'AIza…' } });
  assert.strictEqual(plan.preselect, 'gemini');
  const both = brainPlan({ ...NOTHING, claude: 'ready', local: OLLAMA }, FRESH);
  assert.deepStrictEqual(both.cards.slice(0, 3).map((c) => c.id), ['claude-code', 'local', 'gemini'], 'works, works, then free');
  assert.deepStrictEqual(brainPlan({ ...NOTHING, keys: { anthropic: true } }, FRESH).preselect, 'anthropic');
  assert.deepStrictEqual(brainPlan({ ...NOTHING, keys: { groq: true } }, FRESH).preselect, 'auto', 'a Groq key runs through several providers');
});

test('Start only after a test answered for the chosen brain; until then a plain warning', async () => {
  const { brainPlan } = await loadCore();
  const ready = { ...NOTHING, claude: 'ready' };
  const before = brainPlan(ready, FRESH);
  assert.strictEqual(before.canStart, false, 'set up is not tested');
  assert.ok(before.warn, 'a warning while untested');
  assert.strictEqual(brainPlan(ready, FRESH, { tested: 'gemini' }).canStart, false, 'another brain\'s test does not count');
  const after = brainPlan(ready, FRESH, { tested: 'claude-code' });
  assert.strictEqual(after.canStart, true);
  assert.strictEqual(after.warn, '');
  const switched = brainPlan(ready, FRESH, { chosen: 'gemini', tested: 'claude-code' });
  assert.strictEqual(switched.chosen, 'gemini');
  assert.strictEqual(switched.canStart, false, 'picking another card needs its own test');
  assert.match(brainPlan(NOTHING, FRESH).warn, /can’t answer yet/);
  assert.match(brainPlan(NOTHING, FRESH, { chosen: 'nonsense', tested: 'nonsense' }).warn, /can’t answer yet/, 'an unknown card is no brain');
});

test('setup reopened from Settings keeps the brain already set up', async () => {
  const { brainPlan } = await loadCore();
  const local = { ...FRESH, llm: { provider: 'local' }, local: { baseUrl: 'http://localhost:1234/v1', model: 'qwen3' } };
  assert.strictEqual(brainPlan({ ...NOTHING, claude: 'ready' }, local).preselect, 'local', 'a configured local model, even with Claude ready');
  const server = { ...FRESH, llm: { provider: 'openai', baseUrl: 'http://localhost:3001/v1' } };
  const plan = brainPlan({ ...NOTHING, claude: 'ready' }, server);
  assert.strictEqual(plan.preselect, 'openai');
  assert.ok(plan.cards.find((c) => c.id === 'openai').works, 'shown as set up');
  const key = { ...FRESH, llm: { provider: 'anthropic' }, anthropic: { apiKey: 'sk-ant' } };
  assert.strictEqual(brainPlan({ ...NOTHING, claude: 'ready', keys: { anthropic: true } }, key).preselect, 'anthropic');
  // A current brain that isn't set up gives way to what works.
  assert.strictEqual(brainPlan({ ...NOTHING, claude: 'ready' }, { ...FRESH, llm: { provider: 'anthropic' } }).preselect, 'claude-code');
});

test('the wizard tells the truth about the brain: a warning on Next, Fix this and Set up a brain first on First hello', () => {
  const src = read('renderer/js/onboarding.js');
  // The brain step is drawn from the plan, from the checks that already exist (no new probing).
  assert.match(src, /api\.llm\.brains\(\{ fresh: true, all: true \}\)/);
  assert.match(src, /api\.llm\.localModels\(\)/);
  assert.match(src, /detectionFrom\(catalogue, servers\)/);
  assert.match(src, /brainPlan\(finder\.detection \|\| NOTHING_FOUND, state\.settings, finder\)/);
  // Claude Code: a plain line and the official page, never a terminal command as the only way.
  assert.match(src, /api\.shell\.openExternal\(CLAUDE_CODE_URL\)/);
  assert.ok(!/isn’t installed\. Install it, then click Re-check/.test(src), 'the old terminal-command line is gone');
  assert.match(src, /api\.shell\.openExternal\(FREE_KEY_URL\) \}, '🔑 Get my free key'\)/);
  // Next in the full wizard without a brain that answered: warned once, and staying is the default.
  assert.match(src, /if \(!plan\.canStart && mode === 'full' && !\(await warnOnce\(plan\.warn\)\)\) return false;/);
  assert.match(src, /if \(\(await beforeNext\(\)\) === false\) return;/);
  assert.match(src, /'Continue anyway'/);
  assert.match(src, /'Set it up now'/);
  // Quick start's last step: Start only once the test answered, Do this later says so plainly.
  assert.match(src, /disabled: !ready,[^\n]*'Start ›'\)/);
  assert.match(src, /'Do this later'/);
  assert.match(src, /if \(!plan\.canStart && plan\.warn\) toast\(plan\.warn/);
  // First hello: the failed brain row gets Fix this, and the main button stops promising an interview.
  assert.match(src, /brain\.action\(el\('button', \{ class: 'btn small', onclick: fix \}, 'Fix this'\)\)/);
  assert.match(src, /if \(finder\.helloFailed\) return el\('div', \{ class: 'row' \}, el\('button', \{ class: 'btn', onclick: \(\) => finish\(\) \}, 'Start without a brain'\), el\('button', \{ class: 'btn primary', onclick: toBrain \}, 'Set up a brain first ›'\)\);/);
});

test('the finder reads what the app already checks: the brain catalogue and the local servers', async () => {
  const { detectionFrom } = await loadCore();
  const catalogue = { brains: [{ id: 'claude-code', state: 'signedOut', ready: false }, { id: 'gemini', state: 'ready', ready: true }, { id: 'groq', state: 'notSetUp', ready: false }, { id: 'anthropic', state: 'notSetUp', ready: false }] };
  const servers = [{ id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', running: true, models: [{ id: 'llama3.2:3b', name: 'llama3.2:3b' }] }, { id: 'lmstudio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', running: false, models: [] }];
  assert.deepStrictEqual(detectionFrom(catalogue, servers), {
    claude: 'signedOut',
    local: [{ server: 'Ollama', baseUrl: 'http://localhost:11434/v1', model: 'llama3.2:3b', name: 'llama3.2:3b' }],
    keys: { gemini: true, groq: false, anthropic: false },
  });
  assert.deepStrictEqual(detectionFrom(null, null), { claude: 'unchecked', local: [], keys: { gemini: false, groq: false, anthropic: false } }, 'a failed check finds nothing and claims nothing');
});

test('a brain card writes only the provider and its own key or detected model', async () => {
  const { brainPatch } = await loadCore();
  assert.deepStrictEqual(brainPatch('gemini', { key: '  AIza123 ' }), { llm: { provider: 'gemini' }, gemini: { apiKey: 'AIza123' } });
  assert.deepStrictEqual(brainPatch('gemini'), { llm: { provider: 'gemini' } }, 'no key typed: the provider only');
  assert.deepStrictEqual(brainPatch('local', { local: OLLAMA[0] }), { llm: { provider: 'local' }, local: { model: 'llama3.2:3b', baseUrl: 'http://localhost:11434/v1' } });
  assert.deepStrictEqual(brainPatch('claude-code', { key: 'x' }), { llm: { provider: 'claude-code' } }, 'no key for the Claude plan');
  assert.deepStrictEqual(brainPatch('anthropic', { key: 'sk-ant-1' }), { llm: { provider: 'anthropic' }, anthropic: { apiKey: 'sk-ant-1' } });
});

// Wizard copy and reassurance (#19): the progress in three phases, the privacy step in short lines, the
// Obsidian option only for Obsidian users, and the plain words a newcomer reads.
test('the progress reads "about 3 minutes" in three phases; Quick start says one step after privacy', async () => {
  const { wizardProgress } = await loadCore();
  const at = (id) => wizardProgress('full', id);
  assert.strictEqual(at('welcome').label, 'Setup · about 3 minutes');
  assert.deepStrictEqual(at('welcome').phases.map((p) => p.name), ['Basics', 'Brain & voice', 'You']);
  assert.deepStrictEqual(at('privacy').phases.map((p) => p.state), ['current', 'todo', 'todo']);
  assert.deepStrictEqual(at('vault').phases.map((p) => p.state), ['done', 'current', 'todo']);
  assert.deepStrictEqual(at('hello').phases.map((p) => p.state), ['done', 'done', 'current']);
  assert.strictEqual(wizardProgress('quick', 'brain').label, 'Start now (1 step after privacy)');
  assert.strictEqual(wizardProgress('missed', 'privacy').label, 'Before you go on');
  assert.deepStrictEqual(wizardProgress('missed', 'privacy').phases, []);
  assert.ok(!/Step \d+ of/.test(JSON.stringify(['welcome', 'brain', 'hello'].map(at))), 'no "Step N of 11"');
});

test('every step of the full setup belongs to exactly one phase, in order', async () => {
  const { PHASES, STEPS } = await loadCore();
  assert.deepStrictEqual(PHASES.flatMap((p) => p.steps), STEPS);
});

test('the privacy step is five one-line points, each with its details folded away', async () => {
  const { PRIVACY_POINTS } = await loadCore();
  assert.strictEqual(PRIVACY_POINTS.length, 5);
  for (const p of PRIVACY_POINTS) {
    assert.ok(p.ico && p.line && p.more, `${p.line}: icon, line and details`);
    assert.ok(p.line.length <= 70, `one short line: ${p.line}`);
    assert.ok(!/[.:;]\s+\S/.test(p.line), `one sentence: ${p.line}`);
    assert.ok(p.more.length > p.line.length, 'the details say more than the line');
  }
  const text = JSON.stringify(PRIVACY_POINTS);
  for (const must of ['no account', 'MIT License', 'ask you first', 'leaves', 'charges']) assert.ok(text.includes(must), `still says: ${must}`);
  const src = read('renderer/js/onboarding.js');
  assert.match(src, /PRIVACY_POINTS\.map\(/);
  assert.match(src, /el\('details', \{ class: 'ob-point'/);
});

test('the Obsidian vault-list option shows only when Obsidian is found, and is off unless turned on', async () => {
  const { registerOffer } = await loadCore();
  assert.deepStrictEqual(registerOffer(false), { show: false, checked: false });
  assert.deepStrictEqual(registerOffer(false, true), { show: false, checked: false }, 'never ticked out of sight');
  assert.deepStrictEqual(registerOffer(true), { show: true, checked: false });
  assert.deepStrictEqual(registerOffer(true, true), { show: true, checked: true });
});

test('the wizard says once that changes save as you go and stay on this PC', async () => {
  const { SAVES_LINE } = await loadCore();
  assert.strictEqual(SAVES_LINE, 'Changes save as you go · everything stays on this PC · you can run this again from Settings → System.');
  assert.match(read('renderer/js/onboarding.js'), /el\('p', \{ class: 'ob-saves' \}, SAVES_LINE\)/);
  // Settings → System really holds the way back into setup.
  assert.match(read('renderer/js/settingstabs.js'), /id: 'system'[^\n]*'health'/);
  assert.match(read('renderer/js/settings/system.js'), /startOnboarding\(\)/);
});

test('the wizard speaks plainly: product names only as small print', () => {
  const src = read('renderer/js/onboarding.js');
  for (const plain of ['Speak replies out loud', 'How ${name} hears you', 'Where ${name} keeps your notes and memories', 'A folder of ordinary text files on this PC', 'Describe her personality', 'Link Gmail, Calendar and more (optional, later)']) assert.ok(src.includes(plain), `says: ${plain}`);
  for (const jargon of ['Memory vault', "'Master prompt'", "'VoiceStudio URL'", 'Groq (Orpheus)', 'Who writes down what you say?', 'Step ${step + 1} of', 'labelled Config']) assert.ok(!src.includes(jargon), `no longer says: ${jargon}`);
  // The vault-list option: only when Obsidian is found (registerOffer), never ticked by default.
  assert.ok(!/draft\.register \?\?= true/.test(src));
  assert.match(src, /registerOffer\(/);
  assert.match(src, /api\.obsidian\.installed\(\)/);
});

test('Obsidian counts as found when its vault list exists', async () => {
  const reg = path.join(dir, 'obsidian.json');
  process.env.NEXUS_OBSIDIAN_REGISTRY = reg;
  stub({
    electron: { app: { getPath: () => dir } },
    './logger': quietLog,
    './vaultgit': { commitSoon() {}, ensure: async () => {} },
    './store': { getSettings: async () => ({ obsidian: { enabled: false } }) },
  });
  try {
    const obsidian = load('main/obsidian.js');
    assert.strictEqual(await obsidian.obsidianInstalled(), false);
    fs.writeFileSync(reg, JSON.stringify({ vaults: {} }));
    assert.strictEqual(await obsidian.obsidianInstalled(), true);
  } finally {
    delete process.env.NEXUS_OBSIDIAN_REGISTRY;
  }
});

test('the smoke check never touches the real Obsidian vault list', () => {
  assert.match(read('main/smoke.js'), /process\.env\.NEXUS_OBSIDIAN_REGISTRY \|\|= path\.join\(dir, 'obsidian\.json'\)/);
});
