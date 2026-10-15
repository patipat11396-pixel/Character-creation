# The foes' mannequin

From the uploaded `retargeted_animations.glb` (a wooden mannequin, 23 bones, its
own retargeted clips), whose skinning was off (the forearms moved with the hands,
the shoulders creased). Run in one folder holding `src.glb` (the upload) and
`male.glb` / `female.glb` (copies of `models/character_*.glb`):

1. `python3 reweight.py` → `fixed.glb` (kept as `models/source/mannequin_reweighted.glb`):
   new weights from the bones: each vertex on its nearest bone, blended with the
   neighbour bone across each joint (about ±3.5 cm); the pelvis kept rigid on the hips.
2. `python3 transfer.py` → `mannequin_male.glb`, `mannequin_female.glb` (in `models/foe/`):
   each bone's piece turned onto the game body's bone and stretched to its length,
   so the mesh sits on that body's bind pose; textures cut to 1024 JPEG.

The game binds that mesh to the foe body's own skeleton (same first 23 joints, same
order), so the foes keep every clip, the sword grip and the hit zones.
