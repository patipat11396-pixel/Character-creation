"""Skin textures for the menu from the painted bodies.

The painted bodies (models/source/<f|m>_painted.glb) wear a grey bodysuit;
only the head, arms, hands and feet show painted skin. For each body this:

* paints everything below the chin (the suit and the bare skin) in one flat
  skin colour measured on the painted face, fading into the painted head
  over the neck, with skin roughness there,
* grows every UV island a few texels outwards so filtering never pulls in
  the background (that showed as a thin light line across the face),
* leaves the painted normal map out: its tangent frames break at every UV
  seam, which lit up as a line across the eyes,
* lifts the painted brows off the skin into their own image so the menu can
  move, resize, recolour and thicken them,
* marks the irises and the painted lips in a feature mask (red: iris,
  green: lips, blue: the whole painted eye, which skin tones leave alone)
  for the menu's eye and lip colours,
* writes models/skin/<body>_color.jpg and _rough.jpg (glTF
  metallic-roughness: G roughness, B metal) at SIZE x SIZE, _mask.png,
  _brow.png, and models/skin/<body>.json with the reference skin colour
  (the menu tints the texture by skin tone / reference) and the brow box.

    python3 tools/build_skin.py [female|male ...]     (default: every body)

Needs opencv-python-headless besides the other tools' packages.
"""
import io
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import trimesh
from PIL import Image

import face as features
from bodies import BODIES
from glb import read_accessor, read_glb
from skin import load_painted

ROOT = Path(__file__).resolve().parent.parent
SIZE = 4096


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def images(gltf, binary):
    """The painted material's (normal, color, metallic-roughness) images as float RGB."""
    mat = gltf["materials"][0]
    order = [mat["normalTexture"]["index"], mat["pbrMetallicRoughness"]["baseColorTexture"]["index"],
             mat["pbrMetallicRoughness"]["metallicRoughnessTexture"]["index"]]
    out = []
    for t in order:
        view = gltf["bufferViews"][gltf["images"][gltf["textures"][t]["source"]]["bufferView"]]
        start = view.get("byteOffset", 0)
        img = Image.open(io.BytesIO(binary[start:start + view["byteLength"]])).convert("RGB")
        out.append(np.asarray(img.resize((SIZE, SIZE), Image.LANCZOS), np.float32) / 255)
    return out


def rasterize(pv, uv, pf):
    """Per texel: covered?, mesh-space position. UV v runs down the image (glTF)."""
    px = np.c_[uv[:, 0] * SIZE - 0.5, uv[:, 1] * SIZE - 0.5]
    tri_id = np.zeros((SIZE, SIZE, 3), np.uint8)
    for i, tri in enumerate(pf):
        k = i + 1
        cv2.fillPoly(tri_id, [np.round(px[tri] * 16).astype(np.int32)], (k & 255, (k >> 8) & 255, k >> 16),
                     lineType=cv2.LINE_8, shift=4)
    ids = tri_id[..., 0].astype(np.int64) | (tri_id[..., 1].astype(np.int64) << 8) | (tri_id[..., 2].astype(np.int64) << 16)
    covered = ids > 0
    t = ids[covered] - 1
    ys, xs = np.nonzero(covered)
    a, b, c = (px[pf[t, k]] for k in range(3))
    p = np.c_[xs, ys].astype(float)
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
    d20, d21 = (v2 * v0).sum(1), (v2 * v1).sum(1)
    den = np.where(np.abs(d00 * d11 - d01 * d01) < 1e-12, 1e-12, d00 * d11 - d01 * d01)
    w1 = (d11 * d20 - d01 * d21) / den
    w2 = (d00 * d21 - d01 * d20) / den
    w0 = 1 - w1 - w2
    pos = np.zeros((SIZE, SIZE, 3), np.float32)
    pos[covered] = w0[:, None] * pv[pf[t, 0]] + w1[:, None] * pv[pf[t, 1]] + w2[:, None] * pv[pf[t, 2]]
    fn = np.cross(pv[pf[:, 1]] - pv[pf[:, 0]], pv[pf[:, 2]] - pv[pf[:, 0]])
    fn /= np.linalg.norm(fn, axis=1, keepdims=True) + 1e-12
    normal = np.zeros((SIZE, SIZE, 3), np.float32)
    normal[covered] = fn[t]
    return covered, pos, normal


def grow(img, covered):
    """Fill every uncovered texel with the nearest covered one."""
    _, labels = cv2.distanceTransformWithLabels((~covered).astype(np.uint8), cv2.DIST_L2, 5,
                                                labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(covered)
    lut = np.zeros((labels.max() + 1, 2), np.int64)
    lut[labels[ys, xs]] = np.c_[ys, xs]
    src = lut[labels]
    return img[src[..., 0], src[..., 1]]


def eye_frames(body):
    """(side, iris centre x, opening centre x) for both eyes; side +1 is the left eye."""
    i, o = body["iris"], body.get("eye_repaint", {}).get("opening", body["iris"])
    return [(s, s * i["x"], s * o["x"]) for s in (1, -1)]


def iris_mask(color, covered, pos, body):
    """1 on the coloured part of each iris (not the white, the pupil or the lashes)."""
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    i = body["iris"]
    hsv = cv2.cvtColor(color, cv2.COLOR_RGB2HSV)
    coloured = smoothstep(0.12, 0.25, hsv[..., 1]) * smoothstep(0.1, 0.22, hsv[..., 2])
    out = np.zeros(z.shape, np.float32)
    front = covered & (y < body["nose_tip"][0] + 8)
    for _, ix, _ in eye_frames(body):
        r = np.hypot((x - ix) / i["rx"], (z - i["z"]) / i["rz"])
        out = np.maximum(out, smoothstep(1.05, 0.9, r) * front * coloured)
    return out


def eye_area(color, covered, pos, iris, body):
    """1 on the painted eyes (whites, lashes, irises), which skin tones leave alone."""
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    e = body["eye"]
    hsv = cv2.cvtColor(color, cv2.COLOR_RGB2HSV)
    eye_like = np.maximum.reduce([smoothstep(0.28, 0.14, hsv[..., 1]) * smoothstep(0.22, 0.38, hsv[..., 2]),  # white, grey
                                  smoothstep(0.4, 0.25, hsv[..., 2]),                                       # dark
                                  iris])
    if "eye_repaint" in body:                  # the repainted opening, with its lash line
        o = body["eye_repaint"]["opening"]
        cx, cz, ax, az = o["x"], o["z"], o["a"] + 0.4, o["b"] + 0.7
    else:
        cx, cz, ax, az = e["x"], e["z"], e["w"] / 2 + 0.3, e["h"] / 2 + 0.3
    q = np.hypot((np.abs(x) - cx) / ax, (z - cz) / az)
    # Grown a few texels so the edge where the eye blends into the skin is included.
    eye_like = cv2.dilate(eye_like.astype(np.float32), np.ones((7, 7), np.uint8))
    out = smoothstep(1.0, 0.9, q) * covered * (y < body["nose_tip"][0] + 8) * eye_like
    return cv2.GaussianBlur(out.astype(np.float32), (0, 0), 1.0)


def lip_mask(color, covered, pos, skin_rgb, body):
    """1 on the painted lips: texels redder than the skin around the mouth."""
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    m = body["mouth"]
    box = covered & (np.abs(x) < m["half"] + 0.7) & (np.abs(z - features.lip_z(x)) < 2.0) & (y < m["y"] + 2.5)
    redness = (color[..., 0] - color[..., 1]) - (skin_rgb[0] - skin_rgb[1])
    return (smoothstep(0.03, 0.1, redness) * box).astype(np.float32)


def repaint_eyes(color, covered, pos, nrm, body):
    """Paint new eyes over a painting whose upper half does not match the lower.

    Below `seam_z` the painted eye is right; above it the iris is shifted and
    the white turns yellow. Inside each eye opening (an ellipse) this paints
    the white (colour from the lower half, shaded under the upper lid), an
    iris that is round and continuous (its colour by distance from the
    centre, averaged over the lower half), two highlights and a lash shadow.
    """
    r = body["eye_repaint"]
    o, seam, sm = r["opening"], r["seam_z"], r["sample"]
    i = body["iris"]
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    front = covered & (y < body["nose_tip"][0] + 8) & (nrm[..., 1] < -0.15)
    hsv = cv2.cvtColor(color, cv2.COLOR_RGB2HSV)
    out = color.copy()
    for side, ix, ox in eye_frames(body):
        q = np.hypot((x - ox) / o["a"], (z - o["z"]) / o["b"])
        inside = front & (q < 1.15)
        rr = np.hypot(x - ix, z - i["z"]) / i["rx"]
        # Colours by distance from the centre of the painted iris, lower half.
        rs = np.hypot(x - side * sm["x"], z - sm["z"]) / sm["r"]
        lower = front & (np.hypot((x - side * sm["x"]) / (sm["r"] * 2), (z - sm["z"]) / (sm["r"] * 2)) < 1) & (z < seam - 0.1)
        white = np.median(color[lower & (hsv[..., 1] < 0.15) & (hsv[..., 2] > 0.75) & (rs > 1.1)], 0)
        bins = np.linspace(0, 1.05, 22)
        prof = []
        for a, b in zip(bins[:-1], bins[1:]):
            sel = lower & (rs >= a) & (rs < b)
            prof.append(np.median(color[sel], 0) if sel.sum() > 5 else (prof[-1] if prof else np.zeros(3)))
        prof = np.array(prof)
        centres = (bins[:-1] + bins[1:]) / 2
        iris = np.stack([np.interp(rr, centres, prof[:, k]) for k in range(3)], -1)
        up = np.clip((z - o["z"]) / o["b"], -1, 1)
        # Round the white: shade under the upper lid and towards the corners.
        sclera = white * ((1 - 0.3 * smoothstep(0.1, 1.0, up)) * (1 - 0.22 * smoothstep(0.55, 1.0, q)))[..., None]
        eye = np.where((rr < 1.0)[..., None], iris, sclera)
        edge = smoothstep(1.0, 0.94, rr)[..., None]
        eye = iris * edge + sclera * (1 - edge)
        for dx, dz, rad, k in ((-0.32, 0.12, 0.15, 0.9), (0.3, -0.38, 0.06, 0.7)):
            d = np.hypot(x - (ix + side * dx * i["rx"]), z - (i["z"] + dz * i["rx"])) / (rad * i["rx"])
            eye = eye + (1 - eye) * (k * smoothstep(1.0, 0.6, d))[..., None]
        eye = eye * (1 - 0.7 * smoothstep(0.4, 0.95, up))[..., None]           # lash shadow
        # The painted eye reaches past the new opening: paint skin there first.
        pe = r["painted"]
        q_old = np.hypot((x - side * pe["x"]) / pe["a"], (z - pe["z"]) / pe["b"])
        under = front & (np.abs(x - side * pe["x"]) < pe["a"] + 0.5) & (z < pe["z"] - pe["b"]) & (z > pe["z"] - pe["b"] - 0.8)
        skin_near = np.median(color[under], 0)
        sw = (smoothstep(1.08, 0.95, q_old) * front)[..., None]
        out = out * (1 - sw) + skin_near * sw
        wgt = (smoothstep(1.05, 0.95, q) * inside)[..., None]
        out = out * (1 - wgt) + eye * wgt
        # Upper lash line: a dark band over the top of the opening, which also
        # covers the painted (mismatched) lid above it.
        q_lid = np.hypot((x - ox) / (o["a"] + 0.15), (z - o["z"]) / (o["b"] + 0.5))
        lash = front & (q_lid < 1.08) & (q > 0.9) & (z > o["z"] + 0.2 * o["b"])
        dark = np.array([0.16, 0.1, 0.08], np.float32)
        lw = (smoothstep(1.08, 0.96, q_lid) * smoothstep(0.9, 1.0, q) * lash
              * smoothstep(o["z"] + 0.2 * o["b"], o["z"] + 0.6 * o["b"], z))[..., None]
        out = out * (1 - lw) + dark * lw
        # The skin around the eye also steps at the seam: blend a band across
        # it towards the skin just below, column by column.
        reach = o["a"] + 2.5
        band = front & (np.abs(x - ox) < reach) & (np.abs(z - seam) < 0.7) & (q >= 1.0)
        below = front & (np.abs(x - ox) < reach) & (z < seam - 0.3) & (z > seam - 1.0) & (q >= 1.0)
        edges = np.linspace(ox - reach, ox + reach, 33)
        idx = np.digitize(x, edges)
        for k in range(1, len(edges)):
            src = below & (idx == k)
            dst = band & (idx == k)
            if src.sum() > 5 and dst.any():
                w = smoothstep(0.7, 0.0, np.abs(z[dst] - seam))[:, None]
                out[dst] = out[dst] * (1 - w) + np.median(color[src], 0) * w
    return out.astype(np.float32)


BROW_PPC = 60          # brow image pixels per cm


def bilinear(img, col, row):
    """img sampled at fractional (col, row) pixel positions, clamped at the edges."""
    h, w = img.shape[:2]
    c0 = np.clip(np.floor(col).astype(int), 0, w - 2)
    r0 = np.clip(np.floor(row).astype(int), 0, h - 2)
    fc = np.clip(col - c0, 0, 1)[:, None]
    fr = np.clip(row - r0, 0, 1)[:, None]
    flat = img.reshape(h, w, -1)
    top = flat[r0, c0] * (1 - fc) + flat[r0, c0 + 1] * fc
    bottom = flat[r0 + 1, c0] * (1 - fc) + flat[r0 + 1, c0 + 1] * fc
    return top * (1 - fr) + bottom * fr


def front_view(color, pv, uv, pf, x0, x1, z0, z1, y_from, ppc):
    """The painted surface seen straight from the front over x0..x1, z0..z1:
    (rgb image, hit mask). Row 0 is the top (z1)."""
    xs = np.arange(x0, x1, 1 / ppc)
    zs = np.arange(z1, z0, -1 / ppc)
    gx, gz = np.meshgrid(xs, zs)
    origins = np.c_[gx.ravel(), np.full(gx.size, y_from), gz.ravel()]
    mesh = trimesh.Trimesh(pv, pf, process=False)
    loc, ray, tri = mesh.ray.intersects_location(origins, np.tile([0, 1.0, 0], (len(origins), 1)),
                                                 multiple_hits=False)
    bary = trimesh.triangles.points_to_barycentric(pv[pf[tri]], loc)
    u = np.einsum("ij,ijk->ik", bary, uv[pf[tri]])
    img = np.zeros((len(origins), 3), np.float32)
    img[ray] = bilinear(color, u[:, 0] * SIZE - 0.5, u[:, 1] * SIZE - 0.5)
    hit = np.zeros(len(origins), bool)
    hit[ray] = True
    return img.reshape(len(zs), len(xs), 3), hit.reshape(len(zs), len(xs))


def brows(color, covered, pos, nrm, pv, uv, pf, skin_rgb, body):
    """Lift the painted brows off the skin.

    Returns (color with the brows painted out, brow image RGBA for the left
    brow). Inside the brow box (body["brow_box"], left side; the right is
    its mirror) the brows are the texels darker than the skin around them.
    They are painted out with the forehead filled in from around them
    (inpainted on a front view), and the menu draws the brow image back on
    where the sliders put it.
    """
    x0, z0, x1, z1 = body["brow_box"]
    y_from = body["nose_tip"][0] - 20
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    out = color.copy()
    for side in (1, -1):
        # Front view of this side's box; columns run outwards from the middle.
        view, hit = front_view(color, pv, uv, pf, x0, x1, z0, z1, y_from, BROW_PPC) if side > 0 else \
            [a[:, ::-1] for a in front_view(color, pv, uv, pf, -x1, -x0, z0, z1, y_from, BROW_PPC)]
        lum = view @ np.array([0.299, 0.587, 0.114], np.float32)
        around = cv2.GaussianBlur(np.where(hit, lum, 0).astype(np.float32), (0, 0), 25)
        around /= cv2.GaussianBlur(hit.astype(np.float32), (0, 0), 25) + 1e-6
        alpha = smoothstep(0.025, 0.12, around - lum) * hit
        alpha = cv2.GaussianBlur(alpha.astype(np.float32), (0, 0), 1.0)
        if side > 0:
            # The brow image (left brow; the menu mirrors it): only the brow
            # itself, the biggest dark shape, not the stray strokes near it.
            keep_alpha = alpha
            n, labels, stats, _ = cv2.connectedComponentsWithStats((alpha > 0.08).astype(np.uint8))
            if n > 1:
                main = 1 + np.argmax(stats[1:, cv2.CC_STAT_AREA])
                keep = cv2.dilate((labels == main).astype(np.uint8), np.ones((9, 9), np.uint8)).astype(bool)
                keep_alpha = alpha * keep
            brow = np.dstack([view, keep_alpha])
        # Forehead without any of the marks: inpaint them on the front view.
        hole = (cv2.dilate((alpha > 0.01).astype(np.uint8), np.ones((17, 17), np.uint8)) > 0).astype(np.uint8)
        clean = cv2.inpaint(np.clip(view * 255, 0, 255).astype(np.uint8), hole, 12, cv2.INPAINT_TELEA).astype(np.float32) / 255
        fill = np.maximum(hole, cv2.GaussianBlur(hole.astype(np.float32), (0, 0), 4))
        # Back onto the texture: texels on the front of the face in this box.
        sel = covered & (nrm[..., 1] < -0.2) & (y < body["nose_tip"][0] + 8) & (z > z0) & (z < z1)
        sel &= (x * side > x0) & (x * side < x1)
        col = (np.abs(x[sel]) - x0) * BROW_PPC
        row = (z1 - z[sel]) * BROW_PPC
        out[sel] = out[sel] * (1 - bilinear(fill, col, row)) + bilinear(clean, col, row) * bilinear(fill, col, row)
    return out, brow


def smooth_bands(color, covered, pos, nrm, pv, uv, pf, body):
    """Blend across painted steps (body["seam_bands"]): on a front view of
    each band, blur up and down only, and write it back fading to nothing at
    the band's top and bottom."""
    out = color.copy()
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    for x0, x1, zc, half in body.get("seam_bands", []):
        for side in (1, -1):
            lo, hi = (x0, x1) if side > 0 else (-x1, -x0)
            view, hit = front_view(color, pv, uv, pf, lo, hi, zc - 2 * half, zc + 2 * half,
                                   body["nose_tip"][0] - 20, BROW_PPC)
            blur = cv2.GaussianBlur(view, (1, 0), sigmaX=0.1, sigmaY=half * BROW_PPC * 0.6)
            sel = covered & (nrm[..., 1] < -0.2) & (y < body["nose_tip"][0] + 8)
            sel &= (x > lo) & (x < hi) & (np.abs(z - zc) < half)
            col = (x[sel] - lo) * BROW_PPC
            row = (zc + 2 * half - z[sel]) * BROW_PPC
            w = smoothstep(half, 0.3 * half, np.abs(z[sel] - zc))[:, None]
            w *= smoothstep(0, 0.5, np.minimum(x[sel] - lo, hi - x[sel]))[:, None]
            out[sel] = out[sel] * (1 - w) + bilinear(blur, col, row) * w
    return out


def paint_out(color, covered, pos, nrm, pv, uv, pf, eye, body):
    """Paint out thin painted strokes in body["paint_out"] boxes (left side,
    mirrored): texels darker than their close surroundings, not on the eye."""
    out = color.copy()
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    for x0, z0, x1, z1 in body.get("paint_out", []):
        for side in (1, -1):
            lo, hi = (x0, x1) if side > 0 else (-x1, -x0)
            view, hit = front_view(color, pv, uv, pf, lo, hi, z0, z1, body["nose_tip"][0] - 20, BROW_PPC)
            lum = view @ np.array([0.299, 0.587, 0.114], np.float32)
            around = cv2.GaussianBlur(np.where(hit, lum, 0).astype(np.float32), (0, 0), 8)
            around /= cv2.GaussianBlur(hit.astype(np.float32), (0, 0), 8) + 1e-6
            line = ((around - lum) > 0.012).astype(np.uint8)
            hole = cv2.dilate(line, np.ones((5, 5), np.uint8))
            clean = cv2.inpaint(np.clip(view * 255, 0, 255).astype(np.uint8), hole, 6,
                                cv2.INPAINT_TELEA).astype(np.float32) / 255
            fill = cv2.GaussianBlur(hole.astype(np.float32), (0, 0), 1.5)
            sel = covered & (nrm[..., 1] < 0.1) & (y < body["nose_tip"][0] + 8)
            sel &= (x > lo) & (x < hi) & (z > z0) & (z < z1) & (eye < 0.2)
            col, row = (x[sel] - lo) * BROW_PPC, (z1 - z[sel]) * BROW_PPC
            w = bilinear(fill, col, row)
            out[sel] = out[sel] * (1 - w) + bilinear(clean, col, row) * w
    return out


def blend_seams(color, pv, uv, pf, body, radius=4):
    """Match the colour on both sides of every UV seam on the head.

    The painting's islands do not quite agree where they meet, which showed
    as thin lines across the face. Along each seam edge both sides are
    sampled, and each side is pulled towards their average, fading over
    `radius` texels into its island.
    """
    _, pid = np.unique(np.round(pv, 4), axis=0, return_inverse=True)
    pid = pid.ravel()
    edges = {}
    for f in pf:
        for a, b in ((0, 1), (1, 2), (2, 0)):
            key = (pid[f[a]], pid[f[b]]) if pid[f[a]] < pid[f[b]] else (pid[f[b]], pid[f[a]])
            edges.setdefault(key, []).append((f[a], f[b]) if pid[f[a]] < pid[f[b]] else (f[b], f[a]))
    acc = np.zeros_like(color)
    wsum = np.zeros(color.shape[:2], np.float32)
    head = body["chin_z"] - 1
    for pair in edges.values():
        if len(pair) != 2:
            continue
        (a1, b1), (a2, b2) = pair
        if np.allclose(uv[a1], uv[a2]) and np.allclose(uv[b1], uv[b2]):
            continue
        if min(pv[a1, 2], pv[b1, 2]) < head:
            continue
        p1a, p1b, p2a, p2b = (uv[i] * SIZE - 0.5 for i in (a1, b1, a2, b2))
        n = int(max(np.linalg.norm(p1b - p1a), np.linalg.norm(p2b - p2a)) * 2) + 2
        t = np.linspace(0, 1, n)[:, None]
        s1, s2 = p1a + (p1b - p1a) * t, p2a + (p2b - p2a) * t
        c1, c2 = bilinear(color, s1[:, 0], s1[:, 1]), bilinear(color, s2[:, 0], s2[:, 1])
        avg = (c1 + c2) / 2
        for pts, c in ((s1, c1), (s2, c2)):
            for dx in range(-radius, radius + 1):
                for dy in range(-radius, radius + 1):
                    w = max(0.0, 1 - np.hypot(dx, dy) / (radius + 0.5))
                    if w <= 0:
                        continue
                    cx = np.clip(np.round(pts[:, 0]).astype(int) + dx, 0, SIZE - 1)
                    cy = np.clip(np.round(pts[:, 1]).astype(int) + dy, 0, SIZE - 1)
                    np.add.at(acc, (cy, cx), w * (avg - c))
                    np.add.at(wsum, (cy, cx), w)
    # Each texel moves by the weighted mean correction of the seams near it.
    move = acc / np.maximum(wsum, 1e-6)[..., None]
    strength = np.clip(wsum, 0, 1)[..., None]
    return color + move * strength


def save(img, path, quality=90):
    Image.fromarray(np.clip(img * 255 + 0.5, 0, 255).astype(np.uint8)).save(path, quality=quality)


def build(key):
    body = BODIES[key]
    gltf, binary = read_glb(ROOT / body["src"])
    src = read_accessor(gltf, binary, gltf["meshes"][0]["primitives"][0]["attributes"]["POSITION"])
    pv, uv, pf, pg, pb = load_painted(ROOT / body["painted"], src)
    _, color, rough = images(pg, pb)
    covered, pos, nrm = rasterize(pv, uv, pf)
    x, y, z = pos[..., 0], pos[..., 1], pos[..., 2]
    features.configure(body)

    hsv = cv2.cvtColor(color, cv2.COLOR_RGB2HSV)       # H 0-360, S and V 0-1
    sat, val = hsv[..., 1], hsv[..., 2]
    suit = covered & (z < body["chin_z"] - 0.5) & (sat < 0.16)
    # Reference skin: the painted face below the brows (the male's suit covers
    # his hands and feet too). Eyes, lips and brows are left out by colour.
    face = covered & (z > body["chin_z"] + 1.5) & (z < body["brow_z"]) & (pos[..., 1] < body["nose_tip"][0] + 6)
    skin = face & (sat > 0.25) & (sat < 0.6) & (val > 0.45)
    skin_rgb = np.median(color[skin], 0)
    skin_rough = np.median(rough[skin], 0)
    print(f"{key}: suit {suit.mean():.1%} of the texture, face skin {np.round(skin_rgb * 255)}")

    # Below the jaw everything becomes the measured skin colour, flat (the
    # scene's lights do the shading): baked shade differs from one UV island
    # to the next and shows as lines along their borders. The jaw line runs
    # from under the chin up to below the ear (2.5 cm under the jaw hinge);
    # the flat colour fades into the painted head just under it, so the neck
    # carries no painted streaks. Roughness goes flat there too.
    hy, hz = body["jaw_hinge"]
    chin_y = body["nose_tip"][0] + 2.0
    jaw_z = body["chin_z"] + (hz - 2.5 - body["chin_z"]) * np.clip((y - chin_y) / (hy - chin_y), 0, 1)
    w = (smoothstep(jaw_z + 0.3, jaw_z - 2.0, z) * covered)[..., None].astype(np.float32)
    color = color * (1 - w) + skin_rgb * w
    rough = rough * (1 - w) + skin_rough * w

    if "eye_repaint" in body:
        color = repaint_eyes(color, covered, pos, nrm, body)
    color, brow = brows(color, covered, pos, nrm, pv, uv, pf, skin_rgb, body)
    color = smooth_bands(color, covered, pos, nrm, pv, uv, pf, body)
    mask = np.zeros((SIZE, SIZE, 3), np.float32)
    mask[..., 0] = iris_mask(color, covered, pos, body)
    mask[..., 1] = lip_mask(color, covered, pos, skin_rgb, body)
    mask[..., 2] = eye_area(color, covered, pos, mask[..., 0], body)

    # Island borders hold texels blended with the painting's background; drop
    # one texel ring and grow the islands back out from their insides.
    covered = cv2.erode(covered.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    out = ROOT / "models/skin"
    out.mkdir(parents=True, exist_ok=True)
    save(grow(color, covered), out / f"{key}_color.jpg")
    save(grow(rough, covered), out / f"{key}_rough.jpg", 85)
    Image.fromarray(np.clip(grow(mask, covered) * 255 + 0.5, 0, 255).astype(np.uint8)).resize(
        (SIZE // 2, SIZE // 2), Image.LANCZOS).save(out / f"{key}_mask.png", optimize=True)
    Image.fromarray(np.clip(brow * 255 + 0.5, 0, 255).astype(np.uint8), "RGBA").save(out / f"{key}_brow.png", optimize=True)
    info = {
        "reference": "#%02x%02x%02x" % tuple(np.round(skin_rgb * 255).astype(int)),
        # The brow image covers this box (left brow; x0, z0, x1, z1 in mesh cm)
        # on the front of the face, which is in front of front_y.
        "browBox": body["brow_box"], "frontY": body["nose_tip"][0] + 8,
    }
    (out / f"{key}.json").write_text(json.dumps(info) + "\n")
    print(f"wrote models/skin/{key}_*.jpg and {key}.json")


if __name__ == "__main__":
    for key in sys.argv[1:] or BODIES:
        build(key)
