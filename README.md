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

**Save slots.** Three slots on the right of the view (this browser's
storage): click a filled slot to load it, Save writes the selected slot,
Back returns to the setup as it was when the slot was last loaded or saved.

**The menu.** Name and Body sit at the top; everything else is in tabs.
Basic starts with quick "‹ ›" choices for hair style, hair colour, eye
colour, lipstick and eyebrows:

- **Basic:** skin tone, preview animation, expression, stance ("Legs
  together" turns the thighs inward during animations; female 6°, male 0°
  by default), hands, model check.
- **Hair:** a picture of each style, colour, fit (handles in the view and
  sliders), movement of the swinging parts, and "Keep hair outside the body".
- **Nose, Lips, Forehead, Chin, Jaw:** shape sliders (Lips also has the lip
  colour). Each tab has its own reset.
- **Eyes:** eye colour and the eye shape sliders.
- **Brow:** brow colour, spacing, size, thickness, strength (height and
  angle are fixed so the brows stay on the brow ridge).

**Starting setup.** Everyone starts from the built-in values, overridden by
`models/defaults.json`, overridden (on the published page) by the default
saved with **Set this as the default for everyone**. On the published page
that button writes to the page's shared store, and only the owner or an
editor can use it; run from the repo it downloads a `defaults.json` to put
in `models/` and commit. A person's own Save still wins in their browser.

**Confirm & fight** saves (a name is required) and opens the sword combat
demo with this character. **Save** stores the whole setup in the browser's `localStorage` under
`character-creation:character`; it is loaded again the next time the page
opens. **Confirm** does the same (a name is required) and also fires a
`character-confirmed` event on `window` with the data: name, `body`,
`skinTone`, `expression`, `mouth`, `hands`, `hair` (style, colour, fit,
movement), `hairFits` (every style's fit, per body), `lips`, `eyes`,
`brows` and `face` (the shape sliders).


**Fitting tools are hidden for players.** The hair fit (move / rotate / scale
handles and the fit sliders), the clothes fit sliders, "Set this as the
default for everyone" and "Download setup" only show when the page is opened
with `?fit=1`, or after Ctrl+Alt+F (which toggles them). The saved fits in
`models/defaults.json` still apply to everyone.

## Sword combat demo

`combat.html` (opened by **Confirm & fight** in the menu, which saves the
character first): a white room, your character against one sparring
swordsman, with a third-person camera.

| Input | Action |
|---|---|
| WASD, mouse | move, look (the mouse is captured on click; else right-drag looks) |
| Left click | light attack: Basic Sword 3-hit combo; in the air a plunge; while sprinting a dash strike |
| Right click / Q | heavy attack: slow overhead blow, staggers, a blocked one drains 40 guard stamina; can follow a light hit |
| Space | jump |
| Ctrl (or C) | sprint, uses stamina (in fullscreen, F, the keyboard is locked so Ctrl+W cannot close the tab) |
| Alt | side step / dodge; **perfect** only if pressed within the dodge window before the blow (0.05–0.12 s, a stat) |
| Shift | hold: guard (−50% damage, costs stamina; red attacks cannot be blocked), and walk slowly (1.5 m/s) with it up, the legs walking or strafing under the held guard; tap within the parry window before the blow: **perfect parry** (no damage, the attacker staggers for 1 s) |
| E | Feint 虚招 (skill): a fake heavy wind-up, then a fast stab that breaks a guard (cooldown 4 s); a broken guard cannot block or parry for 5 s |

**Hits and stagger.** Every blow that lands stuns for 0.2 s (no knock-downs)
and fills the target's stagger gauge (the orange bar; 2 × damage, a heavy
55); a full gauge staggers for 1 s. A perfect parry staggers the attacker
for 0.3 s while the parrier, at once (no guard raised first), shoves their
blade out to the left, across and away from the body
(`Parry_Sweep`, made at load by IK from the guard pose; an attack may cut
it short after 0.12 s) (it reels back two steps; no stun). A guard broken by a feint or
by running out of stamina cannot block or parry for 5 s. A blow stopped by a
guard bounces off: the attacker is held for 0.1 s (the swing runs back a
little) and the combo is cut short. Every blow that lands or is blocked, given
or taken, shakes the camera; a dodge leaves a short motion blur. The third
light hit, the finisher, is over in under 0.5 s.

A perfect dodge or parry slows time briefly and gives a counter window
(×1.5 damage), with a flash at the screen's edges, a shockwave and a burst
of streaks at the blade (gold for a parry, blue for a dodge) and a quick
zoom-in. Every swing leaves a trail behind the blade while it is live
(blue for you, gold or red for the enemy, by its telegraph). Running,
sprinting, walking and strafing use the plain locomotion clips with the
sword arm held in the stance (`Run_Sword` etc., made at load): in the
plain run the arm swung the blade past the neck.

Light cut 1 ends once the cut is through and eases back into the stance (its
own recovery clip twirled the sword); the spinning finisher (and the enemy's
spin) lands as the spin comes round, not as it starts. A blade that touches
before its blow's scheduled moment (the aim can tilt a swing into the target
early) lands at that moment, so the timing ring and the parry and dodge
windows stay true.

Two clips are made from the rig at load, since the library has none:
`Sword_Stab` (a lunge, arm and legs placed by two-bone IK with the feet
planted: the arm pulls back by the hip as the body coils, then the right
foot steps out, the hips drop and drive forward, the body leans in and the
arm thrusts straight out) and `Stagger` (the chest-hit
recoil drawn out over a second over two steps back). Both can be picked in
the Animation panel like any other clip. The enemy telegraphs: gold flash = blockable, red =
unblockable; a ring around the enemy's blade (H) closes on the moment of the blow and
turns white in the perfect window.

**Aim.** Cuts follow the camera: the pitch picks a height on the enemy —
its legs looking down, chest at the default view, head looking up — and
each move tilts by what it needs from its own blow height (`hitY` in
`skills.js`) to there, a third by the body bending and the rest at the sword
shoulder (up to 43°). Where the blade touches several zones, the one nearest
its tip counts (then the more vital). The stab never aims below 0.8 m (it
would pass between the legs).

**Body parts.** Head, torso, each arm and each leg have their own HP (25%,
45%, 20% and 25% of max HP); a blow that lands (not one blocked) takes its
damage off the part it hit as well. A part at 0 breaks — head: dazed 2.5 s
taking double damage; torso: +30% damage taken and a guard stops half as
much; sword (right) arm: −60% damage dealt; off (left) arm: blocking costs
60% more stamina; a leg: −60% walking, running and dodging speed (jumps
to 60%). Parts heal 5% a second after 3 s unhit and mend at 40%. Both
fighters have them; the figures beside the HP bars show them, and the enemy
aims too (mostly the body, often the legs, sometimes the head). The head
zone is kept small, so it is hard to hit.

**Enemy defence.** The enemy reads each of your moves as it starts and,
when free and in reach, plans a defence as a player would: a perfect parry
(it shoves your blade aside and you stagger 0.3 s), a perfect dodge, a block,
or nothing. It needs a human reaction time (quick blows can only be blocked
or taken) and its timing has an error, so it misses sometimes. "Enemy skill"
in the Stats panel sets how often and how well (default 0.5: about a third of
blows parried or dodged, a quarter blocked). A feint's wind-up still draws its
guard, which the stab then breaks.

**Hit zones.** The blade has to touch the target: capsules on the bones
(B shows them). Vital zones take more damage and crit more: head ×2.0
(+35% crit), neck ×1.8 (+25%), chest ×1.3 (+10%), abdomen ×1.1, arms ×0.6–0.7,
legs ×0.7–0.8; base crit 5%, crit ×1.8.

**Animation panel** (top right): every move's clip, speed, hit and end time
and every pose's clip and speed (idle, run, guard and the legs under it,
dodges, hit reactions...), with ▶ to play it; kept in the browser, Reset and
Copy JSON (to paste into `skills.js`). A clip can play on the upper or lower
body only, which is how the guard is held while walking.

Martial arts are data (`src/combat/skills.js`): each move names its clip,
when the blade lands (measured where the blade reaches furthest in front),
damage, reach and flags (stagger, unblockable, guard break). The look comes
from the menu's save (`src/combat/look.js`: skin tone, lips, eyes, brows,
face shapes, hair). Stats (timing windows, block reduction) are adjustable
in the Stats panel and kept in the browser.

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
- The brows are lifted off into their own image and painted out of the skin;
  the sculpted brow ridge and its painted light and shade are kept, and the
  menu keeps the brows on the ridge (their height and angle are fixed). The
  male's old painted eye is painted out with a wide fade.
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
   kept as made.
4. **Mouth:** the lip area is refined and cut along the lip line, with shape
   keys `jawOpen`, `smile`, `frown`, `mouthRound`, plus teeth and a tongue.
5. **Face shape keys** (`tools/face.py`): nose width, length and bridge; lip
   fullness, width and corners; forehead fullness and slope; chin length, forward and
   width; jaw width and angle; eye socket size, spacing, height and tilt.
6. **Painted UVs** are carried over from the painted bodies (`tools/skin.py`).
7. **For the menu** the scene's extras hold the body's landmarks, a head map
   (moves hairstyles fitted to the old head onto this one) and the ellipsoids
   that keep hair outside the body. The scene is scaled to metres and `_RT`
   is dropped from clip names.

## Hair

Ten hairstyles plus Bald, each style its own file in `models/hair/` loaded
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

## Head size

The menu draws the head 12% smaller than modelled (`HEAD_SCALE` in
`src/main.js`): the Head bone is scaled every frame after the animation, so
the face, teeth and hair shrink together and the neck tapers into it.

## Hands

The animations have no finger tracks, so the menu poses the fingers every
frame (`FIST` in `src/main.js`): **Auto** makes a fist for fighting, weapon,
climbing and carrying clips, **Open** and **Fist** force either. "Model
check" compares with the original model, colours the body by bone weights or
shows the skeleton.

## Clothing references

`python3 tools/clothing_refs.py` measures both bodies and writes into
`clothing/`: `<body>_measurements.json`, the outline of a tank top and of
shorts cut from each body's own shape in four views
(`<body>_<garment>_<front|side|top|bottom>.png`, 1 cm grid, no body drawn),
and an image-generation prompt per garment (`<body>_<garment>.json`) with
the measurements and the images to attach.

`clothing/<body>_cloak.json` is a hand-written prompt for a wanderer's cloak
(capelet, lowered hood, cowl; side slits and no sleeves so the arms move
freely) in five views: front, back, side, top, bottom.

## Robe

A garment with `"textures"` in `tools/bodies.py` (category "robe", textures
in `models/clothes/<name>_color|normal|mr.jpg`) is worn over the tank top and
shorts; Clothes → Robe switches it on and off (shown only when the body has
one). None is installed at the moment: the first robe (made with the arms
down) was removed, a T-pose robe is to come.

`process_character.py` fits it outside the body and the garments under it,
drapes it over the arms, and rigs it: trunk weights, the tank top's and
shorts' weights where it lies over them (so they move alike), and the arm's
where it lies on an arm. The garments under it get an `underRobe` shape key
that pulls any point the robe would not cover in behind it (rays along each
point's normal); the menu sets it while the robe is worn. `src/cloth.js`
simulates the robe: about 1,000 particles (Verlet), pinned at the
shoulders, distance and bending constraints, capsule collisions with the
arms (the pinned shoulders too), legs and trunk; the mesh follows on the GPU.

## Clothes

Garments always worn are listed per body in `tools/bodies.py` ("clothes":
source GLB converted from the FBX with `tools/fbx_to_glb.mjs`, and the body
heights the garment spans). `process_character.py` scales and places each
one on the body (a garment marked "inflate", made for a smaller body, is
first widened to the body's proportions at each height so its folds keep
their shape), pushes it 0.5 cm out of the skin, gives it the nearest
body points' skin weights and writes it as its own part of the model, so it
moves with every animation. The menu's Clothes tab fits each garment (size,
width, height, depth, up/down, back/forward), saved per body with the
character. Both bodies wear a tank top and shorts from
`models/source/clothing/` (`female_*.glb`, `male_*.glb`).
