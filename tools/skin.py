"""The painted bodies: their UVs on the built meshes.

`models/source/<f|m>_painted.glb` are the base bodies re-exported from Blender
with a painted texture: the same triangles in another order, turned 180
degrees about X and (for the male) scaled to about 1/149. `load_painted` puts
them back into the base body's mesh space and `corner_uvs` gives every
triangle corner of a built mesh its painted UV.
"""
import numpy as np
import trimesh
from scipy.spatial import cKDTree

from glb import read_accessor, read_glb


def load_painted(path, src_positions):
    """Painted mesh in the source's mesh space: (verts, uvs, faces, gltf, binary)."""
    gltf, binary = read_glb(path)
    prim = gltf["meshes"][0]["primitives"][0]
    v = read_accessor(gltf, binary, prim["attributes"]["POSITION"]).astype(float) * [1, -1, -1]
    uv = read_accessor(gltf, binary, prim["attributes"]["TEXCOORD_0"]).astype(float)
    f = read_accessor(gltf, binary, prim["indices"]).astype(np.int64).reshape(-1, 3)
    scale = np.ptp(src_positions[:, 0]) / np.ptp(v[:, 0])
    v = v * scale
    v += src_positions.min(0) - v.min(0)
    return v, uv, f, gltf, binary


def corner_uvs(verts, faces, painted, tol=1e-3):
    """(F, 3, 2) painted UV for each corner of the built mesh's faces.

    Faces that are triangles of the painted mesh take its UVs exactly (seams
    included: the painted face says which side of a seam it is on). The
    others (split around the mouth) lie inside painted triangles and take
    barycentric UVs from the one nearest their centre.
    """
    pv, puv, pf = painted[:3]
    # One id per distinct painted position (seam vertices are duplicated).
    _, pos_id = np.unique(np.round(pv, 4), axis=0, return_inverse=True)
    pos_id = pos_id.ravel()
    tree = cKDTree(pv)
    d, nearest = tree.query(verts)
    vid = np.where(d < tol, pos_id[nearest], -1)
    key_of = {}
    for i, tri in enumerate(pos_id[pf]):
        key_of[tuple(sorted(tri))] = i
    out = np.zeros((len(faces), 3, 2))
    todo = []
    for i, tri in enumerate(vid[faces]):
        j = key_of.get(tuple(sorted(tri))) if (tri >= 0).all() else None
        if j is None:
            todo.append(i)
            continue
        ids = pos_id[pf[j]]
        for c in range(3):
            out[i, c] = puv[pf[j][list(ids).index(tri[c])]]
    if todo:
        todo = np.array(todo)
        mesh = trimesh.Trimesh(pv, pf, process=False)
        centres = verts[faces[todo]].mean(1)
        _, _, tri = trimesh.proximity.closest_point(mesh, centres)
        for c in range(3):
            bary = trimesh.triangles.points_to_barycentric(pv[pf[tri]], verts[faces[todo, c]])
            out[todo, c] = np.einsum("ij,ijk->ik", bary, puv[pf[tri]])
    return out, len(todo)


def split_by_uv(faces, uv):
    """New vertex ids so each (vertex, UV) pair is its own vertex.

    Returns (new faces, old vertex id of each new vertex, UV of each new vertex).
    """
    key = np.c_[faces.reshape(-1, 1), np.round(uv.reshape(-1, 2) * 2 ** 16)]
    uniq, inverse = np.unique(key, axis=0, return_inverse=True)
    inverse = inverse.ravel()
    first = np.zeros(len(uniq), np.int64)
    first[inverse] = np.arange(len(inverse))
    return inverse.reshape(-1, 3), uniq[:, 0].astype(np.int64), uv.reshape(-1, 2)[first]
