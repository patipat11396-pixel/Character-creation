import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Animation editor: pose any clip of the fighters bone by bone.
//
// Pick a clip and a moment on its timeline, pick a bone (click its joint on
// the body or choose it from the list) and turn it with the handles (the
// hips can also be moved). Letting go keys the pose there. Most clips have a
// key every frame, so a change is blended into the neighbouring keys over
// "Spread" seconds (0: only this moment). Edits are kept in this browser,
// used by the fight straight away, and can be exported as JSON (to send in
// and bake into the game) or imported.

const EDIT_KEY = 'character-creation:anim-edits';
const FPS = 30;   // the editor works in frames of 1/30 s
const ORIGINALS = new WeakMap();   // clip -> Map(track name -> { times, values } | null): before any edit

export function readEdits() {
  try { return JSON.parse(localStorage.getItem(EDIT_KEY)) ?? {}; } catch { return {}; }
}
function writeEdits(edits) {
  try { localStorage.setItem(EDIT_KEY, JSON.stringify(edits)); } catch { /* private mode */ }
}

function remember(clip, name) {
  if (!ORIGINALS.has(clip)) ORIGINALS.set(clip, new Map());
  const m = ORIGINALS.get(clip);
  if (m.has(name)) return;
  const tr = clip.tracks.find((t) => t.name === name);
  m.set(name, tr ? { times: Array.from(tr.times), values: Array.from(tr.values) } : null);
}

function setTrack(clip, name, times, values) {
  remember(clip, name);
  const i = clip.tracks.findIndex((t) => t.name === name);
  const Track = name.endsWith('.position') ? THREE.VectorKeyframeTrack : THREE.QuaternionKeyframeTrack;
  const track = new Track(name, times, values);
  if (i >= 0) clip.tracks[i] = track; else clip.tracks.push(track);
}

/** Put saved edits (or `edits`) into a fighter's clips (a Map of name -> clip). */
export function applyAnimEdits(clips, edits = readEdits()) {
  for (const [clipName, data] of Object.entries(edits)) {
    const clip = clips.get(clipName);
    if (!clip) continue;
    for (const [name, t] of Object.entries(data.tracks ?? {})) setTrack(clip, name, t.times, t.values);
    clips.delete(`${clipName}#upper`);
    clips.delete(`${clipName}#lower`);
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
  clips.delete(`${clip.name}#upper`);
  clips.delete(`${clip.name}#lower`);
}

const css = `
#anim-editor { position: fixed; left: 12px; top: 12px; bottom: 12px; width: 300px; background: rgba(255,255,255,0.96); border: 1px solid #ddd; border-radius: 8px;
  padding: 10px 12px; font: 12px/1.4 system-ui, sans-serif; color: #1d1f24; overflow: auto; z-index: 20; display: flex; flex-direction: column; gap: 8px; }
#anim-editor h3 { margin: 0; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
#anim-editor label { display: flex; flex-direction: column; gap: 2px; color: #555; }
#anim-editor select, #anim-editor input[type=number] { font-size: 12px; }
#anim-editor .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
#anim-editor button { border: 1px solid #ccc; background: #fff; border-radius: 4px; cursor: pointer; font-size: 12px; padding: 3px 8px; }
#anim-editor button.on { background: #c9a227; border-color: #c9a227; color: #fff; }
#anim-editor .keys { position: relative; height: 14px; background: #f1f1ef; border-radius: 3px; }
#anim-editor .keys i { position: absolute; top: 2px; width: 3px; height: 10px; background: #c9a227; margin-left: -1px; }
#anim-editor .keys b { position: absolute; top: 0; width: 2px; height: 14px; background: #c8323c; margin-left: -1px; }
#anim-editor .note { color: #777; margin: 0; }
#anim-editor textarea { width: 100%; height: 70px; font-size: 11px; }
`;

/**
 * The editor. ctx: { scene, camera, canvas, fighters: () => [player, enemy], onClose }.
 * Returns { open(), close(), update(dt), isOpen }.
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
  const gizmo = new TransformControls(ctx.camera, ctx.canvas);
  gizmo.setSpace('local');
  gizmo.setSize(0.7);
  gizmo.setMode('rotate');
  gizmo.addEventListener('dragging-changed', (e) => {
    orbit.enabled = !e.value;
    if (e.value) dragStart = { q: bone?.quaternion.clone(), p: bone?.position.clone() };
    else if (bone && auto.checked) keyBone();
  });
  ctx.scene.add(gizmo.getHelper());

  // Joint markers to click.
  const markers = new THREE.Group();
  markers.visible = false;
  ctx.scene.add(markers);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0x2f7fff, depthTest: false, transparent: true, opacity: 0.85 });
  const markerOn = new THREE.MeshBasicMaterial({ color: 0xc8323c, depthTest: false });

  let fighter = null, clip = null, action = null, time = 0, playing = false, bone = null, dragStart = null, isOpen = false;

  panel.innerHTML = `
    <h3>Animation editor <button type="button" data-a="close">Close ✕</button></h3>
    <label>Clip<select data-a="clip"></select></label>
    <div class="row"><button type="button" data-a="play">▶ Play</button>
      <button type="button" data-a="fprev" title="Previous frame (,)">◀ frame</button><button type="button" data-a="fnext" title="Next frame (.)">frame ▶</button></div>
    <div class="row"><span>frame <input data-a="frame" type="number" step="1" min="0" style="width:52px"> / <span data-a="frames"></span></span>
      <span style="color:#777">(<span data-a="secs"></span> s of <span data-a="dur"></span> s)</span></div>
    <input data-a="scrub" type="range" min="0" step="1">
    <div class="keys" data-a="keys"></div>
    <label>Bone (or click a joint)<select data-a="bone"></select></label>
    <div class="row"><button type="button" data-a="rotate" class="on">Rotate</button><button type="button" data-a="move">Move (hips)</button>
      <button type="button" data-a="prev">◀ key</button><button type="button" data-a="next">key ▶</button></div>
    <div class="row"><button type="button" data-a="key">Set key</button><button type="button" data-a="del">Delete key</button>
      <label style="flex-direction:row;align-items:center;gap:4px"><input type="checkbox" data-a="auto" checked> key on release</label></div>
    <label>Blend into nearby frames: <span data-a="spreadv">0 (this frame only)</span><input data-a="spread" type="range" min="0" max="0.6" step="0.01" value="0"></label>
    <div class="row"><button type="button" data-a="copy">Copy pose</button><button type="button" data-a="paste">Paste pose here</button></div>
    <div class="row"><button type="button" data-a="save">Save (use in the fight)</button><button type="button" data-a="revert">Revert this clip</button></div>
    <div class="row"><button type="button" data-a="export">Export JSON</button><button type="button" data-a="import">Import JSON</button></div>
    <textarea data-a="json" placeholder="Exported edits appear here; paste edits here to import." hidden></textarea>
    <p class="note" data-a="status">Drag to orbit, scroll to zoom. Click a blue joint to pick a bone, then turn it with the rings. Letting go keys it on this frame. Keys: , . frames · K key · Space play.</p>`;
  const $ = (a) => panel.querySelector(`[data-a="${a}"]`);
  const auto = $('auto');
  const status = (t) => { $('status').textContent = t; };
  let dirty = new Set();   // clip names edited since the last save

  function trackOf(name) { return clip?.tracks.find((t) => t.name === name); }
  function boneTrack() {
    if (!bone) return null;
    return `${bone.name}.${gizmo.mode === 'translate' ? 'position' : 'quaternion'}`;
  }

  function pose() {
    if (!fighter || !clip) return;
    fighter.mixer.stopAllAction();
    action = fighter.mixer.clipAction(clip);
    action.reset().play();
    action.paused = true;
    action.time = time;
    fighter.mixer.update(0);
    fighter.finishPose();
    syncTime();
  }
  function rebind() {
    fighter.mixer.stopAllAction();
    fighter.mixer.uncacheClip(clip);
    pose();
  }
  const frameCount = () => Math.max(1, Math.round(clip.duration * FPS));
  function syncTime() {
    $('frame').value = Math.round(time * FPS);
    $('frames').textContent = frameCount();
    $('secs').textContent = time.toFixed(2);
    $('scrub').max = frameCount();
    $('scrub').value = Math.round(time * FPS);
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
    const tr = trackOf(boneTrack());
    if (clip && tr && tr.times.length < 400) {
      for (const t of tr.times) {
        const i = document.createElement('i');
        i.style.left = `${(t / clip.duration) * 100}%`;
        box.appendChild(i);
      }
    }
    const b = document.createElement('b');
    b.style.left = `${clip ? (time / clip.duration) * 100 : 0}%`;
    box.appendChild(b);
  }

  /** Key the selected bone's current pose at `time`, blending the change over the spread. */
  function keyBone(quiet = false) {
    if (!bone || !clip) return;
    time = Math.min(Math.round(time * FPS) / FPS, clip.duration);   // keys sit on frames
    const name = boneTrack();
    const isPos = name.endsWith('.position');
    const now = isPos ? bone.position.clone() : bone.quaternion.clone();
    let tr = trackOf(name);
    // The pose the clip had here before the change.
    let before;
    if (tr) before = isPos ? new THREE.Vector3().fromArray(tr.createInterpolant().evaluate(time)) : new THREE.Quaternion().fromArray(tr.createInterpolant().evaluate(time));
    else before = dragStart ? (isPos ? dragStart.p : dragStart.q) : now.clone();
    const times = tr ? Array.from(tr.times) : [];
    const values = tr ? Array.from(tr.values) : [];
    const n = isPos ? 3 : 4;
    // Make sure there is a key at this moment.
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
      if (isPos) {
        const v = new THREE.Vector3().fromArray(values, i * 3).addScaledVector(deltaP, w);
        v.toArray(values, i * 3);
      } else {
        const q = new THREE.Quaternion().fromArray(values, i * 4);
        new THREE.Quaternion().slerp(deltaQ, w).multiply(q).normalize().toArray(values, i * 4);
      }
    }
    setTrack(clip, name, times, values);
    dirty.add(clip.name);
    if (quiet) return;
    rebind();
    status(`Keyed ${bone.name} on frame ${Math.round(time * FPS)} (unsaved).`);
  }

  function deleteKey() {
    const tr = trackOf(boneTrack());
    if (!tr) return;
    const i = Array.from(tr.times).findIndex((t) => Math.abs(t - time) < 0.02);
    if (i < 0 || tr.times.length < 2) { status('No key here.'); return; }
    const n = tr.getValueSize();
    const times = Array.from(tr.times), values = Array.from(tr.values);
    times.splice(i, 1);
    values.splice(i * n, n);
    setTrack(clip, tr.name, times, values);
    dirty.add(clip.name);
    rebind();
  }

  function jumpKey(dir) {
    const tr = trackOf(boneTrack());
    if (!tr) return;
    const ts = Array.from(tr.times);
    const t = dir > 0 ? ts.find((x) => x > time + 1e-3) : [...ts].reverse().find((x) => x < time - 1e-3);
    if (t !== undefined) { time = t; pose(); }
  }

  function selectBone(b) {
    bone = b;
    $('bone').value = b ? b.name : '';
    for (const m of markers.children) m.material = m.userData.bone === b ? markerOn : markerMat;
    if (b) gizmo.attach(b); else gizmo.detach();
    if (b?.name !== 'Hips' && gizmo.mode === 'translate') setMode('rotate');
    drawKeys();
  }
  function setMode(mode) {
    if (mode === 'translate' && bone?.name !== 'Hips') { status('Only the hips can be moved.'); return; }
    gizmo.setMode(mode);
    $('rotate').classList.toggle('on', mode === 'rotate');
    $('move').classList.toggle('on', mode === 'translate');
    drawKeys();
  }

  function saveEdits() {
    const edits = readEdits();
    for (const name of dirty) {
      const c = fighter.clips.get(name);
      const m = ORIGINALS.get(c);
      if (!c || !m) continue;
      const tracks = {};
      for (const tn of m.keys()) {
        const tr = c.tracks.find((t) => t.name === tn);
        if (tr) tracks[tn] = { times: Array.from(tr.times, (v) => +v.toFixed(4)), values: Array.from(tr.values, (v) => +v.toFixed(5)) };
      }
      edits[name] = { tracks };
    }
    writeEdits(edits);
    // The other fighter uses the same clips by name.
    for (const f of ctx.fighters()) if (f !== fighter) applyAnimEdits(f.clips, edits);
    dirty = new Set();
    status('Saved. The fight uses these edits (in this browser).');
  }

  // ---- UI wiring
  $('close').onclick = () => close();
  $('clip').onchange = () => { clip = fighter.clips.get($('clip').value); time = 0; $('dur').textContent = clip.duration.toFixed(2); pose(); };
  $('spread').oninput?.();
  $('play').onclick = () => { playing = !playing; $('play').textContent = playing ? '❚❚ Pause' : '▶ Play'; };
  $('scrub').oninput = () => goFrame(Number($('scrub').value));
  $('frame').onchange = () => goFrame(Number($('frame').value));
  $('fprev').onclick = () => goFrame(Math.round(time * FPS) - 1);
  $('fnext').onclick = () => goFrame(Math.round(time * FPS) + 1);
  $('spread').oninput = () => {
    const v = Number($('spread').value);
    $('spreadv').textContent = v ? `${v.toFixed(2)} s each side` : '0 (this frame only)';
  };
  // Copy / paste the whole pose (every bone) between frames.
  let clipboard = null;
  $('copy').onclick = () => {
    clipboard = fighter.mesh.skeleton.bones.map((b) => [b, b.quaternion.clone(), b.position.clone()]);
    status(`Copied the pose at frame ${Math.round(time * FPS)}.`);
  };
  $('paste').onclick = () => {
    if (!clipboard) { status('Copy a pose first.'); return; }
    const keep = bone;
    for (const [b, q, p] of clipboard) {
      if (/Hand(Thumb|Index|Middle|Ring|Pinky)/.test(b.name) || b.name === 'root') continue;
      bone = b;
      b.quaternion.copy(q);
      setMode('rotate');
      keyBone(true);
      if (b.name === 'Hips') { b.position.copy(p); gizmo.setMode('translate'); keyBone(true); gizmo.setMode('rotate'); }
    }
    bone = keep;
    rebind();
    status(`Pasted the pose at frame ${Math.round(time * FPS)} (unsaved).`);
  };
  $('bone').onchange = () => selectBone(fighter.bones[$('bone').value] ?? null);
  $('rotate').onclick = () => setMode('rotate');
  $('move').onclick = () => setMode('translate');
  $('key').onclick = () => keyBone();
  $('del').onclick = () => deleteKey();
  $('prev').onclick = () => jumpKey(-1);
  $('next').onclick = () => jumpKey(1);
  $('save').onclick = () => saveEdits();
  $('revert').onclick = () => {
    for (const f of ctx.fighters()) revertClip(f.clips.get(clip.name), f.clips);
    const edits = readEdits();
    delete edits[clip.name];
    writeEdits(edits);
    dirty.delete(clip.name);
    clip = fighter.clips.get(clip.name);
    rebind();
    status(`${clip.name} is back to the original.`);
  };
  $('export').onclick = async () => {
    saveEdits();
    const text = JSON.stringify(readEdits());
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
      const edits = JSON.parse(box.value);
      writeEdits({ ...readEdits(), ...edits });
      for (const f of ctx.fighters()) applyAnimEdits(f.clips, edits);
      rebind();
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
    if (e.code === 'KeyK') keyBone();
    if (e.code === 'Comma') goFrame(Math.round(time * FPS) - 1);
    if (e.code === 'Period') goFrame(Math.round(time * FPS) + 1);
    if (e.code === 'Space') { e.preventDefault(); $('play').click(); }
  });

  function open(f) {
    fighter = f;
    isOpen = true;
    panel.hidden = false;
    const names = [...f.clips.keys()].filter((n) => !n.includes('#')).sort();
    $('clip').innerHTML = names.map((n) => `<option>${n}</option>`).join('');
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
    clip = f.clips.get($('clip').value = f.clips.has('Idle_Sword_Out') ? 'Idle_Sword_Out' : names[0]);
    $('dur').textContent = clip.duration.toFixed(2);
    time = 0;
    orbit.target.copy(f.pos).add(new THREE.Vector3(0, 1.0, 0));
    ctx.camera.position.copy(f.pos).add(new THREE.Vector3(1.8, 1.4, 2.6).applyAxisAngle(new THREE.Vector3(0, 1, 0), f.yaw));
    orbit.enabled = true;
    selectBone(null);
    pose();
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
      time = (time + dt) % clip.duration;
      pose();
    } else if (!gizmo.dragging) {
      // Hold the pose (hair and fingers settle).
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
