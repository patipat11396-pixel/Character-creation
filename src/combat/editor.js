import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Animation editor: make and change the fighters' clips frame by frame.
//
// Pick a clip (or duplicate one as a new clip), step to a frame, pick a bone
// (click its joint or use the list) and turn it with the gizmo rings; the
// hips can also be moved, and a hand or foot can be dragged with IK (the
// whole arm or leg follows). Letting go keys the change on that frame (only
// that frame, unless "blend" is raised). Undo / redo, copy / paste a pose.
// "Use in the game" sets which move or pose plays a clip and the move's hit
// and end frames. Everything is kept in this browser, used by the fight, and
// can be exported / imported as JSON.

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

const css = `
#anim-editor { position: fixed; left: 12px; top: 12px; bottom: 12px; width: 320px; background: rgba(255,255,255,0.96); border: 1px solid #ddd; border-radius: 8px;
  padding: 10px 12px; font: 12px/1.4 system-ui, sans-serif; color: #1d1f24; overflow: auto; z-index: 20; display: flex; flex-direction: column; gap: 8px; }
#anim-editor h3 { margin: 0; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
#anim-editor label { display: flex; flex-direction: column; gap: 2px; color: #555; }
#anim-editor select, #anim-editor input[type=number], #anim-editor input[type=text] { font-size: 12px; }
#anim-editor .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
#anim-editor button { border: 1px solid #ccc; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; padding: 3px 8px; }
#anim-editor button.on { background: #c9a227; border-color: #c9a227; color: #fff; }
#anim-editor button:disabled { opacity: 0.45; cursor: default; }
#anim-editor .keys { position: relative; height: 16px; background: #f1f1ef; border-radius: 3px; }
#anim-editor .keys i { position: absolute; top: 3px; width: 3px; height: 10px; background: #c9a227; margin-left: -1px; }
#anim-editor .keys b { position: absolute; top: 0; width: 2px; height: 16px; background: #c8323c; margin-left: -1px; }
#anim-editor .keys u { position: absolute; top: 0; width: 2px; height: 16px; margin-left: -1px; text-decoration: none; }
#anim-editor .keys u.hit { background: #2f7fff; }
#anim-editor .keys u.end { background: #7b4dd6; }
#anim-editor .note { color: #777; margin: 0; }
#anim-editor textarea { width: 100%; height: 70px; font-size: 11px; }
#anim-editor .section { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-top: 6px; border-top: 1px solid #eee; padding-top: 8px; }
/* Its own page: a dark panel on the right, as in the character creator. */
#anim-editor.page { left: auto; right: 0; top: 0; bottom: 0; width: 360px; border-radius: 0; border: 0; border-left: 1px solid #2e323c;
  background: linear-gradient(180deg, #1f232c, #181b22); color: #e9ebf0; padding: 18px 20px; gap: 10px; font-size: 13px; }
#anim-editor.page h3 { font-size: 20px; font-weight: 600; }
#anim-editor.page label, #anim-editor.page .note, #anim-editor.page span { color: #9aa1b0; }
#anim-editor.page select, #anim-editor.page input[type=number], #anim-editor.page input[type=text], #anim-editor.page textarea {
  background: #15171c; color: #e9ebf0; border: 1px solid #2e323c; border-radius: 8px; padding: 6px 8px; font-size: 13px; }
#anim-editor.page button { background: transparent; color: #e9ebf0; border: 1px solid #2e323c; border-radius: 8px; padding: 5px 9px; font-size: 13px; }
#anim-editor.page button.on, #anim-editor.page button.primary { background: #e2b45a; border-color: #e2b45a; color: #1a1a1a; }
#anim-editor.page .keys { background: #15171c; }
#anim-editor.page .keys i { background: #e2b45a; }
#anim-editor.page input[type=range] { accent-color: #e2b45a; width: 100%; }
#anim-editor.page .section { color: #9aa1b0; border-top-color: #2e323c; }
#anim-editor.page a { color: #e2b45a; text-decoration: none; font-size: 13px; }
`;

/**
 * The editor. ctx: { scene, camera, canvas, fighters: () => [player, enemy], onClose, page,
 *   moves: [[label, move]], slots: { name: { clip, speed } }, saveAnim(), loadAnim(data) }.
 * Returns { open(fighter), close(), update(dt), isOpen }.
 */
export function createAnimEditor(ctx) {
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  const panel = document.createElement('div');
  panel.id = 'anim-editor';
  if (ctx.page) panel.classList.add('page');
  panel.hidden = true;
  document.body.appendChild(panel);

  const orbit = new OrbitControls(ctx.camera, ctx.canvas);
  orbit.enabled = false;
  orbit.enableDamping = true;
  const gizmo = new TransformControls(ctx.camera, ctx.canvas);
  gizmo.setSpace('local');
  gizmo.setSize(0.7);
  gizmo.setMode('rotate');
  const ikTarget = new THREE.Object3D();   // what the gizmo drags in IK mode
  ctx.scene.add(ikTarget);
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (e.value) { pushUndo(); dragStart = { q: bone?.quaternion.clone(), p: bone?.position.clone() }; }
    else if (bone && auto.checked) keyNow(true);
  });
  gizmo.addEventListener('objectChange', () => {
    if (mode === 'ik' && bone) solveIK();
  });
  ctx.scene.add(gizmo.getHelper());

  // Joint markers to click.
  const markers = new THREE.Group();
  markers.visible = false;
  ctx.scene.add(markers);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0x2f7fff, depthTest: false, transparent: true, opacity: 0.85 });
  const markerOn = new THREE.MeshBasicMaterial({ color: 0xc8323c, depthTest: false });

  let fighter = null, clip = null, time = 0, playing = false, bone = null, dragStart = null, isOpen = false;
  let mode = 'rotate';   // rotate | move (hips) | ik (hands, feet)
  let dirty = new Set();   // clip names changed since the last save
  const undoStack = [], redoStack = [];

  const body = new URLSearchParams(location.search).get('body');
  panel.innerHTML = (ctx.page ? `
    <div class="row" style="justify-content:space-between"><a href="index.html">← Character</a><a href="combat.html">Fight ⚔</a></div>
    <h3>Animation editor</h3>
    <label>Body<select data-a="body"><option value="">My character</option><option value="female">Female</option><option value="male">Male</option></select></label>`
    : `<h3>Animation editor <button type="button" data-a="close">Close ✕</button></h3>`) + `
    <label>Clip<select data-a="clip"></select></label>
    <div class="row"><button type="button" data-a="dup">Duplicate as new clip…</button>
      <span>length <input data-a="len" type="number" step="1" min="2" style="width:56px"> frames</span></div>
    <div class="section">Timeline</div>
    <div class="row"><button type="button" data-a="play">▶ Play</button>
      <button type="button" data-a="fprev" title="Previous frame (,)">◀ frame</button><button type="button" data-a="fnext" title="Next frame (.)">frame ▶</button>
      <label style="flex-direction:row;align-items:center;gap:4px"><input type="checkbox" data-a="loop" checked> loop</label></div>
    <div class="row"><span>frame <input data-a="frame" type="number" step="1" min="0" style="width:56px"> / <span data-a="frames"></span></span>
      <span>(<span data-a="secs"></span> s)</span></div>
    <input data-a="scrub" type="range" min="0" step="1">
    <div class="keys" data-a="keys" title="Gold: this bone's keys · red: now · blue: hit · purple: end"></div>
    <div class="section">Pose</div>
    <label>Bone (or click a joint)<select data-a="bone"></select></label>
    <div class="row"><button type="button" data-a="rotate" class="on" title="Turn the bone">Rotate</button>
      <button type="button" data-a="move" title="Move the hips">Move hips</button>
      <button type="button" data-a="ik" title="Drag a hand or foot; the arm or leg follows">IK drag</button>
      <button type="button" data-a="space" title="Gizmo in the bone's own axes or the world's">Local</button></div>
    <div class="row"><button type="button" data-a="key">Set key (K)</button><button type="button" data-a="del">Delete key</button>
      <button type="button" data-a="prev">◀ key</button><button type="button" data-a="next">key ▶</button></div>
    <div class="row"><label style="flex-direction:row;align-items:center;gap:4px"><input type="checkbox" data-a="auto" checked> key on release</label>
      <button type="button" data-a="keyall" title="Key every bone's current pose on this frame">Key whole pose</button></div>
    <label>Blend into nearby frames: <span data-a="spreadv">0 (this frame only)</span><input data-a="spread" type="range" min="0" max="0.6" step="0.01" value="0"></label>
    <div class="row"><button type="button" data-a="copy">Copy pose</button><button type="button" data-a="paste">Paste pose here</button>
      <button type="button" data-a="undo" title="Ctrl+Z">↶ Undo</button><button type="button" data-a="redo" title="Ctrl+Y">↷ Redo</button></div>
    <div class="section">Use in the game</div>
    <label>Move or pose<select data-a="use"></select></label>
    <div class="row"><button type="button" data-a="useclip">Use this clip</button>
      <button type="button" data-a="sethit" title="The blow lands on this frame">Hit = this frame</button>
      <button type="button" data-a="setend" title="The move is over on this frame">End = this frame</button></div>
    <label>Speed in the game <input data-a="speed" type="number" step="0.05" min="0.1" max="4" style="width:70px"></label>
    <p class="note" data-a="usenote"></p>
    <div class="section">Save</div>
    <div class="row"><button type="button" data-a="save" class="primary">Save (use in the fight)</button><button type="button" data-a="revert">Revert this clip</button></div>
    <div class="row"><button type="button" data-a="export">Export JSON</button><button type="button" data-a="import">Import JSON</button></div>
    <textarea data-a="json" placeholder="Exported edits appear here; paste edits here to import." hidden></textarea>
    <p class="note" data-a="status">Drag to orbit, right-drag to pan, scroll to zoom. Click a blue joint to pick a bone, turn it with the rings; letting go keys it on this frame. Keys: , . frames · K key · Space play · Ctrl+Z / Ctrl+Y.</p>`;
  const $ = (a) => panel.querySelector(`[data-a="${a}"]`);
  const auto = $('auto');
  const status = (t) => { $('status').textContent = t; };

  const frameCount = () => Math.max(1, Math.round(clip.duration * FPS));
  const frameNow = () => Math.round(time * FPS);
  function trackOf(name) { return clip?.tracks.find((t) => t.name === name); }
  function boneTrack(b = bone, m = mode) {
    if (!b) return null;
    return `${b.name}.${m === 'move' ? 'position' : 'quaternion'}`;
  }

  // ---- posing
  function pose() {
    if (!fighter || !clip) return;
    fighter.mixer.stopAllAction();
    const action = fighter.mixer.clipAction(clip);
    action.reset().play();
    action.paused = true;
    action.time = time;
    fighter.mixer.update(0);
    fighter.finishPose();
    if (mode === 'ik' && bone) bone.getWorldPosition(ikTarget.position);
    syncTime();
  }
  function rebind() {
    fighter.mixer.stopAllAction();
    fighter.mixer.uncacheClip(clip);
    pose();
  }
  function syncTime() {
    $('frame').value = frameNow();
    $('frames').textContent = frameCount();
    $('secs').textContent = time.toFixed(2);
    $('scrub').max = frameCount();
    $('scrub').value = frameNow();
    $('len').value = frameCount();
    drawKeys();
  }
  function goFrame(n) {
    playing = false;
    $('play').textContent = '▶ Play';
    n = THREE.MathUtils.clamp(Math.round(n), 0, frameCount());
    time = Math.min(n / FPS, clip.duration);
    pose();
  }
  function drawKeys() {
    const box = $('keys');
    box.innerHTML = '';
    if (!clip) return;
    const tr = trackOf(boneTrack(bone, mode === 'ik' ? 'rotate' : mode));
    if (tr && tr.times.length < 400) {
      for (const t of tr.times) {
        const i = document.createElement('i');
        i.style.left = `${(t / clip.duration) * 100}%`;
        box.appendChild(i);
      }
    }
    // The chosen move's hit and end, when it plays this clip.
    const use = useTarget();
    if (use?.kind === 'move' && use.m.clip === clip.name) {
      for (const k of ['hit', 'end']) {
        if (use.m[k] == null) continue;
        const u = document.createElement('u');
        u.className = k;
        u.style.left = `${(Math.min(use.m[k], clip.duration) / clip.duration) * 100}%`;
        box.appendChild(u);
      }
    }
    const b = document.createElement('b');
    b.style.left = `${(time / clip.duration) * 100}%`;
    box.appendChild(b);
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
    dirty.add(clip.name);
    dropSplits(fighter.clips, clip.name);
    rebind();
  }
  function pushUndo() {
    if (!clip) return;
    undoStack.push(snapshot());
    if (undoStack.length > 60) undoStack.shift();
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

  /** Key bone `b`'s current pose (`kind`: 'quaternion' | 'position') on this frame, blended over the spread. */
  function keyBone(b, kind, startQ = null, startP = null) {
    const name = `${b.name}.${kind}`;
    const isPos = kind === 'position';
    const now = isPos ? b.position.clone() : b.quaternion.clone();
    const tr = trackOf(name);
    let before;
    if (tr) before = isPos ? new THREE.Vector3().fromArray(tr.createInterpolant().evaluate(time)) : new THREE.Quaternion().fromArray(tr.createInterpolant().evaluate(time));
    else before = (isPos ? startP : startQ) ?? now.clone();
    const times = tr ? Array.from(tr.times) : [];
    const values = tr ? Array.from(tr.values) : [];
    const n = isPos ? 3 : 4;
    let at = times.findIndex((t) => Math.abs(t - time) < 1e-3);
    if (at < 0) {
      at = times.findIndex((t) => t > time);
      if (at < 0) at = times.length;
      times.splice(at, 0, time);
      values.splice(at * n, 0, ...before.toArray());
    }
    const spread = Number($('spread').value);
    const deltaQ = isPos ? null : now.clone().multiply(before.clone().invert());
    const deltaP = isPos ? now.clone().sub(before) : null;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(times[i] - time);
      const w = i === at ? 1 : spread > 0 && d < spread ? 0.5 + 0.5 * Math.cos((Math.PI * d) / spread) : 0;
      if (w <= 0) continue;
      if (isPos) new THREE.Vector3().fromArray(values, i * 3).addScaledVector(deltaP, w).toArray(values, i * 3);
      else new THREE.Quaternion().slerp(deltaQ, w).multiply(new THREE.Quaternion().fromArray(values, i * 4)).normalize().toArray(values, i * 4);
    }
    setTrack(clip, name, times, values);
  }

  /** Key the selected bone (or, in IK, its chain) on this frame. */
  function keyNow(fromDrag = false) {
    if (!bone || !clip) return;
    if (!fromDrag) pushUndo();
    time = Math.min(frameNow() / FPS, clip.duration);   // keys sit on frames
    if (mode === 'ik') {
      for (const n of [...IK_CHAINS[bone.name], bone.name]) keyBone(fighter.bones[n], 'quaternion');
    } else {
      keyBone(bone, mode === 'move' ? 'position' : 'quaternion', dragStart?.q, dragStart?.p);
    }
    dirty.add(clip.name);
    dropSplits(fighter.clips, clip.name);
    rebind();
    status(`Keyed ${mode === 'ik' ? `${bone.name} and its ${bone.name.includes('Hand') ? 'arm' : 'leg'}` : bone.name} on frame ${frameNow()} (unsaved).`);
  }

  function keyWholePose() {
    if (!clip) return;
    pushUndo();
    time = Math.min(frameNow() / FPS, clip.duration);
    for (const b of fighter.mesh.skeleton.bones) {
      if (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(b.name) || b.name === 'root') continue;
      keyBone(b, 'quaternion');
      if (b.name === 'Hips') keyBone(b, 'position');
    }
    dirty.add(clip.name);
    dropSplits(fighter.clips, clip.name);
    rebind();
    status(`Keyed the whole pose on frame ${frameNow()} (unsaved).`);
  }

  function deleteKey() {
    const tr = trackOf(boneTrack(bone, mode === 'ik' ? 'rotate' : mode));
    if (!tr) return;
    const i = Array.from(tr.times).findIndex((t) => Math.abs(t - time) < 0.02);
    if (i < 0 || tr.times.length < 2) { status('No key on this frame.'); return; }
    pushUndo();
    const n = tr.getValueSize();
    const times = Array.from(tr.times), values = Array.from(tr.values);
    times.splice(i, 1);
    values.splice(i * n, n);
    setTrack(clip, tr.name, times, values);
    dirty.add(clip.name);
    rebind();
  }

  function jumpKey(dir) {
    const tr = trackOf(boneTrack(bone, mode === 'ik' ? 'rotate' : mode));
    if (!tr) return;
    const ts = Array.from(tr.times);
    const t = dir > 0 ? ts.find((x) => x > time + 1e-3) : [...ts].reverse().find((x) => x < time - 1e-3);
    if (t !== undefined) { time = t; pose(); }
  }

  // ---- IK drag of a hand or foot
  function solveIK() {
    const [a, b] = IK_CHAINS[bone.name].map((n) => fighter.bones[n]);
    // Keep the elbow / knee bending the way it bends now.
    const mid = b.getWorldPosition(new THREE.Vector3());
    const s = a.getWorldPosition(new THREE.Vector3());
    const e = bone.getWorldPosition(new THREE.Vector3());
    const pole = mid.clone().sub(s.clone().lerp(e, 0.5));
    if (pole.lengthSq() < 1e-6) pole.set(0, -1, 0);
    twoBoneIK(a, b, bone, ikTarget.position, pole);
  }

  function selectBone(b) {
    bone = b;
    $('bone').value = b ? b.name : '';
    for (const m of markers.children) m.material = m.userData.bone === b ? markerOn : markerMat;
    if (mode === 'move' && b?.name !== 'Hips') setMode('rotate');
    else if (mode === 'ik' && !IK_CHAINS[b?.name]) setMode('rotate');
    else attachGizmo();
    drawKeys();
  }
  function attachGizmo() {
    if (!bone) { gizmo.detach(); return; }
    if (mode === 'ik') {
      bone.getWorldPosition(ikTarget.position);
      gizmo.setMode('translate');
      gizmo.setSpace('world');
      gizmo.attach(ikTarget);
    } else {
      gizmo.setMode(mode === 'move' ? 'translate' : 'rotate');
      gizmo.setSpace($('space').textContent === 'Local' ? 'local' : 'world');
      gizmo.attach(bone);
    }
  }
  function setMode(m) {
    if (m === 'move' && bone?.name !== 'Hips') { status('Only the hips can be moved: pick Hips.'); return; }
    if (m === 'ik' && !IK_CHAINS[bone?.name]) { status('IK drag works on a hand or a foot: pick one.'); return; }
    mode = m;
    $('rotate').classList.toggle('on', m === 'rotate');
    $('move').classList.toggle('on', m === 'move');
    $('ik').classList.toggle('on', m === 'ik');
    attachGizmo();
    drawKeys();
  }

  // ---- clips
  function fillClips(select) {
    const names = [...fighter.clips.keys()].filter((n) => !n.includes('#')).sort((a, b) => a.localeCompare(b));
    $('clip').innerHTML = names.map((n) => `<option>${n}</option>`).join('');
    $('clip').value = names.includes(select) ? select : names[0];
  }
  function chooseClip(name) {
    clip = fighter.clips.get(name);
    time = 0;
    undoStack.length = redoStack.length = 0;
    syncUndo();
    pose();
  }
  function duplicateClip() {
    let name = prompt('Name for the new clip:', `${clip.name}_edit`);
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
    status(`Made ${name} (a copy of the clip you had). Save to keep it.`);
  }
  function setLength(frames) {
    frames = Math.max(2, Math.round(frames));
    const d = frames / FPS;
    pushUndo();
    for (const tr of [...clip.tracks]) {
      // Cut keys past the end; a longer clip holds its last pose.
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
    dirty.add(clip.name);
    time = Math.min(time, d);
    dropSplits(fighter.clips, clip.name);
    rebind();
    status(`${clip.name} is now ${frames} frames (unsaved).`);
  }

  // ---- use in the game
  function fillUse() {
    const opts = [
      ...(ctx.moves ?? []).map(([label]) => `<option value="move:${label}">Move · ${label}</option>`),
      ...Object.keys(ctx.slots ?? {}).map((k) => `<option value="slot:${k}">Pose · ${k}</option>`),
    ];
    $('use').innerHTML = opts.join('');
  }
  function useTarget() {
    const v = $('use').value;
    if (!v) return null;
    const kind = v.slice(0, v.indexOf(':')), key = v.slice(v.indexOf(':') + 1);
    if (kind === 'move') {
      const m = (ctx.moves ?? []).find(([label]) => label === key)?.[1];
      return m ? { kind, key, m } : null;
    }
    const m = ctx.slots?.[key];
    return m ? { kind: 'slot', key, m } : null;
  }
  function syncUse() {
    const u = useTarget();
    if (!u) { $('usenote').textContent = ''; return; }
    $('sethit').disabled = $('setend').disabled = u.kind !== 'move';
    $('speed').value = u.m.speed ?? 1;
    $('usenote').textContent = u.kind === 'move'
      ? `${u.key} plays ${u.m.clip} at ${(u.m.speed ?? 1)}×: the blow on frame ${Math.round((u.m.hit ?? 0) * FPS)}, over on frame ${Math.round((u.m.end ?? 0) * FPS)} (clip frames).`
      : `${u.key} plays ${u.m.clip} at ${(u.m.speed ?? 1)}×.`;
    drawKeys();
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
    // The other fighter uses the same clips by name.
    for (const f of ctx.fighters()) if (f !== fighter) applyAnimEdits(f.clips, edits);
    dirty = new Set();
    status('Saved. The fight uses these edits (in this browser).');
  }

  // ---- UI wiring
  if ($('close')) $('close').onclick = () => close();
  if ($('body')) {
    $('body').value = body ?? '';
    $('body').onchange = () => {
      if (dirty.size && !confirm('Switch body without saving the changes?')) { $('body').value = body ?? ''; return; }
      dirty = new Set();
      location.search = $('body').value ? `?body=${$('body').value}` : '';
    };
  }
  $('clip').onchange = () => chooseClip($('clip').value);
  $('dup').onclick = () => duplicateClip();
  $('len').onchange = () => setLength(Number($('len').value));
  $('play').onclick = () => { playing = !playing; $('play').textContent = playing ? '❚❚ Pause' : '▶ Play'; };
  $('scrub').oninput = () => goFrame(Number($('scrub').value));
  $('frame').onchange = () => goFrame(Number($('frame').value));
  $('fprev').onclick = () => goFrame(frameNow() - 1);
  $('fnext').onclick = () => goFrame(frameNow() + 1);
  $('bone').onchange = () => selectBone(fighter.bones[$('bone').value] ?? null);
  $('rotate').onclick = () => setMode('rotate');
  $('move').onclick = () => setMode('move');
  $('ik').onclick = () => setMode('ik');
  $('space').onclick = () => { $('space').textContent = $('space').textContent === 'Local' ? 'World' : 'Local'; attachGizmo(); };
  $('key').onclick = () => keyNow();
  $('keyall').onclick = () => keyWholePose();
  $('del').onclick = () => deleteKey();
  $('prev').onclick = () => jumpKey(-1);
  $('next').onclick = () => jumpKey(1);
  $('undo').onclick = () => undo();
  $('redo').onclick = () => redo();
  $('spread').oninput = () => {
    const v = Number($('spread').value);
    $('spreadv').textContent = v ? `${v.toFixed(2)} s each side` : '0 (this frame only)';
  };
  let clipboard = null;
  $('copy').onclick = () => {
    clipboard = fighter.mesh.skeleton.bones.map((b) => [b, b.quaternion.clone(), b.position.clone()]);
    status(`Copied the pose on frame ${frameNow()}.`);
  };
  $('paste').onclick = () => {
    if (!clipboard) { status('Copy a pose first.'); return; }
    pushUndo();
    time = Math.min(frameNow() / FPS, clip.duration);
    for (const [b, q, p] of clipboard) {
      if (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(b.name) || b.name === 'root') continue;
      b.quaternion.copy(q);
      keyBone(b, 'quaternion');
      if (b.name === 'Hips') { b.position.copy(p); keyBone(b, 'position'); }
    }
    dirty.add(clip.name);
    dropSplits(fighter.clips, clip.name);
    rebind();
    status(`Pasted the pose on frame ${frameNow()} (unsaved).`);
  };
  $('use').onchange = () => syncUse();
  $('useclip').onclick = () => changeUse((m) => { m.clip = clip.name; if (m.end != null && m.end > clip.duration) m.end = clip.duration; }, `now plays ${clip.name}`);
  $('sethit').onclick = () => changeUse((m) => { m.clip = clip.name; m.hit = +(frameNow() / FPS).toFixed(3); }, `the blow on frame ${frameNow()}`);
  $('setend').onclick = () => changeUse((m) => { m.clip = clip.name; m.end = +(frameNow() / FPS).toFixed(3); }, `over on frame ${frameNow()}`);
  $('speed').onchange = () => changeUse((m) => { m.speed = THREE.MathUtils.clamp(Number($('speed').value) || 1, 0.1, 4); }, `speed ${$('speed').value}×`);
  $('save').onclick = () => saveEdits();
  $('revert').onclick = () => {
    if (clip.userData?.custom) {
      if (!confirm(`Delete the clip ${clip.name}?`)) return;
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
    for (const f of ctx.fighters()) { const c = f.clips.get(clip.name); if (c) revertClip(c, f.clips); }
    const edits = readEdits();
    delete edits[clip.name];
    writeEdits(edits);
    dirty.delete(clip.name);
    rebind();
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
      syncUse();
      status(`Imported edits for ${Object.keys(edits).length} clip(s).`);
    } catch { status('That is not valid JSON.'); }
  };

  // Click a joint marker to pick its bone.
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  ctx.canvas.addEventListener('pointerdown', (e) => {
    if (!isOpen || gizmo.dragging || e.button !== 0) return;
    const r = ctx.canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, ctx.camera);
    const hit = ray.intersectObjects(markers.children, false)[0];
    if (hit) selectBone(hit.object.userData.bone);
  });
  addEventListener('keydown', (e) => {
    if (!isOpen || e.target.closest?.('input, select, textarea')) return;
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { e.preventDefault(); redo(); return; }
    if (e.code === 'KeyK') keyNow();
    if (e.code === 'Comma') goFrame(frameNow() - 1);
    if (e.code === 'Period') goFrame(frameNow() + 1);
    if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  });
  addEventListener('beforeunload', (e) => { if (isOpen && dirty.size) { e.preventDefault(); e.returnValue = ''; } });

  function open(f) {
    fighter = f;
    isOpen = true;
    panel.hidden = false;
    fillClips('Idle_Sword_Out');
    const bones = f.mesh.skeleton.bones.filter((b) => !/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(b.name) && b.name !== 'root');
    $('bone').innerHTML = '<option value="">—</option>' + bones.map((b) => `<option>${b.name}</option>`).join('');
    markers.clear();
    for (const b of bones) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(b.name === 'Hips' ? 0.035 : 0.025, 10, 8), markerMat);
      m.userData.bone = b;
      m.renderOrder = 30;
      markers.add(m);
    }
    markers.visible = true;
    fillUse();
    syncUse();
    orbit.target.copy(f.pos).add(new THREE.Vector3(0, 0.9, 0));
    ctx.camera.position.copy(f.pos).add(new THREE.Vector3(1.6, 1.3, 2.6).applyAxisAngle(new THREE.Vector3(0, 1, 0), f.yaw));
    orbit.enabled = true;
    selectBone(null);
    chooseClip($('clip').value);
  }

  function close() {
    if (dirty.size && !confirm('Close without saving the changes?')) return;
    dirty = new Set();
    isOpen = false;
    panel.hidden = true;
    markers.visible = false;
    gizmo.detach();
    orbit.enabled = false;
    playing = false;
    ctx.onClose();
  }

  function update(dt) {
    if (!isOpen || !fighter) return;
    if (playing && !gizmo.dragging) {
      time += dt;
      if (time > clip.duration) {
        if ($('loop').checked) time %= clip.duration;
        else { time = clip.duration; playing = false; $('play').textContent = '▶ Play'; }
      }
      pose();
    } else if (!gizmo.dragging) {
      fighter.finishPose();
    } else {
      fighter.root.updateMatrixWorld(true);
    }
    fighter.hair?.rig.update(Math.max(dt, 1e-4), fighter.hair.state);
    for (const m of markers.children) m.userData.bone.getWorldPosition(m.position);
    orbit.update();
  }

  return { open, close, update, get isOpen() { return isOpen; } };
}
