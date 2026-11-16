// A model's JSON read leniently (main/jsonrepair.js). One slip lost the handoff note ("Expected ':'
// after property name") and a whole village day ("Expected ',' or ']' after array element").
const test = require('node:test');
const assert = require('node:assert');
const { parseLoose, withRetry } = require('../main/jsonrepair');

test('valid JSON, with chatter, fences and braces inside text around it', () => {
  assert.deepStrictEqual(parseLoose('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(parseLoose('Here you go:\n```json\n{"topic":"a {b} c","list":[1,2]}\n```\nHope it helps {x}'), { topic: 'a {b} c', list: [1, 2] });
  assert.deepStrictEqual(parseLoose('[{"a":1}]'), [{ a: 1 }]);
});

test('the usual slips are repaired', () => {
  // A quote inside text left unescaped.
  assert.deepStrictEqual(parseLoose('{"summary": "She said "hello" to the Ringmaster", "n": 1}'), { summary: 'She said "hello" to the Ringmaster', n: 1 });
  // A raw line break inside a string.
  assert.deepStrictEqual(parseLoose('{"summary": "line one\nline two"}'), { summary: 'line one\nline two' });
  // A missing comma between lines, in an object and in an array.
  assert.deepStrictEqual(parseLoose('{\n "a": "x"\n "b": ["p"\n "q"]\n}'), { a: 'x', b: ['p', 'q'] });
  assert.deepStrictEqual(parseLoose('{"events": [\n {"who": "Ada"}\n {"who": "Sol"}\n]}'), { events: [{ who: 'Ada' }, { who: 'Sol' }] });
  // Trailing commas and comments.
  assert.deepStrictEqual(parseLoose('{"a": [1, 2,], // two\n "b": 3,}'), { a: [1, 2], b: 3 });
  // Cut off at the end.
  assert.deepStrictEqual(parseLoose('{"a": {"b": [1, 2'), { a: { b: [1, 2] } });
  // Escapes already right stay right.
  assert.deepStrictEqual(parseLoose(String.raw`{"a": "say \"hi\" \\ ok \n"}`), { a: 'say "hi" \\ ok \n' });
});

test('no JSON, or beyond repair: the original error; one retry asks the model to correct it', async () => {
  assert.throws(() => parseLoose('no json here'), /no JSON/);
  assert.throws(() => parseLoose('{"a": tru}'), SyntaxError);
  let asked = '';
  const fixed = await withRetry('{"a": tru}', async (prompt) => ((asked = prompt), '{"a": true}'));
  assert.deepStrictEqual(fixed, { a: true });
  assert.match(asked, /does not parse/);
  assert.match(asked, /\{"a": tru\}/);
  let calls = 0;
  await withRetry('{"a":1}', async () => calls++);
  assert.strictEqual(calls, 0, 'no call when it parses');
  await assert.rejects(withRetry('{"a": tru}', async () => 'still {bad'));
  await assert.rejects(withRetry('{"a": tru}'), SyntaxError);
});
