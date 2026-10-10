"""Turn the hair_thumbs.mjs screenshots (hair on magenta) into transparent PNGs."""
from pathlib import Path

import numpy as np
from PIL import Image

THUMBS = Path(__file__).resolve().parent.parent / "models/hair/thumbs"
for raw in sorted(THUMBS.glob("*.raw.png")):
    rgb = np.asarray(Image.open(raw).convert("RGB"), np.float32) / 255
    # Magenta has full red and blue, no green; the grey hair has r = g = b.
    alpha = np.clip(1 - (np.minimum(rgb[..., 0], rgb[..., 2]) - rgb[..., 1]), 0, 1)
    grey = np.clip(rgb[..., 1:2] / np.maximum(alpha[..., None], 1e-3), 0, 1).repeat(3, 2)
    out = np.dstack([grey, alpha]) * 255
    Image.fromarray(out.astype(np.uint8), "RGBA").resize((240, 240), Image.LANCZOS).save(
        raw.with_name(raw.name.replace(".raw", "")), optimize=True)
    raw.unlink()
    print(raw.name.replace(".raw", ""))
