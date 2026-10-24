// Engineering mode (main/engineering.js): which turns get the larger tool budget and higher effort.
const test = require('node:test');
const assert = require('node:assert');
const eng = require('../main/engineering');

test('recognizes engineering requests', () => {
  for (const t of ['Add a new feature that shows the weather', 'implement dark mode', 'The voice is broken again', 'why does it crash on startup?', 'fix the calendar sync', 'refactor the router', 'improve yourself', 'there is an error in the log']) {
    assert.ok(eng.isEngineeringTask(t), t);
  }
  for (const t of ["what's on my calendar today?", 'tell me a joke', 'remind me to call mom', 'how is the weather']) {
    assert.ok(!eng.isEngineeringTask(t), t);
  }
});

test('engineering turns get a larger budget; others keep the setting', () => {
  const settings = { llm: { maxToolRounds: 8, engineeringToolRounds: 40 } };
  assert.strictEqual(eng.toolBudget(settings, false).rounds, 8);
  assert.strictEqual(eng.toolBudget(settings, true).rounds, 40);
  // Never smaller than the normal budget.
  assert.strictEqual(eng.toolBudget({ llm: { maxToolRounds: 60, engineeringToolRounds: 40 } }, true).rounds, 60);
  assert.strictEqual(eng.toolBudget({ llm: {} }, true).rounds, eng.ENGINEERING_ROUNDS);
});

test('a self-change tool upgrades the turn once', () => {
  const ctx = { budget: eng.toolBudget({ llm: { maxToolRounds: 8 } }, false) };
  assert.strictEqual(eng.upgradeBudget(ctx, 'web_search'), false);
  assert.strictEqual(ctx.budget.rounds, 8);
  assert.strictEqual(eng.upgradeBudget(ctx, 'self_change_plan'), true);
  assert.strictEqual(ctx.budget.rounds, 40);
  assert.strictEqual(eng.upgradeBudget(ctx, 'code_read_file'), false, 'only once');
});

test('effort is raised to high for engineering, never lowered', () => {
  const eng1 = { budget: { engineering: true } };
  const plain = { budget: { engineering: false } };
  assert.strictEqual(eng.turnEffort('medium', eng1), 'high');
  assert.strictEqual(eng.turnEffort(undefined, eng1), 'high');
  assert.strictEqual(eng.turnEffort('max', eng1), 'max');
  assert.strictEqual(eng.turnEffort('medium', plain), 'medium');
});
