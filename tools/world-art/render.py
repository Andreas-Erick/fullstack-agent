# Renders the Inner World's sprites from Kenney's CC0 3D kits with Blender (headless).
#
#   blender -b --factory-startup --python tools/world-art/render.py -- <kits dir> <out dir> [only-name ...]
#
# <kits dir> holds the unpacked kits: town/ (Fantasy Town Kit 2.0) and nature/ (Nature Kit), each with
# its "Models/GLB format" (town) or "Models/GLTF format" (nature) folder. Blueprints (what each sprite is
# made of) are in blueprints.py. Every sprite is rendered with an orthographic camera that matches the
# app's isometric projection exactly (renderer/js/world/art.js: a tile is 48 × 24 px, so the camera looks
# down at 30°), lit from the upper left, at SCALE × the world size so it stays sharp when zoomed in.
# Variants: summer (as modelled), winter (snow on every upward face), autumn (trees: green turns to
# orange and red), and a night "glow" pass (only window glass shines, everything else black) that the
# app adds on top after dark. Output: <name>.<variant>.webp and manifest.json (size, anchor = where the
# blueprint's origin, the middle of its footprint on the ground, lands in the image; marked points such
# as chimney tops for smoke). The files go to renderer/assets/world/ with the kits' licences.
import bpy
import json
import math
import os
import sys

from mathutils import Matrix, Vector
from bpy_extras.object_utils import world_to_camera_view

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import blueprints  # noqa: E402

args = sys.argv[sys.argv.index('--') + 1:]
KITS, OUT = os.path.abspath(args[0]), os.path.abspath(args[1])
ONLY = set(args[2:])
SCALE = 3.0  # image pixels per world pixel
PX_PER_UNIT = (48 / math.sqrt(2)) * SCALE  # a 1 × 1 cell's diagonal is one tile (48 world px) wide
ELEVATION = math.radians(30)  # sin(30°) = 0.5: the 2:1 tiles of the app

KIT_DIRS = {
    'town': os.path.join(KITS, 'town', 'Models', 'GLB format'),
    'nature': os.path.join(KITS, 'nature', 'Models', 'GLTF format'),
}

_cache = {}
VARIANT = 'summer'  # the variant being rendered (generators read it)


def load(kit, name):
    """A model as a list of objects in a hidden collection (imported once, linked copies after)."""
    key = (kit, name)
    if key not in _cache:
        folder = KIT_DIRS[kit]
        path = next((os.path.join(folder, name + ext) for ext in ('.glb', '.gltf') if os.path.exists(os.path.join(folder, name + ext))), None)
        if not path:
            raise FileNotFoundError(f'{kit}/{name}')
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        objs = [o for o in bpy.data.objects if o not in before]
        coll = bpy.data.collections.new(f'src:{kit}:{name}')
        for o in objs:
            for c in o.users_collection:
                c.objects.unlink(o)
            coll.objects.link(o)
        _cache[key] = coll
    return _cache[key]


def place(scene_coll, kit, name, pos=(0, 0, 0), rot=0, scale=1.0, tint=None):
    """An instance of a model at pos (Blender units), rotated rot degrees about z."""
    src = load(kit, name)
    inst = bpy.data.objects.new(f'{name}', None)
    inst.instance_type = 'COLLECTION'
    inst.instance_collection = src
    inst.location = Vector(pos)
    inst.rotation_euler = (0, 0, math.radians(rot))
    inst.scale = tuple(scale) if isinstance(scale, (tuple, list)) else (scale, scale, scale)
    scene_coll.objects.link(inst)
    return inst


def srgb(c):
    """sRGB 0..255 → linear 0..1 (Blender colours are linear)."""
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (ch(c[0]), ch(c[1]), ch(c[2]), 1)


def flat_material(name, color, rough=0.8):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = srgb(color)
    bsdf.inputs['Roughness'].default_value = rough
    return m


def mesh_object(coll, name, verts, faces, material, solidify=0.0):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(material)
    if solidify:
        mod = ob.modifiers.new('thick', 'SOLIDIFY')
        mod.thickness = solidify
        mod.offset = -1
    coll.objects.link(ob)
    return ob


def gen_gable(coll, w, d, z, ox=0.0, oy=0.0, along='X', h=None, color=(222, 96, 92), wall=(160, 166, 214), overhang=0.14):
    """A gable roof over a w × d block (ridge along X or Y), its gable walls, a ridge beam and eave trims."""
    h = h if h is not None else 0.42 * (d if along == 'X' else w) + 0.18
    x0, x1, y0, y1 = ox - w / 2, ox + w / 2, oy - d / 2, oy + d / 2
    o = overhang
    roof = flat_material(f'roof-{color}', color, 0.75)
    trim = flat_material(f'trim-{color}', tuple(int(v * 0.72) for v in color), 0.8)
    wallm = flat_material(f'wall-{wall}', wall, 0.9)
    if along == 'X':
        yc = (y0 + y1) / 2
        r0, r1 = (x0 - o, yc, z + h), (x1 + o, yc, z + h)
        verts = [(x0 - o, y0 - o, z), (x1 + o, y0 - o, z), r1, r0, (x0 - o, y1 + o, z), (x1 + o, y1 + o, z)]
        faces = [(0, 1, 2, 3), (4, 3, 2, 5)]
        mesh_object(coll, 'roof', verts, faces, roof, solidify=0.08)
        for x in (x0, x1):
            mesh_object(coll, 'gable', [(x, y0, z), (x, y1, z), (x, yc, z + h * 0.94)], [(0, 1, 2)], wallm, solidify=0.06)
        mesh_object(coll, 'ridge', [(x0 - o, yc - 0.06, z + h + 0.02), (x1 + o, yc - 0.06, z + h + 0.02), (x1 + o, yc + 0.06, z + h + 0.02), (x0 - o, yc + 0.06, z + h + 0.02)], [(0, 1, 2, 3)], trim, solidify=0.07)
    else:
        xc = (x0 + x1) / 2
        r0, r1 = (xc, y0 - o, z + h), (xc, y1 + o, z + h)
        verts = [(x0 - o, y0 - o, z), (x0 - o, y1 + o, z), r1, r0, (x1 + o, y0 - o, z), (x1 + o, y1 + o, z)]
        faces = [(0, 3, 2, 1), (4, 5, 2, 3)]
        mesh_object(coll, 'roof', verts, faces, roof, solidify=0.08)
        for y in (y0, y1):
            mesh_object(coll, 'gable', [(x0, y, z), (x1, y, z), (xc, y, z + h * 0.94)], [(0, 1, 2)], wallm, solidify=0.06)
        mesh_object(coll, 'ridge', [(xc - 0.06, y0 - o, z + h + 0.02), (xc + 0.06, y0 - o, z + h + 0.02), (xc + 0.06, y1 + o, z + h + 0.02), (xc - 0.06, y1 + o, z + h + 0.02)], [(0, 1, 2, 3)], trim, solidify=0.07)
    return z + h


def gen_cone(coll, x, y, z, r, h, color=(120, 110, 200), sides=10):
    """A conical tower roof."""
    import math as m
    verts = [(x + r * m.cos(2 * m.pi * i / sides), y + r * m.sin(2 * m.pi * i / sides), z) for i in range(sides)] + [(x, y, z + h)]
    faces = [(i, (i + 1) % sides, sides) for i in range(sides)]
    mesh_object(coll, 'cone', verts, faces, flat_material(f'cone-{color}', color, 0.7), solidify=0.05)


def gen_dome(coll, x, y, z, r, color=(110, 190, 170)):
    """A half-sphere dome (an observatory)."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=r, location=(x, y, z))
    ob = bpy.context.active_object
    me = ob.data
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(me)
    for v in [v for v in bm.verts if v.co.z < -0.001]:
        bm.verts.remove(v)
    bm.to_mesh(me)
    bm.free()
    for c in ob.users_collection:
        c.objects.unlink(ob)
    coll.objects.link(ob)
    ob.data.materials.append(flat_material(f'dome-{color}', color, 0.4))
    bpy.ops.object.shade_smooth()


def gen_cylinder(coll, x, y, z, r, h, color=(160, 166, 214), sides=14):
    """A round wall (tower body)."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=sides, radius=r, depth=h, location=(x, y, z + h / 2))
    ob = bpy.context.active_object
    for c in ob.users_collection:
        c.objects.unlink(ob)
    coll.objects.link(ob)
    ob.data.materials.append(flat_material(f'cyl-{color}', color, 0.9))


def gen_box(coll, x, y, z, sx, sy, sz, color=(176, 104, 74), glow=False):
    """A box from (x, y, z) (its centre on the ground plane at z) of size sx × sy × sz. glow: a warm light
    inside a building, present only in the night pass (it shows through the window openings)."""
    if glow and VARIANT != 'glow':
        return
    x0, x1, y0, y1 = x - sx / 2, x + sx / 2, y - sy / 2, y + sy / 2
    verts = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), (x0, y0, z + sz), (x1, y0, z + sz), (x1, y1, z + sz), (x0, y1, z + sz)]
    faces = [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]
    mesh_object(coll, 'box', verts, faces, glow_material() if glow else flat_material(f'box-{color}', color, 0.85))


def glow_material():
    m = bpy.data.materials.get('glow-light') or bpy.data.materials.new('glow-light')
    m.use_nodes = True
    nodes, links = m.node_tree.nodes, m.node_tree.links
    for n in list(nodes):
        if n.type != 'OUTPUT_MATERIAL':
            nodes.remove(n)
    emit = nodes.new('ShaderNodeEmission')
    emit.inputs['Color'].default_value = (1.0, 0.62, 0.26, 1)
    emit.inputs['Strength'].default_value = 1.5
    links.new(emit.outputs[0], next(n for n in nodes if n.type == 'OUTPUT_MATERIAL').inputs['Surface'])
    return m


def gen_pyramid(coll, x, y, z, sx, sy, h, color=(100, 120, 210), overhang=0.12):
    """A square pyramid roof (a tower)."""
    x0, x1, y0, y1 = x - sx / 2 - overhang, x + sx / 2 + overhang, y - sy / 2 - overhang, y + sy / 2 + overhang
    verts = [(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), (x, y, z + h)]
    faces = [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)]
    mesh_object(coll, 'pyramid', verts, faces, flat_material(f'pyr-{color}', color, 0.7), solidify=0.06)


GENERATORS = {'gable': gen_gable, 'cone': gen_cone, 'dome': gen_dome, 'cylinder': gen_cylinder, 'box': gen_box, 'pyramid': gen_pyramid}


def setup_world():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _cache.clear()
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.film_transparent = True
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    world = bpy.data.worlds.new('world')
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs[0].default_value = (0.72, 0.76, 0.86, 1)
    bg.inputs[1].default_value = 0.4
    try:
        scene.eevee.use_shadows = True
        scene.eevee.use_raytracing = True
        scene.eevee.ray_tracing_options.resolution_scale = '1'
    except AttributeError:
        pass
    # The sun from the upper left of the screen (Blender +X, −Y, above).
    sun_data = bpy.data.lights.new('sun', 'SUN')
    sun_data.energy = 4.6
    sun_data.angle = math.radians(6)
    sun = bpy.data.objects.new('sun', sun_data)
    sun.rotation_euler = Vector((0.55, -0.62, 1.0)).to_track_quat('Z', 'Y').to_euler()
    scene.collection.objects.link(sun)
    cam_data = bpy.data.cameras.new('cam')
    cam_data.type = 'ORTHO'
    cam = bpy.data.objects.new('cam', cam_data)
    # Looking from +X +Y (the viewer's side in the app) down at 30°.
    d = 50
    cam.location = Vector((d * math.cos(ELEVATION) / math.sqrt(2), d * math.cos(ELEVATION) / math.sqrt(2), d * math.sin(ELEVATION)))
    cam.rotation_euler = (-cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.collection.objects.link(cam)
    scene.camera = cam
    return scene, cam


def mesh_corners(coll):
    """World-space bounding-box corners of everything in the sprite: kit instances and generated meshes."""
    out = []
    for ob in coll.objects:
        if ob.instance_type == 'COLLECTION' and ob.instance_collection:
            for o in ob.instance_collection.all_objects:
                if o.type == 'MESH':
                    m = ob.matrix_world @ o.matrix_world
                    out += [m @ Vector(c) for c in o.bound_box]
        elif ob.type == 'MESH':
            out += [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    return out


def frame(scene, cam, objs, points):
    """Fit the camera tightly around the objects; returns (width, height, anchor, points) in pixels."""
    bpy.context.view_layer.update()
    inv = cam.matrix_world.inverted()
    cs = [inv @ p for p in mesh_corners(objs) + [Vector((0, 0, 0))]]
    minx, maxx = min(c.x for c in cs), max(c.x for c in cs)
    miny, maxy = min(c.y for c in cs), max(c.y for c in cs)
    pad = 0.08
    w_u, h_u = (maxx - minx) + 2 * pad, (maxy - miny) + 2 * pad
    w_px, h_px = max(8, math.ceil(w_u * PX_PER_UNIT)), max(8, math.ceil(h_u * PX_PER_UNIT))
    w_u, h_u = w_px / PX_PER_UNIT, h_px / PX_PER_UNIT
    cam.data.ortho_scale = max(w_u, h_u)
    cx, cy = (minx + maxx) / 2, (miny + maxy) / 2
    big = max(w_u, h_u)
    cam.data.shift_x = cx / big
    cam.data.shift_y = cy / big
    scene.render.resolution_x = w_px
    scene.render.resolution_y = h_px
    scene.render.resolution_percentage = 100
    bpy.context.view_layer.update()

    def px(p):
        v = world_to_camera_view(scene, cam, Vector(p))
        return [round(v.x * w_px, 1), round((1 - v.y) * h_px, 1)]

    return w_px, h_px, px((0, 0, 0)), {k: px(p) for k, p in points.items()}


# ------------------------------------------------------------------ material variants
def each_material():
    for m in bpy.data.materials:
        if m.use_nodes and m.node_tree and 'Principled BSDF' in m.node_tree.nodes:
            yield m


def base_link(m):
    """The node output feeding the BSDF's Base Color (inserting a colour node if there is none)."""
    nodes, links = m.node_tree.nodes, m.node_tree.links
    bsdf = nodes['Principled BSDF']
    inp = bsdf.inputs['Base Color']
    if inp.links:
        return inp.links[0].from_socket, inp, bsdf
    rgb = nodes.new('ShaderNodeRGB')
    rgb.outputs[0].default_value = inp.default_value
    links.new(rgb.outputs[0], inp)
    return rgb.outputs[0], inp, bsdf


def apply_winter():
    """Snow on every face that points up, a little on steep ones."""
    for m in each_material():
        nodes, links = m.node_tree.nodes, m.node_tree.links
        src, inp, _ = base_link(m)
        geo = nodes.new('ShaderNodeNewGeometry')
        sep = nodes.new('ShaderNodeSeparateXYZ')
        links.new(geo.outputs['Normal'], sep.inputs[0])
        ramp = nodes.new('ShaderNodeMapRange')
        ramp.inputs['From Min'].default_value = 0.2
        ramp.inputs['From Max'].default_value = 0.6
        links.new(sep.outputs['Z'], ramp.inputs['Value'])
        mix = nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        links.new(ramp.outputs['Result'], mix.inputs['Factor'])
        links.new(src, mix.inputs['A'])
        mix.inputs['B'].default_value = (0.93, 0.96, 1.0, 1)
        links.new(mix.outputs['Result'], inp)


def apply_autumn(hue=0.12, saturation=1.3):
    """Leaves (anything clearly greener than red) turn orange, red or gold; trunks and stone stay."""
    for m in each_material():
        nodes, links = m.node_tree.nodes, m.node_tree.links
        src, inp, _ = base_link(m)
        sep = nodes.new('ShaderNodeSeparateColor')
        links.new(src, sep.inputs[0])
        green = nodes.new('ShaderNodeMath')
        green.operation = 'SUBTRACT'
        links.new(sep.outputs[1], green.inputs[0])
        links.new(sep.outputs[0], green.inputs[1])
        mask = nodes.new('ShaderNodeMapRange')
        mask.inputs['From Min'].default_value = 0.08
        mask.inputs['From Max'].default_value = 0.25
        links.new(green.outputs[0], mask.inputs['Value'])
        # Hue: rotate the leaf colour to the target (0.5 = unchanged in the Hue/Saturation node).
        hsv = nodes.new('ShaderNodeHueSaturation')
        hsv.inputs['Hue'].default_value = hue
        hsv.inputs['Saturation'].default_value = saturation
        hsv.inputs['Value'].default_value = 1.05
        links.new(src, hsv.inputs['Color'])
        mix = nodes.new('ShaderNodeMix')
        mix.data_type = 'RGBA'
        links.new(mask.outputs['Result'], mix.inputs['Factor'])
        links.new(src, mix.inputs['A'])
        links.new(hsv.outputs['Color'], mix.inputs['B'])
        links.new(mix.outputs['Result'], inp)


def apply_glow():
    """Night pass: everything black; only the light boxes inside the buildings shine (through the windows)."""
    for m in bpy.data.materials:
        if not m.use_nodes or m.name.startswith('glow-'):
            continue
        nodes, links = m.node_tree.nodes, m.node_tree.links
        out = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL'), None)
        if not out:
            continue
        black = nodes.new('ShaderNodeEmission')
        black.inputs['Color'].default_value = (0, 0, 0, 1)
        links.new(black.outputs[0], out.inputs['Surface'])


VARIANTS = {'summer': None, 'winter': apply_winter, 'autumn': apply_autumn, 'glow': apply_glow}


# ------------------------------------------------------------------ rendering
def render_one(name, spec, variant):
    global VARIANT
    VARIANT = variant
    scene, cam = setup_world()
    coll = bpy.data.collections.new('sprite')
    scene.collection.children.link(coll)
    autumn_model = spec.get('autumn_model') if variant == 'autumn' else None
    for kind, model, kw in spec['parts']:
        if autumn_model and kind == 'nature':
            model = autumn_model
        if kind == 'gen':
            GENERATORS[model](coll, **kw)
        else:
            place(coll, kind, model, **kw)
    if spec.get('leaf_hue') is not None and variant in ('summer', 'winter'):
        apply_autumn(spec['leaf_hue'], 1.05)  # the kit's turquoise leaves, greener
    if variant == 'autumn' and not autumn_model:
        apply_autumn(spec.get('autumn_hue', 0.12))
    elif VARIANTS[variant] and not autumn_model:
        VARIANTS[variant]()
    if variant == 'glow':
        scene.world.node_tree.nodes['Background'].inputs[1].default_value = 0
        for o in scene.objects:
            if o.type == 'LIGHT':
                o.data.energy = 0
    w, h, anchor, points = frame(scene, cam, coll, spec.get('points', {}))
    scene.render.image_settings.file_format = 'WEBP'
    scene.render.image_settings.color_mode = 'RGBA'
    scene.render.image_settings.quality = 88
    path = os.path.join(OUT, f'{name}.{variant}.webp')
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return {'w': w, 'h': h, 'ax': anchor[0], 'ay': anchor[1], 'points': points}


def main():
    os.makedirs(OUT, exist_ok=True)
    manifest_path = os.path.join(OUT, 'manifest.json')
    manifest = {}
    if os.path.exists(manifest_path):
        with open(manifest_path, encoding='utf-8') as f:
            manifest = json.load(f)
    sprites = manifest.setdefault('sprites', {})
    manifest['scale'] = SCALE
    manifest['source'] = "Rendered from Kenney's Fantasy Town Kit 2.0 and Nature Kit (CC0, www.kenney.nl) by tools/world-art/render.py"
    for name, spec in blueprints.SPRITES.items():
        if ONLY and name not in ONLY:
            continue
        entry = {'footprint': spec.get('footprint', [1, 1]), 'variants': {}}
        for variant in spec.get('variants', ['summer', 'winter']):
            info = render_one(name, spec, variant)
            entry['variants'][variant] = f'{name}.{variant}.webp'
            entry.update({k: info[k] for k in ('w', 'h', 'ax', 'ay')})
            if info['points']:
                entry['points'] = info['points']
            print(f'rendered {name}.{variant} {info["w"]}x{info["h"]}')
        sprites[name] = entry
    with open(manifest_path, 'w', encoding='utf-8') as f:
        json.dump(manifest, f, indent=1, sort_keys=True)


main()
