// Approvals on a paired phone: a heading for every always-asking kind on both screens, a Stop on the phone
// closing its approval card (and refusing a late answer), a web_outbound approval answered there with its
// warning, and a desktop-only approval that the Android notification offers no Allow or Deny for.
const test = require('node:test');
const assert = require('node:assert');
const fx = require('./appfixture')('phoneapprovals', { server: true });
const { store, approvals, companion, active, read, pairDevice, post, openStream } = fx;

const kindsOf = (file, name) => new Set([...new RegExp(`const ${name} = \\{([\\s\\S]*?)\\};`).exec(read(file))[1].matchAll(/(\w+):\s*'/g)].map((m) => m[1]));

test('the phone and the desktop have a heading for web_outbound and every always-asking kind', () => {
  const phone = kindsOf('renderer/remote/approvals.js', 'KIND');
  const desktop = kindsOf('renderer/js/approval.js', 'KIND_LABEL');
  for (const kind of new Set([...approvals.ALWAYS_ASK, ...approvals.TAINT_ASKS, ...approvals.TAINT_EACH_TIME, 'web_outbound'])) {
    assert.ok(phone.has(kind), `the phone's card has no heading for ${kind}`);
    assert.ok(desktop.has(kind), `the desktop dialog has no heading for ${kind}`);
  }
});

test('a Stop on the phone closes its approval card: approval.cancel with its id, and the answer after it is refused', async () => {
  approvals.setSender((channel, payload) => companion.publish(channel, payload)); // main.js send()
  const auth = await pairDevice('Stop phone');
  const { requestId } = await (await post('/api/chat', { text: 'push my branch' }, auth)).json();
  const controller = active.get(requestId);
  assert.ok(controller, 'the turn was started');
  const stream = await openStream(auth);
  try {
    const question = approvals.gate(approvals.newTurn({ signal: controller.signal }), 'github_publish', 'Push branch fix-1', 'git push origin fix-1');
    await stream.until(/event: approval\.request\n/);
    const [req] = stream.events('approval.request');
    assert.strictEqual(req.kind, 'github_publish');
    assert.strictEqual(req.voice, 'key');
    assert.strictEqual(req.desktopOnly, true, 'publishing is answered on the computer (SEC-05)');
    assert.strictEqual((await post(`/api/chat/${requestId}/abort`, {}, auth)).status, 200, 'the phone’s Stop');
    assert.deepStrictEqual(await question, { allow: false, reason: 'The reply was stopped.' });
    await stream.until(/event: approval\.cancel\n/);
    assert.deepStrictEqual(stream.events('approval.cancel'), [{ id: req.id }], 'closed as on a time-out (no "answered")');
    const late = await post(`/api/approvals/${req.id}`, { allow: true }, auth);
    assert.strictEqual(late.status, 404);
  } finally {
    stream.close();
  }
  // The phone closes the card the event names, the one addApproval made.
  const app = read('renderer/remote/stream.js') + read('renderer/remote/approvals.js');
  assert.match(app, /else if \(event === 'approval\.cancel'\) removeApproval\(payload\.id\);/);
  assert.match(app, /el\('div', \{ class: 'approval', 'data-id': a\.id,/);
  assert.match(app, /document\.querySelector\(`\.approval\[data-id="\$\{CSS\.escape\(String\(id\)\)\}"\]`\)\?\.remove\(\);/);
  // The phone's Stop reaches the turn's approvals: main.js aborts the request's controller, whose signal the turn's approvals hold.
  assert.match(read('main/main.js'), /abortTurn: \(requestId\) => turns\.abort\(requestId\),/);
  assert.match(read('main/turns.js'), /abort: \(requestId\) => active\.get\(requestId\)\?\.abort\(\),/);
  assert.match(read('main/turns.js'), /llm\.runTurn\(\{[^}]*signal: controller\.signal,/);
  assert.match(read('main/llm.js'), /turn: approvals\.newTurn\(\{ signal, userText: lastText \}\), signal,/);
  assert.match(read('android/app/src/main/java/com/nexusagent/android/ConnectionService.java'), /else if \(event\.equals\("approval\.cancel"\)\) cancel\(/);
});

test('a web_outbound approval reaches the phone with its warning and is answered there', async (t) => {
  t.after(() => store.setSettings({ safety: { permissionMode: 'ask', taintGuard: true } }));
  await store.setSettings({ safety: { permissionMode: 'auto', taintGuard: true } });
  approvals.setSender((channel, payload) => companion.publish(channel, payload));
  const auth = await pairDevice('Outbound phone');
  const stream = await openStream(auth);
  try {
    const turn = approvals.newTurn();
    approvals.markTainted(turn, 'web_fetch https://example.org/page');
    const asking = approvals.askOutbound(turn, 'https://new-host.example.com/a');
    await stream.until(/"kind":"web_outbound"/);
    const req = stream.events('approval.request').find((e) => e.kind === 'web_outbound');
    assert.strictEqual(req.tainted, true);
    assert.deepStrictEqual(req.sources, ['web_fetch https://example.org/page']);
    assert.strictEqual(req.desktopOnly, false, 'answerable from the phone');
    assert.ok(kindsOf('renderer/remote/approvals.js', 'KIND').has(req.kind), 'the card has a heading for it');
    assert.strictEqual((await post(`/api/approvals/${req.id}`, { allow: true }, auth)).status, 200);
    assert.strictEqual((await asking).allow, true);
    assert.ok(turn.outboundApproved.has('new-host.example.com'), 'the host is approved for the rest of the turn');
    await stream.until(/event: approval\.cancel\n/);
    assert.deepStrictEqual(stream.events('approval.cancel').at(-1), { id: req.id, answered: true });
  } finally {
    stream.close();
  }
});

// companion.js refuses a device's answer to a self-change or a connector-trust request (DESKTOP_ONLY, 403)
// and marks the streamed request desktopOnly; the phone's card shows no buttons for it. The Android
// notification (shown while the app isn't in front, and bridged to the watch) is the other place a device
// answers approvals: ApprovalReceiver cancels the notification and ignores the reply's status.
test('a desktop-only approval gets no Allow or Deny on the Android notification (the computer refuses a device’s answer)', async () => {
  const auth = await pairDevice('Notification phone');
  companion.publish('approval:request', { id: 'selfask', kind: 'self_modify', title: 'Change its own code (main/x.js)', timeoutSec: 60 });
  try {
    const r = await post('/api/approvals/selfask', { allow: true }, auth);
    assert.strictEqual(r.status, 403, 'a device can’t answer it');
  } finally {
    companion.publish('approval:cancel', { id: 'selfask' });
  }
  const java = read('android/app/src/main/java/com/nexusagent/android/ConnectionService.java');
  const start = java.indexOf('private void onApproval(JSONObject a) {');
  assert.ok(start > 0, 'ConnectionService has onApproval');
  const body = java.slice(start, java.indexOf('\n    }\n', start));
  assert.match(body, /optBoolean\("desktopOnly"/, 'onApproval offers Allow and Deny for every request: tapped on a self-change (or on the watch), the notification goes away, the POST gets a 403 that ApprovalReceiver ignores, and the computer waits out the time limit as a no');
  const gated = body.indexOf('if (!desktopOnly && cut) {');
  assert.ok(gated > 0 && body.indexOf('.addAction(') > gated && body.indexOf('WearableExtender') > gated, 'every action, the watch’s too, only when the device may answer');
  // SEC-05: a detail cut short gets Deny only (phone and watch); Allow waits for the app's full card.
  const cutBranch = body.slice(gated, body.indexOf('} else if (!desktopOnly) {'));
  assert.ok(cutBranch.includes('R.string.action_deny') && !cutBranch.includes('R.string.action_allow'), 'no Allow when the detail was cut');
  assert.match(body, /boolean cut = detail\.length\(\) > DETAIL_MAX;/);
  assert.match(read('android/app/src/main/res/values/strings.xml'), /<string name="approval_open_to_allow">/);
  assert.match(body, /if \(desktopOnly\) detail = getString\(R\.string\.approval_desktop_only\)/, 'it says where to answer');
  assert.match(read('android/app/src/main/res/values/strings.xml'), /<string name="approval_desktop_only">Approve or deny this one on your computer\.<\/string>/, 'the phone card’s words (renderer/remote/approvals.js)');
  assert.match(read('renderer/remote/approvals.js'), /Approve or deny this one on your computer\./);
});
