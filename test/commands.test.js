// The voice commands' words (renderer/js/commandcore.js): "cancel" and "never mind" stop a reply that
// is still being written, "stop" and "quiet" only silence the voice, and the same words inside a real
// request still go to the agent. ("Cancel" used to only stop the voice, so the reply and its tools went on.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-commands-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
fs.copyFileSync(path.join(ROOT, 'renderer/js/commandcore.js'), path.join(ESM, 'commandcore.js'));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const load = () => import(pathToFileURL(path.join(ESM, 'commandcore.js')).href);

test('norm reads a transcript as letters and single spaces', async () => {
  const { norm } = await load();
  assert.strictEqual(norm('Cancel.'), 'cancel');
  assert.strictEqual(norm('  Never   mind! '), 'never mind');
  assert.strictEqual(norm("Let's start a new chat."), 'let s start a new chat');
  assert.strictEqual(norm(undefined), '');
});

test('cancel, never mind and stop working stop the reply', async () => {
  const { norm, CANCEL_REPLY } = await load();
  for (const said of ['Cancel.', 'cancel that', 'Cancel it!', 'never mind', 'Nevermind.', 'stop working', 'please cancel', 'Okay, cancel.', 'Stop that, please.']) {
    assert.ok(CANCEL_REPLY.test(norm(said)), said);
  }
});

test('the same words inside a request still go to the agent', async () => {
  const { norm, CANCEL_REPLY, STOP_SPEAKING } = await load();
  for (const said of ['cancel my dentist appointment', 'stop', 'never mind the weather what about tomorrow', 'can you cancel the meeting', 'stop working on the essay and start the slides']) {
    assert.ok(!CANCEL_REPLY.test(norm(said)), said);
  }
  assert.ok(!STOP_SPEAKING.test(norm('stop the timer')));
});

test('stop and quiet only silence the voice', async () => {
  const { norm, STOP_SPEAKING, CANCEL_REPLY } = await load();
  for (const said of ['Stop.', 'quiet', 'be quiet', 'stop talking', 'Shut up!']) {
    assert.ok(STOP_SPEAKING.test(norm(said)), said);
    assert.ok(!CANCEL_REPLY.test(norm(said)), `${said} must not stop the reply`);
  }
  assert.ok(!STOP_SPEAKING.test('cancel'), '"cancel" stops the reply now, not only the voice');
});

// The regression: "cancel that" after "Added your dentist appointment" was swallowed as a command that
// found no reply to stop, so nothing happened and nothing was said, and the appointment stayed.
test('the stop-a-reply words count only while a reply is being written', async () => {
  const { norm, stopCommand } = await load();
  for (const said of ['Cancel that.', 'cancel it', 'never mind', 'Nevermind.', 'stop working', 'stop that', 'please cancel', 'Okay, cancel.']) {
    assert.strictEqual(stopCommand(norm(said), true), 'reply', `${said} while writing`);
    assert.strictEqual(stopCommand(norm(said), false), null, `${said} with nothing running goes to the agent`);
  }
  assert.strictEqual(stopCommand('cancel', true), 'reply');
  assert.strictEqual(stopCommand('cancel', false), 'voice', 'a bare "cancel" with nothing running only silences, as before');
  for (const said of ['stop', 'quiet', 'stop talking']) {
    assert.strictEqual(stopCommand(said, true), 'voice', `${said} while writing`);
    assert.strictEqual(stopCommand(said, false), 'voice', `${said} with nothing running`);
  }
  for (const said of ['cancel my dentist appointment', 'stop the timer', 'never mind the weather what about tomorrow']) {
    assert.strictEqual(stopCommand(norm(said), true), null, said);
    assert.strictEqual(stopCommand(norm(said), false), null, said);
  }
});

test('new chat still matches only on its own', async () => {
  const { norm, NEW_CHAT } = await load();
  for (const said of ['Start a new chat.', 'new session', "Let's start a fresh conversation please", 'clear the chat']) assert.ok(NEW_CHAT.test(norm(said)), said);
  assert.ok(!NEW_CHAT.test(norm('a new chat about cats')));
});

test('a long sentence is never a command', async () => {
  const { norm, MAX_WORDS } = await load();
  assert.strictEqual(MAX_WORDS, 7);
  assert.ok(norm('never mind I will tell you about my day instead').split(' ').length > MAX_WORDS);
});

// commands.js asks stopCommand with whether a reply is being written, and runs what it says: 'reply'
// stops the reply, 'voice' only the voice; "cancel" is no longer in a voice-only pattern of its own.
test('commands.js stops the reply on "cancel" and only the voice on "stop"', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/commands.js'), 'utf8');
  const reply = src.indexOf("stopCommand(t, state.generating) === 'reply'");
  const voice = src.indexOf("stopCommand(t, state.generating) === 'voice'");
  assert.ok(reply > 0 && voice > reply, 'both stop entries ask stopCommand with state.generating');
  assert.match(src.slice(reply, voice), /ctx\.cancel/);
  assert.match(src.slice(voice, src.indexOf('\n', voice)), /ctx\.stop\(\)/);
  assert.match(src, /COMMANDS\.find\(\(c\) => \(c\.match \? c\.match\(t\) : c\.re\.test\(t\)\)\)/, 'tryCommand honours match');
  assert.doesNotMatch(src, /\|cancel\)\$\//, 'the old voice-only pattern with "cancel" is gone');
  assert.match(src, /export \{ NEW_CHAT \}/, 'NEW_CHAT is still exported from commands.js');
});
