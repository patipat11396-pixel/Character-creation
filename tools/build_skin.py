"""Skin textures for the menu from the painted bodies.

The painted bodies (models/source/<f|m>_painted.glb) wear a grey bodysuit;
only the head, arms, hands and feet show painted skin. For each body this:

* paints everything below the chin (the suit and the bare skin) in one flat
  skin colour measured on the painted face, fading into the painted head
  over the neck, with a flat normal map and skin roughness there,
* grows every UV island a few texels outwards so filtering never pulls in
  the background (that showed as a thin light line across the face),
* writes models/skin/<body>_color.jpg, _normal.jpg and _rough.jpg (glTF
  metallic-roughness: G roughness, B metal) at SIZE x SIZE, and
  models/skin/<body>.json with the reference skin colour (the menu tints
  the texture by skin tone / reference).

    python3 tools/build_skin.py [female|male ...]     (default: every body)

Needs opencv-python-headless besides the other tools' packages.
"""
import io
import json
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

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
    return covered, pos


def grow(img, covered):
    """Fill every uncovered texel with the nearest covered one."""
    _, labels = cv2.distanceTransformWithLabels((~covered).astype(np.uint8), cv2.DIST_L2, 5,
                                                labelType=cv2.DIST_LABEL_PIXEL)
    ys, xs = np.nonzero(covered)
    lut = np.zeros((labels.max() + 1, 2), np.int64)
    lut[labels[ys, xs]] = np.c_[ys, xs]
    src = lut[labels]
    return img[src[..., 0], src[..., 1]]


def save(img, path, quality=90):
    Image.fromarray(np.clip(img * 255 + 0.5, 0, 255).astype(np.uint8)).save(path, quality=quality)


def build(key):
    body = BODIES[key]
    gltf, binary = read_glb(ROOT / body["src"])
    src = read_accessor(gltf, binary, gltf["meshes"][0]["primitives"][0]["attributes"]["POSITION"])
    pv, uv, pf, pg, pb = load_painted(ROOT / body["painted"], src)
    normal, color, rough = images(pg, pb)
    covered, pos = rasterize(pv, uv, pf)
    x, z = pos[..., 0], pos[..., 2]

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

    # Below the chin everything becomes the measured skin colour, flat (the
    # scene's lights do the shading): baked shade differs from one UV island
    # to the next and shows as lines along their borders. It fades into the
    # painted head over the neck. The normal map and roughness go flat there too.
    w = (smoothstep(body["chin_z"] - 0.5, body["chin_z"] - 4.0, z) * covered)[..., None].astype(np.float32)
    color = color * (1 - w) + skin_rgb * w
    normal = normal * (1 - w) + np.array([0.5, 0.5, 1.0], np.float32) * w
    rough = rough * (1 - w) + skin_rough * w

    # Island borders hold texels blended with the painting's background; drop
    # one texel ring and grow the islands back out from their insides.
    covered = cv2.erode(covered.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    out = ROOT / "models/skin"
    out.mkdir(parents=True, exist_ok=True)
    save(grow(color, covered), out / f"{key}_color.jpg")
    save(grow(normal, covered), out / f"{key}_normal.jpg", 92)
    save(grow(rough, covered), out / f"{key}_rough.jpg", 85)
    (out / f"{key}.json").write_text(json.dumps({"reference": "#%02x%02x%02x" % tuple(np.round(skin_rgb * 255).astype(int))}) + "\n")
    print(f"wrote models/skin/{key}_*.jpg and {key}.json")


if __name__ == "__main__":
    for key in sys.argv[1:] or BODIES:
        build(key)
