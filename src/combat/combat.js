import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ARTS, ANIM_SLOTS, DEFAULT_STATS, HIT_ZONES, ZONE_ORDER, CRIT, BLADE_ACTIVE } from './skills.js';
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

  /** Pose after the animation: fingers, head size, facing. */
  finishPose() {
    for (const a of [this.upper, this.action]) {
      if (a?.holdAt != null && a.time >= a.holdAt) { a.time = a.holdAt; a.timeScale = 0; }
    }
    this.root.rotation.y = this.yaw;
    this.bones.Head.scale.setScalar(HEAD_SCALE);
    const q = new THREE.Quaternion();
    for (const f of this.fingers) f.bone.quaternion.copy(f.rest).multiply(q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), f.angle));
    this.root.updateMatrixWorld(true);
    for (const z of this.zones) {
      this.bones[z.from].getWorldPosition(z.a);
      if (z.to) this.bones[z.to].getWorldPosition(z.b); else z.b.copy(z.a);
    }
  }

  blade() {
    return [this.sword.localToWorld(this.sword.userData.base.clone()), this.sword.localToWorld(this.sword.userData.tip.clone())];
  }

  /** Clip time of the current move. */
  moveTime() { return this.move ? this.t * (this.move.speed ?? 1) : 0; }
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
  let best = null;
  for (const z of target.zones) {
    for (const [a, b] of samples) {
      if (segSegDist(a, b, z.a, z.b) < z.radius + BLADE_R) {
        if (!best || ZONE_ORDER.indexOf(z.name) < ZONE_ORDER.indexOf(best.name)) best = z;
        break;
      }
    }
  }
  return best;
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
  $('enemy-text').textContent = `${Math.ceil(enemy.hp)} / ${enemy.maxHp}`;
  const left = Math.max(0, (player.feintReady ?? 0) - gameTime);
  $('skill-e').classList.toggle('cool', left > 0);
  $('skill-e-cd').textContent = left > 0 ? left.toFixed(1) : '';
  $('combo').textContent = player.comboIndex >= 0 && player.state === 'attack' ? `${ART.name} · ${player.comboIndex + 1}` : ART.name;
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

const ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffc640, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
ring.rotation.x = -Math.PI / 2;
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
  f.bladePrev = null;
  f.setState('attack');
  f.play(move.clip, { loop: false, speed: move.speed ?? 1, fade: 0.08 });
  f.hitAt = gameTime + move.hit / (move.speed ?? 1);   // scheduled moment of the blow (game time)
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
  if (def.isPlayer && facing && sinceParry >= 0 && sinceParry <= stats.parryWindow + 0.02 && move.parryable !== false) {
    perfect(def, att, 'Perfect Parry!', true);
    return;
  }
  let dmg = move.damage * zone.damage;
  let crit = false;
  if (att.isPlayer && gameTime < att.counterUntil) dmg *= stats.counterBonus;
  if (Math.random() < CRIT.baseChance + zone.crit) { crit = true; dmg *= CRIT.damage; }
  // Blocking (holding parry, facing the attacker).
  const blocking = def.state === 'block' && facing;
  if (blocking && move.guardBreak) {
    // A feint's real cut: the guard is broken.
    def.stamina = Math.max(0, def.stamina - 30);
    def.hp = Math.max(0, def.hp - dmg);
    sound('crit');
    floatText(zone.a.clone().lerp(zone.b, 0.5), `Guard Break ${Math.round(dmg)}`, 'crit');
    hitStop = 0.1;
    if (def.hp <= 0) { die(def); return; }
    stagger(def, 1.4, null);
    if (att.isPlayer) att.counterUntil = gameTime + 1.6;
    return;
  }
  if (blocking && !move.unblockable) {
    dmg *= def.isPlayer ? 1 - stats.blockReduction : 0.25;
    crit = false;
    def.stamina -= move.guardDamage ?? stats.blockCost;
    sound('block');
    sparks(zone.a.clone().lerp(zone.b, 0.5), 0xfff0b0);
    if (def.stamina <= 0) { def.stamina = 0; stagger(def, 1.1, 'Guard Break'); }
    else floatText(zone.a, `Blocked ${Math.round(dmg)}`, 'blocked');
  } else {
    if (blocking && move.unblockable && def.isPlayer) message('Unblockable!', 'bad');
    sound(crit ? 'crit' : 'hit');
    floatText(zone.a.clone().lerp(zone.b, 0.5), `${crit ? 'CRIT ' : ''}${zone.label} ${Math.round(dmg)}`, crit ? 'crit' : def.isPlayer ? 'taken' : '');
    hitStop = crit ? 0.1 : 0.05;
  }
  def.hp = Math.max(0, def.hp - dmg);
  if (def.hp <= 0) { die(def); return; }
  if (!blocking || move.unblockable) {
    // Flinch, unless attacking with armour (the enemy's heavy blows) and not a staggering blow.
    const armoured = def.state === 'attack' && def.move?.unblockable;
    if (!armoured && (def.state !== 'attack' || move.stagger || def.isPlayer)) flinch(def, att, move.stagger);
  }
}

function perfect(def, att, text, parry = false) {
  message(text, 'good');
  sound('perfect');
  def.invulnUntil = gameTime + 0.4;
  def.counterUntil = gameTime + 1.6;
  slowUntil = gameTime + (parry ? 0.35 : 0.6);
  if (parry) {
    sparks(def.sword.localToWorld(def.sword.userData.tip.clone().multiplyScalar(0.6)), 0xffffff);
    stagger(att, 1.6, 'Stunned');
  } else {
    att.exposedUntil = gameTime + 1.2;
  }
}

function flinch(f, att, hard) {
  f.move = null;
  f.setState('hit');
  f.hitDur = hard ? 0.7 : 0.38;
  f.playSlot(hard ? 'hitHard' : (Math.random() < 0.5 ? 'hitLight' : 'hitLight2'), { loop: false, fade: 0.05 });
  const push = f.pos.clone().sub(att.pos).setY(0).normalize();
  f.vel.copy(push.multiplyScalar(hard ? 3.5 : 1.6));
  f.comboIndex = -1;
}

function stagger(f, dur, text) {
  f.move = null;
  f.setState('stagger');
  f.hitDur = dur;
  f.playSlot('stun', { loop: true, fade: 0.1 });
  if (text) floatText(f.zones[0].a, text, 'status');
}

function die(f) {
  f.move = null;
  f.setState('dead');
  f.playSlot('death', { loop: false, fade: 0.1 });
  over = true;
  message(f.isPlayer ? 'Defeated — press R to try again' : 'Victory — press R to fight again', f.isPlayer ? 'bad' : 'good');
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
    const zone = bladeContact(att.bladePrev, now, def);
    if (zone) resolveHit(att, def, zone);
    else if (due && !att.timedChecked) {
      att.timedChecked = true;
      const sinceDodge = att.hitAt - (def.dodgeAt ?? -99);
      const sinceParry = att.hitAt - (def.parryAt ?? -99);
      if (def.state === 'dodge' && sinceDodge >= 0 && sinceDodge <= stats.dodgeWindow + 0.02) { att.moveHit = true; perfect(def, att, 'Perfect Dodge!'); }
      else if (def.isPlayer && sinceParry >= 0 && sinceParry <= stats.parryWindow + 0.02 && move.parryable !== false) { att.moveHit = true; perfect(def, att, 'Perfect Parry!', true); }
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
  const blockKey = keys.has('ShiftLeft') || keys.has('ShiftRight');
  const attackPress = clicked;
  const dodgePress = pressed.has('AltLeft') || pressed.has('AltRight');
  const parryPress = pressed.has('ShiftLeft') || pressed.has('ShiftRight');
  const jumpPress = pressed.has('Space');
  const heavyPress = rightClicked || pressed.has('KeyQ');
  if (parryPress) p.parryAt = gameTime;

  const canAct = ['idle', 'move', 'block'].includes(p.state) || (p.state === 'recover' && p.t > 0.12);
  const afterHit = p.state === 'attack' && p.moveHit;

  if (p.state === 'dead') { /* nothing */ } else if (p.state === 'hit' || p.state === 'stagger') {
    if (p.t > p.hitDur) p.setState('idle');
    if (p.state === 'hit' && p.t > 0.25 && dodgePress) doDodge(wish);
  } else if (dodgePress && (canAct || afterHit || p.state === 'feint' || p.state === 'attack' && p.t < 0.1) && p.stamina >= stats.dodgeCost && p.grounded) {
    doDodge(wish);
  } else if (p.state === 'dodge') {
    const k = p.t < 0.32 ? 1 : 0;
    p.vel.copy(p.dodgeDir).multiplyScalar(k * 8.5 * (1 - p.t / 0.32));
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
        const rec = p.move.rec;
        p.move = null;
        p.queued = false;
        if (rec) { p.setState('recover'); p.play(rec, { loop: false, fade: 0.1, speed: 1.3 }); } else p.setState('idle');
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
      p.vy = 5.4;
      p.grounded = false;
      p.stamina -= stats.jumpCost;
      p.playSlot('jump', { fade: 0.1 });
    } else if (blockKey && p.grounded) {
      // Guard (parry held): walk slowly with the guard up, facing the enemy.
      if (p.state !== 'block') p.setState('block');
      const near = dist2(p, enemy) < 8 * 8;
      if (near) p.faceTarget(enemy, dt, 10); else if (wish.lengthSq()) p.turnTo(Math.atan2(wish.x, wish.z), dt, 8);
      p.vel.copy(wish).multiplyScalar(stats.guardSpeed);
      const g = ANIM_SLOTS.guard;
      if (wish.lengthSq()) {
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
      p.vel.copy(wish).multiplyScalar(speed);
      if (moving) p.turnTo(Math.atan2(wish.x, wish.z), dt, 12);
      if (p.grounded && !(gameTime < (p.previewUntil ?? 0) && !moving)) {
        p.playSlot(moving ? (p.sprinting ? 'sprint' : 'run') : 'idle', { fade: 0.18 });
        p.state = moving ? 'move' : 'idle';
      }
    }
  }
  if (p.state !== 'move') p.sprinting = false;
  if (p.state === 'attack' || p.state === 'recover' || p.state === 'stagger' || p.state === 'feint') p.vel.multiplyScalar(Math.max(0, 1 - dt * 10));
  if (p.state === 'hit') p.vel.multiplyScalar(Math.max(0, 1 - dt * 6));

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

function enemyUpdate(dt) {
  const e = enemy;
  e.t += dt;
  const d = Math.sqrt(dist2(e, player));
  if (e.state === 'dead') return;
  if (player.state === 'dead') { e.playSlot('idle'); e.vel.set(0, 0, 0); physics(e, dt); return; }
  e.think = (e.think ?? 1) - dt;
  switch (e.state) {
    case 'hit':
    case 'stagger':
      e.vel.multiplyScalar(Math.max(0, 1 - dt * 6));
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
          if (rec) e.play(rec, { loop: false, fade: 0.1 }); else e.playSlot('idle', { fade: 0.2 });
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
      e.vel.copy(side).multiplyScalar(1.6).addScaledVector(toP, (d - 2.2) * 0.8);
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
        e.vel.copy(toP).multiplyScalar(speed);
        e.playSlot(d > 6 ? 'run' : 'walk', { fade: 0.2 });
      } else {
        e.vel.multiplyScalar(0.7);
        e.state = 'idle';
        e.playSlot('idle', { fade: 0.2 });
        // React to the player's swing sometimes by blocking.
        const bait = player.state === 'feint' && Math.random() < dt * 6;
        if (bait || (player.state === 'attack' && !player.moveHit && Math.random() < dt * 1.2 && e.think < 0.5)) {
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
          } else {
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
}

function updateRing() {
  const e = enemy;
  if (!assist || e.state !== 'attack' || e.moveHit || !e.move) { ring.visible = false; return; }
  const left = e.hitAt - gameTime;
  const total = e.move.hit / e.move.speed;
  if (left < -0.05) { ring.visible = false; return; }
  ring.visible = true;
  ring.position.set(player.pos.x, 0.02, player.pos.z);
  const s = 0.6 + Math.max(0, left / total) * 1.8;
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
    renderer.render(scene, camera);
    return;
  }
  tick(real);
  renderer.render(scene, camera);
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
  for (const f of [player, enemy]) {
    f.mixer.update(dt);
    f.finishPose();
    f.hair?.rig.update(Math.max(dt, 1e-4), f.hair.state);
    if (f.flashUntil && gameTime > f.flashUntil) { f.sword.userData.steel.emissive.setHex(0); f.flashUntil = 0; }
  }
  bladeStep(player, enemy);
  bladeStep(enemy, player);
  for (let i = sparkPool.length - 1; i >= 0; i--) {
    const s = sparkPool[i];
    s.life += real;
    s.m.scale.setScalar(1 + s.life * 14);
    s.m.material.opacity = Math.max(0, 1 - s.life / 0.25);
    if (s.life > 0.25) { scene.remove(s.m); sparkPool.splice(i, 1); }
  }
  updateRing();
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
  get player() { return player; }, get enemy() { return enemy; }, get time() { return gameTime; }, hitLog, stats, camera, scene,
  press(code) { pressed.add(code); keys.add(code); setTimeout(() => keys.delete(code), 60); },
  hold(code, on) { if (on) keys.add(code); else keys.delete(code); },
  click() { clicked = true; },
  look(yaw) { camYaw = yaw; },
  /** Run n fixed steps (no rendering in between), then draw once. */
  start() { active = true; $('start').hidden = true; },
  step(n = 1, dt = 1 / 60, each = null) { stepping = true; for (let i = 0; i < n; i++) { each?.(i); tick(dt); } renderer.render(scene, camera); },
  release() { stepping = false; },
  startEnemyMove(name) { enemy.timedChecked = false; startMove(enemy, ART.enemy.find((m) => m.name === name)); },
};
main();
