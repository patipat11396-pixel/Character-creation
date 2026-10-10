import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { SKIN_TONES, DEFAULT_TONE } from './skinTones.js';
import { HAIR_COLORS, HAIR_DEFAULTS, FIT_DEFAULTS, FIT_KEYS, HairRig, hairMaterial, setHairColor } from './hair.js';

const DEFAULTS_URL = 'models/defaults.json';
const HAIR_INDEX_URL = 'models/hair/index.json';
// Filled in by the single-file artifact build: model URL -> base64 text parts.
const PACKED = null;
// The base bodies, built by tools/process_character.py, and their sources
// (shown by "Model check").
const BODIES = {
  female: { label: 'Female', fixed: 'models/character_female.glb', original: 'models/source/f_base.glb' },
  male: { label: 'Male', fixed: 'models/character_male.glb', original: 'models/source/m_base.glb' },
};
// Finger curl for a full fist, in degrees per joint (knuckle, middle, tip).
// The finger bones curl towards the palm when rotated about their local X.
const FIST = {
  Thumb: [0, 25, 55],
  Index: [75, 95, 60], Middle: [75, 95, 60], Ring: [75, 95, 60], Pinky: [75, 95, 60],
};
const RELAXED_GRIP = 0.15;
// Mouth shape keys built by tools/process_character.py, mixed per expression.
const EXPRESSIONS = {
  neutral: {},
  smile: { smile: 1 },
  laugh: { jawOpen: 0.65, smile: 1 },
  surprised: { jawOpen: 0.75, mouthRound: 1 },
  sad: { frown: 1 },
  talking: {},
};
// Clips where the character holds something or fights get a fist in "Auto".
const GRIP_CLIPS = /Punch|Fight|Melee|Hook|Kick|Sword|Pistol|Shield|Torch|Lantern|Climb|Ladder|Pipe|Ledge|Bow|Golf|Fishing|Chop|Carry|Driving|Rail|Ground_Pound/;
// Shown first in the animation list; every other clip follows.
const FEATURED = ['Idle_A', 'Walk', 'Jog', 'Sprint', 'Dance_Simple', 'Greeting',
  'Sword_Regular_Combo', 'Sitting_Idle', 'Crouch_Idle', 'Pushup'];
const STORAGE_KEY = 'character-creation:character';
// Lip colours, mixed over the lip area (the model's _LIPMASK) by `amount`.
const LIP_COLORS = [
  { name: 'Natural', hex: '#b8676d' },
  { name: 'Nude', hex: '#a8705f' },
  { name: 'Pink', hex: '#d9798a' },
  { name: 'Rose', hex: '#b5596a' },
  { name: 'Coral', hex: '#e0705a' },
  { name: 'Red', hex: '#b3202e' },
  { name: 'Berry', hex: '#7a2541' },
];
const LIP_DEFAULTS = { color: '#b8676d', amount: 0.35 };
// Face shape keys built by tools/face.py (FACE_SHAPES), grouped for the menu.
// Each slider runs -1 … 1; 0 is the model as made.
const FACE_GROUPS = [
  ['Nose', [['noseWidth', 'Width'], ['noseLength', 'Length'], ['noseBridge', 'Bridge']]],
  ['Lips', [['lipsFull', 'Fullness'], ['lipsWidth', 'Width']]],
  ['Forehead', [['foreheadFull', 'Fullness'], ['foreheadSlope', 'Slope']]],
  ['Chin', [['chinLength', 'Length'], ['chinForward', 'Forward'], ['chinWidth', 'Width']]],
  ['Jaw', [['jawWidth', 'Width'], ['jawSquare', 'Angle']]],
  ['Eyes', [['eyeSize', 'Size'], ['eyeSpacing', 'Spacing'], ['eyeHeight', 'Height'], ['eyeTilt', 'Tilt']]],
];
const FACE_KEYS = FACE_GROUPS.flatMap(([, items]) => items.map(([k]) => k));

const $ = (id) => document.getElementById(id);
const canvas = $('view');

const state = {
  name: '',
  tone: DEFAULT_TONE,
  anim: 'Idle_A',
  body: 'female',
  model: 'fixed',
  weights: false,
  hands: 'auto',
  expression: 'neutral',
  mouth: { open: 0, smile: 0, round: 0 },
  hair: { ...HAIR_DEFAULTS },
  hairFits: {}, // body -> style id -> fit, for every style fitted on that body
  lips: { ...LIP_DEFAULTS },
  face: Object.fromEntries(FACE_KEYS.map((k) => [k, 0])),
};
let grip = RELAXED_GRIP;

// ---------------------------------------------------------------- scene

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15171c);
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;

const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
camera.position.set(0.9, 1.3, 4.6);

const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0.88, 0);
controls.enableDamping = true;
// Panning moves the view up and down only (right-drag, or two fingers):
// the point it orbits stays on the character's centre line.
controls.enablePan = true;
controls.screenSpacePanning = true;
const PAN_RANGE = [0.05, 1.75]; // metres, how low and high the view can go
const _panFix = new THREE.Vector3();
controls.addEventListener('change', () => {
  const t = controls.target;
  _panFix.set(-t.x, THREE.MathUtils.clamp(t.y, ...PAN_RANGE) - t.y, -t.z);
  if (_panFix.lengthSq() > 1e-12) {
    t.add(_panFix);
    camera.position.add(_panFix);
  }
});
controls.minDistance = 0.45;
controls.maxDistance = 7;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = Math.PI / 2 + 0.05;

// Editor-style move / rotate / scale handles for the hair, on its HairRoot bone.
const gizmo = new TransformControls(camera, canvas);
gizmo.setSpace('local');
gizmo.setSize(0.8);
// The centre scale cube becomes "drag up to grow, down to shrink" for the
// overall size: three.js's own uniform scale divides by the distance from the
// centre and jumps when the cube is grabbed in the middle.
const uniformDrag = { active: false, y: 0, size: 1 };
let pointerY = 0;
canvas.addEventListener('pointermove', (e) => { pointerY = e.clientY; });
canvas.addEventListener('pointerdown', (e) => { pointerY = e.clientY; });
gizmo.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  uniformDrag.active = e.value && gizmo.mode === 'scale' && gizmo.axis === 'XYZ';
  Object.assign(uniformDrag, { y: pointerY, size: state.hair.size });
});
gizmo.addEventListener('objectChange', () => {
  const rig = current()?.hair;
  if (!rig) return;
  if (uniformDrag.active) {
    const size = THREE.MathUtils.clamp(uniformDrag.size * Math.exp((uniformDrag.y - pointerY) / 250), 0.3, 3);
    setHair({ size });
    rig.fit(state.hair); // undo three.js's own scaling for this frame
    return;
  }
  setHair(rig.readFit(state.hair));
});
scene.add(gizmo.getHelper());

// Camera presets: keep the viewing direction, change height and distance.
// Heights are a share of the way up the head (from the chin) or of the body.
const VIEWS = {
  head: { target: (b) => (b.chin_z + 0.55 * (b.top_z - b.chin_z)) / 100, distance: 1.1 },
  body: { target: (b) => 0.53 * b.top_z / 100, distance: 4.7 },
};
const view = { from: null, to: null, t: 1 };

function setView(name) {
  const v = VIEWS[name];
  // Drop any glide left over from the last drag, which would pull the view off.
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
  const dir = camera.position.clone().sub(controls.target).normalize();
  const target = new THREE.Vector3(0, v.target(current()?.body ?? { top_z: 160, chin_z: 131 }), 0);
  view.from = { target: controls.target.clone(), position: camera.position.clone() };
  view.to = { target, position: target.clone().addScaledVector(dir, v.distance) };
  view.t = 0;
}

function stepView(dt) {
  if (view.t >= 1) return;
  view.t = Math.min(1, view.t + dt * 3);
  const k = view.t * view.t * (3 - 2 * view.t);
  controls.target.lerpVectors(view.from.target, view.to.target, k);
  camera.position.lerpVectors(view.from.position, view.to.position, k);
}

const key = new THREE.DirectionalLight(0xffffff, 2.2);
key.position.set(1.5, 3, 2);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = key.shadow.camera.bottom = -1.6;
key.shadow.camera.right = key.shadow.camera.top = 1.6;
key.shadow.bias = -0.0005;
key.shadow.normalBias = 0.02;
scene.add(key);
const rim = new THREE.DirectionalLight(0xbfd4ff, 1.2);
rim.position.set(-2, 2, -2.5);
scene.add(rim);
scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2d35, 0.5));

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(1.8, 64),
  new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.95 }),
);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

// One skin material shared by both model versions, so a tone change shows on
// whichever is visible.
const skin = new THREE.MeshPhysicalMaterial({
  roughness: 0.55,
  sheen: 0.4,
  sheenRoughness: 0.6,
  side: THREE.DoubleSide,
});
// Looking into the open mouth shows the inside of the head; draw those back
// faces as a dark mouth interior instead of lit skin.
// Lip colour: the model marks the lips with a 0..1 vertex attribute.
const lipUniforms = {
  lipColor: { value: new THREE.Color(LIP_DEFAULTS.color) }, lipAmount: { value: LIP_DEFAULTS.amount },
  // Buzz cut under the hair: the scalp (_SCALPMASK) takes the hair colour.
  scalpColor: { value: new THREE.Color(HAIR_DEFAULTS.color) }, scalpAmount: { value: HAIR_DEFAULTS.under },
  // 1 while a hair mesh is worn: use the mask with the front hairline raised.
  scalpUnderHair: { value: 1 },
  // This body's head against the head the hairline was drawn on (new = scale * old + offset),
  // and its ears: centre (y, z), radii (y, z), and how far out (|x|) the ear cut starts.
  headScale: { value: new THREE.Vector3(1, 1, 1) }, headOffset: { value: new THREE.Vector3() },
  earShape: { value: new THREE.Vector4(16.8, 146, 3.2, 4.5) }, earX: { value: 8.5 },
};
skin.onBeforeCompile = (shader) => {
  Object.assign(shader.uniforms, lipUniforms);
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float _lipmask;\nvarying float vLip;\nvarying vec3 vSkinPos;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLip = _lipmask;\n  vSkinPos = position;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform vec3 lipColor; uniform float lipAmount; varying float vLip;
uniform vec3 scalpColor; uniform float scalpAmount; uniform float scalpUnderHair;
uniform vec3 headScale; uniform vec3 headOffset; uniform vec4 earShape; uniform float earX;
varying vec3 vSkinPos;
// Buzz-cut boundary, drawn on a reference head (mesh space, cm: x side, y back,
// z up); each body maps its points onto that head first (headScale, headOffset).
// Front and sides: a Catmull-Rom curve of hairline height by depth y, from the
// forehead (158.5) through a short tapered temple to the front of the ear.
const float HAIR_FRONT[14] = float[14](158.5, 158.5, 158.5, 158.3, 157.8, 156.8, 154.9,
                                       151.2, 146.4, 143.2, 142.8, 142.8, 142.8, 142.8);  // y = -2, 0, 2 … 24
float hairFront(float y) {
  float t = clamp((y + 2.0) / 2.0, 0.0, 12.999);
  int i = int(t);
  float f = t - float(i);
  float p0 = HAIR_FRONT[max(i - 1, 0)], p1 = HAIR_FRONT[i];
  float p2 = HAIR_FRONT[min(i + 1, 13)], p3 = HAIR_FRONT[min(i + 2, 13)];
  return 0.5 * (2.0 * p1 + (p2 - p0) * f + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f * f
              + (3.0 * p1 - p0 - 3.0 * p2 + p3) * f * f * f);
}
float scalpCover(vec3 q) {
  vec3 p = (q - headOffset) / headScale;
  // Back: a shallow rounded nape edge where the skull meets the neck (140.5 cm
  // on the centre line), rising to meet the line behind each ear.
  float back = 140.5 + 0.031 * p.x * p.x;
  float line = mix(hairFront(p.y), back, smoothstep(18.0, 23.0, p.y));
  // Under a hair mesh the front edge sits 2.5 cm higher so it stays hidden.
  line += 2.5 * scalpUnderHair * smoothstep(12.0, 6.0, p.y);
  float d = p.z - line;
  float aa = max(fwidth(d), 0.02);
  float m = smoothstep(-aa, aa, d);
  // Ears: an ellipse just outside this body's measured ear outline, on the
  // sides of the head only.
  float r = length(vec2((q.y - earShape.x) / earShape.z, (q.z - earShape.y) / earShape.w)) - 1.0;
  float ar = max(fwidth(r), 0.004);
  m *= 1.0 - (1.0 - smoothstep(-ar, ar, r)) * smoothstep(earX, earX + 1.0, abs(q.x));
  return m;
}
float stubbleHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }`)
    .replace('#include <color_fragment>', `#include <color_fragment>
  diffuseColor.rgb = mix(diffuseColor.rgb, lipColor, clamp(vLip, 0.0, 1.0) * lipAmount);
  {
    // Stubble: fine per-hair speckle, and a hairline broken up by it.
    float n = stubbleHash(floor(vSkinPos * 7.0));
    float n2 = stubbleHash(floor(vSkinPos * 19.0) + 3.1);
    float cover = scalpCover(vSkinPos) * scalpAmount;
    vec3 stubble = scalpColor * (0.75 + 0.45 * n2);
    diffuseColor.rgb = mix(diffuseColor.rgb, stubble, cover * (0.82 + 0.18 * n));
  }`)
    .replace('#include <dithering_fragment>',
      '#include <dithering_fragment>\n  if (!gl_FrontFacing) gl_FragColor.rgb = vec3(0.12, 0.04, 0.04);');
};
const weightMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
const hairMat = hairMaterial(HAIR_DEFAULTS.color);

// ---------------------------------------------------------------- models

const loader = new GLTFLoader();
const characters = {}; // "body:model" -> { root, mesh, mixer, clips, action, body }
const loading = {};    // "body:model" -> Promise of the character
const charKey = (body = state.body, model = state.model) => `${body}:${model}`;
const current = () => characters[charKey()];
const clock = new THREE.Clock();

async function loadGLB(url) {
  const parts = PACKED?.[url];
  if (!parts) return loader.loadAsync(url);
  const texts = await Promise.all(parts.map(async (part) => {
    const res = await fetch(part);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${part}`);
    return res.text();
  }));
  const bytes = Uint8Array.from(atob(texts.join('')), (c) => c.charCodeAt(0));
  return loader.parseAsync(bytes.buffer, '');
}

function loadModel(body, kind) {
  const k = charKey(body, kind);
  loading[k] ??= buildCharacter(body, kind).catch((err) => {
    delete loading[k];
    throw err;
  });
  return loading[k];
}

async function buildCharacter(body, kind) {
  const gltf = await loadGLB(BODIES[body][kind]);
  const root = gltf.scene;
  let mesh;
  const faceMeshes = []; // every part with mouth shape keys: body, teeth, tongue
  root.traverse((o) => {
    if (o.isSkinnedMesh) {
      if (!['Teeth', 'Tongue'].includes(o.material.name)) mesh = o;
      if (o.morphTargetDictionary) faceMeshes.push(o);
      o.castShadow = true;
      o.frustumCulled = false; // animated bounds differ from the bind pose
    }
  });
  // The unprocessed source is in centimetres.
  if (new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3()).y > 10) root.scale.multiplyScalar(0.01);
  mesh.material = skin;
  addWeightColors(mesh.geometry);
  const fingers = [];
  for (const bone of mesh.skeleton.bones) {
    const m = bone.name.match(/Hand(Thumb|Index|Middle|Ring|Pinky)([123])$/);
    if (m) fingers.push({ bone, rest: bone.quaternion.clone(), angle: THREE.MathUtils.degToRad(FIST[m[1]][m[2] - 1]) });
  }
  // The Head bone's world matrix in the bind pose, where hairstyles are built.
  mesh.skeleton.pose();
  root.updateMatrixWorld(true);
  const headBone = mesh.skeleton.bones.find((b) => b.name === 'Head');
  const headBindWorld = headBone.matrixWorld.clone();
  const hair = null;
  const mixer = new THREE.AnimationMixer(root);
  const clips = new Map(gltf.animations.map((c) => [c.name.replace(/_RT$/, ''), c]));
  // Landmarks written by the build; the unprocessed source borrows the built model's.
  const landmarks = root.userData.body ?? (kind === 'fixed' ? null : (await loadModel(body, 'fixed')).body);
  const character = {
    root, mesh, mixer, clips, fingers, faceMeshes, hair, headBone, headBindWorld, hairRigs: {}, action: null,
    body: landmarks, headMap: headMapWorld(landmarks.head_map),
  };
  characters[charKey(body, kind)] = character;
  root.visible = false;
  scene.add(root);
  return character;
}

// The build's head map (mesh cm: new = scale * old + offset) as a world-space
// matrix: the meshes are centimetres, Z up, front -Y, under a 0.01 scale and a
// -90 degree turn about X.
const MESH_TO_WORLD = new THREE.Matrix4().makeRotationX(-Math.PI / 2).multiply(new THREE.Matrix4().makeScale(0.01, 0.01, 0.01));
function headMapWorld(map) {
  const m = new THREE.Matrix4().makeScale(...map.scale).setPosition(...map.offset);
  return MESH_TO_WORLD.clone().multiply(m).multiply(MESH_TO_WORLD.clone().invert());
}

/** Point the skin shader's hairline at this body's head and ears. */
function useBodyLandmarks(b) {
  lipUniforms.headScale.value.set(...b.head_map.scale);
  lipUniforms.headOffset.value.set(...b.head_map.offset);
  lipUniforms.earShape.value.set(b.ear.y, b.ear.z, b.ear.ry, b.ear.rz);
  lipUniforms.earX.value = b.ear.x;
}

// A colour per bone, blended by each vertex's skin weights, for the debug view.
function addWeightColors(geometry) {
  const joints = geometry.attributes.skinIndex;
  const weights = geometry.attributes.skinWeight;
  const colors = new Float32Array(joints.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < joints.count; i++) {
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < 4; k++) {
      const w = weights.getComponent(i, k);
      if (!w) continue;
      c.setHSL(((joints.getComponent(i, k) * 0.618034) % 1), 0.75, 0.55);
      r += c.r * w; g += c.g * w; b += c.b * w;
    }
    colors.set([r, g, b], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function playAnimation(character, name) {
  const clip = character.clips.get(name);
  if (!clip) return;
  const next = character.mixer.clipAction(clip);
  if (character.action === next) return;
  next.reset().play();
  if (character.action) next.crossFadeFrom(character.action, 0.25, false);
  character.action = next;
}

const X_AXIS = new THREE.Vector3(1, 0, 0);
const curl = new THREE.Quaternion();

function targetGrip() {
  if (state.hands === 'fist') return 1;
  if (state.hands === 'open') return 0;
  return GRIP_CLIPS.test(state.anim) ? 1 : RELAXED_GRIP;
}

// The animations have no finger tracks, so the hands are posed here every frame.
function poseHands(dt) {
  grip += (targetGrip() - grip) * Math.min(1, dt * 10);
  for (const ch of Object.values(characters)) {
    for (const f of ch.fingers) {
      f.bone.quaternion.copy(f.rest).multiply(curl.setFromAxisAngle(X_AXIS, f.angle * grip));
    }
  }
}

// Current mouth values ease towards the sliders; "talking" adds a jaw flap.
const mouthNow = { jawOpen: 0, smile: 0, frown: 0, mouthRound: 0 };
let talkTime = 0;

function poseMouth(dt) {
  const { open, smile, round } = state.mouth;
  const target = { jawOpen: open, smile: Math.max(smile, 0), frown: Math.max(-smile, 0), mouthRound: round };
  if (state.expression === 'talking') {
    talkTime += dt;
    const t = talkTime * 9;
    target.jawOpen = Math.min(1, open + 0.3 * Math.max(0, Math.sin(t) + 0.5 * Math.sin(t * 2.3 + 1)));
    target.mouthRound = Math.min(1, round + 0.3 * Math.max(0, Math.sin(t * 0.7 + 2)));
  }
  const k = Math.min(1, dt * (state.expression === 'talking' ? 20 : 10));
  for (const key in mouthNow) mouthNow[key] += (target[key] - mouthNow[key]) * k;
  for (const ch of Object.values(characters)) {
    for (const m of ch.faceMeshes) {
      for (const key in mouthNow) {
        const i = m.morphTargetDictionary[key];
        if (i !== undefined) m.morphTargetInfluences[i] = mouthNow[key];
      }
      for (const key of FACE_KEYS) {
        const i = m.morphTargetDictionary[key];
        if (i !== undefined) m.morphTargetInfluences[i] = state.face[key];
      }
    }
  }
}

function setExpression(name) {
  state.expression = name;
  const e = EXPRESSIONS[name];
  state.mouth = { open: e.jawOpen ?? 0, smile: (e.smile ?? 0) - (e.frown ?? 0), round: e.mouthRound ?? 0 };
  document.querySelectorAll('[data-expression]').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.expression === name)));
  $('mouth-open').value = state.mouth.open;
  $('mouth-smile').value = state.mouth.smile;
  $('mouth-round').value = state.mouth.round;
}

function buildHairControls() {
  const box = $('hair-colors');
  for (const c of HAIR_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch hair-swatch';
    b.style.background = c.hex;
    b.dataset.color = c.hex;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c.name);
    b.title = c.name;
    b.addEventListener('click', () => setHair({ color: c.hex }));
    box.appendChild(b);
  }
  $('hair-custom').addEventListener('input', (e) => setHair({ color: e.target.value }));
  document.querySelectorAll('[data-hair]').forEach((input) =>
    input.addEventListener('input', () => setHair({ [input.dataset.hair]: Number(input.value) })));
  document.querySelectorAll('[data-gizmo]').forEach((b) =>
    b.addEventListener('click', () => setGizmo(b.dataset.gizmo)));
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea')) return;
    const mode = { w: 'translate', e: 'rotate', r: 'scale', escape: 'off' }[e.key.toLowerCase()];
    if (mode) setGizmo(mode);
  });
  $('hair-reset').addEventListener('click', () => {
    const style = state.hair.style;
    const physics = { weight: HAIR_DEFAULTS.weight, stiffness: HAIR_DEFAULTS.stiffness, bounce: HAIR_DEFAULTS.bounce };
    for (const k of Object.keys(physics)) if (defaults?.hair?.[k] !== undefined) physics[k] = defaults.hair[k];
    const fit = fitsByBody(defaults?.hairFits)[state.body]?.[style]
      ?? (defaults?.hair?.style === style ? pickFit(defaults.hair) : FIT_DEFAULTS);
    setHair({ ...FIT_DEFAULTS, ...fit, ...physics });
    for (const ch of Object.values(characters)) ch.hair?.reset();
  });
  setHair({});
}

function buildFaceControls() {
  const box = $('face-shape');
  for (const [group, items] of FACE_GROUPS) {
    const label = document.createElement('span');
    label.className = 'sublabel';
    label.textContent = group;
    box.appendChild(label);
    for (const [key, name] of items) {
      const row = document.createElement('label');
      row.className = 'slider';
      row.innerHTML = `<span>${name}</span><input type="range" min="-1" max="1" step="0.01" value="0" data-face="${key}">`;
      row.querySelector('input').addEventListener('input', (e) => { state.face[key] = Number(e.target.value); });
      box.appendChild(row);
    }
  }
  $('face-reset').addEventListener('click', () => setFace(Object.fromEntries(FACE_KEYS.map((k) => [k, 0]))));
}

function setFace(values) {
  for (const k of FACE_KEYS) if (typeof values?.[k] === 'number') state.face[k] = values[k];
  document.querySelectorAll('[data-face]').forEach((el) => { el.value = state.face[el.dataset.face]; });
}

function buildLipControls() {
  const box = $('lip-colors');
  for (const c of LIP_COLORS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch lip-swatch';
    b.style.background = c.hex;
    b.dataset.color = c.hex;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', c.name);
    b.title = c.name;
    b.addEventListener('click', () => setLips({ color: c.hex, amount: Math.max(state.lips.amount, 0.35) }));
    box.appendChild(b);
  }
  $('lip-custom').addEventListener('input', (e) => setLips({ color: e.target.value }));
  $('lip-amount').addEventListener('input', (e) => setLips({ amount: Number(e.target.value) }));
  setLips({});
}

function setLips(change) {
  Object.assign(state.lips, change);
  lipUniforms.lipColor.value.set(state.lips.color);
  lipUniforms.lipAmount.value = state.lips.amount;
  document.querySelectorAll('.lip-swatch').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.color === state.lips.color)));
  $('lip-custom').value = state.lips.color;
  $('lip-amount').value = state.lips.amount;
}

// ---------------------------------------------------------------- hairstyles

let hairStyles = [];
const hairFiles = {};       // style id -> Promise of the loaded file
let hairRequest = 0;
let shownStyle = null;

async function loadHairIndex() {
  try {
    hairStyles = await (await fetch(HAIR_INDEX_URL)).json();
  } catch {
    hairStyles = [];
  }
  const select = $('hair-style');
  for (const s of hairStyles) select.appendChild(new Option(s.name, s.id));
  select.value = state.hair.style;
  select.addEventListener('change', () => setHair({ style: select.value }));
}

/** Put hairstyle `id` on the character, loading it the first time. */
async function showHairstyle(id) {
  const request = ++hairRequest;
  const ch = await loadModel(state.body, state.model);
  if (ch !== current()) return;             // switched body or model meanwhile
  const style = hairStyles.find((s) => s.id === id);
  if (!style) return;
  if (!style.file) {                        // buzz cut: only the scalp layer
    if (request !== hairRequest) return;
    if (gizmo.object === ch.hair?.root) gizmo.detach();
    ch.hair?.detach();
    ch.hair = null;
    shownStyle = id;
    lipUniforms.scalpUnderHair.value = 0;
    return;
  }
  if (!ch.hairRigs[id]) {
    status(`Loading ${style.name}…`);
    hairFiles[id] ??= loadGLB(style.file);
    let gltf;
    try {
      gltf = await hairFiles[id];
    } catch {
      delete hairFiles[id];
      status(`Could not load ${style.name}.`);
      return;
    }
    if (!ch.hairRigs[id]) {
      // Each body gets its own copy: a rig takes over the scene it is given.
      const copy = SkeletonUtils.clone(gltf.scene);
      ch.hairRigs[id] = new HairRig(copy, ch.mesh, ch.headBone, ch.headBindWorld, ch.headMap, ch.body.head_map);
      ch.hairRigs[id].mesh.material = hairMat;
      ch.hairRigs[id].detach();
    }
    status('');
  }
  if (request !== hairRequest) return;      // a newer choice came in meanwhile
  const following = gizmo.object && gizmo.object === ch.hair?.root;
  ch.hair?.detach();
  ch.hair = ch.hairRigs[id];
  ch.hair.attach(scene);
  shownStyle = id;
  lipUniforms.scalpUnderHair.value = 1;
  if (following) gizmo.attach(ch.hair.root);
}

function pickFit(source) {
  return Object.fromEntries(FIT_KEYS.map((k) => [k, source[k] ?? FIT_DEFAULTS[k]]));
}

function setGizmo(mode) {
  const rig = current()?.hair;
  document.querySelectorAll('[data-gizmo]').forEach((b) => b.classList.toggle('on', b.dataset.gizmo === mode));
  if (mode === 'off' || !rig) {
    gizmo.detach();
    return;
  }
  gizmo.setMode(mode);
  gizmo.attach(rig.root);
}

/** Fits saved per body ({ female: { style: fit } }); older saves kept one set for the old body. */
function fitsByBody(hairFits) {
  if (!hairFits) return {};
  if (Object.keys(hairFits).some((k) => k in BODIES)) return hairFits;
  return Object.fromEntries(Object.keys(BODIES).map((b) => [b, hairFits]));
}

/** The fit `style` starts with on `body`: fitted here before, else the default's. */
function fitFor(body, style) {
  return state.hairFits[body]?.[style] ?? fitsByBody(defaults?.hairFits)[body]?.[style]
    ?? (defaults?.hair?.style === style ? pickFit(defaults.hair) : FIT_DEFAULTS);
}

function parkFit() {
  (state.hairFits[state.body] ??= {})[state.hair.style] = pickFit(state.hair);
}

function setHair(change) {
  if (change.style && change.style !== state.hair.style) {
    // Each style keeps its own fit: park this one's, bring the next one's back.
    parkFit();
    Object.assign(state.hair, FIT_DEFAULTS, fitFor(state.body, change.style));
  }
  Object.assign(state.hair, change);
  if ($('hair-style').value !== state.hair.style) $('hair-style').value = state.hair.style;
  if (hairStyles.length && state.hair.style !== shownStyle) showHairstyle(state.hair.style);
  setHairColor(hairMat, state.hair.color);
  lipUniforms.scalpColor.value.set(state.hair.color);
  lipUniforms.scalpAmount.value = state.hair.under;
  document.querySelectorAll('.hair-swatch').forEach((b) =>
    b.setAttribute('aria-checked', String(b.dataset.color === state.hair.color)));
  $('hair-custom').value = state.hair.color;
  document.querySelectorAll('[data-hair]').forEach((input) => { input.value = state.hair[input.dataset.hair]; });
}

function syncTime(from, to) {
  if (from?.action && to.action) to.action.time = from.action.time;
}

// ---------------------------------------------------------------- UI

function buildSwatches() {
  const box = $('swatches');
  SKIN_TONES.forEach((tone, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch' + (i >= 5 ? ' dark' : '');
    b.style.background = tone.hex;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `Tone ${i + 1} of ${SKIN_TONES.length}`);
    b.innerHTML = `<span>${i + 1}</span>`;
    b.addEventListener('click', () => setTone(i));
    b.addEventListener('keydown', (e) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!step) return;
      e.preventDefault();
      setTone((state.tone + step + SKIN_TONES.length) % SKIN_TONES.length);
      box.children[state.tone].focus();
    });
    box.appendChild(b);
  });
}

function setTone(i) {
  state.tone = i;
  skin.color.set(SKIN_TONES[i].hex);
  skin.sheenColor.set(SKIN_TONES[i].hex).lerp(new THREE.Color(0xffffff), 0.3);
  [...$('swatches').children].forEach((b, k) => {
    b.setAttribute('aria-checked', String(k === i));
    b.tabIndex = k === i ? 0 : -1;
  });
  $('tone-value').textContent = `${i + 1} / ${SKIN_TONES.length}`;
}

function buildAnimationList(clips) {
  const select = $('anim');
  const names = [...clips.keys()];
  const featured = FEATURED.filter((n) => clips.has(n));
  const rest = names.filter((n) => !featured.includes(n)).sort();
  const group = (label, list) => {
    const g = document.createElement('optgroup');
    g.label = label;
    list.forEach((n) => g.appendChild(new Option(n.replace(/_/g, ' '), n)));
    select.appendChild(g);
  };
  select.appendChild(new Option('T-pose (no animation)', ''));
  group('Featured', featured);
  group('All animations', rest);
  select.value = state.anim;
  select.addEventListener('change', () => {
    state.anim = select.value;
    applyAnimation();
  });
}

function applyAnimation() {
  for (const ch of Object.values(characters)) {
    ch.hair?.reset();
    if (state.anim) {
      playAnimation(ch, state.anim);
    } else {
      ch.mixer.stopAllAction();
      ch.action = null;
      ch.root.traverse((o) => o.isSkinnedMesh && o.skeleton.pose());
    }
  }
}

/** Show `body` ("female" / "male") as `model` ("fixed" or its "original" source). */
async function setCharacter(body = state.body, model = state.model) {
  document.querySelectorAll('[data-model]').forEach((b) => b.classList.toggle('on', b.dataset.model === model));
  document.querySelectorAll('[data-body]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.body === body));
    b.classList.toggle('on', b.dataset.body === body);
  });
  const k = charKey(body, model);
  if (!characters[k]) status(`Loading ${model === 'original' ? 'original ' : ''}${BODIES[body].label.toLowerCase()} model…`);
  const previous = current();
  let ch;
  try {
    ch = await loadModel(body, model);
  } catch (err) {
    console.error(err);
    status('Could not load that model.');
    return;
  }
  if (body !== state.body) {
    // Each body keeps its own hair fits: park this one's, bring the next one's back.
    parkFit();
    state.body = body;
    Object.assign(state.hair, FIT_DEFAULTS, fitFor(body, state.hair.style));
    setHair({});
  }
  state.model = model;
  setGizmo('off');
  applyAnimation();
  syncTime(previous, ch);
  for (const [key, c] of Object.entries(characters)) c.root.visible = key === k;
  for (const c of Object.values(characters)) if (c.bonesHelper) c.bonesHelper.visible = $('bones').checked && c.root.visible;
  useBodyLandmarks(ch.body);
  applyWeightView();
  if (hairStyles.length) {
    shownStyle = null;
    showHairstyle(state.hair.style);
  }
  status('');
}

function applyWeightView() {
  for (const ch of Object.values(characters)) {
    ch.mesh.material = state.weights ? weightMaterial : skin;
  }
}

function status(text) {
  $('status').textContent = text;
}

function randomize() {
  setTone(Math.floor(Math.random() * SKIN_TONES.length));
}

// What a saved character or a default holds.
function snapshot() {
  const tone = SKIN_TONES[state.tone];
  return {
    name: $('name').value.trim(),
    skinTone: { index: state.tone + 1, id: tone.id, hex: tone.hex },
    body: state.body,
    expression: state.expression,
    mouth: { ...state.mouth },
    hands: state.hands,
    hair: { ...state.hair },
    hairFits: {
      ...state.hairFits,
      [state.body]: { ...state.hairFits[state.body], [state.hair.style]: pickFit(state.hair) },
    },
    lips: { ...state.lips },
    face: { ...state.face },
    savedAt: new Date().toISOString(),
  };
}

/** Put a saved character or a default on screen. Defaults leave the name alone. */
function applySetup(setup, { withName = false } = {}) {
  if (!setup) return;
  if (withName) $('name').value = setup.name ?? '';
  const i = (setup.skinTone?.index ?? 0) - 1;
  if (i >= 0 && i < SKIN_TONES.length) setTone(i);
  if (setup.body in BODIES && setup.body !== state.body) {
    state.body = setup.body;                  // the model follows in setCharacter
    if (characters[charKey()]) setCharacter();
  }
  const fits = fitsByBody(setup.hairFits);
  for (const [b, f] of Object.entries(fits)) state.hairFits[b] = { ...state.hairFits[b], ...f };
  if (setup.hair) {
    const style = setup.hair.style ?? HAIR_DEFAULTS.style;
    state.hair.style = style;                 // switch without parking the old fit
    // A saved fit for this body wins; one saved for the old single body stays a fallback.
    const fit = fits[state.body]?.[style] ?? pickFit(setup.hair);
    setHair({ ...HAIR_DEFAULTS, ...setup.hair, ...fit, style });
  }
  if (setup.lips) setLips({ ...LIP_DEFAULTS, ...setup.lips });
  if (setup.face) setFace(setup.face);
  if (setup.hands) {
    state.hands = setup.hands;
    document.querySelectorAll('[data-hands]').forEach((o) => o.classList.toggle('on', o.dataset.hands === state.hands));
  }
  if (setup.expression && setup.expression in EXPRESSIONS) setExpression(setup.expression);
  if (setup.mouth) {
    Object.assign(state.mouth, setup.mouth);
    $('mouth-open').value = state.mouth.open;
    $('mouth-smile').value = state.mouth.smile;
    $('mouth-round').value = state.mouth.round;
  }
  for (const ch of Object.values(characters)) ch.hair?.reset();
}

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function save() {
  const character = snapshot();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(character));
  } catch {
    status('Could not save: this browser is blocking storage for the page.');
    return null;
  }
  status(`Saved at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. It will load next time you open the page.`);
  return character;
}

function confirmCharacter() {
  if (!$('name').value.trim()) {
    status('Please enter a name first.');
    $('name').focus();
    return;
  }
  const character = save() ?? snapshot();
  window.dispatchEvent(new CustomEvent('character-confirmed', { detail: character }));
  status(`Saved ${character.name} with skin tone ${character.skinTone.index}.`);
}

// ---------------------------------------------------------------- defaults for everyone
//
// Where everyone's starting setup comes from, later ones winning:
//   1. the built-in values in this file and hair.js,
//   2. models/defaults.json next to the page (committed to the repo),
//   3. the published artifact's shared store, set with "Set as default".
// A person's own Save still wins over all of them in their browser.

const DEFAULT_DOC = 'settings/default';
let defaults = null;
let sharedDb = null;

async function loadDefaults() {
  try {
    const res = await fetch(DEFAULTS_URL);
    if (res.ok) defaults = await res.json();
  } catch { /* no defaults file */ }
  const runtime = window.claude;
  if (!runtime?.use) return;
  sharedDb = await runtime.use('db');
  if (!sharedDb) return;
  try {
    const snap = await sharedDb.doc(DEFAULT_DOC).get();
    if (snap.exists) defaults = { ...defaults, ...snap.data() };
  } catch { /* shared store unavailable: keep the file's defaults */ }
}

/** Offer `data` as a JSON file: the artifact's download prompt, or a plain browser download. */
async function saveJson(filename, data) {
  const text = JSON.stringify(data, null, 2);
  const downloads = window.claude?.use ? await window.claude.use('downloads') : null;
  if (downloads) {
    try {
      await downloads.save({ filename, data: text });
      return true;
    } catch (e) {
      if (e?.code === 'declined') return false;
      status(`Could not save the file (${e?.code ?? 'error'}).`);
      return false;
    }
  }
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([text], { type: 'application/json' })), download: filename,
  });
  a.click();
  URL.revokeObjectURL(a.href);
  return true;
}

async function downloadSetup() {
  const setup = snapshot();
  delete setup.name;
  if (await saveJson('defaults.json', setup)) {
    status('Saved defaults.json with every hairstyle fit. Send it to Claude, or put it in models/ and commit it.');
  }
}

async function setAsDefault() {
  const setup = snapshot();
  delete setup.name;
  if (sharedDb) {
    try {
      await sharedDb.doc(DEFAULT_DOC).set(setup);
      defaults = setup;
      status('Set as the default for everyone who opens this page.');
    } catch {
      status('Only the owner or an editor of this page can set the default.');
    }
    return;
  }
  // Running from the repo: hand over the file to commit as models/defaults.json.
  if (await saveJson('defaults.json', setup)) {
    defaults = setup;
    status('Downloaded defaults.json. Put it in the models folder (models/defaults.json) and commit it.');
  }
}

// ---------------------------------------------------------------- start

function resize() {
  const { clientWidth: w, clientHeight: h } = canvas.parentElement;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  for (const ch of Object.values(characters)) ch.mixer.update(dt);
  poseHands(dt);
  poseMouth(dt);
  for (const ch of Object.values(characters)) {
    if (!ch.hair) continue;
    ch.root.updateMatrixWorld(true); // the physics reads this frame's head and spine
    ch.hair.update(dt, state.hair);
  }
  controls.update();
  stepView(dt);
  renderer.render(scene, camera);
});

buildSwatches();
setTone(state.tone);
resize();

document.querySelectorAll('[data-expression]').forEach((b) =>
  b.addEventListener('click', () => setExpression(b.dataset.expression)));
for (const [id, key] of [['mouth-open', 'open'], ['mouth-smile', 'smile'], ['mouth-round', 'round']]) {
  $(id).addEventListener('input', (e) => {
    state.mouth[key] = Number(e.target.value);
    if (state.expression !== 'talking') {
      state.expression = 'custom';
      document.querySelectorAll('[data-expression]').forEach((b) => b.setAttribute('aria-checked', 'false'));
    }
  });
}
setExpression(state.expression);
buildHairControls();
buildLipControls();
buildFaceControls();
document.querySelectorAll('[data-hands]').forEach((b) =>
  b.addEventListener('click', () => {
    state.hands = b.dataset.hands;
    document.querySelectorAll('[data-hands]').forEach((o) => o.classList.toggle('on', o === b));
  }));
document.querySelectorAll('[data-model]').forEach((b) =>
  b.addEventListener('click', () => setCharacter(state.body, b.dataset.model)));
document.querySelectorAll('[data-body]').forEach((b) =>
  b.addEventListener('click', () => setCharacter(b.dataset.body, state.model)));
$('bones').addEventListener('change', (e) => {
  for (const ch of Object.values(characters)) {
    if (!ch.bonesHelper) {
      ch.bonesHelper = new THREE.SkeletonHelper(ch.root);
      ch.bonesHelper.material.depthTest = false;
      scene.add(ch.bonesHelper);
    }
    ch.bonesHelper.visible = e.target.checked && ch.root.visible;
  }
});
$('weights').addEventListener('change', (e) => {
  state.weights = e.target.checked;
  applyWeightView();
});
$('random').addEventListener('click', randomize);
$('confirm').addEventListener('click', confirmCharacter);
$('save').addEventListener('click', save);
$('set-default').addEventListener('click', setAsDefault);
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('download-setup').addEventListener('click', downloadSetup);

// Start from the defaults, then this browser's own save if there is one.
const savedCharacter = readSaved();
const ready = Promise.all([loadDefaults(), loadHairIndex()]);
ready.then(() => {
  if (savedCharacter) {
    applySetup(savedCharacter, { withName: true });
    status(`Loaded your saved character${savedCharacter.name ? `, ${savedCharacter.name}` : ''}.`);
  } else {
    applySetup(defaults);
  }
});

// The body comes from this browser's save, else the defaults.
ready.then(() => {
  const b = savedCharacter?.body ?? defaults?.body;
  if (b in BODIES) state.body = b;
  return loadModel(state.body, 'fixed');
}).then(async (ch) => {
  buildAnimationList(ch.clips);
  await setCharacter(state.body, 'fixed');
  $('loading').classList.add('hidden');
}).catch((err) => {
  console.error(err);
  $('loading').textContent = 'Could not load the character. Serve this folder over HTTP (see README).';
});

// Lets tests and other pages read the current selection.
window.characterCreation = { state, setTone, SKIN_TONES, characters, camera, controls };
