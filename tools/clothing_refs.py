"""Reference sheets and prompts for a tank top and shorts, per body.

For each base body this measures the torso and legs on the source mesh
(centimetres) and writes, into clothing/:

* <body>_measurements.json: the landmarks and girths,
* <body>_<garment>_<view>.png: the garment's outline in four views
  (front, side, top, bottom), cut from the body's own shape, on a 1 cm grid,
  with no body in the picture,
* <body>_<garment>.json: an image-generation prompt for the garment alone,
  with the measurements and the reference images to attach.

    python3 tools/clothing_refs.py
"""
import json
from pathlib import Path

import numpy as np
import trimesh
from PIL import Image, ImageDraw

from bodies import BODIES
from glb import read_accessor, read_glb

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "clothing"
PPC = 12                                   # image pixels per cm


def load(body):
    gltf, binary = read_glb(ROOT / body["src"])
    pos = read_accessor(gltf, binary, gltf["meshes"][0]["primitives"][0]["attributes"]["POSITION"])
    verts, inv = np.unique(np.round(pos, 5), axis=0, return_inverse=True)
    skin = gltf["skins"][0]
    ibm = read_accessor(gltf, binary, skin["inverseBindMatrices"]).reshape(-1, 4, 4).transpose(0, 2, 1)
    bones = {gltf["nodes"][j]["name"]: np.linalg.inv(m)[:3, 3] for j, m in zip(skin["joints"], ibm)}
    return trimesh.Trimesh(verts, inv.ravel().reshape(-1, 3), process=False), bones


def loops(mesh, z):
    sec = mesh.section(plane_origin=[0, 0, z], plane_normal=[0, 0, 1])
    return [] if sec is None else [sec.vertices[e.points] for e in sec.entities]


def girth(loop):
    return float(np.linalg.norm(np.diff(loop, axis=0), axis=1).sum())


def torso_loop(mesh, z):
    """The slice loop around the body's middle (x = 0), or None."""
    for lp in loops(mesh, z):
        if lp[:, 0].min() < 0 < lp[:, 0].max():
            return lp
    return None


def measure(mesh, bones, body):
    zs = np.arange(50, bones["Neck"][2], 0.5)
    # Crotch: the highest slice where the legs are still two loops.
    crotch = max(z for z in zs if torso_loop(mesh, z) is None and len(loops(mesh, z)) >= 2)
    # Armpit: the lowest slice where the arms join the torso loop (T-pose).
    width = {z: np.ptp(torso_loop(mesh, z)[:, 0]) for z in zs if z > crotch + 2 and torso_loop(mesh, z) is not None}
    armpit = min(z for z, w in width.items() if w > 50) - 1.0
    g = {z: girth(torso_loop(mesh, z)) for z in width if z < armpit - 0.5}
    hip_z = max((z for z in g if z < crotch + 16), key=g.get)
    waist_z = min((z for z in g if hip_z + 4 < z < armpit - 8), key=g.get)
    # Chest / bust: at the fullest point of the breasts where the body names
    # them, else the fullest slice clear of the armpits.
    if "breasts" in body:
        chest_z = min(g, key=lambda z: abs(z - body["breasts"]["z"]))
    else:
        chest_z = max((z for z in g if waist_z + 6 < z < armpit - 4), key=g.get)
    neck = bones["Neck"]
    neck_loop = torso_loop(mesh, neck[2] + 2.5)
    shoulder_x = abs(bones["LeftArm"][0])
    top = max(v[2] for v in mesh.vertices[np.abs(mesh.vertices[:, 0] - shoulder_x * 0.7) < 0.8] if v[2] < neck[2] + 3)
    thigh = []
    hem = crotch - 9.0
    for lp in loops(mesh, hem):
        if lp[:, 0].mean() > 0:
            thigh.append(girth(lp))
    m = {
        "units": "cm",
        "height": float(mesh.vertices[:, 2].max() + 1.0),
        "crotch_height": round(float(crotch), 1),
        "hip_height": round(float(hip_z), 1), "hip_girth": round(g[hip_z], 1),
        "waist_height": round(float(waist_z), 1), "waist_girth": round(g[waist_z], 1),
        "chest_height": round(float(chest_z), 1), "chest_girth": round(g[chest_z], 1),
        "armpit_height": round(float(armpit), 1),
        "neck_base_height": round(float(neck[2]), 1),
        "neck_base_width": round(float(np.ptp(neck_loop[:, 0])), 1),
        "shoulder_top_height": round(float(top), 1),
        "shoulder_width": round(float(2 * shoulder_x + 3), 1),
        "thigh_girth_at_shorts_hem": round(max(thigh), 1),
        "shorts_hem_height": round(float(hem), 1),
        "torso_width_at_waist": round(float(np.ptp(torso_loop(mesh, waist_z)[:, 0])), 1),
        "torso_width_at_hip": round(float(np.ptp(torso_loop(mesh, hip_z)[:, 0])), 1),
        "torso_depth_at_chest": round(float(np.ptp(torso_loop(mesh, chest_z)[:, 1])), 1),
    }
    return m


# ---------------------------------------------------------------- garment shapes

def tank_hem(m):
    """Tank top hem: on the upper hips, a little under halfway from hip to waist."""
    return m["hip_height"] + 0.45 * (m["waist_height"] - m["hip_height"])


def tank_keep(x, y, z, m, female):
    """Which points of the body surface the tank top covers."""
    strap_in = m["neck_base_width"] / 2 + (1.2 if female else 0.8)
    strap_out = strap_in + (3.0 if female else 4.5)
    top = m["shoulder_top_height"] + 1
    keep = (z > tank_hem(m)) & (z < top)
    # Scoop neckline: a curve from the strap tops down to the neckline's
    # lowest point at the middle (deeper at the front than at the back).
    bottom = np.where(y < 0, m["chest_height"] + (5.0 if female else 7.0), m["armpit_height"] + 3.0)
    t = np.clip(np.abs(x) / strap_in, 0, 1)
    keep &= ~((np.abs(x) < strap_in) & (z > bottom + (top - bottom) * t ** 2.2))
    # Armholes: above the armpit only the straps, curving out below them.
    a = m["armpit_height"]
    keep &= ~((z > a - 3.0) & (np.abs(x) > strap_out + np.clip(a - z, 0, 3.0) ** 2 * 0.8))
    return keep


def shorts_keep(x, y, z, m, female):
    top = m["waist_height"] - (2.0 if female else 3.0)
    return (z > m["shorts_hem_height"]) & (z < top)


def no_arms(mesh, m):
    """The mesh without its arms (T-pose), for the side view of the tank top."""
    c = mesh.triangles_center
    keep = ~((np.abs(c[:, 0]) > m["shoulder_width"] / 2 - 2.5) & (c[:, 2] > m["armpit_height"] - 4))
    return trimesh.Trimesh(mesh.vertices, mesh.faces[keep], process=False)


def grid_image(w_cm, h_cm, origin, horizontal):
    """A white image with a 1 cm grid (5 cm darker) covering w_cm x h_cm."""
    w, h = int(w_cm * PPC), int(h_cm * PPC)
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    for k in range(int(w_cm) + 1):
        c = (215, 215, 215) if (k + int(origin[0])) % 5 else (170, 170, 170)
        d.line([(k * PPC, 0), (k * PPC, h)], c)
    for k in range(int(h_cm) + 1):
        c = (215, 215, 215) if (k + int(origin[1])) % 5 else (170, 170, 170)
        d.line([(0, k * PPC), (w, k * PPC)], c)
    return img, d


def project(mesh, keep_fn, m, female, view, box):
    """Mask of the garment seen orthographically: box = (u0, u1, v0, v1) cm."""
    u0, u1, v0, v1 = box
    us = np.arange(u0, u1, 1 / PPC)
    vs = np.arange(v1, v0, -1 / PPC)
    gu, gv = np.meshgrid(us, vs)
    if view == "front":
        o = np.c_[gu.ravel(), np.full(gu.size, -80.0), gv.ravel()]
        d = [0, 1.0, 0]
    elif view == "side":
        o = np.c_[np.full(gu.size, 80.0), gu.ravel(), gv.ravel()]
        d = [-1.0, 0, 0]
    loc, ray, _ = mesh.ray.intersects_location(o, np.tile(d, (len(o), 1)), multiple_hits=True)
    hit = np.zeros(len(o), bool)
    k = keep_fn(loc[:, 0], loc[:, 1], loc[:, 2], m, female)
    hit[ray[k]] = True
    return hit.reshape(len(vs), len(us))


def draw_mask(mask, title, notes):
    h, w = mask.shape
    img, d = grid_image(w / PPC, h / PPC, (0, 0), True)
    arr = np.asarray(img).copy()
    arr[mask] = (arr[mask] * 0.35 + np.array([90, 140, 210]) * 0.65).astype(np.uint8)
    edge = mask ^ np.pad(mask, 1, mode="edge")[2:, 1:-1] | mask ^ np.pad(mask, 1, mode="edge")[1:-1, 2:]
    arr[edge] = (20, 40, 90)
    img = Image.fromarray(arr)
    return label(img, title, notes)


def label(img, title, notes):
    pad = 70
    out = Image.new("RGB", (img.width, img.height + pad), "white")
    out.paste(img, (0, pad))
    d = ImageDraw.Draw(out)
    d.text((8, 6), title, (0, 0, 0))
    d.text((8, 24), notes, (60, 60, 60))
    d.text((8, 44), "grid: 1 cm squares, darker every 5 cm", (110, 110, 110))
    return out


def draw_loops(rings, box, title, notes, flip=False):
    """Top or bottom view: outlines of slices; rings = [(loop, colour, width)]."""
    u0, u1, v0, v1 = box
    img, d = grid_image(u1 - u0, v1 - v0, (u0, v0), True)
    for lp, colour, width in rings:
        pts = [((p[0] - u0) * PPC, ((p[1] if not flip else -p[1]) - v0) * PPC) for p in lp]
        if flip:
            pts = [((u1 - u0) * PPC - x, y) for x, y in pts]
        d.line(pts + [pts[0]], fill=colour, width=width)
    return label(img, title, notes)


def build(key):
    body = BODIES[key]
    female = key == "female"
    mesh, bones = load(body)
    m = measure(mesh, bones, body)
    OUT.mkdir(exist_ok=True)
    (OUT / f"{key}_measurements.json").write_text(json.dumps(m, indent=2) + "\n")
    arms_off = no_arms(mesh, m)
    half = m["shoulder_width"] / 2 + 6
    garments = {
        "tank_top": (tank_keep, tank_hem(m) - 3, m["shoulder_top_height"] + 3),
        "shorts": (shorts_keep, m["shorts_hem_height"] - 3, m["waist_height"] + 2),
    }
    files = {}
    for name, (keep, z0, z1) in garments.items():
        label_name = name.replace("_", " ")
        front = project(arms_off, keep, m, female, "front", (-half, half, z0, z1))
        side = project(arms_off, keep, m, female, "side", (-18, 18, z0, z1))
        views = {
            "front": draw_mask(front, f"{key} {label_name}: FRONT (garment only)",
                               "outline cut from the character's own body; left of image = character's right"),
            "side": draw_mask(side, f"{key} {label_name}: SIDE (left side; front of body to the left)",
                              "outline cut from the character's own body"),
        }
        if name == "tank_top":
            levels = [(tank_hem(m), (40, 60, 160), 3), (m["waist_height"], (120, 120, 120), 1),
                      (m["chest_height"], (200, 60, 60), 2), (m["armpit_height"] - 1, (120, 120, 120), 1)]
            top_note = "rings: hem (blue), waist (grey), chest (red), under the arms (grey)"
            bottom = [(tank_hem(m), (40, 60, 160), 3), (m["chest_height"], (200, 60, 60), 1)]
            bottom_note = "hem opening (blue) with the chest line (red) seen through"
        else:
            levels = [(m["waist_height"] - (2 if female else 3), (40, 60, 160), 3), (m["hip_height"], (200, 60, 60), 2)]
            top_note = "rings: waistband (blue), hips (red)"
            bottom = [(m["shorts_hem_height"], (40, 60, 160), 3), (m["hip_height"], (200, 60, 60), 1)]
            bottom_note = "leg openings at the hem (blue) with the hip line (red) seen through"
        box = (-half, half, -16, 18)
        rings = [(lp, c, w) for z, c, w in levels for lp in loops(arms_off, z) if np.ptp(lp[:, 0]) > 4]
        views["top"] = draw_loops(rings, box, f"{key} {label_name}: TOP (looking down, front of body at the bottom)", top_note, flip=True)
        rings = [(lp, c, w) for z, c, w in bottom for lp in loops(arms_off, z) if np.ptp(lp[:, 0]) > 4]
        views["bottom"] = draw_loops(rings, box, f"{key} {label_name}: BOTTOM (looking up, front of body at the top)", bottom_note)
        for view, img in views.items():
            path = OUT / f"{key}_{name}_{view}.png"
            img.save(path, optimize=True)
            files.setdefault(name, []).append(path.name)
    return m, files


def prompt(key, garment, m, images):
    female = key == "female"
    who = "female" if female else "male"
    if garment == "tank_top":
        item = (f"a plain fitted {who} tank top (sleeveless vest) in light grey cotton jersey: scoop neckline, "
                f"{'3' if female else '4.5'} cm straps, smooth armholes, hem on the upper hips, no print or logo")
        sizes = {k: m[k] for k in ("chest_girth", "chest_height", "waist_girth", "waist_height", "hip_girth",
                                   "hip_height", "armpit_height", "neck_base_height", "neck_base_width",
                                   "shoulder_top_height", "shoulder_width", "torso_depth_at_chest")}
        sizes["hem_height"] = round(tank_hem(m), 1)
        sizes["length_shoulder_to_hem"] = round(m["shoulder_top_height"] - tank_hem(m), 1)
    else:
        item = (f"plain {who} shorts in dark grey cotton twill: elastic waistband at the "
                f"{'natural waist' if female else 'hips'}, hem at mid-thigh, smooth panels, no pockets, print or logo")
        sizes = {k: m[k] for k in ("waist_girth", "waist_height", "hip_girth", "hip_height", "crotch_height",
                                   "thigh_girth_at_shorts_hem", "shorts_hem_height", "torso_width_at_hip")}
        top = m["waist_height"] - (2 if female else 3)
        sizes["waistband_height"] = round(top, 1)
        sizes["outseam_length"] = round(top - m["shorts_hem_height"], 1)
        sizes["inseam_length"] = round(m["crotch_height"] - m["shorts_hem_height"], 1)
    views = {
        "front": "straight front view, orthographic, centred",
        "side": "straight left side view, orthographic, front of the garment facing left",
        "top": "straight top-down view looking into the garment from above, orthographic",
        "bottom": "straight bottom-up view looking into the garment from below, orthographic",
    }
    return {
        "task": f"Create 4 reference images of {item}, shown on its own (no person, no mannequin, no hanger).",
        "style": "stylised 3D animated film look matching the character, clean 3D render, soft even studio lighting, "
                 "plain white background, no shadows on the floor, whole garment in frame, same scale in every view",
        "fit": "shaped exactly to the attached outlines: the garment as if worn by an invisible body, filled out, "
               "not flat-laid and not on a hanger; follow the outline's proportions exactly",
        "views": [{"name": v, "description": d, "reference_image": f"{key}_{garment}_{v}.png"} for v, d in views.items()],
        "measurements_cm": sizes,
        "body_height_cm": round(m["height"], 1),
        "attach_these_images": images,
        "notes": [
            "Heights are measured from the floor.",
            "Girths are around the body; the garment may be up to 1 cm larger for fabric thickness.",
            "The reference images use a 1 cm grid; match the outline to the grid.",
            "Do not draw the body, skin, head, arms or legs.",
        ],
    }


def main():
    for key in BODIES:
        m, files = build(key)
        for garment, images in files.items():
            (OUT / f"{key}_{garment}.json").write_text(json.dumps(prompt(key, garment, m, images), indent=2) + "\n")
        print(key, json.dumps(m))


if __name__ == "__main__":
    main()
