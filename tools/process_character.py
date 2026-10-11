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
import trimesh
from scipy.sparse import coo_matrix, diags
from scipy.spatial import cKDTree

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


def shape_breasts(verts, faces, avg, body):
    """Give the breasts a set shape (body["breasts"]): a round volume set on
    the chest, as in a side view of a real breast.

    The chest wall under them is found by relaxing the chest with a ring
    around it held. Each breast is an ellipsoid (half widths rx across,
    `depth` front to back, `up` above and `down` below its centre) whose
    front reaches `depth` cm in front of the wall; the surface takes
    whichever is further forward, wall or ellipsoid, joined with a smooth
    minimum so there is a soft fold underneath and a gentle slope above.
    Points move forward or back only.
    """
    b = body["breasts"]
    x, y, z = verts.T
    sx = np.sqrt(x ** 2 + 1.0)                                   # smooth |x|
    reach = b["down"] + (b["up"] - b["down"]) * smoothstep(-3.0, 3.0, z - b["z"])
    dx, dz = (sx - b["x"]) / b["rx"], (z - b["z"]) / reach
    u = np.hypot(dx, dz)
    # Front of the chest only: surface facing forward (the sides and back of
    # the ribcage stay as they are).
    smooth = verts.copy()
    for _ in range(10):
        smooth = 0.5 * smooth + 0.5 * (avg @ smooth)
    fn = vertex_normals(smooth, faces)
    facing = smoothstep(0.25, 0.6, -fn[:, 1])
    region = (u < 1.7) & (facing > 0)
    wall = verts.copy()
    for _ in range(300):
        wall[region] = (avg @ wall)[region]
    wy = wall[:, 1]
    centre = region & (u < 0.15)
    cy = np.median(wy[centre])                                    # ellipsoid centre on the wall
    q2 = dx ** 2 + dz ** 2
    qn = np.sqrt(q2) + 1e-6
    ell = np.where(q2 < 1, cy - b["depth"] * np.sqrt(np.clip(1 - q2, 0, 1)), np.inf)
    # Softness of the join (cm): a tight fold underneath, a long soft blend
    # above and towards the middle, so there is no crease there.
    k = b.get("fold", 0.5) + 2.2 * np.clip(smoothstep(-0.2, 0.7, dz / qn) + smoothstep(0.0, -0.7, dx / qn), 0, 1)
    base = y + (wy - y) * smoothstep(1.35, 1.0, u)               # old breast down to the wall
    def smin(p, q, kk):
        a_, c_ = -p / kk, -q / kk
        m = np.maximum(a_, c_)
        return -kk * (m + np.log(np.exp(a_ - m) + np.exp(c_ - m)))

    new_y = smin(base, np.where(np.isfinite(ell), ell, 1e6), k)
    # Upper slope: from the fullest point a near-straight line runs up and
    # back into the upper chest (`slope` cm back per cm up), instead of the
    # chest dropping away above the breast.
    top = cy - b["depth"]
    rise = np.clip(z - b["z"], 0, None)
    ramp = top + b.get("slope", 0.75) * rise + 0.02 * rise ** 2
    across = np.clip(1 - dx ** 2, 0, 1)
    ramp = ramp + (1 - np.sqrt(across)) * 12 + np.where(z < b["z"], 30, 0)
    new_y = smin(new_y, ramp, 1.2)
    offset = (new_y - y) * facing * smoothstep(1.7, 1.4, u) * region
    # Smooth the change itself (not the surface), so the coarse mesh takes it
    # without facets.
    spread = region | (avg @ region.astype(float) > 0)
    for _ in range(25):
        offset[spread] = 0.5 * offset[spread] + 0.5 * (avg @ offset)[spread]
    out = verts.copy()
    out[:, 1] += offset
    area = region & (u < 1.5)
    for _ in range(6):
        for factor in (0.5, -0.53):
            out[area] += factor * (avg @ out - out)[area]
    moved = (np.abs(offset) > 1e-4) | area
    return out, moved


BROW_MORPHS = ("browRidgeUp", "browRidgeOut", "browRidgeTilt")


def brow_ridge_morphs(verts, faces, body):
    """Shape keys that carry the sculpted brow ridge with the menu's brows.

    The front of the face around the brows is sampled as a depth map; each
    key moves that relief across the face, front/back only:
    browRidgeUp 1 cm up, browRidgeOut 1 cm outwards (away from the middle),
    browRidgeTilt 10 degrees outer end up, about the brow box's centre.
    The menu sets them from the brow height, spacing and angle sliders.
    """
    from scipy.interpolate import RegularGridInterpolator
    x0, z0, x1, z1 = body["brow_box"]
    mx0, mx1, mz0, mz1 = x0 - 1.0, x1 + 1.5, z0 - 0.4, z1 + 2.0
    step = 0.1
    gx = np.arange(-(mx1 + 3), mx1 + 3 + step, step)
    gz = np.arange(mz0 - 3, mz1 + 3 + step, step)
    X, Z = np.meshgrid(gx, gz, indexing="ij")
    mesh = trimesh.Trimesh(verts, faces, process=False)
    origins = np.c_[X.ravel(), np.full(X.size, body["nose_tip"][0] - 20), Z.ravel()]
    loc, ray, _ = mesh.ray.intersects_location(origins, np.tile([0, 1.0, 0], (len(origins), 1)), multiple_hits=False)
    depth = np.full(len(origins), np.nan)
    depth[ray] = loc[:, 1]
    depth = depth.reshape(X.shape)
    depth = np.where(np.isnan(depth), np.nanmax(depth), depth)
    D = RegularGridInterpolator((gx, gz), depth, bounds_error=False, fill_value=None)
    x, y, z = verts.T
    ax, sx = np.abs(x), np.sign(x) + (x == 0)
    w = (smoothstep(mx0 - 1.5, mx0, ax) * smoothstep(mx1 + 1.5, mx1, ax)
         * smoothstep(mz0 - 0.8, mz0, z) * smoothstep(mz1 + 1.5, mz1, z) * (y < body["nose_tip"][0] + 8))
    sel = w > 0
    here = D(np.c_[x[sel], z[sel]])
    out = {}
    up = D(np.c_[x[sel], z[sel] - 1.0]) - here
    outw = D(np.c_[sx[sel] * np.maximum(ax[sel] - 1.0, 0), z[sel]]) - here
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    a = np.radians(10)
    px, pz = ax[sel] - cx, z[sel] - cz
    rx, rz = np.cos(a) * px + np.sin(a) * pz, -np.sin(a) * px + np.cos(a) * pz
    tilt = D(np.c_[sx[sel] * (rx + cx), rz + cz]) - here
    for name, dy in zip(BROW_MORPHS, (up, outw, tilt)):
        d = np.zeros_like(verts)
        d[sel, 1] = np.clip(dy, -1.5, 1.5) * w[sel]
        out[name] = d
    print(f"brow ridge keys on {sel.sum()} vertices")
    return out


def flatten_brows(verts, avg, body):
    """Relax the brow ridge (body["brow_box"], mirrored for the right brow)
    on the front of the face, fading out over 2.5 cm around it, so the ridge
    and the step at its top edge are gone (the menu draws the brows)."""
    x0, z0, x1, z1 = body["brow_box"]
    z1 += 1.5
    x, y, z = verts.T
    ax = np.abs(x)
    w = (smoothstep(x0 - 2.5, x0, ax) * smoothstep(x1 + 2.5, x1, ax) * smoothstep(z0 - 2.0, z0, z)
         * smoothstep(z1 + 2.5, z1, z) * (y < body["nose_tip"][0] + 8))
    # Only forward/back: sliding the points sideways folded triangles at the
    # box's edge (a dark line between the eye and the nose).
    out = verts.copy()
    for _ in range(80):
        out[:, 1] += 0.5 * w * (avg @ out - out)[:, 1]
    return out, w > 0


def tuck(cv, cf, ov, of, depth):
    """Cut a garment where it is tucked into another (ov, of): faces lower
    than `depth` cm under the outer garment's top edge at the same angle
    round the body are removed."""
    def angle(p):
        return np.arctan2(p[:, 1] - ov[:, 1].mean(), p[:, 0])
    bins = np.linspace(-np.pi, np.pi, 73)
    top_edge = ov[:, 2] > ov[:, 2].max() - 4
    ob = np.digitize(angle(ov[top_edge]), bins)
    tops = np.full(len(bins) + 1, -np.inf)
    np.maximum.at(tops, ob, ov[top_edge, 2])
    for _ in range(3):                            # fill empty bins from neighbours
        tops = np.where(np.isfinite(tops), tops, np.maximum(np.roll(tops, 1), np.roll(tops, -1)))
    centre = cv[cf].mean(1)
    keep = centre[:, 2] > tops[np.digitize(angle(centre), bins)] - depth
    used, nf = np.unique(cf[keep], return_inverse=True)
    cv = cv[used].copy()
    # What is left inside sits a little closer to the body than the outer
    # garment, so the two do not show through each other.
    under = smoothstep(1.0, 0.0, cv[:, 2] - tops[np.digitize(angle(cv), bins)])
    my = ov[:, 1].mean()
    radial = np.c_[cv[:, 0], cv[:, 1] - my]
    r = np.linalg.norm(radial, axis=1) + 1e-9
    # ...and always inside the outer garment's inner surface nearby.
    _, k = cKDTree(ov).query(cv, k=12)
    r_out = np.linalg.norm(np.stack([ov[k, 0], ov[k, 1] - my], -1), axis=-1).min(1)
    r_new = np.minimum(r - 0.35, r_out - 0.4)
    r_new = r + (r_new - r) * under
    cv[:, :2] = np.c_[0 * r, my + 0 * r] + radial * (r_new / r)[:, None]
    return cv, nf.reshape(-1, 3)


def snug_edges(v, cloth, verts, normals, tree, margin):
    """Pull a garment's edges (cloth["snug"]: "top" and/or "bottom") in to
    the body, keeping the fabric's thickness.

    In slices 0.5 cm high and 15 degrees round, the inside of the garment
    (its smallest gap to the body) is brought to `margin` cm by moving the
    whole slice towards the body's middle; the pull fades out over `fade`
    cm from the edge.
    """
    band, fade = cloth.get("snug_band", 3.0), cloth.get("snug_fade", 4.0)
    z = v[:, 2]
    w = np.zeros(len(v))
    if "top" in cloth.get("snug", []):
        w = np.maximum(w, smoothstep(band + fade, band, z.max() - z))
    if "bottom" in cloth.get("snug", []):
        w = np.maximum(w, smoothstep(band + fade, band, z - z.min()))
    if not w.any():
        return v
    _, k = tree.query(v)
    gap = ((v - verts[k]) * normals[k]).sum(1)
    # The body's middle at each height (front to back).
    cy = np.zeros(len(v))
    for zz in np.unique(np.round(z)):
        s = np.abs(verts[:, 2] - zz) < 1.0
        s &= np.abs(verts[:, 0]) < 25
        cy[np.round(z) == zz] = (verts[s, 1].max() + verts[s, 1].min()) / 2 if s.any() else 0
    ang = np.arctan2(v[:, 1] - cy, v[:, 0])
    key = np.c_[np.floor(z / 0.5), np.floor(ang / np.radians(15))].astype(int)
    _, bin_id = np.unique(key, axis=0, return_inverse=True)
    bin_id = bin_id.ravel()
    inner = np.full(bin_id.max() + 1, np.inf)
    np.minimum.at(inner, bin_id, gap)
    move = np.clip(inner[bin_id] - margin, 0, None) * w
    out = v.copy()
    radial = np.c_[v[:, 0], v[:, 1] - cy]
    r = np.linalg.norm(radial, axis=1, keepdims=True) + 1e-9
    out[:, :2] -= radial / r * move[:, None]
    return out


def inflate(v, cloth, verts, normals, tree, margin):
    """Widen a garment that is smaller than the body round it, keeping its
    folds and thickness.

    At each height the garment is scaled across and front to back about the
    body's middle (each leg's middle below cloth["crotch"]) just enough that
    nearly all of it clears the skin by `margin`; the scales are smoothed
    over height, so the fabric stretches evenly and the folds keep their
    shape. The final push in fit_cloth does what is left.
    """
    # First the whole garment, across and front to back, to the body's
    # proportions (median over heights; arms left out).
    z = v[:, 2]
    zi = np.round(z).astype(int)
    rx, ry = [], []
    for zz in np.unique(zi)[2:-2]:
        m = zi == zz
        half = np.abs(v[m, 0]).max()
        s = (np.abs(verts[:, 2] - zz) < 0.5) & (np.abs(verts[:, 0]) < half)
        if m.sum() > 20 and s.sum() > 20:
            rx.append((np.ptp(verts[s, 0]) + 2 * margin + 2) / np.ptp(v[m, 0]))
            ry.append((np.ptp(verts[s, 1]) + 2 * margin + 2) / np.ptp(v[m, 1]))
    gx, gy = np.clip(np.median(rx), 0.85, 1.4), np.clip(np.median(ry), 0.85, 1.4)
    my = (v[:, 1].max() + v[:, 1].min()) / 2
    v = np.c_[v[:, 0] * gx, my + (v[:, 1] - my) * gy, z]
    print(f"  {cloth['id']} scaled x{gx:.2f} across, x{gy:.2f} front to back")
    crotch = cloth.get("crotch", -np.inf)
    side = np.where(z < crotch, np.sign(v[:, 0]), 0)
    cx, cy = np.zeros(len(v)), np.zeros(len(v))
    for zz in np.unique(zi):
        s = (np.abs(verts[:, 2] - zz) < 1.0) & (np.abs(verts[:, 0]) < 25)
        for sd in (-1, 0, 1):
            m = (zi == zz) & (side == sd)
            ss = s & (np.sign(verts[:, 0]) == sd) if sd else s
            if m.any() and ss.any():
                cx[m] = (verts[ss, 0].max() + verts[ss, 0].min()) / 2 if sd else 0
                cy[m] = (verts[ss, 1].max() + verts[ss, 1].min()) / 2
    d = np.c_[v[:, 0] - cx, v[:, 1] - cy]
    # Then each height, where it is still narrower than the body.
    z0 = zi.min()
    n = zi.max() - z0 + 1
    scale = np.ones((2, n))
    shift = np.zeros(n)                     # front to back, onto the body's middle
    for t in range(n):
        m = zi - z0 == t
        if m.sum() < 20:
            continue
        half = np.abs(v[m, 0]).max()
        s = (np.abs(verts[:, 2] - (t + z0)) < 0.5) & (np.abs(verts[:, 0]) < half)
        if s.sum() > 20:
            shift[t] = (verts[s, 1].max() + verts[s, 1].min() - v[m, 1].max() - v[m, 1].min()) / 2
            scale[0, t] = max(1, (np.ptp(verts[s, 0]) + 2 * margin + 1) / np.ptp(v[m, 0]))
            scale[1, t] = max(1, (np.ptp(verts[s, 1]) + 2 * margin + 1) / np.ptp(v[m, 1]))
    for j in range(2):
        sc = np.minimum(scale[j], 1.3)
        for _ in range(2):                                   # hold the peaks a little
            sc = np.maximum.reduce([sc, np.r_[sc[1:], sc[-1]], np.r_[sc[0], sc[:-1]]])
        for _ in range(8):
            sc = (2 * sc + np.r_[sc[1:], sc[-1]] + np.r_[sc[0], sc[:-1]]) / 4
        scale[j] = sc
    for _ in range(8):
        shift = (2 * shift + np.r_[shift[1:], shift[-1]] + np.r_[shift[0], shift[:-1]]) / 4
    out = v.copy()
    out[:, 0] = cx + d[:, 0] * scale[0, zi - z0]
    out[:, 1] = cy + d[:, 1] * scale[1, zi - z0] + shift[zi - z0]
    print(f"  {cloth['id']} widened up to x{scale[0].max():.2f} across, x{scale[1].max():.2f} front to back")
    return out


def fit_cloth(cloth, verts, faces, normals, margin=0.5):
    """A garment (glTF axes, any scale) placed on the body in mesh cm.

    Scaled so it spans cloth["top"] to cloth["bottom"], centred on the body
    across, its middle front to back set to the body's middle at that
    height, then every point inside the body or closer than `margin` cm is
    pushed out along the body's normal. A rough fit: the menu's sliders
    adjust it.
    """
    gl, bin_ = read_glb(ROOT / cloth["src"])
    p = read_accessor(gl, bin_, gl["meshes"][0]["primitives"][0]["attributes"]["POSITION"]).astype(float)
    v = np.c_[p[:, 0], -p[:, 2], p[:, 1]]                       # Y up, front +Z -> Z up, front -Y
    v, inv = np.unique(np.round(v, 6), axis=0, return_inverse=True)
    f = inv.ravel().reshape(-1, 3)
    s = (cloth["top"] - cloth["bottom"]) / np.ptp(v[:, 2])
    v = v * s
    v[:, 2] += cloth["bottom"] - v[:, 2].min()
    v[:, 0] -= (v[:, 0].max() + v[:, 0].min()) / 2
    band = (verts[:, 2] > cloth["bottom"]) & (verts[:, 2] < cloth["top"]) & (np.abs(verts[:, 0]) < 20)
    v[:, 1] += (verts[band, 1].max() + verts[band, 1].min()) / 2 - (v[:, 1].max() + v[:, 1].min()) / 2
    tree = cKDTree(verts)
    if cloth.get("inflate"):
        v = inflate(v, cloth, verts, normals, tree, margin)
    v = snug_edges(v, cloth, verts, normals, tree, margin)
    for _ in range(3):
        _, k = tree.query(v)
        gap = ((v - verts[k]) * normals[k]).sum(1)
        push = np.clip(margin - gap, 0, None)
        v += normals[k] * push[:, None]
    return v, f


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
    # The cut follows mesh edges, so it zigzags; straighten both lips' edges
    # onto the measured lip line (with one ring around them following
    # halfway) so the open mouth has a clean edge.
    line = np.unique(np.r_[upper_lip, lower_lip])
    shift = np.zeros(len(verts))
    shift[line] = face.lip_z(verts[line, 0]) - verts[line, 2]
    ring = np.zeros(len(verts), bool)
    ring[faces[np.isin(faces, line).any(1)].ravel()] = True
    ring[line] = False
    adj = adjacency(len(verts), faces)
    shift[ring] = 0.5 * (adj @ shift)[ring] / np.maximum((adj @ np.isin(np.arange(len(verts)), line))[ring], 1e-6) * 0.5
    # Back off wherever the move would flip a triangle (fold the surface).
    near = np.flatnonzero(np.isin(faces, np.flatnonzero(shift != 0)).any(1))

    def face_n(vv):
        f = faces[near]
        return np.cross(vv[f[:, 1]] - vv[f[:, 0]], vv[f[:, 2]] - vv[f[:, 0]])

    before = face_n(verts)
    for _ in range(20):
        moved = verts.copy()
        moved[:, 2] += shift
        flipped = (face_n(moved) * before).sum(1) <= 0
        if not flipped.any():
            break
        shift[faces[near[flipped]].ravel()] *= 0.5
    verts[:, 2] += shift
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
                curl = np.array(body.get("thumb_curl", THUMB_CURL)[k]) if finger == "Thumb" else PALM_NORMAL
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
        lo, hi = body["hip_back_y"]
        back = smoothstep(lo - 3, hi, verts[:, 1])   # 0 at the front, 1 behind the hip joint
        # The whole buttock follows the pelvis down to below the gluteal fold,
        # handing over to the thigh gradually (a sharp hand-over folded it to
        # a point when sitting).
        # At most 60 % to the pelvis: the rest stays with the thigh, so a deep
        # bend (sitting, crouching) stretches the buttock round instead of
        # folding it to a point between the two bones.
        h = 0.6 * back * (1 - smoothstep(0, 26, t))
        moved = dense[:, up] * h
        dense[:, up] -= moved
        dense[:, hips] += moved
    z0, z1 = body["pelvis_z"]
    pelvis = (verts[:, 2] > z0 - 12) & (verts[:, 2] < z1) & (np.abs(verts[:, 0]) < 26)
    dense = smooth_rows(dense, avg, pelvis, iterations=90)

    # ---- shoulders, upper back and neck: the source hands off between Spine2,
    # the shoulders, the upper arms and the neck along hard lines, which crease
    # and wrinkle when the arms go up. Stop below the jaw and above the elbows.
    z0, z1 = body["shoulders_z"]
    shoulders = (verts[:, 2] > z0) & (verts[:, 2] < z1) & (np.abs(verts[:, 0]) < 30)
    dense = smooth_rows(dense, avg, shoulders, iterations=25)

    # ---- breasts: one rigid piece on the chest bone. Spread over Hips, Spine,
    # Spine1 and Spine2 they were sheared into a point whenever the spine bent.
    if "breasts" in body:
        b = body["breasts"]
        x_, y_, z_ = verts.T
        reach = b["down"] + (b["up"] - b["down"]) * smoothstep(-3.0, 3.0, z_ - b["z"])
        u_ = np.hypot((np.sqrt(x_ ** 2 + 1.0) - b["x"]) / b["rx"], (z_ - b["z"]) / reach)
        w_ = 0.7 * smoothstep(1.8, 0.9, u_) * (y_ < body["nose_tip"][0] + 10)
        chest = np.zeros(dense.shape[1])
        chest[bone["Spine2"]] = 1
        dense = dense * (1 - w_[:, None]) + np.outer(w_, chest)
        # Smooth the hand-over to the ribs and sides, so they do not crumple.
        around = (u_ < 2.6) & (u_ > 0.9) & (np.abs(x_) < b["x"] + 2.6 * b["rx"])
        dense = smooth_rows(dense, avg, around, iterations=30)

    # ---- smooth the body; recompute normals where it moved
    bind = {nm: np.linalg.inv(ibm[i])[:3, 3] for nm, i in bone.items() if i < len(ibm)}
    verts, moved = clean_body(verts, faces, avg, body, bind.__getitem__)
    print(f"body: smoothed {moved.sum()} vertices")
    near = moved | (avg @ moved.astype(float) > 0)
    normals[near] = vertex_normals(verts, faces)[near]

    # ---- breasts: a set shape where the body defines one
    if body.get("breasts", {}).get("shape"):
        verts, shaped = shape_breasts(verts, faces, avg, body)
        print(f"breasts: shaped {shaped.sum()} vertices")
        near = shaped | (avg @ shaped.astype(float) > 0)
        normals[near] = vertex_normals(verts, faces)[near]

    # ---- brows: the sculpted brow ridges stay behind when the menu moves the
    # painted brows, so the brow area is relaxed flat (both sides, front only)
    # (flatten_brows is off: the sculpted brow ridge is kept as made.)

    # ---- mouth shape keys
    morphs, _ = face.mouth_morphs(verts, faces, upper_lip, lower_lip)
    morphs.update(face.face_shapes(verts))
    morphs.update(brow_ridge_morphs(verts, faces, body))
    MORPH_NAMES = face.MORPHS + list(face.FACE_SHAPES) + list(BROW_MORPHS)
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
        _, nearest = cKDTree(verts).query(pv)
        zero = np.zeros_like(pv, dtype=np.float32)
        # Bone weights: the face skin's around the mouth (the lips also follow
        # the neck a little; bound to Head alone the teeth slid out of them).
        _, near4 = cKDTree(verts[(np.abs(verts[:, 0]) < 5) & (np.abs(verts[:, 2] - body["mouth"]["z"]) < 3)]).query(pv, k=6)
        mouth_ids = np.flatnonzero((np.abs(verts[:, 0]) < 5) & (np.abs(verts[:, 2] - body["mouth"]["z"]) < 3))
        dense_t = np.zeros((len(pv), len(names)))
        for k in range(6):
            ids = mouth_ids[near4[:, k]]
            np.add.at(dense_t, (np.repeat(np.arange(len(pv)), 4), order[ids].ravel()), top[ids].ravel() / 6)
        joints = np.argsort(-dense_t, axis=1)[:, :4].astype(np.uint16)
        weights = np.take_along_axis(dense_t, joints.astype(np.int64), axis=1).astype(np.float32)
        weights /= weights.sum(1, keepdims=True)
        g["materials"].append({"name": name, "doubleSided": True, "pbrMetallicRoughness": {
            "baseColorFactor": color, "metallicFactor": 0, "roughnessFactor": roughness}})
        targets = []
        for k in MORPH_NAMES:
            d, dn = (jaw, jaw_n) if k == "jawOpen" else (zero, zero)
            if k == "jawForward":                  # teeth and tongue go with the lower face
                d = (morphs[k][nearest] * jw[:, None]).astype(np.float32)
            elif k in ("lipsWidth", "lipsFull"):   # and stay inside the lips as they change
                d = morphs[k][nearest].astype(np.float32)
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
    # ---- clothes: separate primitives skinned like the body under them
    fitted = {c["id"]: fit_cloth(c, verts, faces, normals) for c in body.get("clothes", [])}
    for cloth in body.get("clothes", []):
        cv, cf = fitted[cloth["id"]]
        if "tuck_into" in cloth:                   # hidden under another garment: cut away
            cv, cf = tuck(cv, cf, *fitted[cloth["tuck_into"]], cloth.get("tuck_depth", 1.0))
        _, near = cKDTree(verts).query(cv, k=4)
        # Weights: the four nearest body points' weights, averaged.
        dense_w = np.zeros((len(cv), len(names)))
        for k in range(4):
            np.add.at(dense_w, (np.repeat(np.arange(len(cv)), 4), order[near[:, k]].ravel()), top[near[:, k]].ravel() / 4)
        c_order = np.argsort(-dense_w, axis=1)[:, :4]
        c_top = np.take_along_axis(dense_w, c_order, axis=1)
        c_top /= c_top.sum(1, keepdims=True)
        cn = vertex_normals(cv, cf)
        g["materials"].append({"name": f"Cloth_{cloth['id']}", "doubleSided": True, "pbrMetallicRoughness": {
            "baseColorFactor": cloth["color"] + [1], "metallicFactor": 0, "roughnessFactor": 0.85}})
        zero = np.zeros_like(cv, dtype=np.float32)
        g["meshes"][0]["primitives"].append({
            "attributes": {"POSITION": out.append(cv.astype(np.float32), 34962),
                           "NORMAL": out.append(cn.astype(np.float32), 34962),
                           "JOINTS_0": out.append(c_order.astype(np.uint16), 34962),
                           "WEIGHTS_0": out.append(c_top.astype(np.float32), 34962)},
            "indices": out.append(cf.astype(np.uint32).reshape(-1, 1), 34963),
            "material": len(g["materials"]) - 1,
            "targets": [{"POSITION": out.append_sparse(zero), "NORMAL": out.append_sparse(zero)} for _ in MORPH_NAMES],
        })
        print(f"cloth {cloth['id']}: {len(cv)} vertices")
    g["meshes"][0]["weights"] = [0] * len(MORPH_NAMES)
    g["meshes"][0]["extras"] = {"targetNames": MORPH_NAMES}
    g["meshes"][0]["name"] = g["nodes"][1]["name"] = "Body"
    g["materials"][0]["name"] = "Skin"
    g["nodes"][0]["scale"] = [0.01, 0.01, 0.01]  # centimetres -> metres
    # Landmarks the menu reads (gltf.scene.userData.body), in mesh centimetres.
    extras = {k: body[k] for k in ("label", "eye", "top_z", "chin_z", "nose_tip", "brow_z")}
    extras["head_map"] = head_map(verts, body)
    extras["mouth_z"] = body["mouth"]["z"]
    if "thumb_fist" in body:
        extras["thumb_fist"] = body["thumb_fist"]
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
