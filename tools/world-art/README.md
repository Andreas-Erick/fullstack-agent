# Inner World art

The village's buildings, trees and small things are rendered from Kenney's free 3D kits (CC0) with
Blender, into the sprites in `renderer/assets/world/`. The app (`renderer/js/world/sprites.js`) draws
them; everything that shows the user's data (habit banners, deck tables, flower beds, books, interiors,
labels) and everything that moves (smoke, fire, water, people) is still drawn by code on top. Without
the sprites, or with Settings → Inner World art → "Drawn by code", the village is drawn entirely by code.

## Re-render

1. Download and unpack the kits (both CC0, www.kenney.nl) into one folder:
   - `town/` ← [Fantasy Town Kit 2.0](https://kenney.nl/assets/fantasy-town-kit)
   - `nature/` ← [Nature Kit](https://kenney.nl/assets/nature-kit)
2. Run Blender headless (tested with Blender 5.2):

   ```
   blender -b --factory-startup --python tools/world-art/render.py -- <kits folder> renderer/assets/world [sprite names…]
   ```

   With names, only those sprites are rendered (the manifest keeps the others). It takes a few minutes
   for the whole set.

## How it works

- `blueprints.py` describes each sprite: kit models on a 1 × 1 grid (one tile, one story per unit) plus
  generated shapes from `render.py` (gable roofs, pyramids, domes, round towers, boxes). Names:
  `<place>-<level>` (1–3), `construction`, `tree-<kind>-<n>`, `prop-<kind>-<n>`.
- `render.py` renders each one with an orthographic camera that matches the app's isometric projection
  (2:1 tiles, 30° down), lit from the upper left, at 3 × world size, cropped tightly. Variants:
  `summer` (as modelled; spring uses it), `winter` (snow on upward faces), `autumn` (trees: leaves
  recoloured), `glow` (night: black, with light boxes inside the buildings showing through the windows).
- `manifest.json` gives each sprite its size, its anchor (the middle of its footprint on the ground, in
  image pixels) and named points (chimney tops, the forge, magic lights, the fountain) that the app turns
  into animations. `test/worldsprites.test.js` checks the set is complete and consistent.

Axes: Blender +X is the app's +gy (lower left on screen), +Y is +gx (lower right); fronts face +X / +Y.
