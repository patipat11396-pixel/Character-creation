"""Fit hairstyles to the character's head and rig them.

Every hairstyle is a single closed mesh in `models/source/hair/<id>.glb`
(converted from the FBX by `fbx_to_glb.mjs`), in metres, Y up, facing +Z,
sized for some other head. `tools/hairstyles.json` lists them and says which
parts swing.

* `load` turns a source mesh into the character's mesh axes (x side,
  y back, z up), still in source units.
* `cap_centre` finds the hollow the head goes into: the largest empty sphere
  inside the hair that has hair above it, behind it and on both sides.
* `fit` scales and moves the hair onto the head: the inside of the cap is
  matched to the head by ray casting, then pushed out so the scalp does not
  poke through.
* `rig` builds a bone chain for every swinging part (a ponytail, a braid,
  each twin tail) and weights the hair to HairRoot and those chains.
"""
import numpy as np
import trimesh
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra
from scipy.spatial import cKDTree

from glb import read_accessor, read_glb

CLEARANCE = 0.35            # cm between scalp and the inside of the hair cap
SEAM_BLUR = 40              # smoothing passes across each chain's seam with the rest


def load(path):
    gltf, binary = read_glb(path)
    raw = read_accessor(gltf, binary, 0)
    verts, inverse = np.unique(np.round(raw, 6), axis=0, return_inverse=True)
    faces = inverse.ravel().reshape(-1, 3)
    # source (x side, y up, z front) -> character mesh axes (x side, y back, z up)
    return np.c_[verts[:, 0], -verts[:, 2], verts[:, 1]].astype(float), faces


def cap_centre(verts):
    """Centre of the head-sized hollow inside the hair, in source units."""
    tree = cKDTree(verts)
    lo, hi = verts.min(0), verts.max(0)
    size = hi - lo
    step = size.max() / 60
    ys = np.arange(lo[1], hi[1], step)
    zs = np.arange(lo[2] + 0.3 * size[2], hi[2], step)
    yy, zz = np.meshgrid(ys, zs, indexing="ij")
    pts = np.c_[np.zeros(yy.size), yy.ravel(), zz.ravel()]
    gap, _ = tree.query(pts)

    def reach(points, direction, farthest=False):
        # Distance to the nearest (or farthest) hair in a thin column from each point.
        out = np.full(len(points), np.inf)
        for k, p in enumerate(points):
            rel = verts - p
            along = rel @ direction
            across = np.linalg.norm(rel - along[:, None] * direction, axis=1)
            hit = (along > 0) & (across < 2 * step)
            if hit.any():
                out[k] = along[hit].max() if farthest else along[hit].min()
        return out

    # The roomiest point that sits inside the cap the way a head does: hair
    # close above, the top of the hair no more than about a head above, and
    # hair close behind and to both sides. This rules out the space under the
    # cap where the neck goes and gaps between hanging strands.
    order = np.argsort(-gap)[:2500]
    sel, room = pts[order], gap[order]
    up = np.array([0, 0, 1.0])
    ok = (reach(sel, up) < 1.6 * room) & (reach(sel, up, farthest=True) < 2.4 * room)
    for d in ([0, 1, 0], [1, 0, 0], [-1, 0, 0]):
        ok &= reach(sel, np.array(d, float)) < 1.8 * room
    if not ok.any():
        raise ValueError("no hollow found inside the hair")
    return sel[np.flatnonzero(ok)[0]]


def _directions():
    out = []
    for el in np.radians(np.arange(-15, 90, 6)):
        for az in np.radians(np.arange(0, 360, 8)):
            if np.cos(az) > 0.5 and el < np.radians(30):
                continue                     # the face, where a fringe hangs
            out.append([np.cos(el) * np.sin(az), -np.cos(el) * np.cos(az), np.sin(el)])
    return np.array(out)


def _hits(mesh, centre, dirs, outermost):
    r = np.full(len(dirs), np.nan)
    for i in range(0, len(dirs), 400):
        d = dirs[i:i + 400]
        loc, ray, _ = mesh.ray.intersects_location(np.repeat(centre[None], len(d), 0), d, multiple_hits=True)
        t = np.einsum("ij,ij->i", loc - centre, d[ray])
        for k, tk in zip(ray, t):
            if tk <= 1e-6:
                continue
            j = i + k
            if np.isnan(r[j]) or (tk > r[j] if outermost else tk < r[j]):
                r[j] = tk
    return r


def fit(hair, faces, head_verts, head_faces, head_centre, centre=None):
    """Scale and move the hair (source units) onto the head (cm)."""
    if centre is None:
        centre = cap_centre(hair)
    head = trimesh.Trimesh(head_verts, head_faces, process=False)
    cap = trimesh.Trimesh(hair, faces, process=False)
    dirs = _directions()
    r_cap = _hits(cap, centre, dirs, outermost=False)
    r_head = _hits(head, head_centre, dirs, outermost=True)
    ok = ~np.isnan(r_cap) & ~np.isnan(r_head)
    src = centre + r_cap[ok, None] * dirs[ok]
    dst = head_centre + (r_head[ok, None] + CLEARANCE) * dirs[ok]
    scale, offset = np.zeros(3), np.zeros(3)
    for k in range(3):
        a = np.c_[src[:, k], np.ones(len(src))]
        scale[k], offset[k] = np.linalg.lstsq(a, dst[:, k], rcond=None)[0]
    # A pure per-axis fit squashes the hair vertically to suit the wide head;
    # keep the height scale close to the width so long hair keeps its length.
    centre_dst = centre * scale + offset
    scale[2] = 0.97 * (scale[2] + scale[0]) / 2
    offset = centre_dst - centre * scale
    fitted = hair * scale + offset
    # Push out where the scalp would poke through the cap.
    cap = trimesh.Trimesh(fitted, faces, process=False)
    r_cap = _hits(cap, head_centre, dirs, outermost=False)
    ok = ~np.isnan(r_cap) & ~np.isnan(r_head)
    push = np.clip(np.percentile((r_head[ok] + CLEARANCE) / r_cap[ok], 95), 1.0, 1.15)
    return head_centre + (fitted - head_centre) * push


def region(points, spec):
    """Vertices inside any `include` box and no `exclude` box (source units).

    Boxes are {"min": [x, y, z], "max": [x, y, z]}; null means unbounded.
    """
    def inside(box):
        m = np.ones(len(points), bool)
        for k in range(3):
            if box.get("min") and box["min"][k] is not None:
                m &= points[:, k] >= box["min"][k]
            if box.get("max") and box["max"][k] is not None:
                m &= points[:, k] <= box["max"][k]
        return m
    keep = np.zeros(len(points), bool)
    for box in spec.get("include", []):
        keep |= inside(box)
    for box in spec.get("exclude", []):
        keep &= ~inside(box)
    return keep


def _chain(source, fitted, faces, edges, mask, bones, tie):
    """Joint positions down one swinging part and each vertex's distance along it."""
    n = len(source)
    keep = mask[edges[:, 0]] & mask[edges[:, 1]]
    length = np.linalg.norm(fitted[edges[keep, 0]] - fitted[edges[keep, 1]], axis=1)
    graph = coo_matrix((length, (edges[keep, 0], edges[keep, 1])), shape=(n, n)).tocsr()
    graph = graph + graph.T
    idx = np.flatnonzero(mask)
    if tie is None:
        # Where the part leaves the head: its highest band.
        top = source[idx, 2].max()
        start = idx[source[idx, 2] > top - 0.03]
    else:
        start = idx[np.linalg.norm(source[idx] - tie, axis=1) < 0.06]
    u = dijkstra(graph, indices=start, min_only=True)    # cm along the part
    lost = mask & ~np.isfinite(u)
    found = np.flatnonzero(mask & np.isfinite(u))
    if lost.any():
        u[lost] = u[found[cKDTree(fitted[found]).query(fitted[lost])[1]]]
    u[~mask] = 0
    top = np.percentile(u[mask], 90)
    stops = np.linspace(0, top, bones)
    joints = []
    for s in stops:
        band = mask & (np.abs(u - s) < top / bones / 3)
        joints.append(fitted[band].mean(0))
    joints[0] = fitted[start].mean(0)
    low = mask & (fitted[:, 2] < np.percentile(fitted[mask, 2], 4))
    joints.append(fitted[low].mean(0))                   # tip: the lowest strands
    return np.array(joints), u, stops, start


def rig(source, fitted, faces, chains):
    """Bone chains and per-vertex weights.

    Returns (chain_joints, weights): chain_joints is a list with one array of
    joint positions per chain (bones + 1, the last is the tip), weights an
    (n, 1 + total bones) array over [HairRoot, chain 1 bones, chain 2 bones, ...].
    """
    n = len(source)
    edges = np.unique(np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), 1), axis=0)
    total = sum(c["bones"] for c in chains)
    weights = np.zeros((n, 1 + total))
    weights[:, 0] = 1
    all_joints, blur, protect = [], np.zeros(n, bool), np.zeros(n, bool)
    col = 1
    for c in chains:
        mask = region(source, c["region"])
        tie = np.array(c["tie"]) if c.get("tie") else None
        joints, u, stops, start = _chain(source, fitted, faces, edges, mask, c["bones"], tie)
        all_joints.append(joints)
        bones = c["bones"]
        mids = (stops[:-1] + stops[1:]) / 2 if bones > 1 else stops + 1
        t = np.clip(u / mids[0], 0, 1)
        root = 1 - t * t * (3 - 2 * t)
        root[~mask] = 1
        pos = np.interp(u, mids, np.arange(len(mids))) if bones > 1 else np.zeros(n)
        lo = np.floor(pos).astype(int)
        hi = np.minimum(lo + 1, bones - 1)
        frac = pos - lo
        rest = np.where(mask, 1 - root, 0)
        weights[mask, 0] = root[mask]
        np.add.at(weights, (np.arange(n), col + lo), rest * (1 - frac))
        np.add.at(weights, (np.arange(n), col + hi), rest * frac)
        col += bones
        # Blur across this chain's seam with the rest of the hair, but keep
        # the place where it leaves the head pinned.
        near = cKDTree(fitted[mask]).query(fitted)[0] < c.get("blend", 4.0)   # cm
        blur |= near
        protect |= np.linalg.norm(fitted - fitted[start].mean(0), axis=1) < 3.0
    if chains:
        adj = coo_matrix((np.ones(len(edges)), (edges[:, 0], edges[:, 1])), shape=(n, n)).tocsr()
        adj = adj + adj.T
        adj = coo_matrix(adj.multiply(1 / np.asarray(adj.sum(1)))).tocsr()
        blur &= ~protect
        for _ in range(SEAM_BLUR):
            weights[blur] = 0.5 * weights[blur] + 0.5 * (adj @ weights)[blur]
    return all_joints, weights
