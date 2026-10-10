"""Cut the eye part sheets (5 x 2 grids, 10 styles each) into one PNG per part.

    python3 tools/slice_eyes.py

Reads models/source/eyes/{whites,irises,pupils,lashes,closed}.* and writes
models/eyes/{white,iris,pupil,lash,closed}_<1-10>.png at 400 x 400, in reading order (top row left to
right, then the bottom row). Style N of every part is drawn to line up.
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC, OUT = ROOT / "models/source/eyes", ROOT / "models/eyes"
PARTS = {"whites": "white", "irises": "iris", "pupils": "pupil", "lashes": "lash", "closed": "closed"}
CELL = 400


def keep_middle(cell):
    """Keep only the drawing that touches the middle of the cell.

    A long lash flick from the next style can cross the grid line; anything
    not connected to the central drawing is cleared.
    """
    import numpy as np
    from scipy.ndimage import label
    a = np.array(cell)
    solid = a[..., 3] > 8
    parts, n = label(solid, structure=np.ones((3, 3)))
    if n <= 1:
        return cell
    h, w = solid.shape
    sizes = np.bincount(parts.ravel())
    sizes[0] = 0
    _, xs = np.mgrid[0:h, 0:w]
    keep = np.zeros(n + 1, bool)
    for i in range(1, n + 1):
        m = parts == i
        cx = xs[m].mean()
        # keep the parts that sit around the middle, drop slivers at the edges
        touches_edge = m[:, :3].any() or m[:, -3:].any()
        keep[i] = not (touches_edge and abs(cx - w / 2) > 0.3 * w) and sizes[i] > 30
    a[..., 3] = np.where(keep[parts], a[..., 3], 0)
    return Image.fromarray(a)


def main():
    OUT.mkdir(exist_ok=True)
    for part, name in PARTS.items():
        src = next(SRC.glob(part + ".*"))
        sheet = Image.open(src).convert("RGBA")
        w, h = sheet.size
        for row in range(2):
            for col in range(5):
                box = (round(col * w / 5), round(row * h / 2), round((col + 1) * w / 5), round((row + 1) * h / 2))
                cell = sheet.crop(box)
                cell = keep_middle(cell).resize((CELL, CELL), Image.LANCZOS)
                cell.save(OUT / f"{name}_{row * 5 + col + 1}.png", optimize=True)
    print("wrote", len(list(OUT.glob("*.png"))), "images to", OUT)


if __name__ == "__main__":
    main()
