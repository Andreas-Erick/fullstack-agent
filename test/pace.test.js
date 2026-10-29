// Turn pace (main/pace.js): which messages are quick lookups, which need deep thought, and what each
// changes (model mode and effort) for the providers.
const test = require('node:test');
const assert = require('node:assert');
const { load } = require('./helpers');

const pace = load('main/pace.js');

test('lookups in the user\'s own things and small commands are quick', () => {
  for (const t of [
    'what is my schedule tomorrow?',
    "What's on my calendar today?",
    'do I have any meetings this week',
    'when is my next exam?',
    'Any habits left today?',
    'what time is it',
    'add milk to my todoist',
    'remind me to call mom at 6',
    'check off reading',
    'thanks!',
    'good morning',
    'was steht morgen an?',
  ])
    assert.strictEqual(pace.classify(t), 'quick', t);
});

test('understanding work is deep', () => {
  for (const t of [
    'explain the following topic to me: eigenvalues',
    'Why does the moon have phases?',
    'how does backpropagation work?',
    'compare SM-2 and FSRS',
    'help me plan my week',
    'write me an essay about Rome',
    'can you fix the bug in my script',
    'erkläre mir die Relativitätstheorie',
    'x'.repeat(1300),
  ])
    assert.strictEqual(pace.classify(t), 'deep', t.slice(0, 40));
});

test('general questions and go-aheads are not mistaken for quick lookups', () => {
  for (const t of [
    'what is time dilation?',
    'what are the events that led to WW1?',
    'yes',
    'ok do it',
    'create a study plan for machine learning',
    'tell me a story about a dragon',
    'what is my schedule tomorrow?\nAlso go through every note in my vault and reorganize it',
  ])
    assert.notStrictEqual(pace.classify(t), 'quick', t);
});

const settings = (llm = {}) => ({ llm: { modelMode: 'default', voiceUsesFast: true, ...llm } });

test('plan: quick = fast model at low effort; deep raises an explicit low/medium effort only', () => {
  assert.deepStrictEqual(pace.plan(settings(), { text: 'what is my schedule tomorrow?' }), { pace: 'quick', mode: 'fast', effort: 'low' });
  assert.deepStrictEqual(pace.plan(settings(), { text: 'explain entropy', base: 'medium' }), { pace: 'deep', mode: 'default', effort: 'high' });
  assert.deepStrictEqual(pace.plan(settings(), { text: 'explain entropy', base: 'xhigh' }), { pace: 'deep', mode: 'default', effort: 'xhigh' });
  assert.deepStrictEqual(pace.plan(settings(), { text: 'explain entropy' }), { pace: 'deep', mode: 'default', effort: 'default' }, 'the model\'s own default is left alone');
  assert.deepStrictEqual(pace.plan(settings(), { text: 'tell me a story', base: 'medium' }), { pace: 'normal', mode: 'normal', effort: 'medium' }, 'everyday messages run on the normal model (Sonnet)');
  assert.strictEqual(pace.plan(settings(), { text: 'tell me a story', voice: true }).mode, 'fast', 'spoken turns keep "fast for voice"');
  assert.strictEqual(pace.plan(settings(), { text: 'add milk', engineering: true }).pace, 'deep');
});

test('plan: off with the setting, in setup, or when the user picked a model mode', () => {
  assert.deepStrictEqual(pace.plan(settings({ autoPace: false }), { text: 'what is my schedule tomorrow?', base: 'medium' }), { pace: 'off', mode: 'default', effort: 'medium' });
  assert.strictEqual(pace.plan(settings(), { text: 'thanks', setup: true }).pace, 'off');
  assert.deepStrictEqual(pace.plan(settings({ modelMode: 'deep' }), { text: 'thanks' }), { pace: 'off', mode: 'deep', effort: 'default' });
  assert.strictEqual(pace.plan(settings({ modelMode: 'deep' }), { text: 'thanks', voice: true }).mode, 'fast', 'as before: fast for voice wins');
});

test('odd messages never throw: empty, null, emoji only, a pasted wall of text, only whitespace', () => {
  for (const t of [null, undefined, '', '   \n\t ', '🙂', '🔥🔥🔥', '?', '...', 42, {}, 'a'.repeat(100000)]) assert.doesNotThrow(() => pace.classify(t), String(t).slice(0, 20));
  assert.strictEqual(pace.classify('a'.repeat(100000)), 'deep', 'a long paste gets thought');
  assert.strictEqual(pace.classify(''), 'normal');
  assert.strictEqual(pace.classify('🙂'), 'normal');
  assert.doesNotThrow(() => pace.plan({}, { text: 'hi' }), 'settings without an llm section');
});

test('a very long prompt is classified at once, as deep', () => {
  const long = `${'Here is everything about my project, in detail. '.repeat(4000)}What should I do first?`;
  const t0 = Date.now();
  assert.strictEqual(pace.classify(long), 'deep');
  assert.strictEqual(pace.classify(`${'a'.repeat(200000)}`), 'deep', 'one endless word');
  assert.strictEqual(pace.classify(`${'why '.repeat(50000)}`), 'deep');
  assert.ok(Date.now() - t0 < 500, `took ${Date.now() - t0} ms`);
});

// Regression: "How are you today?" was deep ("how … are" read as an explanation question), so a
// greeting got the full thinking treatment.
test('asking how the assistant is doing is small talk, not a deep question', () => {
  for (const t of ['How are you today?', 'how are you', 'hey, how is it going?', "What's up?", "how's it going"]) assert.strictEqual(pace.classify(t), 'quick', t);
  for (const t of ['How does a transformer work?', 'How are prime numbers distributed?', 'how is entropy defined?']) assert.strictEqual(pace.classify(t), 'deep', t);
});

// Opus took ~15 s to start a tool-using reply in the log; everyday messages now run on Sonnet.
test('the model per pace: quick → fast, everyday → normal (Sonnet), deep → the main model', () => {
  const { stub: s, load: l, quietLog } = require('./helpers');
  s({ './logger': quietLog });
  const llm = l('main/llm.js');
  const settings = { llm: { provider: 'claude-code', modelMode: 'default' }, claudeCode: { model: 'default', fastModel: 'haiku', normalModel: 'sonnet', deepModel: 'opus' }, anthropic: {} };
  assert.strictEqual(llm.effectiveModel(settings, { mode: 'fast' }), 'haiku');
  assert.strictEqual(llm.effectiveModel(settings, { mode: 'normal' }), 'sonnet');
  assert.strictEqual(llm.effectiveModel(settings, { mode: 'default' }), 'default', 'deep questions keep the main model');
  assert.strictEqual(llm.effectiveModel({ ...settings, claudeCode: { ...settings.claudeCode, normalModel: '' } }, { mode: 'normal' }), 'default', 'empty = the main model');
  assert.strictEqual(llm.effectiveModel({ ...settings, llm: { provider: 'openai', model: 'qwen3:8b' } }, { mode: 'normal' }), 'qwen3:8b', 'other providers have no normal model');
});
