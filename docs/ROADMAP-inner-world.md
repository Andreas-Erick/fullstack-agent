# Inner World — roadmap

Ideas for the village that are agreed in principle but not built yet. Built so far: the memory stream,
the daily narrator, rehearsals, live work at the buildings, the isometric floating island with
interiors, seasons and the camera (pan with glide, pinch/wheel zoom, keyboard, minimap, follow).
The code map is in `CLAUDE.md` (Inner World) and the art kit in `renderer/js/world/`.

Ordered by impact for the effort, as discussed on 2026-10-26.

## 0. Inside the buildings
Built (2.5.3): "Step inside" opens the room from above over the island (`renderer/js/world/room.js`,
hosted by `js/roomview.js` on the desktop and the phone's world screen): the furniture is the user's
data, the residents walk between stations following their plans, the active persona works at the tool's
station during a turn, documents open from the paper stacks. Still open: the figures could carry
things between stations, talk to each other in a scene, and the room could show the time of day on
the windows' light more finely.

## 1. Celebrate level-ups
Built (2.1.1): the glow and sparks, the panel line and the toast (`world:event` `levelup`). Still
open: scaffolding, dust and fireworks as one-off sprite animations.

When real progress raises a place's level, play it: scaffolding goes up, a puff of dust, the new
building, fireworks, a "The Library grew!" banner. Needs the previous levels per place (the main
process already keeps `levels` in `innerworld.json`; push a `world:event` `levelup` when `view()`
sees a higher one) and a short one-off animation in `scene.js`. Strongest link between progress and
reward.

## 2. Statues for mastered skills, festivals for milestones
A statue on the plaza for each mastered skill (its name on the plinth; data is in `details.skills`).
Festivals when a habit streak passes 7 / 30 / 100 days, or on a birthday from memory: lanterns
strung between houses, banners, a market, residents gathered on the plaza, a line in the chronicle.

## 3. Quest board
A noticeboard on the plaza that turns what is due into quests: cards to review, today's habits,
shaky concepts, today's calendar entries, rehearsals planned. Completing them lights up the village
(a lantern per quest, a festival when the board is clear). A feature of its own: decide how quests are
generated (rules over the data the app already has, no model call) and whether they appear in chat.

## 4. More life in the village
Birds and butterflies by day, bats at dusk; a boat on the river; carts travelling the roads;
residents fishing at the river, sitting on benches, reading outside, sweeping, gardening, chosen
from their plan's activity text. Mostly emitters and small figures in `scene.js` / `art.js`.

## 5. Talk to a resident
Click a resident for a short in-world exchange (a speech bubble reply in their voice, one model call,
written to their memory stream), without switching personas. The active persona could also show the
first sentence of its current chat reply as a bubble (local UI only; never sent anywhere new).

## 6. Optional soundscape
Generated with WebAudio, no audio files: birds by day, crickets at night, rain, the fountain, the
river, the forge hammering while the assistant writes code, the Lookout's ravens. Off by default, a
setting, follows the app's mute and stops when the view is hidden.

## 7. Timelapse
Built (2.1.1): ⏳ Timelapse in the World view, from the daily snapshots that `track()` keeps from now on.

Replay the last weeks of growth: buildings rising level by level, the seasons turning. Needs a daily
snapshot of the levels (start storing them in `innerworld.json` now so there is history to replay).

## Art direction note
Built (2026-10-26): the hybrid. Buildings, trees and small things are sprites rendered in Blender from
Kenney's CC0 kits (`tools/world-art/`); layout, data, animation and interiors stay procedural. Next
steps for the art, done the same day: second designs, homes that fill lots as the village grows,
crops by season, fences, an animated watermill and windmill, theme-tinted accent roofs (a roofmask
pass). Still open: rendered residents, bridges and stairs from the kit, more props per season.
