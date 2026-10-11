"""Rig-only copies of the characters, for animating in Blender/Maya.

Keeps the skinned body, clothes, skeleton (53 bones) and face shape keys;
drops the 178 game clips (keep_clips=True keeps them) and any buffer data
nothing else uses.

    python3 tools/export_rig.py            -> export/<body>_rig.glb
"""
import json
import struct
import sys
from pathlib import Path

from glb import read_glb

ROOT = Path(__file__).resolve().parent.parent


def strip(src, dst, keep_clips=False, skin_map=None):
    gltf, binary = read_glb(src)
    if not keep_clips:
        gltf.pop("animations", None)
    # Accessors still referenced by meshes and skins.
    used = set()
    for mesh in gltf["meshes"]:
        for p in mesh["primitives"]:
            used.update(p["attributes"].values())
            if "indices" in p:
                used.add(p["indices"])
            for t in p.get("targets", []):
                used.update(t.values())
    for skin in gltf.get("skins", []):
        if "inverseBindMatrices" in skin:
            used.add(skin["inverseBindMatrices"])
    for anim in gltf.get("animations", []):
        for s in anim["samplers"]:
            used.update((s["input"], s["output"]))
    acc_map = {old: new for new, old in enumerate(sorted(used))}
    accessors = [gltf["accessors"][i] for i in sorted(used)]
    views_used = set()
    for a in accessors:
        if "bufferView" in a:
            views_used.add(a["bufferView"])
        sp = a.get("sparse")
        if sp:
            views_used.update((sp["indices"]["bufferView"], sp["values"]["bufferView"]))
    for img in gltf.get("images", []):
        if "bufferView" in img:
            views_used.add(img["bufferView"])
    blob = bytearray()
    view_map, views = {}, []
    for old in sorted(views_used):
        v = dict(gltf["bufferViews"][old])
        start = v.get("byteOffset", 0)
        blob.extend(b"\0" * (-len(blob) % 4))
        v["byteOffset"] = len(blob)
        blob.extend(binary[start:start + v["byteLength"]])
        view_map[old] = len(views)
        views.append(v)
    for a in accessors:
        if "bufferView" in a:
            a["bufferView"] = view_map[a["bufferView"]]
        sp = a.get("sparse")
        if sp:
            sp["indices"]["bufferView"] = view_map[sp["indices"]["bufferView"]]
            sp["values"]["bufferView"] = view_map[sp["values"]["bufferView"]]
    for img in gltf.get("images", []):
        if "bufferView" in img:
            img["bufferView"] = view_map[img["bufferView"]]
    remap = lambda i: acc_map[i]
    for mesh in gltf["meshes"]:
        for p in mesh["primitives"]:
            p["attributes"] = {k: remap(v) for k, v in p["attributes"].items()}
            if "indices" in p:
                p["indices"] = remap(p["indices"])
            if "targets" in p:
                p["targets"] = [{k: remap(v) for k, v in t.items()} for t in p["targets"]]
    for skin in gltf.get("skins", []):
        if "inverseBindMatrices" in skin:
            skin["inverseBindMatrices"] = remap(skin["inverseBindMatrices"])
    for anim in gltf.get("animations", []):
        for s in anim["samplers"]:
            s["input"], s["output"] = remap(s["input"]), remap(s["output"])
    gltf["accessors"], gltf["bufferViews"] = accessors, views
    if skin_map:
        # The painted skin (the game paints it in a shader; here it is a plain texture).
        blob.extend(b"\0" * (-len(blob) % 4))
        raw = Path(skin_map).read_bytes()
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(raw)})
        blob.extend(raw)
        gltf["images"] = [{"bufferView": len(views) - 1, "mimeType": "image/jpeg", "name": "skin_color"}]
        gltf["samplers"] = [{"magFilter": 9729, "minFilter": 9987}]
        gltf["textures"] = [{"source": 0, "sampler": 0}]
        skin = next(m for m in gltf["materials"] if m["name"] == "Skin")
        skin["pbrMetallicRoughness"]["baseColorTexture"] = {"index": 0}
        skin["pbrMetallicRoughness"]["baseColorFactor"] = [1, 1, 1, 1]
    blob.extend(b"\0" * (-len(blob) % 4))
    gltf["buffers"] = [{"byteLength": len(blob)}]
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * (-len(js) % 4)
    out = struct.pack("<III", 0x46546C67, 2, 28 + len(js) + len(blob))
    out += struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(blob), 0x004E4942) + blob
    Path(dst).write_bytes(out)


if __name__ == "__main__":
    keep = "--clips" in sys.argv
    (ROOT / "export").mkdir(exist_ok=True)
    for body in ("female", "male"):
        dst = ROOT / "export" / f"character_{body}_rig{'_clips' if keep else ''}.glb"
        strip(ROOT / "models" / f"character_{body}.glb", dst, keep, ROOT / "models" / "skin" / f"{body}_color.jpg")
        print(dst, dst.stat().st_size)
