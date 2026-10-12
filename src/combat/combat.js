import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ARTS, ANIM_SLOTS, DEFAULT_STATS, HIT_ZONES, ZONE_ORDER, CRIT, BLADE_ACTIVE, BODY_PARTS, PART_RULES } from './skills.js';
import { readSetup, skinMaterial, applyFace, hairFor } from './look.js';

// Sword combat demo: a white room, the player and one sparring enemy.
// Third-person camera (mouse look), left click attacks (Basic Sword combo,
// air and dash attacks), Space jumps, Alt side-steps (a perfect dodge needs
// the right moment), Shift blocks (hold) or parries (tap at the right
// moment), Ctrl sprints. The blade has to touch a hit zone; vital zones
// take more damage and crit more.

const PACKED = null;   // filled in for the published page (models as text parts)
const STATS_KEY = 'character-creation:combat-stats';
const ROOM = 14;       // half size of the room (m)
const HEAD_SCALE = 0.88;
const FIST = { Thumb: [0, 25, 55], Index: [75, 95, 60], Middle: [75, 95, 60], Ring: [75, 95, 60], Pinky: [75, 95, 60] };
const ART = ARTS.basicSword;

const $ = (id) => document.getElementById(id);
const stats = { ...DEFAULT_STATS, ...readStats() };
function readStats() { try { return JSON.parse(localStorage.getItem(STATS_KEY)) ?? {}; } catch { return {}; } }
function saveStats() { try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch { /* private mode */ } }

// ------------------------------------------------------------------ scene

const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f4f2);
scene.fog = new THREE.Fog(0xf4f4f2, 18, 40);
const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 100);
// Drawn through a composer: the afterimage pass is the dodge's motion blur
// (off, damp 0, the rest of the time).
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const blur = new AfterimagePass(0);
composer.addPass(blur);
composer.addPass(new OutputPass());
const draw = () => composer.render();

scene.add(new THREE.HemisphereLight(0xffffff, 0xd8d8d4, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(6, 12, 5);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 16, bottom: -16, near: 1, far: 40 });
scene.add(sun);

{
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(ROOM * 2, ROOM * 2),
    new THREE.MeshStandardMaterial({ color: 0xfafaf8, roughness: 0.95 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const grid = new THREE.GridHelper(ROOM * 2, 28, 0xe2e2de, 0xebebe8);
  grid.position.y = 0.002;
  scene.add(grid);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  for (const [x, z, ry] of [[0, -ROOM, 0], [0, ROOM, Math.PI], [-ROOM, 0, Math.PI / 2], [ROOM, 0, -Math.PI / 2]]) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(ROOM * 2, 5), wallMat);
    w.position.set(x, 2.5, z);
    w.rotation.y = ry;
    w.receiveShadow = true;
    scene.add(w);
  }
}

// ------------------------------------------------------------------ sound (synthesised, no files)

let audio = null;
function sound(kind) {
  try {
    audio ??= new AudioContext();
    const t = audio.currentTime;
    const out = audio.createGain();
    out.connect(audio.destination);
    if (kind === 'swing' || kind === 'hit' || kind === 'crit') {
      const len = kind === 'swing' ? 0.18 : 0.12;
      const buf = audio.createBuffer(1, audio.sampleRate * len, audio.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
      const src = audio.createBufferSource();
      src.buffer = buf;
      const f = audio.createBiquadFilter();
      f.type = kind === 'swing' ? 'bandpass' : 'lowpass';
      f.frequency.value = kind === 'swing' ? 1800 : 700;
      src.connect(f).connect(out);
      out.gain.setValueAtTime(kind === 'swing' ? 0.12 : kind === 'crit' ? 0.5 : 0.35, t);
      src.start(t);
    } else {
      // Clang (block / parry) or chime (perfect).
      const freqs = kind === 'perfect' ? [880, 1320, 1760] : kind === 'parry' ? [1200, 1810, 2650] : [600, 905];
      for (const fr of freqs) {
        const o = audio.createOscillator();
        o.type = kind === 'perfect' ? 'sine' : 'triangle';
        o.frequency.value = fr;
        o.connect(out);
        o.start(t);
        o.stop(t + (kind === 'perfect' ? 0.6 : 0.35));
      }
      out.gain.setValueAtTime(0.12, t);
      out.gain.exponentialRampToValueAtTime(0.001, t + (kind === 'perfect' ? 0.6 : 0.35));
    }
  } catch { /* no audio */ }
}

// ------------------------------------------------------------------ models

const loader = new GLTFLoader();
const texLoader = new THREE.TextureLoader();
async function loadGLB(url) {
  const parts = PACKED?.[url];
  if (!parts) return loader.loadAsync(url);
  const texts = await Promise.all(parts.map(async (p) => {
    const r = await fetch(p);
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${p}`);
    return r.text();
  }));
  return loader.parseAsync(Uint8Array.from(atob(texts.join('')), (c) => c.charCodeAt(0)).buffer, '');
}

function makeSword(tint) {
  // Built along +Y (grip at 0), metres.
  const g = new THREE.Group();
  const steel = new THREE.MeshStandardMaterial({ color: 0xd9dde2, metalness: 0.9, roughness: 0.25, emissive: 0x000000 });
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.82, 0.008), steel);
  blade.position.y = 0.53;
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.07, 4), steel);
  tip.position.y = 0.975;
  tip.scale.z = 0.25;
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.02, 0.03), new THREE.MeshStandardMaterial({ color: tint, metalness: 0.6, roughness: 0.4 }));
  guard.position.y = 0.11;
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.2, 8), new THREE.MeshStandardMaterial({ color: 0x2a1d16, roughness: 0.8 }));
  grip.position.y = 0.0;
  const tassel = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), new THREE.MeshStandardMaterial({ color: tint }));
  tassel.position.y = -0.11;
  for (const m of [blade, tip, guard, grip, tassel]) { m.castShadow = true; g.add(m); }
  g.userData.steel = steel;
  g.userData.base = new THREE.Vector3(0, 0.13, 0);   // blade start and tip (local)
  g.userData.tip = new THREE.Vector3(0, 1.0, 0);
  return g;
}

class Fighter {
  constructor(gltf, body, opts) {
    this.body = body;
    this.root = gltf.scene;
    this.name = opts.name;
    this.isPlayer = !!opts.player;
    this.root.traverse((o) => {
      if (o.isSkinnedMesh) {
        o.castShadow = true;
        o.frustumCulled = false;
        if (!['Teeth', 'Gums', 'Tongue'].includes(o.material.name) && !o.material.name.startsWith('Cloth_')) this.mesh = o;
        if (o.material.name.startsWith('Cloth_')) o.material = new THREE.MeshStandardMaterial({ color: o.material.color, roughness: 0.85, side: THREE.DoubleSide });
      }
    });
    this.mesh.material = opts.skin;
    applyFace(this.root, opts.setup);
    this.bones = Object.fromEntries(this.mesh.skeleton.bones.map((b) => [b.name, b]));
    this.mixer = new THREE.AnimationMixer(this.root);
    this.clips = new Map(gltf.animations.map((c) => [c.name, c]));
    this.action = null;
    // Fingers: the clips have no finger tracks; the sword hand makes a fist.
    this.fingers = [];
    for (const [name, bone] of Object.entries(this.bones)) {
      const m = name.match(/^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)([123])$/);
      if (m) this.fingers.push({ bone, rest: bone.quaternion.clone(), angle: THREE.MathUtils.degToRad(FIST[m[2]][m[3] - 1]) * (m[1] === 'Right' ? 1 : 0.25) });
    }
    // Sword in the right hand: blade forward with the arm out (bind pose), grip in the palm.
    this.root.updateMatrixWorld(true);
    this.sword = makeSword(opts.tint);
    this.bones.RightHand.add(this.sword);
    this.gripSword();
    // Clips the library lacks, made from the rig: a stab (the feint's real
    // strike) and a stagger (reeling back a couple of steps).
    this.clips.set('Sword_Stab', makeStabClip(this));
    this.clips.set('Stagger', makeStaggerClip(this));
    this.clips.set('Parry_Sweep', makeParrySweepClip(this));
    // Locomotion with the sword arm held in the stance: in the plain run the
    // arm swings the blade past the neck.
    for (const [name, base] of [['Run_Sword', 'Jog'], ['Sprint_Sword', 'Sprint'], ['Walk_Sword', 'Walk'], ['Walk_Backwards_Sword', 'Walk_Backwards'],
      ['Strafe_left_Sword', 'Strafe_left'], ['Strafe_right_Sword', 'Strafe_right']]) {
      const clip = makeArmedClip(this, name, base);
      if (clip) this.clips.set(name, clip);
    }
    this.bladePrev = null;
    // Hit zones: capsules on the bones.
    this.zones = HIT_ZONES.filter((z) => this.bones[z.from] && (!z.to || this.bones[z.to]))
      .map((z) => ({ ...z, a: new THREE.Vector3(), b: new THREE.Vector3() }));
    // Body radius for pushing apart.
    this.radius = 0.35;
    this.yaw = 0;
    this.vel = new THREE.Vector3();
    this.vy = 0;
    this.grounded = true;
    this.hp = opts.maxHp;
    this.maxHp = opts.maxHp;
    this.stamina = stats.maxStamina;
    this.state = 'idle';
    this.t = 0;          // time in the current state (game seconds)
    this.move = null;    // the move being performed
    this.moveHit = false;
    this.comboIndex = -1;
    this.queued = false;
    this.counterUntil = 0;
    this.parts = makeParts(this.maxHp);
    this.invulnUntil = 0;
    scene.add(this.root);
  }

  /**
   * Put the sword in the right fist, from the hand's own bones: the handle's
   * centre in the hole of the fist (between the knuckles and the curled
   * finger tips), its axis along the knuckle line (little finger to index,
   * the blade out of the thumb side) at exactly 90 degrees to the hand's
   * length, and the blade's edge facing the way the knuckles point.
   */
  gripSword() {
    const hand = this.bones.RightHand;
    const names = ['Index', 'Middle', 'Ring', 'Pinky'];
    // Curl the fingers into the fist for the measurement, then put them back.
    const saved = this.fingers.map((f) => f.bone.quaternion.clone());
    const q = new THREE.Quaternion();
    for (const f of this.fingers) f.bone.quaternion.copy(f.rest).multiply(q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), f.angle));
    hand.updateMatrixWorld(true);
    const local = (name) => hand.worldToLocal(this.bones[`RightHand${name}`].getWorldPosition(new THREE.Vector3()));
    const knuckles = names.map((n) => local(`${n}1`));
    const tips = names.map((n) => local(`${n}3`));
    this.fingers.forEach((f, i) => f.bone.quaternion.copy(saved[i]));
    const centre = new THREE.Vector3();
    for (const v of [...knuckles, ...tips]) centre.add(v);
    centre.divideScalar(8);
    const along = knuckles[1].clone().normalize();                        // wrist to middle knuckle
    const axis = knuckles[0].clone().sub(knuckles[3]);                    // little finger to index
    axis.addScaledVector(along, -axis.dot(along)).normalize();            // at 90 degrees to the hand
    const edge = along.clone().addScaledVector(axis, -along.dot(axis)).normalize();
    const basis = new THREE.Matrix4().makeBasis(edge, axis, edge.clone().cross(axis));   // sword X = edge, Y = blade
    this.sword.quaternion.setFromRotationMatrix(basis);
    // The handle (sword y -0.1..0.1) centred in the fist.
    const s = hand.getWorldScale(new THREE.Vector3()).x;
    this.sword.position.copy(centre);
    this.sword.scale.setScalar(1 / s);
    this.sword.updateMatrix();
  }

  get pos() { return this.root.position; }
  forward(out = new THREE.Vector3()) { return out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }

  /**
   * A clip, or only its upper or lower body ('upper': spine up, arms, head;
   * 'lower': hips and legs), so two can play at once (guard up while walking).
   */
  clip(name, part) {
    const full = this.clips.get(name);
    if (!full || !part) return full;
    const key = `${name}#${part}`;
    if (!this.clips.has(key)) {
      const upper = (bone) => /Spine1|Spine2|Neck|Head|Shoulder|Arm|Hand/.test(bone);
      const tracks = full.tracks.filter((t) => upper(t.name.split('.')[0]) === (part === 'upper'));
      this.clips.set(key, new THREE.AnimationClip(key, full.duration, tracks));
    }
    return this.clips.get(key);
  }

  /** A pose slot (ANIM_SLOTS: idle, run, guard...) with its speed. */
  playSlot(slot, opts = {}) {
    const s = ANIM_SLOTS[slot];
    return this.play(s.clip, { speed: s.speed, ...opts });
  }

  /** The upper-body layer (the guard while walking), or null to drop it. */
  setUpper(name, { hold = null, speed = 1 } = {}) {
    if (this.upperName === name) return;
    this.upper?.fadeOut(0.12);
    this.upper = null;
    this.upperName = name;
    if (!name) return;
    const a = this.mixer.clipAction(this.clip(name, 'upper'));
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = true;
    a.timeScale = speed;
    a.fadeIn(0.12).play();
    a.holdAt = hold;
    this.upper = a;
  }

  play(name, { fade = 0.12, loop = true, speed = 1, from = 0, part = null } = {}) {
    const clip = this.clip(name, part);
    if (!clip) return null;
    if (!part && this.upper) this.setUpper(null);
    const a = this.mixer.clipAction(clip);
    if (this.action === a && loop) { a.timeScale = speed; return a; }
    a.reset();
    a.holdAt = null;
    a.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    a.clampWhenFinished = !loop;
    a.timeScale = speed;
    a.time = from;
    if (this.action && this.action !== a) { this.action.fadeOut(fade); a.fadeIn(fade); }
    a.play();
    this.action = a;
    return a;
  }

  setState(s) { this.state = s; this.t = 0; }

  turnTo(yaw, dt, rate = 12) {
    let d = yaw - this.yaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.yaw += d * Math.min(1, dt * rate);
  }

  faceTarget(other, dt, rate = 14) {
    const d = other.pos.clone().sub(this.pos);
    this.turnTo(Math.atan2(d.x, d.z), dt, rate);
  }

  /** Pose after the animation: fingers, head size, facing, the attack's aim. */
  finishPose(dt = 0) {
    for (const a of [this.upper, this.action]) {
      if (a?.holdAt != null && a.time >= a.holdAt) { a.time = a.holdAt; a.timeScale = 0; }
    }
    this.root.rotation.y = this.yaw;
    this.bones.Head.scale.setScalar(HEAD_SCALE);
    const q = new THREE.Quaternion();
    for (const f of this.fingers) f.bone.quaternion.copy(f.rest).multiply(q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), f.angle));
    this.root.updateMatrixWorld(true);
    // Aim: while attacking, the cut is tilted up or down by `aim` (radians,
    // + = up), a third by the body bending and the rest at the sword shoulder
    // (bending the body alone pulled the blade back out of reach when aiming
    // up). The player's aim comes from the camera's pitch.
    const attacking = (this.state === 'attack' || this.state === 'feint') && this.grounded;
    this.aimW = (this.aimW ?? 0) + ((attacking ? 1 : 0) - (this.aimW ?? 0)) * Math.min(1, dt * 14);
    const angle = (this.aim ?? 0) * this.aimW;
    if (Math.abs(angle) > 1e-3) {
      const fwd = this.forward(new THREE.Vector3());
      const right = fwd.cross(new THREE.Vector3(0, 1, 0)).normalize();
      turnBoneWorld(this.bones.Spine1, q.setFromAxisAngle(right, angle * 0.35));
      turnBoneWorld(this.bones.RightArm, q.setFromAxisAngle(right, angle * 0.65));
    }
    for (const z of this.zones) {
      this.bones[z.from].getWorldPosition(z.a);
      if (z.to) this.bones[z.to].getWorldPosition(z.b);
      else if (z.lift) z.b.copy(z.a).addScaledVector(new THREE.Vector3(0, 1, 0).transformDirection(this.bones[z.from].matrixWorld), z.lift);
      else z.b.copy(z.a);
    }
  }

  blade() {
    return [this.sword.localToWorld(this.sword.userData.base.clone()), this.sword.localToWorld(this.sword.userData.tip.clone())];
  }

  /** Clip time of the current move. */
  moveTime() { return this.move ? this.t * (this.move.speed ?? 1) : 0; }
}

// ------------------------------------------------------------------ made clips

const UPPER_BONE = /Spine1|Spine2|Neck|Head|Shoulder|Arm|Hand/;
const trackBone = (t) => t.name.split('.')[0];

/** Pose the rig as `clip` is at time t (only the bones `only` accepts). */
function poseFromClip(f, clip, t, only = null) {
  for (const tr of clip.tracks) {
    const [name, prop] = tr.name.split('.');
    if (only && !only(name)) continue;
    const bone = f.bones[name];
    if (!bone || !(prop in bone)) continue;
    const v = tr.createInterpolant().evaluate(Math.min(t, tr.times[tr.times.length - 1]));
    bone[prop].fromArray(v);
  }
  f.root.updateMatrixWorld(true);
}

/** Turn a bone by a rotation given in world space. */
function turnBoneWorld(bone, q) {
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parent.invert().multiply(q.clone().multiply(world)));
  bone.updateMatrixWorld(true);
}

/** Turn `bone` so its child at `child` points at `target` (world). */
function aimBone(bone, child, target) {
  const at = bone.getWorldPosition(new THREE.Vector3());
  const cur = child.getWorldPosition(new THREE.Vector3()).sub(at).normalize();
  const want = target.clone().sub(at).normalize();
  turnBoneWorld(bone, new THREE.Quaternion().setFromUnitVectors(cur, want));
}

/**
 * The stab: a lunge. The sword arm pulls back by the hip (blade level,
 * pointing ahead) as the body coils, then the right foot steps out, the hips
 * drop and drive forward, the body leans in and the arm thrusts straight out;
 * held, then back to the stance. Arm and legs are placed by two-bone IK on the
 * rig itself (the feet planted), so it fits each body.
 */
function makeStabClip(f) {
  const idle = f.clips.get('Idle_Sword');
  const B = f.bones;
  const record = ['Spine1', 'Spine2', 'RightArm', 'RightForeArm', 'RightHand', 'RightUpLeg', 'RightLeg', 'LeftUpLeg', 'LeftLeg'];
  //            body turn, lean in, blade drop (deg); hand target; hips down / forward, right foot step (m)
  const chamber = { twist: 30, lean: 4, drop: 3, hand: [-0.05, 0.08, -0.36], down: 0.06, push: -0.04, step: 0 };
  const strike = { twist: -25, lean: 20, drop: 2, hand: null, down: 0.2, push: 0.22, step: 0.42 };
  // Phases: stance -> chamber (0.07) -> lunge (0.17), held to 0.3, back to the stance by 0.5.
  // Sampled every 1/40 s, the IK solved at each sample, so the blade and feet stay true between keys.
  const smooth = (x) => { x = THREE.MathUtils.clamp(x, 0, 1); return x * x * (3 - 2 * x); };
  const mix = (p, q, w) => {
    const o = { from: p, to: q, w };
    for (const key of ['twist', 'lean', 'drop', 'down', 'push', 'step']) o[key] = p[key] + (q[key] - p[key]) * w;
    return o;
  };
  const phase = (t) => {
    if (t < 0.07) return { k: chamber, idle: 1 - smooth(t / 0.07) };
    if (t < 0.17) return { k: mix(chamber, strike, smooth((t - 0.07) / 0.1)), idle: 0 };
    if (t < 0.3) return { k: strike, idle: 0 };
    return { k: strike, idle: smooth((t - 0.3) / 0.2) };
  };
  const times = [];
  for (let t = 0; t <= 0.5 + 1e-6; t += 0.025) times.push(Math.round(t * 1000) / 1000);
  const up = new THREE.Vector3(0, 1, 0);
  const values = Object.fromEntries(record.map((n) => [n, []]));
  const hipsValues = [];
  const handTarget = (k, S, fwd, right, reach) => (k.hand
    ? S.clone().addScaledVector(fwd, k.hand[0]).addScaledVector(right, k.hand[1]).addScaledVector(up, k.hand[2])
    : S.clone().addScaledVector(fwd, reach * 0.93).addScaledVector(right, -0.1).addScaledVector(up, 0.08));
  // Two-bone IK: turn `a` and `b` so the chain a -> b -> c ends at `target`, the middle joint toward `pole`.
  const twoBone = (a, b, c, target, pole) => {
    const S = a.getWorldPosition(new THREE.Vector3());
    const l1 = S.distanceTo(b.getWorldPosition(new THREE.Vector3())), l2 = b.getWorldPosition(new THREE.Vector3()).distanceTo(c.getWorldPosition(new THREE.Vector3()));
    const toT = target.clone().sub(S);
    const dist = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999);
    const dir = toT.normalize();
    const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
    const p = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
    aimBone(a, b, S.clone().addScaledVector(dir, along).addScaledVector(p, h));
    aimBone(b, c, S.clone().addScaledVector(dir, dist));
  };
  for (const t of times) {
    const { k, idle: idleW } = phase(t);
    poseFromClip(f, idle, t);
    const idleQ = Object.fromEntries(record.map((n) => [n, B[n].quaternion.clone()]));
    const idleHips = B.Hips.position.clone();
    // The fighter's facing (the root's +Z), not the shoulders'.
    const fwd = new THREE.Vector3(0, 0, 1).transformDirection(f.root.matrixWorld).setY(0).normalize();
    const right = fwd.clone().cross(up);
    // Legs: the feet where the stance has them (the right one stepping out), the hips dropping and driving on.
    const footL = B.LeftFoot.getWorldPosition(new THREE.Vector3());
    const footR = B.RightFoot.getWorldPosition(new THREE.Vector3()).addScaledVector(fwd, k.step);
    const hipsW = B.Hips.getWorldPosition(new THREE.Vector3()).addScaledVector(up, -k.down).addScaledVector(fwd, k.push);
    B.Hips.position.copy(B.Hips.parent.worldToLocal(hipsW));
    B.Hips.updateMatrixWorld(true);
    twoBone(B.RightUpLeg, B.RightLeg, B.RightFoot, footR, fwd.clone().addScaledVector(right, 0.2));
    twoBone(B.LeftUpLeg, B.LeftLeg, B.LeftFoot, footL, fwd.clone().addScaledVector(right, -0.2));
    // Body: turn the right shoulder back (+) or into the thrust (-), lean in.
    for (const n of ['Spine1', 'Spine2']) {
      turnBoneWorld(B[n], new THREE.Quaternion().setFromAxisAngle(up.clone().negate(), THREE.MathUtils.degToRad(k.twist / 2)));
      turnBoneWorld(B[n], new THREE.Quaternion().setFromAxisAngle(up.clone().cross(fwd), THREE.MathUtils.degToRad(k.lean / 2)));
    }
    // Arm: to the hand target, the elbow down and out.
    const S = B.RightArm.getWorldPosition(new THREE.Vector3());
    const reach = S.distanceTo(B.RightForeArm.getWorldPosition(new THREE.Vector3())) + B.RightForeArm.getWorldPosition(new THREE.Vector3()).distanceTo(B.RightHand.getWorldPosition(new THREE.Vector3()));
    const T = k.from ? handTarget(k.from, S, fwd, right, reach).lerp(handTarget(k.to, S, fwd, right, reach), k.w) : handTarget(k, S, fwd, right, reach);
    twoBone(B.RightArm, B.RightForeArm, B.RightHand, T, up.clone().negate().addScaledVector(right, 0.5).addScaledVector(fwd, -0.2));
    // Hand: the blade straight ahead (a little down), its point on the centre line.
    const blade = new THREE.Vector3(0, 1, 0).transformDirection(f.sword.matrixWorld);
    const want = fwd.clone().addScaledVector(up, -Math.tan(THREE.MathUtils.degToRad(k.drop))).addScaledVector(right, 0.08).normalize();
    turnBoneWorld(B.RightHand, new THREE.Quaternion().setFromUnitVectors(blade, want));
    // Into and out of the stance.
    for (const n of record) values[n].push(...B[n].quaternion.clone().slerp(idleQ[n], idleW).toArray());
    hipsValues.push(...B.Hips.position.clone().lerp(idleHips, idleW).toArray());
  }
  const tracks = [
    ...idle.tracks.filter((tr) => !(record.includes(trackBone(tr)) && tr.name.endsWith('.quaternion')) && tr.name !== 'Hips.position'),
    ...record.map((n) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, values[n])),
    new THREE.VectorKeyframeTrack('Hips.position', times, hipsValues),
  ];
  poseFromClip(f, idle, 0);
  return new THREE.AnimationClip('Sword_Stab', 0.5, tracks);
}

/**
 * After a perfect parry: a shove. Straight from the blades meeting in front
 * of the chest (no guard raised first), the arm drives the blade out to the
 * left, across and away from the body (the point leading, the body turning
 * with it), batting the other blade aside, then eases into the guard. Arm by two-bone IK
 * from the held guard pose, so it fits each body.
 */
function makeParrySweepClip(f) {
  const guard = f.clips.get(ANIM_SLOTS.guard.clip) ?? f.clips.get('Sword_Block');
  const B = f.bones;
  const at = ANIM_SLOTS.guard.hold ?? 0.45;
  const record = ['Spine1', 'Spine2', 'RightArm', 'RightForeArm', 'RightHand'];
  // Keys: hand (forward, right, up from the shoulder, m), blade direction (forward, right, up), body turn (deg, + = with the sweep).
  // Swept to the left, across the body (the inside of the sword arm), the body turning with it.
  const meet = { hand: [0.42, 0.08, -0.1], blade: [0.35, 0.1, 1], twist: 6 };
  const out = { hand: [0.38, -0.3, -0.04], blade: [0.55, -0.75, 0.45], twist: -20 };
  // No raising of the guard first: it starts on the blades meeting and shoves straight out.
  const keys = [[0, meet, 1], [0.1, out, 1], [0.2, out, 1], [0.35, out, 0]];
  const times = [];
  for (let t = 0; t <= 0.35 + 1e-6; t += 0.025) times.push(Math.round(t * 1000) / 1000);
  const ease = (x) => x * x * (3 - 2 * x);
  const lerp3 = (a, b, w) => a.map((v, i) => v + (b[i] - v) * w);
  const sample = (t) => {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
    const [t0, k0, w0] = keys[i], [t1, k1, w1] = keys[i + 1];
    const u = ease(THREE.MathUtils.clamp((t - t0) / (t1 - t0), 0, 1));
    const a = k0 ?? k1, b = k1 ?? k0;
    return { hand: lerp3(a.hand, b.hand, u), blade: lerp3(a.blade, b.blade, u), twist: a.twist + (b.twist - a.twist) * u, w: w0 + (w1 - w0) * u };
  };
  const up = new THREE.Vector3(0, 1, 0);
  const values = Object.fromEntries(record.map((n) => [n, []]));
  for (const t of times) {
    const k = sample(t);
    poseFromClip(f, guard, at);
    const rest = Object.fromEntries(record.map((n) => [n, B[n].quaternion.clone()]));
    const fwd = new THREE.Vector3(0, 0, 1).transformDirection(f.root.matrixWorld).setY(0).normalize();
    const right = fwd.clone().cross(up);
    for (const n of ['Spine1', 'Spine2']) turnBoneWorld(B[n], new THREE.Quaternion().setFromAxisAngle(up.clone().negate(), THREE.MathUtils.degToRad(k.twist / 2)));
    const S = B.RightArm.getWorldPosition(new THREE.Vector3());
    const E = B.RightForeArm.getWorldPosition(new THREE.Vector3()), H = B.RightHand.getWorldPosition(new THREE.Vector3());
    const l1 = S.distanceTo(E), l2 = E.distanceTo(H);
    const T = S.clone().addScaledVector(fwd, k.hand[0]).addScaledVector(right, k.hand[1]).addScaledVector(up, k.hand[2]);
    const toT = T.clone().sub(S), dist = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.999), dir = toT.normalize();
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const pole = up.clone().negate().addScaledVector(right, 0.6);
    pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    aimBone(B.RightArm, B.RightForeArm, S.clone().addScaledVector(dir, a).addScaledVector(pole, h));
    aimBone(B.RightForeArm, B.RightHand, S.clone().addScaledVector(dir, dist));
    const blade = new THREE.Vector3(0, 1, 0).transformDirection(f.sword.matrixWorld);
    const want = fwd.clone().multiplyScalar(k.blade[0]).addScaledVector(right, k.blade[1]).addScaledVector(up, k.blade[2]).normalize();
    turnBoneWorld(B.RightHand, new THREE.Quaternion().setFromUnitVectors(blade, want));
    for (const n of record) values[n].push(...rest[n].clone().slerp(B[n].quaternion, k.w).toArray());
  }
  const tracks = [
    ...guard.tracks.filter((tr) => !(record.includes(trackBone(tr)) && tr.name.endsWith('.quaternion')))
      .map((tr) => new tr.constructor(tr.name, [0], tr.createInterpolant().evaluate(Math.min(at, tr.times[tr.times.length - 1])).slice())),
    ...record.map((n) => new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, times, values[n])),
  ];
  poseFromClip(f, f.clips.get('Idle_Sword'), 0);
  return new THREE.AnimationClip('Parry_Sweep', 0.35, tracks);
}

/** `base` with the right arm (shoulder to hand) taken from the sword idle. */
function makeArmedClip(f, name, base) {
  const clip = f.clips.get(base), idle = f.clips.get('Idle_Sword');
  if (!clip || !idle) return null;
  const arm = /^Right(Shoulder|Arm|ForeArm|Hand)$/;
  return new THREE.AnimationClip(name, clip.duration, [
    ...clip.tracks.filter((tr) => !arm.test(trackBone(tr))),
    ...idle.tracks.filter((tr) => arm.test(trackBone(tr))),
  ]);
}

/** Staggering: the chest-hit recoil drawn out over a second, the legs stepping back. */
function makeStaggerClip(f) {
  const hit = f.clips.get('Hit_Chest'), back = f.clips.get('Walk_Backwards');
  const tracks = [
    ...hit.tracks.filter((tr) => UPPER_BONE.test(trackBone(tr))).map((tr) => tr.clone().scale(2.3)),
    ...back.tracks.filter((tr) => !UPPER_BONE.test(trackBone(tr))).map((tr) => tr.clone()),
  ];
  return new THREE.AnimationClip('Stagger', 1.0, tracks);
}

// ------------------------------------------------------------------ geometry helpers

function segSegDist(p1, q1, p2, q2) {
  // Closest distance between segments p1q1 and p2q2 (Real-Time Collision Detection 5.1.9).
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a <= 1e-9 && e <= 1e-9) return p1.distanceTo(p2);
  if (a <= 1e-9) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); } else {
    const c = d1.dot(r);
    if (e <= 1e-9) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); } else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}

/** Which zone of `target` the blade swept this frame (from prev to now) touches, most vital first. */
function bladeContact(prev, now, target) {
  const BLADE_R = 0.03;
  const samples = [];
  // The swept blade: segments between the previous and current blade at a few steps.
  for (let k = 0; k <= 3; k++) {
    const s = k / 3;
    samples.push([prev[0].clone().lerp(now[0], s), prev[1].clone().lerp(now[1], s)]);
  }
  // ...and the tip's path (a fast swing passes clean through between frames).
  samples.push([prev[1], now[1]]);
  samples.push([prev[0].clone().lerp(prev[1], 0.5), now[0].clone().lerp(now[1], 0.5)]);
  // Of the zones touched, the one nearest the blade's tip counts (where a cut
  // lands; the long blade also brushes what is below a high cut), then the
  // more vital.
  let best = null, bestAt = -1;
  for (const z of target.zones) {
    let at = -1;
    for (const [a, b] of samples) {
      if (segSegDist(a, b, z.a, z.b) < z.radius + BLADE_R) at = Math.max(at, bladeParam(a, b, z));
    }
    if (at < 0) continue;
    const better = !best || at > bestAt + 0.1 || (Math.abs(at - bestAt) <= 0.1 && ZONE_ORDER.indexOf(z.name) < ZONE_ORDER.indexOf(best.name));
    if (better) { best = z; bestAt = at; }
  }
  return best;
}

/** Where along blade a-b (0 = base, 1 = tip) it comes closest to zone z. */
function bladeParam(a, b, z) {
  let bestT = 0, bestD = Infinity;
  const pnt = new THREE.Vector3(), seg = new THREE.Line3(z.a, z.b), on = new THREE.Vector3();
  for (let t = 0; t <= 1.0001; t += 0.1) {
    pnt.copy(a).lerp(b, t);
    const d = seg.closestPointToPoint(pnt, true, on).distanceTo(pnt) - z.radius;
    if (d < bestD - 1e-4) { bestD = d; bestT = t; }
    else if (d <= z.radius * 0.5 + 0.03) bestT = Math.max(bestT, t);   // still touching further out
  }
  return bestT;
}

function inFront(attacker, target, range, arc) {
  const d = target.pos.clone().sub(attacker.pos);
  d.y = 0;
  const dist = d.length();
  if (dist > range + target.radius) return false;
  const ang = attacker.forward().angleTo(d.normalize());
  return THREE.MathUtils.radToDeg(ang) <= arc / 2;
}

// ------------------------------------------------------------------ HUD

const msgEl = $('message');
let msgTimer = 0;
function message(text, kind = '') {
  msgEl.textContent = text;
  msgEl.className = 'show ' + kind;
  msgTimer = 1.1;
}

const floaters = [];
function floatText(pos, text, kind) {
  const el = document.createElement('div');
  el.className = 'dmg ' + kind;
  el.textContent = text;
  $('hud').appendChild(el);
  floaters.push({ el, pos: pos.clone(), life: 0 });
}
function updateFloaters(dt) {
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life += dt;
    f.pos.y += dt * 0.6;
    const p = f.pos.clone().project(camera);
    f.el.style.transform = `translate(${(p.x * 0.5 + 0.5) * innerWidth}px, ${(-p.y * 0.5 + 0.5) * innerHeight}px) translate(-50%, -50%)`;
    f.el.style.opacity = String(Math.max(0, 1 - f.life / 1.1));
    if (f.life > 1.1 || p.z > 1) { f.el.remove(); floaters.splice(i, 1); }
  }
}

function updateBars() {
  $('hp-fill').style.width = `${(player.hp / player.maxHp) * 100}%`;
  $('hp-text').textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
  $('st-fill').style.width = `${(player.stamina / stats.maxStamina) * 100}%`;
  $('enemy-fill').style.width = `${(enemy.hp / enemy.maxHp) * 100}%`;
  $('enemy-poise').style.width = `${((enemy.poise ?? 0) / STAGGER.gauge) * 100}%`;
  $('poise-fill').style.width = `${((player.poise ?? 0) / STAGGER.gauge) * 100}%`;
  $('enemy-text').textContent = `${Math.ceil(enemy.hp)} / ${enemy.maxHp}`;
  const left = Math.max(0, (player.feintReady ?? 0) - gameTime);
  $('skill-e').classList.toggle('cool', left > 0);
  $('skill-e-cd').textContent = left > 0 ? left.toFixed(1) : '';
  const broken = Math.max(0, (player.guardBrokenUntil ?? 0) - gameTime);
  $('combo').textContent = broken > 0 ? `Guard broken ${broken.toFixed(1)} s`
    : player.comboIndex >= 0 && player.state === 'attack' ? `${ART.name} · ${player.comboIndex + 1}` : ART.name;
  $('combo').style.color = broken > 0 ? '#c8323c' : '';
  $('enemy-text').textContent += guardBroken(enemy) ? ' · guard broken' : '';
  for (const [id, f] of [['body-p', player], ['body-e', enemy]]) {
    for (const el of $(id).children) {
      const part = f.parts[el.dataset.part];
      const k = part.hp / part.max;
      el.classList.toggle('broken', part.broken);
      // green -> yellow -> red as the part's HP falls (a broken one blinks red)
      el.style.fill = part.broken ? '' : `hsl(${Math.round(110 * k)}, 55%, ${48 + 6 * (1 - k)}%)`;
    }
  }
}

// ------------------------------------------------------------------ input

const keys = new Set();
const pressed = new Set();     // this frame
let mouseDown = false;
let clicked = false;
let rightClicked = false;
let locked = false;
let camYaw = Math.PI, camPitch = 0.18, camDist = 3.6;

const typing = (e) => /INPUT|SELECT|TEXTAREA/.test(e.target?.tagName ?? '');
addEventListener('keydown', (e) => {
  if (typing(e)) return;
  if (['AltLeft', 'AltRight', 'Space', 'Tab', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight'].includes(e.code)) e.preventDefault();
  if (e.code === 'KeyW' && e.ctrlKey) e.preventDefault();   // (the browser may still close the tab: use fullscreen, F)
  if (!keys.has(e.code)) pressed.add(e.code);
  keys.add(e.code);
});
addEventListener('keyup', (e) => {
  if (e.code.startsWith('Alt')) e.preventDefault();
  keys.delete(e.code);
});
addEventListener('blur', () => keys.clear());
// The mouse is captured on the first click; where a page may not capture it
// (some embedded frames), right-drag turns the camera instead.
let active = false;
canvas.addEventListener('mousedown', (e) => {
  if (!active) {
    active = true;
    $('start').hidden = true;
    try { const r = canvas.requestPointerLock?.(); r?.catch?.(() => {}); } catch { /* not allowed */ }
    return;
  }
  if (!locked && e.button === 0 && !document.pointerLockElement) { try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* no */ } }
  if (e.button === 0) { mouseDown = true; clicked = true; }
  if (e.button === 2 && locked) rightClicked = true;   // (unlocked, right-drag turns the camera)
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
// The "Click to fight" box covers the view: clicking it starts the fight.
$('start').addEventListener('click', () => {
  active = true;
  $('start').hidden = true;
  try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* not allowed */ }
});
addEventListener('mouseup', (e) => { if (e.button === 0) mouseDown = false; });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
});
addEventListener('mousemove', (e) => {
  if (!locked && !(active && e.buttons & 2)) return;
  camYaw -= e.movementX * 0.0024;
  camPitch = THREE.MathUtils.clamp(camPitch + e.movementY * 0.002, -0.35, 0.9);
});
addEventListener('wheel', (e) => { camDist = THREE.MathUtils.clamp(camDist + Math.sign(e.deltaY) * 0.3, 2.2, 7); }, { passive: true });

async function fullscreen() {
  try {
    await document.documentElement.requestFullscreen();
    await navigator.keyboard?.lock?.();   // lets Ctrl (+W) reach the game in fullscreen
  } catch { /* not allowed here */ }
}

// ------------------------------------------------------------------ settings panel

function buildSettings() {
  const rows = [
    ['dodgeWindow', 'Perfect dodge window (s)', 0.05, 0.12, 0.005],
    ['parryWindow', 'Perfect parry window (s)', 0.05, 0.2, 0.005],
    ['blockReduction', 'Block damage reduction', 0.3, 0.9, 0.05],
    ['aiSkill', 'Enemy skill (parry, dodge, block)', 0, 1, 0.05],
  ];
  const box = $('settings-rows');
  for (const [k, label, min, max, step] of rows) {
    const row = document.createElement('label');
    row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${stats[k]}"><b>${stats[k]}</b>`;
    const input = row.querySelector('input');
    input.addEventListener('input', () => { stats[k] = Number(input.value); row.querySelector('b').textContent = input.value; saveStats(); });
    box.appendChild(row);
  }
}

// ------------------------------------------------------------------ animation panel
//
// Every move's clip, speed, hit and end time, and every pose slot's clip and
// speed, editable while playing; kept in this browser (Reset restores the
// built-in values, Copy JSON gives them to paste into skills.js).

const ANIM_KEY = 'character-creation:combat-anim';
const MOVES = [
  ['Light 1', ART.combo[0]], ['Light 2', ART.combo[1]], ['Light 3', ART.combo[2]], ['Heavy', ART.heavy],
  ['Air', ART.air], ['Dash', ART.dash], ['Feint strike', ART.skills.feint.strike],
  ...ART.enemy.map((m) => [`Enemy ${m.name}`, m]),
];
const BUILT_IN = JSON.parse(JSON.stringify({ moves: MOVES.map(([, m]) => pickMove(m)), slots: ANIM_SLOTS }));
function pickMove(m) { return { clip: m.clip, speed: m.speed ?? 1, hit: m.hit, end: m.end }; }
function readAnim() { try { return JSON.parse(localStorage.getItem(ANIM_KEY)) ?? null; } catch { return null; } }
function saveAnim() {
  const data = { moves: Object.fromEntries(MOVES.map(([k, m]) => [k, pickMove(m)])), slots: ANIM_SLOTS };
  try { localStorage.setItem(ANIM_KEY, JSON.stringify(data)); } catch { /* private mode */ }
  return data;
}
function applyAnim(data) {
  if (!data) return;
  // Saves from before the sword-arm locomotion hold the plain clips; drop those.
  const was = { run: 'Jog', sprint: 'Sprint', walk: 'Walk', guardForward: 'Walk', guardBack: 'Walk_Backwards', guardLeft: 'Strafe_left', guardRight: 'Strafe_right' };
  for (const [slot, clip] of Object.entries(was)) if (data.slots?.[slot]?.clip === clip) delete data.slots[slot];
  // Saves from before the finisher was sped up hold its old default; drop it.
  const old3 = data.moves?.['Light 3'];
  if (old3 && old3.clip === 'Sword_Regular_C' && old3.speed === 0.9 && old3.end === 0.75) delete data.moves['Light 3'];
  for (const [k, m] of MOVES) if (data.moves?.[k]) Object.assign(m, data.moves[k]);
  for (const [k, v] of Object.entries(data.slots ?? {})) if (ANIM_SLOTS[k]) Object.assign(ANIM_SLOTS[k], v);
}
applyAnim(readAnim());

function buildAnimPanel() {
  const box = $('anim-rows');
  box.innerHTML = '';
  const names = [...player.clips.keys()].filter((n) => !n.includes('#')).sort();
  const options = names.map((n) => `<option>${n}</option>`).join('');
  const num = (label, value, min, max, step, on) => {
    const l = document.createElement('label');
    l.className = 'num';
    l.innerHTML = `<span>${label}</span><input type="number" min="${min}" max="${max}" step="${step}" value="${value}">`;
    l.querySelector('input').addEventListener('change', (e) => { on(Number(e.target.value)); saveAnim(); });
    return l;
  };
  const row = (title, target, fields, preview) => {
    const r = document.createElement('div');
    r.className = 'anim-row';
    r.innerHTML = `<b>${title}</b><select>${options}</select><button type="button" title="Play">▶</button>`;
    const sel = r.querySelector('select');
    sel.value = target.clip;
    sel.addEventListener('change', () => { target.clip = sel.value; saveAnim(); });
    r.querySelector('button').addEventListener('click', () => preview());
    const f = document.createElement('div');
    f.className = 'anim-fields';
    for (const x of fields) f.appendChild(x);
    r.appendChild(f);
    box.appendChild(r);
  };
  const h = (t) => { const e = document.createElement('h4'); e.textContent = t; box.appendChild(e); };
  h('Moves');
  for (const [title, m] of MOVES) {
    row(title, m, [
      num('speed', m.speed ?? 1, 0.1, 3, 0.05, (v) => { m.speed = v; }),
      num('hit (s)', m.hit, 0, 5, 0.01, (v) => { m.hit = v; }),
      num('end (s)', m.end, 0, 5, 0.01, (v) => { m.end = v; }),
    ], () => { if (player.state !== 'dead') { player.comboIndex = -1; startMove(player, m); } });
  }
  h('Poses');
  for (const [slot, v] of Object.entries(ANIM_SLOTS)) {
    const fields = [num('speed', v.speed, 0.1, 3, 0.05, (x) => { v.speed = x; })];
    if ('hold' in v) fields.push(num('hold (s)', v.hold, 0, 3, 0.01, (x) => { v.hold = x; }));
    row(slot, v, fields, () => { player.setState('idle'); player.playSlot(slot, { loop: false, fade: 0.1 }); player.previewUntil = gameTime + 1.5; });
  }
}

function initAnimPanel() {
  buildAnimPanel();
  $('anim-reset').addEventListener('click', () => {
    MOVES.forEach(([, m], i) => Object.assign(m, BUILT_IN.moves[i]));
    for (const [k, v] of Object.entries(BUILT_IN.slots)) Object.assign(ANIM_SLOTS[k], v);
    try { localStorage.removeItem(ANIM_KEY); } catch { /* no */ }
    buildAnimPanel();
  });
  $('anim-copy').addEventListener('click', async () => {
    const json = JSON.stringify(saveAnim(), null, 2);
    try { await navigator.clipboard.writeText(json); message('Animation settings copied'); } catch { prompt('Copy:', json); }
  });
}

// ------------------------------------------------------------------ timing assist ring

// Drawn around the attacker's blade, facing the camera, closing on it as the blow comes.
const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffc640, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, depthTest: false }));
ring.renderOrder = 10;
ring.visible = false;
scene.add(ring);
let assist = true;

// ------------------------------------------------------------------ fighters

let player, enemy;
let gameTime = 0;
let timeScale = 1, slowUntil = 0, hitStop = 0;
let over = false;
const hitLog = [];

function startMove(f, move) {
  f.move = move;
  f.moveHit = false;
  f.pendingZone = null;
  f.moveSerial = (f.moveSerial ?? 0) + 1;   // the enemy reads each of the player's moves once
  f.bladePrev = null;
  f.setState('attack');
  f.play(move.clip, { loop: false, speed: move.speed ?? 1, fade: 0.08 });
  f.hitAt = gameTime + move.hit / (move.speed ?? 1);   // scheduled moment of the blow (game time)
  // The enemy aims too: mostly the body, often the legs, now and then the head.
  if (!f.isPlayer) {
    const r = Math.random();
    const want = aimHeightAt(player, r < 0.15 ? 'head' : r < 0.6 ? 'chest' : 'legs');
    f.aim = THREE.MathUtils.clamp((Math.max(want, move.aimFloor ?? 0) - (move.hitY ?? 1)) * AIM.perMetre, -AIM.max, AIM.max);
  }
  // Soft lock: close the gap to a target in front, so the blade ends at its body
  // (up to 2 m; a move's own lunge is the least it moves).
  const foe = f.isPlayer ? enemy : player;
  const gap = Math.sqrt(dist2(f, foe));
  const ahead = gap < 5 && inFront(f, foe, 5, 140);
  f.lungeLeft = Math.max(move.lunge ?? 0, ahead ? Math.min(2, gap - (move.reach ?? 0.95)) : 0);
  f.lungeTotal = f.lungeLeft;
  if (ahead) f.faceTarget(foe, 1, 1);
  if (move.unblockable) flashSword(f, 0xff2a2a); else if (!f.isPlayer) flashSword(f, 0xffe7a0);
  if (f.isPlayer) setTimeout(() => sound('swing'), (move.hit / (move.speed ?? 1)) * 700);
}

function flashSword(f, color) {
  f.sword.userData.steel.emissive.setHex(color);
  f.sword.userData.steel.emissiveIntensity = 0.9;
  f.flashUntil = gameTime + 0.6;
}

/** The blade of `att` touched `def`'s zone (or, for timing checks, would have). */
function resolveHit(att, def, zone) {
  const move = att.move;
  hitLog.push(`${att.isPlayer ? 'P' : 'E'}>${zone.name}`);
  att.moveHit = true;
  if (def.state === 'dead') return;
  // Timing is judged at the moment the blade touches (what the player sees).
  const sinceDodge = gameTime - (def.dodgeAt ?? -99);
  if (def.state === 'dodge' && sinceDodge >= 0 && sinceDodge <= stats.dodgeWindow + 0.02) {
    perfect(def, att, 'Perfect Dodge!');
    return;
  }
  if (gameTime < def.invulnUntil) return;
  // Perfect parry: a tap of parry within the window before the blow.
  const sinceParry = gameTime - (def.parryAt ?? -99);
  const facing = def.forward().angleTo(att.pos.clone().sub(def.pos).setY(0).normalize()) < THREE.MathUtils.degToRad(70);
  if (facing && !guardBroken(def) && sinceParry >= 0 && sinceParry <= stats.parryWindow + 0.02 && move.parryable !== false) {
    perfect(def, att, 'Perfect Parry!', true);
    return;
  }
  let dmg = move.damage * zone.damage;
  let crit = false;
  if (partBroken(att, 'armR')) dmg *= PART_RULES.armRDamage;
  if (partBroken(def, 'torso')) dmg *= PART_RULES.torsoDamage;
  if (gameTime < (def.dazedUntil ?? 0)) dmg *= PART_RULES.dazedDamage;
  if (gameTime < (att.counterUntil ?? 0)) dmg *= stats.counterBonus;
  if (Math.random() < CRIT.baseChance + zone.crit) { crit = true; dmg *= CRIT.damage; }
  // Blocking (holding parry, facing the attacker).
  const blocking = def.state === 'block' && facing && !guardBroken(def);
  if (blocking && move.guardBreak) {
    // A feint's real cut: the guard is broken.
    def.stamina = Math.max(0, def.stamina - 30);
    breakGuard(def);
    def.hp = Math.max(0, def.hp - dmg);
    hurtPart(def, zone, dmg);
    sound('crit');
    floatText(zone.a.clone().lerp(zone.b, 0.5), `Guard Break ${Math.round(dmg)}`, 'crit');
    hitStop = 0.1;
    fightShake(att, def, 0.09);
    if (def.hp <= 0) { die(def); return; }
    stagger(def, STAGGER.full, null);
    if (att.isPlayer) att.counterUntil = gameTime + 1.6;
    return;
  }
  if (blocking && !move.unblockable) {
    // A broken torso lets twice as much through the guard.
    const through = (def.isPlayer ? 1 - stats.blockReduction : 0.25) * (partBroken(def, 'torso') ? 1 / PART_RULES.torsoGuard : 1);
    dmg *= Math.min(1, through);
    crit = false;
    def.stamina -= (move.guardDamage ?? stats.blockCost) * (partBroken(def, 'armL') ? PART_RULES.armLGuardCost : 1);
    sound('block');
    fightShake(att, def, 0.04);
    sparks(zone.a.clone().lerp(zone.b, 0.5), 0xfff0b0);
    if (def.stamina <= 0) { def.stamina = 0; breakGuard(def); stagger(def, STAGGER.full, 'Guard Break'); }
    else floatText(zone.a, `Blocked ${Math.round(dmg)}`, 'blocked');
    recoil(att, def);
  } else {
    if (blocking && move.unblockable && def.isPlayer) message('Unblockable!', 'bad');
    sound(crit ? 'crit' : 'hit');
    floatText(zone.a.clone().lerp(zone.b, 0.5), `${crit ? 'CRIT ' : ''}${zone.label} ${Math.round(dmg)}`, crit ? 'crit' : def.isPlayer ? 'taken' : '');
    hitStop = crit ? 0.1 : 0.05;
    fightShake(att, def, crit ? 0.09 : 0.06);
  }
  def.hp = Math.max(0, def.hp - dmg);
  hitLog.push(`  ${Math.round(dmg * 10) / 10}${blocking && !move.unblockable ? ' blocked' : ''}`);
  if (def.hp <= 0) { die(def); return; }
  if (!blocking || move.unblockable) {
    if (hurtPart(def, zone, dmg) === 'head') return;   // dazed
    addPoise(def, move, dmg);
    // Flinch, unless attacking with armour (the enemy's heavy blows) and not a
    // staggering blow; a full stagger gauge staggers anyway.
    const armoured = def.state === 'attack' && def.move?.unblockable;
    if (def.poise >= STAGGER.gauge) flinch(def, att, true);
    else if (!armoured && (def.state !== 'attack' || move.stagger || def.isPlayer)) flinch(def, att, move.stagger);
  }
}

/** Shake the screen when the player lands a blow or takes one (blocked too); landing one shakes a little less. */
function fightShake(att, def, amount) {
  if (def.isPlayer) shake(amount);
  else if (att.isPlayer) shake(amount * 0.6);
}

// ------------------------------------------------------------------ body parts

function makeParts(maxHp) {
  return Object.fromEntries(Object.entries(BODY_PARTS).map(([k, p]) => [k, { max: maxHp * p.share, hp: maxHp * p.share, broken: false, hitAt: -99 }]));
}
/** The body part a hit zone belongs to. */
function partOf(zone) {
  const side = zone.from.startsWith('Left') ? 'L' : 'R';
  if (zone.name === 'head' || zone.name === 'neck') return 'head';
  if (zone.name === 'arm') return `arm${side}`;
  if (zone.name === 'leg') return `leg${side}`;
  return 'torso';
}
function partBroken(f, key) { return !!f.parts?.[key]?.broken; }
function legsBroken(f) { return partBroken(f, 'legL') || partBroken(f, 'legR'); }
/** Movement multiplier: a broken leg slows walking, running, dodging and jumping. */
function legMul(f) { return legsBroken(f) ? PART_RULES.legSpeed : 1; }

/** Take a landed blow's damage off its part; returns the part's key if it broke now. */
function hurtPart(f, zone, dmg) {
  const key = partOf(zone), part = f.parts[key];
  part.hp = Math.max(0, part.hp - dmg);
  part.hitAt = gameTime;
  if (part.hp > 0 || part.broken) return null;
  part.broken = true;
  const at = zone.a.clone().lerp(zone.b, 0.5);
  const text = { head: 'Head broken — dazed', torso: 'Torso broken — defence down', armR: 'Sword arm broken — damage −60%',
    armL: 'Off arm broken — guard costs more', legL: 'Leg broken — speed −60%', legR: 'Leg broken — speed −60%' }[key];
  floatText(at, text, 'status');
  if (f.isPlayer) message(text, 'bad'); else message(text, 'good');
  sound('crit');
  if (key === 'head') {
    // Dazed: reeling on the spot, every blow doubled.
    f.dazedUntil = gameTime + PART_RULES.headDaze;
    f.move = null;
    f.comboIndex = -1;
    f.setState('stagger');
    f.hitDur = PART_RULES.headDaze;
    f.playSlot('daze', { loop: true, fade: 0.1 });
    shake(0.08);
  }
  return key;
}
function healParts(f, dt) {
  for (const part of Object.values(f.parts)) {
    if (gameTime - part.hitAt < PART_RULES.regenAfter || part.hp >= part.max) continue;
    part.hp = Math.min(part.max, part.hp + part.max * PART_RULES.regen * dt);
    if (part.broken && part.hp >= part.max * PART_RULES.mendAt) part.broken = false;
  }
}

// A broken guard cannot block or parry for this long.
const GUARD_BROKEN = 5;
function breakGuard(f) {
  f.guardBrokenUntil = gameTime + GUARD_BROKEN;
  if (f.state === 'block') { f.setState('idle'); f.setUpper(null); }
  if (f.isPlayer) message(`Guard broken — no guard or parry for ${GUARD_BROKEN} s`, 'bad');
}
function guardBroken(f) { return gameTime < (f.guardBrokenUntil ?? 0); }

function perfect(def, att, text, parry = false) {
  // The enemy pulls these off too: then it is bad news, and no slow motion or screen flash.
  if (def.isPlayer) message(text, 'good'); else message(parry ? 'Parried!' : 'Dodged!', 'bad');
  sound('perfect');
  def.invulnUntil = gameTime + 0.4;
  def.counterUntil = gameTime + 1.6;
  // (A parry's slow motion is short: the attacker's 0.3 s stagger should still feel short.)
  if (def.isPlayer) slowUntil = gameTime + (parry ? 0.1 : 0.6);
  if (!def.isPlayer) { def.think = parry ? 0.3 : 0.05; def.plan = null; }   // and it counters
  if (parry) {
    const at = def.sword.localToWorld(def.sword.userData.tip.clone().multiplyScalar(0.6));
    stagger(att, STAGGER.perfect, null);
    // The parrier sweeps the other blade aside, out from the body (attacks may cut it short after 0.12 s).
    def.move = null;
    def.setState('push');
    def.setUpper(null);
    def.play('Parry_Sweep', { loop: false, fade: 0.04 });
    att.vel.copy(att.pos.clone().sub(def.pos).setY(0).normalize().multiplyScalar(2.5));
    hitStop = 0.08;
    shake(0.05);
    perfectFx(at, 0xf0a800, true, def.isPlayer);
  } else {
    att.exposedUntil = gameTime + 1.2;
    perfectFx(def.zones[2].a.clone(), 0x1e9bff, false, def.isPlayer);
  }
}

// A blow costs 0.2 s of hit-stun (no knock-downs) and fills the stagger
// gauge; a full gauge staggers for STAGGER.full seconds and empties.
const STAGGER = { hitStun: 0.2, recoil: 0.1, full: 1.0, perfect: 0.3, gauge: 100, perDamage: 2, decay: 25, decayAfter: 1.5 };
function flinch(f, att, hard) {
  f.move = null;
  f.comboIndex = -1;
  const push = f.pos.clone().sub(att.pos).setY(0).normalize();
  f.vel.copy(push.multiplyScalar(hard ? 2.2 : 1.2));
  if (f.poise >= STAGGER.gauge) { f.poise = 0; stagger(f, STAGGER.full, 'Staggered'); return; }
  f.setState('hit');
  f.hitDur = STAGGER.hitStun;
  f.playSlot(Math.random() < 0.5 ? 'hitLight' : 'hitLight2', { loop: false, fade: 0.04 });
}

function addPoise(f, move, dmg) {
  f.poise = Math.min(STAGGER.gauge, (f.poise ?? 0) + (move.poise ?? dmg * STAGGER.perDamage));
  f.poiseAt = gameTime;
}

/** While staggering, the fighter is carried back with its steps (at least 0.75 m/s for 0.9 s). */
function staggerDrift(f) {
  if (f.state !== 'stagger' || f.t > 0.9 || gameTime < (f.dazedUntil ?? 0)) return;
  const back = f.forward(new THREE.Vector3()).negate();
  f.vel.copy(back.multiplyScalar(Math.max(0.75, f.vel.dot(back))));
}

/**
 * A blow stopped by a guard: the attacker's blade bounces off and they are
 * held for STAGGER.recoil s (the swing runs backwards a little), the combo cut short.
 */
function recoil(att, def) {
  att.move = null;
  att.comboIndex = -1;
  att.queued = false;
  att.setState('recoil');
  att.hitDur = STAGGER.recoil;
  if (att.action) att.action.timeScale = -0.8 * Math.abs(att.action.timeScale || 1);
  att.vel.copy(att.pos.clone().sub(def.pos).setY(0).normalize().multiplyScalar(1.2));
}

function stagger(f, dur, text) {
  f.move = null;
  f.setState('stagger');
  f.hitDur = dur;
  // A short stagger plays the reel faster, so it shows more than its first moment.
  f.playSlot('stagger', { loop: false, fade: 0.06, speed: ANIM_SLOTS.stagger.speed * Math.max(1, 0.6 / dur) });
  if (text) floatText(f.zones[0].a, text, 'status');
}

function die(f) {
  f.move = null;
  f.setState('dead');
  f.playSlot('death', { loop: false, fade: 0.1 });
  over = true;
  message(f.isPlayer ? 'Defeated — press R to try again' : 'Victory — press R to fight again', f.isPlayer ? 'bad' : 'good');
}

// ------------------------------------------------------------------ perfect parry / dodge effects
// A flash over the screen, a shockwave and a burst of streaks at the point,
// and a quick zoom-in of the camera; they run on real time (through the slow motion).
const fxList = [];
const flashEl = document.createElement('div');
flashEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;opacity:0';
document.getElementById('view').after(flashEl);   // under the HUD and panels
let flashLife = 1, fovKick = 0;
function perfectFx(pos, color, parry, screen = true) {
  const c = new THREE.Color(color);
  // The room is white: the effects are strong colours drawn normally (additive light would vanish).
  if (screen) {
    flashEl.style.background = `radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 35%, #${c.getHexString()}cc 100%)`;
    flashLife = 0;
    fovKick = parry ? 7 : 5;
  }
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, side: THREE.DoubleSide, depthWrite: false, depthTest: false });
  for (const [delay, thick] of [[0, 0.82], [0.07, 0.9]]) {
    const wave = new THREE.Mesh(new THREE.RingGeometry(thick, 1, 64), ringMat.clone());
    wave.position.copy(pos);
    wave.renderOrder = 11;
    wave.visible = false;
    scene.add(wave);
    fxList.push({ kind: 'wave', m: wave, life: -delay, dur: 0.4, size: parry ? 1.6 : 2.2 });
  }
  const n = parry ? 22 : 12;
  for (let i = 0; i < n; i++) {
    const streak = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, parry ? 0.22 : 0.3),
      new THREE.MeshBasicMaterial({ color: i % 3 ? color : 0xfff4c0, transparent: true, depthWrite: false, depthTest: false }));
    const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * (parry ? 1 : 0.4) - 0.2, Math.random() - 0.5).normalize();
    streak.position.copy(pos);
    streak.lookAt(pos.clone().add(dir));
    streak.renderOrder = 11;
    scene.add(streak);
    fxList.push({ kind: 'streak', m: streak, life: 0, dur: 0.35 + Math.random() * 0.15, vel: dir.multiplyScalar(parry ? 5 + Math.random() * 4 : 3 + Math.random() * 2) });
  }
  if (parry) sparks(pos, 0xffd040);
}
function updateFx(real) {
  for (let i = fxList.length - 1; i >= 0; i--) {
    const f = fxList[i];
    f.life += real;
    if (f.life < 0) continue;
    const k = f.life / f.dur;
    if (k >= 1) { scene.remove(f.m); f.m.geometry.dispose(); f.m.material.dispose(); fxList.splice(i, 1); continue; }
    if (f.kind === 'wave') {
      f.m.visible = true;
      f.m.quaternion.copy(camera.quaternion);
      f.m.scale.setScalar(0.1 + f.size * (1 - (1 - k) ** 3));
      f.m.material.opacity = 1 - k;
    } else {
      f.m.position.addScaledVector(f.vel, real);
      f.vel.multiplyScalar(Math.exp(-real * 6));
      f.vel.y -= 4 * real;
      f.m.material.opacity = 1 - k;
    }
  }
  flashLife += real;
  flashEl.style.opacity = String(Math.max(0, 0.75 * (1 - flashLife / 0.35)));
  if (fovKick > 0.01) {
    camera.fov = 55 - fovKick * Math.min(1, flashLife / 0.06);
    fovKick *= Math.exp(-real * 5);
    camera.updateProjectionMatrix();
  } else if (camera.fov !== 55) { camera.fov = 55; camera.updateProjectionMatrix(); }
}

// ------------------------------------------------------------------ sword trails
// A ribbon behind the blade while it is live (from just before a move's
// blow to just after), fading over 0.14 s of game time.
const TRAIL = { samples: 28, life: 0.14, before: 0.2, after: 0.12 };
class SwordTrail {
  constructor() {
    const n = TRAIL.samples;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 2 * 4), 4));
    const index = [];
    for (let i = 0; i < n - 1; i++) { const a = i * 2; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setIndex(index);
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    scene.add(this.mesh);
    this.points = [];
    this.color = new THREE.Color();
  }
  update(f) {
    const m = f.move, mt = f.moveTime();
    if (f.state === 'attack' && m && mt >= m.hit - (m.trail ?? TRAIL.before) && mt <= m.hit + TRAIL.after) {
      this.color.setHex(f.isPlayer ? 0x2f7fff : m.unblockable ? 0xff2a2a : 0xf0a800);
      this.points.unshift({ a: f.sword.localToWorld(new THREE.Vector3(0, 0.3, 0)), b: f.sword.localToWorld(f.sword.userData.tip.clone()), t: gameTime });
    }
    while (this.points.length && (this.points.length > TRAIL.samples || gameTime - this.points[this.points.length - 1].t > TRAIL.life)) this.points.pop();
    const pos = this.mesh.geometry.attributes.position, col = this.mesh.geometry.attributes.color;
    const c = this.color;
    this.points.forEach((p, i) => {
      const k = Math.max(0, 1 - (gameTime - p.t) / TRAIL.life) * (1 - i / TRAIL.samples);
      pos.setXYZ(i * 2, p.a.x, p.a.y, p.a.z);
      pos.setXYZ(i * 2 + 1, p.b.x, p.b.y, p.b.z);
      col.setXYZW(i * 2, c.r, c.g, c.b, 0.1 * k);
      col.setXYZW(i * 2 + 1, c.r, c.g, c.b, 0.85 * k);
    });
    pos.needsUpdate = col.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, Math.max(0, this.points.length - 1) * 6);
  }
}
const trails = new Map();
function updateTrails() {
  for (const f of [player, enemy]) {
    if (!trails.has(f)) trails.set(f, new SwordTrail());
    trails.get(f).update(f);
  }
}

const sparkPool = [];
function sparks(pos, color) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), new THREE.MeshBasicMaterial({ color, transparent: true }));
  m.position.copy(pos);
  scene.add(m);
  sparkPool.push({ m, life: 0 });
}

/** Blade contact while the move's blade is live. */
function bladeStep(att, def) {
  const move = att.move;
  if (!move || att.moveHit) return;
  const mt = att.moveTime();
  const live = mt >= move.hit - BLADE_ACTIVE.before && mt <= move.hit + BLADE_ACTIVE.after;
  const now = att.blade();
  if (live && att.bladePrev) {
    // A timed defence counts at the scheduled blow even if the blade would graze nothing yet.
    const due = gameTime >= att.hitAt && inFront(att, def, move.range, move.arc);
    // A blade that touches before the blow's scheduled moment (the aim tilts the swing)
    // lands at that moment: the timing ring and the parry / dodge windows stay true.
    const zone = att.pendingZone ?? bladeContact(att.bladePrev, now, def);
    if (zone && gameTime < att.hitAt - 0.02) att.pendingZone = zone;
    else if (zone) { att.pendingZone = null; resolveHit(att, def, zone); }
    else if (due && !att.timedChecked) {
      att.timedChecked = true;
      const sinceDodge = att.hitAt - (def.dodgeAt ?? -99);
      const sinceParry = att.hitAt - (def.parryAt ?? -99);
      if (def.state === 'dodge' && sinceDodge >= 0 && sinceDodge <= stats.dodgeWindow + 0.02) { att.moveHit = true; perfect(def, att, 'Perfect Dodge!'); }
      else if (!guardBroken(def) && sinceParry >= 0 && sinceParry <= stats.parryWindow + 0.02 && move.parryable !== false) { att.moveHit = true; perfect(def, att, 'Perfect Parry!', true); }
    }
  }
  att.bladePrev = now;
}

// ------------------------------------------------------------------ player control

const tmp = new THREE.Vector3();
function playerUpdate(dt) {
  const p = player;
  p.t += dt;
  // Movement input relative to the camera.
  const fwd = new THREE.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw)).negate();
  const right = new THREE.Vector3(fwd.z, 0, -fwd.x).negate();
  const wish = new THREE.Vector3();
  if (keys.has('KeyW')) wish.add(fwd);
  if (keys.has('KeyS')) wish.sub(fwd);
  if (keys.has('KeyD')) wish.add(right);
  if (keys.has('KeyA')) wish.sub(right);
  if (wish.lengthSq()) wish.normalize();
  const sprintKey = keys.has('ControlLeft') || keys.has('ControlRight') || keys.has('KeyC');
  const blockKey = (keys.has('ShiftLeft') || keys.has('ShiftRight')) && !guardBroken(p);
  const attackPress = clicked;
  const dodgePress = pressed.has('AltLeft') || pressed.has('AltRight');
  const parryPress = (pressed.has('ShiftLeft') || pressed.has('ShiftRight')) && !guardBroken(p);
  const jumpPress = pressed.has('Space');
  const heavyPress = rightClicked || pressed.has('KeyQ');
  if (parryPress) p.parryAt = gameTime;

  // The parry sweep plays out unless an action cuts it off (after 0.12 s).
  const cutPush = p.state === 'push' && p.t > 0.12 && (attackPress || heavyPress || dodgePress || jumpPress || pressed.has(ART.skills.feint.key));
  const canAct = ['idle', 'move', 'block'].includes(p.state) || (p.state === 'recover' && p.t > 0.12) || cutPush;
  const afterHit = p.state === 'attack' && p.moveHit;

  if (p.state === 'dead') { /* nothing */ } else if (p.state === 'hit' || p.state === 'stagger' || p.state === 'recoil') {
    if (p.t > p.hitDur) p.setState('idle');
    if (p.state === 'hit' && p.t > 0.25 && dodgePress) doDodge(wish);
  } else if (dodgePress && (canAct || afterHit || p.state === 'feint' || p.state === 'attack' && p.t < 0.1) && p.stamina >= stats.dodgeCost && p.grounded) {
    doDodge(wish);
  } else if (p.state === 'push' && !cutPush) {
    p.vel.set(0, 0, 0);
    if (p.t > 0.35) p.setState('idle');
  } else if (p.state === 'dodge') {
    const k = p.t < 0.32 ? 1 : 0;
    p.vel.copy(p.dodgeDir).multiplyScalar(k * 8.5 * legMul(p) * (1 - p.t / 0.32));
    if (p.t > 0.5) p.setState('idle');
  } else if (p.state === 'attack') {
    const mt = p.moveTime();
    if (attackPress && mt >= (p.move.chainFrom ?? p.move.hit)) p.queued = true;
    // Lunge over the wind-up, towards the enemy if near.
    if (p.lungeLeft > 0 && mt < p.move.hit) {
      const step = Math.min(p.lungeLeft, (p.lungeTotal / Math.max(p.move.hit / (p.move.speed ?? 1), 0.05)) * dt);
      const dEnemy = enemy.pos.distanceTo(p.pos);
      if (dEnemy > 0.75) p.pos.addScaledVector(p.forward(tmp), step);
      p.lungeLeft -= step;
    }
    if (dist2(p, enemy) < 4.5 * 4.5 && mt < p.move.hit) p.faceTarget(enemy, dt, 18);
    if (mt >= p.move.end) {
      if (p.queued && p.move !== ART.air && p.move !== ART.dash && p.comboIndex < ART.combo.length - 1) {
        p.comboIndex++;
        p.queued = false;
        startMove(p, ART.combo[p.comboIndex]);
      } else {
        const rec = p.move.rec, recFade = p.move.recFade ?? 0.1;
        p.move = null;
        p.queued = false;
        // rec 'idle': ease straight back into the stance (a recovery clip of its own would twirl the blade).
        if (rec) { p.setState('recover'); if (rec === 'idle') p.playSlot('idle', { fade: recFade }); else p.play(rec, { loop: false, fade: recFade, speed: 1.3 }); } else p.setState('idle');
        if (!rec) p.comboIndex = -1;
      }
    }
  } else if (p.state === 'recover') {
    if (attackPress && p.comboIndex >= 0 && p.comboIndex < ART.combo.length - 1) {
      p.comboIndex++;
      startMove(p, ART.combo[p.comboIndex]);
    } else if (p.t > 0.55 || (wish.lengthSq() && p.t > 0.2)) {
      p.comboIndex = -1;
      p.setState('idle');
    }
  }

  // Feint (skill key): the bait wind-up, then the real cut.
  const feint = ART.skills.feint;
  if (p.state === 'feint') {
    if (dist2(p, enemy) < 4.5 * 4.5) p.faceTarget(enemy, dt, 14);
    if (p.t * feint.bait.speed >= feint.bait.until) { p.comboIndex = -1; startMove(p, feint.strike); }
  }
  if (heavyPress && afterHit && p.move !== ART.heavy && p.grounded && p.stamina >= ART.heavy.stamina) {
    p.comboIndex = -1;
    p.stamina -= ART.heavy.stamina;
    startMove(p, ART.heavy);
  } else if (pressed.has(feint.key) && (canAct || afterHit) && p.grounded && gameTime >= (p.feintReady ?? 0) && p.stamina >= feint.stamina) {
    p.stamina -= feint.stamina;
    p.feintReady = gameTime + feint.cooldown;
    p.move = null;
    p.comboIndex = -1;
    p.setState('feint');
    p.play(feint.bait.clip, { loop: false, speed: feint.bait.speed, fade: 0.08 });
    p.vel.set(0, 0, 0);
  } else if (canAct && p.state !== 'dodge' && p.state !== 'attack') {
    if (attackPress) {
      if (!p.grounded) { p.comboIndex = -1; startMove(p, ART.air); p.vy = Math.min(p.vy, -2); }
      else if (p.sprinting && p.stamina > 10) { p.comboIndex = -1; p.stamina -= 10; startMove(p, ART.dash); }
      else { p.comboIndex = 0; startMove(p, ART.combo[0]); }
    } else if (jumpPress && p.grounded && p.stamina >= stats.jumpCost) {
      p.vy = 5.4 * (legsBroken(p) ? 0.6 : 1);   // a jump only drops to 60% (the -60% left no jump at all)
      p.grounded = false;
      p.stamina -= stats.jumpCost;
      p.playSlot('jump', { fade: 0.1 });
    } else if (blockKey && p.grounded) {
      // Guard (parry held): walk slowly with the guard up, facing the enemy.
      if (p.state !== 'block') p.setState('block');
      const near = dist2(p, enemy) < 8 * 8;
      if (near) p.faceTarget(enemy, dt, 10); else if (wish.lengthSq()) p.turnTo(Math.atan2(wish.x, wish.z), dt, 8);
      p.vel.copy(wish).multiplyScalar(stats.guardSpeed * legMul(p));
      const g = ANIM_SLOTS.guard;
      // The guard is drawn only once the parry window has passed: a parry that
      // lands goes straight into its shove without the guard coming up first.
      if (p.t < stats.parryWindow) { /* still the parry tap */ } else if (wish.lengthSq()) {
        // Legs by the step's direction against the facing; the guard on top.
        const f = p.forward(tmp);
        const fwd = wish.dot(f), side = wish.x * f.z - wish.z * f.x;
        const legs = Math.abs(fwd) >= Math.abs(side) ? (fwd >= 0 ? 'guardForward' : 'guardBack') : (side > 0 ? 'guardLeft' : 'guardRight');
        p.play(ANIM_SLOTS[legs].clip, { speed: ANIM_SLOTS[legs].speed, part: 'lower', fade: 0.15 });
        p.setUpper(g.clip, { hold: g.hold, speed: g.speed });
      } else if (p.action?.getClip().name !== g.clip || p.upper) {
        const a = p.play(g.clip, { loop: false, speed: g.speed, fade: 0.1 });
        if (a) a.holdAt = g.hold;
      }
    } else if (heavyPress && p.grounded && p.stamina >= ART.heavy.stamina) {
      p.comboIndex = -1;
      p.stamina -= ART.heavy.stamina;
      startMove(p, ART.heavy);
    } else {
      if (p.state === 'block') { p.setState('idle'); p.setUpper(null); }
      const moving = wish.lengthSq() > 0;
      p.sprinting = moving && sprintKey && p.stamina > 1;
      const speed = p.sprinting ? stats.sprintSpeed : stats.runSpeed;
      p.vel.copy(wish).multiplyScalar(speed * legMul(p));
      if (moving) p.turnTo(Math.atan2(wish.x, wish.z), dt, 12);
      if (p.grounded && !(gameTime < (p.previewUntil ?? 0) && !moving)) {
        p.playSlot(moving ? (p.sprinting ? 'sprint' : 'run') : 'idle', { fade: 0.18 });
        p.state = moving ? 'move' : 'idle';
      }
    }
  }
  if (p.state !== 'move') p.sprinting = false;
  if (p.state === 'attack' || p.state === 'recover' || p.state === 'stagger' || p.state === 'feint') p.vel.multiplyScalar(Math.max(0, 1 - dt * 10));
  if (p.state === 'hit' || p.state === 'recoil') p.vel.multiplyScalar(Math.max(0, 1 - dt * 6));
  staggerDrift(p);

  // Stamina.
  if (p.sprinting) p.stamina -= stats.sprintCost * dt;
  else if (p.state !== 'block' && p.state !== 'dodge') p.stamina += stats.staminaRegen * dt;
  p.stamina = THREE.MathUtils.clamp(p.stamina, 0, stats.maxStamina);

  physics(p, dt);
  if (!p.grounded && p.state !== 'attack') p.playSlot('jump', { fade: 0.1 });
}

function doDodge(wish) {
  const p = player;
  p.move = null;
  p.comboIndex = -1;
  p.queued = false;
  p.stamina -= stats.dodgeCost;
  p.dodgeAt = gameTime;
  p.setState('dodge');
  // Side step relative to the enemy: left / right / back from the input.
  const toEnemy = enemy.pos.clone().sub(p.pos).setY(0).normalize();
  const side = new THREE.Vector3(toEnemy.z, 0, -toEnemy.x);
  let dir, clip;
  if (wish.lengthSq() === 0 || wish.dot(toEnemy) < -0.5) { dir = toEnemy.clone().negate(); clip = 'dodgeBack'; }
  else if (wish.dot(side) >= 0) { dir = side; clip = 'dodgeLeft'; }
  else { dir = side.clone().negate(); clip = 'dodgeRight'; }
  if (wish.lengthSq() && wish.dot(toEnemy) > 0.5) { dir = wish.clone(); clip = 'dodgeLeft'; }
  p.dodgeDir = dir;
  p.yaw = Math.atan2(toEnemy.x, toEnemy.z);
  p.playSlot(clip, { loop: false, fade: 0.05 });
}

function dist2(a, b) { return (a.pos.x - b.pos.x) ** 2 + (a.pos.z - b.pos.z) ** 2; }

function physics(f, dt) {
  f.pos.x += f.vel.x * dt;
  f.pos.z += f.vel.z * dt;
  if (!f.grounded || f.vy > 0) {
    f.vy -= 14 * dt;
    f.pos.y += f.vy * dt;
    if (f.pos.y <= 0) {
      f.pos.y = 0;
      f.vy = 0;
      if (!f.grounded) { f.grounded = true; if (f.state !== 'attack') f.setState('idle'); }
    } else f.grounded = false;
  }
  f.pos.x = THREE.MathUtils.clamp(f.pos.x, -ROOM + 0.5, ROOM - 0.5);
  f.pos.z = THREE.MathUtils.clamp(f.pos.z, -ROOM + 0.5, ROOM - 0.5);
}

// ------------------------------------------------------------------ enemy AI

// ------------------------------------------------------------------ enemy: defending like a player
// Each of the player's moves is read once, when it starts: if the enemy is
// free and in reach it plans a perfect parry, a dodge or a block, timed on
// the blow with a human reaction time and an error, or just takes it.
// How well it defends follows stats.aiSkill (0..1, the Stats panel).
function aiFor(skill) {
  return {
    parry: 0.36 * skill, dodge: 0.3 * skill, block: 0.2 + 0.2 * skill,   // chances per player move (the rest: no defence)
    reaction: 0.24 - 0.1 * skill,   // s needed to react to a move: quicker blows can only be blocked or taken
    error: 0.1 - 0.07 * skill,      // s, spread of its timing (the parry window is 0.12 s, the dodge's 0.08 s)
  };
}
function enemyRead(e, d) {
  const p = player;
  const AI = aiFor(stats.aiSkill ?? 0.5);
  if (e.plan && (p.state !== 'attack' || p.moveHit || p.moveSerial !== e.plan.serial)) e.plan = null;
  if (p.state === 'attack' && p.move && p.moveSerial !== e.seenSerial) {
    e.seenSerial = p.moveSerial;
    const free = ['idle', 'chase', 'strafe', 'recover', 'block'].includes(e.state);
    const lead = p.hitAt - gameTime;
    if (free && d < (p.move.range ?? 2) + 1.2 && lead > 0) {
      const r = Math.random();
      const jitter = () => (Math.random() + Math.random() - 1) * AI.error;
      if (lead >= AI.reaction && r < AI.parry && !guardBroken(e) && p.move.parryable !== false) {
        e.plan = { kind: 'parry', at: p.hitAt - stats.parryWindow * 0.5 + jitter(), serial: p.moveSerial };
      } else if (lead >= AI.reaction && r < AI.parry + AI.dodge && e.stamina >= stats.dodgeCost) {
        e.plan = { kind: 'dodge', at: p.hitAt - stats.dodgeWindow * 0.5 + jitter(), serial: p.moveSerial };
      } else if (r < AI.parry + AI.dodge + AI.block && !guardBroken(e) && !p.move.unblockable) {
        e.plan = { kind: 'block', at: gameTime + Math.min(Math.max(0, lead - 0.05), AI.reaction), serial: p.moveSerial };
      }
    }
  }
  if (!e.plan || gameTime < e.plan.at) return;
  const kind = e.plan.kind;
  e.plan = null;
  if (!['idle', 'chase', 'strafe', 'recover', 'block'].includes(e.state)) return;
  if (kind === 'dodge') {
    e.stamina -= stats.dodgeCost;
    e.dodgeAt = gameTime;
    e.move = null;
    e.setState('dodge');
    const toP = p.pos.clone().sub(e.pos).setY(0).normalize();
    const side = new THREE.Vector3(toP.z, 0, -toP.x);
    const r = Math.random();
    let slot;
    if (r < 0.4) { e.dodgeDir = side; slot = 'dodgeLeft'; } else if (r < 0.8) { e.dodgeDir = side.clone().negate(); slot = 'dodgeRight'; } else { e.dodgeDir = toP.clone().negate(); slot = 'dodgeBack'; }
    e.yaw = Math.atan2(toP.x, toP.z);
    e.playSlot(slot, { loop: false, fade: 0.05 });
  } else {
    // A parry is a tap of the guard: held a moment, it blocks if the timing was off.
    if (kind === 'parry') e.parryAt = gameTime;
    e.setState('block');
    e.blockFor = kind === 'parry' ? 0.4 : 0.6 + Math.random() * 0.4;
    const a = e.playSlot('guard', { loop: false, fade: 0.08 });
    if (a) a.holdAt = ANIM_SLOTS.guard.hold;
  }
}

function enemyUpdate(dt) {
  const e = enemy;
  e.t += dt;
  const d = Math.sqrt(dist2(e, player));
  if (e.state === 'dead') return;
  if (player.state === 'dead') { e.playSlot('idle'); e.vel.set(0, 0, 0); physics(e, dt); return; }
  e.think = (e.think ?? 1) - dt;
  if (e.state !== 'block' && e.state !== 'dodge') e.stamina = Math.min(stats.maxStamina, e.stamina + stats.staminaRegen * dt);
  enemyRead(e, d);
  switch (e.state) {
    case 'dodge': {
      const k = e.t < 0.32 ? 1 : 0;
      e.vel.copy(e.dodgeDir).multiplyScalar(k * 8.5 * legMul(e) * (1 - e.t / 0.32));
      if (e.t > 0.5) { e.setState('idle'); e.think = Math.min(e.think, 0.1); }
      break;
    }
    case 'push':
      e.vel.set(0, 0, 0);
      e.faceTarget(player, dt, 10);
      if (e.t > 0.35) { e.setState('idle'); e.think = 0; }
      break;
    case 'hit':
    case 'stagger':
    case 'recoil':
      e.vel.multiplyScalar(Math.max(0, 1 - dt * 6));
      staggerDrift(e);
      if (e.t > e.hitDur) { e.setState('idle'); e.think = 0.25 + Math.random() * 0.4; }
      break;
    case 'attack': {
      const mt = e.moveTime();
      if (mt < e.move.hit) e.faceTarget(player, dt, 6);
      if (e.lungeLeft > 0 && mt < e.move.hit && d > 0.75) {
        const step = Math.min(e.lungeLeft, (e.lungeTotal / (e.move.hit / e.move.speed)) * dt);
        e.pos.addScaledVector(e.forward(tmp), step);
        e.lungeLeft -= step;
      }
      if (mt >= e.move.end) {
        const next = e.move.next && Math.random() < e.move.nextChance && d < 3 ? ART.enemy.find((m) => m.name === e.move.next) : null;
        if (next) { e.timedChecked = false; startMove(e, next); }
        else {
          const rec = e.move.rec;
          e.move = null;
          e.setState('recover');
          if (rec && rec !== 'idle') e.play(rec, { loop: false, fade: 0.1 }); else e.playSlot('idle', { fade: 0.25 });
          e.think = 0.7 + Math.random() * 0.6;
        }
      }
      e.vel.multiplyScalar(Math.max(0, 1 - dt * 10));
      break;
    }
    case 'block':
      e.faceTarget(player, dt, 8);
      e.vel.set(0, 0, 0);
      if (e.t > e.blockFor) { e.setState('idle'); e.think = 0.2; }
      break;
    case 'strafe': {
      e.faceTarget(player, dt, 8);
      const toP = player.pos.clone().sub(e.pos).setY(0).normalize();
      const side = new THREE.Vector3(toP.z, 0, -toP.x).multiplyScalar(e.strafeDir);
      e.vel.copy(side).multiplyScalar(1.6).addScaledVector(toP, (d - 2.2) * 0.8).multiplyScalar(legMul(e));
      if (e.t > e.strafeFor) { e.setState('idle'); e.think = 0; }
      break;
    }
    default: {   // idle, chase, recover
      e.faceTarget(player, dt, 6);
      if (e.state === 'recover' && e.think > 0) { e.vel.multiplyScalar(0.8); break; }
      if (d > 2.4) {
        e.state = 'chase';
        const toP = player.pos.clone().sub(e.pos).setY(0).normalize();
        const speed = d > 6 ? 3.8 : 2.2;
        e.vel.copy(toP).multiplyScalar(speed * legMul(e));
        e.playSlot(d > 6 ? 'run' : 'walk', { fade: 0.2 });
      } else {
        e.vel.multiplyScalar(0.7);
        e.state = 'idle';
        e.playSlot('idle', { fade: 0.2 });
        // Swings are read in enemyRead; a feint's wind-up looks like a heavy blow, and is often met with a guard.
        const bait = player.state === 'feint' && Math.random() < dt * 6;
        if (!guardBroken(e) && bait) {
          e.setState('block');
          e.blockFor = 0.7 + Math.random() * 0.5;
          { const a = e.playSlot('guard', { loop: false, fade: 0.08 }); if (a) a.holdAt = ANIM_SLOTS.guard.hold; }
          break;
        }
        if (e.think <= 0) {
          const r = Math.random();
          if (r < 0.68) {
            const pool = ART.enemy.filter((m) => m.name !== 'slash2');
            const pick = Math.random() < 0.22 ? pool.find((m) => m.name === 'heavy') : pool[Math.floor(Math.random() * pool.length)];
            e.timedChecked = false;
            startMove(e, pick);
          } else if (r < 0.88) {
            e.setState('strafe');
            e.strafeDir = Math.random() < 0.5 ? 1 : -1;
            e.strafeFor = 0.8 + Math.random() * 0.8;
            e.playSlot(e.strafeDir > 0 ? 'guardLeft' : 'guardRight', { fade: 0.2 });
          } else if (!guardBroken(e)) {
            e.setState('block');
            e.blockFor = 0.6 + Math.random() * 0.6;
            { const a = e.playSlot('guard', { loop: false, fade: 0.08 }); if (a) a.holdAt = ANIM_SLOTS.guard.hold; }
          }
          e.think = 0.6 + Math.random() * 0.9;
        }
      }
    }
  }
  physics(e, dt);
}

// ------------------------------------------------------------------ camera

let shakeAmp = 0;
function shake(a) { shakeAmp = Math.max(shakeAmp, a); }

// The camera's pitch (camPitch, + = camera above looking down) picks the
// height to cut at on the target: its legs looking down, chest at the
// default view, head looking up. Each move tilts by what it needs from its
// own natural blow height (move.hitY, metres, measured with no aim) to there.
const AIM = { level: 0.18, down: 0.9, up: -0.35, perMetre: 0.95, max: 0.75 };
function aimHeightAt(target, where) {
  const z = target.zones.find((x) => x.name === { legs: 'leg', chest: 'chest', head: 'head' }[where]);
  return where === 'head' ? z.a.y + 0.08 : 0.5 * (z.a.y + z.b.y);
}
function aimHeight(target) {
  const legY = aimHeightAt(target, 'legs'), chestY = aimHeightAt(target, 'chest'), headY = aimHeightAt(target, 'head');
  if (camPitch >= AIM.level) return THREE.MathUtils.lerp(chestY, legY, Math.min(1, (camPitch - AIM.level) / (AIM.down - AIM.level)));
  return THREE.MathUtils.lerp(chestY, headY, Math.min(1, (AIM.level - camPitch) / (AIM.level - AIM.up)));
}
function aimFromCamera() {
  const m = player.move ?? (player.state === 'feint' ? ART.skills.feint.strike : null);
  if (!m || window.combat?.noAim) return 0;
  const want = Math.max(aimHeight(enemy), m.aimFloor ?? 0);
  return THREE.MathUtils.clamp((want - (m.hitY ?? 1)) * AIM.perMetre, -AIM.max, AIM.max);
}

function updateCamera(dt) {
  const target = player.pos.clone().add(new THREE.Vector3(0, 1.45, 0));
  const dir = new THREE.Vector3(Math.sin(camYaw) * Math.cos(camPitch), Math.sin(camPitch), Math.cos(camYaw) * Math.cos(camPitch));
  const right = new THREE.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
  const want = target.clone().addScaledVector(dir, camDist).addScaledVector(right, 0.4);
  want.x = THREE.MathUtils.clamp(want.x, -ROOM + 0.3, ROOM - 0.3);
  want.z = THREE.MathUtils.clamp(want.z, -ROOM + 0.3, ROOM - 0.3);
  want.y = Math.max(0.3, want.y);
  camera.position.lerp(want, Math.min(1, dt * 14));
  camera.lookAt(target.addScaledVector(right, 0.4));
  if (shakeAmp > 0.001) {
    camera.position.add(new THREE.Vector3((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, (Math.random() - 0.5)).multiplyScalar(shakeAmp));
    shakeAmp *= Math.exp(-dt * 14);
  }
}

function updateRing() {
  const e = enemy;
  if (!assist || e.state !== 'attack' || e.moveHit || !e.move) { ring.visible = false; return; }
  const left = e.hitAt - gameTime;
  const total = e.move.hit / e.move.speed;
  if (left < -0.05) { ring.visible = false; return; }
  ring.visible = true;
  e.sword.localToWorld(ring.position.set(0, 0.6, 0));
  ring.quaternion.copy(camera.quaternion);
  const s = 0.14 + Math.max(0, left / total) * 0.9;
  ring.scale.setScalar(s);
  const inWindow = left >= 0 && left <= stats.dodgeWindow;
  ring.material.color.setHex(inWindow ? 0xffffff : e.move.unblockable ? 0xff3030 : 0xffc640);
  ring.material.opacity = inWindow ? 1 : 0.75;
}

// ------------------------------------------------------------------ hit zone debug

const zoneMeshes = [];
let showZones = false;
function updateZoneDebug() {
  if (!showZones) { for (const m of zoneMeshes) m.visible = false; return; }
  let i = 0;
  for (const f of [player, enemy]) {
    for (const z of f.zones) {
      let m = zoneMeshes[i];
      if (!m) {
        m = new THREE.Mesh(new THREE.CapsuleGeometry(1, 1, 4, 8), new THREE.MeshBasicMaterial({ wireframe: true, transparent: true, opacity: 0.6 }));
        scene.add(m);
        zoneMeshes.push(m);
      }
      const len = z.a.distanceTo(z.b);
      m.visible = true;
      m.position.copy(z.a).lerp(z.b, 0.5);
      m.scale.set(z.radius, Math.max(len, 1e-3) / 2 / 1 + 0, z.radius);
      m.geometry.dispose();
      m.geometry = new THREE.CapsuleGeometry(z.radius, Math.max(len, 0.001), 4, 8);
      m.scale.set(1, 1, 1);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), z.b.clone().sub(z.a).normalize().lengthSq() ? z.b.clone().sub(z.a).normalize() : new THREE.Vector3(0, 1, 0));
      m.material.color.setHex({ head: 0xff2020, neck: 0xff7a00, chest: 0xffd000, abdomen: 0x9be000, arm: 0x40a0ff, leg: 0x8060ff }[z.name]);
      i++;
    }
  }
}

// ------------------------------------------------------------------ loop

const clock = new THREE.Clock();
let stepping = false;   // tests drive tick() themselves
function frame() {
  requestAnimationFrame(frame);
  const real = Math.min(clock.getDelta(), 0.05);
  if (!player || stepping) return;
  // Nothing moves until the fight is started (the enemy waits too).
  if (!active) {
    // Waiting to start: both stand in the sword idle (nothing else moves).
    for (const f of [player, enemy]) { f.mixer.update(real); f.finishPose(); f.hair?.rig.update(real, f.hair.state); }
    updateCamera(real);
    draw();
    return;
  }
  tick(real);
  draw();
}

function tick(real) {
  if (pressed.has('KeyR')) reset();
  if (pressed.has('KeyH')) { assist = !assist; message(assist ? 'Timing assist on' : 'Timing assist off'); }
  if (pressed.has('KeyB')) showZones = !showZones;
  if (pressed.has('KeyF')) fullscreen();
  // Slow motion after a perfect move, hit stop on a landed blow.
  if (hitStop > 0) { hitStop -= real; timeScale = 0.05; } else timeScale = gameTime < slowUntil ? 0.3 : 1;
  const dt = real * timeScale;
  gameTime += dt;
  playerUpdate(dt);
  enemyUpdate(dt);
  // Keep the two apart.
  const sep = enemy.pos.clone().sub(player.pos).setY(0);
  const dd = sep.length(), minD = player.radius + enemy.radius;
  if (dd < minD && dd > 1e-4 && player.state !== 'dead' && enemy.state !== 'dead') {
    sep.multiplyScalar((minD - dd) / dd / 2);
    enemy.pos.add(sep);
    player.pos.sub(sep);
  }
  // The player's cut follows the camera: looking down cuts low, looking up cuts high.
  player.aim = aimFromCamera();
  for (const f of [player, enemy]) {
    f.mixer.update(dt);
    f.finishPose(dt);
    f.hair?.rig.update(Math.max(dt, 1e-4), f.hair.state);
    if (f.flashUntil && gameTime > f.flashUntil) { f.sword.userData.steel.emissive.setHex(0); f.flashUntil = 0; }
  }
  bladeStep(player, enemy);
  bladeStep(enemy, player);
  updateTrails();
  for (let i = sparkPool.length - 1; i >= 0; i--) {
    const s = sparkPool[i];
    s.life += real;
    s.m.scale.setScalar(1 + s.life * 14);
    s.m.material.opacity = Math.max(0, 1 - s.life / 0.25);
    if (s.life > 0.25) { scene.remove(s.m); sparkPool.splice(i, 1); }
  }
  for (const f of [player, enemy]) healParts(f, dt);
  for (const f of [player, enemy]) {
    if (f.poise > 0 && gameTime - (f.poiseAt ?? 0) > STAGGER.decayAfter) f.poise = Math.max(0, f.poise - STAGGER.decay * dt);
  }
  // Dodge motion blur: trails while dodging, fading out quickly after.
  const want = player.state === 'dodge' && (player.t < 0.4 || gameTime < slowUntil) ? 0.7 : 0;
  blur.uniforms.damp.value += (want - blur.uniforms.damp.value) * Math.min(1, real * (want ? 30 : 12));
  updateRing();
  updateFx(real);
  updateZoneDebug();
  updateCamera(real);
  updateFloaters(real);
  updateBars();
  if (msgTimer > 0) { msgTimer -= real; if (msgTimer <= 0 && !over) msgEl.className = ''; }
  pressed.clear();
  clicked = false;
  rightClicked = false;
}

function reset() {
  over = false;
  msgEl.className = '';
  for (const [f, x, z, yaw] of [[player, 0, 4, Math.PI], [enemy, 0, -2, 0]]) {
    f.pos.set(x, 0, z);
    f.yaw = yaw;
    f.vel.set(0, 0, 0);
    f.vy = 0;
    f.grounded = true;
    f.hp = f.maxHp;
    f.stamina = stats.maxStamina;
    f.poise = 0;
    f.parts = makeParts(f.maxHp);
    f.dazedUntil = 0;
    f.guardBrokenUntil = 0;
    f.plan = null;
    f.parryAt = -99;
    f.dodgeAt = -99;
    f.move = null;
    f.comboIndex = -1;
    f.setState('idle');
    f.mixer.stopAllAction();
    f.action = null;
    f.setUpper(null);
    f.playSlot('idle', { fade: 0 });
  }
  camYaw = 0;
  enemy.think = 1.5;
}

function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

async function main() {
  resize();
  buildSettings();
  frame();
  // The player: the character made in the menu (else the female body as
  // made); the enemy is the other body with a fixed look.
  const setup = readSetup();
  const body = setup?.body ?? 'female';
  const other = body === 'female' ? 'male' : 'female';
  const enemySetup = { body: other, hair: { style: other === 'male' ? 'short_shaggy' : 'low_ponytail', color: '#1d1a19' },
    brows: { color: 'hair', thickness: 0.65 }, lips: { amount: 0.1 } };
  try {
    const [g1, g2] = await Promise.all([loadGLB(`models/character_${body}.glb`), loadGLB(`models/character_${other}.glb`)]);
    const [s1, s2] = await Promise.all([
      skinMaterial(body, setup, texLoader, g1.scene.userData.body), skinMaterial(other, enemySetup, texLoader, g2.scene.userData.body)]);
    player = new Fighter(g1, body, { name: setup?.name || 'You', player: true, maxHp: stats.maxHp, skin: s1, setup, tint: 0xc9a227 });
    enemy = new Fighter(g2, other, { name: 'Sparring Swordsman', maxHp: 420, skin: s2, setup: enemySetup, tint: 0x8a1c1c });
    const [h1, h2] = await Promise.all([hairFor(player, body, setup, loadGLB, scene), hairFor(enemy, other, enemySetup, loadGLB, scene)]);
    player.hair = h1;
    enemy.hair = h2;
    $('enemy-name').textContent = 'Sparring Swordsman · 陪练剑客';
    $('player-name').textContent = setup?.name || '';
    reset();
    initAnimPanel();
    $('loading').hidden = true;
    $('start').hidden = false;
  } catch (err) {
    console.error(err);
    $('loading').textContent = 'Could not load the characters. Serve this folder over HTTP (see README).';
  }
}

// For scripted tests: press a key or click for one frame, hold keys.
window.combat = {
  get player() { return player; }, get enemy() { return enemy; }, get time() { return gameTime; }, get shake() { return shakeAmp; }, hitLog, stats, camera, scene,
  press(code) { pressed.add(code); keys.add(code); setTimeout(() => keys.delete(code), 60); },
  hold(code, on) { if (on) keys.add(code); else keys.delete(code); },
  click() { clicked = true; },
  look(yaw, pitch) { camYaw = yaw; if (pitch !== undefined) camPitch = pitch; },
  /** Damage a fighter's body part directly (as a landed blow on that zone would). */
  hurt(who, zoneName, dmg) { const f = who === 'enemy' ? enemy : player; return hurtPart(f, f.zones.find((z) => z.name === zoneName), dmg); },
  /** Run n fixed steps (no rendering in between), then draw once. */
  start() { active = true; $('start').hidden = true; },
  step(n = 1, dt = 1 / 60, each = null) { stepping = true; for (let i = 0; i < n; i++) { each?.(i); tick(dt); } draw(); },
  release() { stepping = false; },
  startEnemyMove(name) { enemy.timedChecked = false; startMove(enemy, ART.enemy.find((m) => m.name === name)); },
};
main();
