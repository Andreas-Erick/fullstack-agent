// Inside a building (renderer/js/world/room.js): every place lays out its furniture from the data
// and stays inside the walls, the walkers go to the station their activity names and never leave the
// room, every room draws by day and by night on a stand-in context, and picking finds things.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ROOT, tmpDir } = require('./helpers');

// The renderer's modules are ES modules in a CommonJS package: a copy under a {"type":"module"} package loads.
const ESM = tmpDir('nexus-room-');
fs.writeFileSync(path.join(ESM, 'package.json'), '{"type":"module"}');
fs.copyFileSync(path.join(ROOT, 'renderer/js/world/room.js'), path.join(ESM, 'room.js'));
test.after(() => fs.rmSync(ESM, { recursive: true, force: true }));

const PLACES = ['lookout', 'hearth', 'library', 'cafe', 'workshop', 'garden', 'grounds', 'observatory', 'archive', 'stage'];
const details = {
  topics: [{ name: 'Linear algebra', understood: 7, shaky: 2 }, { name: 'Thermodynamics', understood: 3, shaky: 4 }],
  decks: [{ name: 'Spanish', mature: 40, total: 120, due: 9 }, { name: 'Japanese', mature: 2, total: 30, due: 0 }],
  habits: [{ name: 'Meditate', done: true, streak: 4, unit: 'd' }, { name: 'Run', done: false, streak: 0, unit: 'd' }],
  skills: [{ name: 'Proofs', state: 'mastered', progress: 1, area: 'Maths' }, { name: 'Integrals', state: 'growing', progress: 0.4, area: 'Maths' }, { name: 'Pitching', state: 'locked', progress: 0, area: 'Speaking' }],
  memories: 61,
  work: { today: { workshop: 3, lookout: 1 }, total: { workshop: 80, lookout: 23 } },
};
const data = { details, residents: [{ name: 'Siren' }, { name: 'Wren' }, { name: 'Bram' }], docs: [{ name: 'Thesis.pdf', kind: 'pdf', path: 'C:/x/Thesis.pdf' }, { name: 'Notes.md', kind: 'markdown', path: 'C:/x/Notes.md' }], rehearsals: [{ title: 'Salary talk' }] };
const P = Object.fromEntries(['grass', 'grassDark', 'dirt', 'stone', 'stoneShade', 'stoneLight', 'plaster', 'plasterShade', 'timber', 'timberDark', 'wood', 'woodShade', 'woodLight', 'leaf', 'leafDark', 'lamp', 'outline', 'copper', 'cloth', 'banner', 'soil', 'water', 'foam', 'wheat', 'c1', 'c2', 'c3', 'ok', 'warn', 'text', 'bg'].map((k, i) => [k, [(i * 37) % 255, (i * 59) % 255, (i * 83) % 255]]));

// A 2D context that accepts any call and records how many it got.
function fakeContext() {
  const calls = { n: 0 };
  const grad = { addColorStop() {} };
  const c = new Proxy({ calls }, { get: (t, k) => (k === 'calls' ? calls : k === 'measureText' ? () => ({ width: 40 }) : k === 'createRadialGradient' || k === 'createLinearGradient' ? () => grad : typeof k === 'string' ? (calls.n++, () => undefined) : undefined), set: () => true });
  return c;
}

const mod = () => import(pathToFileURL(path.join(ESM, 'room.js')).href);

test('every place lays out labelled furniture from the data, inside the walls', async () => {
  const room = await mod();
  for (const place of PLACES) {
    const r = room.layout(place, 2, data);
    assert.ok(r.stations.length >= 3, `${place} has furniture`);
    assert.ok(r.stations.some((s) => s.label), `${place} has something to look at`);
    for (const s of r.stations) {
      assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= room.RW && s.y + s.h <= room.RH, `${place}: ${s.kind} inside the room`);
      assert.ok(s.slot.x > 0 && s.slot.x < room.RW && s.slot.y > 0 && s.slot.y < room.RH, `${place}: ${s.kind} has a place to stand`);
    }
  }
  const lib = room.layout('library', 2, data);
  assert.strictEqual(lib.stations.filter((s) => s.kind === 'shelf').length, 2, 'a shelf per topic');
  assert.match(lib.stations[0].info, /7 understood, 2 shaky/);
  const ws = room.layout('workshop', 2, data);
  assert.strictEqual(ws.stations.filter((s) => s.kind === 'papers').length, 2, 'a paper stack per recent document');
  assert.strictEqual(ws.stations.find((s) => s.kind === 'papers').doc.path, 'C:/x/Thesis.pdf');
  assert.strictEqual(room.layout('hearth', 1, data).stations.filter((s) => s.kind === 'bed').length, 3, 'a bed per resident');
  assert.ok(room.layout('library', 1, {}).stations.some((s) => /Nothing tracked/.test(s.info)), 'without data: empty shelves that say so');
});

test('the walkers head for the station their activity names and stay inside', async () => {
  const room = await mod();
  const { stations } = room.layout('workshop', 2, data);
  const sim = room.createSim();
  const people = [{ name: 'Siren', color: [0, 200, 255], active: true, kind: 'active', activity: 'at the forge, building something', working: true }, { name: 'Wren', color: [200, 100, 50], kind: 'npc', activity: 'pottering about' }];
  let actors;
  for (let t = 0; t < 40; t += 1 / 30) {
    actors = sim.update(people, stations, 1 / 30, t);
    for (const a of actors) assert.ok(a.x > 0 && a.x < room.RW && a.y > 0 && a.y < room.RH, `${a.name} inside at ${t.toFixed(1)}s`);
  }
  const siren = actors.find((a) => a.name === 'Siren');
  assert.strictEqual(siren.at?.kind, 'forge', 'the forge, for code');
  assert.strictEqual(siren.mode, 'do');
  assert.ok(siren.bubble.includes('forge'));
  actors = sim.update([people[1]], stations, 1 / 30, 41);
  assert.strictEqual(actors.length, 1, 'whoever left the room is gone');
  const hearth = room.layout('hearth', 1, data);
  const night = room.createSim();
  let a;
  for (let t = 0; t < 30; t += 1 / 30) a = night.update([{ name: 'Wren', color: [1, 2, 3], kind: 'npc', activity: 'asleep', asleep: true }], hearth.stations, 1 / 30, t)[0];
  assert.strictEqual(a.mode, 'sleep');
  assert.strictEqual(a.at.kind, 'bed');
});

test('every room draws by day and by night, with people, on a stand-in context; picking finds things', async () => {
  const room = await mod();
  for (const place of PLACES) {
    const { stations, floor, open } = room.layout(place, 3, data);
    const sim = room.createSim();
    const actors = sim.update([{ name: 'Siren', color: [0, 200, 255], active: true, kind: 'active', activity: 'reading', working: true }, { name: 'Bram', color: [9, 9, 9], kind: 'npc', activity: 'asleep', asleep: true }], stations, 0.5, 1);
    for (const night of [false, true]) {
      const c = fakeContext();
      room.draw(c, { w: 900, h: 560, P, t: 3, place, level: 3, name: place, stations, actors, floor, open, night, anim: true, lite: false, hover: { type: 'station', station: stations[0] } });
      assert.ok(c.calls.n > 100, `${place} draws (${night ? 'night' : 'day'})`);
    }
    const s = stations.find((x) => x.label) || stations[0];
    const { k, ox, oy } = room.transform(900, 560);
    const hit = room.pick(900, 560, stations, [], ox + (s.x + s.w / 2) * k, oy + (s.y + s.h / 2) * k);
    assert.ok(hit && hit.type === 'station', `${place}: picking finds a station`);
  }
});
