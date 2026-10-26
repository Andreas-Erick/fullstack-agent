// The Inner World's rendered sprites (renderer/assets/world, made by tools/world-art): every place has
// a sprite per level, every variant file exists, anchors and points lie inside their pictures, the
// families the map draws from exist, and the kits' licences ship with the art.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./helpers');
const core = require('../main/worldcore');

const DIR = path.join(ROOT, 'renderer/assets/world');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const S = manifest.sprites;

test('every place has a sprite for each level, and there is a construction site', () => {
  for (const p of core.PLACES) {
    if (p.id === 'grounds') continue; // drawn by code: it is mostly the user's habits
    for (const level of [1, 2, 3]) assert.ok(S[`${p.id}-${level}`], `${p.id}-${level}`);
  }
  assert.ok(S.construction);
});

test('every variant file exists; buildings have winter and night pictures, trees autumn ones', () => {
  for (const [name, s] of Object.entries(S)) {
    assert.ok(s.variants.summer, `${name} has a summer picture`);
    for (const file of Object.values(s.variants)) assert.ok(fs.existsSync(path.join(DIR, file)), `${file} exists`);
    if (/^(hearth|library|cafe|workshop|observatory|archive|stage|lookout|garden)-\d$/.test(name)) assert.ok(s.variants.winter && s.variants.glow, `${name} winter + glow`);
    if (name.startsWith('tree-')) assert.ok(s.variants.autumn && s.variants.winter, `${name} autumn + winter`);
  }
});

test('anchors lie inside their pictures, points near them', () => {
  for (const [name, s] of Object.entries(S)) {
    assert.ok(s.w > 0 && s.h > 0, `${name} size`);
    assert.ok(s.ax >= 0 && s.ax <= s.w && s.ay >= 0 && s.ay <= s.h, `${name} anchor inside`);
    // Points may sit just outside (the Lookout's ravens circle above its roof), never far off.
    for (const [k, p] of Object.entries(s.points || {})) assert.ok(p[0] >= -s.w * 0.5 && p[0] <= s.w * 1.5 && p[1] >= -s.h * 0.5 && p[1] <= s.h * 1.5, `${name}.${k} near the picture`);
  }
  assert.ok(manifest.scale > 0);
});

test('the families the island draws from exist (trees by kind, small things, lamps)', () => {
  for (const kind of ['oak', 'pine', 'birch']) assert.ok(S[`tree-${kind}-0`], `tree-${kind}`);
  for (const kind of ['rock', 'bush', 'flowers', 'stump']) assert.ok(S[`prop-${kind}-0`], `prop-${kind}`); // map.js prop kinds
  assert.ok(S['prop-lamp-0']?.points?.light);
  assert.ok(S['workshop-1'].points.forge && S['workshop-1'].points.smoke, 'the smithy has its forge and chimney');
});

test('homes, mills with their frames, crops and fences are there', () => {
  for (let d = 0; d < 8; d++) assert.ok(S[`home-${d}`], `home-${d}`);
  assert.ok(S.watermill && S.windmill);
  assert.ok(S['watermill-wheel-0'] && S['watermill-wheel-11'] && S['windmill-blades-0'] && S['windmill-blades-11'], 'animation frames');
  for (const c of ['wheat', 'corn', 'pumpkin', 'leafs', 'carrot']) assert.ok(S[`crop-${c}-0`], c);
  assert.ok(S['prop-fence-x'] && S['prop-fence-y']);
  // Accent roofs carry a mask for the theme tint.
  assert.ok(S['library-1'].variants.roofmask && S['home-2'].variants.roofmask);
});

test('the kits’ licences ship with the art', () => {
  for (const f of ['LICENSE-kenney-fantasy-town-kit.txt', 'LICENSE-kenney-nature-kit.txt']) assert.match(fs.readFileSync(path.join(DIR, f), 'utf8'), /CC0/);
});
