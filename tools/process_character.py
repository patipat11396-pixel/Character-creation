"""Add finger bones to the retargeted character and fix its hip weights.

The source (`models/source/retargeted_animations.glb`, a three.js export in
centimetres, Z up, front = -Y) has a Mixamo-style skeleton with one bone per
hand, so the hands cannot close. Its buttocks are weighted almost entirely to
the thigh bones, so they fold into spikes whenever a leg lifts.

This script:

* welds the triangle soup into an indexed mesh (shape and normals unchanged),
* adds 15 finger bones per hand (Thumb, Index, Middle, Ring, Pinky, 3 each),
  placed on the measured finger centrelines, and splits each hand's weight
  between the palm and those bones by distance to each bone,
* moves the buttocks' weight from the thigh bones to Hips down to the gluteal
  fold, then smooths the weights around the pelvis,
* scales the scene to metres and drops the "_RT" suffix from clip names.

Finger bones point along the finger (+Y) and curl towards the palm when
rotated about their local +X axis, which is what the menu's fist control does.

    python3 tools/process_character.py [--in models/source/retargeted_animations.glb]
                                       [--out models/character.glb]
"""
import argparse
from pathlib import Path

import numpy as np
from scipy.sparse import coo_matrix, diags

from glb import GlbWriter, read_accessor, read_glb

ROOT = Path(__file__).resolve().parent.parent
FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"]
# Lateral (Y) centre of each finger, measured from the mesh's fingertip outline.
FINGER_Y = {"Index": 18.4, "Middle": 20.1, "Ring": 21.7, "Pinky": 23.2}
PALM_NORMAL = np.array([0.0, 0.0, -1.0])          # palms face down in the T-pose
# Thumb curl direction per bone, found by searching for the axes and angles that
# put the thumb tip on the curled index and middle fingers without bending the
# thumb's base, which tears the palm.
THUMB_CURL = [np.array([0.0, 0.9, -0.45]), np.array([0.0, 0.37, -0.93]), np.array([0.0, 0.37, -0.93])]


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


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


def hand_landmarks(verts, side):
    """Joint chains in mesh space for one hand. side=+1 left, -1 right."""
    h = verts * [side, 1, 1]
    hand = h[:, 0] > 50
    chains = {}
    for name, yc in FINGER_Y.items():
        band = hand & (np.abs(h[:, 1] - yc) < 0.5)
        tip_x = h[band, 0].max()
        knuckle_x = 63.5 if name != "Pinky" else 63.0
        length = tip_x - knuckle_x
        xs = [knuckle_x, knuckle_x + 0.46 * length, knuckle_x + 0.75 * length]
        pts = [slice_centre(h, x, yc, mask=hand) for x in xs]
        for p, x in zip(pts, xs):
            p[0], p[1] = x, yc
        tip = np.array([tip_x - 0.4, yc, pts[-1][2]])
        chains[name] = pts + [tip]
    thumb = hand & (h[:, 1] < 17.4) & (h[:, 0] > 57)
    tip = h[thumb][h[thumb, 0].argmax()].copy()
    tip[0] -= 0.4
    mcp = slice_centre(h, 59.5, mask=thumb)
    ip = slice_centre(h, 63.8, mask=thumb)
    cmc = np.array([54.5, 18.8, 118.6])
    chains["Thumb"] = [cmc, mcp, ip, tip]
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


def smooth_rows(weights, avg, mask, iterations, alpha=0.5):
    for _ in range(iterations):
        blurred = avg @ weights
        weights[mask] = (1 - alpha) * weights[mask] + alpha * blurred[mask]
    return weights


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", default=ROOT / "models/source/retargeted_animations.glb")
    ap.add_argument("--out", default=ROOT / "models/character.glb")
    args = ap.parse_args()

    gltf, binary = read_glb(args.src)
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
    n = len(verts)
    print(f"source: {len(pos)} corners -> {n} vertices, {len(faces)} triangles")

    # ---- finger bones
    new_ibm = list(ibm)
    hand_bones = {}  # side -> list of (joint index, segment start, segment end)
    for side, prefix in ((1, "Left"), (-1, "Right")):
        hand = bone[f"{prefix}Hand"]
        chains = hand_landmarks(verts, side)
        knuckles = np.mean([chains[f][0] for f in FINGER_Y], axis=0)
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
        hand_bones[side] = (hand, bone[f"{prefix}Hand_end"], segments)

    dense = np.zeros((n, len(names)))
    np.add.at(dense, (np.repeat(np.arange(n), 4), jnt[first].ravel()), wgt[first].ravel())
    avg = adjacency(n, faces)

    # Split each hand's weight between the palm and the finger bones.
    for side, (hand, hand_end, segments) in hand_bones.items():
        share = dense[:, hand] + dense[:, hand_end]
        idx = np.flatnonzero(share > 0)
        p = verts[idx]
        score = np.stack([1 / (segment_distance(p, a, b) + 0.4) ** 5 for _, a, b in segments], 1)
        score /= score.sum(1, keepdims=True)
        dense[idx, hand] = 0
        dense[idx, hand_end] = 0
        for col, (j, _, _) in enumerate(segments):
            dense[idx, j] += share[idx] * score[:, col]
        mask = np.zeros(n, bool)
        mask[idx] = True
        mask &= (verts[:, 0] * side) > 54          # leave the wrist blend as authored
        dense = smooth_rows(dense, avg, mask, iterations=6)

    # ---- buttocks: follow Hips down to the gluteal fold
    hips = bone["Hips"]
    for prefix in ("Left", "Right"):
        up, knee = bone[f"{prefix}UpLeg"], bone[f"{prefix}Leg"]
        a = np.linalg.inv(ibm[up])[:3, 3]
        b = np.linalg.inv(ibm[knee])[:3, 3]
        down = (b - a) / np.linalg.norm(b - a)
        t = (verts - a) @ down                       # cm down the thigh
        back = smoothstep(9, 15, verts[:, 1])        # 0 at the front, 1 behind the hip joint
        h = back * (1 - smoothstep(6, 18, t))
        moved = dense[:, up] * h
        dense[:, up] -= moved
        dense[:, hips] += moved
    pelvis = (verts[:, 2] > 70) & (verts[:, 2] < 106) & (np.abs(verts[:, 0]) < 26)
    dense = smooth_rows(dense, avg, pelvis, iterations=12)

    # ---- keep the 4 strongest influences
    order = np.argsort(-dense, axis=1)[:, :4]
    top = np.take_along_axis(dense, order, axis=1)
    top[top < 0.01] = 0
    top /= top.sum(1, keepdims=True)

    out = GlbWriter(gltf, binary)
    g = out.gltf
    out.replace(attr["POSITION"], verts.astype(np.float32), 34962)
    out.replace(attr["NORMAL"], normals.astype(np.float32), 34962)
    out.replace(attr["JOINTS_0"], order.astype(np.uint16), 34962)
    out.replace(attr["WEIGHTS_0"], top.astype(np.float32), 34962)
    out.replace(skin["inverseBindMatrices"],
                np.array([m.T.ravel() for m in new_ibm], np.float32))
    g["meshes"][0]["primitives"][0]["indices"] = out.append(faces.astype(np.uint32).reshape(-1, 1), 34963)
    g["meshes"][0]["name"] = g["nodes"][1]["name"] = "Body"
    g["materials"][0]["name"] = "Skin"
    g["nodes"][0]["scale"] = [0.01, 0.01, 0.01]  # centimetres -> metres
    for anim in g["animations"]:
        anim["name"] = anim["name"].removesuffix("_RT")
    g["asset"]["generator"] = "Character-creation tools/process_character.py"
    out.write(args.out)
    print(f"bones: {len(names)} ({len(names) - len(ibm)} finger bones added)")
    print(f"wrote {args.out} ({Path(args.out).stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
