# Character creation

A browser character creation menu for the base character model: enter a name,
pick one of 10 real-world skin tones, style and colour the hair, colour the lips, set a facial expression, preview any of
the model's 178 animations and confirm.

## Run it

The page loads the model with `fetch`, so serve the folder over HTTP rather
than opening the file directly:

```
python3 -m http.server 8000
# then open http://localhost:8000/
```

**Starting setup.** Everyone starts from the built-in values, overridden by
`models/defaults.json`, overridden (on the published page) by the default
saved with **Set this as the default for everyone**. On the published page
that button writes to the page's shared store, and only the owner or an
editor can use it; run from the repo it downloads a `defaults.json` to put
in `models/` and commit. A person's own Save still wins in their browser.

**Save** stores the whole setup (name, skin tone, expression, hands, hair
colour, fit and ponytail settings) in the browser's `localStorage` under
`character-creation:character`; it is loaded again the next time the page
opens. **Confirm** does the same (a name is required) and also fires a
`character-confirmed` event on `window` with the data:

```json
{ "name": "Mali", "skinTone": { "index": 8, "id": "MST-8", "hex": "#604134" },
  "expression": "smile", "mouth": { "open": 0, "smile": 1, "round": 0 },
  "hands": "auto",
  "hair": { "color": "#4b2e1d", "size": 1, "width": 1, "height": 1, "depth": 1,
            "up": 0, "forward": 0, "side": 0, "tilt": 0, "turn": 0, "roll": 0,
            "weight": 1, "stiffness": 0.5, "bounce": 0.5 },
  "lips": { "color": "#b8676d", "amount": 0.35 }, "savedAt": "…" }
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

`tools/process_character.py` fixes five things in the export (and the face, see below):

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
4. **Head size.** The head is 15% smaller than the source (`HEAD_SCALE`),
   shrunk towards the top of the neck and blended over the upper neck so
   there is no step. The mouth shape keys, teeth and tongue scale with it.
5. **Units and layout.** The mesh is welded into an indexed mesh, scaled from centimetres to metres, and the `_RT`
   suffix is dropped from clip names.

The skeleton's other bones, the bind pose and all 178 animations are
unchanged.

## Face and expressions

The source face had the mouth sculpted shut and the eye recesses covered in a
few long, flat triangles. `tools/face.py` fixes both:

- **Eye area:** triangles longer than 0.9 cm are split down to the size used
  on the rest of the face, then the patch is relaxed so the recesses have
  soft edges instead of facets.
- **Mouth corners:** the source has tiny triangles folded back on themselves
  at both corners, which showed as white spots. Their shading normals are
  blended with the surrounding skin; the shape is not moved, so the lip line
  stays intact.
- **Mouth:** the mesh is cut along the line where the lips meet, so the lips
  can part. Four shape keys (morph targets) are added: `jawOpen` (the lower
  jaw rotates about a hinge in front of the ears), `smile`, `frown` and
  `mouthRound`. Teeth and a tongue are added as extra parts of the same mesh,
  bound to the `Head` bone, with the lower teeth and tongue following
  `jawOpen`.

The menu's Expression control mixes those shape keys: Neutral, Smile, Laugh,
Surprised, Sad and Talking (an animated jaw), plus sliders for mouth open,
frown/smile and round lips. The open mouth shows the inside of the head,
which the menu draws as a dark mouth interior (back faces of the skin
material). Another engine needs the same treatment or a mouth cavity mesh.

## Lips

`tools/face.py` stores a 0..1 lip mask on every body vertex (`_LIPMASK`): a
soft lens shape around the lip line that covers the upper and lower lip and
the inside of the lip fold. The menu mixes the chosen lip colour over the
skin by that mask times Intensity (`src/main.js`, skin shader). Presets:
Natural, Nude, Pink, Rose, Coral, Red, Berry, or any custom colour.

## Hair

`models/source/hair.fbx` is converted once to `models/source/hair.glb`
(`npm i three@0.170.0 && node tools/fbx_to_glb.mjs models/source/hair.fbx models/source/hair.glb`),
then `tools/hair.py` (run by `process_character.py`):

- **Fits it to the head.** The inside of the hair cap is matched to the head
  by ray casting, then pushed out so the scalp never pokes through.
- **Attaches it to the Head bone.** A `HairRoot` bone at the centre of the
  head holds the whole hairstyle, so it stays on the head in every
  animation. The menu adjusts that bone two ways:
  - **In the view:** "Adjust in view" puts move / rotate / scale handles on
    the hair (keys W, E, R; Esc to hide). The scale handle's axis cubes
    stretch width, height or depth; its centre cube changes the overall size
    (drag up to grow, down to shrink).
  - **Sliders:** Size, Width, Height, Depth, Up/down, Back/forward,
    Left/right, Tilt, Turn and Roll, kept in step with the handles.
- **Rigs the ponytail.** Eight bones (`HairTail1`…`HairTail8`, plus
  `HairTailEnd`) run from the hair tie to the tip, and the tail is weighted
  along them. Where the tail is fused to the long hair on the back of the
  head, the weights are blended across the seam so nothing tears.

In the menu (`src/hair.js`) the ponytail is a spring-bone simulation: each
bone is pulled back towards its rest direction (Stiffness), pulled down
(Weight), and slowed by drag (Bounce), and it collides with spheres on the
head, neck, chest, waist and hips. Colours: Black, Brown, Blonde, Red or any
custom colour.

## Hands

The animations have no finger tracks, so the menu poses the fingers every
frame (`FIST` in `src/main.js`). The Hands control offers:

- **Auto**: a fist for fighting, weapon, climbing and carrying clips
  (`GRIP_CLIPS`), a relaxed hand otherwise.
- **Open** and **Fist**: forced either way.

Open "Model check" to compare with the original export, colour the body by
bone weights, or show the skeleton.
