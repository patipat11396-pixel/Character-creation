import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { HAIR_DEFAULTS, HairRig, hairMaterial, makeHairCollision } from '../hair.js';

// The character's look in the fight, from the setup the menu saved: painted
// skin with its tone, lips, eye colour and brows (the menu's skin shader),
// face shapes, and the hairstyle with its fit and movement.

const LIP_DEFAULTS = { color: '#b8676d', amount: 0.35 };
const BROW_DEFAULTS = { color: 'hair', spacing: 0, size: 1, thickness: 0.5, amount: 1 };
const FACE_NEG_SCALE = { lipsFull: 0.5, lipsWidth: 0.6 };
const MESH_TO_WORLD = new THREE.Matrix4().makeRotationX(-Math.PI / 2).multiply(new THREE.Matrix4().makeScale(0.01, 0.01, 0.01));

const STORAGE_KEY = 'character-creation:character';

/** The character in the menu's current save slot (the one Confirm saved). */
export function readSetup() {
  try {
    const slot = localStorage.getItem(`${STORAGE_KEY}:current`) ?? '0';
    return JSON.parse(localStorage.getItem(`${STORAGE_KEY}:slot${slot}`) ?? localStorage.getItem(STORAGE_KEY)) ?? null;
  } catch { return null; }
}

/** The skin material for `body` with the setup's tone, lips, eyes and brows. */
export async function skinMaterial(body, setup, texLoader, extras) {
  const load = async (name, srgb, ext = 'jpg') => {
    const t = await texLoader.loadAsync(`models/skin/${body}_${name}.${ext}`);
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const [map, roughnessMap, featureMask, browTex, info] = await Promise.all([
    load('color', true), load('rough', false), load('mask', false, 'png'), load('brow', true, 'png'),
    fetch(`models/skin/${body}.json`).then((r) => r.json()),
  ]);
  const tone = setup?.skinTone?.hex ?? null;
  const lips = { ...LIP_DEFAULTS, ...setup?.lips };
  const brows = { ...BROW_DEFAULTS, ...setup?.brows };
  const hairColor = setup?.hair?.color ?? HAIR_DEFAULTS.color;
  const browColor = brows.color === 'hair' ? hairColor : brows.color;
  const eye = setup?.eyes?.color ?? null;
  const m = extras ?? {};
  const u = {
    lipColor: { value: new THREE.Color(lips.color) }, lipAmount: { value: lips.amount },
    mouthZ: { value: m.mouth_z ?? 133.5 },
    mouthLine: { value: new THREE.Vector4(m.mouth?.z ?? 133.55, m.mouth?.kz ?? 0.045, m.mouth?.y ?? -5.95, m.mouth?.ky ?? 0.18) },
    mouthHalf: { value: m.mouth?.half ?? 3.1 },
    eyeColor: { value: new THREE.Color(eye ?? 0x7a4a26) }, eyeTint: { value: eye ? 1 : 0 },
    browOffset: { value: new THREE.Vector2(brows.spacing, 0) }, browScale: { value: brows.size }, browAngle: { value: 0 },
    browThick: { value: brows.thickness }, browAmount: { value: brows.amount },
    browColor: { value: new THREE.Color(browColor ?? '#3b2a20') }, browTint: { value: browColor ? 1 : 0 },
    featureMask: { value: featureMask }, toneColor: { value: new THREE.Color(tone ?? 0xffffff) },
    skinRef: { value: new THREE.Color(info.reference) }, toneOn: { value: tone ? 1 : 0 },
    browTex: { value: browTex }, browBox: { value: new THREE.Vector4(...info.browBox) }, frontY: { value: info.frontY },
  };
  const mat = new THREE.MeshPhysicalMaterial({ map, roughnessMap, roughness: 1, sheen: 0.25, sheenRoughness: 0.6, side: THREE.DoubleSide });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float _lipmask;\nvarying float vLip;\nvarying vec3 vSkinPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vLip = _lipmask;\n  vSkinPos = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 lipColor; uniform float lipAmount; varying float vLip;
uniform float mouthZ; uniform vec4 mouthLine; uniform float mouthHalf;
uniform vec3 eyeColor; uniform float eyeTint; uniform sampler2D featureMask;
uniform vec3 toneColor; uniform vec3 skinRef; uniform float toneOn;
uniform sampler2D browTex; uniform vec4 browBox; uniform float frontY;
uniform vec2 browOffset; uniform float browScale; uniform float browAngle; uniform float browThick;
uniform float browAmount; uniform vec3 browColor; uniform float browTint;
varying vec3 vSkinPos;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
  {
    vec3 fm = texture2D(featureMask, vMapUv).rgb;
    if (toneOn > 0.5) {
      float tl = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)) / max(dot(skinRef, vec3(0.299, 0.587, 0.114)), 1e-3);
      diffuseColor.rgb = mix(toneColor * tl, diffuseColor.rgb, fm.b);
    }
    float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(diffuseColor.rgb, lipColor * (0.45 + 1.1 * lum), clamp(fm.g, 0.0, 1.0) * lipAmount);
    diffuseColor.rgb = mix(diffuseColor.rgb, eyeColor * (0.25 + 2.2 * lum), fm.r * eyeTint);
    vec2 c = 0.5 * (browBox.xy + browBox.zw);
    vec2 d = vec2(abs(vSkinPos.x) - c.x - browOffset.x, vSkinPos.z - c.y - browOffset.y);
    float ca = cos(browAngle), sa = sin(browAngle);
    d = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / browScale;
    vec2 size = browBox.zw - browBox.xy;
    vec2 bu = vec2(d.x / size.x + 0.5, 0.5 - d.y / size.y);
    if (vSkinPos.y < frontY && bu.x > 0.0 && bu.x < 1.0 && bu.y > 0.0 && bu.y < 1.0) {
      vec4 b = texture2D(browTex, bu);
      float a = pow(b.a, exp2((0.5 - browThick) * 3.0)) * browAmount;
      float bl = dot(b.rgb, vec3(0.299, 0.587, 0.114));
      vec3 bc = mix(b.rgb, browColor * (0.4 + 1.6 * bl), browTint);
      diffuseColor.rgb = mix(diffuseColor.rgb, bc, clamp(a, 0.0, 1.0));
    }
  }`)
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
  float mx = vSkinPos.x * vSkinPos.x;
  float mz = vSkinPos.z - mouthLine.x - mouthLine.y * mx;
  float my = vSkinPos.y - mouthLine.z - mouthLine.w * mx;
  float ax = abs(vSkinPos.x);
  float deep = 0.9 + max(0.0, -mz - 0.6) + max(0.0, mz - 0.5) + (ax > mouthHalf + 0.3 ? 0.9 : 0.0);
  bool inMouth = ax < mouthHalf + 1.5 && mz > -2.4 && mz < 1.4 && my > deep && my < 4.0;
  if ((!gl_FrontFacing && abs(vSkinPos.z - mouthZ) < 2.2 && abs(vSkinPos.x) < 7.0) || inMouth)
    gl_FragColor.rgb = vec3(0.015);`);
  };
  return mat;
}

/** Face shape keys and the mouth (expression) from the setup, on every part that has them. */
export function applyFace(root, setup) {
  const face = setup?.face ?? {};
  const m = setup?.mouth ?? {};
  // The mouth as the menu mixes it: smile below 0 is a frown.
  const mouth = { jawOpen: m.open ?? 0, smile: Math.max(m.smile ?? 0, 0), frown: Math.max(-(m.smile ?? 0), 0), mouthRound: m.round ?? 0 };
  root.traverse((o) => {
    if (!o.morphTargetDictionary) return;
    for (const [k, v] of Object.entries(face)) {
      const i = o.morphTargetDictionary[k];
      if (i !== undefined) o.morphTargetInfluences[i] = v < 0 ? v * (FACE_NEG_SCALE[k] ?? 1) : v;
    }
    for (const [k, v] of Object.entries(mouth)) {
      const i = o.morphTargetDictionary[k];
      if (i !== undefined) o.morphTargetInfluences[i] = v;
    }
  });
}

// ---- clothes, as fitted in the menu
const CLOTH_FIT_DEFAULTS = { size: 1, width: 1, height: 1, depth: 1, up: 0, forward: 0 };

/**
 * The material for a garment (a Cloth_<id> part) with its fit from the menu:
 * scaled about its own centre and offset in the body's bind pose before
 * skinning (mesh cm: x side, y back, z up), as the menu does.
 */
export function clothMaterial(o, fit) {
  const f = { ...CLOTH_FIT_DEFAULTS, ...fit };
  o.geometry.computeBoundingBox();
  const u = {
    clothScale: { value: new THREE.Vector3(f.size * f.width, f.size * f.depth, f.size * f.height) },
    clothOffset: { value: new THREE.Vector3(0, -f.forward, f.up) },
    clothCentre: { value: o.geometry.boundingBox.getCenter(new THREE.Vector3()) },
  };
  const m = new THREE.MeshStandardMaterial({ color: o.material.color, roughness: 0.85, side: THREE.DoubleSide, shadowSide: THREE.FrontSide });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec3 clothScale; uniform vec3 clothOffset; uniform vec3 clothCentre;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  transformed = (transformed - clothCentre) * clothScale + clothCentre + clothOffset;');
  };
  return m;
}

/** Thighs turned inward (degrees) while animating, as set in the menu: the clips were made for wider hips. */
export const LEG_DEFAULTS = { female: 0, male: 0 };

/**
 * The setup's hairstyle on a fighter (in its bind pose, before it moves).
 * Returns { rig, state } or null for bald; call rig.update(dt, state) each frame.
 */
// Loaded once each (a crowd of foes shares the hairstyle: each gets a clone).
const hairFiles = new Map();
let hairIndex = null, hairDefaults = null;
export async function hairFor(fighter, body, setup, loadGLB, scene) {
  const hair = { ...HAIR_DEFAULTS, ...setup?.hair };
  if (!hair.style || hair.style === 'bald') return null;
  hairIndex ??= fetch('models/hair/index.json').then((r) => r.json());
  const index = await hairIndex;
  const entry = index.find((e) => e.id === hair.style);
  if (!entry?.file) return null;
  if (!hairFiles.has(entry.file)) hairFiles.set(entry.file, loadGLB(entry.file));
  const file = await hairFiles.get(entry.file);
  const gltf = { scene: SkeletonUtils.clone(file.scene) };
  const extras = fighter.root.userData.body;
  const head = fighter.bones.Head;
  // Fitted against the head as modelled (as in the menu): the fight draws the
  // head 12% smaller every frame, and fitting against that scaled head made
  // the hair 1/0.88 too big and pushed it off the head.
  const shown = head.scale.clone();
  head.scale.setScalar(1);
  fighter.root.updateMatrixWorld(true);
  const m = new THREE.Matrix4().makeScale(...extras.head_map.scale).setPosition(...extras.head_map.offset);
  const headMap = MESH_TO_WORLD.clone().multiply(m).multiply(MESH_TO_WORLD.clone().invert());
  // The head's bind pose from the skeleton (whatever pose the body is in now),
  // relative to the fighter's root: the hair map is in the root's space.
  const sk = fighter.mesh.skeleton;
  const headBind = fighter.mesh.bindMatrix.clone().multiply(sk.boneInverses[sk.bones.indexOf(head)].clone().invert());
  const rootInv = fighter.root.matrixWorld.clone().invert();
  const meshInRoot = rootInv.multiply(fighter.mesh.matrixWorld);
  const rig = new HairRig(gltf.scene, fighter.mesh, head, meshInRoot.multiply(headBind), headMap, extras.head_map, extras.colliders);
  // Its own ellipsoid uniforms: with one shared set, each hairstyle was pushed
  // out of the other fighter's body (and floated off its head).
  rig.collision = makeHairCollision();
  rig.mesh.material = hairMaterial(hair.color, rig.collision);
  rig.attach(scene);
  head.scale.copy(shown);
  // The fit saved for this style and body wins over the general one.
  let fit = setup?.hairFits?.[body]?.[hair.style];
  if (!fit) {
    hairDefaults ??= fetch('models/defaults.json').then((r) => r.json()).catch(() => null);
    const defaults = await hairDefaults;
    fit = defaults?.hairFits?.[body]?.[hair.style];
  }
  return { rig, state: { ...hair, ...fit, collide: hair.collide !== false } };
}
