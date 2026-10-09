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

- `models/source/retargeted_animations.glb` is the original export, unchanged.
- `models/character.glb` is what the menu loads. Rebuild it with:

```
pip install -r tools/requirements.txt
python3 tools/process_character.py
```

`tools/process_character.py` fixes four things in the export:

1. **Hands could not close.** The skeleton had one bone per hand. The script
   adds 15 finger bones per hand (`LeftHandThumb1`…`LeftHandPinky3`, Mixamo
   naming) on the measured finger centrelines and shares each hand's weight
   between the palm and those bones. Each finger bone curls towards the palm
   when rotated about its local X axis.
2. **Spiky buttocks.** The buttocks were weighted to the thigh bones, so they
   folded whenever a leg lifted. Their weight now goes to `Hips` down to the
   gluteal fold, fading into the thighs over about 12 cm, and the weights
   around the pelvis are smoothed.
3. **Leftover clothing seams.** The mesh had raised edge loops where a
   tank top and bikini were removed: around the neckline, both armholes and
   the bikini line. They showed as hard lines, worst with the arms raised.
   The script finds them by their sharp crease angle and smooths only those
   vertices (about 13% of the mesh); the buttock crease and crotch are left
   alone. The weights over the shoulders, upper back and neck are smoothed
   too, which removes the crumpling there when the arms go up.
4. **Units and layout.** The mesh is welded into an indexed mesh, scaled from centimetres to metres, and the `_RT`
   suffix is dropped from clip names.

The skeleton's other bones, the bind pose and all 178 animations are
unchanged.

## Hands

The animations have no finger tracks, so the menu poses the fingers every
frame (`FIST` in `src/main.js`). The Hands control offers:

- **Auto**: a fist for fighting, weapon, climbing and carrying clips
  (`GRIP_CLIPS`), a relaxed hand otherwise.
- **Open** and **Fist**: forced either way.

Open "Model check" to compare with the original export or to colour the body
by bone weights.
