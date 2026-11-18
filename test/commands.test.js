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
  assert.match(src, /COMMANDS\.find\(\(c\) => \(c\.match \? c\.match\(t, ctx\) : c\.re\.test\(t\)\)\)/, 'tryCommand honours match (with the context: "try again" asks it)');
  assert.doesNotMatch(src, /\|cancel\)\$\//, 'the old voice-only pattern with "cancel" is gone');
  assert.match(src, /export \{ NEW_CHAT \}/, 'NEW_CHAT is still exported from commands.js');
});

// "Try again" runs the failed or stopped reply again; after a good reply (or with nothing failed) it goes to the agent.
test('"try again" is a command only while the latest reply failed or was stopped', async () => {
  const { retryCommand, norm } = await load();
  for (const t of ['try again', 'Try again.', 'please try that again', 'retry', 'ok try it again please']) assert.strictEqual(retryCommand(norm(t), true), true, t);
  for (const t of ['try again', 'retry']) assert.strictEqual(retryCommand(norm(t), false), false, `${t}: nothing failed, so the agent hears it`);
  assert.strictEqual(retryCommand(norm('try again tomorrow with the dentist'), true), false);
  assert.strictEqual(retryCommand(norm('let me try again'), true), false);
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/commands.js'), 'utf8');
  assert.match(src, /retryCommand\(t, ctx\?\.canRetry\?\.\(\)\), run: async \(ctx\) => \(ctx\.retry\(\), ''\)/);
  const app = fs.readFileSync(path.join(ROOT, 'renderer/js/app.js'), 'utf8');
  assert.match(app, /retry: retryLatest, canRetry: canRetryLatest/, 'app.js hands the chat’s Try again to the commands');
});

// ---- Spoken answers to an approval (approvalAnswer): "Approve" and "Okay, go ahead" used to decline; a
// lone "okay" from a TV approved a command through an open microphone; words said before the dialog
// appeared answered it.
test('spoken approval answers: what approves and what declines', async () => {
  const { approvalAnswer } = await load();
  for (const said of ['Approve.', 'Okay, go ahead.', 'Yes, yes.', 'yes please', 'Yes', 'OK.', 'Allow it!', 'Sure, go ahead.', 'Approve it']) {
    assert.strictEqual(approvalAnswer(said), 'yes', said);
  }
  for (const said of ['No, put it in drafts.', 'go', 'alright', '', '   ', '👨‍👩‍👧‍👦', 'نعم', '<script>alert(1)</script>', 'x'.repeat(10000), 'yes '.repeat(3000), 'yes but not the dentist', null, undefined]) {
    assert.strictEqual(approvalAnswer(said), 'no', String(said).slice(0, 40));
  }
  for (const said of ['Details', 'details.', 'What exactly?', 'show details']) assert.strictEqual(approvalAnswer(said), 'details', said);
});

test('"always" needs a remember choice and the talk key', async () => {
  const { approvalAnswer } = await load();
  assert.strictEqual(approvalAnswer('Always.', { canRemember: true, source: 'ptt' }), 'always');
  assert.strictEqual(approvalAnswer("Don't ask again.", { canRemember: true, source: 'ptt' }), 'always', 'the apostrophe is dropped');
  assert.strictEqual(approvalAnswer('always', { canRemember: true, source: 'open' }), 'needs-key');
  assert.strictEqual(approvalAnswer('always', { canRemember: true, source: '' }), 'needs-key');
  assert.strictEqual(approvalAnswer('always', { source: 'ptt' }), 'no', 'nothing to remember: a sentence');
});

test('the always-ask kinds take a spoken yes only from the talk key; a tainted command only a click', async () => {
  const { approvalAnswer } = await load();
  assert.strictEqual(approvalAnswer('yes', { voice: 'key', source: 'ptt' }), 'yes');
  assert.strictEqual(approvalAnswer('okay', { voice: 'key', source: 'open' }), 'needs-key', 'a TV saying "okay" approves nothing');
  assert.strictEqual(approvalAnswer('yes', { voice: 'key', source: '' }), 'needs-key');
  assert.strictEqual(approvalAnswer('yes', { voice: 'click', source: 'ptt' }), 'needs-click');
  assert.strictEqual(approvalAnswer('no thanks', { voice: 'click', source: 'ptt' }), 'no', 'declining by voice is fine');
  assert.strictEqual(approvalAnswer('details', { voice: 'click' }), 'details');
  assert.strictEqual(approvalAnswer('yes', { voice: 'any', source: 'open' }), 'yes');
});

test('speech that began before the approval appeared is never its answer', async () => {
  const { approvalAnswer } = await load();
  for (const said of ['yes', 'no', 'details', 'always', '', 'please add milk']) {
    assert.strictEqual(approvalAnswer(said, { startedAt: 100, shownAt: 200, source: 'ptt', canRemember: true }), 'early', said);
  }
  assert.strictEqual(approvalAnswer('yes', { startedAt: 0, shownAt: 200 }), 'yes', 'start unknown: never early');
  assert.strictEqual(approvalAnswer('yes', { startedAt: 200, shownAt: 200 }), 'yes');
  assert.strictEqual(approvalAnswer('yes', { startedAt: 300, shownAt: 200 }), 'yes');
});

test('seeded: no spoken text approves past its policy', async () => {
  const { approvalAnswer } = await load();
  const words = ['yes', 'Yes,', 'okay', 'go', 'ahead', 'approve', 'always', 'allow', 'it', 'no', 'details', '.', '!', "don't", 'ask', 'again', 'please', 'سلام', '👍', '   ', 'do', 'sure'];
  let a = 4242; // mulberry32, seed 4242
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const results = new Set(['early', 'details', 'needs-click', 'needs-key', 'yes', 'always', 'no']);
  for (let i = 0; i < 500; i++) {
    const text = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => words[Math.floor(rnd() * words.length)]).join(' ');
    const voice = ['any', 'key', 'click'][Math.floor(rnd() * 3)];
    const source = ['ptt', 'open', ''][Math.floor(rnd() * 3)];
    const canRemember = rnd() < 0.5;
    const r = approvalAnswer(text, { voice, source, canRemember });
    const label = `seed 4242 case ${i}: ${JSON.stringify(text)} ${voice} ${source} ${canRemember}`;
    assert.ok(results.has(r), label);
    if (voice === 'click') assert.ok(r !== 'yes' && r !== 'always', label);
    if (source !== 'ptt') assert.ok(r !== 'always', label);
    if (voice === 'key' && source !== 'ptt') assert.ok(r !== 'yes', label);
    if (!canRemember) assert.ok(r !== 'always', label);
  }
});

test('the spoken prompt and the hint say how this approval is answered', async () => {
  const { approvalPrompt, approvalHint } = await load();
  assert.strictEqual(approvalPrompt({ title: 'Delete a note', kind: 'delete', voice: 'any' }), 'Permission needed: Delete a note. Say yes or no.');
  assert.match(approvalPrompt({ title: 'x', kind: 'connector', voice: 'key', tainted: true }), /after reading outside content/);
  assert.doesNotMatch(approvalPrompt({ title: 'x', kind: 'connector', voice: 'key' }), /outside content|details/);
  assert.match(approvalPrompt({ title: 'Run a command', kind: 'command', voice: 'key' }), /Say details to hear the command\. Say yes or no\.$/);
  assert.match(approvalPrompt({ title: 'Run a command', kind: 'command', voice: 'click', tainted: true }), /Then click Approve or Deny\.$/);
  assert.strictEqual(approvalHint({ voice: 'click' }), 'Click Approve or Deny: this one isn’t answered by voice. ');
  assert.strictEqual(approvalHint({ voice: 'any', remember: [{ level: 'read' }] }), 'Say “yes” to approve, say “always” to stop asking, “details” to hear more; anything else declines. ');
  assert.strictEqual(approvalHint({ voice: 'key' }, { pttKey: 'F8', handsFree: true }), 'Hold F8 and say “yes” to approve, “details” to hear more; anything else declines. ');
  assert.strictEqual(approvalHint({ voice: 'any', remember: [{}] }, { pttKey: 'F8', handsFree: true }), 'Say “yes” to approve, hold F8 and say “always” to stop asking, “details” to hear more; anything else declines. ');
  assert.strictEqual(approvalHint({ voice: 'key' }, { handsFree: false }), 'Say “yes” to approve, “details” to hear more; anything else declines. ', 'push-to-talk: the key is how they speak anyway');
  assert.match(approvalHint({ voice: 'key' }, { handsFree: true }), /^Hold the talk key/);
});

test('the dialog answers through approvalAnswer, marks when it appeared, and acknowledges', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/approval.js'), 'utf8');
  assert.match(src, /import \{ approvalAnswer, approvalPrompt, approvalHint \} from '\.\/commandcore\.js';/);
  assert.doesNotMatch(src, /const (YES|ALWAYS) = new Set/, 'the word lists live in commandcore.js');
  const shown = src.indexOf('current.shownAt = performance.now();');
  assert.ok(shown > 0 && shown < src.indexOf('speaker.say(approvalPrompt(req))'), 'shownAt is set before the prompt is spoken');
  assert.match(src, /toast\(`🎙 \$\{allow \? 'Approved' : 'Declined'\}/);
  const voice = fs.readFileSync(path.join(ROOT, 'renderer/js/voice.js'), 'utf8');
  assert.match(voice, /export const utteranceInfo = \(\) => utteranceStart;/);
  assert.ok(voice.indexOf("utteranceStart = { source: 'ptt'") < voice.indexOf('await finishUtterance(() => recorder.stop());'));
  assert.match(voice, /utteranceStart = \{ source: 'open', startedAt: performance\.now\(\) - \(this\.loud \|\| 0\) \}/);
  // Regression (review): a talk-key tap during a hands-free piece, or a release while one was still being
  // written down, made the open microphone's words count as the talk key's.
  assert.match(voice, /this\.seg = \{[^}]*start: utteranceStart \};/, 'the hands-free piece keeps its own start');
  const handsFreeEnd = voice.indexOf('finishUtterance(() => toMono16k(concat(seg.chunks), this.rate)');
  assert.ok(handsFreeEnd > 0 && voice.lastIndexOf('utteranceStart = seg.start;', handsFreeEnd) > voice.lastIndexOf('const seg = this.seg;', handsFreeEnd), 'and gets it back right before its words are written down');
  assert.match(voice, /if \(!busy\) utteranceStart = \{ source: 'ptt'/, 'a release never takes over a piece still being written down');
});

test('"stop asking" says what still asks', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/commands.js'), 'utf8');
  const line = src.split('\n').find((l) => l.includes('stop asking('));
  assert.match(line, /I still ask before changing my code, running commands, publishing, sending invitations and using services you haven’t allowed/);
  assert.match(line, /after reading outside content, before deleting or inviting in your services or opening new websites/);
});
