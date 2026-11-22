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

// Kept voice lines (phrases.js) are keyed by their chunk: a fixed text must always chunk the same way.
test('sayChunks: the first sentence alone, then pairs, a long sentence closing its pair', async () => {
  const { sayChunks, LONE_CHARS } = await plan();
  assert.strictEqual(LONE_CHARS, 110);
  const L = `A long sentence ${'that goes on '.repeat(8)}to the end.`;
  assert.ok(L.length >= LONE_CHARS);
  assert.deepStrictEqual(sayChunks(['A', 'B', 'C', 'D']), ['A', 'B C', 'D']);
  assert.deepStrictEqual(sayChunks(['A', L, 'B']), ['A', L, 'B']);
  assert.deepStrictEqual(sayChunks(['A', 'B', L, 'C']), ['A', `B ${L}`, 'C']);
  assert.deepStrictEqual(sayChunks(['A', 'B', 'C'], { firstAlone: false }), ['A B', 'C']);
  assert.deepStrictEqual(sayChunks(['', ' A ', '  ', 'B', 'C']), ['A', 'B C'], 'empties dropped');
  assert.deepStrictEqual(sayChunks([]), []);
  assert.deepStrictEqual(sayChunks(['Only one.']), ['Only one.']);
});

test('offlineVoiceSpeaks: the offline voice as main voice, or as the fallback filling in', async () => {
  const { offlineVoiceSpeaks } = await plan();
  const v = (extra) => ({ ttsEnabled: true, autoSpeak: true, engine: 'local', fallback: 'local', ...extra });
  assert.strictEqual(offlineVoiceSpeaks(v()), true);
  assert.strictEqual(offlineVoiceSpeaks(v({ autoSpeak: false })), false);
  assert.strictEqual(offlineVoiceSpeaks(v({ ttsEnabled: false })), false);
  assert.strictEqual(offlineVoiceSpeaks(v({ engine: 'voicestudio' })), false);
  assert.strictEqual(offlineVoiceSpeaks(v({ engine: 'voicestudio' }), { onFallback: true }), true);
  assert.strictEqual(offlineVoiceSpeaks(v({ engine: 'cloud', fallback: undefined }), { onFallback: true }), true, 'local is the default fallback');
  assert.strictEqual(offlineVoiceSpeaks(v({ engine: 'voicestudio', fallback: 'system' }), { onFallback: true }), false);
  assert.strictEqual(offlineVoiceSpeaks(undefined), false);
});

// Found while building it: the launch greeting, not kept yet, is looked up first; the "Last time we were
// on …" line behind it went to the voice at once and was made before the greeting.
test('createLineOrder: a line behind a lookup is made after it, a miss first', async () => {
  const { createLineOrder } = await plan();
  const later = (v, ms = 5) => new Promise((r) => setTimeout(() => r(v), ms));
  const run = async (hit) => {
    const order = createLineOrder();
    const made = [];
    const make = (name) => () => (made.push(name), Promise.resolve(name));
    const greeting = order.lookup(() => later(hit), make('greeting'));
    const handoff = order.after(make('handoff'));
    return { made, audio: await Promise.all([greeting, handoff]) };
  };
  assert.deepStrictEqual(await run(null), { made: ['greeting', 'handoff'], audio: ['greeting', 'handoff'] }, 'not kept: made in order');
  assert.deepStrictEqual(await run('kept'), { made: ['handoff'], audio: ['kept', 'handoff'] }, 'kept: only the next line is made');

  // Two looked-up chunks: the second waits for the first even when its own lookup is faster.
  const order = createLineOrder();
  const made = [];
  const a = order.lookup(() => later(null, 20), () => made.push('a'));
  const b = order.lookup(() => later(null, 1), () => made.push('b'));
  const c = order.after(() => made.push('c'));
  await Promise.all([a, b, c]);
  assert.deepStrictEqual(made, ['a', 'b', 'c']);

  // Nothing looked up: made at once, as before. A failed lookup is a miss. A stop waits for nothing.
  const free = createLineOrder();
  let now = false;
  free.after(() => (now = true));
  assert.strictEqual(now, true);
  assert.strictEqual(await free.lookup(() => Promise.reject(new Error('blocked')), () => 'made'), 'made');
  const stopped = createLineOrder();
  stopped.lookup(() => later(null, 50), () => 'old');
  stopped.reset();
  let next = false;
  stopped.after(() => (next = true));
  assert.strictEqual(next, true, 'after a reset nothing waits for the dropped lookup');
});

// Found in review: a stop (the talk key, Esc, a new message) while the greeting was still being looked
// up; the greeting (a miss) and the handoff line behind it went to the voice after the stop had
// cancelled its queue, and the next reply's first sentence waited behind both.
test('createLineOrder: after a reset, the lines that were waiting are never made', async () => {
  const { createLineOrder } = await plan();
  const later = (v, ms) => new Promise((r) => setTimeout(() => r(v), ms));
  for (const hit of [null, 'kept']) {
    const order = createLineOrder();
    const made = [];
    const make = (name) => () => (made.push(name), name);
    const greeting = order.lookup(() => later(hit, 5), make('greeting'));
    const handoff = order.after(make('handoff'));
    await later(null, 1);
    order.reset(); // speaker.stop()
    const reply = order.after(make('reply'));
    assert.deepStrictEqual(await Promise.all([greeting, handoff, reply]), [hit, null, 'reply'], `${hit ? 'kept' : 'not kept'}: a hit still resolves (the speaker drops it by gen)`);
    await later(null, 10);
    assert.deepStrictEqual(made, ['reply'], 'nothing dropped reaches the voice');
  }
  // A lookup started after the reset is made as usual, even while the dropped one is still pending.
  const order = createLineOrder();
  const made = [];
  order.lookup(() => later(null, 20), () => made.push('old'));
  order.reset();
  await order.lookup(() => later(null, 1), () => (made.push('new'), 'new'));
  await later(null, 30);
  assert.deepStrictEqual(made, ['new']);
});

// The sources as LF text (a Windows checkout has CRLF), for the checks below that slice at line ends.
const source = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

// voice.js needs the window, so the kept lines' wiring is checked in its source.
test('voice.js: kept lines are read first, kept only when made, and fixed lines chunk the same way', () => {
  const src = source('renderer/js/voice.js');
  // One method's text: from its header to the next method (two-space indent) or the end of its block.
  const method = (start) => {
    const from = src.indexOf(start);
    assert.ok(from >= 0, `${start} found`);
    const rest = src.slice(from + start.length);
    const end = rest.search(/\n {2}(?:async )?\w+\([^)]*\) \{\n|\n {2}get \w+\(\) \{|\n\}\n/);
    assert.ok(end >= 0, `${start} ends`);
    return src.slice(from, from + start.length + end);
  };
  const chunk = src.slice(src.indexOf('  chunk(text, override)'), src.indexOf('  release()'));
  assert.match(chunk, /text\.length >= LONE_CHARS/);
  assert.doesNotMatch(chunk, />= 110/);
  const say = method('  say(text, override, { remember = false } = {}) {');
  assert.match(say, /if \(remember\) \{\s*\n\s*sayChunks\(splitSentences\(speakable\(text\), true\)\)\.forEach\(\(c, i\) => this\.enqueue\(c, override, \{ first: i === 0, remember: true \}\)\);/);
  const follow = method('  follow(text,');
  assert.match(follow, /sayChunks\(splitSentences\(speakable\(text\), true\), \{ firstAlone \}\)/);
  assert.doesNotMatch(follow, /this\.stop\(\)/, 'follow adds to what is being said');
  const pump = method('  async pump() {');
  assert.match(pump, /if \(!buf \|\| item\.gen !== this\.gen\) continue;\s*\n\s*if \(item\.skipIf\?\.\(\)\) continue;/);
  const warm = method('  async warmNext() {');
  const look = warm.indexOf('getPhrase(');
  const made = warm.indexOf('synthesize(todo[0], undefined, this.gen, { quiet: true })');
  assert.ok(look > 0 && look < made, 'the kept line is read before the voice makes one');
  // Found in review: a message sent while the kept line was looked up got a filler made ahead of its
  // first sentence (the idle check ran before the lookup only).
  assert.match(warm.slice(look, made), /if \(!kept && \(!want\.idle\(\) \|\| state\.transcribing \|\| this\.busy \|\| this\.mainVoiceAway\(\)\)\) return void \(this\.warming = false\);/, 'checked again after the lookup');
  assert.match(warm, /if \(kept\) this\.warmKept\+\+;\s*\n\s*else \{[^}]*keepPhrase\(id, todo\[0\], buf\)/, 'kept again only when made');
  assert.strictEqual(warm.split('keepPhrase(').length, 2, 'one keepPhrase, in the made branch');
  const remembered = method('  remembered(text, override, gen) {');
  assert.match(remembered, /override \|\| practiceVoiceFor\(override\) \? null : voiceIdentity\(state\.settings\)/, 'never for an override or a practice voice');
  assert.match(remembered, /this\.order\.lookup\(/);
  assert.match(method('  enqueue(text, override'), /this\.order\.after\(\(\) => this\.synthesize\(text, override, gen\)\)/, 'a line behind a lookup waits for it');
  assert.match(method('  stop() {'), /this\.order\.reset\(\)/);
  assert.match(src, /buf\.madeBy = madeByOf\('local', \{ voice: v \}\);/, 'the offline voice says who made its audio');
  assert.match(src, /buf\.madeBy = madeBy;/, 'VoiceStudio and the cloud voice too');
  assert.match(src, /const fillerKey = \(text\) => `\$\{JSON\.stringify\(voiceIdentity\(state\.settings\)\)\}\|\$\{text\}`;/, 'the in-memory key holds no API key either');
  assert.match(method('function logFirstAudio('), /cached: t\.cached \|\| undefined/);
  assert.match(src, /if \(ttsActive\(\) && v\.filler\) speaker\.loadKept\(allFillers\(\)\);\s*\n\s*if \(!v\?\.ttsEnabled \|\| v\.engine !== 'local'\) return;/, 'kept fillers load at launch, before the model');
});

// The faces draw fewer frames while the offline voice works: state.voiceWorking must follow every change.
test('voice.js: every change to the offline voice\'s jobs or load state updates voiceWorking', () => {
  const src = source('renderer/js/voice.js');
  const from = src.indexOf('const localVoice = {');
  const to = src.indexOf('\n};\n', from);
  assert.ok(from > 0 && to > from);
  const obj = src.slice(from, to);
  assert.match(obj, /syncBusy\(\) \{\s*\n\s*state\.voiceWorking = Boolean\(this\.worker\) && \(!this\.loaded \|\| this\.pending\.size > 0\);/);
  // Each method of the object, split at its two-space-indented header.
  const methods = obj.split(/\n(?= {2}(?:async )?\w+\([^)]*\) \{\n)/);
  let checked = 0;
  for (const m of methods) {
    for (const change of ['this.pending.set(', 'this.pending.delete(', 'this.pending.clear()', 'this.host.ready()']) {
      for (let at = m.indexOf(change); at >= 0; at = m.indexOf(change, at + 1)) {
        checked++;
        assert.ok(m.indexOf('this.syncBusy()', at) > at, `${change} in ${m.trim().split('\n')[0]} is followed by this.syncBusy()`);
      }
    }
  }
  assert.ok(checked >= 6, `found the changes (${checked})`);
  // The worker's own changes come from the model host (modelhost.js): a new worker (onStart) and every
  // way it goes (onStop → dropJobs) update it too.
  assert.match(obj, /onStart\(\) \{\n\s+this\.startedAt = performance\.now\(\);\n\s+this\.syncBusy\(\);/);
  assert.match(obj, /onStop\(reason, kind\) \{[^}]*this\.dropJobs\(reason\);/);
  assert.match(obj, /dropJobs\(reason\) \{[\s\S]*?this\.syncBusy\(\);\n {2}\},/);
  assert.match(obj, /job\.faceFps = env\.maxFps\(\);/, 'the sentence log has the cap the faces really got');
  assert.match(obj, /faceFps: job\.faceFps/);
});

// An unloaded voice (Balanced's idle unload, or Unload in the system monitor on any profile) loads when
// a reply is coming, never on hands-free noise or the face demo.
test('voice.js: an unloaded offline voice starts when a message goes out or at a cloud push-to-talk press', () => {
  const src = source('renderer/js/voice.js');
  const from = src.indexOf("on('agent-state', (s) => {");
  const to = src.indexOf('\n});\n', from);
  assert.ok(from > 0 && to > from);
  const handler = src.slice(from, to);
  assert.match(handler, /if \(state\.demo \|\| state\.transcribing \|\| !offlineVoiceSpeaks\(state\.settings\?\.voice, \{ onFallback: speaker\.onFallback \}\)\) return;/);
  assert.match(handler, /const sent = s === 'thinking' && state\.generating;/);
  assert.match(handler, /const talking = s === 'listening' && recorder\.active && state\.settings\.stt\?\.engine !== 'local';/, 'never a hands-free onset (no recorder), never with local Whisper');
  assert.match(handler, /if \(!sent && !talking\) return;\s*\n\s*localVoice\.start\(\);/);
  assert.match(handler, /if \(sent && localVoice\.worker\) localVoice\.keepFor\(\);/);
  assert.strictEqual(handler.split('keepFor(').length, 2, 'the idle clock restarts only for a sent message');
});

// The "Last time we were on …" line holds conversation content: it is never kept.
test('app.js and chat.js: the greeting is kept, the handoff line never', () => {
  const app = source('renderer/js/app.js');
  const start = app.indexOf('function greetOnLaunch()');
  const end = app.indexOf('\n}\n', start);
  assert.ok(start > 0 && end > start);
  const greet = app.slice(start, end);
  assert.match(greet, /const \{ greeting, handoff \} = launchGreeting\(s, n\);/);
  assert.match(greet, /speaker\.say\(greeting, undefined, \{ remember: true \}\);/);
  assert.match(greet, /if \(handoff\) speaker\.follow\(handoff, \{ skipIf: \(\) => typed \|\| performance\.now\(\) - at > HANDOFF_LATE_MS \}\);/);
  assert.doesNotMatch(greet, /follow\(handoff[^\n]*remember/, 'the handoff line is never kept');
  assert.doesNotMatch(app, /Last time we were on/, 'phrasecore.js launchGreeting builds it');
  assert.match(app, /import \{ launchGreeting, HANDOFF_LATE_MS \} from '\.\/phrasecore\.js';/);
  const chat = fs.readFileSync(path.join(ROOT, 'renderer/js/chat.js'), 'utf8');
  assert.match(chat, /replySpeech\.follow\(greeting\)/, 'a new persona\'s hello after the reply');
  assert.match(source('renderer/js/speechplan.js'), /if \(active\(\)\) speaker\.follow\(text, \{ remember: true, firstAlone: true \}\);/, 'kept, only when replies are spoken');
  const personas = fs.readFileSync(path.join(ROOT, 'renderer/js/personas.js'), 'utf8');
  assert.match(personas, /speaker\.say\(settings\.appearance\.greeting \|\| `Hi, \$\{name\} here\.`, undefined, \{ remember: true \}\)/);
});
