"""Minimal GLB reading and writing shared by the model scripts."""
import json
import struct
from pathlib import Path

import numpy as np

COMPONENT = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
CTYPE = {np.dtype(v): k for k, v in COMPONENT.items()}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
TYPE = {1: "SCALAR", 2: "VEC2", 3: "VEC3", 4: "VEC4", 16: "MAT4"}


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


class GlbWriter:
    """Copy a GLB, replacing some accessors' data and appending new ones.

    Accessor indices stay the same, so animations, skins and meshes that are
    not touched keep working without remapping.
    """

    def __init__(self, gltf, binary):
        self.gltf = json.loads(json.dumps(gltf))
        self.binary = binary
        self.replaced = {}

    def replace(self, index, arr, target=None):
        self.replaced[index] = (np.ascontiguousarray(arr), target)

    def append(self, arr, target=None):
        self.gltf["accessors"].append({})
        index = len(self.gltf["accessors"]) - 1
        self.replace(index, arr, target)
        return index

    def write(self, path):
        gltf, old_views = self.gltf, self.gltf["bufferViews"]
        blob = bytearray()
        views, view_map = [], {}

        def add_view(raw, target=None):
            blob.extend(b"\0" * (-len(blob) % 4))
            view = {"buffer": 0, "byteOffset": len(blob), "byteLength": len(raw)}
            if target:
                view["target"] = target
            blob.extend(raw)
            views.append(view)
            return len(views) - 1

        for i, acc in enumerate(gltf["accessors"]):
            if i in self.replaced:
                arr, target = self.replaced[i]
                arr = arr.reshape(len(arr), -1)
                new = {"bufferView": add_view(arr.tobytes(), target),
                       "componentType": CTYPE[arr.dtype], "count": len(arr), "type": TYPE[arr.shape[1]]}
                if new["type"] == "VEC3" and arr.dtype == np.float32:
                    new["min"], new["max"] = arr.min(0).tolist(), arr.max(0).tolist()
                gltf["accessors"][i] = new
            else:
                v = acc["bufferView"]
                if v not in view_map:
                    src = old_views[v]
                    start = src.get("byteOffset", 0)
                    view_map[v] = add_view(self.binary[start:start + src["byteLength"]], src.get("target"))
                acc["bufferView"] = view_map[v]

        blob.extend(b"\0" * (-len(blob) % 4))
        gltf["bufferViews"] = views
        gltf["buffers"] = [{"byteLength": len(blob)}]
        js = json.dumps(gltf, separators=(",", ":")).encode()
        js += b" " * (-len(js) % 4)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
            f.write(struct.pack("<I4s", len(js), b"JSON") + js)
            f.write(struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob))
