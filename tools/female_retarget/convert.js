// Runs in the browser page (view.html): the new character (src.fbx) moved onto the game's
// female skeleton (character_female.glb): same bones, same rest rotations and clips, the
// joints placed at the new character's own proportions (scaled to the old height).
window.convert = async function convert(opts = {}) {
  const { THREE, FBXLoader, GLTFLoader } = window;
  const log = [];
  const fbx = (await new GLTFLoader().loadAsync('src.glb')).scene;
  fbx.updateMatrixWorld(true);
  const gl = await new GLTFLoader().loadAsync('/cc/models/character_female.glb');
  const old = gl.scene;
  old.updateMatrixWorld(true);

  // ---- old rig: the skin mesh, its skeleton, joints in its geometry space (Z-up cm)
  let om = null;
  const oldMeshes = [];
  old.traverse((o) => { if (o.isSkinnedMesh) { oldMeshes.push(o); if (o.material.name === 'Skin') om = o; } });
  const OS = om.skeleton;
  // (geometry space: bindMatrix^-1 * boneInverse^-1; the loaded bindMatrixInverse is not always bindMatrix's inverse)
  const geoJoint = (mesh, i) => new THREE.Vector3().setFromMatrixPosition(mesh.bindMatrix.clone().invert().multiply(mesh.skeleton.boneInverses[i].clone().invert()));
  const OJ = {};
  OS.bones.forEach((b, i) => { OJ[b.name] = geoJoint(om, i); });
  log.push('DBG om bind ' + om.bindMatrix.elements.map((v) => +v.toFixed(3)) + ' OJ.Hips ' + OJ.Hips.toArray().map((v) => v.toFixed(2)) + ' bones ' + OS.bones.length + ' meshes ' + oldMeshes.map((m) => m.material.name));

  // ---- new rig: joints in the new skin's geometry space, then into the old space
  let nsk = null;
  fbx.traverse((o) => { if (o.isSkinnedMesh && o.material.name === 'Material.001') nsk = o; });
  const NJraw = {};
  nsk.skeleton.bones.forEach((b, i) => { NJraw[b.name] = geoJoint(nsk, i); });
  // up axis: the bbox's tallest (glTF is Y up; the old data is Z up, front -Y)
  const nbox0 = new THREE.Box3().setFromBufferAttribute(nsk.geometry.attributes.position);
  const sz = nbox0.getSize(new THREE.Vector3());
  const Rup = new THREE.Matrix4();
  if (sz.y > sz.z) Rup.makeRotationX(Math.PI / 2);   // (x, y, z) -> (x, -z, y)
  const nbox = new THREE.Box3().setFromBufferAttribute(nsk.geometry.attributes.position.clone().applyMatrix4(Rup));
  const obox = new THREE.Box3().setFromBufferAttribute(om.geometry.attributes.position);
  const height = opts.height ?? (obox.max.z - Math.max(0, obox.min.z));
  const k = height / (nbox.max.z - nbox.min.z);
  const toeU = NJraw.ToeL.clone().applyMatrix4(Rup), footU = NJraw.FootL.clone().applyMatrix4(Rup);
  const facesPlusY = toeU.y > footU.y;
  // G: new geometry -> old geometry (Z up, scale, turn round to face -Y if needed, feet on the floor, hips over the old hips)
  const G = Rup.clone().premultiply(new THREE.Matrix4().makeScale(k, k, k));
  if (facesPlusY) G.premultiply(new THREE.Matrix4().makeRotationZ(Math.PI));
  const hipsG = NJraw.Hips.clone().applyMatrix4(G);
  G.premultiply(new THREE.Matrix4().makeTranslation(OJ.Hips.x - hipsG.x, OJ.Hips.y - hipsG.y, -nbox.min.z * k));
  const NJ = {};
  for (const [n, v] of Object.entries(NJraw)) NJ[n] = v.clone().applyMatrix4(G);
  const Grot = new THREE.Matrix3().setFromMatrix4(G).multiplyScalar(1 / k);   // (rotation part)
  log.push(`k ${k.toFixed(2)} facesPlusY ${facesPlusY} height ${height.toFixed(1)} newHips ${NJ.Hips.z.toFixed(1)} oldHips ${OJ.Hips.z.toFixed(1)}`);

  // ---- names: new bone -> old bone
  const MAP = { Root: 'root', Hips: 'Hips', Spine: 'Spine', Chest: 'Spine1', UpperChest: 'Spine2', Neck: 'Neck', Head: 'Head', Jaw: 'Head', EyeL: 'Head', EyeR: 'Head' };
  const FING = { Thumb: 'Thumb', Index: 'Index', Middle: 'Middle', Ring: 'Ring', Little: 'Pinky' };
  for (const [s, side] of [['L', 'Left'], ['R', 'Right']]) {
    Object.assign(MAP, { [`Clavicle${s}`]: `${side}Shoulder`, [`UpperArm${s}`]: `${side}Arm`, [`Forearm${s}`]: `${side}ForeArm`, [`Hand${s}`]: `${side}Hand`,
      [`Thigh${s}`]: `${side}UpLeg`, [`Shin${s}`]: `${side}Leg`, [`Foot${s}`]: `${side}Foot`, [`Toe${s}`]: `${side}ToeBase` });
    for (const [a, b] of Object.entries(FING)) for (let i = 1; i <= 3; i++) MAP[`${a}${i}${s}`] = `${side}Hand${b}${i}`;
  }
  const INV = {};
  for (const [n, o] of Object.entries(MAP)) if (!(o in INV) && !['Jaw', 'EyeL', 'EyeR'].includes(n)) INV[o] = n;
  // Each old bone's main child (its direction).
  const CHILD = { Hips: 'Spine', Spine: 'Spine1', Spine1: 'Spine2', Spine2: 'Neck', Neck: 'Head' };
  for (const side of ['Left', 'Right']) {
    Object.assign(CHILD, { [`${side}Shoulder`]: `${side}Arm`, [`${side}Arm`]: `${side}ForeArm`, [`${side}ForeArm`]: `${side}Hand`, [`${side}Hand`]: `${side}HandMiddle1`,
      [`${side}UpLeg`]: `${side}Leg`, [`${side}Leg`]: `${side}Foot`, [`${side}Foot`]: `${side}ToeBase` });
    for (const f of Object.values(FING)) { CHILD[`${side}Hand${f}1`] = `${side}Hand${f}2`; CHILD[`${side}Hand${f}2`] = `${side}Hand${f}3`; }
  }
  // ---- per old bone: R (the new piece turned onto the old bone's direction), S* (its joint)
  const R = {}, S = {};
  const align = (a, b) => new THREE.Quaternion().setFromUnitVectors(a.clone().normalize(), b.clone().normalize());
  const order = [];   // old bones, parents first
  OS.bones[0].traverse ? null : null;
  const visit = (b) => { if (b.isBone) order.push(b); b.children.forEach(visit); };
  visit(OS.bones.find((b) => b.name === 'root'));
  for (const b of order) {
    const B = b.name, n = INV[B];
    const P = b.parent?.isBone ? b.parent.name : null;
    if (!n) { log.push('no new bone for ' + B); R[B] = P ? R[P] : new THREE.Quaternion(); S[B] = OJ[B].clone(); continue; }
    // the joint: where the parent's turned piece carries it
    if (!P) S[B] = NJ[n].clone();
    else S[B] = S[P].clone().add(NJ[n].clone().sub(NJ[INV[P]]).applyQuaternion(R[P]));
    const C = CHILD[B];
    if (C && INV[C]) R[B] = align(NJ[INV[C]].clone().sub(NJ[n]), OJ[C].clone().sub(OJ[B]));
    else R[B] = P ? R[P].clone() : new THREE.Quaternion();
  }
  log.push(`S* hips ${S.Hips.toArray().map((v) => v.toFixed(1))} head ${S.Head.toArray().map((v) => v.toFixed(1))} Lhand ${S.LeftHand.toArray().map((v) => v.toFixed(1))} Lfoot ${S.LeftFoot.toArray().map((v) => v.toFixed(1))}`);

  // ---- the old skeleton re-jointed: rest rotations kept, joints at S* (world space)
  // The bind pose, set by hand (Skeleton.pose() writes the root bone's world into its
  // local, ignoring the armature's scale): world = meshWorld * boneInverse^-1.
  const toWorld = om.matrixWorld.clone();   // (geometry -> world)
  const setWorld = (b, w) => { b.matrix.copy(b.parent.matrixWorld.clone().invert().multiply(w)); b.matrix.decompose(b.position, b.quaternion, b.scale); b.updateMatrixWorld(true); };
  for (const b of order) setWorld(b, toWorld.clone().multiply(OS.boneInverses[OS.bones.indexOf(b)].clone().invert()));
  for (const b of order) {
    const w = S[b.name].clone().applyMatrix4(toWorld);
    b.position.copy(b.parent.worldToLocal(w));
    b.updateMatrixWorld(true);
  }
  const NS = new THREE.Skeleton(OS.bones, OS.bones.map((b) => b.matrixWorld.clone().invert()));
  const oldIndex = Object.fromEntries(OS.bones.map((b, i) => [b.name, i]));

  // ---- the new meshes, moved and bound to it
  const nskBindInv = nsk.bindMatrix.clone().invert();
  const made = [];
  const mats = new Map();
  const stdMat = (m, name) => {
    if (mats.has(m)) return mats.get(m);
    const s = new THREE.MeshStandardMaterial({ name: name ?? m.name, color: m.color.clone(), map: m.map ?? null, roughness: Math.max(0.55, m.roughness ?? 0.75), metalness: 0, side: THREE.FrontSide });
    if (s.map) { s.map.colorSpace = THREE.SRGBColorSpace; s.map.userData.mimeType = 'image/jpeg'; }
    mats.set(m, s);
    return s;
  };
  const NAMES = { 'Material.001': 'Skin', 'Teeth': 'Teeth', 'Tongue': 'Tongue' };
  const parts = [];
  fbx.traverse((o) => { if (o.isSkinnedMesh) parts.push(o); });
  const zeroCtrl = { w: 0 };
  for (const src of parts) {
    const g0 = src.geometry;
    const toSkin = nskBindInv.clone().multiply(src.bindMatrix);   // this mesh's geometry -> the skin's geometry
    const pos = g0.attributes.position, nrm = g0.attributes.normal, si = g0.attributes.skinIndex, sw = g0.attributes.skinWeight;
    const n = pos.count;
    const P2 = new Float32Array(n * 3), N2 = new Float32Array(n * 3), SI = new Uint16Array(n * 4), SW = new Float32Array(n * 4);
    const Rv = [];   // per vertex: its blended turn (for normals and morph deltas)
    const v = new THREE.Vector3(), nv = new THREE.Vector3(), acc = new THREE.Vector3(), tmp = new THREE.Vector3();
    const nm = new THREE.Matrix3().getNormalMatrix(toSkin);
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(toSkin).applyMatrix4(G);
      nv.fromBufferAttribute(nrm, i).applyMatrix3(nm).applyMatrix3(Grot).normalize();
      acc.set(0, 0, 0);
      const w = {};
      let wsum = 0;
      for (let c = 0; c < 4; c++) {
        const wt = sw.getComponent(i, c);
        if (wt <= 0) continue;
        let nb = src.skeleton.bones[si.getComponent(i, c)].name;
        let ob = MAP[nb];
        if (!ob) { zeroCtrl.w += wt; continue; }   // (control bones: none expected)
        w[ob] = (w[ob] ?? 0) + wt;
        wsum += wt;
      }
      const ents = Object.entries(w).sort((a, b) => b[1] - a[1]).slice(0, 4);
      const tot = ents.reduce((s, e) => s + e[1], 0) || 1;
      const q = new THREE.Matrix3().set(0, 0, 0, 0, 0, 0, 0, 0, 0);
      const nn = new THREE.Vector3();
      ents.forEach(([ob, wt], c) => {
        const ww = wt / tot;
        SI[i * 4 + c] = oldIndex[ob];
        SW[i * 4 + c] = ww;
        // (Jaw / eyes ride the head: the same turn about the head's joint as the head's own.)
        const nbn = INV[ob];
        tmp.copy(v).sub(NJ[nbn]).applyQuaternion(R[ob]).add(S[ob]);
        acc.addScaledVector(tmp, ww);
        nn.addScaledVector(nv.clone().applyQuaternion(R[ob]), ww);
        const rm = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(R[ob]));
        for (let e = 0; e < 9; e++) q.elements[e] += rm.elements[e] * ww;
      });
      if (!ents.length) { acc.copy(v); SI[i * 4] = oldIndex.Head; SW[i * 4] = 1; }
      P2.set([acc.x, acc.y, acc.z], i * 3);
      nn.normalize();
      N2.set([nn.x, nn.y, nn.z], i * 3);
      Rv.push(q);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(P2, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(N2, 3));
    if (g0.attributes.uv) g.setAttribute('uv', g0.attributes.uv.clone());
    if (g0.attributes.uv1) g.setAttribute('uv1', g0.attributes.uv1.clone());
    g.setAttribute('skinIndex', new THREE.BufferAttribute(SI, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(SW, 4));
    if (g0.index) g.setIndex(g0.index.clone());
    // morphs: the deltas turned and scaled with their vertex
    const dict = src.morphTargetDictionary ?? {};
    if (g0.morphAttributes.position?.length) {
      const toSkin3 = new THREE.Matrix3().setFromMatrix4(toSkin);
      g.morphAttributes.position = g0.morphAttributes.position.map((ma) => {
        const out = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          v.fromBufferAttribute(ma, i).applyMatrix3(toSkin3).applyMatrix3(Grot).multiplyScalar(k).applyMatrix3(Rv[i]);
          out.set([v.x, v.y, v.z], i * 3);
        }
        return new THREE.BufferAttribute(out, 3);
      });
      g.morphTargetsRelative = true;
    }
    // split by material groups (one material per mesh: the game reads material.name)
    const srcMats = [].concat(src.material);
    const groups = g0.groups.length ? g0.groups : [{ start: 0, count: g0.index ? g0.index.count : n, materialIndex: 0 }];
    const byMat = new Map();
    for (const gr of groups) { if (!byMat.has(gr.materialIndex)) byMat.set(gr.materialIndex, []); byMat.get(gr.materialIndex).push(gr); }
    for (const [mi, grs] of byMat) {
      const m = srcMats[mi];
      const idx = [];
      for (const gr of grs) for (let t = gr.start; t < gr.start + gr.count; t++) idx.push(g0.index ? g0.index.getX(t) : t);
      if (!idx.length) continue;
      const gg = g.clone();
      gg.setIndex(idx);
      gg.clearGroups();
      // (keep only the vertices used)
      const used = [...new Set(idx)].sort((a, b) => a - b), remap = new Map(used.map((x, j) => [x, j]));
      const sub = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(gg.attributes)) {
        const arr = new attr.array.constructor(used.length * attr.itemSize);
        used.forEach((x, j) => { for (let c = 0; c < attr.itemSize; c++) arr[j * attr.itemSize + c] = attr.array[x * attr.itemSize + c]; });
        sub.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize, attr.normalized));
      }
      if (gg.morphAttributes.position) {
        sub.morphAttributes.position = gg.morphAttributes.position.map((ma) => {
          const arr = new Float32Array(used.length * 3);
          used.forEach((x, j) => { for (let c = 0; c < 3; c++) arr[j * 3 + c] = ma.array[x * 3 + c]; });
          return new THREE.BufferAttribute(arr, 3);
        });
        sub.morphTargetsRelative = true;
      }
      sub.setIndex(idx.map((x) => remap.get(x)));
      const onSkin = src.parent?.name === 'Character_Skin' || src.name.startsWith('Character_Skin');
      const matName = NAMES[m.name] ?? (onSkin ? 'Face_' + m.name.replace(/\s+/g, '_') : /Eye/.test(src.name) && !/lash/i.test(src.name) ? src.name.replace(/\W/g, '') : /lash/i.test(src.name) ? 'Eyelashes' : src.name);
      const mat = stdMat(m, matName);
      if (m.map && m.map.channel) mat.map.channel = m.map.channel;
      const sm = new THREE.SkinnedMesh(sub, mat);
      sm.name = matName === 'Skin' ? 'Body' : onSkin ? matName : src.name.replace(/\W/g, '');
      sm.morphTargetDictionary = { ...dict };
      sm.morphTargetInfluences = new Array(Object.keys(dict).length).fill(0);
      made.push(sm);
    }
  }
  log.push(`made ${made.map((m) => `${m.name}:${m.material.name}:${m.geometry.attributes.position.count}`).join(' ')} ctrlWeight ${zeroCtrl.w.toFixed(2)}`);

  // ---- the old body parts out, the new in (clothes kept, moved with their bones for now)
  const parent = om.parent;
  for (const m of oldMeshes) {
    if (m.material.name.startsWith('Cloth_')) {
      // each vertex carried with its bones' joints (S* - old joint): the old directions are kept
      const g = m.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      m.userData.origPos = pos.array.slice();
      // (the old face's shape keys ride on the garments, all but empty there: dropped)
      g.morphAttributes = {};
      m.morphTargetDictionary = undefined;
      m.morphTargetInfluences = undefined;
      const v = new THREE.Vector3(), acc = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        acc.set(0, 0, 0);
        for (let c = 0; c < 4; c++) {
          const wt = sw.getComponent(i, c);
          if (!wt) continue;
          const B = m.skeleton.bones[si.getComponent(i, c)].name;
          acc.add(S[B].clone().sub(OJ[B]).multiplyScalar(wt));
        }
        pos.setXYZ(i, v.x + acc.x, v.y + acc.y, v.z + acc.z);
      }
      pos.needsUpdate = true;
      g.computeBoundingSphere();
      m.bind(NS, om.matrixWorld.clone());
    } else m.removeFromParent();
  }
  for (const sm of made) {
    sm.position.copy(om.position); sm.quaternion.copy(om.quaternion); sm.scale.copy(om.scale);
    parent.add(sm);
    sm.bind(NS, om.matrixWorld.clone());
  }
  // ---- the clips: the hips carried at the new hip height (legs of another length)
  const hipRatio = S.Hips.z / OJ.Hips.z;
  for (const clip of gl.animations) for (const t of clip.tracks) if (t.name === 'Hips.position') for (let i = 0; i < t.values.length; i++) t.values[i] *= hipRatio;
  log.push('hip ratio ' + hipRatio.toFixed(3));

  // ---- the clothes onto the new body: each vertex kept at its old height above the
  // body (along the body's normal), over the nearest point of the new body
  const body = made.find((m) => m.material.name === 'Skin');
  const grid = (P, cell) => { const h = new Map(); for (let i = 0; i < P.length / 3; i++) { const key = `${Math.floor(P[i * 3] / cell)},${Math.floor(P[i * 3 + 1] / cell)},${Math.floor(P[i * 3 + 2] / cell)}`; (h.get(key) ?? h.set(key, []).get(key)).push(i); } return { h, cell, P }; };
  const nearest = (G2, x, y, z, maxR = 14) => {
    const c = G2.cell, cx = Math.floor(x / c), cy = Math.floor(y / c), cz = Math.floor(z / c);
    let best = -1, bd = Infinity;
    for (let r = 0; r * c <= maxR; r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k2 = -r; k2 <= r; k2++) {
        if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k2)) !== r) continue;
        const list = G2.h.get(`${cx + i},${cy + j},${cz + k2}`);
        if (!list) continue;
        for (const q of list) { const dx = G2.P[q * 3] - x, dy = G2.P[q * 3 + 1] - y, dz = G2.P[q * 3 + 2] - z, d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; best = q; } }
      }
      if (best >= 0 && Math.sqrt(bd) < r * c) break;
    }
    return best;
  };
  const oldP = om.geometry.attributes.position.array, oldN = om.geometry.attributes.normal.array;
  const newP = body.geometry.attributes.position.array, newN = body.geometry.attributes.normal.array;
  const GN = grid(newP, 2);
  // the old body carried by its bones (as the garments are), and how far each of its
  // vertices must move along its normal to lie on the new body
  const B1 = new Float32Array(oldP.length), BD = new Float32Array(oldP.length);
  {
    const si = om.geometry.attributes.skinIndex, sw = om.geometry.attributes.skinWeight;
    for (let i = 0; i < oldP.length / 3; i++) {
      let ax = 0, ay = 0, az = 0;
      for (let c = 0; c < 4; c++) { const wt = sw.getComponent(i, c); if (!wt) continue; const Bn = om.skeleton.bones[si.getComponent(i, c)].name; ax += (S[Bn].x - OJ[Bn].x) * wt; ay += (S[Bn].y - OJ[Bn].y) * wt; az += (S[Bn].z - OJ[Bn].z) * wt; }
      B1[i * 3] = oldP[i * 3] + ax; B1[i * 3 + 1] = oldP[i * 3 + 1] + ay; B1[i * 3 + 2] = oldP[i * 3 + 2] + az;
    }
    for (let i = 0; i < oldP.length / 3; i++) {
      const q = nearest(GN, B1[i * 3], B1[i * 3 + 1], B1[i * 3 + 2], 10);
      if (q < 0) continue;
      const nx = oldN[i * 3], ny = oldN[i * 3 + 1], nz = oldN[i * 3 + 2];
      let d = (newP[q * 3] - B1[i * 3]) * nx + (newP[q * 3 + 1] - B1[i * 3 + 1]) * ny + (newP[q * 3 + 2] - B1[i * 3 + 2]) * nz;
      d = Math.max(-8, Math.min(8, d));
      BD[i * 3] = nx * d; BD[i * 3 + 1] = ny * d; BD[i * 3 + 2] = nz * d;
    }
  }
  const GB = grid(B1, 2);
  for (const m of oldMeshes) {
    if (!m.material.name.startsWith('Cloth_')) continue;
    const g = m.geometry, pos = g.attributes.position, n = pos.count;
    const orig = m.userData.origPos;   // (before the bone carry)
    // weld (garments are split at seams) and neighbours
    const idx = g.index.array;
    const key = (i) => `${Math.round(orig[i * 3] * 20)},${Math.round(orig[i * 3 + 1] * 20)},${Math.round(orig[i * 3 + 2] * 20)}`;
    const weld = new Map(), wid = new Int32Array(n);
    for (let i = 0; i < n; i++) { const kk = key(i); if (!weld.has(kk)) weld.set(kk, weld.size); wid[i] = weld.get(kk); }
    const W = weld.size, wnb = Array.from({ length: W }, () => new Set());
    for (let t = 0; t < idx.length; t += 3) for (const [a2, b2] of [[0, 1], [1, 2], [2, 0]]) { const A = wid[idx[t + a2]], B = wid[idx[t + b2]]; if (A !== B) { wnb[A].add(B); wnb[B].add(A); } }
    // the body's change of shape carried over: each garment vertex moved as the old body
    // near it (within 5 cm, by inverse distance) moves onto the new body
    let snapped = 0;
    for (let i = 0; i < n; i++) {
      const x1 = pos.getX(i), y1 = pos.getY(i), z1 = pos.getZ(i);
      const c = GB.cell, cx = Math.floor(x1 / c), cy = Math.floor(y1 / c), cz = Math.floor(z1 / c);
      let sx = 0, sy = 0, sz = 0, sw2 = 0;
      for (let a3 = -2; a3 <= 2; a3++) for (let b3 = -2; b3 <= 2; b3++) for (let c3 = -2; c3 <= 2; c3++) {
        const list = GB.h.get(`${cx + a3},${cy + b3},${cz + c3}`);
        if (!list) continue;
        for (const q of list) {
          const dx = B1[q * 3] - x1, dy = B1[q * 3 + 1] - y1, dz = B1[q * 3 + 2] - z1, d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > 25) continue;
          const w = 1 / (d2 + 0.25);
          sx += BD[q * 3] * w; sy += BD[q * 3 + 1] * w; sz += BD[q * 3 + 2] * w; sw2 += w;
        }
      }
      if (sw2 > 0) { pos.setXYZ(i, x1 + sx / sw2, y1 + sy / sw2, z1 + sz / sw2); snapped++; }
    }
    // nothing under the skin: a push out to MIN_GAP over the body, spread smoothly over
    // the garment (diffused over the welded neighbours), three rounds
    const MIN_GAP = opts.minGap ?? 0.85;
    for (let pass = 0; pass < (opts.pushPasses ?? 4); pass++) {
      let push = new Float32Array(W * 3);
      const wpos = new Float32Array(W * 3), wcnt = new Float32Array(W);
      for (let i = 0; i < n; i++) { wpos[wid[i] * 3] += pos.getX(i); wpos[wid[i] * 3 + 1] += pos.getY(i); wpos[wid[i] * 3 + 2] += pos.getZ(i); wcnt[wid[i]]++; }
      for (let w = 0; w < W; w++) {
        const x = wpos[w * 3] / wcnt[w], y = wpos[w * 3 + 1] / wcnt[w], z = wpos[w * 3 + 2] / wcnt[w], q = nearest(GN, x, y, z, 6);
        if (q < 0) continue;
        const d = (x - newP[q * 3]) * newN[q * 3] + (y - newP[q * 3 + 1]) * newN[q * 3 + 1] + (z - newP[q * 3 + 2]) * newN[q * 3 + 2];
        if (d < MIN_GAP && d > -6) for (let c = 0; c < 3; c++) push[w * 3 + c] = newN[q * 3 + c] * (MIN_GAP - d);
      }
      for (let it = 0; it < 6; it++) {   // (spread: each takes the larger of its own and its neighbours' mean)
        const np2 = new Float32Array(W * 3);
        for (let w = 0; w < W; w++) {
          let sx = 0, sy = 0, sz = 0, cnt = 0;
          for (const o of wnb[w]) { sx += push[o * 3]; sy += push[o * 3 + 1]; sz += push[o * 3 + 2]; cnt++; }
          const mx = cnt ? sx / cnt : 0, my = cnt ? sy / cnt : 0, mz = cnt ? sz / cnt : 0;
          const own = Math.hypot(push[w * 3], push[w * 3 + 1], push[w * 3 + 2]), mean = Math.hypot(mx, my, mz);
          if (own >= mean) { np2[w * 3] = 0.5 * push[w * 3] + 0.5 * mx; np2[w * 3 + 1] = 0.5 * push[w * 3 + 1] + 0.5 * my; np2[w * 3 + 2] = 0.5 * push[w * 3 + 2] + 0.5 * mz; }
          else { np2[w * 3] = mx; np2[w * 3 + 1] = my; np2[w * 3 + 2] = mz; }
        }
        push = np2;
      }
      for (let i = 0; i < n; i++) pos.setXYZ(i, pos.getX(i) + push[wid[i] * 3], pos.getY(i) + push[wid[i] * 3 + 1], pos.getZ(i) + push[wid[i] * 3 + 2]);
    }
    pos.needsUpdate = true;
    // the garment moves as the body under it does: each welded vertex takes the skin
    // weights of the nearest body vertex
    const bSI = body.geometry.attributes.skinIndex.array, bSW = body.geometry.attributes.skinWeight.array;
    const gSI = g.attributes.skinIndex, gSW = g.attributes.skinWeight;
    const pick = new Int32Array(W).fill(-2);
    for (let i = 0; i < n; i++) {
      const w = wid[i];
      if (pick[w] === -2) pick[w] = nearest(GN, pos.getX(i), pos.getY(i), pos.getZ(i), 20);
      const q = pick[w];
      if (q < 0) continue;
      for (let c = 0; c < 4; c++) { gSI.setComponent(i, c, bSI[q * 4 + c]); gSW.setComponent(i, c, bSW[q * 4 + c]); }
    }
    gSI.needsUpdate = gSW.needsUpdate = true;
    // normals again, averaged over the welded seams
    g.computeVertexNormals();
    const nr = g.attributes.normal, wn = new Float32Array(W * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) wn[wid[i] * 3 + c] += nr.array[i * 3 + c];
    for (let i = 0; i < n; i++) { const x = wn[wid[i] * 3], y = wn[wid[i] * 3 + 1], z = wn[wid[i] * 3 + 2], l = Math.hypot(x, y, z) || 1; nr.setXYZ(i, x / l, y / l, z / l); }
    nr.needsUpdate = true;
    g.computeBoundingSphere();
    log.push(`${m.material.name}: ${snapped}/${n} fitted`);
  }

  const rest = order.map((b) => [b, b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
  const restPose = () => { for (const [b, p, q, sc] of rest) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(sc); } old.updateMatrixWorld(true); };
  window.conv = { old, gl, made, NS, S, OJ, R, NJ, k, G, om, log, restPose, order };
  return log.join('\n');
};

// Landmarks the menu and the game read (scene.userData.body), as tools/process_character.py
// makes them, from the new body (mesh cm), then the GLB.
window.exportGLB = async function exportGLB() {
  const { THREE, GLTFExporter, conv } = window;
  const { old, gl, made, S, NS } = conv;
  const body = made.find((m) => m.material.name === 'Skin');
  const P = body.geometry.attributes.position.array, n = P.length / 3;
  const V = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  let top = -Infinity; for (let i = 0; i < n; i++) top = Math.max(top, P[i * 3 + 2]);
  const head = [], level = [];
  for (let i = 0; i < n; i++) { const v = V(i); if (v[2] > S.Neck.z) head.push(v); if (Math.abs(v[2] - (top - 6)) < 0.3) level.push(v); }
  let nose = head[0]; for (const v of head) if (v[1] < nose[1] && Math.abs(v[0] - S.Head.x) < 1.5) nose = v;
  // chin: the lowest point of the face's front (near the nose's depth, under it, on the middle line)
  let chin = Infinity; for (const v of head) if (Math.abs(v[0] - S.Head.x) < 1.2 && v[1] < nose[1] + 5 && v[2] < nose[2]) chin = Math.min(chin, v[2]);
  const REF = { top: 164.63, half: 10.31, front: 2.6, back: 26.75, chin: 136.33 };
  const half = Math.max(...level.map((v) => Math.abs(v[0])));
  const front = Math.min(...level.map((v) => v[1])), back = Math.max(...level.map((v) => v[1]));
  const scale = [half / REF.half, (back - front) / (REF.back - REF.front), (top - chin) / (REF.top - REF.chin)];
  const offset = [0, front - scale[1] * REF.front, top - scale[2] * REF.top];
  const r4 = (x) => Math.round(x * 1e4) / 1e4, r2 = (x) => Math.round(x * 100) / 100;
  // colliders (hair keeps outside them): process_character.body_colliders
  const bind = (nm) => [S[nm].x, S[nm].y, S[nm].z];
  const verts = []; for (let i = 0; i < n; i++) verts.push(V(i));
  const out = [];
  const fit = (bone, sel, grow = [1.1, 1.12, 1.35]) => {
    const p = verts.filter(sel); if (!p.length) return;
    const lo = [0, 1, 2].map((c) => Math.min(...p.map((v) => v[c]))), hi = [0, 1, 2].map((c) => Math.max(...p.map((v) => v[c])));
    out.push({ bone, centre: lo.map((l, c) => r2((l + hi[c]) / 2)), radii: lo.map((l, c) => r2((hi[c] - l) / 2 * grow[c])) });
  };
  const armX = Math.abs(bind('LeftArm')[0]), neckZ = bind('Neck')[2], headZ = bind('Head')[2];
  fit('Spine2', ([x, , z]) => Math.abs(x) < armX && z > bind('Spine2')[2] - 3 && z < neckZ - 1);
  fit('Spine1', ([x, , z]) => Math.abs(x) < armX && z > bind('Spine1')[2] - 4 && z < bind('Spine2')[2]);
  fit('Hips', ([x, , z]) => Math.abs(x) < armX + 4 && z > bind('Hips')[2] - 14 && z < bind('Spine')[2]);
  fit('Neck', ([x, y, z]) => Math.abs(x) < 6 && z > neckZ - 1 && z < (neckZ + headZ) / 2 + 1 && y > nose[1] + 4, [1.08, 1.08, 1.6]);
  for (const side of ['Left', 'Right']) {
    const a = bind(`${side}Arm`), f = bind(`${side}ForeArm`), s = Math.sign(a[0]);
    const c0 = [a[0] - s * 2.5, a[1], a[2] + 1.5];
    fit(`${side}Shoulder`, (v) => Math.hypot(v[0] - c0[0], v[1] - c0[1], v[2] - c0[2]) < 7.5, [1, 1, 1]);
    fit(`${side}Arm`, ([x, y, z]) => x * s > Math.abs(a[0]) + 2 && x * s < Math.abs(f[0]) && Math.abs(z - (a[2] + f[2]) / 2) < 7 && Math.abs(y - (a[1] + f[1]) / 2) < 7, [0.62, 1.15, 1.15]);
  }
  const prev = old.userData.body ?? {};
  old.userData.body = { ...prev, label: 'female', top_z: r2(top), chin_z: r2(chin), nose_tip: [r2(nose[1]), r2(nose[2])], brow_z: r2(nose[2] + (prev.brow_z - prev.nose_tip?.[1] || 6)),
    head_map: { scale: scale.map(r4), offset: offset.map((x) => Math.round(x * 1000) / 1000) }, colliders: out, ownSkin: true, headScale: 1, source: 'Character_3D_Eyelashes' };
  const info = JSON.stringify({ top, chin, nose, half, front, back, head_map: old.userData.body.head_map, prevTop: prev.top_z, prevChin: prev.chin_z, prevMap: prev.head_map });
  conv.restPose();
  // (the landmarks belong on the glTF scene: gltf.scene.userData.body)
  const sc = new THREE.Scene();
  sc.userData = { body: old.userData.body };
  sc.add(old);
  const ab = await new GLTFExporter().parseAsync(sc, { binary: true, animations: gl.animations, maxTextureSize: 2048, onlyVisible: false });
  let s = ''; const u8 = new Uint8Array(ab); for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  console.warn('EXTRAS ' + info);
  return btoa(s);
};
