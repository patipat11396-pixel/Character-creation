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

**Camera.** Drag to rotate, scroll or pinch to zoom, right-drag (or two
fingers) to move the view up and down; the **Head** and **Full body**
buttons jump to those views.

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

Nine hairstyles, each its own file in `models/hair/` loaded when it is
picked: High ponytail, Wavy, Bob, Braid, Long with fringe, Twin tails,
Long centre part, Low ponytail, Short shaggy.

**Building them.** Sources are in `models/source/hair/` (the FBX as given,
plus a GLB converted with `node tools/fbx_to_glb.mjs <in.fbx> <out.glb>`,
which needs `npm i three@0.170.0`). `tools/hairstyles.json` lists the styles
and which parts swing. Then:

```
python3 tools/process_character.py   # the body, if it changed
python3 tools/build_hair.py           # every style, or: build_hair.py braid bob
```

`tools/hair.py` finds the head-sized hollow inside each hairstyle, scales and
moves the hair onto the head (ray casting, then pushed out so the scalp
never pokes through), and builds a bone chain for every swinging part with
weights blended across its seam with the rest of the hair. Each output file
holds a `HairRoot` bone, chains `Chain<n>_1 … Chain<n>_End`, and the skinned
mesh, in the character's bind pose.

**In the menu** (`src/hair.js`) `HairRoot` is moved under the character's
Head bone, so the hair follows the head in every animation. Every style keeps
its own fit:

- **In the view:** "Adjust in view" puts move / rotate / scale handles on
  the hair (keys W, E, R; Esc to hide). The scale handle's axis cubes
  stretch width, height or depth; its centre cube changes the overall size
  (drag up to grow, down to shrink).
- **Sliders:** Size, Width, Height, Depth, Up/down, Back/forward,
  Left/right, Tilt, Turn and Roll, kept in step with the handles.

The swinging parts are spring-bone simulations: each bone is pulled back
towards its rest direction (Stiffness), pulled down (Weight), slowed by drag
(Bounce), and collides with spheres on the head, neck, chest, waist and hips.
Bones near the tie are stiffer and bend less, as real hair is held there.
Colours: Black, Brown, Blonde, Red or any custom colour.

**Under hair (buzz cut).** The menu's skin shader paints the scalp in the
hair colour with a fine stubble speckle (`scalpCover` in `src/main.js`). The
boundary is computed per pixel from the head's mesh-space position, fitted to
this head's landmarks:

- **Front and sides:** a Catmull-Rom curve of hairline height by depth
  (`HAIR_FRONT`), from the forehead (158.5 cm) through a short, softly
  tapered temple to a small sideburn in front of the ear. The cheek stays
  clear.
- **Ears:** an ellipse 0.3 cm outside the measured ear outline (front 13.8,
  back 19.4, bottom 142, top 150 cm), so the ear is bare and the hair runs
  close over and behind it.
- **Nape:** a shallow rounded edge where the skull meets the neck (140.5 cm
  on the centre line), rising to meet the line behind each ear.
- **Under a hair mesh** the front edge is raised 2.5 cm so it stays hidden.

The cap is painted on the head's own surface, so it cannot intersect or
flicker against it. The "Under hair" slider sets its strength, and the
**Buzz cut** style shows it on its own with no hair mesh.

**Keeping your fits.** "Download setup with all hair fits (JSON)" saves a
`defaults.json` with the fit of every style (on the published page through
the page's download prompt). Put it in `models/` to make it the starting
setup, or give it to Claude to build the fits into the hair files.

## Hands

The animations have no finger tracks, so the menu poses the fingers every
frame (`FIST` in `src/main.js`). The Hands control offers:

- **Auto**: a fist for fighting, weapon, climbing and carrying clips
  (`GRIP_CLIPS`), a relaxed hand otherwise.
- **Open** and **Fist**: forced either way.

Open "Model check" to compare with the original export, colour the body by
bone weights, or show the skeleton.
