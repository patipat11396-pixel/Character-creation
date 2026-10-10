"""Face fixes for the retargeted character: smoother eye area and a working mouth.

All coordinates are the source mesh's: centimetres, Z up, front = -Y.

* The eye recesses are covered by a few long, thin triangles (up to 3.6 cm
  against 0.85 cm elsewhere), which read as bumps. `refine_long_edges` splits
  them down to the face's normal size and `smooth_eye_area` relaxes the patch.
* The mouth corners have tiny folded triangles that show as white spots;
  `mouth_corner_normals` evens out their shading.
* The mouth is sculpted shut: the lips fold about 2 cm inwards and meet along
  one line. `cut_mouth` splits the mesh along that line so the lips can part,
  `mouth_morphs` builds the shape keys and `mouth_parts` adds teeth and a
  tongue.
"""
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

MOUTH_Z = 141.45                     # height of the line where the lips meet
MOUTH_CORNERS = (np.array([-2.85, 0.85, 141.45]), np.array([2.85, 0.85, 141.45]))
JAW_HINGE = np.array([13.0, 147.0])  # (y, z) of the jaw hinge, in front of the ears
JAW_ANGLE = np.radians(13)
MORPHS = ["jawOpen", "smile", "frown", "mouthRound"]


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def edge_graph(verts, faces):
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    w = np.linalg.norm(verts[e[:, 0]] - verts[e[:, 1]], axis=1)
    n = len(verts)
    g = coo_matrix((w, (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    return g + g.T, e


# ---------------------------------------------------------------- eye area

def eye_area(points):
    """Front of the face between the cheeks and the brow, minus nose and ears."""
    x, y, z = points.T
    return ((z > 143.5) & (z < 162) & (y < 5) & (np.abs(x) < 10.2)
            & ~((np.abs(x) < 1.8) & (z < 151)))           # nose


def refine_long_edges(verts, faces, attrs, max_len=0.9, rounds=6):
    """Split edges longer than max_len inside the eye area, keeping the mesh conforming.

    attrs are per-vertex arrays that new midpoints get by averaging.
    """
    for _ in range(rounds):
        e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
        key = np.sort(e, axis=1)
        mid = (verts[key[:, 0]] + verts[key[:, 1]]) / 2
        long_ = (np.linalg.norm(verts[key[:, 0]] - verts[key[:, 1]], axis=1) > max_len) & eye_area(mid)
        if not long_.any():
            break
        split = np.unique(key[long_], axis=0)
        index = {tuple(k): len(verts) + i for i, k in enumerate(split)}
        verts = np.vstack([verts, (verts[split[:, 0]] + verts[split[:, 1]]) / 2])
        attrs = [np.vstack([a, (a[split[:, 0]] + a[split[:, 1]]) / 2]) for a in attrs]
        out = []
        for a, b, c in faces:
            m = [index.get((min(p, q), max(p, q))) for p, q in ((a, b), (b, c), (c, a))]
            k = sum(x is not None for x in m)
            if k == 0:
                out.append((a, b, c))
            elif k == 3:
                ab, bc, ca = m
                out += [(a, ab, ca), (ab, b, bc), (ca, bc, c), (ab, bc, ca)]
            else:
                # rotate so the first split edge is (p, q)
                tri, mids = [a, b, c], m
                while mids[0] is None or (k == 2 and mids[2] is not None and mids[1] is None):
                    tri, mids = tri[1:] + tri[:1], mids[1:] + mids[:1]
                p, q, r = tri
                if k == 1:
                    out += [(p, mids[0], r), (mids[0], q, r)]
                else:  # edges (p,q) and (q,r) split
                    pq, qr = mids[0], mids[1]
                    out += [(p, pq, r), (pq, q, qr), (pq, qr, r)]
        faces = np.array(out)
    return verts, faces, attrs


def smooth_eye_area(verts, faces, avg):
    """Relax the refined patch; its outer two rings stay put so it blends in."""
    inside = eye_area(verts)
    fixed = ~inside
    for _ in range(2):
        fixed = fixed | (avg @ fixed.astype(float) > 0)
    move = inside & ~fixed
    out = verts.copy()
    for _ in range(10):
        out[move] = 0.5 * out[move] + 0.5 * (avg @ out)[move]
    for _ in range(40):
        for factor in (0.5, -0.53):
            out[move] += factor * (avg @ out - out)[move]
    return out, move


# ---------------------------------------------------------------- mouth

def mouth_corner_normals(verts, normals, avg, crease, iterations=8):
    """Even out the shading at both mouth corners without moving anything.

    The source has tiny triangles folded back on themselves where the lips
    meet at each corner (edges bending 120-165 degrees). Their normals point
    the wrong way and catch the light as white spots. Moving the vertices
    breaks the lip line, so only the normals there are blended with their
    neighbours'.
    """
    x, y, z = verts.T
    box = (np.abs(np.abs(x) - 3.0) < 1.1) & (np.abs(z - MOUTH_Z) < 1.0) & (y > -1.5) & (y < 2.5)
    fix = box & (crease > 60)
    for _ in range(2):
        fix = fix | ((avg @ fix.astype(float) > 0) & box)
    out = normals.copy()
    for _ in range(iterations):
        out[fix] = (avg @ out)[fix]
        out[fix] /= np.linalg.norm(out[fix], axis=1, keepdims=True)
    return out, fix


def lip_line(verts, faces):
    """Vertex path along the bottom of the lip fold, corner to corner."""
    graph, edges = edge_graph(verts, faces)
    x, y, z = verts.T
    near = (z > MOUTH_Z - 0.9) & (z < MOUTH_Z + 0.9) & (np.abs(x) < 3.3) & (y > -2.6) & (y < 1.8)
    # Deepest (largest y) point of the fold at each x, to steer the path.
    xs = np.arange(-3.0, 3.01, 0.25)
    deep = np.array([y[near & (np.abs(x - x0) < 0.3)].max() for x0 in xs])
    a, b = edges.T
    keep = near[a] & near[b]
    mid = (verts[a] + verts[b]) / 2
    shallow = np.maximum(0, np.interp(mid[:, 0], xs, deep) - mid[:, 1])
    cost = np.linalg.norm(verts[a] - verts[b], axis=1) * (1 + 40 * shallow + 20 * np.abs(mid[:, 2] - MOUTH_Z))
    n = len(verts)
    g = coo_matrix((cost[keep], (a[keep], b[keep])), shape=(n, n)).tocsr()
    g = g + g.T
    cand = np.flatnonzero(near)
    start, end = (cand[np.linalg.norm(verts[cand] - c, axis=1).argmin()] for c in MOUTH_CORNERS)
    _, pred = dijkstra(g, indices=start, return_predecessors=True)
    path = [end]
    while path[-1] != start:
        path.append(pred[path[-1]])
        assert path[-1] >= 0, "lip line not connected"
    return path[::-1]


def cut_mouth(verts, faces, attrs):
    """Duplicate the lip line (not its two corners); faces below take the copies.

    Returns the new arrays plus the upper and lower vertex ids along the line.
    """
    path = lip_line(verts, faces)
    on_path = set(path)
    path_edges = {frozenset(e) for e in zip(path, path[1:])}
    centroids = verts[faces].mean(1)
    faces = faces.copy()
    upper, lower = [path[0]], [path[0]]
    for p in path[1:-1]:
        fan = np.flatnonzero((faces == p).any(1))
        # Group the fan's faces across edges that are not on the lip line.
        group = {f: f for f in fan}

        def root(f):
            while group[f] != f:
                f = group[f]
            return f
        for i, f in enumerate(fan):
            for g in fan[i + 1:]:
                shared = set(faces[f]) & set(faces[g])
                if len(shared) == 2 and frozenset(shared) not in path_edges:
                    group[root(f)] = root(g)
        roots = {}
        for f in fan:
            roots.setdefault(root(f), []).append(f)
        assert len(roots) == 2, f"lip line vertex {p} splits into {len(roots)} groups"
        below = min(roots.values(), key=lambda fs: centroids[fs, 2].mean())
        copy = len(verts)
        verts = np.vstack([verts, verts[p]])
        attrs = [np.vstack([a, a[p]]) for a in attrs]
        for f in below:
            faces[f][faces[f] == p] = copy
        upper.append(p)
        lower.append(copy)
    upper.append(path[-1])
    lower.append(path[-1])
    assert len(on_path) == len(path)
    return verts, faces, attrs, np.array(upper), np.array(lower)


def rotate_jaw(points, amount=1.0):
    """Points rotated about the jaw hinge (an X axis), by amount * JAW_ANGLE."""
    a = JAW_ANGLE * np.asarray(amount)
    dy, dz = points[:, 1] - JAW_HINGE[0], points[:, 2] - JAW_HINGE[1]
    out = points.copy()
    out[:, 1] = JAW_HINGE[0] + dy * np.cos(a) - dz * np.sin(a)
    out[:, 2] = JAW_HINGE[1] + dy * np.sin(a) + dz * np.cos(a)
    return out


def mouth_morphs(verts, faces, upper, lower):
    """Position deltas for each of MORPHS on the body mesh."""
    graph, _ = edge_graph(verts, faces)
    d_up = dijkstra(graph, indices=upper[1:-1], min_only=True, limit=40)
    d_low = dijkstra(graph, indices=lower[1:-1], min_only=True, limit=40)
    d_up, d_low = np.minimum(d_up, 99), np.minimum(d_low, 99)   # unreached -> far
    x, y, z = verts.T
    jaw_side = smoothstep(-1.5, 1.5, d_up - d_low)
    jaw_side[lower] = 1
    jaw_side[upper] = 0
    jaw_side[[upper[0], upper[-1]]] = 0.5
    w_jaw = (jaw_side * smoothstep(134.0, 137.5, z) * smoothstep(9.0, 4.0, np.abs(x))
             * smoothstep(10, 4, y) * smoothstep(MOUTH_Z + 3, MOUTH_Z + 1, z))
    jaw = rotate_jaw(verts) - verts
    jaw *= w_jaw[:, None]
    lift = (1 - jaw_side) * np.exp(-(d_up ** 2) / (2 * 0.6 ** 2)) * smoothstep(3.6, 2.0, np.abs(x))
    jaw[:, 2] += 0.22 * lift

    def corner_field(radius):
        out = np.zeros(len(verts))
        sides = np.zeros(len(verts))
        for s, c in zip((-1, 1), MOUTH_CORNERS):
            g = np.exp(-np.sum((verts - c) ** 2, 1) / (2 * radius ** 2)) * smoothstep(5, 2, y)
            out += g
            sides += s * g
        return out, np.sign(sides)

    g, side = corner_field(1.1)
    smile = np.c_[0.5 * side * g, 0.4 * g, 0.8 * g]
    cheek = np.zeros(len(verts))
    for c in MOUTH_CORNERS:
        cc = c + [np.sign(c[0]) * 1.0, -1.0, 2.0]
        cheek += np.exp(-np.sum((verts - cc) ** 2, 1) / (2 * 1.8 ** 2))
    smile[:, 2] += 0.3 * cheek * smoothstep(5, 1, y)
    frown = np.c_[-0.1 * side * g, 0.1 * g, -0.55 * g]

    lips = np.exp(-((z - MOUTH_Z) ** 2) / (2 * 1.1 ** 2)) * smoothstep(4.2, 2.0, np.abs(x)) * smoothstep(3, 0, y)
    rnd = np.c_[-0.32 * x * lips, -0.45 * lips * (1 - (x / 3.2) ** 2).clip(0), np.zeros(len(verts))]
    return {"jawOpen": jaw, "smile": smile, "frown": frown, "mouthRound": rnd}, w_jaw


def lip_mask(verts):
    """0..1 per vertex: how much of the lip colour each vertex takes.

    A soft lens shape around the lip line, measured on this face: the upper
    lip reaches about 0.85 cm above the line and the lower lip about 1.7 cm
    below it, both narrowing towards the corners. The inside of the lip fold
    is included so the colour carries into the open mouth.
    """
    x, y, z = verts.T
    up = z >= MOUTH_Z
    half = np.where(up, 3.0, 2.9)                       # half width of each lip
    across = np.clip(1 - (x / half) ** 2, 0, 1)
    reach = np.where(up, 0.85 * np.sqrt(across), 1.7 * across ** 0.7)
    t = np.abs(z - MOUTH_Z) / np.maximum(reach, 1e-3)
    mask = 1 - smoothstep(0.75, 1.15, t)
    mask *= smoothstep(half, half - 0.45, np.abs(x))    # soft corners
    mask *= smoothstep(3.5, 2.5, y)                     # front of the face only
    return mask.astype(np.float32)


# ---------------------------------------------------------------- face shape

# Face shape keys: name -> menu label. Each is a smooth weighted push on the
# face, built on the full-size head (process_character shrinks it with the
# head). Landmarks measured on this head, in cm (x side, y back, z up).
FACE_SHAPES = {
    "noseWidth": "Nose width", "noseLength": "Nose length", "noseBridge": "Nose bridge",
    "lipsFull": "Lip fullness", "lipsWidth": "Lip width",
    "foreheadFull": "Forehead fullness", "foreheadSlope": "Forehead slope",
    "chinLength": "Chin length", "chinForward": "Chin forward", "chinWidth": "Chin width",
    "jawWidth": "Jaw width", "jawSquare": "Jaw angle",
    "eyeSize": "Eye size", "eyeSpacing": "Eye spacing", "eyeHeight": "Eye height", "eyeTilt": "Eye tilt",
}
EYE = np.array([6.35, 153.3])          # x, z of each eye recess centre


def _blob(verts, centre, sigma):
    d = (verts - np.asarray(centre)) / np.asarray(sigma)
    return np.exp(-0.5 * np.sum(d * d, axis=1))


def face_shapes(verts):
    """Position deltas (cm) for each of FACE_SHAPES at full strength (slider 1)."""
    x, y, z = verts.T
    n = len(verts)
    front = smoothstep(12, 4, y)                 # the face, not the back of the head
    neck_guard = smoothstep(132.5, 135, z)
    out = {}

    def delta(dx=0.0, dy=0.0, dz=0.0):
        return np.c_[np.broadcast_to(dx, n), np.broadcast_to(dy, n), np.broadcast_to(dz, n)].astype(float)

    # Nose: the whole nose, its tip, and the bridge between the eyes.
    nose = _blob(verts, (0, -2.5, 145.0), (2.0, 3.0, 2.6)) * front
    tip = _blob(verts, (0, -3.6, 145.6), (1.6, 2.0, 1.7)) * front
    bridge = _blob(verts, (0, -1.4, 150.0), (1.3, 2.2, 2.4)) * front
    out["noseWidth"] = delta(dx=0.4 * x * nose)
    out["noseLength"] = delta(dy=-0.5 * tip, dz=-1.1 * tip)
    out["noseBridge"] = delta(dy=-0.9 * bridge)

    # Lips: the lip area, pushed out and apart (fuller) or stretched sideways.
    lips = lip_mask(verts).astype(float)
    # Spread away from the lip line smoothly (zero on the line, so the lips stay closed).
    out["lipsFull"] = delta(dy=-0.5 * lips, dz=0.3 * np.clip((z - MOUTH_Z) / 1.2, -1, 1) * lips)
    out["lipsWidth"] = delta(dx=0.16 * x * lips)

    # Forehead: between the brows and the top of the head, front only.
    fore = smoothstep(151, 157.5, z) * smoothstep(168.5, 160, z) * smoothstep(10.5, 3, np.abs(x)) * front
    out["foreheadFull"] = delta(dy=-0.9 * fore)
    out["foreheadSlope"] = delta(dy=0.12 * (z - 154.5) * fore)

    # Chin and jaw.
    chin = (smoothstep(140.5, 137.0, z) * smoothstep(5.0, 1.5, np.abs(x))
            * smoothstep(10, 6, y) * neck_guard)
    out["chinLength"] = delta(dz=-0.9 * chin)
    out["chinForward"] = delta(dy=-1.0 * chin)
    out["chinWidth"] = delta(dx=0.22 * x * chin)
    jaw = (smoothstep(145, 141, z) * smoothstep(2.5, 5.0, np.abs(x)) * smoothstep(15, 11, y)
           * neck_guard * smoothstep(-1, 2, y))
    out["jawWidth"] = delta(dx=0.16 * x * jaw)
    corner = sum(_blob(verts, (s_ * 8.6, 8.5, 137.8), (2.0, 3.0, 2.0)) for s_ in (-1, 1)) * neck_guard
    out["jawSquare"] = delta(dx=0.7 * np.sign(x) * corner, dz=-0.3 * corner)

    # Eyes: the eye recesses only (the model has no eyeballs).
    eye = sum(_blob(verts, (s_ * EYE[0], 0.0, EYE[1]), (2.7, 99, 2.4)) for s_ in (-1, 1)) * front
    eye *= smoothstep(1.2, 2.2, np.abs(x))      # leave the bridge of the nose alone
    cx = np.sign(x) * EYE[0]
    out["eyeSize"] = delta(dx=0.18 * (x - cx) * eye, dy=0.35 * eye, dz=0.18 * (z - EYE[1]) * eye)
    out["eyeSpacing"] = delta(dx=0.9 * np.sign(x) * eye)
    out["eyeHeight"] = delta(dz=0.9 * eye)
    out["eyeTilt"] = delta(dz=0.15 * (np.abs(x) - EYE[0]) * eye)
    return out


# ---------------------------------------------------------------- teeth and tongue

def _arch(z0, z1, inset, n=24):
    """A curved band of teeth following the lip line, set `inset` cm behind it."""
    xs = np.linspace(-2.25, 2.25, n)
    ys = -0.25 + 0.16 * xs ** 2 + inset
    front = np.c_[xs, ys]
    back = np.c_[xs * 0.92, ys + 0.3]
    verts, faces = [], []
    for ring in (front, back):
        for zz in (z0, z1):
            verts += [[p[0], p[1], zz] for p in ring]
    verts = np.array(verts, float)
    def idx(r, k, i):  # ring (0 front, 1 back), level (0 bottom, 1 top), column
        return (r * 2 + k) * n + i
    for i in range(n - 1):
        quads = [
            (idx(0, 0, i), idx(0, 0, i + 1), idx(0, 1, i + 1), idx(0, 1, i)),   # front face
            (idx(1, 0, i + 1), idx(1, 0, i), idx(1, 1, i), idx(1, 1, i + 1)),   # back face
            (idx(0, 1, i), idx(0, 1, i + 1), idx(1, 1, i + 1), idx(1, 1, i)),   # top
            (idx(1, 0, i), idx(1, 0, i + 1), idx(0, 0, i + 1), idx(0, 0, i)),   # bottom
        ]
        for a, b, c, d in quads:
            faces += [(a, b, c), (a, c, d)]
    for i, s in ((0, 1), (n - 1, -1)):          # end caps
        a, b, c, d = idx(0, 0, i), idx(1, 0, i), idx(1, 1, i), idx(0, 1, i)
        faces += [(a, c, b), (a, d, c)] if s > 0 else [(a, b, c), (a, c, d)]
    return verts, np.array(faces)


def _tongue(n=16):
    u, v = np.meshgrid(np.linspace(0, np.pi, n), np.linspace(0, 2 * np.pi, n, endpoint=False), indexing="ij")
    pts = np.c_[np.sin(u).ravel() * np.cos(v).ravel(), np.sin(u).ravel() * np.sin(v).ravel(), np.cos(u).ravel()]
    pts = pts * [1.7, 1.8, 0.45] + [0, 2.4, 140.55]
    faces = []
    for i in range(n - 1):
        for j in range(n):
            a, b = i * n + j, i * n + (j + 1) % n
            c, d = (i + 1) * n + (j + 1) % n, (i + 1) * n + j
            faces += [(a, d, c), (a, c, b)]
    return pts, np.array(faces)


def mouth_parts():
    """(name, verts, faces, jaw_weight) for the upper teeth, lower teeth and tongue."""
    upper_v, upper_f = _arch(MOUTH_Z + 0.05, MOUTH_Z + 0.6, 0.45)
    lower_v, lower_f = _arch(MOUTH_Z - 0.6, MOUTH_Z - 0.1, 0.55)
    tongue_v, tongue_f = _tongue()
    return [("UpperTeeth", upper_v, upper_f, 0.0),
            ("LowerTeeth", lower_v, lower_f, 1.0),
            ("Tongue", tongue_v, tongue_f, 1.0)]
