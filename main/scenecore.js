// The scene behind the face: a vector illustration of the place the persona lives in (a big top at
// night for a ringmaster, a moonlit cove for a sea nymph), drawn by the model as one SVG when the
// user generates the look & feel (persona.generateScene) and shown behind the face on the desktop
// (renderer/js/scene.js). Pure: the prompt, pulling the SVG out of the reply, and making it safe to
// put into the app's page: nothing that runs, loads or references anything outside the drawing.

const WIDTH = 1600;
const HEIGHT = 900;
const MAX_BYTES = 200000;
const MAX_ELEMENTS = 6000;
const LAYERS = ['far', 'mid', 'near'];
// Two drawings of the same place: wide for the Face view and the phone's face strip, tall for the
// chat's narrow face panel and the phone's full-screen face (a wide picture cropped to a tall strip
// shows only its quiet middle).
const FRAMES = { landscape: { w: WIDTH, h: HEIGHT }, portrait: { w: HEIGHT, h: WIDTH } };

function buildPrompt({ name, masterPrompt, aesthetic, colors = {}, orientation = 'landscape', userName = '' }) {
  const palette = Object.entries(colors)
    .filter(([, v]) => /^#[0-9a-f]{6}$/i.test(String(v)))
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  const f = FRAMES[orientation] || FRAMES.landscape;
  const tall = f.h > f.w;
  return `You are an illustrator. Draw the vector background scene for the animated face of a desktop AI assistant: the place its character lives in. The character itself is drawn by the app in the middle of the screen, over your scene, so your scene is the room, stage, landscape or world around it.

ASSISTANT NAME: ${name}

PERSONA:
"""
${String(masterPrompt || '').slice(0, 3000)}
"""

AESTHETIC / STYLE requested by the user:
"""
${String(aesthetic || '(none given — derive it from the persona)').slice(0, 2000)}
"""
${palette ? `\nTHE APP'S PALETTE (use these colors and tints and shades of them; let the background colors dominate so the character stands out): ${palette}\n` : ''}
Pick a concrete place that fits (a circus ringmaster: the fairground at night, the big top, booths, rides, string lights, a crowd; a sea nymph: a moonlit cove with rocks, kelp and a wreck; a librarian: tall shelves, ladders, a reading lamp, stacks of books). Make it rich and lived-in: a full place with many things in it, flat layered vector shapes, soft gradients, lights and glows, a floor with texture (planks, cobbles, sand, sawdust) and shadows under things. First list for yourself 10 to 14 motifs that belong to this place, then draw all of them.

Make it feel made by a hand and lived in, not generated. Where it fits the place, work in some of these (not all, never as a checklist): surface imperfections (a scratch, chipped paint, a crack in a wall, a faded patch, uneven texture); asymmetry (a sign hanging crooked, a stool out of place, a roof line that isn't straight, an off-centre arrangement); signs of use (worn steps, a scuffed table, a frayed banner, a patched tent, a repaired fence); environmental storytelling (something left behind, a note pinned up, a half-burned candle, footprints, evidence of what happened before); natural randomness (dust and leaves that gathered unevenly, irregular folds in cloth, small variation between things of the same kind); lighting imperfections (one lamp brighter than the next, deep shadows, dull reflections, things half in shadow); human craftsmanship (visible brush marks, a pencil line that stayed, rough edges, hand-carved unevenness); mundane details (a bucket, a coil of rope, a mug, a coin, a key: the ordinary things that make a place believable); evidence of cause and effect (a wet patch under a dripping bucket, soot on the wall above a lamp, a path worn where people walk, a shelf bowed under heavy books, a chair pushed back from a table someone just left). Subtle: a few well-placed ones beat many.${userName ? `
Hide the name "${userName}" somewhere in the scene as an easter egg: small, part of the world and not obvious (carved into a bench or a plank, a label on a crate, the name on a boat's stern, a tag on a mailbox, scratched into a wall, a scribble on a notice). It must be findable by someone looking for it (hidden, not invisible: a visitor who hunts for it for half a minute should find it), never a title or a caption. Put it in the middle band of the picture, between y=${Math.round(f.h * 0.25)} and y=${Math.round(f.h * 0.68)}, to the left or right of the centre (outside the character's circle), never along the bottom or the top edge: the app lays its controls over the bottom of the picture and crops the edges on small screens. For this one word only, a <text> element is allowed: font-size 18 to 24, opacity 0.7 or more, in a colour one clear step lighter or darker than what it is written on, a plain font-family, no other text anywhere.` : ''}

Respond with ONLY one <svg> element, no prose, no code fences, starting with an XML comment that captions the scene in at most six words: <!-- caption: ... -->

Requirements:
- viewBox="0 0 ${f.w} ${f.h}" (${tall ? 'a tall picture for a narrow panel: the sky and what hangs above fill the top third, the character sits in the middle third, the floor with props fills the bottom third; it may be cropped a little at the top and bottom' : 'a wide picture; it is cropped at the sides on narrow panels, so the most important things sit inside the middle 60% of the width, with more at the sides'}).
- Exactly three groups, in this order, holding everything: <g id="far"> (sky, stars or clouds, distant silhouettes: hills, a skyline, more tents, trees), <g id="mid"> (the main scenery: at least ${tall ? 'four' : 'six'} distinct structures or objects, plus small life such as simple silhouettes of people, animals, lanterns, flags, signs), <g id="near"> (foreground framing at the edges and the bottom: a prop or two in each lower corner, something hanging in from the top, the floor). The app moves them at different speeds for depth.
- The character sits in the centre, so inside a circle of radius ${tall ? 300 : 260} around (${f.w / 2}, ${f.h / 2}) put only what it stands on or in front of, in low contrast: a stage, a doorway, an archway, a path, a glow of light, a plain wall. Everything outside that circle is full: no empty area bigger than a tenth of the picture; the sky has stars, clouds, beams or bunting; the ground has texture.
- 200 to 450 elements. Use only basic shapes, paths, polygons and linearGradient / radialGradient in <defs>. Repeat small things with varied positions and sizes (lights, stars, pebbles, planks) rather than one big flat fill.
- No text${userName ? ' (apart from the hidden name)' : ''}, no <image>, no <use>, no <style>, no <filter>, no <foreignObject>, no <script>, no animation, no external references of any kind. Under 70 KB.`;
}

/** The SVG in a model reply (prose and code fences around it ignored), or null. */
function extractSvg(text) {
  const s = String(text || '');
  const start = s.search(/<svg[\s>]/i);
  const end = s.lastIndexOf('</svg>');
  if (start === -1 || end <= start) return null;
  return s.slice(start, end + 6);
}

const CAPTION = /<!--\s*caption:\s*([^>]*?)\s*-->/i;

/**
 * A scene safe to put into the page: one <svg> with nothing that runs or loads (scripts, handlers,
 * images, uses, styles, filters, foreign objects, animation, links, external references), the root
 * given the app's viewBox and crop. Throws when it is not a drawing or too big.
 */
function cleanScene(text, { orientation = 'landscape' } = {}) {
  const f = FRAMES[orientation] || FRAMES.landscape;
  const raw = extractSvg(text) || extractSvg(`${text}</svg>`);
  if (!raw) throw new Error('The model did not return an SVG drawing. Try again, or use a more capable model.');
  const caption = String((CAPTION.exec(String(text)) || [])[1] || '').slice(0, 80);
  let svg = raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<(script|style|foreignObject|image|use|filter|animate|animateTransform|animateMotion|set|title|desc|metadata)\b(?:[^>]*?\/>|[\s\S]*?<\/\1\s*>)/gi, '') // with everything inside
    .replace(/<\/?(script|style|foreignObject|image|use|filter|a|animate|animateTransform|animateMotion|set|title|desc|metadata)\b[^>]*>/gi, '') // stray tags; a link loses only its tags
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|xlink:href)\s*=\s*("(?!#)[^"]*"|'(?!#)[^']*'|(?!#)[^\s>]+)/gi, '') // only in-document references
    .replace(/\sfilter\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\sstyle\s*=\s*("[^"]*url\([^#][^"]*"|'[^']*url\([^#][^']*')/gi, '') // no url() to outside
    .replace(/\s(fill|stroke|mask|clip-path|marker(?:-start|-mid|-end)?)\s*=\s*("url\([^#][^"]*"|'url\([^#][^']*')/gi, '');
  if (Buffer.byteLength(svg, 'utf8') > MAX_BYTES) throw new Error('The scene is over 200 KB; ask for a simpler one.');
  const elements = (svg.match(/<[a-z]/gi) || []).length;
  if (elements > MAX_ELEMENTS) throw new Error('The scene has too many parts; ask for a simpler one.');
  if (elements < 4) throw new Error('The scene is empty.');
  // The root: the app's viewBox and crop, no fixed size, the namespace it needs inline.
  svg = svg.replace(/^<svg\b([^>]*)>/i, (_m, attrs) => {
    let a = attrs
      .replace(/\s(width|height|preserveAspectRatio|xmlns(?::\w+)?)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s(viewBox)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    a = ` xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f.w} ${f.h}" preserveAspectRatio="xMidYMid slice"${a}`;
    return `<svg${a}>`;
  });
  const layers = LAYERS.every((id) => new RegExp(`<g\\b[^>]*\\bid=["']${id}["']`).test(svg));
  return { svg, caption, bytes: Buffer.byteLength(svg, 'utf8'), elements, layers };
}

module.exports = { WIDTH, HEIGHT, FRAMES, MAX_BYTES, LAYERS, buildPrompt, extractSvg, cleanScene };
