# Character creation

A browser character creation menu for two base bodies (female and male):
enter a name, pick the body and skin tone, choose and fit a hairstyle, shape
the nose, lips, forehead, chin, jaw, eyes and brows, set an expression,
preview any of the 178 animations and confirm.

## Run it

The page loads the models with `fetch`, so serve the folder over HTTP rather
than opening the file directly:

```
python3 -m http.server 8000
# then open http://localhost:8000/
```

**Camera.** Drag to rotate, scroll or pinch to zoom, right-drag (or two
fingers) to move the view up and down; the **Head** and **Full body**
buttons jump to those views. Opening a hair or face tab moves to the head.

**The menu.** Name and Body sit at the top; everything else is in tabs:

- **Basic:** skin tone, preview animation, expression, hands, model check.
- **Hair:** a picture of each style, colour, fit (handles in the view and
  sliders), movement of the swinging parts, and "Keep hair outside the body".
- **Nose, Lips, Forehead, Chin, Jaw:** shape sliders (Lips also has the lip
  colour). Each tab has its own reset.
- **Eyes:** eye colour and the eye shape sliders.
- **Brow:** brow colour, height, spacing, size, angle, thickness, strength.

**Starting setup.** Everyone starts from the built-in values, overridden by
`models/defaults.json`, overridden (on the published page) by the default
saved with **Set this as the default for everyone**. On the published page
that button writes to the page's shared store, and only the owner or an
editor can use it; run from the repo it downloads a `defaults.json` to put
in `models/` and commit. A person's own Save still wins in their browser.

**Save** stores the whole setup in the browser's `localStorage` under
`character-creation:character`; it is loaded again the next time the page
opens. **Confirm** does the same (a name is required) and also fires a
`character-confirmed` event on `window` with the data: name, `body`,
`skinTone`, `expression`, `mouth`, `hands`, `hair` (style, colour, fit,
movement), `hairFits` (every style's fit, per body), `lips`, `eyes`,
`brows` and `face` (the shape sliders).

## Skin

`tools/build_skin.py` makes the skin textures from the painted bodies
(`models/source/<f|m>_painted.glb`: the base bodies with a painted texture,
the same triangles in another order):

- Below the jaw everything (the painted grey bodysuit included) becomes one
  flat skin colour measured on the painted face, fading into the painted head
  under the jaw line; the scene's lights do the shading.
- The painted normal map is left out: its tangents break at the UV seams,
  which lit up as a line across the eyes.
- The male's painted eyes do not match above and below a seam; the eye
  openings are repainted (white, a round iris coloured from the lower half,
  highlights, lash shadow).
- The brows are lifted off into their own image and painted out of the skin.
- A feature mask marks the irises (red), the painted lips (green) and the
  whole painted eye (blue), which skin tones leave alone.

Outputs in `models/skin/`: `<body>_color.jpg`, `_rough.jpg`, `_mask.png`,
`_brow.png` and `<body>.json` (reference skin colour, brow box). It needs
`opencv-python-headless` besides `tools/requirements.txt`.

**Skin tones.** "P" is the painted skin. 1-10 are the
[Monk Skin Tone Scale](https://skintone.google) by Dr. Ellis Monk (CC BY 4.0,
`src/skinTones.js`); the menu tints the texture by tone / reference colour.

## The models

- `models/source/f_base.glb`, `m_base.glb`: the rigged base bodies as given.
- `models/character_female.glb`, `character_male.glb`: what the menu loads.
  Rebuild with:

```
pip install -r tools/requirements.txt opencv-python-headless
python3 tools/process_character.py     # both bodies, or: process_character.py male
python3 tools/build_skin.py
```

Everything body-specific (hand joints, face landmarks, iris and brow
positions) is in `tools/bodies.py`. `tools/process_character.py`:

1. **Hands** get 15 finger bones each (`LeftHandThumb1`…`LeftHandPinky3`) on
   the measured finger centrelines, with each hand's weight shared between
   the palm and those bones; they curl about their local X axis.
2. **Buttocks** follow `Hips` down to the gluteal fold instead of folding
   with the thighs; the weights over the pelvis, shoulders, upper back and
   neck are smoothed.
3. **Body cleanup** (`clean_body`): the bodysuit's ridges are flattened, the
   female nipples removed, shoulders, underarms and buttocks smoothed, and a
   light pass evens out small dents and bumps. The sculpted brow ridges are
   relaxed so the movable brows leave nothing behind.
4. **Mouth:** the lip area is refined and cut along the lip line, with shape
   keys `jawOpen`, `smile`, `frown`, `mouthRound`, plus teeth and a tongue.
5. **Face shape keys** (`tools/face.py`): nose width, length and bridge; lip
   fullness and width; forehead fullness and slope; chin length, forward and
   width; jaw width and angle; eye socket size, spacing, height and tilt.
6. **Painted UVs** are carried over from the painted bodies (`tools/skin.py`).
7. **For the menu** the scene's extras hold the body's landmarks, a head map
   (moves hairstyles fitted to the old head onto this one) and the ellipsoids
   that keep hair outside the body. The scene is scaled to metres and `_RT`
   is dropped from clip names.

## Hair

Nine hairstyles plus Bald, each style its own file in `models/hair/` loaded
when picked; `models/hair/thumbs/` holds their pictures (made with
`node tools/hair_thumbs.mjs`, see the file). Sources and the build
(`tools/build_hair.py`, `tools/hair.py`) are as before: each file holds a
`HairRoot` bone, swinging chains `Chain<n>_1 … Chain<n>_End` and the skinned
mesh. In the menu (`src/hair.js`) `HairRoot` is moved onto the body's head
with the head map and held by the Head bone; every style keeps its own fit
per body. The swinging parts are spring bones that collide with spheres on
the head, neck and spine; the whole hair mesh is also pushed out of the
body's ellipsoids (torso, neck, shoulders, upper arms) every frame, so long
hair lies over the back and shoulders instead of passing through them.

## Hands

The animations have no finger tracks, so the menu poses the fingers every
frame (`FIST` in `src/main.js`): **Auto** makes a fist for fighting, weapon,
climbing and carrying clips, **Open** and **Fist** force either. "Model
check" compares with the original model, colours the body by bone weights or
shows the skeleton.
