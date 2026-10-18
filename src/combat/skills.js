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
//   rec       optional recovery clip played when no next move follows ('idle': ease into the stance)
//   recFade   crossfade into it (s; default 0.1)
//   chainFrom earliest time a buffered attack press starts the next move
//   damage    base damage
//   range     reach in metres, arc in degrees (centred on facing)
//   lunge     least metres moved forward over the wind-up
//   reach     how far in front the blade lands (m): a target in front is
//             closed in on (up to 2 m) so the blade ends at its body
//   stagger   true: the blow interrupts the target even if it is attacking
//   poise     how much of the stagger gauge (100) it fills (default 2 x damage)
//   hitY      height (m) the blow lands at with no aim; the camera's aim tilts
//             the cut from there to the height looked at
//   aimFloor  the lowest height (m) the aim takes the move to
//   trail     how long before the blow the blade leaves a trail (clip s; default 0.2)
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
      // Ends once the cut is through (0.34; after that the clip whips the blade back round)
      // and eases back into the stance (its own recovery clip twirls the sword).
      { clip: 'Sword_Regular_A', speed: 1.0, hit: 0.22, end: 0.34, rec: 'idle', recFade: 0.25, chainFrom: 0.15,
        damage: 12, range: 2.1, arc: 110, lunge: 0.4, reach: 1.0, hitY: 0.8 },
      { clip: 'Sword_Regular_B', speed: 1.0, hit: 0.24, end: 0.54, rec: 'Sword_Regular_B_Rec', chainFrom: 0.2,
        damage: 14, range: 2.1, arc: 110, lunge: 0.5, reach: 0.75, hitY: 0.45 },
      // Finisher, the spinning cut: the blow lands as the spin comes round (0.65; the blade
      // also passes in front at 0.17, as the spin starts). 0.92 s of clip at 2.15x: 0.43 s.
      { clip: 'Sword_Regular_C', speed: 2.15, hit: 0.65, end: 0.92, chainFrom: 0.5,
        damage: 26, range: 2.4, arc: 120, lunge: 0.8, reach: 0.75, stagger: true, hitY: 0.69 },
    ],
    // Heavy attack (right click / Q): slow overhead blow; staggers, and a
    // blocked one costs the defender a lot of guard (stamina).
    heavy: { clip: 'Sword_Attack', speed: 0.95, hit: 0.52, end: 1.05, damage: 30, range: 2.4, arc: 120,
      lunge: 0.6, reach: 0.95, stagger: true, stamina: 15, guardDamage: 40, poise: 55, hitY: 1.13 },
    // Jump attack: Light 1's cut on its own (no combo follows it).
    air: { clip: 'Sword_Regular_A', speed: 1.0, hit: 0.22, end: 0.34, damage: 12, range: 2.1, arc: 110, hitY: 0.8 },
    // Right button: hold to charge (up to `max` s; let go, or at `max`, it
    // goes): Light 3's spinning cut played backwards (Spin_Back), jumping
    // `back` m back, a sword wave thrown off the blade at `launch` (clip s: the
    // blade coming round in front) that runs `run` m at `flight` m/s, `width` m
    // to each side, damage and width x1 to x2 with the charge. A guard takes the
    // wave (as a blow into it); a parry (or an auto parry) bats it up and away. Charging: the fight
    // stance, the sword swung a little up to the left (`pose`), walking slowly
    // (`walk` m/s), no guard; only a side step. Spent 0.6 s after. The foe uses it too.
    wave: { clip: 'Spin_Back', speed: 2.0, hit: 0.27, launch: 0.27, end: 0.92, damage: 20, range: 0, arc: 0,
      straight: true, noBlade: true, spent: true, unblockable: true, parryable: false, rec: 'idle',
      max: 3, cooldown: 6, hop: 3.2, back: 2.5, walk: 0.9, run: 18, flight: 12, width: 0.9, pose: { clip: 'Charge_Pose', at: 0 } },
    // Sprint + attack: runs through the foe (even locked on), unless a guard stops it in front of it; cooldown s.
    dash: { clip: 'Sword_Dash_RM', speed: 1.1, hit: 0.3, end: 0.85, damage: 18, range: 2.4, arc: 90, lunge: 0, through: true, cooldown: 3 },
    // Skills (keys). A feint shows a bait, then thrusts in fast: blocked, it
    // breaks the guard (the target is staggered).
    skills: {
      feint: {
        key: 'KeyE', name: 'Feint', name_cn: '虚招', cooldown: 4, stamina: 15,
        // The bait: drawing into the stab's chamber (both hands, blade level at the foe).
        bait: { clip: 'Thrust_Chamber', speed: 1, until: 0.3 },
        // The real strike is a thrust (the captured right jab, the blade along the
        // forearm, made at load): the arm straight at 0.22 s of it, played a bit fast.
        strike: { clip: 'Sword_Thrust', speed: 1.3, hit: 0.22, end: 0.5, straight: true,
          damage: 16, range: 2.4, arc: 70, lunge: 0.6, reach: 1.0, guardBreak: true,
          trail: 0.08, hitY: 0.65, aimFloor: 0.8 },   // crouched, straight ahead   // a low stab would pass between the legs   // trail only on the thrust itself (not the turn out of the bait)
      },
    },
  },
};

// The sparring partner's moves are the player's own, the same in every way
// (each reads the player's move through its prototype, so an edit to one is
// an edit to both), named for its choice of attack.
{
  const A = ARTS.basicSword;
  const as = (move, extra) => Object.assign(Object.create(move), extra);
  A.enemy = [
    as(A.combo[0], { name: 'slash', next: 'slash2', nextChance: 0.6 }),
    as(A.combo[1], { name: 'slash2' }),
    as(A.heavy, { name: 'heavy' }),
    as(A.combo[2], { name: 'thrust' }),
    // The feint: the bait (the chamber), then this thrust.
    as(A.skills.feint.strike, { name: 'stab', bait: A.skills.feint.bait }),
    // The player's sprint cut, through the player (a guard stops it in front).
    as(A.dash, { name: 'dashcut' }),
    // The jump cut (Light 1 in the air), played on the whole body.
    as(A.air, { name: 'jumpcut' }),
  ];
}

// Poses (not attacks): the clip and speed for each. The menu's Animation
// panel changes these and the moves above (clip, speed, hit, end).
export const ANIM_SLOTS = {
  idle: { clip: 'Idle_Fight', speed: 1 },   // ready to fight: the captured stance (models/anims/idle_fight.bvh, made at load)
  idleCalm: { clip: 'Idle_Relaxed', speed: 1 },  // not fighting: standing easy, the sword hanging point down (made at load)
  // Running: the anime run (body leaning in, arms trailing back, the blade behind).
  run: { clip: 'Run_Anime', speed: 1 },
  sprint: { clip: 'Run_Anime', speed: 1.2 },              // also in the fight: sprinting runs
  // Out of the fight: steps with the sword hanging as in idleCalm (made at load).
  walk: { clip: 'Walk_Relaxed', speed: 1 },
  // In the fight: steps forward / back / left / right against the facing.
  // From the captured walk back (made at load): back, and forward / left /
  // right made from it. They play at the fighter's speed over the capture's
  // (so the feet keep to the ground), times this speed.
  fightForward: { clip: 'Fight_Forward', speed: 1 },
  fightBack: { clip: 'Fight_Back', speed: 1 },
  fightLeft: { clip: 'Fight_Left', speed: 1 },
  fightRight: { clip: 'Fight_Right', speed: 1 },
  guard: { clip: 'Sword_Block', speed: 1.4, hold: 0.45 },   // held at `hold` s while parry is held
  // Legs while moving with the guard up: facing straight ahead like the
  // guard, slow, careful steps (guardSpeed 0.9 m/s).
  guardForward: { clip: 'Walk_Sword', speed: 0.6 },
  guardBack: { clip: 'Walk_Backwards_Sword', speed: 0.6 },
  guardLeft: { clip: 'Strafe_left_Sword', speed: 0.6 },
  guardRight: { clip: 'Strafe_right_Sword', speed: 0.6 },
  jump: { clip: 'Jump_air', speed: 1 },
  dodgeLeft: { clip: 'Dodge_left', speed: 1.5 },
  dodgeRight: { clip: 'Dodge_right', speed: 1.5 },
  dodgeBack: { clip: 'Dodge_back', speed: 1.5 },
  dodgeForward: { clip: 'Dodge_left', speed: 1.5 },
  roll: { clip: 'Roll', speed: 1.6 },   // the roll (Tab): a dive roll, up again by 1.2 s of clip (0.75 s)   // dashing ahead: the left dodge, turned so its left is ahead
  hitLight: { clip: 'Hit_Chest', speed: 1.1 },
  hitLight2: { clip: 'Hit_Head', speed: 1.1 },
  stagger: { clip: 'Stagger', speed: 1 },
  daze: { clip: 'Dizzy', speed: 1 },
  staggerBack: { clip: 'Stagger_Back', speed: 1 },   // a broken guard: thrown back on the heels, 0.5 s          // head broken: dazed (looped)   // reeling back two steps (~1 s): a full gauge, a parried blow, a broken guard
  knockdown: { clip: 'Hit_Knockback', speed: 1 },   // hit from behind (10%): thrown on the back...
  getUp: { clip: 'LayToIdle', speed: 1.2 },         // ...and up again
  death: { clip: 'Death_A', speed: 1 },
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
  blockReduction: 0.65,  // share of damage taken away by holding the guard
  counterBonus: 1.5,     // damage multiplier just after a perfect dodge or parry
  runSpeed: 3.8,
  guardSpeed: 0.9,       // moving with the guard up (parry held): slow, careful steps
  sprintSpeed: 6.6,
  aiSkill: 0.85,         // the enemy's defence: 0 none, 1 parries and dodges often and on time
  enemyCount: 1,         // foes in the room (1: the sparring partner alone; up to 100)
};

// Hit zones (positional hitboxes): capsules on the bones; the blade has to
// touch one. More vital zones take more damage and crit more often.
//   from, to   bones the capsule runs between (to: null = a sphere on from,
//              or with lift, a capsule that far up from's own axis)
//   radius     metres
//   damage     multiplier, crit  extra critical chance (added to baseCrit)
export const HIT_ZONES = [
  // The rig has no Head_end bone: the head runs `lift` m up the Head bone's own axis.
  // Kept small: the head is meant to be hard to hit.
  { name: 'head', label: 'Head', from: 'Head', to: null, lift: 0.15, radius: 0.08, damage: 2.0, crit: 0.35 },
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

// Body parts, each with its own HP (a share of the fighter's max HP). A blow
// that lands (not one blocked) takes its damage off the part it hit as well.
// A part at 0 is broken until it heals back to `mendAt` of its HP; parts heal
// on their own (`regen` of their HP per second) once not hit for `regenAfter` s.
export const BODY_PARTS = {
  head: { label: 'Head', share: 0.25 },
  torso: { label: 'Torso', share: 0.45 },
  armL: { label: 'Left arm', share: 0.2 },
  armR: { label: 'Right arm', share: 0.2 },
  legL: { label: 'Left leg', share: 0.25 },
  legR: { label: 'Right leg', share: 0.25 },
};
export const PART_RULES = {
  regen: 0.05, regenAfter: 3, mendAt: 0.4,
  headDaze: 2.5,         // head broken: dazed this long, taking x dazedDamage
  dazedDamage: 2,
  torsoDamage: 1.3,      // torso broken: takes 30% more, and a guard stops half as much
  torsoGuard: 0.5,
  armRDamage: 0.4,       // sword arm broken: deals 60% less
  armLGuardCost: 1.6,    // off arm broken: blocking costs 60% more stamina
  legSpeed: 0.4,         // a leg broken: moves, dodges and jumps 60% less
};
// The blade is live from this long before a move's hit time to this long after (clip seconds).
export const BLADE_ACTIVE = { before: 0.16, after: 0.1 };
