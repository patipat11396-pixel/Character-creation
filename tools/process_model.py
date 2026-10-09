"""Smooth the base character and give it blended skin weights.

The source GLB (exported from three.js) has two problems:

* Every triangle has its own three vertices, so the body renders flat-shaded
  and Loop subdivision cannot run on it.
* Every vertex is bound 100% to a single bone. Joints tear and crease as soon
  as an animation bends them, because nothing blends between bones.

This script welds the vertices, applies Loop subdivision, recomputes smooth
normals, and rebuilds the skin weights. Each vertex keeps the bone the source
rig assigned it to (after cleaning the ragged region borders), and weights fade
across every border over a per-bone distance measured along the surface. The
skeleton, inverse bind matrices and all animations are copied unchanged.

    python3 tools/process_model.py [--iterations 1] [--in models/base_character.glb]
                                   [--out models/character.glb]
"""
import argparse
import json
import struct
from pathlib import Path

import numpy as np
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

ROOT = Path(__file__).resolve().parent.parent
COMPONENT = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

# How far (metres, along the surface) a bone's weight fades into its
# neighbours. The model is about 1.17 m tall.
BLEND = [
    ("thumb", 0.008), ("middle", 0.008), ("hand", 0.014), ("ball", 0.014),
    ("foot", 0.022), ("lowerarm", 0.028), ("upperarm", 0.032),
    ("clavicle", 0.035), ("calf", 0.04), ("thigh", 0.05), ("head", 0.025),
    ("neck", 0.03), ("spine", 0.045),
]


def blend_radius(name):
    for key, radius in BLEND:
        if key in name:
            return radius
    return 0.03


def read_glb(path):
    data = Path(path).read_bytes()
    json_len = struct.unpack_from("<I", data, 12)[0]
    gltf = json.loads(data[20:20 + json_len])
    off = 20 + json_len
    bin_len = struct.unpack_from("<I", data, off)[0]
    return gltf, data[off + 8:off + 8 + bin_len]


def read_accessor(gltf, binary, index):
    acc = gltf["accessors"][index]
    view = gltf["bufferViews"][acc["bufferView"]]
    dtype = COMPONENT[acc["componentType"]]
    width = WIDTH[acc["type"]]
    assert view.get("byteStride", 0) in (0, np.dtype(dtype).itemsize * width)
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    arr = np.frombuffer(binary, dtype, acc["count"] * width, start)
    return arr.reshape(acc["count"], width).copy()


def weld(positions, joints, weights):
    """Merge duplicate corners; return vertices, faces and one bone per vertex."""
    verts, inverse = np.unique(np.round(positions, 6), axis=0, return_inverse=True)
    inverse = inverse.ravel()
    labels = np.empty(len(verts), np.int64)
    labels[inverse] = joints[np.arange(len(joints)), weights.argmax(1)]
    return verts, inverse.reshape(-1, 3), labels


def split_nonmanifold_edges(verts, faces):
    """Give each extra sheet on an edge used by more than two faces its own copy.

    The source has two such edges, at the tips of the toes. Faces are paired
    as one forward and one backward use of the edge with the closest normals;
    every pair after the first gets duplicate vertices.
    """
    faces = faces.copy()
    verts = list(verts)
    directed = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    owner = np.tile(np.arange(len(faces)), 3)
    keys, counts = np.unique(np.sort(directed, axis=1), axis=0, return_counts=True)
    for a, b in keys[counts > 2]:
        fwd = [owner[i] for i in np.flatnonzero((directed[:, 0] == a) & (directed[:, 1] == b))]
        bwd = [owner[i] for i in np.flatnonzero((directed[:, 0] == b) & (directed[:, 1] == a))]
        normal = lambda f: np.cross(verts[faces[f][1]] - verts[faces[f][0]], verts[faces[f][2]] - verts[faces[f][0]])
        pairs = []
        for f in fwd:
            g = max(bwd, key=lambda g: np.dot(normal(f), normal(g)) / np.linalg.norm(normal(f)) / np.linalg.norm(normal(g)))
            bwd.remove(g)
            pairs.append((f, g))
        for f, g in pairs[1:]:
            na, nb = len(verts), len(verts) + 1
            verts += [verts[a], verts[b]]
            for face in (f, g):
                faces[face][faces[face] == a] = na
                faces[face][faces[face] == b] = nb
    return np.array(verts), faces


def edge_graph(verts, faces):
    edges = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    edges = np.unique(np.sort(edges, axis=1), axis=0)
    length = np.linalg.norm(verts[edges[:, 0]] - verts[edges[:, 1]], axis=1)
    n = len(verts)
    graph = coo_matrix((length, (edges[:, 0], edges[:, 1])), shape=(n, n)).tocsr()
    return graph + graph.T, edges


def clean_labels(labels, edges, rounds=3):
    """Majority vote over each vertex and its neighbours to remove speckles."""
    n = len(labels)
    nbrs = [[i] for i in range(n)]
    for a, b in edges:
        nbrs[a].append(b)
        nbrs[b].append(a)
    for _ in range(rounds):
        new = labels.copy()
        for i, ring in enumerate(nbrs):
            vals, counts = np.unique(labels[ring], return_counts=True)
            best = vals[counts == counts.max()]
            new[i] = labels[i] if labels[i] in best else best[0]
        labels = new
    return labels


def smooth_weights(graph, labels, bone_names, max_influences=4):
    n = len(labels)
    raw = np.zeros((n, len(bone_names)))
    for bone in np.unique(labels):
        radius = blend_radius(bone_names[bone])
        inside = np.flatnonzero(labels == bone)
        outside = np.flatnonzero(labels != bone)
        d_in = dijkstra(graph, indices=inside, min_only=True, limit=radius * 1.01)
        d_out = dijkstra(graph, indices=outside, min_only=True, limit=radius * 1.01)
        signed = np.where(labels == bone, -np.minimum(d_out, radius), np.minimum(d_in, radius))
        t = np.clip(0.5 - signed / (2 * radius), 0, 1)
        raw[:, bone] = t * t * (3 - 2 * t)

    order = np.argsort(-raw, axis=1)[:, :max_influences]
    top = np.take_along_axis(raw, order, axis=1)
    top[top < 1e-3] = 0
    top /= top.sum(1, keepdims=True)
    return order.astype(np.uint16), top.astype(np.float32)


def vertex_normals(verts, faces):
    face_n = np.cross(verts[faces[:, 1]] - verts[faces[:, 0]], verts[faces[:, 2]] - verts[faces[:, 0]])
    normals = np.zeros_like(verts)
    for k in range(3):
        np.add.at(normals, faces[:, k], face_n)
    return normals / np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-12)


def write_glb(path, gltf, binary, mesh_accessors, arrays):
    """Replace the mesh accessors with `arrays`, keep every other buffer view."""
    old_views = gltf["bufferViews"]
    keep_views = sorted({a["bufferView"] for i, a in enumerate(gltf["accessors"]) if i not in mesh_accessors})
    blob = bytearray()
    views, view_map = [], {}

    def add_view(raw, target=None):
        while len(blob) % 4:
            blob.append(0)
        view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(raw)}
        if target:
            view["target"] = target
        blob.extend(raw)
        views.append(view)
        return len(views) - 1

    for v in keep_views:
        src = old_views[v]
        start = src.get("byteOffset", 0)
        view_map[v] = add_view(binary[start:start + src["byteLength"]], src.get("target"))

    accessors = []
    for i, acc in enumerate(gltf["accessors"]):
        if i in mesh_accessors:
            continue
        acc = dict(acc, bufferView=view_map[acc["bufferView"]])
        accessors.append(acc)
    remap = {old: new for new, old in enumerate(i for i in range(len(gltf["accessors"])) if i not in mesh_accessors)}

    def add_accessor(arr, type_, ctype, target):
        acc = {"bufferView": add_view(arr.tobytes(), target), "componentType": ctype,
               "count": len(arr), "type": type_}
        if type_ == "VEC3" and ctype == 5126:
            acc["min"] = arr.min(0).tolist()
            acc["max"] = arr.max(0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    out = json.loads(json.dumps(gltf))
    for skin in out.get("skins", []):
        skin["inverseBindMatrices"] = remap[skin["inverseBindMatrices"]]
    for anim in out.get("animations", []):
        for s in anim["samplers"]:
            s["input"] = remap[s["input"]]
            s["output"] = remap[s["output"]]

    prim = out["meshes"][0]["primitives"][0]
    prim["attributes"] = {
        "POSITION": add_accessor(arrays["position"], "VEC3", 5126, 34962),
        "NORMAL": add_accessor(arrays["normal"], "VEC3", 5126, 34962),
        "JOINTS_0": add_accessor(arrays["joints"], "VEC4", 5123, 34962),
        "WEIGHTS_0": add_accessor(arrays["weights"], "VEC4", 5126, 34962),
    }
    prim["indices"] = add_accessor(arrays["indices"].reshape(-1, 1), "SCALAR", 5125, 34963)
    out["meshes"][0]["name"] = "Body"
    out["materials"][0]["name"] = "Skin"
    out["nodes"][0]["name"] = "Body"
    out["accessors"], out["bufferViews"] = accessors, views
    while len(blob) % 4:
        blob.append(0)
    out["buffers"] = [{"byteLength": len(blob)}]
    out["asset"]["generator"] = "Character-creation tools/process_model.py"

    js = json.dumps(out, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON") + js)
        f.write(struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", default=ROOT / "models/base_character.glb")
    ap.add_argument("--out", default=ROOT / "models/character.glb")
    ap.add_argument("--iterations", type=int, default=1, help="Loop subdivision passes")
    args = ap.parse_args()

    gltf, binary = read_glb(args.src)
    assert len(gltf["meshes"]) == 1 and len(gltf["meshes"][0]["primitives"]) == 1
    prim = gltf["meshes"][0]["primitives"][0]
    attr = prim["attributes"]
    if "indices" in prim:
        raise SystemExit("expected the non-indexed three.js export")
    mesh_accessors = {attr[k] for k in attr}
    positions = read_accessor(gltf, binary, attr["POSITION"])
    joints = read_accessor(gltf, binary, attr["JOINTS_0"])
    weights = read_accessor(gltf, binary, attr["WEIGHTS_0"])
    bone_names = [gltf["nodes"][j]["name"] for j in gltf["skins"][0]["joints"]]

    verts, faces, labels = weld(positions, joints, weights)
    print(f"source: {len(positions)} corners -> {len(verts)} welded vertices, {len(faces)} triangles")
    n_welded = len(verts)
    verts, faces = split_nonmanifold_edges(verts, faces)
    labels = labels[cKDTree(verts[:n_welded]).query(verts)[1]]
    _, edges = edge_graph(verts, faces)
    labels = clean_labels(labels, edges)

    sub_v, sub_f = verts, faces
    if args.iterations:
        sub_v, sub_f = trimesh.remesh.subdivide_loop(verts, faces, iterations=args.iterations)
    # Each new vertex takes the bone of the nearest source vertex.
    sub_labels = labels[cKDTree(verts).query(sub_v)[1]]
    graph, sub_edges = edge_graph(sub_v, sub_f)
    sub_labels = clean_labels(sub_labels, sub_edges, rounds=2)
    j4, w4 = smooth_weights(graph, sub_labels, bone_names)

    arrays = {
        "position": sub_v.astype(np.float32),
        "normal": vertex_normals(sub_v, sub_f).astype(np.float32),
        "joints": j4,
        "weights": w4,
        "indices": sub_f.astype(np.uint32),
    }
    write_glb(args.out, gltf, binary, mesh_accessors, arrays)
    blended = (w4[:, 1] > 0).mean() * 100
    print(f"output: {len(sub_v)} vertices, {len(sub_f)} triangles, {blended:.0f}% of vertices blend 2+ bones")
    print(f"wrote {args.out} ({Path(args.out).stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
