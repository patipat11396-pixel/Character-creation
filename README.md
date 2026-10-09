# Character creation

A browser character creation menu for the base character model: enter a name,
pick one of 10 real-world skin tones, preview any of the model's 178
animations and confirm.

## Run it

The page loads the model with `fetch`, so serve the folder over HTTP rather
than opening the file directly:

```
python3 -m http.server 8000
# then open http://localhost:8000/
```

Confirm saves the character to `localStorage` under
`character-creation:character` and fires a `character-confirmed` event on
`window` with the same data:

```json
{ "name": "Mali", "skinTone": { "index": 8, "id": "MST-8", "hex": "#604134" }, "createdAt": "…" }
```

## Skin tones

The 10 tones are the [Monk Skin Tone Scale](https://skintone.google) by
Dr. Ellis Monk (CC BY 4.0), a scale built to cover the range of real human
skin. They live in `src/skinTones.js`.

## The model

- `models/base_character.glb` is the original export, unchanged.
- `models/character.glb` is what the menu loads. Rebuild it with:

```
pip install -r tools/requirements.txt
python3 tools/process_model.py            # --iterations 2 for an even denser mesh
```

`tools/process_model.py` fixes the two problems in the export:

1. **Faceted mesh.** Every triangle had its own three vertices (26,508
   corners for 4,418 points). The script welds them, applies one pass of Loop
   subdivision (17,684 vertices, 35,344 triangles) and recomputes smooth
   normals.
2. **No weight blending.** Every vertex was bound 100% to one bone, so
   elbows, knees, shoulders and hips tore when animated. The script keeps the
   bone each area was assigned to, cleans the ragged borders between areas,
   then fades each bone's weight across the border over a distance measured
   along the surface (8 mm on fingers up to 5 cm on thighs, see `BLEND`).
   Each vertex gets up to 4 bones.

The skeleton, bind pose and all animations are copied unchanged. Open
"Model check" in the menu to switch to the original model or show the bone
weights as colours.
