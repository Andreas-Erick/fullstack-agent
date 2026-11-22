// The phone client's ergonomics: errors in plain words (never "Failed to fetch" or "Error 503"), the
// keyboard decision, push-to-talk's tap-or-hold, how long a notice stays (renderer/remote/sync.js), and
// the source contracts around them in app.js, styles.css and the Android app.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// sync.js is an ES module in a CommonJS package: loaded from an .mjs copy (as test/sync.test.js does).
let mod = null;
const client = async () => {
  if (mod) return mod;
  const copy = path.join(tmpDir('nexus-phoneux-'), 'sync.mjs');
  fs.copyFileSync(path.join(ROOT, 'renderer/remote/sync.js'), copy);
  return (mod = await import(pathToFileURL(copy).href));
};

test('plainStatus: every status in words, never a bare number for the common ones', async () => {
  const { plainStatus } = await client();
  assert.match(plainStatus(401), /isn’t paired/);
  assert.match(plainStatus(403), /didn’t allow/);
  assert.match(plainStatus(404), /isn’t on the computer/);
  assert.match(plainStatus(408), /too long to answer/);
  assert.strictEqual(plainStatus(413, { recording: true }), 'That recording is too long.');
  assert.match(plainStatus(413), /too much to send/);
  assert.match(plainStatus(429), /Too many requests/);
  for (const n of [500, 502, 503, 504, 530, 599]) assert.match(plainStatus(n), /on the computer/, String(n));
  assert.match(plainStatus(418), /error 418/, 'another 4xx keeps its number for a report');
  assert.match(plainStatus('404'), /isn’t on the computer/, 'a numeric string counts');
  for (const odd of [0, NaN, undefined, null, '', 'abc', 200, 302, 399, 600, 404.5, -1, Infinity, {}]) {
    const s = plainStatus(odd);
    assert.strictEqual(s, 'Something went wrong. Try again.', `${String(odd)} → ${s}`);
    assert.doesNotMatch(s, /\d/);
  }
});

test('networkFailure: fetch’s TypeError is "can’t reach", nothing else is', async () => {
  const { networkFailure } = await client();
  assert.strictEqual(networkFailure(new TypeError('Failed to fetch')), true);
  assert.strictEqual(networkFailure(Object.assign(new Error('x'), { name: 'TypeError' })), true);
  for (const e of [new Error('boom'), new DOMException('aborted', 'AbortError'), null, undefined, '', 0, {}]) assert.strictEqual(networkFailure(e), false, String(e));
});

test('micError: the microphone’s failures in words; the app gets the app’s wording', async () => {
  const { micError } = await client();
  const err = (name) => Object.assign(new Error('raw browser text'), { name });
  assert.strictEqual(micError(err('NotFoundError')), 'No microphone found.');
  assert.strictEqual(micError(err('OverconstrainedError')), 'No microphone found.');
  assert.strictEqual(micError(err('NotReadableError')), 'Another app is using the microphone.');
  assert.match(micError(err('NotAllowedError')), /this page/, 'in a browser the page is what is allowed');
  assert.doesNotMatch(micError(err('NotAllowedError'), { app: true }), /page/, 'in the app it is the app');
  assert.match(micError(err('NotAllowedError'), { app: true }), /Tap the mic again/);
  for (const e of [err('WeirdError'), err(''), null, undefined, 'text', {}]) {
    const s = micError(e);
    assert.strictEqual(s, 'The microphone didn’t start. Try again.');
    assert.doesNotMatch(s, /raw browser text/);
  }
});

test('toastMs: at least 4 s (8 s with a button), about 60 ms a character, at most 12 s', async () => {
  const { toastMs } = await client();
  assert.strictEqual(toastMs(''), 4000);
  assert.strictEqual(toastMs(undefined), 4000);
  assert.strictEqual(toastMs(null), 4000);
  assert.strictEqual(toastMs('Copied'), 4000);
  assert.strictEqual(toastMs('x'.repeat(100)), 6000);
  assert.strictEqual(toastMs('x'.repeat(1000)), 12000);
  assert.strictEqual(toastMs('Hi', true), 8000);
  assert.strictEqual(toastMs('x'.repeat(150), true), 9000);
});

test('keyboardState: up only while typing in a window much shorter than its tallest; a rotation starts over', async () => {
  const { keyboardState, KBD_MIN } = await client();
  let s = keyboardState(null, { width: 360, height: 640, typing: false });
  assert.deepStrictEqual(s, { width: 360, tallest: 640, up: false });
  s = keyboardState(s, { width: 360, height: 640, typing: true });
  assert.strictEqual(s.up, false, 'focused, no keyboard yet');
  s = keyboardState(s, { width: 360, height: 330, typing: true });
  assert.deepStrictEqual(s, { width: 360, tallest: 640, up: true });
  assert.strictEqual(keyboardState(s, { width: 360, height: 330, typing: false }).up, false, 'not typing: the keyboard is closing');
  assert.strictEqual(keyboardState(s, { width: 360, height: 640 - KBD_MIN, typing: true }).up, false, 'exactly the threshold is not enough');
  assert.strictEqual(keyboardState(s, { width: 360, height: 640 - KBD_MIN - 1, typing: true }).up, true);
  // Turned sideways: the portrait height is no measure for landscape.
  const side = keyboardState(s, { width: 640, height: 360, typing: true });
  assert.deepStrictEqual(side, { width: 640, tallest: 360, up: false });
  assert.strictEqual(keyboardState(side, { width: 640, height: 200, typing: true }).up, true);
  // Odd input never throws and never claims a keyboard.
  for (const odd of [{}, { width: NaN, height: NaN, typing: true }, { width: 360, height: 0, typing: true }, undefined]) assert.strictEqual(keyboardState({ width: 0, tallest: 640 }, odd).up, false, JSON.stringify(odd));
});

test('releasePlan: a short press or one before the microphone started keeps listening; a hold sends', async () => {
  const { releasePlan, TAP_MS } = await client();
  assert.strictEqual(TAP_MS, 400);
  assert.strictEqual(releasePlan({ heldMs: 0 }), 'toggle');
  assert.strictEqual(releasePlan({ heldMs: TAP_MS - 1 }), 'toggle');
  assert.strictEqual(releasePlan({ heldMs: TAP_MS }), 'send');
  assert.strictEqual(releasePlan({ heldMs: 5000 }), 'send');
  assert.strictEqual(releasePlan({ heldMs: 5000, starting: true }), 'toggle', 'nothing recorded yet: listen until the next tap');
  for (const odd of [NaN, undefined, null, '', 'abc', -5]) assert.strictEqual(releasePlan({ heldMs: odd }), 'toggle', String(odd));
  assert.strictEqual(releasePlan(), 'toggle');
});

// ------------------------------------------------------------------ source contracts
test('the phone page never shows a bare status or the browser’s own error text', () => {
  const app = read('renderer/remote/app.js');
  assert.doesNotMatch(app, /`Error \$\{/, 'every status goes through plainStatus');
  assert.match(app, /networkFailure\(err\)\) throw new NetError/, 'fetchWithin turns "Failed to fetch" into NetError');
  assert.doesNotMatch(app, /Something went wrong: \$\{/, 'a script error is a plain sentence, its text under Details');
  assert.match(app, /toast\(micError\(err/, 'microphone errors in words');
  const screens = read('renderer/remote/screens.js');
  assert.doesNotMatch(screens, /couldn’t be drawn on this device: \$\{/, 'drawing failures keep their text under Details');
  assert.match(screens, /const details = \(err\)/);
});

test('push-to-talk works by tap, hold, keyboard and TalkBack, and says when it listens', () => {
  const app = read('renderer/remote/app.js');
  assert.match(app, /mic\.addEventListener\('click'/, 'Enter, Space and a screen reader’s double tap reach it as a click');
  assert.match(app, /releasePlan\(\{ heldMs, starting: rec\.starting \}\)/);
  assert.match(app, /setAttribute\('aria-pressed', 'true'\)/);
  assert.match(app, /setAttribute\('aria-pressed', 'false'\)/);
  assert.doesNotMatch(app, /Hold the button while you speak/);
  const html = read('renderer/remote/index.html');
  assert.match(html, /id="micBtn"[^>]*aria-pressed="false"/);
});

test('notices let taps through unless they carry a button; the list stays pinned when it shrinks', () => {
  const css = read('renderer/remote/styles.css');
  assert.match(css, /\.toast \{[^}]*pointer-events: none/);
  assert.match(css, /\.toast\.actionable \{[^}]*pointer-events: auto/);
  const app = read('renderer/remote/app.js');
  assert.match(app, /new ResizeObserver\(\(\) => stick &&/);
  assert.match(app, /document\.body\.classList\.toggle\('kbd', kbd\.up\)/);
  assert.match(css, /body\.kbd:not\(\.wide\):not\(\.face-full\) \.face-wrap, body\.kbd:not\(\.wide\):not\(\.face-full\) #tabs \{ display: none !important; \}/);
});

test('phone styles: theme colours only, 16 px search text, 48 px controls', () => {
  const css = read('renderer/remote/styles.css');
  // Masks use #000 as an alpha shape (not a colour anyone sees); text and borders never hard-code one.
  const colours = [...css.matchAll(/(?:^|[;{\s])(?:color|background|background-color|border(?:-\w+)?-color|border)\s*:[^;}]*#(?:fff|000|ffffff|000000)\b/gim)];
  assert.deepStrictEqual(colours.map((m) => m[0].trim()), [], 'no #fff / #000 text, background or border colours');
  assert.match(css, /\.input\.search \{[^}]*font-size: 16px/);
  for (const sel of ['\\.send \\{ width: 48px; height: 48px', '\\.mic \\{ width: 48px; height: 48px', '\\.jump \\{[^}]*width: 48px; height: 48px', '\\.arch-tool \\{ width: 48px; height: 48px', '\\.icon-btn \\{ width: 48px; height: 48px']) assert.match(css, new RegExp(sel), sel);
  assert.doesNotMatch(css, /\.sched-row\.past \{ opacity/, 'past entries step their colour down instead of fading');
  assert.match(css, /width: max\(100%, 48px\); height: max\(100%, 48px\)/, 'compact controls get a 48 px touch area');
});

test('Android: the microphone and notifications refused for good lead to the app’s settings', () => {
  const src = read('android/app/src/main/java/com/nexusagent/android/MainActivity.java');
  assert.match(src, /if \(!shouldShowRequestPermissionRationale\(Manifest\.permission\.RECORD_AUDIO\)\) runJs\("window\.nexusMicBlocked && nexusMicBlocked\(\)"\);\s*pendingPermission\.deny\(\);/, 'the page hears it before the refusal');
  assert.match(src, /public boolean backgroundEnabled\(\) \{\s*if \(!trusted\(\)\) return false;\s*boolean on = backgroundOn\(\);/, 'the switch shows what Android allows, not only the choice');
  assert.match(src, /return Prefs\.background\(this\) && notificationsAllowed\(\);/);
  assert.match(src, /areNotificationsEnabled\(\)/);
  assert.match(src, /protected void onResume\(\) \{[\s\S]*?backgroundOn\(\) != bgReported\) reportBackground\(/, 'checked again when the app comes back');
  assert.match(src, /Settings\.ACTION_APP_NOTIFICATION_SETTINGS/);
  assert.match(src, /Settings\.ACTION_APPLICATION_DETAILS_SETTINGS/);
  const app = read('renderer/remote/app.js');
  assert.match(app, /window\.nexusMicBlocked = /);
  assert.match(app, /bridge\('openAppSettings', 'app'\)/);
  assert.match(app, /bridge\('openAppSettings', 'notifications'\)/);
  assert.match(app, /window\.nexusBackgroundChanged = \(on, blocked = false\)/, 'an older app calls it with one argument');
});

test('Android: only the app’s own Talk tile and shortcut can start push-to-talk (SEC-08)', () => {
  const dir = 'android/app/src/main/java/com/nexusagent/android/';
  const main = read(dir + 'MainActivity.java');
  // MainActivity is exported (launcher, share, pairing link): a TALK intent needs the per-install key.
  assert.match(main, /else if \(ACTION_TALK\.equals\(intent\.getAction\(\)\) && Prefs\.isTalkSecret\(this, intent\.getStringExtra\(EXTRA_TALK_KEY\)\)\) \{/);
  assert.strictEqual((main.match(/ACTION_TALK\.equals\(/g) || []).length, 1, 'no other way in');
  assert.match(main, /\.putExtra\(EXTRA_TALK_KEY, Prefs\.talkSecret\(c\)\)/);
  const prefs = read(dir + 'Prefs.java');
  assert.match(prefs, /new java\.security\.SecureRandom\(\)\.nextBytes\(b\)/, 'a random key per install');
  assert.match(prefs, /MessageDigest\.isEqual\(/, 'compared in constant time');
  assert.match(read(dir + 'TalkTileService.java'), /Intent i = MainActivity\.talkIntent\(this\);/);
  assert.match(read(dir + 'TalkActivity.java'), /startActivity\(MainActivity\.talkIntent\(this\)\);/);
  // The static shortcut can't carry a secret: it goes through TalkActivity, which other apps can't start.
  assert.match(read('android/app/src/main/res/xml/shortcuts.xml'), /android:targetClass="com\.nexusagent\.android\.TalkActivity"/);
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android:name="\.TalkActivity"[^>]*android:exported="false"/);
  assert.doesNotMatch(manifest, /com\.nexusagent\.android\.TALK/, 'no intent filter advertises TALK');
});

test('phone Markdown can never stand in for the page’s own elements (SEC-03)', async () => {
  const { PHONE_PURIFY } = await client();
  // As strict as the desktop's MD_PURIFY: no form controls, frames or dialogs, ids prefixed.
  for (const tag of ['textarea', 'select', 'option', 'button', 'input', 'form', 'iframe', 'dialog', 'template', 'style', 'object', 'embed', 'base']) assert.ok(PHONE_PURIFY.FORBID_TAGS.includes(tag), tag);
  for (const attr of ['style', 'for', 'form', 'formaction', 'action']) assert.ok(PHONE_PURIFY.FORBID_ATTR.includes(attr), attr);
  assert.strictEqual(PHONE_PURIFY.SANITIZE_NAMED_PROPS, true, 'ids and names get the user-content- prefix');
  assert.ok(Object.isFrozen(PHONE_PURIFY));
  const app = read('renderer/remote/app.js');
  assert.match(app, /window\.DOMPurify\.sanitize\(html, \{ \.\.\.PHONE_PURIFY \}\)/, 'markdown() uses the profile');
  // The message box is taken once, before anything is drawn; Send never looks it up again.
  assert.match(app, /^const inputEl = document\.getElementById\('input'\);$/m);
  assert.doesNotMatch(app, /\$\('#input'\)|querySelector\('#input'\)/, 'no lookup of #input after load');
});
