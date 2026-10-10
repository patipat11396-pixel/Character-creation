"""Build the menu's character models from the base bodies.

Each source (`models/source/f_base.glb`, `models/source/m_base.glb`; three.js
exports in centimetres, Z up, front = -Y) has a Mixamo-style skeleton with one
bone per hand, so the hands cannot close, and the buttocks are weighted almost
entirely to the thigh bones, so they fold into spikes whenever a leg lifts.
Every body-specific position comes from tools/bodies.py.

For each body this script:

* welds the triangle soup into an indexed mesh,
* smooths the body below the chin: flattens the bodysuit's ridges, removes
  the female nipples, evens out dents and bumps, and smooths the shoulders,
  underarms and buttocks (clean_body), and gives the female breasts a set
  round shape (shape_breasts),
* adds 15 finger bones per hand (Thumb, Index, Middle, Ring, Pinky, 3 each),
  placed on the measured finger centrelines, and splits each hand's weight
  between the palm and those bones by distance to each bone,
* moves the buttocks' weight from the thigh bones to Hips down to the gluteal
  fold, then smooths the weights around the pelvis,
* smooths the weights over the shoulders, upper back and neck, where the
  source's hard bone borders crease and wrinkle when the arms are raised,
* adds face shape keys (nose, lips, forehead, chin, jaw, eye sockets),
* stores a lip mask (_LIPMASK) for lip colour in the menu,
* refines the mouth (see face.py), cuts the lips apart and adds mouth shape
  keys (jawOpen, smile, frown, mouthRound) plus teeth and a tongue,
* stores the body's landmarks the menu needs in the scene's extras,
* scales the scene to metres and drops the "_RT" suffix from clip names.

Finger bones point along the finger (+Y) and curl towards the palm when
rotated about their local +X axis, which is what the menu's fist control does.

    python3 tools/process_character.py [female|male ...]     (default: every body)
"""
import argparse
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix, diags

import face
import skin as paint
from bodies import BODIES
from glb import GlbWriter, read_accessor, read_glb

ROOT = Path(__file__).resolve().parent.parent
FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"]
# The old character's head, which the hairstyles were fitted to, in its mesh
# centimetres: the top, the half width and the front and back 6 cm below the
# top, and the bottom of the chin.
REF_HEAD = {"top": 164.63, "half": 10.31, "front": 2.6, "back": 26.75, "chin": 136.33}
PALM_NORMAL = np.array([0.0, 0.0, -1.0])          # palms face down in the T-pose
# Thumb curl direction per bone, found by searching for the axes and angles that
# put the thumb tip on the curled index and middle fingers without bending the
# thumb's base, which tears the palm.
THUMB_CURL = [np.array([0.0, 0.9, -0.45]), np.array([0.0, 0.37, -0.93]), np.array([0.0, 0.37, -0.93])]


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def head_map(verts, body):
    """Per-axis scale and offset taking the old head onto this one:
    new = scale * old + offset (mesh cm). The menu moves hairstyles with it."""
    top = verts[:, 2].max()
    level = verts[np.abs(verts[:, 2] - (top - 6)) < 0.3]
    half = np.abs(level[:, 0]).max()
    front, back = level[:, 1].min(), level[:, 1].max()
    r = REF_HEAD
    scale = np.array([half / r["half"], (back - front) / (r["back"] - r["front"]),
                      (top - body["chin_z"]) / (r["top"] - r["chin"])])
    offset = np.array([0.0, front - scale[1] * r["front"], top - scale[2] * r["top"]])
    return {"scale": [round(float(v), 4) for v in scale], "offset": [round(float(v), 3) for v in offset]}


def body_colliders(verts, bind, body):
    """Ellipsoids that keep hair outside the body, one per bone segment.

    Each is fitted to a slab of the bind-pose mesh (its bounding box, grown
    so the ellipsoid's equator reaches the surface) and is carried by a bone:
    the torso by the spine, the neck, the shoulders, the upper arms.
    Returns [{bone, centre, radii}] in mesh cm.
    """
    x, y, z = verts.T
    out = []

    def fit(bone, sel, grow=(1.1, 1.12, 1.35), radii=None):
        p = verts[sel]
        lo, hi = p.min(0), p.max(0)
        centre = (lo + hi) / 2
        r = (hi - lo) / 2 * np.array(grow) if radii is None else np.array(radii)
        out.append({"bone": bone, "centre": [round(float(v), 2) for v in centre],
                    "radii": [round(float(v), 2) for v in r]})

    arm_x = abs(bind("LeftArm")[0])
    neck_z, head_z = bind("Neck")[2], bind("Head")[2]
    chest = (abs(x) < arm_x) & (z > bind("Spine2")[2] - 3) & (z < neck_z - 1)
    fit("Spine2", chest)
    fit("Spine1", (abs(x) < arm_x) & (z > bind("Spine1")[2] - 4) & (z < bind("Spine2")[2]))
    fit("Hips", (abs(x) < arm_x + 4) & (z > bind("Hips")[2] - 14) & (z < bind("Spine")[2]))
    fit("Neck", (abs(x) < 6) & (z > neck_z - 1) & (z < (neck_z + head_z) / 2 + 1) & (y > body["nose_tip"][0] + 4),
        grow=(1.08, 1.08, 1.6))
    for side in ("Left", "Right"):
        a, f = bind(f"{side}Arm"), bind(f"{side}ForeArm")
        s = np.sign(a[0])
        fit(f"{side}Shoulder", (np.linalg.norm(verts - (a + [-s * 2.5, 0, 1.5]), axis=1) < 7.5), grow=(1.0, 1.0, 1.0))
        upper = (x * s > abs(a[0]) + 2) & (x * s < abs(f[0])) & (np.abs(z - (a[2] + f[2]) / 2) < 7)
        upper &= np.abs(y - (a[1] + f[1]) / 2) < 7
        fit(f"{side}Arm", upper, grow=(0.62, 1.15, 1.15))
    return out


def matrix(acc_rows):
    """glTF column-major MAT4 rows -> (n, 4, 4) matrices."""
    return acc_rows.reshape(-1, 4, 4).transpose(0, 2, 1)


def frame(origin, toward, curl_dir):
    """Bone frame: +Y along the bone, rotating about +X moves +Y towards curl_dir."""
    y = toward - origin
    y /= np.linalg.norm(y)
    x = np.cross(y, curl_dir)
    x /= np.linalg.norm(x)
    z = np.cross(x, y)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, z, origin
    return m


def slice_centre(verts, x, y=None, half=0.7, lateral=0.6, mask=None):
    sel = np.abs(verts[:, 0] - x) < half
    if y is not None:
        sel &= np.abs(verts[:, 1] - y) < lateral
    if mask is not None:
        sel &= mask
    return verts[sel].mean(0)


def hand_landmarks(verts, side, body):
    """Joint chains in mesh space for one hand. side=+1 left, -1 right."""
    h = verts * [side, 1, 1]
    hand = h[:, 0] > body["hand_x"]
    chains = {}
    for name, yc in body["finger_y"].items():
        band = hand & (np.abs(h[:, 1] - yc) < 0.6)
        tip_x = h[band, 0].max()
        knuckle_x = body["knuckle_x"][name]
        length = tip_x - knuckle_x
        xs = [knuckle_x, knuckle_x + 0.46 * length, knuckle_x + 0.75 * length]
        pts = [slice_centre(h, x, yc, half=0.8, lateral=0.9, mask=hand) for x in xs]
        for p, x in zip(pts, xs):
            p[0], p[1] = x, yc
        tip = np.array([tip_x - 0.4, yc, pts[-1][2]])
        chains[name] = pts + [tip]
    thumb = hand & (h[:, 1] < body["thumb_max_y"]) & (h[:, 0] > body["thumb_xy"][0][0])
    tip = h[thumb][h[thumb, 0].argmax()].copy()
    tip[0] -= 0.4
    joints = []
    for x, y in body["thumb_xy"]:
        near = hand & (np.hypot(h[:, 0] - x, h[:, 1] - y) < 1.2)
        joints.append(np.array([x, y, h[near, 2].mean()]))
    chains["Thumb"] = joints + [tip]
    for name in chains:
        chains[name] = [p * [side, 1, 1] for p in chains[name]]
    return chains


def segment_distance(p, a, b):
    ab = b - a
    t = np.clip(((p - a) @ ab) / (ab @ ab), 0, 1)
    return np.linalg.norm(p - (a + t[:, None] * ab), axis=1)


def adjacency(n, faces):
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    a = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    a = ((a + a.T) > 0).astype(float)
    return diags(1 / np.asarray(a.sum(1)).ravel()) @ a


def crease_angles(verts, faces):
    """Largest dihedral angle (degrees) across any edge at each vertex."""
    fn = np.cross(verts[faces[:, 1]] - verts[faces[:, 0]], verts[faces[:, 2]] - verts[faces[:, 0]])
    fn /= np.linalg.norm(fn, axis=1, keepdims=True) + 1e-12
    edges = np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), axis=1)
    owner = np.tile(np.arange(len(faces)), 3)
    order = np.lexsort((edges[:, 1], edges[:, 0]))
    edges, owner = edges[order], owner[order]
    pair = np.flatnonzero((edges[1:] == edges[:-1]).all(1))
    angle = np.degrees(np.arccos(np.clip((fn[owner[pair]] * fn[owner[pair + 1]]).sum(1), -1, 1)))
    score = np.zeros(len(verts))
    for c in (0, 1):
        np.maximum.at(score, edges[pair, c], angle)
    return score


def clean_body(verts, faces, avg, body, bone_at):
    """Smooth the body below the chin; returns (new verts, vertices moved).

    * Ridges: the sources carry raised edge loops where a bodysuit was
      (neckline, armholes, side seams, cuffs). Every crease sharper than 12
      degrees outside the hands, feet and the crotch is flattened with three
      rings around it: a plain Laplacian pass on the ridge itself (a step
      survives Taubin smoothing), then Taubin smoothing, which keeps volume.
    * Nipples (bodies with "nipples": true): a plain Laplacian pass over 2.5 cm
      around the most forward point of each breast flattens them.
    * Shoulders, underarms and buttocks get full-strength Taubin smoothing;
      the rest of the body a light pass that takes out small dents and bumps.
    bone_at(name) is a bone's bind position in mesh space.
    """
    x, y, z = verts.T
    region = (z > 9) & (z < body["chin_z"] - 2.5) & (np.abs(x) < body["hand_x"] - 1)
    region &= ~((np.abs(x) < 2.5) & (z > 70) & (z < 100))          # crotch and buttock cleft
    ridge = (crease_angles(verts, faces) > 12) & region
    grow = ridge.astype(float)
    for _ in range(3):
        grow = np.maximum(grow, (avg @ grow > 0) * 1.0)
    w = 0.3 * region + 0.7 * ((grow > 0) & region)

    def zone(centre, radius):
        d = np.linalg.norm(verts - centre, axis=1)
        return np.clip(1.6 - 1.6 * d / radius, 0, 1) * region

    for side in ("Left", "Right"):
        arm = bone_at(f"{side}Arm")
        s = np.sign(arm[0])
        w = np.maximum(w, zone(arm + [0, 0, 1.5], 10))                       # shoulder
        w = np.maximum(w, zone(arm + [-s * 2.5, 1.0, -7.0], 8))              # underarm
        hip = bone_at(f"{side}UpLeg")
        w = np.maximum(w, zone(hip + [s * 1.0, 7.0, -4.0], 10))              # buttock
    w = np.clip(w, 0, 1)
    out = verts.copy()
    core = (ridge | (avg @ ridge.astype(float) > 0)) & region
    for _ in range(8):
        out[core] = 0.5 * out[core] + 0.5 * (avg @ out)[core]
    if body.get("nipples"):
        for s in (-1, 1):
            breast = region & (x * s > 3) & (x * s < 14) & (np.abs(z - body["breast_z"]) < 6)
            tip = verts[np.flatnonzero(breast)[verts[breast, 1].argmin()]]
            near = np.linalg.norm(verts - tip, axis=1)
            flat = near < 2.5
            for _ in range(25):
                out[flat] = 0.5 * out[flat] + 0.5 * (avg @ out)[flat]
            w = np.maximum(w, np.clip(1.5 - near / 3.0, 0, 1) * region)
    for _ in range(30):
        for factor in (0.5, -0.53):
            out += (factor * w)[:, None] * (avg @ out - out)
    moved = np.linalg.norm(out - verts, axis=1) > 1e-4
    return out, moved


def shape_breasts(verts, avg, body):
    """Give the breasts a set shape (body["breasts"]): round, full underneath.

    The chest wall under them is found by relaxing the chest with its edge
    held (a membrane over the breasts' base); each breast is then a dome on
    that wall, its height (1 - u^2)^0.6 times `depth` over an ellipse that
    reaches further up than down, so the upper slope is long and the
    underside round. Points move forward or back only; the ellipse's rim
    fades into the original surface.
    """
    b = body["breasts"]
    x, y, z = verts.T
    dx = (np.abs(x) - b["x"]) / b["rx"]
    dz = (z - b["z"]) / np.where(z > b["z"], b["up"], b["down"])
    u = np.hypot(dx, dz)
    front = y < body["nose_tip"][0] + 10
    # Chest wall: the breast area relaxed with a ring around it held.
    region = (u < 1.6) & front
    wall = verts.copy()
    for _ in range(300):
        wall[region] = (avg @ wall)[region]
    height = b["depth"] * np.clip(1 - u ** 2, 0, 1) ** 0.6
    # Forward/back offset to the new shape, fading out over the ring, then
    # smoothed near the edge (not on the dome) so the edge leaves no crease.
    offset = (wall[:, 1] - height - y) * smoothstep(1.5, 0.95, u) * region
    edge = region & (u > 0.8)
    for _ in range(25):
        offset[edge] = 0.5 * offset[edge] + 0.5 * (avg @ offset)[edge]
    out = verts.copy()
    out[:, 1] += offset
    moved = np.abs(offset) > 1e-4
    return out, moved


def flatten_brows(verts, avg, body):
    """Relax the brow box (body["brow_box"], mirrored for the right brow) on
    the front of the face, fading out over 1 cm around it."""
    x0, z0, x1, z1 = body["brow_box"]
    x, y, z = verts.T
    ax = np.abs(x)
    w = (smoothstep(x0 - 1, x0, ax) * smoothstep(x1 + 1, x1, ax) * smoothstep(z0 - 1, z0, z)
         * smoothstep(z1 + 1, z1, z) * (y < body["nose_tip"][0] + 8))
    out = verts.copy()
    for _ in range(30):
        out += (0.5 * w)[:, None] * (avg @ out - out)
    return out, w > 0


def vertex_normals(verts, faces):
    fn = np.cross(verts[faces[:, 1]] - verts[faces[:, 0]], verts[faces[:, 2]] - verts[faces[:, 0]])
    normals = np.zeros_like(verts)
    for k in range(3):
        np.add.at(normals, faces[:, k], fn)
    return normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)


def smooth_rows(weights, avg, mask, iterations, alpha=0.5):
    for _ in range(iterations):
        blurred = avg @ weights
        weights[mask] = (1 - alpha) * weights[mask] + alpha * blurred[mask]
    return weights


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("bodies", nargs="*", help=f"any of {', '.join(BODIES)} (default: all)")
    for key in ap.parse_args().bodies or BODIES:
        print(f"== {key}")
        build(BODIES[key])


def build(body):
    face.configure(body)
    gltf, binary = read_glb(ROOT / body["src"])
    prim = gltf["meshes"][0]["primitives"][0]
    attr = prim["attributes"]
    skin = gltf["skins"][0]
    pos = read_accessor(gltf, binary, attr["POSITION"])
    nrm = read_accessor(gltf, binary, attr["NORMAL"])
    jnt = read_accessor(gltf, binary, attr["JOINTS_0"])
    wgt = read_accessor(gltf, binary, attr["WEIGHTS_0"])
    ibm = matrix(read_accessor(gltf, binary, skin["inverseBindMatrices"]))
    names = [gltf["nodes"][j]["name"] for j in skin["joints"]]
    bone = {n: i for i, n in enumerate(names)}

    # Weld: identical corners carry identical normals and weights in this export.
    verts, first, inverse = np.unique(np.round(pos, 5), axis=0, return_index=True, return_inverse=True)
    faces = inverse.ravel().reshape(-1, 3)
    normals = nrm[first]
    source_weights = np.zeros((len(verts), len(names)))
    np.add.at(source_weights, (np.repeat(np.arange(len(verts)), 4), jnt[first].ravel()), wgt[first].ravel())
    print(f"source: {len(pos)} corners -> {len(verts)} vertices, {len(faces)} triangles")

    # ---- face: refine the mouth, then cut the lips apart
    before = len(verts)
    verts, faces, (normals, source_weights) = face.refine_mouth(verts, faces, [normals, source_weights])
    print(f"mouth area: {len(verts) - before} vertices added")
    verts, faces, (normals, source_weights), upper_lip, lower_lip = face.cut_mouth(
        verts, faces, [normals, source_weights])
    print(f"mouth: lip line of {len(upper_lip)} vertices cut")
    painted = paint.load_painted(ROOT / body["painted"], pos)
    face_uv, projected = paint.corner_uvs(verts, faces, painted)
    print(f"painted UVs: {len(faces) - projected} faces matched, {projected} projected")
    n = len(verts)
    lips = face.lip_mask(verts)

    # ---- finger bones
    new_ibm = list(ibm)
    hand_bones = {}  # side -> list of (joint index, segment start, segment end)
    for side, prefix in ((1, "Left"), (-1, "Right")):
        hand = bone[f"{prefix}Hand"]
        chains = hand_landmarks(verts, side, body)
        knuckles = np.mean([chains[f][0] for f in body["finger_y"]], axis=0)
        segments = [(hand, np.linalg.inv(ibm[hand])[:3, 3], knuckles)]
        for finger in FINGERS:
            pts = chains[finger]
            parent, parent_ibm = gltf["skins"][0]["joints"][hand], ibm[hand]
            for k in range(3):
                curl = THUMB_CURL[k] if finger == "Thumb" else PALM_NORMAL
                f = frame(pts[k], pts[k + 1], curl / np.linalg.norm(curl))
                local = parent_ibm @ f
                node = {"name": f"{prefix}Hand{finger}{k + 1}", "matrix": local.T.ravel().tolist()}
                gltf["nodes"].append(node)
                idx = len(gltf["nodes"]) - 1
                gltf["nodes"][parent].setdefault("children", []).append(idx)
                skin["joints"].append(idx)
                new_ibm.append(np.linalg.inv(f))
                names.append(node["name"])
                segments.append((len(names) - 1, pts[k], pts[k + 1]))
                parent, parent_ibm = idx, np.linalg.inv(f)
        hand_bones[side] = (hand, bone.get(f"{prefix}Hand_end"), segments)

    dense = np.zeros((n, len(names)))
    dense[:, :source_weights.shape[1]] = source_weights
    avg = adjacency(n, faces)

    # Split each hand's weight between the palm and the finger bones.
    for side, (hand, hand_end, segments) in hand_bones.items():
        share = dense[:, hand] + (dense[:, hand_end] if hand_end is not None else 0)
        idx = np.flatnonzero(share > 0)
        p = verts[idx]
        score = np.stack([1 / (segment_distance(p, a, b) + 0.4) ** 5 for _, a, b in segments], 1)
        score /= score.sum(1, keepdims=True)
        dense[idx, hand] = 0
        if hand_end is not None:
            dense[idx, hand_end] = 0
        for col, (j, _, _) in enumerate(segments):
            dense[idx, j] += share[idx] * score[:, col]
        mask = np.zeros(n, bool)
        mask[idx] = True
        mask &= (verts[:, 0] * side) > body["wrist_x"]   # leave the wrist blend as authored
        dense = smooth_rows(dense, avg, mask, iterations=6)

    # ---- buttocks: follow Hips down to the gluteal fold
    hips = bone["Hips"]
    for prefix in ("Left", "Right"):
        up, knee = bone[f"{prefix}UpLeg"], bone[f"{prefix}Leg"]
        a = np.linalg.inv(ibm[up])[:3, 3]
        b = np.linalg.inv(ibm[knee])[:3, 3]
        down = (b - a) / np.linalg.norm(b - a)
        t = (verts - a) @ down                       # cm down the thigh
        back = smoothstep(*body["hip_back_y"], verts[:, 1])   # 0 at the front, 1 behind the hip joint
        h = back * (1 - smoothstep(6, 18, t))
        moved = dense[:, up] * h
        dense[:, up] -= moved
        dense[:, hips] += moved
    z0, z1 = body["pelvis_z"]
    pelvis = (verts[:, 2] > z0) & (verts[:, 2] < z1) & (np.abs(verts[:, 0]) < 26)
    dense = smooth_rows(dense, avg, pelvis, iterations=12)

    # ---- shoulders, upper back and neck: the source hands off between Spine2,
    # the shoulders, the upper arms and the neck along hard lines, which crease
    # and wrinkle when the arms go up. Stop below the jaw and above the elbows.
    z0, z1 = body["shoulders_z"]
    shoulders = (verts[:, 2] > z0) & (verts[:, 2] < z1) & (np.abs(verts[:, 0]) < 30)
    dense = smooth_rows(dense, avg, shoulders, iterations=25)

    # ---- smooth the body; recompute normals where it moved
    bind = {nm: np.linalg.inv(ibm[i])[:3, 3] for nm, i in bone.items() if i < len(ibm)}
    verts, moved = clean_body(verts, faces, avg, body, bind.__getitem__)
    print(f"body: smoothed {moved.sum()} vertices")
    near = moved | (avg @ moved.astype(float) > 0)
    normals[near] = vertex_normals(verts, faces)[near]

    # ---- breasts: a set shape where the body defines one
    if "breasts" in body:
        verts, shaped = shape_breasts(verts, avg, body)
        print(f"breasts: shaped {shaped.sum()} vertices")
        near = shaped | (avg @ shaped.astype(float) > 0)
        normals[near] = vertex_normals(verts, faces)[near]

    # ---- brows: the sculpted brow ridges stay behind when the menu moves the
    # painted brows, so the brow area is relaxed flat (both sides, front only)
    verts, flat = flatten_brows(verts, avg, body)
    print(f"brows: relaxed {flat.sum()} vertices")
    near = flat | (avg @ flat.astype(float) > 0)
    normals[near] = vertex_normals(verts, faces)[near]

    # ---- mouth shape keys
    morphs, _ = face.mouth_morphs(verts, faces, upper_lip, lower_lip)
    morphs.update(face.face_shapes(verts))
    MORPH_NAMES = face.MORPHS + list(face.FACE_SHAPES)
    base_n = vertex_normals(verts, faces)
    morph_normals = {k: vertex_normals(verts + d, faces) - base_n for k, d in morphs.items()}

    # ---- keep the 4 strongest influences
    order = np.argsort(-dense, axis=1)[:, :4]
    top = np.take_along_axis(dense, order, axis=1)
    top[top < 0.01] = 0
    top /= top.sum(1, keepdims=True)

    # ---- split vertices along the painted texture's UV seams
    faces, old, uvs = paint.split_by_uv(faces, face_uv)
    verts, normals, order, top, lips = verts[old], normals[old], order[old], top[old], lips[old]
    morphs = {k: d[old] for k, d in morphs.items()}
    morph_normals = {k: d[old] for k, d in morph_normals.items()}
    print(f"uv seams: {len(old)} vertices")

    out = GlbWriter(gltf, binary)
    g = out.gltf
    out.replace(attr["POSITION"], verts.astype(np.float32), 34962)
    out.replace(attr["NORMAL"], normals.astype(np.float32), 34962)
    out.replace(attr["JOINTS_0"], order.astype(np.uint16), 34962)
    out.replace(attr["WEIGHTS_0"], top.astype(np.float32), 34962)
    g["meshes"][0]["primitives"][0]["attributes"]["TEXCOORD_0"] = out.append(uvs.astype(np.float32), 34962)
    out.replace(skin["inverseBindMatrices"],
                np.array([m.T.ravel() for m in new_ibm], np.float32))
    skinned = g["meshes"][0]["primitives"][0]
    skinned["indices"] = out.append(faces.astype(np.uint32).reshape(-1, 1), 34963)
    skinned["attributes"]["_LIPMASK"] = out.append(lips.reshape(-1, 1), 34962)
    skinned["targets"] = [{"POSITION": out.append_sparse(morphs[k]),
                         "NORMAL": out.append_sparse(morph_normals[k])} for k in MORPH_NAMES]

    # ---- teeth and tongue: extra primitives on the same mesh, bound to Head
    head = bone["Head"]
    for name, color, roughness, parts in (
            ("Teeth", [0.95, 0.93, 0.88, 1], 0.3, [p for p in face.mouth_parts(verts) if "Teeth" in p[0]]),
            ("Gums", [0.78, 0.4, 0.44, 1], 0.5, [p for p in face.mouth_parts(verts) if "Gum" in p[0]]),
            ("Tongue", [0.62, 0.24, 0.26, 1], 0.6, [p for p in face.mouth_parts(verts) if p[0] == "Tongue"])):
        pv, pf, jw = [], [], []
        for _, v_, f_, w_ in parts:
            pf.append(f_ + sum(len(x) for x in pv))
            pv.append(v_)
            jw.append(np.full(len(v_), w_))
        pv, pf, jw = np.vstack(pv), np.vstack(pf), np.concatenate(jw)
        pn = vertex_normals(pv, pf)
        jaw = (face.rotate_jaw(pv) - pv) * jw[:, None]
        jaw_n = vertex_normals(pv + jaw, pf) - pn
        zero = np.zeros_like(pv, dtype=np.float32)
        joints = np.zeros((len(pv), 4), np.uint16)
        joints[:, 0] = head
        weights = np.zeros((len(pv), 4), np.float32)
        weights[:, 0] = 1
        g["materials"].append({"name": name, "pbrMetallicRoughness": {
            "baseColorFactor": color, "metallicFactor": 0, "roughnessFactor": roughness}})
        targets = []
        for k in MORPH_NAMES:
            d, dn = (jaw, jaw_n) if k == "jawOpen" else (zero, zero)
            targets.append({"POSITION": out.append_sparse(np.asarray(d, np.float32)),
                            "NORMAL": out.append_sparse(np.asarray(dn, np.float32))})
        g["meshes"][0]["primitives"].append({
            "attributes": {"POSITION": out.append(pv.astype(np.float32), 34962),
                           "NORMAL": out.append(pn.astype(np.float32), 34962),
                           "JOINTS_0": out.append(joints, 34962),
                           "WEIGHTS_0": out.append(weights, 34962)},
            "indices": out.append(pf.astype(np.uint32).reshape(-1, 1), 34963),
            "material": len(g["materials"]) - 1,
            "targets": targets,
        })
    g["meshes"][0]["weights"] = [0] * len(MORPH_NAMES)
    g["meshes"][0]["extras"] = {"targetNames": MORPH_NAMES}
    g["meshes"][0]["name"] = g["nodes"][1]["name"] = "Body"
    g["materials"][0]["name"] = "Skin"
    g["nodes"][0]["scale"] = [0.01, 0.01, 0.01]  # centimetres -> metres
    # Landmarks the menu reads (gltf.scene.userData.body), in mesh centimetres.
    extras = {k: body[k] for k in ("label", "eye", "top_z", "chin_z", "nose_tip", "brow_z")}
    extras["head_map"] = head_map(verts, body)
    extras["colliders"] = body_colliders(verts, bind.__getitem__, body)
    g["scenes"][0].setdefault("extras", {})["body"] = extras
    print(f"head map: {extras['head_map']}")
    for anim in g["animations"]:
        anim["name"] = anim["name"].removesuffix("_RT")
    g["asset"]["generator"] = "Character-creation tools/process_character.py"
    out.write(ROOT / body["out"])
    print(f"bones: {len(names)} ({len(names) - len(ibm)} finger bones added)")
    print(f"wrote {body['out']} ({(ROOT / body['out']).stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
