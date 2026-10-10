"""Build one rigged GLB per hairstyle for the menu.

    python3 tools/build_hair.py            # every style in tools/hairstyles.json
    python3 tools/build_hair.py braid bob  # just these

Reads the head from models/character.glb (run process_character.py first) and
each source mesh from models/source/hair/<id>.glb, and writes
models/hair/<id>.glb plus models/hair/index.json for the menu.

Each output file is in the character's world space (metres, Y up, front +Z)
in its bind pose: a HairRoot bone at the centre of the head, one bone chain
per swinging part (Chain1_1 … Chain1_N, Chain1_End, then Chain2_…), and the
hair mesh skinned to them. The menu re-parents HairRoot under the character's
Head bone, so the hair follows the head and the chains are simulated.
"""
import json
import struct
import sys
from pathlib import Path

import numpy as np

import hair
from glb import read_accessor, read_glb

ROOT = Path(__file__).resolve().parent.parent
STYLES = ROOT / "tools/hairstyles.json"
HEAD_CENTRE = np.array([0.0, 14.4, 149.6])   # cm, character mesh space (head at 85%)
# Character mesh space (cm, x side, y back, z up) -> glTF world (m, y up, front +z).
R = np.array([[1.0, 0, 0], [0, 0, 1.0], [0, -1.0, 0]])


def to_world(points):
    return points @ R.T * 0.01


def frame(origin, toward):
    """Bone frame in mesh space: +Y along the bone, +X sideways (the swing axis)."""
    y = toward - origin
    y /= np.linalg.norm(y)
    x = np.cross(y, [0.0, -1.0, 0.0])           # perpendicular to the bone, roughly sideways
    if np.linalg.norm(x) < 1e-3:
        x = np.cross(y, [1.0, 0.0, 0.0])
    x /= np.linalg.norm(x)
    z = np.cross(x, y)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2], m[:3, 3] = x, y, z, origin
    return m


def world_matrix(f):
    w = np.eye(4)
    w[:3, :3] = R @ f[:3, :3]
    w[:3, 3] = 0.01 * (R @ f[:3, 3])
    return w


def normals(v, f):
    fn = np.cross(v[f[:, 1]] - v[f[:, 0]], v[f[:, 2]] - v[f[:, 0]])
    n = np.zeros_like(v)
    for k in range(3):
        np.add.at(n, f[:, k], fn)
    return n / np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)


def write_glb(path, verts, faces, bone_worlds, bone_names, parents, joints, weights, name):
    nodes, mesh_node = [], {"name": name, "mesh": 0, "skin": 0}
    for i, (w, n, p) in enumerate(zip(bone_worlds, bone_names, parents)):
        local = w if p < 0 else np.linalg.inv(bone_worlds[p]) @ w
        nodes.append({"name": n, "matrix": local.T.ravel().tolist()})
    for i, p in enumerate(parents):
        if p >= 0:
            nodes[p].setdefault("children", []).append(i)
    nodes.append(mesh_node)
    roots = [i for i, p in enumerate(parents) if p < 0] + [len(nodes) - 1]

    blob = bytearray()
    views, accessors = [], []

    def add(arr, ctype, type_, target=None, minmax=False):
        arr = np.ascontiguousarray(arr)
        blob.extend(b"\0" * (-len(blob) % 4))
        view = {"buffer": 0, "byteOffset": len(blob), "byteLength": arr.nbytes}
        if target:
            view["target"] = target
        blob.extend(arr.tobytes())
        views.append(view)
        acc = {"bufferView": len(views) - 1, "componentType": ctype, "count": len(arr), "type": type_}
        if minmax:
            acc["min"], acc["max"] = arr.min(0).tolist(), arr.max(0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    v = verts.astype(np.float32)
    prim = {
        "attributes": {
            "POSITION": add(v, 5126, "VEC3", 34962, True),
            "NORMAL": add(normals(verts, faces).astype(np.float32), 5126, "VEC3", 34962),
            "JOINTS_0": add(joints.astype(np.uint16), 5123, "VEC4", 34962),
            "WEIGHTS_0": add(weights.astype(np.float32), 5126, "VEC4", 34962),
        },
        "indices": add(faces.astype(np.uint32).reshape(-1), 5125, "SCALAR", 34963),
        "material": 0,
    }
    ibm = add(np.array([np.linalg.inv(w).T.ravel() for w in bone_worlds], np.float32), 5126, "MAT4")
    blob.extend(b"\0" * (-len(blob) % 4))
    gltf = {
        "asset": {"version": "2.0", "generator": "Character-creation tools/build_hair.py"},
        "scene": 0, "scenes": [{"nodes": roots}], "nodes": nodes,
        "meshes": [{"name": name, "primitives": [prim]}],
        "materials": [{"name": "Hair", "pbrMetallicRoughness": {
            "baseColorFactor": [0.29, 0.18, 0.11, 1], "metallicFactor": 0, "roughnessFactor": 0.5}}],
        "skins": [{"joints": list(range(len(bone_worlds))), "inverseBindMatrices": ibm}],
        "accessors": accessors, "bufferViews": views, "buffers": [{"byteLength": len(blob)}],
    }
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(blob)))
        f.write(struct.pack("<I4s", len(js), b"JSON") + js)
        f.write(struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob))


def build(style, head_verts, head_faces):
    src, faces = hair.load(ROOT / "models/source/hair" / f"{style['id']}.glb")
    centre = np.array(style["centre"]) if style.get("centre") else None
    fitted = hair.fit(src, faces, head_verts, head_faces, HEAD_CENTRE, centre)
    chains = style.get("chains", [])
    chain_joints, w = hair.rig(src, fitted, faces, chains)

    names, worlds, parents = ["HairRoot"], [], [-1]
    root = np.eye(4)
    root[:3, 3] = HEAD_CENTRE
    worlds.append(world_matrix(root))
    for c, joints in enumerate(chain_joints, start=1):
        parent = 0
        for k in range(len(joints) - 1):
            names.append(f"Chain{c}_{k + 1}")
            worlds.append(world_matrix(frame(joints[k], joints[k + 1])))
            parents.append(parent)
            parent = len(names) - 1
        end = np.eye(4)
        end[:3, :3] = frame(joints[-2], joints[-1])[:3, :3]
        end[:3, 3] = joints[-1]
        names.append(f"Chain{c}_End")
        worlds.append(world_matrix(end))
        parents.append(parent)

    # Weight columns are [HairRoot, chain 1 bones, chain 2 bones, ...]; map them to joints.
    cols = [0]
    for c, joints in enumerate(chain_joints, start=1):
        cols += [names.index(f"Chain{c}_{k + 1}") for k in range(len(joints) - 1)]
    if w.shape[1] < 4:                        # glTF skins take four influences
        w = np.pad(w, ((0, 0), (0, 4 - w.shape[1])))
        cols += [0] * (4 - len(cols))
    order = np.argsort(-w, axis=1)[:, :4]
    top = np.take_along_axis(w, order, axis=1)
    top[top < 0.01] = 0
    top /= top.sum(1, keepdims=True)
    joints = np.array(cols)[order]

    out = ROOT / "models/hair" / f"{style['id']}.glb"
    write_glb(out, to_world(fitted), faces, worlds, names, parents, joints, top, style["name"])
    lengths = [np.linalg.norm(np.diff(j, axis=0), axis=1).sum() for j in chain_joints]
    print(f"{style['id']}: {len(fitted)} vertices, chains "
          f"{[f'{n:.0f} cm' for n in lengths] or 'none'} -> {out.name} ({out.stat().st_size / 1e6:.1f} MB)")


def main():
    styles = json.loads(STYLES.read_text())
    wanted = set(sys.argv[1:])
    gltf, binary = read_glb(ROOT / "models/character.glb")
    prim = gltf["meshes"][0]["primitives"][0]
    verts = read_accessor(gltf, binary, prim["attributes"]["POSITION"]).astype(float)
    faces = read_accessor(gltf, binary, prim["indices"]).reshape(-1, 3)
    head_faces = faces[(verts[faces][:, :, 2] > 133).all(1)]
    (ROOT / "models/hair").mkdir(exist_ok=True)
    for style in styles:
        if style.get("mesh") is False:
            continue                      # no mesh (bald)
        if not wanted or style["id"] in wanted:
            build(style, verts, head_faces)
    index = [{"id": s["id"], "name": s["name"],
              "file": None if s.get("mesh") is False else f"models/hair/{s['id']}.glb"} for s in styles]
    (ROOT / "models/hair/index.json").write_text(json.dumps(index, indent=2) + "\n")


if __name__ == "__main__":
    main()
