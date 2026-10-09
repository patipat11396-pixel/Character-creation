"""Fit the ponytail hair to the character's head and rig it.

The hair (`models/source/hair.glb`, converted from `hair.fbx` by
`fbx_to_glb.mjs`) is a single closed mesh in metres, Y up, facing +Z: a centre
parted fringe, long hair at the back of the head, and a high ponytail tied at
the top-back that rises, arcs over and hangs down behind.

* `load` turns it into the character's mesh space axes (Z up, front -Y).
* `fit` scales and moves it onto the head: the inside of the hair cap is
  matched to the head by ray casting, then pushed out so the scalp does not
  poke through.
* `rig` places a HairRoot bone at the centre of the head and a chain of
  ponytail bones from the tie to the tip, and weights the hair to them. The
  cap follows HairRoot rigidly; the tail blends along the chain so the menu
  can swing it with spring physics.
"""
import numpy as np
import trimesh
from scipy.spatial import cKDTree
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

from glb import read_accessor, read_glb

TAIL_BONES = 8
SEAM_BLUR = 40              # smoothing passes across the tail / back hair seam
CLEARANCE = 0.35            # cm between scalp and the inside of the hair cap
# Landmarks in source units, character axes (x side, y back, z up).
CAP_CENTRE = np.array([0.0, -0.17, 0.5])    # inside the cap
TIE = np.array([0.0, 0.07, 0.83])           # hair tie


def tail_region(p):
    """The ponytail: behind the tie, minus the long hair on the back of the head."""
    x, y, z = p.T
    return (y > 0.02) & ~((y < 0.17) & (z < 0.74))


def load(path):
    gltf, binary = read_glb(path)
    raw = read_accessor(gltf, binary, 0)
    verts, inverse = np.unique(np.round(raw, 6), axis=0, return_inverse=True)
    faces = inverse.ravel().reshape(-1, 3)
    # source (x side, y up, z front) -> character mesh axes (x side, y back, z up)
    return np.c_[verts[:, 0], -verts[:, 2], verts[:, 1]].astype(float), faces


def _directions():
    out = []
    for el in np.radians(np.arange(-15, 90, 6)):
        for az in np.radians(np.arange(0, 360, 8)):
            if np.cos(az) > 0.5 and el < np.radians(30):
                continue                     # the face, where the fringe hangs
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


def fit(hair, faces, head_verts, head_faces, head_centre):
    """Scale and move the hair (source units) onto the head (cm)."""
    head = trimesh.Trimesh(head_verts, head_faces, process=False)
    cap = trimesh.Trimesh(hair, faces, process=False)
    dirs = _directions()
    r_cap = _hits(cap, CAP_CENTRE, dirs, outermost=False)
    r_head = _hits(head, head_centre, dirs, outermost=True)
    ok = ~np.isnan(r_cap) & ~np.isnan(r_head)
    src = CAP_CENTRE + r_cap[ok, None] * dirs[ok]
    dst = head_centre + (r_head[ok, None] + CLEARANCE) * dirs[ok]
    scale, offset = np.zeros(3), np.zeros(3)
    for k in range(3):
        a = np.c_[src[:, k], np.ones(len(src))]
        scale[k], offset[k] = np.linalg.lstsq(a, dst[:, k], rcond=None)[0]
    # A pure per-axis fit squashes the hair vertically to suit the wide head;
    # keep the height scale close to the width so the ponytail keeps its shape.
    centre_dst = CAP_CENTRE * scale + offset
    scale[2] = 0.97 * (scale[2] + scale[0]) / 2
    offset = centre_dst - CAP_CENTRE * scale
    fitted = hair * scale + offset
    # Push out where the scalp would poke through the cap.
    cap = trimesh.Trimesh(fitted, faces, process=False)
    r_cap = _hits(cap, head_centre, dirs, outermost=False)
    ok = ~np.isnan(r_cap) & ~np.isnan(r_head)
    push = np.clip(np.percentile((r_head[ok] + CLEARANCE) / r_cap[ok], 95), 1.0, 1.15)
    return head_centre + (fitted - head_centre) * push


def rig(source, fitted, faces, head_centre):
    """Bone positions and per-vertex weights.

    Returns (root, joints, weights): root is the HairRoot position, joints the
    TAIL_BONES + 1 positions down the ponytail (the last is the tip), and
    weights an (n, 1 + TAIL_BONES) array over [HairRoot, Tail1..TailN].
    """
    n = len(source)
    tail = tail_region(source)
    e = np.unique(np.sort(np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]]), 1), axis=0)
    keep = tail[e[:, 0]] & tail[e[:, 1]]
    length = np.linalg.norm(fitted[e[keep, 0]] - fitted[e[keep, 1]], axis=1)
    graph = coo_matrix((length, (e[keep, 0], e[keep, 1])), shape=(n, n)).tocsr()
    graph = graph + graph.T
    start = np.flatnonzero(tail & (np.linalg.norm(source - TIE, axis=1) < 0.06))
    u = dijkstra(graph, indices=start, min_only=True)    # cm along the ponytail
    # Bits of strand that touch the tail only through the cap take the
    # distance of the nearest reached point, so they swing with the tail.
    lost = tail & ~np.isfinite(u)
    found = np.flatnonzero(tail & np.isfinite(u))
    u[lost] = u[found[cKDTree(fitted[found]).query(fitted[lost])[1]]]
    u[~tail] = 0
    top = np.percentile(u[tail], 90)
    stops = np.linspace(0, top, TAIL_BONES)
    joints = []
    for s in stops:
        band = tail & (np.abs(u - s) < top / TAIL_BONES / 3)
        joints.append(fitted[band].mean(0))
    joints[0] = fitted[start].mean(0)
    low = tail & (fitted[:, 2] < np.percentile(fitted[tail, 2], 4))
    joints.append(fitted[low].mean(0))                   # tip: the lowest strands
    joints = np.array(joints)
    stops = np.r_[stops, top + np.linalg.norm(joints[-1] - joints[-2])]

    weights = np.zeros((n, 1 + TAIL_BONES))
    mids = (stops[:-1] + stops[1:]) / 2
    # HairRoot holds the cap and the first part of the tail at the tie.
    t = np.clip(u / mids[0], 0, 1)
    root = 1 - t * t * (3 - 2 * t)
    weights[:, 0] = root
    pos = np.interp(u, mids, np.arange(TAIL_BONES))
    lo = np.floor(pos).astype(int)
    hi = np.minimum(lo + 1, TAIL_BONES - 1)
    frac = pos - lo
    rest = 1 - root
    np.add.at(weights, (np.arange(n), 1 + lo), rest * (1 - frac))
    np.add.at(weights, (np.arange(n), 1 + hi), rest * frac)

    # The ponytail's sides are fused to the long hair on the back of the head
    # along their whole length. Blur the weights across that seam (back half
    # of the hair only) so the back hair beside the tail follows it partly and
    # the stretch spreads out instead of tearing.
    adj = coo_matrix((np.ones(len(e)), (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    adj = adj + adj.T
    adj = coo_matrix(adj.multiply(1 / np.asarray(adj.sum(1)))).tocsr()
    back = source[:, 1] > -0.02
    near_tie = np.linalg.norm(source - TIE, axis=1) < 0.05
    blur = back & ~near_tie
    for _ in range(SEAM_BLUR):
        weights[blur] = 0.5 * weights[blur] + 0.5 * (adj @ weights)[blur]
    return head_centre.copy(), joints, weights
