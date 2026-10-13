import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

// Animation editor: change the fighters' clips frame by frame.
//
// Pick an animation and a frame, then click a joint and turn it with the
// gizmo's rings or move it with its arrows (the hips move; a hand or foot
// moves with IK, the arm or leg following), as in a 3D tool; or set each
// joint's turn (X / Y / Z, in degrees from the rest pose) with the sliders,
// grouped in tabs as in the character creator. A change keys that joint on
// that frame only. Preview
// plays the animation. Copy / paste a frame, undo / redo. "Use in the game"
// sets which move or pose plays an animation and the move's hit and end
// frames. Everything is kept in this browser, used by the fight, and can be
// exported / imported as JSON.

const EDIT_KEY = 'character-creation:anim-edits';
const FPS = 30;   // the editor works in frames of 1/30 s
const ORIGINALS = new WeakMap();   // clip -> Map(track name -> { times, values } | null): before any edit

export function readEdits() {
  try { return JSON.parse(localStorage.getItem(EDIT_KEY)) ?? {}; } catch { return {}; }
}
function writeEdits(edits) {
  try { localStorage.setItem(EDIT_KEY, JSON.stringify(edits)); return true; } catch { return false; }
}

function remember(clip, name) {
  if (!ORIGINALS.has(clip)) ORIGINALS.set(clip, new Map());
  const m = ORIGINALS.get(clip);
  if (m.has(name)) return;
  const tr = clip.tracks.find((t) => t.name === name);
  m.set(name, tr ? { times: Array.from(tr.times), values: Array.from(tr.values) } : null);
}

function makeTrack(name, times, values) {
  const Track = name.endsWith('.position') ? THREE.VectorKeyframeTrack : THREE.QuaternionKeyframeTrack;
  return new Track(name, times, values);
}

function setTrack(clip, name, times, values) {
  remember(clip, name);
  const i = clip.tracks.findIndex((t) => t.name === name);
  const track = makeTrack(name, times, values);
  if (i >= 0) clip.tracks[i] = track; else clip.tracks.push(track);
}

function dropSplits(clips, name) {
  clips.delete(`${name}#upper`);
  clips.delete(`${name}#lower`);
}

/**
 * Put saved edits (or `edits`) into a fighter's clips (a Map of name -> clip):
 * changed tracks into existing clips, and clips made in the editor (`custom`) added whole.
 */
export function applyAnimEdits(clips, edits = readEdits()) {
  for (const [clipName, data] of Object.entries(edits)) {
    let clip = clips.get(clipName);
    if (data.custom) {
      const tracks = Object.entries(data.tracks ?? {}).map(([n, t]) => makeTrack(n, t.times, t.values));
      clip = new THREE.AnimationClip(clipName, data.duration, tracks);
      clip.userData = { custom: true };
      clips.set(clipName, clip);
      ORIGINALS.set(clip, new Map());
      dropSplits(clips, clipName);
      continue;
    }
    if (!clip) continue;
    for (const [name, t] of Object.entries(data.tracks ?? {})) setTrack(clip, name, t.times, t.values);
    if (data.duration) clip.duration = data.duration;
    dropSplits(clips, clipName);
  }
}

/** Put a clip's tracks back as they were before any edit. */
function revertClip(clip, clips) {
  const m = ORIGINALS.get(clip);
  if (!m) return;
  for (const [name, orig] of m) {
    const i = clip.tracks.findIndex((t) => t.name === name);
    if (orig) setTrack(clip, name, orig.times, orig.values);
    else if (i >= 0) clip.tracks.splice(i, 1);
  }
  ORIGINALS.delete(clip);
  dropSplits(clips, clip.name);
}

/** Two-bone IK: turn `a` and `b` so the chain a -> b -> c ends at `target`, the middle joint toward `pole`. */
function twoBoneIK(a, b, c, target, pole) {
  const S = a.getWorldPosition(new THREE.Vector3());
  const M = b.getWorldPosition(new THREE.Vector3()), E = c.getWorldPosition(new THREE.Vector3());
  const l1 = S.distanceTo(M), l2 = M.distanceTo(E);
  const toT = target.clone().sub(S);
  const dist = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-4, (l1 + l2) * 0.9995);
  const dir = toT.normalize();
  const along = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, l1 * l1 - along * along));
  const p = pole.clone().addScaledVector(dir, -pole.dot(dir));
  if (p.lengthSq() < 1e-8) return;
  p.normalize();
  aim(a, b, S.clone().addScaledVector(dir, along).addScaledVector(p, h));
  aim(b, c, S.clone().addScaledVector(dir, dist));
}
function aim(bone, child, target) {
  const at = bone.getWorldPosition(new THREE.Vector3());
  const cur = child.getWorldPosition(new THREE.Vector3()).sub(at).normalize();
  const want = target.clone().sub(at).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(cur, want);
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  bone.quaternion.copy(parent.invert().multiply(q.multiply(world)));
  bone.updateMatrixWorld(true);
}
// The chains a hand or foot drags with IK.
const IK_CHAINS = {
  RightHand: ['RightArm', 'RightForeArm'], LeftHand: ['LeftArm', 'LeftForeArm'],
  RightFoot: ['RightUpLeg', 'RightLeg'], LeftFoot: ['LeftUpLeg', 'LeftLeg'],
};

// The joints, in tabs, and what each is called on the panel.
const GROUPS = [
  ['Body', [['Hips', 'Hips (whole body)'], ['Spine', 'Lower back'], ['Spine1', 'Middle back'], ['Spine2', 'Chest']]],
  ['Head', [['Neck', 'Neck'], ['Head', 'Head']]],
  ['Right arm', [['RightShoulder', 'Shoulder'], ['RightArm', 'Upper arm'], ['RightForeArm', 'Forearm'], ['RightHand', 'Hand (sword)']]],
  ['Left arm', [['LeftShoulder', 'Shoulder'], ['LeftArm', 'Upper arm'], ['LeftForeArm', 'Forearm'], ['LeftHand', 'Hand']]],
  ['Right leg', [['RightUpLeg', 'Thigh'], ['RightLeg', 'Shin'], ['RightFoot', 'Foot'], ['RightToeBase', 'Toes']]],
  ['Left leg', [['LeftUpLeg', 'Thigh'], ['LeftLeg', 'Shin'], ['LeftFoot', 'Foot'], ['LeftToeBase', 'Toes']]],
];
const AXES = ['x', 'y', 'z'];

const css = `
#anim-editor { position: fixed; right: 0; top: 0; bottom: 0; width: 360px; z-index: 20; overflow-y: auto;
  background: linear-gradient(180deg, #1f232c, #181b22); border-left: 1px solid #2e323c; color: #e9ebf0;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 20px 20px 28px; display: flex; flex-direction: column; gap: 18px; }
#anim-editor[hidden] { display: none; }
#anim-editor h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: .02em; }
#anim-editor .top { display: flex; justify-content: space-between; }
#anim-editor a { color: #e2b45a; text-decoration: none; font-size: 13px; }
#anim-editor .field { display: flex; flex-direction: column; gap: 8px; }
#anim-editor .label { color: #9aa1b0; font-size: 13px; text-transform: uppercase; letter-spacing: .06em; }
#anim-editor .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; color: #9aa1b0; font-size: 13px; }
#anim-editor select, #anim-editor input[type=number], #anim-editor textarea {
  background: #15171c; color: #e9ebf0; border: 1px solid #2e323c; border-radius: 8px; padding: 8px 10px; font: inherit; font-size: 13px; }
#anim-editor select { width: 100%; }
#anim-editor button { background: transparent; color: #e9ebf0; border: 1px solid #2e323c; border-radius: 8px; padding: 6px 10px;
  font: inherit; font-size: 13px; cursor: pointer; }
#anim-editor button:hover:not(:disabled) { border-color: #e2b45a; }
#anim-editor button:disabled { opacity: .4; cursor: default; }
#anim-editor button.primary { background: #e2b45a; border-color: #e2b45a; color: #1a1a1a; font-weight: 600; }
#anim-editor button:focus-visible, #anim-editor input:focus-visible, #anim-editor select:focus-visible { outline: 2px solid #e2b45a; outline-offset: 1px; }
#anim-editor .stepper { display: grid; grid-template-columns: 2.4rem 1fr 2.4rem; gap: 6px; align-items: center; }
#anim-editor .stepper button { height: 2.2rem; color: #e2b45a; font-size: 18px; line-height: 1; padding: 0; }
#anim-editor .stepper output { text-align: center; background: #15171c; border: 1px solid #2e323c; border-radius: 6px; padding: 6px 4px; }
#anim-editor .frames { display: flex; flex-wrap: wrap; gap: 3px; }
#anim-editor .frames button { width: 26px; height: 22px; padding: 0; font-size: 10px; border-radius: 4px; color: #9aa1b0; background: #15171c; }
#anim-editor .frames button.key { color: #1a1a1a; background: #8a7444; border-color: #8a7444; }
#anim-editor .frames button.hit { box-shadow: inset 0 -3px 0 #2f7fff; }
#anim-editor .frames button.end { box-shadow: inset 0 -3px 0 #a07cf0; }
#anim-editor .frames button.on { outline: 2px solid #e2b45a; outline-offset: 1px; color: #fff; }
#anim-editor .frames button.key.on { color: #1a1a1a; background: #e2b45a; }
#anim-editor .tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid #2e323c; padding-bottom: 8px; }
#anim-editor .tabs button { padding: 6px 9px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: #9aa1b0; }
#anim-editor .tabs button[aria-selected=true] { border-color: #e2b45a; color: #e9ebf0; background: #2e323c; }
#anim-editor .joint { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid #2e323c; border-radius: 8px; }
#anim-editor .joint.picked { border-color: #e2b45a; }
#anim-editor .joint-head { display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
#anim-editor .joint-head .dot { color: #e2b45a; margin-left: 6px; visibility: hidden; }
#anim-editor .joint-head .dot.on { visibility: visible; }
#anim-editor .joint-head button { padding: 2px 8px; font-size: 12px; color: #9aa1b0; }
#anim-editor .slider { display: grid; grid-template-columns: 1.6em 1fr 4.2em; align-items: center; gap: 8px; font-size: 12px; color: #9aa1b0; }
#anim-editor .slider input[type=range] { width: 100%; accent-color: #e2b45a; }
#anim-editor .slider input[type=number] { padding: 3px 4px; text-align: right; }
#anim-editor .tool.on { background: #e2b45a; border-color: #e2b45a; color: #1a1a1a; }
#anim-editor .note, #anim-editor .status { margin: 0; color: #9aa1b0; font-size: 12px; }
#anim-editor textarea { width: 100%; height: 80px; font-size: 11px; }
`;

/**
 * The editor page. ctx: { scene, camera, canvas, fighters: () => [player, enemy],
 *   moves: [[label, move]], slots: { name: { clip, speed } }, saveAnim(), loadAnim(data) }.
 * Returns { open(fighter), update(dt), isOpen }.
 */
export function createAnimEditor(ctx) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const panel = document.createElement('div');
  panel.id = 'anim-editor';
  panel.hidden = true;
  document.body.appendChild(panel);

  const orbit = new OrbitControls(ctx.camera, ctx.canvas);
  orbit.enabled = false;
  orbit.enableDamping = true;
  orbit.screenSpacePanning = true;

  // Joint markers: click one to bring up its sliders.
  const markers = new THREE.Group();
  markers.visible = false;
  ctx.scene.add(markers);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0x2f7fff, depthTest: false, transparent: true, opacity: 0.8 });
  const markerOn = new THREE.MeshBasicMaterial({ color: 0xe2b45a, depthTest: false });

  const gizmo = new TransformControls(ctx.camera, ctx.canvas);
  gizmo.setSize(0.75);
  gizmo.setSpace('local');
  ctx.scene.add(gizmo.getHelper());
  const ikTarget = new THREE.Object3D();   // what the arrows drag for a hand or foot
  ctx.scene.add(ikTarget);
  let tool = 'rotate', drag = null;

  let fighter = null, clip = null, frame = 0, playing = false, isOpen = false, tab = 0, picked = null;
  let time = 0;   // while previewing; otherwise the frame's time
  let dirty = new Set();   // clip names changed since the last save
  const undoStack = [], redoStack = [];
  const rest = new Map();   // bone name -> { q, p }: the rest pose the sliders count from

  const body = new URLSearchParams(location.search).get('body');
  panel.innerHTML = `
    <div class="top"><a href="index.html">← Menu</a><a href="index.html#create">Character</a><a href="combat.html">Play ⚔</a></div>
    <h1>Animation editor</h1>
    <div class="field"><span class="label">Body</span>
      <select data-a="body"><option value="">My character</option><option value="female">Female</option><option value="male">Male</option></select></div>
    <div class="field"><span class="label">Animation</span>
      <select data-a="clip"></select>
      <div class="row"><button type="button" data-a="dup">Duplicate as new…</button>
        <span>Length <input data-a="len" type="number" step="1" min="2" style="width:64px"> frames</span></div></div>
    <div class="field"><span class="label">Frame</span>
      <div class="stepper"><button type="button" data-a="fprev" aria-label="Previous frame">‹</button><output data-a="fnow"></output><button type="button" data-a="fnext" aria-label="Next frame">›</button></div>
      <div class="frames" data-a="frames"></div>
      <p class="note">Gold: a frame with keys. Blue / purple line: the move's hit / end frame.</p>
      <div class="row"><button type="button" data-a="play">▶ Preview</button>
        <label><input type="checkbox" data-a="loop" checked> loop</label>
        <label>speed <select data-a="pspeed" style="width:auto"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option></select></label></div>
      <div class="row"><button type="button" data-a="copy">Copy frame</button><button type="button" data-a="paste">Paste frame</button>
        <button type="button" data-a="keyall" title="Key every joint on this frame as it is now">Key all joints</button>
        <button type="button" data-a="tpose" title="Key every joint on this frame in the T-pose (all sliders 0)">Reset to T-pose</button>
        <button type="button" data-a="clear" title="Remove this frame's keys (it follows the frames around it)">Clear frame</button></div>
      <div class="row"><button type="button" data-a="undo">↶ Undo</button><button type="button" data-a="redo">↷ Redo</button></div></div>
    <div class="field"><span class="label">Pose on this frame</span>
      <div class="row"><button type="button" class="tool on" data-a="trot" title="Turn the joint with the rings (E)">⟳ Rotate (E)</button>
        <button type="button" class="tool" data-a="tmove" title="Move with the arrows (W): the hips, or a hand or foot (IK)">✥ Move (W)</button>
        <button type="button" data-a="tspace" title="Gizmo in the joint's own axes or the world's">Local</button></div>
      <p class="note" data-a="picknote">Click a blue joint on the figure to get the gizmo.</p>
      <div class="tabs" role="tablist" data-a="tabs">${GROUPS.map(([n], i) => `<button type="button" role="tab" data-tab="${i}">${n}</button>`).join('')}</div>
      <div data-a="joints" class="field"></div>
      <p class="note">Degrees from the T-pose. A change (gizmo or slider) keys that joint on this frame only.</p></div>
    <div class="field"><span class="label">Use in the game</span>
      <select data-a="use"></select>
      <div class="row"><button type="button" data-a="useclip">Use this animation</button>
        <button type="button" data-a="sethit" title="The blow lands on this frame">Hit = this frame</button>
        <button type="button" data-a="setend" title="The move is over on this frame">End = this frame</button></div>
      <div class="row">Speed in the game <input data-a="speed" type="number" step="0.05" min="0.1" max="4" style="width:72px"></div>
      <p class="note" data-a="usenote"></p></div>
    <div class="field"><span class="label">Save</span>
      <div class="row"><button type="button" data-a="save" class="primary">Save (use in the fight)</button><button type="button" data-a="revert">Revert this animation</button></div>
      <div class="row"><button type="button" data-a="export">Export JSON</button><button type="button" data-a="import">Import JSON</button></div>
      <textarea data-a="json" placeholder="Exported edits appear here; paste edits here to import." hidden></textarea></div>
    <p class="status" data-a="status">Drag to orbit, right-drag to pan, scroll to zoom. Click a blue joint to bring up its sliders. Keys: , . frames · Space preview · Ctrl+Z / Ctrl+Y.</p>`;
  const $ = (a) => panel.querySelector(`[data-a="${a}"]`);
  const status = (t) => { $('status').textContent = t; };

  const frameCount = () => Math.max(1, Math.round(clip.duration * FPS));
  const frameTime = (f = frame) => Math.min(f / FPS, clip.duration);
  const trackOf = (name) => clip?.tracks.find((t) => t.name === name);
  const hasKey = (tr, t) => !!tr && Array.from(tr.times).some((x) => Math.abs(x - t) < 1e-3);

  // ---- showing a frame
  function pose(t = frameTime()) {
    if (!fighter || !clip) return;
    fighter.mixer.stopAllAction();
    // Fresh bindings: the mixer skips writing a value it wrote last time, and
    // the pose must be written whole before finishPose adds to it.
    fighter.mixer.uncacheClip(clip);
    const action = fighter.mixer.clipAction(clip);
    action.reset().play();
    action.paused = true;
    action.time = t;
    fighter.mixer.update(0);
    fighter.finishPose();
  }
  function rebind() {
    fighter.mixer.stopAllAction();
    fighter.mixer.uncacheClip(clip);
    dropSplits(fighter.clips, clip.name);
    pose();
  }
  function goFrame(n) {
    stopPreview();
    frame = THREE.MathUtils.clamp(Math.round(n), 0, frameCount());
    pose();
    syncFrame();
  }
  function syncFrame() {
    $('fnow').textContent = `${frame} / ${frameCount()}  ·  ${frameTime().toFixed(2)} s`;
    $('len').value = frameCount();
    drawFrames();
    syncJoints();
  }
  function drawFrames() {
    const keyed = new Set();
    for (const tr of clip.tracks) for (const t of tr.times) keyed.add(Math.round(t * FPS));
    const use = useTarget();
    const mark = use?.kind === 'move' && use.m.clip === clip.name
      ? { hit: Math.round((use.m.hit ?? -1) * FPS), end: Math.round((use.m.end ?? -1) * FPS) } : {};
    const n = frameCount();
    let html = '';
    for (let f = 0; f <= n; f++) {
      const cls = [keyed.has(f) && 'key', f === frame && 'on', f === mark.hit && 'hit', f === mark.end && 'end'].filter(Boolean).join(' ');
      html += `<button type="button" data-f="${f}" class="${cls}">${f}</button>`;
    }
    $('frames').innerHTML = html;
  }

  // ---- the joints' sliders
  function readQ(name, t = frameTime()) {
    const tr = trackOf(`${name}.quaternion`);
    return tr ? new THREE.Quaternion().fromArray(tr.createInterpolant().evaluate(t)) : rest.get(name).q.clone();
  }
  function readP(t = frameTime()) {
    const tr = trackOf('Hips.position');
    return tr ? new THREE.Vector3().fromArray(tr.createInterpolant().evaluate(t)) : rest.get('Hips').p.clone();
  }
  // Hips position slider units: centimetres in the world.
  const hipsScale = () => fighter.bones.Hips.parent.getWorldScale(new THREE.Vector3()).x;

  function buildJoints() {
    const [, joints] = GROUPS[tab];
    for (const b of panel.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(Number(b.dataset.tab) === tab));
    const row = (name, k, label, min, max) => `<label class="slider"><span>${label}</span>
      <input type="range" min="${min}" max="${max}" step="1" data-j="${name}" data-k="${k}">
      <input type="number" min="${min}" max="${max}" step="1" data-j="${name}" data-k="${k}"></label>`;
    $('joints').innerHTML = joints.filter(([n]) => fighter.bones[n]).map(([n, label]) => `
      <div class="joint" data-joint="${n}">
        <div class="joint-head"><span>${label}<span class="dot" title="Keyed on this frame">◆</span></span>
          <button type="button" data-unkey="${n}" title="Remove this joint's key on this frame">Unkey</button></div>
        ${AXES.map((a) => row(n, a, a.toUpperCase(), -180, 180)).join('')}
        ${n === 'Hips' ? `<div class="note">Move (cm)</div>${AXES.map((a) => row(n, `p${a}`, a.toUpperCase(), -120, 120)).join('')}` : ''}
      </div>`).join('');
    syncJoints();
  }
  function jointValues(name) {
    const local = rest.get(name).q.clone().invert().multiply(readQ(name));
    const e = new THREE.Euler().setFromQuaternion(local, 'XYZ');
    const v = { x: e.x, y: e.y, z: e.z };
    for (const a of AXES) v[a] = Math.round(THREE.MathUtils.radToDeg(v[a]));
    if (name === 'Hips') {
      const d = readP().sub(rest.get('Hips').p).multiplyScalar(hipsScale() * 100);
      for (const a of AXES) v[`p${a}`] = Math.round(d[a]);
    }
    return v;
  }
  function syncJoints() {
    for (const box of panel.querySelectorAll('[data-joint]')) {
      const name = box.dataset.joint;
      const v = jointValues(name);
      for (const input of box.querySelectorAll('input[data-k]')) if (document.activeElement !== input) input.value = v[input.dataset.k];
      const keyed = hasKey(trackOf(`${name}.quaternion`), frameTime()) || (name === 'Hips' && hasKey(trackOf('Hips.position'), frameTime()));
      box.querySelector('.dot').classList.toggle('on', keyed);
      box.classList.toggle('picked', name === picked);
    }
  }

  /** Put a key of `values` on this frame in track `name` (made if missing, holding the old pose elsewhere). */
  function setKey(name, values, t = frameTime()) {
    const n = values.length;
    const tr = trackOf(name);
    let times, vals;
    if (tr) { times = Array.from(tr.times); vals = Array.from(tr.values); }
    else {
      const base = name.endsWith('.position') ? rest.get('Hips').p.toArray() : rest.get(name.split('.')[0]).q.toArray();
      times = [0, clip.duration];
      vals = [...base, ...base];
    }
    let i = times.findIndex((x) => Math.abs(x - t) < 1e-3);
    if (i >= 0) vals.splice(i * n, n, ...values);
    else {
      i = times.findIndex((x) => x > t);
      if (i < 0) i = times.length;
      times.splice(i, 0, t);
      vals.splice(i * n, 0, ...values);
    }
    setTrack(clip, name, times, vals);
  }
  function setJoint(name, k, deg) {
    if (k.startsWith('p')) {
      const p = readP();
      p[k[1]] = rest.get('Hips').p[k[1]] + deg / 100 / hipsScale();
      setKey('Hips.position', p.toArray());
    } else {
      const v = jointValues(name);
      v[k] = deg;
      const e = new THREE.Euler(...AXES.map((a) => THREE.MathUtils.degToRad(v[a])), 'XYZ');
      setKey(`${name}.quaternion`, rest.get(name).q.clone().multiply(new THREE.Quaternion().setFromEuler(e)).toArray());
    }
    changed();
  }
  function unkey(name) {
    const t = frameTime();
    let any = false;
    for (const tn of [`${name}.quaternion`, ...(name === 'Hips' ? ['Hips.position'] : [])]) {
      const tr = trackOf(tn);
      if (!tr || tr.times.length < 2) continue;
      const i = Array.from(tr.times).findIndex((x) => Math.abs(x - t) < 1e-3);
      if (i < 0) continue;
      if (!any) pushUndo();
      any = true;
      const n = tr.getValueSize(), times = Array.from(tr.times), vals = Array.from(tr.values);
      times.splice(i, 1);
      vals.splice(i * n, n);
      setTrack(clip, tn, times, vals);
    }
    if (any) { changed(); status(`Removed the key on frame ${frame}; it follows the frames around it.`); }
    else status('No key on this frame for that joint.');
  }
  function changed() {
    dirty.add(clip.name);
    rebind();
    syncFrame();
  }

  // ---- undo / redo: snapshots of the current clip's tracks
  function snapshot() {
    return { clip, duration: clip.duration, tracks: clip.tracks.map((t) => [t.name, Array.from(t.times), Array.from(t.values)]) };
  }
  function restore(s) {
    clip = s.clip;
    for (const [name, times, values] of s.tracks) setTrack(clip, name, times, values);
    clip.tracks = clip.tracks.filter((t) => s.tracks.some(([n]) => n === t.name));
    clip.duration = s.duration;
    $('clip').value = clip.name;
    frame = Math.min(frame, frameCount());
    changed();
  }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 80) undoStack.shift();
    redoStack.length = 0;
    syncUndo();
  }
  function syncUndo() {
    $('undo').disabled = !undoStack.length;
    $('redo').disabled = !redoStack.length;
  }
  function undo() {
    const s = undoStack.pop();
    if (!s) return;
    redoStack.push(snapshot());
    restore(s);
    syncUndo();
    status('Undone.');
  }
  function redo() {
    const s = redoStack.pop();
    if (!s) return;
    undoStack.push(snapshot());
    restore(s);
    syncUndo();
    status('Redone.');
  }

  // ---- whole frames
  const posedBones = () => GROUPS.flatMap(([, j]) => j.map(([n]) => n)).filter((n) => fighter.bones[n]);
  let clipboard = null;
  function copyFrame() {
    clipboard = { q: Object.fromEntries(posedBones().map((n) => [n, readQ(n).toArray()])), p: readP().toArray() };
    status(`Copied frame ${frame}.`);
  }
  function pasteFrame() {
    if (!clipboard) { status('Copy a frame first.'); return; }
    pushUndo();
    for (const [n, q] of Object.entries(clipboard.q)) setKey(`${n}.quaternion`, q);
    setKey('Hips.position', clipboard.p);
    changed();
    status(`Pasted onto frame ${frame} (unsaved).`);
  }
  function keyAll() {
    pushUndo();
    const t = frameTime();
    const q = posedBones().map((n) => [n, readQ(n, t).toArray()]), p = readP(t).toArray();
    for (const [n, v] of q) setKey(`${n}.quaternion`, v);
    setKey('Hips.position', p);
    changed();
    status(`Keyed every joint on frame ${frame} (unsaved).`);
  }
  function tPose() {
    pushUndo();
    for (const n of posedBones()) setKey(`${n}.quaternion`, rest.get(n).q.toArray());
    setKey('Hips.position', rest.get('Hips').p.toArray());
    changed();
    status(`Frame ${frame} is in the T-pose (unsaved; Undo puts it back).`);
  }
  function clearFrame() {
    const t = frameTime();
    const hit = clip.tracks.filter((tr) => tr.times.length > 2 && hasKey(tr, t));
    if (!hit.length) { status('No keys on this frame (the first and last keys stay).'); return; }
    pushUndo();
    for (const tr of hit) {
      const i = Array.from(tr.times).findIndex((x) => Math.abs(x - t) < 1e-3);
      if (i === 0 || i === tr.times.length - 1) continue;
      const n = tr.getValueSize(), times = Array.from(tr.times), vals = Array.from(tr.values);
      times.splice(i, 1);
      vals.splice(i * n, n);
      setTrack(clip, tr.name, times, vals);
    }
    changed();
    status(`Cleared frame ${frame}; it follows the frames around it.`);
  }

  // ---- preview
  function startPreview() {
    playing = true;
    time = frame >= frameCount() ? 0 : frameTime();
    $('play').textContent = '❚❚ Stop';
    gizmo.detach();
  }
  function stopPreview() {
    if (!playing) return;
    playing = false;
    $('play').textContent = '▶ Preview';
    frame = THREE.MathUtils.clamp(Math.round(time * FPS), 0, frameCount());
    pose();
    syncFrame();
    attachGizmo();
  }

  // ---- animations
  function fillClips(select) {
    const names = [...fighter.clips.keys()].filter((n) => !n.includes('#')).sort((a, b) => a.localeCompare(b));
    $('clip').innerHTML = names.map((n) => `<option>${n}</option>`).join('');
    $('clip').value = names.includes(select) ? select : names[0];
  }
  function chooseClip(name) {
    stopPreview();
    clip = fighter.clips.get(name);
    frame = 0;
    undoStack.length = redoStack.length = 0;
    syncUndo();
    pose();
    syncFrame();
    syncUse();
  }
  function duplicateClip() {
    let name = prompt('Name for the new animation:', `${clip.name}_edit`);
    if (!name) return;
    name = name.trim().replace(/[^\w-]/g, '_');
    if (!name || fighter.clips.has(name)) { status('That name is taken (or empty).'); return; }
    for (const f of ctx.fighters()) {
      const src = f.clips.get(clip.name) ?? clip;
      const copy = new THREE.AnimationClip(name, src.duration, src.tracks.map((t) => makeTrack(t.name, Array.from(t.times), Array.from(t.values))));
      copy.userData = { custom: true };
      f.clips.set(name, copy);
      ORIGINALS.set(copy, new Map());
    }
    dirty.add(name);
    fillClips(name);
    chooseClip(name);
    status(`Made ${name} (a copy). Save to keep it.`);
  }
  function setLength(frames) {
    frames = Math.max(2, Math.round(frames));
    const d = frames / FPS;
    pushUndo();
    for (const tr of [...clip.tracks]) {
      // Cut keys past the end; a longer animation holds its last pose.
      const n = tr.getValueSize();
      let times = Array.from(tr.times), values = Array.from(tr.values);
      const keep = times.filter((t) => t <= d + 1e-6).length;
      if (keep < times.length && keep > 0) {
        const endV = Array.from(tr.createInterpolant().evaluate(d));
        const needEnd = times[keep - 1] < d - 1e-6;
        times = times.slice(0, keep).concat(needEnd ? [d] : []);
        values = values.slice(0, keep * n).concat(needEnd ? endV : []);
        setTrack(clip, tr.name, times, values);
      }
    }
    clip.duration = d;
    frame = Math.min(frame, frames);
    changed();
    status(`${clip.name} is now ${frames} frames (unsaved).`);
  }

  // ---- use in the game
  function fillUse() {
    $('use').innerHTML = [
      ...(ctx.moves ?? []).map(([label]) => `<option value="move:${label}">Move · ${label}</option>`),
      ...Object.keys(ctx.slots ?? {}).map((k) => `<option value="slot:${k}">Pose · ${k}</option>`),
    ].join('');
  }
  function useTarget() {
    const v = $('use').value;
    if (!v) return null;
    const kind = v.slice(0, v.indexOf(':')), key = v.slice(v.indexOf(':') + 1);
    const m = kind === 'move' ? (ctx.moves ?? []).find(([label]) => label === key)?.[1] : ctx.slots?.[key];
    return m ? { kind, key, m } : null;
  }
  function syncUse() {
    const u = useTarget();
    if (!u) { $('usenote').textContent = ''; return; }
    $('sethit').disabled = $('setend').disabled = u.kind !== 'move';
    $('speed').value = u.m.speed ?? 1;
    $('usenote').textContent = u.kind === 'move'
      ? `${u.key} plays ${u.m.clip} at ${u.m.speed ?? 1}×: the blow on frame ${Math.round((u.m.hit ?? 0) * FPS)}, over on frame ${Math.round((u.m.end ?? 0) * FPS)}.`
      : `${u.key} plays ${u.m.clip} at ${u.m.speed ?? 1}×.`;
    if (clip) drawFrames();
  }
  function changeUse(fn, what) {
    const u = useTarget();
    if (!u) return;
    fn(u.m);
    ctx.saveAnim?.();
    syncUse();
    status(`${u.key}: ${what} (saved).`);
  }

  // ---- saving
  function saveEdits() {
    const edits = readEdits();
    const round = (tr) => ({ times: Array.from(tr.times, (v) => +v.toFixed(4)), values: Array.from(tr.values, (v) => +v.toFixed(5)) });
    for (const name of dirty) {
      const c = fighter.clips.get(name);
      if (!c) continue;
      if (c.userData?.custom) {
        edits[name] = { custom: true, duration: c.duration, tracks: Object.fromEntries(c.tracks.map((t) => [t.name, round(t)])) };
        continue;
      }
      const m = ORIGINALS.get(c);
      if (!m) continue;
      const tracks = {};
      for (const tn of m.keys()) {
        const tr = c.tracks.find((t) => t.name === tn);
        if (tr) tracks[tn] = round(tr);
      }
      edits[name] = { tracks, duration: c.duration };
    }
    if (!writeEdits(edits)) { status('Could not save: the browser storage is full or blocked. Export JSON to keep the work.'); return; }
    for (const f of ctx.fighters()) if (f !== fighter) applyAnimEdits(f.clips, edits);
    dirty = new Set();
    status('Saved. The fight uses these edits (in this browser).');
  }

  // ---- UI wiring
  $('body').value = body ?? '';
  $('body').onchange = () => {
    if (dirty.size && !confirm('Switch body without saving the changes?')) { $('body').value = body ?? ''; return; }
    dirty = new Set();
    location.search = $('body').value ? `?body=${$('body').value}` : '';
  };
  $('clip').onchange = () => chooseClip($('clip').value);
  $('dup').onclick = () => duplicateClip();
  $('len').onchange = () => setLength(Number($('len').value));
  $('fprev').onclick = () => goFrame(frame - 1);
  $('fnext').onclick = () => goFrame(frame + 1);
  $('frames').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) goFrame(Number(b.dataset.f)); };
  $('play').onclick = () => (playing ? stopPreview() : startPreview());
  $('copy').onclick = () => copyFrame();
  $('paste').onclick = () => pasteFrame();
  $('keyall').onclick = () => keyAll();
  $('clear').onclick = () => clearFrame();
  $('tpose').onclick = () => tPose();
  $('undo').onclick = () => undo();
  $('redo').onclick = () => redo();
  $('trot').onclick = () => setTool('rotate');
  $('tmove').onclick = () => setTool('move');
  $('tspace').onclick = () => { $('tspace').textContent = $('tspace').textContent === 'Local' ? 'World' : 'Local'; attachGizmo(); };
  $('tabs').onclick = (e) => { const b = e.target.closest('[data-tab]'); if (b) { tab = Number(b.dataset.tab); buildJoints(); } };
  // A slider drag is one undo step: snapshot on its first move.
  let sliding = false;
  $('joints').addEventListener('input', (e) => {
    const el = e.target;
    if (!el.dataset.j) return;
    stopPreview();
    if (!sliding || el.type === 'number') pushUndo();
    sliding = el.type === 'range';
    const v = Number(el.value);
    if (Number.isFinite(v)) setJoint(el.dataset.j, el.dataset.k, v);
  });
  $('joints').addEventListener('change', () => { sliding = false; status(`Keyed on frame ${frame} (unsaved).`); });
  $('joints').addEventListener('click', (e) => { const b = e.target.closest('[data-unkey]'); if (b) unkey(b.dataset.unkey); });
  $('use').onchange = () => syncUse();
  $('useclip').onclick = () => changeUse((m) => { m.clip = clip.name; if (m.end != null && m.end > clip.duration) m.end = clip.duration; }, `now plays ${clip.name}`);
  $('sethit').onclick = () => changeUse((m) => { m.clip = clip.name; m.hit = +frameTime().toFixed(3); }, `the blow on frame ${frame}`);
  $('setend').onclick = () => changeUse((m) => { m.clip = clip.name; m.end = +frameTime().toFixed(3); }, `over on frame ${frame}`);
  $('speed').onchange = () => changeUse((m) => { m.speed = THREE.MathUtils.clamp(Number($('speed').value) || 1, 0.1, 4); }, `speed ${$('speed').value}×`);
  $('save').onclick = () => saveEdits();
  $('revert').onclick = () => {
    if (clip.userData?.custom) {
      if (!confirm(`Delete the animation ${clip.name}?`)) return;
      const edits = readEdits();
      delete edits[clip.name];
      writeEdits(edits);
      for (const f of ctx.fighters()) f.clips.delete(clip.name);
      dirty.delete(clip.name);
      fillClips('Idle_Sword_Out');
      chooseClip($('clip').value);
      status('Deleted.');
      return;
    }
    if (!confirm(`Put ${clip.name} back as it was originally?`)) return;
    for (const f of ctx.fighters()) { const c = f.clips.get(clip.name); if (c) revertClip(c, f.clips); }
    const edits = readEdits();
    delete edits[clip.name];
    writeEdits(edits);
    dirty.delete(clip.name);
    changed();
    dirty.delete(clip.name);
    status(`${clip.name} is back to the original (reload to restore its length if you changed it).`);
  };
  $('export').onclick = async () => {
    saveEdits();
    const text = JSON.stringify({ edits: readEdits(), anim: ctx.saveAnim?.() ?? null });
    const box = $('json');
    box.hidden = false;
    box.value = text;
    box.select();
    try { await navigator.clipboard.writeText(text); status('Edits copied (also in the box). Send them to Claude to bake into the game.'); } catch { status('Copy the edits from the box.'); }
  };
  $('import').onclick = () => {
    const box = $('json');
    if (box.hidden || !box.value.trim()) { box.hidden = false; box.value = ''; status('Paste exported edits into the box, then press Import JSON again.'); return; }
    try {
      const data = JSON.parse(box.value);
      const edits = data.edits ?? data;   // (older exports: the edits alone)
      writeEdits({ ...readEdits(), ...edits });
      for (const f of ctx.fighters()) applyAnimEdits(f.clips, edits);
      if (data.anim) ctx.loadAnim?.(data.anim);
      fillClips(clip.name);
      chooseClip($('clip').value);
      status(`Imported edits for ${Object.keys(edits).length} animation(s).`);
    } catch { status('That is not valid JSON.'); }
  };

  // ---- the gizmo, as in a 3D tool
  // Move: the hips slide; a hand or foot pulls its arm or leg (two-bone IK);
  // any other joint pulls its parent round to point at it.
  function setTool(t) {
    tool = t;
    $('trot').classList.toggle('on', t === 'rotate');
    $('tmove').classList.toggle('on', t === 'move');
    if (picked) pickJoint(picked);
  }
  function attachGizmo() {
    if (!picked || playing) { gizmo.detach(); return; }
    const b = fighter.bones[picked];
    if (tool === 'move' && picked !== 'Hips') {
      b.getWorldPosition(ikTarget.position);
      ikTarget.updateMatrixWorld();
      gizmo.setMode('translate');
      gizmo.setSpace('world');
      gizmo.attach(ikTarget);
    } else {
      gizmo.setMode(tool === 'move' ? 'translate' : 'rotate');
      gizmo.setSpace($('tspace').textContent === 'Local' ? 'local' : 'world');
      gizmo.attach(b);
    }
  }
  // A drag keys the change against the frame's own values: the bones carry
  // finishPose's extras (the leg spread), which must not go into the keys.
  const chainOf = (name) => (tool !== 'move' || name === 'Hips' ? [name] : IK_CHAINS[name] ? [...IK_CHAINS[name]] : [fighter.bones[name].parent.name]);
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (e.value) {
      stopPreview();
      pushUndo();
      drag = { bones: chainOf(picked).map((n) => [n, fighter.bones[n].quaternion.clone(), readQ(n)]),
        p: fighter.bones.Hips.position.clone(), pKey: readP() };
    } else {
      drag = null;
      attachGizmo();
      status(`Keyed ${picked} on frame ${frame} (unsaved).`);
    }
  });
  gizmo.addEventListener('objectChange', () => {
    if (!drag) return;
    if (tool === 'move' && picked === 'Hips') {
      const d = fighter.bones.Hips.position.clone().sub(drag.p);
      setKey('Hips.position', drag.pKey.clone().add(d).toArray());
    } else {
      if (tool === 'move') {
        // Back to the frame's pose, then reach for the target.
        for (const [n, q] of drag.bones) fighter.bones[n].quaternion.copy(q);
        fighter.root.updateMatrixWorld(true);
      }
      if (tool === 'move' && !IK_CHAINS[picked]) {
        const b = fighter.bones[picked];
        aim(b.parent, b, ikTarget.position);
      } else if (tool === 'move') {
        const [a, m] = IK_CHAINS[picked].map((n) => fighter.bones[n]);
        const s0 = a.getWorldPosition(new THREE.Vector3()), e0 = fighter.bones[picked].getWorldPosition(new THREE.Vector3());
        const pole = m.getWorldPosition(new THREE.Vector3()).sub(s0.lerp(e0, 0.5));
        if (pole.lengthSq() < 1e-6) pole.set(0, 0, 1);
        twoBoneIK(a, m, fighter.bones[picked], ikTarget.position, pole);
      }
      for (const [n, q0, key] of drag.bones) {
        const delta = q0.clone().invert().multiply(fighter.bones[n].quaternion);
        setKey(`${n}.quaternion`, key.clone().multiply(delta).normalize().toArray());
      }
    }
    dirty.add(clip.name);
    rebind();
    syncJoints();
    drawFrames();
  });

  // Click a joint marker to bring up its sliders.
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let downAt = null;
  ctx.canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  ctx.canvas.addEventListener('pointerup', (e) => {
    if (!isOpen || e.button !== 0 || !downAt || gizmo.dragging || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
    const r = ctx.canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, ctx.camera);
    const hit = ray.intersectObjects(markers.children, false)[0];
    if (hit) pickJoint(hit.object.userData.bone.name);
  });
  function pickJoint(name) {
    picked = name;
    const t = GROUPS.findIndex(([, j]) => j.some(([n]) => n === name));
    if (t >= 0 && t !== tab) { tab = t; buildJoints(); } else syncJoints();
    for (const m of markers.children) m.material = m.userData.bone.name === name ? markerOn : markerMat;
    $('picknote').textContent = name ? `${name}: ${tool === 'rotate' ? 'turn it with the rings' : 'move it with the arrows'}. Esc lets go.` : 'Click a blue joint on the figure to get the gizmo.';
    attachGizmo();
    if (name) panel.querySelector(`[data-joint="${name}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  addEventListener('keydown', (e) => {
    if (!isOpen || e.target.closest?.('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
    if (e.code === 'KeyE') setTool('rotate');
    if (e.code === 'KeyW') setTool('move');
    if (e.code === 'Escape') pickJoint(null);
    if (e.code === 'Comma') goFrame(frame - 1);
    if (e.code === 'Period') goFrame(frame + 1);
    if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  });
  addEventListener('beforeunload', (e) => { if (isOpen && dirty.size) { e.preventDefault(); e.returnValue = ''; } });

  function open(f) {
    fighter = f;
    isOpen = true;
    // The pose as keyed, as in the T-pose: no leg spread from the menu on top.
    f.legDeg = 0;
    panel.hidden = false;
    // The rest pose the sliders count from (and Reset to T-pose sets): the
    // skeleton's bind pose, a T-pose. Read it, then put the bones back.
    f.mixer.stopAllAction();
    const sk = f.mesh.skeleton;
    const held = sk.bones.map((b) => [b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
    sk.pose();
    for (const n of posedBones()) rest.set(n, { q: f.bones[n].quaternion.clone(), p: f.bones[n].position.clone() });
    sk.bones.forEach((b, i) => { b.position.copy(held[i][0]); b.quaternion.copy(held[i][1]); b.scale.copy(held[i][2]); });
    fillClips('Idle_Fight');
    markers.clear();
    for (const n of posedBones()) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(n === 'Hips' ? 0.035 : 0.025, 10, 8), markerMat);
      m.userData.bone = f.bones[n];
      m.renderOrder = 30;
      markers.add(m);
    }
    markers.visible = true;
    fillUse();
    // Framed as in the character creator.
    ctx.camera.fov = 30;
    ctx.camera.updateProjectionMatrix();
    orbit.target.copy(f.pos).add(new THREE.Vector3(0, 0.9, 0));
    ctx.camera.position.copy(f.pos).add(new THREE.Vector3(1.2, 1.3, 4.4).applyAxisAngle(new THREE.Vector3(0, 1, 0), f.yaw));
    orbit.enabled = true;
    clip = fighter.clips.get($('clip').value);
    buildJoints();
    chooseClip(clip.name);
  }

  function update(dt) {
    if (!isOpen || !fighter) return;
    if (playing) {
      time += dt * Number($('pspeed').value);
      if (time > clip.duration) {
        if ($('loop').checked) time %= clip.duration;
        else { time = clip.duration; stopPreview(); }
      }
      if (playing) {
        pose(time);
        $('fnow').textContent = `${Math.round(time * FPS)} / ${frameCount()}  ·  ${time.toFixed(2)} s`;
      }
    }
    // (Held on a frame, nothing is re-posed: finishPose turns the thighs by
    // the menu's leg spread on top of the pose, and would add up.)
    fighter.hair?.rig.update(Math.max(dt, 1e-4), fighter.hair.state);
    for (const m of markers.children) m.userData.bone.getWorldPosition(m.position);
    orbit.update();
  }

  return { open, update, close() {}, get isOpen() { return isOpen; } };
}
