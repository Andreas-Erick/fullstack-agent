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
  assert.deepStrictEqual(pace.plan(settings(), { text: 'explain entropy', base: 'medium' }), { pace: 'deep', mode: 'deep', effort: 'high' });
  assert.deepStrictEqual(pace.plan(settings(), { text: 'explain entropy', base: 'xhigh' }), { pace: 'deep', mode: 'deep', effort: 'xhigh' });
  assert.deepStrictEqual(pace.plan(settings(), { text: 'explain entropy' }), { pace: 'deep', mode: 'deep', effort: 'default' }, 'the model\'s own default is left alone');
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
test('the model per pace: quick → fast, everyday → normal (Sonnet), deep → the deep model', () => {
  const { stub: s, load: l, quietLog } = require('./helpers');
  s({ './logger': quietLog });
  const llm = l('main/llm.js');
  const settings = { llm: { provider: 'claude-code', modelMode: 'default' }, claudeCode: { model: 'default', fastModel: 'haiku', normalModel: 'sonnet', deepModel: 'opus' }, anthropic: {} };
  assert.strictEqual(llm.effectiveModel(settings, { mode: 'fast' }), 'haiku');
  assert.strictEqual(llm.effectiveModel(settings, { mode: 'normal' }), 'sonnet');
  assert.strictEqual(llm.effectiveModel(settings, { mode: 'deep' }), 'opus', 'deep questions go to the deep model');
  assert.strictEqual(llm.effectiveModel({ ...settings, claudeCode: { ...settings.claudeCode, deepModel: '' } }, { mode: 'deep' }), 'default', 'no deep model: the main model');
  // Regression: a local deep model was only used in the explicit deep mode, never for a deep question.
  const local = { llm: { provider: 'openai', model: 'qwen3:8b', fastModel: 'qwen3:8b', deepModel: 'qwen3.8:27b', modelMode: 'default', autoPace: true, voiceUsesFast: true } };
  assert.strictEqual(llm.effectiveModel(local, { mode: pace.plan(local, { text: 'explain why the sky is blue' }).mode }), 'qwen3.8:27b');
  assert.strictEqual(llm.effectiveModel(local, { mode: pace.plan(local, { text: 'thanks!' }).mode }), 'qwen3:8b');
  assert.strictEqual(llm.effectiveModel(local, { mode: pace.plan(local, { text: 'explain why the sky is blue', voice: true }).mode }), 'qwen3:8b', 'spoken: the fast model, as before');
  assert.strictEqual(llm.effectiveModel({ ...settings, claudeCode: { ...settings.claudeCode, normalModel: '' } }, { mode: 'normal' }), 'default', 'empty = the main model');
  assert.strictEqual(llm.effectiveModel({ ...settings, llm: { provider: 'openai', model: 'qwen3:8b' } }, { mode: 'normal' }), 'qwen3:8b', 'other providers have no normal model');
});

// Each model has its own prompt cache: moving a big warm session to a smaller model made it read cold.
test('warmModel keeps a big warm session on its model instead of a smaller one', () => {
  const now = 1e9;
  const ttlMs = 55 * 60000;
  const last = { model: 'sonnet', at: now - 60000, tokens: 110000, key: 'k' };
  const pick = (want, extra = {}) => pace.warmModel({ want, last, key: 'k', now, ttlMs, ...extra });
  assert.deepStrictEqual(pick('haiku'), { model: 'sonnet', kept: 'warm' });
  // A bigger model for deep work: the user asked for the thinking.
  assert.deepStrictEqual(pick('opus'), { model: 'opus' });
  assert.deepStrictEqual(pick('sonnet'), { model: 'sonnet' });
  // A routine never moves the chat's model, up or down.
  assert.deepStrictEqual(pick('opus', { routine: true }), { model: 'sonnet', kept: 'routine' });
  // Switching is free when nothing is cached for it anyway.
  assert.deepStrictEqual(pick('haiku', { now: now + ttlMs }), { model: 'haiku' }, 'cache gone cold');
  assert.deepStrictEqual(pick('haiku', { key: 'other' }), { model: 'haiku' }, 'new configuration: new system prompt');
  assert.deepStrictEqual(pace.warmModel({ want: 'haiku', last: { ...last, tokens: 20000 }, key: 'k', now, ttlMs }), { model: 'haiku' }, 'small session');
  assert.deepStrictEqual(pace.warmModel({ want: 'haiku', last: null, key: 'k', now, ttlMs }), { model: 'haiku' }, 'no call yet');
  // Unknown families (an account default, a full id it can't rank) are never second-guessed.
  assert.deepStrictEqual(pace.warmModel({ want: 'haiku', last: { ...last, model: 'default' }, key: 'k', now, ttlMs }), { model: 'haiku' });
  assert.deepStrictEqual(pace.warmModel({ want: 'claude-haiku-5-5', last: { ...last, model: 'claude-opus-5-5' }, key: 'k', now, ttlMs }), { model: 'claude-opus-5-5', kept: 'warm' });
  assert.deepStrictEqual(pace.warmModel({ want: '', last: { ...last, model: 'default' }, key: 'k', now, ttlMs }), { model: 'default' });
});
