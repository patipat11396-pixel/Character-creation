"""Face work for the base bodies: a mouth that opens, face shape keys and eye patches.

All coordinates are the source mesh's: centimetres, Z up, front = -Y. Every
position comes from the body's landmarks in bodies.py; call `configure(body)`
first.

* The mouth is sculpted shut with only a few large triangles across it.
  `refine_mouth` splits them small, `cut_mouth` splits the mesh along the lip
  line so the lips can part, `mouth_morphs` builds the shape keys and
  `mouth_parts` adds teeth and a tongue.
* `face_shapes` builds the face sliders and `lip_mask` the lip colour area.
"""
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import dijkstra

MORPHS = ["jawOpen", "smile", "frown", "mouthRound"]
JAW_ANGLE = np.radians(13)
B = {}                                   # landmarks of the body being built


def configure(body):
    """Use `body` (a bodies.BODIES entry) for every function below."""
    B.clear()
    B.update(body)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def front_of(y, behind_near, behind_far):
    """1 at the face, 0 further back: falls from `behind_near` to `behind_far`
    cm behind the nose tip (scaled to this head's depth)."""
    f, k = B["nose_tip"][0], B["depth"]
    return smoothstep(f + behind_far * k, f + behind_near * k, y)


def lip_z(x):
    """Height of the lip line at x: it rises towards the corners on a smile."""
    m = B["mouth"]
    return m["z"] + m["kz"] * np.asarray(x) ** 2


def lip_y(x):
    m = B["mouth"]
    return m["y"] + m["ky"] * np.asarray(x) ** 2


def mouth_corners():
    h = B["mouth"]["half"]
    return [np.array([s * h, float(lip_y(h)), float(lip_z(h))]) for s in (-1, 1)]


def edge_graph(verts, faces):
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    e = np.unique(np.sort(e, axis=1), axis=0)
    w = np.linalg.norm(verts[e[:, 0]] - verts[e[:, 1]], axis=1)
    n = len(verts)
    g = coo_matrix((w, (e[:, 0], e[:, 1])), shape=(n, n)).tocsr()
    return g + g.T, e


# ---------------------------------------------------------------- mouth

def mouth_area(points):
    """The lips and a margin around them, front of the face only."""
    x, y, z = points.T
    m = B["mouth"]
    return ((np.abs(x) < m["half"] + 1.2) & (np.abs(z - m["z"]) < 2.2)
            & (y < m["y"] + 2.5))


def refine_mouth(verts, faces, attrs, max_len=0.3, rounds=8):
    """Split edges longer than max_len around the mouth, keeping the mesh conforming.

    attrs are per-vertex arrays that new midpoints get by averaging.
    """
    for _ in range(rounds):
        e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
        key = np.sort(e, axis=1)
        mid = (verts[key[:, 0]] + verts[key[:, 1]]) / 2
        long_ = (np.linalg.norm(verts[key[:, 0]] - verts[key[:, 1]], axis=1) > max_len) & mouth_area(mid)
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


def lip_line(verts, faces):
    """Vertex path along the measured lip line, corner to corner."""
    graph, edges = edge_graph(verts, faces)
    x, y, z = verts.T
    m = B["mouth"]
    near = (np.abs(z - lip_z(x)) < 0.6) & (np.abs(x) < m["half"] + 0.3) & (y < m["y"] + 2.0)
    a, b = edges.T
    keep = near[a] & near[b]
    mid = (verts[a] + verts[b]) / 2
    off = np.abs(mid[:, 2] - lip_z(mid[:, 0]))
    cost = np.linalg.norm(verts[a] - verts[b], axis=1) * (1 + 60 * off)
    n = len(verts)
    g = coo_matrix((cost[keep], (a[keep], b[keep])), shape=(n, n)).tocsr()
    g = g + g.T
    cand = np.flatnonzero(near)
    start, end = (cand[np.linalg.norm(verts[cand] - c, axis=1).argmin()] for c in mouth_corners())
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
    hy, hz = B["jaw_hinge"]
    dy, dz = points[:, 1] - hy, points[:, 2] - hz
    out = points.copy()
    out[:, 1] = hy + dy * np.cos(a) - dz * np.sin(a)
    out[:, 2] = hz + dy * np.sin(a) + dz * np.cos(a)
    return out


def mouth_morphs(verts, faces, upper, lower):
    """Position deltas for each of MORPHS on the body mesh."""
    graph, _ = edge_graph(verts, faces)
    d_up = dijkstra(graph, indices=upper[1:-1], min_only=True, limit=40)
    d_low = dijkstra(graph, indices=lower[1:-1], min_only=True, limit=40)
    d_up, d_low = np.minimum(d_up, 99), np.minimum(d_low, 99)   # unreached -> far
    x, y, z = verts.T
    m = B["mouth"]
    chin = B["chin_z"]
    jaw_side = smoothstep(-1.5, 1.5, d_up - d_low)
    jaw_side[lower] = 1
    jaw_side[upper] = 0
    jaw_side[[upper[0], upper[-1]]] = 0.5
    # The chin and lower lip follow the jaw; the neck below the chin does not.
    w_jaw = (jaw_side * smoothstep(chin - 3.0, chin + 0.5, z) * smoothstep(m["half"] + 6, m["half"] + 1, np.abs(x))
             * front_of(y, 6, 12) * smoothstep(m["z"] + 3, m["z"] + 1, z))
    jaw = rotate_jaw(verts) - verts
    jaw *= w_jaw[:, None]
    lift = (1 - jaw_side) * np.exp(-(d_up ** 2) / (2 * 0.6 ** 2)) * smoothstep(m["half"] + 0.6, m["half"] - 1.0, np.abs(x))
    jaw[:, 2] += 0.22 * lift
    corners = mouth_corners()
    face_front = front_of(y, 4, 8)

    def corner_field(radius):
        out = np.zeros(len(verts))
        sides = np.zeros(len(verts))
        for s, c in zip((-1, 1), corners):
            g = np.exp(-np.sum((verts - c) ** 2, 1) / (2 * radius ** 2)) * face_front
            out += g
            sides += s * g
        return out, np.sign(sides)

    g, side = corner_field(1.1)
    smile = np.c_[0.5 * side * g, 0.4 * g, 0.8 * g]
    cheek = np.zeros(len(verts))
    for c in corners:
        cc = c + [np.sign(c[0]) * 1.0, -1.0, 2.0]
        cheek += np.exp(-np.sum((verts - cc) ** 2, 1) / (2 * 1.8 ** 2))
    smile[:, 2] += 0.3 * cheek * face_front
    frown = np.c_[-0.1 * side * g, 0.1 * g, -0.55 * g]

    lips = (np.exp(-((z - lip_z(x)) ** 2) / (2 * 1.1 ** 2)) * smoothstep(m["half"] + 1.1, m["half"] - 1.0, np.abs(x))
            * smoothstep(m["y"] + 3, m["y"], y))
    rnd = np.c_[-0.32 * x * lips, -0.45 * lips * (1 - (x / (m["half"] + 0.3)) ** 2).clip(0), np.zeros(len(verts))]
    return {"jawOpen": jaw, "smile": smile, "frown": frown, "mouthRound": rnd}, w_jaw


def lip_mask(verts):
    """0..1 per vertex: how much of the lip colour each vertex takes.

    A soft lens shape around the lip line: the upper lip reaches `up` cm above
    the line and the lower lip `down` cm below it, both narrowing towards the
    corners. The inside of the lips is included so the colour carries into the
    open mouth.
    """
    x, y, z = verts.T
    m = B["mouth"]
    line = lip_z(x)
    up = z >= line
    half = np.where(up, m["half"], m["half"] - 0.1)    # half width of each lip
    across = np.clip(1 - (x / half) ** 2, 0, 1)
    reach = np.where(up, m["up"] * np.sqrt(across), m["down"] * across ** 0.7)
    t = np.abs(z - line) / np.maximum(reach, 1e-3)
    mask = 1 - smoothstep(0.75, 1.15, t)
    mask *= smoothstep(half, half - 0.45, np.abs(x))    # soft corners
    mask *= smoothstep(m["y"] + 3.2, m["y"] + 2.2, y)   # front of the face only
    return mask.astype(np.float32)


# ---------------------------------------------------------------- face shape

# Face shape keys: name -> menu label. Each is a smooth weighted push on the
# face around the body's landmarks.
FACE_SHAPES = {
    "noseWidth": "Nose width", "noseLength": "Nose length", "noseBridge": "Nose bridge",
    "lipsFull": "Lip fullness", "lipsWidth": "Lip width",
    "foreheadFull": "Forehead fullness", "foreheadSlope": "Forehead slope",
    "chinLength": "Chin length", "chinForward": "Chin forward", "chinWidth": "Chin width",
    "jawWidth": "Jaw width", "jawSquare": "Jaw angle",
    "eyeSize": "Eye size", "eyeSpacing": "Eye spacing", "eyeHeight": "Eye height", "eyeTilt": "Eye tilt",
}


def _blob(verts, centre, sigma):
    d = (verts - np.asarray(centre)) / np.asarray(sigma)
    return np.exp(-0.5 * np.sum(d * d, axis=1))


def face_shapes(verts):
    """Position deltas (cm) for each of FACE_SHAPES at full strength (slider 1)."""
    x, y, z = verts.T
    n = len(verts)
    ny, nz = B["nose_tip"]
    m, chin_z, eye = B["mouth"], B["chin_z"], B["eye"]
    front = front_of(y, 8, 16)                   # the face, not the back of the head
    neck_guard = smoothstep(chin_z - 4.5, chin_z - 2.0, z)
    out = {}

    def delta(dx=0.0, dy=0.0, dz=0.0):
        return np.c_[np.broadcast_to(dx, n), np.broadcast_to(dy, n), np.broadcast_to(dz, n)].astype(float)

    # Nose: the whole nose, its tip, and the bridge between the eyes.
    nw = B["nose_width"]
    nose = _blob(verts, (0, ny + 1.1, nz), (nw * 1.25, 3.0, 2.6)) * front
    tip = _blob(verts, (0, ny, nz + 0.3), (nw, 2.0, 1.7)) * front
    bridge_z = (nz + eye["z"]) / 2 + 0.5
    bridge = _blob(verts, (0, ny + 2.4, bridge_z), (1.3, 2.2, 2.4)) * front
    out["noseWidth"] = delta(dx=0.4 * x * nose)
    out["noseLength"] = delta(dy=-0.5 * tip, dz=-1.1 * tip)
    out["noseBridge"] = delta(dy=-0.9 * bridge)

    # Lips: the lip area, pushed out and apart (fuller) or stretched sideways.
    lips = lip_mask(verts).astype(float)
    # Spread away from the lip line smoothly (zero on the line, so the lips stay closed).
    out["lipsFull"] = delta(dy=-0.5 * lips, dz=0.3 * np.clip((z - lip_z(x)) / 1.2, -1, 1) * lips)
    out["lipsWidth"] = delta(dx=0.16 * x * lips)

    # Forehead: between the brows and the top of the head, front only.
    brow, top = B["brow_z"], B["top_z"]
    mid = (brow + top) / 2
    fore = (smoothstep(brow, brow + 6, z) * smoothstep(top - 0.5, top - 8, z)
            * smoothstep(9.5, 3, np.abs(x)) * front)
    out["foreheadFull"] = delta(dy=-0.9 * fore)
    out["foreheadSlope"] = delta(dy=0.12 * (z - mid) * fore)

    # Chin and jaw.
    chin = (smoothstep(chin_z + 2.0, chin_z - 1.0, z) * smoothstep(5.0, 1.5, np.abs(x))
            * front_of(y, 10, 14) * neck_guard)
    out["chinLength"] = delta(dz=-0.9 * chin)
    out["chinForward"] = delta(dy=-1.0 * chin)
    out["chinWidth"] = delta(dx=0.22 * x * chin)
    jx, jy, jz = B["jaw_corner"]
    jaw = (smoothstep(m["z"] + 1, m["z"] - 3, z) * smoothstep(2.5, 5.0, np.abs(x))
           * smoothstep(jy + 6, jy + 2, y) * neck_guard)
    out["jawWidth"] = delta(dx=0.16 * x * jaw)
    corner = sum(_blob(verts, (s_ * jx, jy, jz), (2.0, 3.0, 2.0)) for s_ in (-1, 1)) * neck_guard
    out["jawSquare"] = delta(dx=0.7 * np.sign(x) * corner, dz=-0.3 * corner)

    # Eyes: the eye sockets.
    ex, ez = eye["x"], eye["z"]
    sx, sz = eye["w"] * 0.55, eye["h"] * 0.6
    socket = sum(_blob(verts, (s_ * ex, 0.0, ez), (sx, 99, sz)) for s_ in (-1, 1)) * front
    socket *= smoothstep(1.2, 2.2, np.abs(x))   # leave the bridge of the nose alone
    cx = np.sign(x) * ex
    out["eyeSize"] = delta(dx=0.18 * (x - cx) * socket, dz=0.18 * (z - ez) * socket)
    out["eyeSpacing"] = delta(dx=0.9 * np.sign(x) * socket)
    out["eyeHeight"] = delta(dz=0.9 * socket)
    out["eyeTilt"] = delta(dz=0.15 * (np.abs(x) - ex) * socket)
    return out


# ---------------------------------------------------------------- teeth and tongue

def _arch(z0, z1, inset, n=24):
    """A curved band of teeth following the lip line, set `inset` cm behind it."""
    h = B["mouth"]["half"] * 0.65
    xs = np.linspace(-h, h, n)
    ys = lip_y(xs) + inset
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
    m = B["mouth"]
    k = m["half"] / 2.85
    pts = pts * [1.4 * k, 1.4 * k, 0.35] + [0, m["y"] + 3.0, m["z"] - 0.8]
    faces = []
    for i in range(n - 1):
        for j in range(n):
            a, b = i * n + j, i * n + (j + 1) % n
            c, d = (i + 1) * n + (j + 1) % n, (i + 1) * n + j
            faces += [(a, d, c), (a, c, b)]
    return pts, np.array(faces)


def mouth_parts():
    """(name, verts, faces, jaw_weight) for the upper teeth, lower teeth and tongue."""
    z = B["mouth"]["z"]
    upper_v, upper_f = _arch(z + 0.05, z + 0.6, 1.0)
    lower_v, lower_f = _arch(z - 0.6, z - 0.1, 1.1)
    tongue_v, tongue_f = _tongue()
    return [("UpperTeeth", upper_v, upper_f, 0.0),
            ("LowerTeeth", lower_v, lower_f, 1.0),
            ("Tongue", tongue_v, tongue_f, 1.0)]
