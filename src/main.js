import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { SKIN_TONES, DEFAULT_TONE } from './skinTones.js';
import { HAIR_COLORS, HAIR_DEFAULTS, HairRig, hairMaterial, setHairColor } from './hair.js';

const MODELS = {
  fixed: 'models/character.glb',
  original: 'models/source/retargeted_animations.glb',
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

const $ = (id) => document.getElementById(id);
const canvas = $('view');

const state = {
  name: '',
  tone: DEFAULT_TONE,
  anim: 'Idle_A',
  model: 'fixed',
  weights: false,
  hands: 'auto',
  expression: 'neutral',
  mouth: { open: 0, smile: 0, round: 0 },
  hair: { ...HAIR_DEFAULTS },
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
controls.enablePan = false;
controls.minDistance = 1.2;
controls.maxDistance = 7;
controls.minPolarAngle = 0.35;
controls.maxPolarAngle = Math.PI / 2 + 0.05;

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
skin.onBeforeCompile = (shader) => {
  shader.fragmentShader = shader.fragmentShader.replace('#include <dithering_fragment>',
    '#include <dithering_fragment>\n  if (!gl_FrontFacing) gl_FragColor.rgb = vec3(0.12, 0.04, 0.04);');
};
const weightMaterial = new THREE.MeshLambertMaterial({ vertexColors: true });
const hairMat = hairMaterial(HAIR_DEFAULTS.color);

// ---------------------------------------------------------------- models

const loader = new GLTFLoader();
const characters = {}; // model key -> { root, mesh, mixer, clips, action }
const clock = new THREE.Clock();

async function loadModel(kind) {
  if (characters[kind]) return characters[kind];
  const gltf = await loader.loadAsync(MODELS[kind]);
  const root = gltf.scene;
  let mesh, hairMesh;
  const faceMeshes = []; // every part with mouth shape keys: body, teeth, tongue
  root.traverse((o) => {
    if (o.isSkinnedMesh) {
      if (o.material.name === 'Hair') hairMesh = o;
      else if (!['Teeth', 'Tongue'].includes(o.material.name)) mesh = o;
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
  let hair = null;
  if (hairMesh) {
    hairMesh.material = hairMat;
    root.updateMatrixWorld(true);
    hair = new HairRig(hairMesh, mesh);
  }
  const mixer = new THREE.AnimationMixer(root);
  const clips = new Map(gltf.animations.map((c) => [c.name.replace(/_RT$/, ''), c]));
  const character = { root, mesh, mixer, clips, fingers, faceMeshes, hair, action: null };
  characters[kind] = character;
  scene.add(root);
  return character;
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
  $('hair-reset').addEventListener('click', () => {
    setHair({ ...HAIR_DEFAULTS, color: state.hair.color });
    for (const ch of Object.values(characters)) ch.hair?.reset();
  });
  setHair({});
}

function setHair(change) {
  Object.assign(state.hair, change);
  setHairColor(hairMat, state.hair.color);
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

async function setModel(kind) {
  const buttons = document.querySelectorAll('[data-model]');
  buttons.forEach((b) => b.classList.toggle('on', b.dataset.model === kind));
  if (!characters[kind]) status('Loading original model…');
  const previous = characters[state.model];
  const ch = await loadModel(kind);
  state.model = kind;
  applyAnimation();
  syncTime(previous, ch);
  for (const [k, c] of Object.entries(characters)) c.root.visible = k === kind;
  applyWeightView();
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

function confirmCharacter() {
  const name = $('name').value.trim();
  if (!name) {
    status('Please enter a name first.');
    $('name').focus();
    return;
  }
  const tone = SKIN_TONES[state.tone];
  const character = {
    name,
    skinTone: { index: state.tone + 1, id: tone.id, hex: tone.hex },
    expression: state.expression,
    mouth: { ...state.mouth },
    hair: { ...state.hair },
    createdAt: new Date().toISOString(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(character));
  } catch { /* storage may be unavailable; the event below still carries the data */ }
  window.dispatchEvent(new CustomEvent('character-confirmed', { detail: character }));
  status(`Saved ${name} with skin tone ${state.tone + 1}.`);
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!saved) return;
    $('name').value = saved.name ?? '';
    const i = (saved.skinTone?.index ?? 0) - 1;
    if (i >= 0 && i < SKIN_TONES.length) state.tone = i;
  } catch { /* ignore unreadable storage */ }
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
  renderer.render(scene, camera);
});

restore();
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
document.querySelectorAll('[data-hands]').forEach((b) =>
  b.addEventListener('click', () => {
    state.hands = b.dataset.hands;
    document.querySelectorAll('[data-hands]').forEach((o) => o.classList.toggle('on', o === b));
  }));
document.querySelectorAll('[data-model]').forEach((b) =>
  b.addEventListener('click', () => setModel(b.dataset.model)));
$('weights').addEventListener('change', (e) => {
  state.weights = e.target.checked;
  applyWeightView();
});
$('random').addEventListener('click', randomize);
$('confirm').addEventListener('click', confirmCharacter);

loadModel('fixed').then((ch) => {
  buildAnimationList(ch.clips);
  applyAnimation();
  $('loading').classList.add('hidden');
}).catch((err) => {
  console.error(err);
  $('loading').textContent = 'Could not load the character. Serve this folder over HTTP (see README).';
});

// Lets tests and other pages read the current selection.
window.characterCreation = { state, setTone, SKIN_TONES, characters, camera, controls };
