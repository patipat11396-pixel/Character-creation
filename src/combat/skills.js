// Martial arts (武学), as data. Each art is a set of moves; a move names the
// clip it plays and when, in seconds of that clip, the blade lands. Arts are
// meant to be found and learned in play later; the demo starts with the
// basic sword art only.
//
// Move fields:
//   clip      animation clip
//   speed     playback speed (hit and end times are in clip seconds)
//   hit       when the blow lands
//   end       when the move is over (the next move may start)
//   rec       optional recovery clip played when no next move follows
//   chainFrom earliest time a buffered attack press starts the next move
//   damage    base damage
//   range     reach in metres, arc in degrees (centred on facing)
//   lunge     least metres moved forward over the wind-up
//   reach     how far in front the blade lands (m): a target in front is
//             closed in on (up to 2 m) so the blade ends at its body
//   stagger   true: the blow interrupts the target even if it is attacking
//   unblockable  true: holding parry does not help (red flash); only a dodge
//                or (when parryable) a perfect parry avoids it

export const ARTS = {
  basicSword: {
    name: 'Basic Sword',
    name_cn: '基础剑法',
    weapon: 'sword',
    // Hit times are where the blade reaches furthest in front (measured on the
    // clips with the sword held in the fist).
    combo: [
      { clip: 'Sword_Regular_A', speed: 1.0, hit: 0.22, end: 0.46, rec: 'Sword_Regular_A_Rec', chainFrom: 0.15,
        damage: 12, range: 2.1, arc: 110, lunge: 0.4, reach: 1.0 },
      { clip: 'Sword_Regular_B', speed: 1.0, hit: 0.24, end: 0.54, rec: 'Sword_Regular_B_Rec', chainFrom: 0.2,
        damage: 14, range: 2.1, arc: 110, lunge: 0.5, reach: 0.75 },
      { clip: 'Sword_Regular_C', speed: 0.9, hit: 0.17, end: 0.75, chainFrom: 0.5,
        damage: 26, range: 2.4, arc: 120, lunge: 0.8, reach: 0.75, stagger: true },
    ],
    air: { clip: 'Sword_Attack', speed: 1.5, hit: 0.52, end: 1.0, damage: 20, range: 2.2, arc: 120, stagger: true },
    dash: { clip: 'Sword_Dash_RM', speed: 1.1, hit: 0.3, end: 0.85, damage: 18, range: 2.4, arc: 90, lunge: 0 },
    // Skills (keys). A feint shows the heavy wind-up, then cuts in fast: it
    // breaks a guard (the target is staggered) and cannot be blocked.
    skills: {
      feint: {
        key: 'KeyE', name: 'Feint', name_cn: '虚招', cooldown: 4, stamina: 15,
        bait: { clip: 'Sword_Attack', speed: 1.3, until: 0.32 },
        strike: { clip: 'Sword_Regular_A', speed: 1.4, hit: 0.22, end: 0.46, rec: 'Sword_Regular_A_Rec',
          damage: 16, range: 2.2, arc: 120, lunge: 0.6, guardBreak: true, unblockable: true },
      },
    },
    // The sparring partner's moves (the same art, read from the other side).
    enemy: [
      { name: 'slash', clip: 'Sword_Regular_A', speed: 0.55, hit: 0.22, end: 0.46, rec: 'Sword_Regular_A_Rec',
        damage: 12, range: 2.3, arc: 100, lunge: 0.5, next: 'slash2', nextChance: 0.6 },
      { name: 'slash2', clip: 'Sword_Regular_B', speed: 0.6, hit: 0.24, end: 0.54, rec: 'Sword_Regular_B_Rec',
        damage: 14, range: 2.3, arc: 100, lunge: 0.5 },
      { name: 'heavy', clip: 'Sword_Attack', speed: 0.6, hit: 0.52, end: 1.1, damage: 28, range: 2.6, arc: 120,
        lunge: 0.9, reach: 0.95, unblockable: true, parryable: false },
      { name: 'thrust', clip: 'Sword_Regular_C', speed: 0.4, hit: 0.17, end: 0.75, damage: 20, range: 2.6, arc: 70,
        lunge: 1.0, stagger: true },
    ],
  },
};

// Player numbers; the timing windows come from stats later (the dodge window
// runs 0.05 s to 0.12 s).
export const DEFAULT_STATS = {
  maxHp: 200,
  maxStamina: 100,
  staminaRegen: 22,      // per second, when not sprinting or blocking
  sprintCost: 18,        // per second
  dodgeCost: 18,
  jumpCost: 8,
  blockCost: 12,         // per blocked hit
  dodgeWindow: 0.08,     // seconds before a hit in which a dodge is perfect
  parryWindow: 0.12,     // seconds before a hit in which a parry tap is perfect
  blockReduction: 0.5,   // share of damage taken away by holding parry
  counterBonus: 1.5,     // damage multiplier just after a perfect dodge or parry
  runSpeed: 3.8,
  sprintSpeed: 6.6,
};

// Hit zones (positional hitboxes): capsules on the bones; the blade has to
// touch one. More vital zones take more damage and crit more often.
//   from, to   bones the capsule runs between (to: null = a sphere on from)
//   radius     metres
//   damage     multiplier, crit  extra critical chance (added to baseCrit)
export const HIT_ZONES = [
  { name: 'head', label: 'Head', from: 'Head', to: 'Head_end', radius: 0.11, damage: 2.0, crit: 0.35 },
  { name: 'neck', label: 'Neck', from: 'Neck', to: 'Head', radius: 0.065, damage: 1.8, crit: 0.25 },
  { name: 'chest', label: 'Chest', from: 'Spine1', to: 'Neck', radius: 0.15, damage: 1.3, crit: 0.10 },
  { name: 'abdomen', label: 'Abdomen', from: 'Hips', to: 'Spine1', radius: 0.15, damage: 1.1, crit: 0.05 },
  { name: 'arm', label: 'Arm', from: 'LeftArm', to: 'LeftForeArm', radius: 0.06, damage: 0.7, crit: 0 },
  { name: 'arm', label: 'Arm', from: 'LeftForeArm', to: 'LeftHand', radius: 0.05, damage: 0.6, crit: 0 },
  { name: 'arm', label: 'Arm', from: 'RightArm', to: 'RightForeArm', radius: 0.06, damage: 0.7, crit: 0 },
  { name: 'arm', label: 'Arm', from: 'RightForeArm', to: 'RightHand', radius: 0.05, damage: 0.6, crit: 0 },
  { name: 'leg', label: 'Leg', from: 'LeftUpLeg', to: 'LeftLeg', radius: 0.085, damage: 0.8, crit: 0.02 },
  { name: 'leg', label: 'Leg', from: 'LeftLeg', to: 'LeftFoot', radius: 0.06, damage: 0.7, crit: 0 },
  { name: 'leg', label: 'Leg', from: 'RightUpLeg', to: 'RightLeg', radius: 0.085, damage: 0.8, crit: 0.02 },
  { name: 'leg', label: 'Leg', from: 'RightLeg', to: 'RightFoot', radius: 0.06, damage: 0.7, crit: 0 },
];
// Zones are tested most vital first: a blade touching the neck and the chest counts the neck.
export const ZONE_ORDER = ['head', 'neck', 'chest', 'abdomen', 'arm', 'leg'];
export const CRIT = { baseChance: 0.05, damage: 1.8 };
// The blade is live from this long before a move's hit time to this long after (clip seconds).
export const BLADE_ACTIVE = { before: 0.16, after: 0.1 };
