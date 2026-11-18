// What the speaker says when (renderer/js/speechplan.js, spoken by renderer/js/voice.js):
//  - a reply's long first sentence is cut at a comma, so its first part plays while the rest is made;
//  - streamed text is cut into sentences as before (short ones merged, never inside a formula);
//  - the filler lines are made in a quiet moment and the wish is kept while the speaker talks (before,
//    the warm-up gave up whenever the reply was still being spoken, so no filler was ever made).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

const ESM = tmpDir('nexus-speechplan-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
for (const f of ['speechplan.js', 'mathtext.js']) fs.copyFileSync(path.join(ROOT, 'renderer/js', f), path.join(ESM, f));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));
const plan = () => import(pathToFileURL(path.join(ESM, 'speechplan.js')).href);

const LONG = 'When you look at the history of the old harbour town, which grew from a fishing village into a busy trading port, you can see how the river shaped each street.';

test('a long first sentence is cut at its first comma between 30 and 80 characters', async () => {
  const { firstCut } = await plan();
  assert.strictEqual(LONG.length, 159);
  const [head, tail] = firstCut(LONG);
  assert.ok(head.length >= 30 && head.length <= 81, head);
  assert.ok(head.endsWith(','), 'the head keeps its comma');
  assert.strictEqual(`${head} ${tail}`, LONG);
  assert.strictEqual(tail, tail.trim());
});

test('a sentence of 100 characters or fewer is spoken whole', async () => {
  const { firstCut } = await plan();
  const s = 'Well, I looked at your calendar, and there is nothing on it today, so you are free all day, really.';
  assert.ok(s.length <= 100);
  assert.deepStrictEqual(firstCut(s), [s, '']);
  assert.deepStrictEqual(firstCut(''), ['', '']);
});

test('no cut inside a formula or a list of numbers', async () => {
  const { firstCut } = await plan();
  // The formula's own ", " lies in the cut range, so only the formula check keeps it whole.
  const math = 'The surface we are going to study is $f(x, y) = x^2 + y^2$, a bowl, so its lowest point sits right at the origin of the plane we draw.';
  const inner = math.indexOf(', ');
  assert.ok(inner >= 30 && inner <= 80 && math.slice(0, inner).includes('$'), 'the first ", " is inside the formula and in range');
  const [mHead, mTail] = firstCut(math);
  assert.ok(mHead.includes('$f(x, y) = x^2 + y^2$') && mHead.endsWith('y^2$,'), mHead);
  assert.strictEqual(`${mHead} ${mTail}`, math);

  const nums = 'The numbers we need to add up here are 1, 2, 3, 4, 5, 6 and 7, and the total of all of them together is twenty-eight in the end.';
  const [nHead] = firstCut(nums);
  assert.ok(nHead.endsWith('6 and 7,'), `not between digits: ${nHead}`);

  const onlyDigits = 'The winning numbers drawn in the lottery this week were 4, 8, 15, 16, 23 and 42 and nobody at all in the whole country had picked them.';
  assert.deepStrictEqual(firstCut(onlyDigits), [onlyDigits, '']);
});

test('no comma in range: the sentence stays whole', async () => {
  const { firstCut } = await plan();
  const early = 'Well, the thing to remember about all of this is that nothing in the whole long explanation needs a comma until much later, right here.';
  assert.deepStrictEqual(firstCut(early), [early, '']);
  const none = 'This sentence is long enough to be cut but it has no comma anywhere in it at all so it has to be spoken in one single piece.';
  assert.deepStrictEqual(firstCut(none), [none, '']);
});

// The cut costs a longer pause and often a falling tone at the comma (measured on the offline voice),
// so it is made only where the whole sentence would keep the listener waiting.
test('cutWorth: cut on the processor or at a slow measured pace, never on a fast GPU or unmeasured', async () => {
  const { cutWorth, CUT_WORTH_MS } = await plan();
  const gpu = 'WebGPU · nvidia blackwell';
  assert.strictEqual(cutWorth({ chars: 160, msPerChar: 0, device: gpu }), false, 'nothing measured yet: whole');
  assert.strictEqual(cutWorth({ chars: 160, msPerChar: 10, device: gpu }), false, '1.6 s on a healthy GPU: whole');
  assert.strictEqual(cutWorth({ chars: 160, msPerChar: 60, device: gpu }), true, 'the slow in-app pace: cut');
  assert.strictEqual(cutWorth({ chars: 160, msPerChar: 0, device: 'CPU (WASM)' }), true);
  assert.strictEqual(cutWorth({ chars: 160, msPerChar: 0, device: 'CPU (WASM; WebGPU failed: no adapter)' }), true);
  assert.strictEqual(cutWorth({ chars: 100, msPerChar: CUT_WORTH_MS / 100, device: gpu }), false, 'exactly at the limit: whole');
  assert.strictEqual(cutWorth({ chars: 160, msPerChar: 30 }), true, 'no device known, slow pace: cut');
});

test('paceAfter: an average leaning on recent sentences; short lines and missing times ignored', async () => {
  const { paceAfter } = await plan();
  assert.strictEqual(paceAfter(0, { chars: 100, modelMs: 1000 }), 10);
  assert.strictEqual(paceAfter(10, { chars: 100, modelMs: 6000 }), 10 * 0.6 + 60 * 0.4);
  assert.strictEqual(paceAfter(10, { chars: 12, modelMs: 900 }), 10, 'a short line is mostly fixed cost');
  assert.strictEqual(paceAfter(10, { chars: 100, modelMs: undefined }), 10);
  assert.strictEqual(paceAfter(0, { chars: undefined, modelMs: 500 }), 0);
});

test('takeSentences: short pieces merged, formulas and paragraphs respected', async () => {
  const { takeSentences, splitSentences } = await plan();
  assert.deepStrictEqual(takeSentences('Hi. This is a longer sentence that goes on. And the rest'), { done: ['Hi. This is a longer sentence that goes on.'], rest: ' And the rest' });
  assert.deepStrictEqual(takeSentences('$$a. b$$ is the formula we need here today. More').done, ['$$a. b$$ is the formula we need here today.']);
  assert.deepStrictEqual(takeSentences('We start with $$x = 1. y = 2$$ and go. Then more'), { done: ['We start with $$x = 1. y = 2$$ and go.'], rest: ' Then more' });
  assert.deepStrictEqual(takeSentences('Short\n\nNext part'), { done: ['Short'], rest: 'Next part' });
  assert.deepStrictEqual(splitSentences('This is the first sentence of it. And a tail', true), ['This is the first sentence of it.', ' And a tail']);
  assert.deepStrictEqual(splitSentences('This is the first sentence of it. And a tail'), ['This is the first sentence of it.']);
});

test('warmStep: done, stop, wait, warm', async () => {
  const { warmStep } = await plan();
  assert.strictEqual(warmStep({ todo: 0, idle: false, busy: true }), 'done');
  assert.strictEqual(warmStep({ todo: 3, idle: false, busy: false }), 'stop');
  assert.strictEqual(warmStep({ todo: 3, idle: true, busy: true }), 'wait');
  assert.strictEqual(warmStep({ todo: 3, idle: true, busy: false }), 'warm');
  // VoiceStudio or the cloud voice is unreachable: what the fallback makes would be kept under the main
  // voice's key and play in the wrong voice once it is back.
  assert.strictEqual(warmStep({ todo: 3, idle: true, busy: false, away: true }), 'stop');
  assert.strictEqual(warmStep({ todo: 0, idle: true, busy: false, away: true }), 'done');
});

// voice.js needs the window (AudioContext, workers), so its wiring is checked in the source.
test('voice.js keeps the filler wish and resumes it when the speaker goes quiet', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/voice.js'), 'utf8');
  assert.match(src, /from '\.\/speechplan\.js'/);
  assert.doesNotMatch(src, /function takeSentences/, 'one copy, in speechplan.js');
  const pump = src.slice(src.indexOf('async pump()'), src.indexOf('playSystem(text)'));
  assert.match(pump, /emit\('speech-idle'\);\s*\n[\s\S]*this\.warmWant && !this\.warming\) this\.warmSoon\(/);
  const warm = src.slice(src.indexOf('async warmNext()'), src.indexOf('enqueue(text, override'));
  assert.match(warm, /warmStep\(/);
  assert.match(warm, /synthesize\(todo\[0\], undefined, this\.gen, \{ quiet: true \}\)/, 'quiet goes beside override, never into it');
  assert.match(src, /localVoice\.start\(\)\.then\(\(\) => ttsActive\(\) && state\.settings\.voice\.filler && speaker\.warmFillers\(allFillers\(\)/, 'made once the voice is loaded, only when replies are spoken');
  assert.match(warm, /want\.idle\(\) && !state\.transcribing/, 'not while local Whisper writes a recording down');
  assert.match(warm, /away: this\.mainVoiceAway\(\)/);
  const chunk = src.slice(src.indexOf('  chunk(text, override)'), src.indexOf('  release()'));
  assert.match(chunk, /firstCut\(text\)/);
  assert.match(chunk, /practiceVoiceFor\(override\)[\s\S]*pickVoice\([\s\S]*\? \[text, ''\] : firstCut\(text\)/, 'no cut for the instant practice voice');
  assert.match(chunk, /instant \|\| !this\.cutsFirst\(text, override\) \? \[text, ''\] : firstCut\(text\)/, 'cut only when it is worth it');
  const gate = src.slice(src.indexOf('  cutsFirst(text, override)'), src.indexOf('  release()'));
  assert.match(gate, /=== 'local'/, 'only the offline voice cuts');
  assert.match(gate, /cutWorth\(\{ chars: text\.length, msPerChar: localVoice\.msPerChar, device: localVoice\.device \}\)/);
  assert.match(src, /this\.msPerChar = paceAfter\(this\.msPerChar, \{ chars: job\.chars, modelMs: msg\.timing\?\.modelMs \}\)/, 'every made sentence updates the pace');
});

// A filler is made in the main voice or not at all: made by the fallback (the offline voice while
// VoiceStudio starts) it was kept under VoiceStudio's key and played in the wrong voice all session;
// a failed warm-up request toasted, turned the face red and switched replies to the fallback.
test('voice.js: a quiet synthesis never uses the fallback and fails silently', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/voice.js'), 'utf8');
  const synth = src.slice(src.indexOf('  async synthesize('), src.indexOf('  async fallback('));
  assert.ok(synth.length > 200, 'synthesize found');
  assert.match(synth, /\) return quiet \? null : this\.fallback\(text, gen\);/, 'while on the fallback: nothing for a quiet one');
  assert.doesNotMatch(synth, /this\.fallback\([^)]*quiet/, 'quiet never reaches fallback()');
  const caught = synth.slice(synth.indexOf('} catch (err) {'));
  const bail = caught.indexOf('if (quiet) return quietFail(err);');
  assert.ok(bail > 0, 'a failed quiet request returns at once');
  for (const effect of ['toastError(', "emit('voice-fallback'", 'this.onFallback = true', 'this.fallback(', 'this.reportError(']) {
    assert.ok(caught.indexOf(effect) > bail, `${effect} comes after the quiet return`);
  }
  assert.match(synth, /\.catch\(\(err\) => \(quiet \? quietFail\(err\) : \(localVoice\.warn\(err\)/, 'the offline voice as main voice: no toast for a filler either');
  const quietFn = src.slice(src.indexOf('function quietFail('), src.indexOf('export const speaker'));
  assert.doesNotMatch(quietFn, /toast|emit\(/);
});
