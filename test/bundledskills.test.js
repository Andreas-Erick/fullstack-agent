// The skills that ship with the app in the user's skills folder (main/skills.js installBundled): placed
// once, refreshed when a new version changes one the user never edited, left alone when edited, not
// brought back when removed; and what the shipped skills tell the model to call.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ROOT, stub, load, tmpDir, fileStore } = require('./helpers');

const BUNDLED = path.join(ROOT, 'main', 'skills');
const lf = (text) => text.replace(/\r\n/g, '\n');
const sha = (text) => crypto.createHash('sha1').update(lf(text)).digest('hex');
const shipped = (f) => fs.readFileSync(path.join(BUNDLED, f), 'utf8');
const OLD = '---\nname: Set a goal\ndescription: An earlier version\ntriggers: new goal\ninput: \ncreated: 2026-10-25\nupdated: 2026-10-25\n---\n1. Map it with a tool that is gone.\n';

const data = tmpDir('nexus-bundledskills-');
const folder = path.join(data, 'skills');
const marker = path.join(folder, '.bundled.json');
const copy = (f) => path.join(folder, f);
const read = (f) => fs.readFileSync(copy(f), 'utf8');
stub({ './store': fileStore(data) });
test.after(() => fs.rmSync(data, { recursive: true, force: true }));

/** A new start of the app: the bundled skills are placed on the first list(). */
async function start(prepare) {
  const skills = load('main/skills.js');
  prepare?.(skills);
  await skills.list();
  return skills;
}

test('skills are placed and remembered with a hash of what was placed', async () => {
  await start();
  assert.strictEqual(lf(read('goal.md')), lf(shipped('goal.md')));
  const seen = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.strictEqual(seen['goal.md'], sha(shipped('goal.md')));
  assert.strictEqual(Object.keys(seen).length, fs.readdirSync(BUNDLED).filter((f) => f.endsWith('.md')).length);
});

test('a new version reaches a copy the user never edited, whatever its line endings', async () => {
  const seen = JSON.parse(fs.readFileSync(marker, 'utf8'));
  seen['goal.md'] = sha(OLD);
  fs.writeFileSync(marker, JSON.stringify(seen));
  fs.writeFileSync(copy('goal.md'), OLD.replace(/\n/g, '\r\n'));
  await start();
  assert.strictEqual(lf(read('goal.md')), lf(shipped('goal.md')));
  assert.strictEqual(JSON.parse(fs.readFileSync(marker, 'utf8'))['goal.md'], sha(shipped('goal.md')));
});

test('an edited skill is kept, also by later versions; a removed one is not brought back', async () => {
  const mine = `${OLD}2. My own step.\n`;
  const seen = JSON.parse(fs.readFileSync(marker, 'utf8'));
  seen['goal.md'] = sha(OLD);
  seen['drill.md'] = sha(OLD);
  fs.writeFileSync(marker, JSON.stringify(seen));
  fs.writeFileSync(copy('goal.md'), mine);
  fs.rmSync(copy('drill.md'));
  await start();
  assert.strictEqual(read('goal.md'), mine);
  assert.ok(!fs.existsSync(copy('drill.md')));
  // The next version changes the skill again: the edited copy is still not taken for a placed one.
  const later = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.notStrictEqual(later['goal.md'], sha(mine));
  later['goal.md'] = 'f'.repeat(40);
  fs.writeFileSync(marker, JSON.stringify(later));
  await start();
  assert.strictEqual(read('goal.md'), mine);
  fs.rmSync(copy('goal.md'));
  fs.rmSync(marker);
  await start(); // back to a clean folder for the next test
});

test('an install that only remembered names: what an earlier version shipped is refreshed, an edited or removed skill is not', async () => {
  const names = fs.readdirSync(BUNDLED).filter((f) => f.endsWith('.md'));
  const mine = `${OLD}2. My own step.\n`;
  fs.writeFileSync(marker, JSON.stringify(names));
  fs.writeFileSync(copy('goal.md'), OLD.replace(/\n/g, '\r\n'));
  fs.writeFileSync(copy('study-pack.md'), mine);
  fs.rmSync(copy('drill.md'));
  await start((skills) => {
    skills.SHIPPED['goal.md'] = [...skills.SHIPPED['goal.md'], sha(OLD)];
  });
  assert.strictEqual(lf(read('goal.md')), lf(shipped('goal.md')), 'unedited: replaced');
  assert.strictEqual(read('study-pack.md'), mine, 'edited: kept');
  assert.ok(!fs.existsSync(copy('drill.md')), 'removed: stays removed');
  const seen = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.ok(!Array.isArray(seen));
  assert.deepStrictEqual(Object.keys(seen).sort(), names.sort());
  await start();
  assert.strictEqual(read('study-pack.md'), mine);
});

test('the list of what earlier versions shipped names real skills', () => {
  const { SHIPPED } = load('main/skills.js');
  for (const [f, hashes] of Object.entries(SHIPPED)) {
    assert.ok(fs.existsSync(path.join(BUNDLED, f)), f);
    for (const h of hashes) assert.match(h, /^[0-9a-f]{40}$/);
  }
});

test('the shipped skills name only tools the app has', () => {
  const sources = [path.join(ROOT, 'main', 'tools.js'), ...fs.readdirSync(path.join(ROOT, 'main', 'tools')).map((f) => path.join(ROOT, 'main', 'tools', f))];
  const tools = new Set(sources.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/\bname: '([a-z_]+)'/g)].map((m) => m[1])));
  assert.ok(tools.has('learning_update') && tools.has('vault_list_notes'));
  for (const f of fs.readdirSync(BUNDLED).filter((x) => x.endsWith('.md'))) {
    for (const name of new Set(shipped(f).match(/\b[a-z]+(?:_[a-z]+)+\b/g) || [])) assert.ok(tools.has(name), `${f} names ${name}`);
  }
});

test('the prompt lists skills by name and trigger phrases only (descriptions via skill_list)', async () => {
  const skills = await start();
  const block = await skills.promptBlock();
  assert.match(block, /^## Skills/);
  assert.match(block, /- \/goal Set a goal \("/);
  const all = await skills.list();
  for (const s of all) if (s.description) assert.ok(!block.includes(s.description), `${s.slug}'s description is not in every message`);
  assert.ok(block.includes('skill_list'));
});
