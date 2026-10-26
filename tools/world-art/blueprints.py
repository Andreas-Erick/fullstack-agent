# What each Inner World sprite is made of: Kenney kit models placed on a grid of 1 × 1 cells (Blender
# units; one story is 1 unit high) plus a few generated shapes (roofs, towers, platforms).
#
# Axes as the app shows them: Blender +X runs to the lower left of the screen (the app's +gy), +Y to the
# lower right (the app's +gx); the faces towards +X and +Y are the ones you see, so doors and fronts go
# there. Wall pieces sit on their cell's +X edge and turn with `rot` (90 = the +Y edge). The origin is the
# middle of the place's footprint on the ground (map.js SIZE: half-sizes a along gx = Blender Y, b along
# gy = Blender X): the app anchors the sprite there.
#
# Names: <place>-<level> for buildings (1–3), 'construction' for an unbuilt place, tree-*, prop-*.
# 'points' are spots the app needs in the image (chimney tops for smoke, the forge, magic lights).


def T(name, pos=(0, 0, 0), rot=0, scale=1.0):
    return ('town', name, {'pos': pos, 'rot': rot, 'scale': scale})


def N(name, pos=(0, 0, 0), rot=0, scale=1.0):
    return ('nature', name, {'pos': pos, 'rot': rot, 'scale': scale})


def G(kind, **kw):
    """A generated part (render.py GENERATORS): gable roofs, pyramids, cones, domes, cylinders, boxes."""
    return ('gen', kind, kw)


# Colours (sRGB) matching the kit: its lavender stone, warm wood, red, green, blue and slate roofs.
STONE = (164, 168, 214)
WOOD = (176, 104, 74)
DARKWOOD = (120, 72, 54)
RED = (226, 92, 96)
GREEN = (84, 186, 150)
BLUE = (100, 120, 210)
SLATE = (112, 116, 160)
TEAL = (90, 190, 180)
CLOTH = (200, 70, 110)
# Roofs in this colour are tinted with the persona's theme by the app (render.py roofmask variant).
ACCENT = (204, 98, 108)


def walls(w, d, stories=1, kind='wall', ox=0.0, oy=0.0, door=('X', 0), windows='wall-window-shutters', z0=0.0, skip=()):
    """Walls around a w (along X) × d (along Y) block centred on (ox, oy). door = (side, index) or None."""
    parts = []
    xs = [ox - w / 2 + 0.5 + i for i in range(w)]
    ys = [oy - d / 2 + 0.5 + j for j in range(d)]
    wood = kind != 'wall'
    win = windows.replace('wall-', 'wall-wood-') if wood else windows
    door_piece = 'wall-wood-door' if wood else 'wall-door'
    sides = [('X', [(xs[-1], y) for y in ys], 0), ('-X', [(xs[0], y) for y in ys], 180), ('Y', [(x, ys[-1]) for x in xs], 90), ('-Y', [(x, ys[0]) for x in xs], 270)]
    for s in range(stories):
        for side, cells, rot in sides:
            if side in skip:
                continue
            for k, (x, y) in enumerate(cells):
                if s == 0 and door and door[0] == side and door[1] == k:
                    piece = door_piece
                elif (k + s) % 2 == 0:
                    piece = win
                else:
                    piece = kind
                parts.append(T(piece, (x, y, z0 + s), rot))
    # A warm light inside, for the night pass only (it shows through the windows).
    parts.append(G('box', x=ox, y=oy, z=z0 + 0.05, sx=w - 0.35, sy=d - 0.35, sz=stories - 0.15, glow=True))
    return parts


def gable(w, d, z, ox=0.0, oy=0.0, along='X', color=RED, wall=STONE, h=None):
    return G('gable', w=w, d=d, z=z, ox=ox, oy=oy, along=along, color=color, wall=wall, h=h)


def house(w, d, stories=1, kind='wall', ox=0.0, oy=0.0, along='Y', color=RED, door=('X', 0), chimney=True):
    """A house: walls, a gable roof, maybe a chimney. Returns (parts, chimney top or None)."""
    wall = STONE if kind == 'wall' else WOOD
    parts = walls(w, d, stories, kind, ox, oy, door) + [gable(w, d, stories, ox, oy, along, color, wall)]
    top = None
    if chimney:
        cx, cy = ox - w / 2 + 0.5, oy + d / 2 - 0.6
        parts.append(T('chimney', (cx - 0.3, cy, stories + 0.15), 0, (1, 1, 1.1)))
        top = (cx, cy, stories + 1.35)
    return parts, top


def tower(x, y, stories, color=BLUE):
    """A square stone tower with windows and a pointed roof. Returns (parts, top)."""
    parts = walls(1, 1, stories, 'wall', x, y, door=None, windows='wall-window-small')
    parts.append(G('pyramid', x=x, y=y, z=stories, sx=1, sy=1, h=1.1, color=color))
    return parts, (x, y, stories + 1.15)


def lantern(x, y):
    # The kit's street lantern, and a light in its head for the night pass.
    return [T('lantern', (x, y, 0)), G('box', x=x, y=y, z=1.3, sx=0.14, sy=0.14, sz=0.18, glow=True)]


# ------------------------------------------------------------------ buildings
def hearth(level):
    a, top = house(2, 3, 1, 'wall-wood', 0.4 if level == 1 else 0.6, 0.2 if level == 1 else -0.5, 'Y', ACCENT, ('X', 1))
    parts = a + [*lantern(1.6, 1.6)]
    points = {'smoke': top}
    if level >= 2:
        parts = []
        a, top = house(2, 2, 2, 'wall', 0.6, -0.8, 'X', ACCENT, ('X', 0))
        b, top2 = house(1, 2, 1, 'wall-wood', -1.0, 0.9, 'Y', GREEN, ('X', 1))
        parts = b + a + [*lantern(1.8, 0.6), T('stall-bench', (1.6, -0.2, 0), 90)]
        points = {'smoke': top, 'smoke2': top2}
    if level >= 3:
        c, top3 = house(2, 1, 1, 'wall-wood', 0.9, 1.4, 'X', BLUE, ('Y', 0))
        parts = parts + c + [*lantern(-1.6, -1.6)]
        points['smoke3'] = top3
    return {'parts': parts, 'points': points, 'footprint': [3.4, 3.8]}


def library(level):
    stories = 1 if level == 1 else 2
    t, top = tower(-0.9, -0.9, 1 + level, ACCENT)
    h, _ = house(2, 2, stories, 'wall', 0.4, 0.4, 'Y', SLATE, ('X', 0), chimney=False)
    parts = t + h
    if level >= 3:
        w, _ = house(1, 1, 1, 'wall', 1.3, -1.0, 'X', SLATE, ('X', 0), chimney=False)
        parts += w + [T('banner-red', (-0.4, -0.9, 1.2), 0)]
    parts += [*lantern(1.6, 1.4)]
    return {'parts': parts, 'points': {'orb': top}, 'footprint': [3.2, 3.2]}


def cafe(level):
    stories = 1 if level == 1 else 2
    h, top = house(2, 3, stories, 'wall-wood', -0.3, 0, 'Y', RED, ('X', 1))
    parts = h + [T('stall-red', (1.1, -0.6, 0), 0), *lantern(1.2, 1.4), *lantern(1.2, -1.4)]
    if level >= 3:
        w, _ = house(1, 1, 1, 'wall-wood', -0.3, 2.0, 'X', GREEN, ('Y', 0), chimney=False)
        parts += w + [T('stall-bench', (1.5, 0.6, 0), 90)]
    return {'parts': parts, 'points': {'smoke': top}, 'footprint': [2.6, 3.2]}


def workshop(level):
    parts = walls(2, 2, 1, 'wall', -0.2, -0.2, door=None, windows='wall-window-stone', skip=('X',))
    # The open forge front (+X face): a wide doorway.
    parts += [T('wall-doorway-square-wide', (0.3, -0.2, 0), 0)]
    parts += [gable(2, 2, 1, -0.2, -0.2, 'X', SLATE, STONE)]
    parts += [T('chimney', (-0.9, 0.5, 0.2), 0, (1.3, 1.3, 2.2))]
    parts += [N('log_stack', (-0.2, 1.3, 0), 0), *lantern(1.4, 1.1)]
    if level >= 2:
        parts += [N('log_stackLarge', (-1.2, 1.3, 0), 0)]
    if level >= 3:
        parts += [T('cart', (1.2, -1.1, 0), 90)]
    return {'parts': parts, 'points': {'smoke': (-0.6, 0.5, 2.5), 'forge': (0.6, -0.2, 0.35)}, 'footprint': [2.6, 3]}


def garden(level):
    parts = [T('fountain-round-detail', (0, 0, 0), 0, 1.2), *lantern(1.7, 1.7), *lantern(-1.7, -1.7)]
    if level >= 2:
        parts += [T('stall-green', (1.9, -0.7, 0), 0), T('stall-red', (-0.7, 1.9, 0), 90), *lantern(1.7, -1.7), *lantern(-1.7, 1.7)]
    if level >= 3:
        parts += [T('stall-bench', (1.5, 0.9, 0), 90), T('stall-bench', (0.9, 1.5, 0), 0)]
    return {'parts': parts, 'points': {'fountain': (0, 0, 0.9)}, 'footprint': [5.2, 5.2]}


def observatory(level):
    h = 0.9 + 0.5 * level
    parts = [G('cylinder', x=-0.2, y=-0.2, z=0, r=0.95, h=h, color=STONE), G('box', x=-0.2, y=-0.2, z=h, sx=2.1, sy=2.1, sz=0.08, color=(130, 132, 176)), G('dome', x=-0.2, y=-0.2, z=h + 0.08, r=0.9, color=ACCENT)]
    parts += [T('wall-door', (0.25, -0.2, 0), 0, (1, 0.8, 0.85))]
    if level >= 2:
        a, _ = house(1, 1, 1, 'wall', 0.9, 0.9, 'X', SLATE, ('X', 0), chimney=False)
        parts += a
    if level >= 3:
        parts += [N('statue_obelisk', (1.1, -1.0, 0), 0)]
    parts += [*lantern(1.3, -0.2)]
    return {'parts': parts, 'points': {'orb': (-0.2, -0.2, h + 1.0)}, 'footprint': [2.8, 2.8]}


def archive(level):
    stories = 1 if level < 3 else 2
    h, _ = house(2, 3, stories, 'wall', -0.4, 0, 'Y', SLATE, ('X', 1), chimney=False)
    cols = 2 + level
    parts = [G('box', x=0.95, y=0, z=0, sx=0.9, sy=3.3, sz=0.12, color=(190, 192, 226))]
    parts += [T('pillar-stone', (1.15, -1.3 + i * (2.6 / (cols - 1)), 0.12), 0, (1, 1, 0.9 * stories + 0.1)) for i in range(cols)]
    parts += h + [G('box', x=0.65, y=0, z=0.9 * stories + 0.22, sx=1.2, sy=3.4, sz=0.14, color=(190, 192, 226))]
    parts += [T('stairs-wide-stone', (1.6, 0, 0), 90, (1, 1, 0.15))]
    return {'parts': parts, 'points': {}, 'footprint': [2.8, 3.6]}


def stage(level):
    parts = [G('box', x=-0.3, y=0, z=0, sx=1.8, sy=3.2, sz=0.35, color=DARKWOOD)]
    parts += [T('planks', (-0.3 + dx, y, 0.35)) for dx in (-0.5, 0.5) for y in (-1.5, -0.5, 0.5, 1.5)]
    # Frame and curtains at the back.
    for y in (-1.55, 1.55):
        parts.append(G('box', x=-1.15, y=y, z=0.35, sx=0.14, sy=0.14, sz=1.9, color=WOOD))
    parts += [G('box', x=-1.15, y=0, z=2.2, sx=0.18, sy=3.3, sz=0.16, color=WOOD)]
    parts += [G('box', x=-1.12, y=-1.0, z=0.4, sx=0.06, sy=1.0, sz=1.8, color=ACCENT), G('box', x=-1.12, y=1.0, z=0.4, sx=0.06, sy=1.0, sz=1.8, color=ACCENT), G('box', x=-1.12, y=0, z=1.85, sx=0.06, sy=3.0, sz=0.35, color=ACCENT)]
    for row in range(level):
        parts += [T('stall-bench', (1.0 + row * 0.55, y, 0), 0) for y in (-0.9, 0.9)]
    if level >= 2:
        parts += [T('banner-red', (-1.6, -1.6, 0.4), 0), T('banner-red', (-1.6, 1.4, 0.4), 0)]
    parts += [*lantern(0.8, -1.8), *lantern(0.8, 1.8)]
    return {'parts': parts, 'points': {'spot': (-0.3, 0, 0.4)}, 'footprint': [3.2, 4]}


def lookout(level):
    hgt = 2.4 + 0.5 * level
    parts = []
    for x in (-0.45, 0.45):
        for y in (-0.45, 0.45):
            parts.append(G('box', x=x, y=y, z=0, sx=0.12, sy=0.12, sz=hgt, color=WOOD))
    for k in range(1, 4):
        z = hgt * k / 4
        parts += [G('box', x=0, y=-0.45, z=z, sx=0.95, sy=0.06, sz=0.06, color=DARKWOOD), G('box', x=0.45, y=0, z=z, sx=0.06, sy=0.95, sz=0.06, color=DARKWOOD), G('box', x=0, y=0.45, z=z, sx=0.95, sy=0.06, sz=0.06, color=DARKWOOD), G('box', x=-0.45, y=0, z=z, sx=0.06, sy=0.95, sz=0.06, color=DARKWOOD)]
    parts += [G('box', x=0, y=0, z=hgt, sx=1.3, sy=1.3, sz=0.1, color=WOOD)]
    parts += walls(1, 1, 1, 'wall-wood', 0, 0, door=('X', 0), windows='wall-window-small', z0=hgt + 0.1)
    parts += [gable(1, 1, hgt + 1.1, 0, 0, 'Y', SLATE, WOOD)]
    return {'parts': parts, 'points': {'ravens': (0, 0, hgt + 2.4)}, 'footprint': [2, 2]}


def construction():
    parts = [T('wall-broken', (0.5, 0, 0), 0), T('wall-broken', (0, 0.5, 0), 90), T('wall-half', (-0.5, 0, 0), 180), T('planks', (0, 0, 0))]
    for x, y in ((-0.6, -0.6), (0.6, -0.6), (-0.6, 0.6)):
        parts.append(G('box', x=x, y=y, z=0, sx=0.08, sy=0.08, sz=1.6, color=WOOD))
    parts += [G('box', x=0, y=-0.6, z=1.2, sx=1.3, sy=0.06, sz=0.06, color=WOOD), G('box', x=-0.6, y=0, z=1.2, sx=0.06, sy=1.3, sz=0.06, color=WOOD)]
    parts += [N('log_stack', (1.1, 0.9, 0), 0), N('rock_smallA', (0.9, -1.0, 0), 0)]
    return {'parts': parts, 'points': {}, 'footprint': [2, 2]}


SPRITES = {'construction': {**construction(), 'variants': ['summer', 'winter']}}
for _name, _fn in (('hearth', hearth), ('library', library), ('cafe', cafe), ('workshop', workshop), ('garden', garden), ('observatory', observatory), ('archive', archive), ('stage', stage), ('lookout', lookout)):
    for _level in (1, 2, 3):
        SPRITES[f'{_name}-{_level}'] = {**_fn(_level), 'variants': ['summer', 'winter', 'glow']}

# ------------------------------------------------------------------ nature
# Trees: summer as modelled, autumn recoloured (leaves only, a different hue per tree), winter with snow.
TREES = {
    'oak': ['tree_oak', 'tree_default', 'tree_detailed', 'tree_fat'],
    'pine': ['tree_pineRoundA', 'tree_pineRoundC', 'tree_pineTallA_detailed', 'tree_cone'],
    'birch': ['tree_thin', 'tree_tall'],
}
for _kind, _models in TREES.items():
    for _i, _m in enumerate(_models):
        SPRITES[f'tree-{_kind}-{_i}'] = {'parts': [N(_m, (0, 0, 0), 0, 1.6)], 'variants': ['summer', 'winter', 'autumn'], 'footprint': [1, 1], 'autumn_hue': (0.12, 0.05, 0.17, 0.09)[_i % 4], 'leaf_hue': 0.42 if _kind != 'pine' else 0.45}

PROPS = {
    'rock': ['rock_smallA', 'rock_smallC', 'rock_tallA'],
    'bush': ['plant_bushLarge', 'plant_bushDetailed'],
    'flowers': ['flower_redA', 'flower_yellowB', 'flower_purpleC'],
    'stump': ['stump_roundDetailed', 'log_stack'],
}
for _kind, _models in PROPS.items():
    for _i, _m in enumerate(_models):
        SPRITES[f'prop-{_kind}-{_i}'] = {'parts': [N(_m, (0, 0, 0), 0, 1.4)], 'variants': ['summer', 'winter'], 'footprint': [1, 1]}
SPRITES['prop-lamp-0'] = {'parts': [T('lantern', (0, 0, 0), 0, 1.0)], 'variants': ['summer', 'winter'], 'footprint': [0.4, 0.4], 'points': {'light': (0, 0, 1.38)}}


# ------------------------------------------------------------------ second designs (b), chosen per install
def hearth_b(level):
    a, top = house(3, 2, 1, 'wall', -0.3, 0.3, 'X', ACCENT, ('X', 1))
    parts = a + [*lantern(1.5, -1.4), N('flower_redA', (1.4, 0.9, 0), 0, 1.2)]
    points = {'smoke': top}
    if level >= 2:
        b, top2 = house(1, 2, 2, 'wall-wood', 1.1, -1.0, 'Y', GREEN, ('X', 1))
        parts = b + parts
        points['smoke2'] = top2
    if level >= 3:
        c, top3 = house(2, 1, 1, 'wall-wood', -0.8, -1.6, 'X', BLUE, ('Y', 0))
        parts = c + parts + [T('stall-bench', (1.6, 0.6, 0), 90)]
        points['smoke3'] = top3
    return {'parts': parts, 'points': points, 'footprint': [3.4, 3.8]}


def cafe_b(level):
    stories = 1 if level == 1 else 2
    h, top = house(3, 2, stories, 'wall', 0, -0.2, 'X', BLUE, ('Y', 1))
    parts = h + [T('stall-green', (-0.4, 1.3, 0), 90), *lantern(1.6, 1.2), *lantern(-1.6, 1.2)]
    if level >= 3:
        parts += [T('stall-bench', (0.9, 1.5, 0), 0), N('log_stack', (-1.6, -1.4, 0), 0)]
    return {'parts': parts, 'points': {'smoke': top}, 'footprint': [2.6, 3.2]}


def workshop_b(level):
    parts = walls(2, 2, 1, 'wall-wood', -0.2, -0.2, door=None, windows='wall-window-small', skip=('X',))
    parts += [T('wall-wood-doorway-square-wide', (0.3, -0.2, 0), 0)]
    parts += [gable(2, 2, 1, -0.2, -0.2, 'Y', RED, WOOD)]
    parts += [T('chimney', (-1.0, -0.9, 0.2), 0, (1.3, 1.3, 2.0))]
    parts += [N('log_stackLarge', (0.9, 1.3, 0), 90), *lantern(1.4, -1.2)]
    if level >= 2:
        parts += [T('planks-half', (-0.2, 1.4, 0), 0)]
    if level >= 3:
        parts += [T('cart-high', (1.2, 1.0, 0), 0)]
    return {'parts': parts, 'points': {'smoke': (-0.7, -0.9, 2.3), 'forge': (0.6, -0.2, 0.35)}, 'footprint': [2.6, 3]}


def archive_b(level):
    stories = 1 if level < 3 else 2
    h, _ = house(3, 2, stories, 'wall', 0.2, -0.4, 'X', GREEN, ('Y', 1), chimney=False)
    cols = 2 + level
    parts = [G('box', x=0.2, y=0.95, z=0, sx=3.3, sy=0.9, sz=0.12, color=(190, 192, 226))]
    parts += [T('pillar-stone', (-1.1 + i * (2.6 / (cols - 1)), 1.15, 0.12), 0, (1, 1, 0.9 * stories + 0.1)) for i in range(cols)]
    parts += h + [G('box', x=0.2, y=0.65, z=0.9 * stories + 0.22, sx=3.4, sy=1.2, sz=0.14, color=(190, 192, 226))]
    return {'parts': parts, 'points': {}, 'footprint': [2.8, 3.6]}


for _name, _fn in (('hearth', hearth_b), ('cafe', cafe_b), ('workshop', workshop_b), ('archive', archive_b)):
    for _level in (1, 2, 3):
        SPRITES[f'{_name}-{_level}b'] = {**_fn(_level), 'variants': ['summer', 'winter', 'glow']}


# ------------------------------------------------------------------ homes: the village grows houses
def fence(x0, y0, x1, y1):
    """A wooden fence from (x0, y0) to (x1, y1), along X or Y, one piece per cell."""
    parts = []
    if abs(x1 - x0) > abs(y1 - y0):
        for k in range(int(round(abs(x1 - x0)))):
            parts.append(N('fence_simple', (min(x0, x1) + 0.5 + k, y0, 0), 90))
    else:
        for k in range(int(round(abs(y1 - y0)))):
            parts.append(N('fence_simple', (x0, min(y0, y1) + 0.5 + k, 0), 0))
    return parts


def well(x, y):
    return [G('cylinder', x=x, y=y, z=0, r=0.28, h=0.35, color=STONE), G('box', x=x - 0.22, y=y, z=0.35, sx=0.06, sy=0.06, sz=0.55, color=WOOD), G('box', x=x + 0.22, y=y, z=0.35, sx=0.06, sy=0.06, sz=0.55, color=WOOD), gable(1, 1, 0.9, x, y, 'Y', RED, WOOD, 0.25)]


def home(design):
    designs = {
        0: lambda: house(1, 2, 1, 'wall-wood', 0, 0, 'Y', RED, ('X', 0))[0] + fence(0.9, -1.2, 0.9, 1.2) + [N('flower_yellowB', (0.6, 0.9, 0)), N('flower_redA', (0.6, -0.8, 0))],
        1: lambda: house(2, 2, 1, 'wall', 0, 0, 'X', GREEN, ('X', 1))[0] + [T('stall-bench', (1.4, -0.4, 0), 90), N('plant_bushLarge', (-0.4, 1.4, 0))],
        2: lambda: house(2, 2, 2, 'wall-wood', 0, 0, 'Y', ACCENT, ('X', 0))[0] + [N('log_stack', (0.3, 1.4, 0), 0), *lantern(1.3, 1.2)],
        3: lambda: house(1, 3, 1, 'wall', 0, 0, 'Y', SLATE, ('X', 1))[0] + [T('cart', (1.3, -0.6, 0), 0), N('rock_smallC', (1.1, 1.3, 0))],
        4: lambda: house(2, 1, 1, 'wall-wood', 0, -0.4, 'X', BLUE, ('Y', 0))[0] + well(0.6, 0.9) + fence(-1.1, 1.4, 1.1, 1.4),
        5: lambda: house(2, 2, 2, 'wall', 0, 0, 'X', RED, ('Y', 0))[0] + [N('flower_purpleC', (1.3, 0.4, 0)), N('plant_bushDetailed', (1.3, -0.8, 0)), *lantern(-0.9, 1.4)],
        6: lambda: house(1, 2, 1, 'wall-wood', -0.3, 0, 'Y', GREEN, ('X', 1))[0] + [T('stall', (0.9, 0.2, 0), 0), T('hedge', (0.9, -1.1, 0), 90)],
        7: lambda: tower(0, 0, 3, ACCENT)[0] + house(1, 1, 1, 'wall-wood', 0, 1.0, 'X', SLATE, ('X', 0), chimney=False)[0] + [N('log_stack', (1.1, -0.6, 0))],
    }
    return {'parts': designs[design](), 'points': {}, 'footprint': [2.4, 2.4]}


for _d in range(8):
    SPRITES[f'home-{_d}'] = {**home(_d), 'variants': ['summer', 'winter', 'glow']}


# ------------------------------------------------------------------ mills (animated: one sprite per frame)
def watermill():
    parts = house(2, 2, 1, 'wall', 0, 0, 'Y', SLATE, ('Y', 0))[0]
    parts += [G('box', x=1.15, y=0, z=0.85, sx=0.3, sy=0.12, sz=0.12, color=DARKWOOD)]  # the axle
    return {'parts': parts, 'points': {}, 'footprint': [2.6, 2.4]}


def windmill():
    parts = [G('cylinder', x=0, y=0, z=0, r=0.75, h=2.2, color=STONE, sides=12), G('cone', x=0, y=0, z=2.2, r=0.95, h=1.0, color=RED, sides=12)]
    parts += [T('wall-door', (0.3, 0, 0), 0, (1, 0.7, 0.8)), G('box', x=0.85, y=0, z=2.05, sx=0.3, sy=0.12, sz=0.12, color=DARKWOOD)]
    return {'parts': parts, 'points': {}, 'footprint': [1.8, 1.8]}


SPRITES['watermill'] = {**watermill(), 'variants': ['summer', 'winter', 'glow']}
SPRITES['windmill'] = {**windmill(), 'variants': ['summer', 'winter']}
WHEEL_FRAMES = 12  # over 45 degrees (the wheel looks the same every 45)
BLADE_FRAMES = 12  # over 90 degrees (four blades)
for _k in range(WHEEL_FRAMES):
    SPRITES[f'watermill-wheel-{_k}'] = {'parts': [T('watermill', (1.4, 0, 0.9), 0, 1.0)], 'variants': ['summer', 'winter'], 'footprint': [2.6, 2.4]}
    SPRITES[f'watermill-wheel-{_k}']['parts'][0][2]['rx'] = 45 * _k / WHEEL_FRAMES
for _k in range(BLADE_FRAMES):
    SPRITES[f'windmill-blades-{_k}'] = {'parts': [T('windmill', (1.0, 0, 2.05), 0, 0.8)], 'variants': ['summer', 'winter'], 'footprint': [1.8, 1.8]}
    SPRITES[f'windmill-blades-{_k}']['parts'][0][2]['rx'] = 90 * _k / BLADE_FRAMES


# ------------------------------------------------------------------ crops, fences, more nature
CROPS = {'wheat': 'crops_wheatStageB', 'corn': 'crops_cornStageD', 'pumpkin': 'crop_pumpkin', 'leafs': 'crops_leafsStageB', 'carrot': 'crop_carrot'}
for _kind, _m in CROPS.items():
    SPRITES[f'crop-{_kind}-0'] = {'parts': [N(_m, (0, 0, 0), 0, 1.0)], 'variants': ['summer'], 'footprint': [1, 1]}
SPRITES['prop-fence-x'] = {'parts': [N('fence_simple', (0, 0, 0), 90)], 'variants': ['summer', 'winter'], 'footprint': [1, 1]}
SPRITES['prop-fence-y'] = {'parts': [N('fence_simple', (0, 0, 0), 0)], 'variants': ['summer', 'winter'], 'footprint': [1, 1]}

for _kind, _more in (('oak', ['tree_simple', 'tree_plateau']), ('pine', ['tree_pineSmallA', 'tree_pineRoundE']), ('birch', ['tree_small'])):
    _start = len(TREES[_kind])
    for _j, _m in enumerate(_more):
        _i = _start + _j
        SPRITES[f'tree-{_kind}-{_i}'] = {'parts': [N(_m, (0, 0, 0), 0, 1.6)], 'variants': ['summer', 'winter', 'autumn'], 'footprint': [1, 1], 'autumn_hue': (0.12, 0.05, 0.17, 0.09)[_i % 4], 'leaf_hue': 0.42 if _kind != 'pine' else 0.45}
for _kind, _models in (('mushroom', ['mushroom_redGroup', 'mushroom_tanGroup']), ('log', ['log', 'log_large']), ('grass', ['grass_large', 'grass_leafsLarge'])):
    for _i, _m in enumerate(_models):
        SPRITES[f'prop-{_kind}-{_i}'] = {'parts': [N(_m, (0, 0, 0), 0, 1.4)], 'variants': ['summer', 'winter'], 'footprint': [1, 1]}


# Sprites with accent roofs also get the mask the app tints with the theme.
def _has_accent(spec):
    return any(kind == 'gen' and tuple(kw.get('color', ())) == ACCENT for kind, _m, kw in spec['parts'])


for _spec in SPRITES.values():
    if _has_accent(_spec) and 'roofmask' not in _spec['variants']:
        _spec['variants'] = _spec['variants'] + ['roofmask']
