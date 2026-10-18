# The female body: Character_3D_Eyelashes onto the game's skeleton

`models/character_female.glb` is the uploaded `Character_3D_Eyelashes.glb` (kept in
`models/source/`) moved onto the old female's 53-bone skeleton, so it plays every clip
the game has (same bones, same rest rotations):

- the joints are placed at the new character's own proportions (scaled to the old
  female's height, 158 cm), each bone's piece turned onto the old bone's direction
  (its A-pose into the old T-pose), its weights renamed (Chest → Spine1, UpperChest →
  Spine2, Clavicle → Shoulder, Thigh → UpLeg, Little → Pinky …; jaw and eyes ride
  the head);
- the clips' hip track is scaled to the new hip height (legs of another length);
- the tank top and shorts are carried onto the new body (moved as the body near them
  changes shape, pushed out of the skin, and given the skin's weights under them);
- its own skin, eyes, lashes, teeth and tongue and its 45 face shape keys are kept;
  `scene.userData.body` says `ownSkin` (no painted skin) and `headScale: 1`, with the
  head map and hair colliders measured on it.

To redo it: put `src.glb` (the upload) beside these files, serve nothing — `run.mjs`
loads them in Playwright from disk (it reads the old female from `/cc/models/…`):

    NODE_PATH=… node run.mjs check.png "rest,Idle_Sword@0.5,Run_Anime@0.3" out.glb

Then run `tools/mannequin/transfer.py` again: the female mannequin foe is fitted to
this skeleton.
