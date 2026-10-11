import * as THREE from 'three';

// Cloth simulation for robes: a coarse particle net (built by
// tools/process_character.py and stored in the primitive's extras) moved by
// Verlet integration in world space, held to the skinned pose by each
// particle's pin (the shoulders follow the body, the skirt swings), kept in
// shape by distance constraints and pushed out of capsules round the arms,
// legs and trunk. The render mesh follows the net on the GPU: every vertex
// adds the weighted offsets (simulated minus skinned) of up to 4 particles.

const CLOTH_GRAVITY = new THREE.Vector3(0, -9.8, 0);
const CLOTH_STEP = 1 / 60;
const CLOTH_ITERATIONS = 5;
const CLOTH_DAMPING = 0.985;
const CLOTH_SHAPE = 0.035;        // pull of a free particle back to its skinned place, per step
const CLOTH_MARGIN = 0.012;       // gap kept from the body (m)
const CLOTH_SEGMENTS = [
  ['LeftArm', 'LeftForeArm'], ['LeftForeArm', 'LeftHand'], ['LeftHand', 'LeftHand_end'],
  ['RightArm', 'RightForeArm'], ['RightForeArm', 'RightHand'], ['RightHand', 'RightHand_end'],
  ['LeftUpLeg', 'LeftLeg'], ['LeftLeg', 'LeftFoot'], ['RightUpLeg', 'RightLeg'], ['RightLeg', 'RightFoot'],
  ['Hips', 'Spine1'], ['Spine1', 'Neck'],
];
// Body points that set each capsule's radius: those whose strongest bone is one of these.
const CLOTH_SEGMENT_BONES = [
  ['LeftArm'], ['LeftForeArm'], ['LeftHand'], ['RightArm'], ['RightForeArm'], ['RightHand'],
  ['LeftUpLeg'], ['LeftLeg'], ['RightUpLeg'], ['RightLeg'], ['Hips', 'Spine'], ['Spine1', 'Spine2'],
];

const _cv = new THREE.Vector3();
const _ca = new THREE.Vector3();
const _cb = new THREE.Vector3();
const _cm = new THREE.Matrix4();

function clothClosest(p, a, b, out) {
  _cv.subVectors(b, a);
  const t = THREE.MathUtils.clamp(_ca.subVectors(p, a).dot(_cv) / Math.max(_cv.lengthSq(), 1e-12), 0, 1);
  return out.copy(a).addScaledVector(_cv, t);
}

/** Capsules round the body's limbs and trunk, radii measured on the skinned body in its current (bind) pose. */
export function bodyCapsules(bodyMesh) {
  const bones = bodyMesh.skeleton.bones;
  const byName = Object.fromEntries(bones.map((b, i) => [b.name, i]));
  const g = bodyMesh.geometry;
  const pos = g.attributes.position;
  const si = g.attributes.skinIndex;
  const sw = g.attributes.skinWeight;
  bodyMesh.updateMatrixWorld(true);
  const pts = CLOTH_SEGMENTS.map(() => []);
  const ends = CLOTH_SEGMENTS.map(([a, b]) => [bones[byName[a]], bones[byName[b]]]);
  const wa = new THREE.Vector3();
  const wb = new THREE.Vector3();
  for (let i = 0; i < pos.count; i += 5) {
    let best = 0;
    for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, best)) best = k;
    const name = bones[si.getComponent(i, best)]?.name;
    const s = CLOTH_SEGMENT_BONES.findIndex((names) => names.includes(name));
    if (s < 0 || !ends[s][0] || !ends[s][1]) continue;
    const p = bodyMesh.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(pos, i)).applyMatrix4(bodyMesh.matrixWorld);
    ends[s][0].getWorldPosition(wa);
    ends[s][1].getWorldPosition(wb);
    pts[s].push(p.distanceTo(clothClosest(p, wa, wb, _cb)));
  }
  return CLOTH_SEGMENTS.map(([a, b], s) => {
    const d = pts[s].sort((x, y) => x - y);
    // The trunk is far from round: its capsules take the outer points.
    const q = s >= CLOTH_SEGMENTS.length - 2 ? 0.9 : 0.6;
    const r = d.length ? d[Math.floor(d.length * q)] : 0.03;
    return { a: ends[s][0], b: ends[s][1], radius: r, pa: new THREE.Vector3(), pb: new THREE.Vector3() };
  }).filter((c) => c.a && c.b);
}

export class ClothSim {
  /**
   * @param mesh       the robe's SkinnedMesh (geometry.userData.physics from the build)
   * @param capsules   bodyCapsules() of the body wearing it
   * @param fit        { centre, scale, offset } uniforms' values: the fit the shader applies before skinning
   */
  constructor(mesh, capsules, fit) {
    const ph = mesh.geometry.userData.physics;
    this.mesh = mesh;
    this.capsules = capsules;
    this.armCapsules = capsules.filter((c) => /Arm|Hand/.test(c.a.name)).length;
    this.fit = fit;
    this.ids = Int32Array.from(ph.particles);
    this.edges = Int32Array.from(ph.edges);
    this.bend = Int32Array.from(ph.bend);
    this.pin = Float32Array.from(ph.pin);
    const n = this.ids.length;
    this.n = n;
    this.x = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.target = new Float32Array(n * 3);
    this.restEdge = new Float32Array(this.edges.length / 2);
    this.restBend = new Float32Array(this.bend.length / 2);
    this.ready = false;
    this.restScale = null;
    // Offsets for the shader: one texel per particle.
    this.width = 64;
    const h = Math.ceil(n / this.width);
    this.data = new Float32Array(this.width * h * 4);
    this.texture = new THREE.DataTexture(this.data, this.width, h, THREE.RGBAFormat, THREE.FloatType);
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.needsUpdate = true;
  }

  /** Skinned (unsimulated) world position of every particle. */
  computeTargets() {
    const pos = this.mesh.geometry.attributes.position;
    const { centre, scale, offset } = this.fit;
    const t = this.target;
    for (let i = 0; i < this.n; i++) {
      _cv.fromBufferAttribute(pos, this.ids[i]).sub(centre).multiply(scale).add(centre).add(offset);
      this.mesh.applyBoneTransform(this.ids[i], _cv).applyMatrix4(this.mesh.matrixWorld);
      t[i * 3] = _cv.x; t[i * 3 + 1] = _cv.y; t[i * 3 + 2] = _cv.z;
    }
  }

  reset() {
    this.computeTargets();
    this.x.set(this.target);
    this.prev.set(this.target);
    const x = this.x;
    const len = (a, b) => Math.hypot(x[a * 3] - x[b * 3], x[a * 3 + 1] - x[b * 3 + 1], x[a * 3 + 2] - x[b * 3 + 2]);
    for (let e = 0; e < this.restEdge.length; e++) this.restEdge[e] = len(this.edges[2 * e], this.edges[2 * e + 1]);
    for (let e = 0; e < this.restBend.length; e++) this.restBend[e] = len(this.bend[2 * e], this.bend[2 * e + 1]);
    this.restKey = this.fitKey();
    this.ready = true;
  }

  fitKey() {
    const { scale, offset } = this.fit;
    return [scale.x, scale.y, scale.z, offset.x, offset.y, offset.z].join(',');
  }

  constrain(pairs, rest, stiffness, compress) {
    const x = this.x;
    const pin = this.pin;
    for (let e = 0; e < rest.length; e++) {
      const a = pairs[2 * e] * 3;
      const b = pairs[2 * e + 1] * 3;
      const dx = x[b] - x[a], dy = x[b + 1] - x[a + 1], dz = x[b + 2] - x[a + 2];
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 1e-18) continue;
      const d = Math.sqrt(d2);
      let diff = (d - rest[e]) / d;
      if (diff < 0) diff *= compress;
      const wa = 1 - pin[pairs[2 * e]];
      const wb = 1 - pin[pairs[2 * e + 1]];
      const w = wa + wb;
      if (w < 1e-6) continue;
      const k = stiffness * diff / w;
      x[a] += dx * k * wa; x[a + 1] += dy * k * wa; x[a + 2] += dz * k * wa;
      x[b] -= dx * k * wb; x[b + 1] -= dy * k * wb; x[b + 2] -= dz * k * wb;
    }
  }

  collide() {
    const x = this.x;
    const caps = this.capsules;
    // Plain numbers in the inner loop (this runs for every particle and capsule).
    const cs = this.capsData ??= new Float32Array(caps.length * 7);
    for (let c = 0; c < caps.length; c++) {
      caps[c].a.getWorldPosition(caps[c].pa);
      caps[c].b.getWorldPosition(caps[c].pb);
      const o = c * 7;
      cs[o] = caps[c].pa.x; cs[o + 1] = caps[c].pa.y; cs[o + 2] = caps[c].pa.z;
      cs[o + 3] = caps[c].pb.x - caps[c].pa.x; cs[o + 4] = caps[c].pb.y - caps[c].pa.y; cs[o + 5] = caps[c].pb.z - caps[c].pa.z;
      cs[o + 6] = caps[c].radius + CLOTH_MARGIN;
    }
    // The arms (the first 6 capsules) push every particle, the pinned
    // shoulders too; the legs and trunk only the free ones.
    const armEnd = this.armCapsules * 7;
    for (let i = 0; i < this.n; i++) {
      const pinned = this.pin[i] > 0.97;
      const j = i * 3;
      let px = x[j], py = x[j + 1], pz = x[j + 2];
      for (let o = 0; o < (pinned ? armEnd : cs.length); o += 7) {
        const ax = cs[o], ay = cs[o + 1], az = cs[o + 2], dx = cs[o + 3], dy = cs[o + 4], dz = cs[o + 5], r = cs[o + 6];
        const ll = dx * dx + dy * dy + dz * dz;
        let t = ((px - ax) * dx + (py - ay) * dy + (pz - az) * dz) / (ll > 1e-12 ? ll : 1e-12);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - (ax + dx * t), qy = py - (ay + dy * t), qz = pz - (az + dz * t);
        const d2 = qx * qx + qy * qy + qz * qz;
        if (d2 < r * r && d2 > 1e-12) {
          const d = Math.sqrt(d2), k = (r - d) / d;
          px += qx * k; py += qy * k; pz += qz * k;
        }
      }
      x[j] = px; x[j + 1] = py; x[j + 2] = pz;
    }
  }

  update(dt) {
    if (!(dt > 0)) return;
    this.mesh.updateMatrixWorld(true);
    if (!this.ready || this.restKey !== this.fitKey()) this.reset();
    this.computeTargets();
    const { x, prev, target, pin } = this;
    // A big jump (body switch, a new clip snapping the pose far away): start again.
    if (Math.hypot(x[0] - target[0], x[1] - target[1], x[2] - target[2]) > 0.6) this.reset();
    const steps = Math.min(3, Math.max(1, Math.round(dt / CLOTH_STEP)));
    const h = Math.min(dt, 0.05) / steps;
    const g = CLOTH_GRAVITY.y * h * h;
    for (let s = 0; s < steps; s++) {
      for (let i = 0; i < this.n; i++) {
        const j = i * 3;
        const p = pin[i];
        for (let k = 0; k < 3; k++) {
          const cur = x[j + k];
          let nx = cur + (cur - prev[j + k]) * CLOTH_DAMPING + (k === 1 ? g : 0);
          nx += (target[j + k] - nx) * (p + (1 - p) * CLOTH_SHAPE);
          prev[j + k] = cur;
          x[j + k] = nx;
        }
      }
      for (let it = 0; it < CLOTH_ITERATIONS; it++) {
        this.constrain(this.edges, this.restEdge, 1.0, 0.3);
        if (it === 0 || it === CLOTH_ITERATIONS - 1) this.constrain(this.bend, this.restBend, 0.25, 0.05);
        if (it >= CLOTH_ITERATIONS - 2) this.collide();
      }
    }
    // Offsets for the shader, in the mesh's own (pre-model-matrix) space.
    _cm.copy(this.mesh.matrixWorld).invert();
    const e = _cm.elements;
    for (let i = 0; i < this.n; i++) {
      const dx = x[i * 3] - target[i * 3], dy = x[i * 3 + 1] - target[i * 3 + 1], dz = x[i * 3 + 2] - target[i * 3 + 2];
      this.data[i * 4] = e[0] * dx + e[4] * dy + e[8] * dz;
      this.data[i * 4 + 1] = e[1] * dx + e[5] * dy + e[9] * dz;
      this.data[i * 4 + 2] = e[2] * dx + e[6] * dy + e[10] * dz;
    }
    this.texture.needsUpdate = true;
  }
}

/** The shader lines that move a robe vertex by its particles' offsets (after skinning). */
export const CLOTH_VERTEX = {
  common: 'attribute vec4 _proxy_j;\nattribute vec4 _proxy_w;\nuniform sampler2D clothOffsets;\nuniform int clothWidth;',
  skinning: `{
    vec3 off = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      int j = int(_proxy_j[k] + 0.5);
      off += _proxy_w[k] * texelFetch(clothOffsets, ivec2(j % clothWidth, j / clothWidth), 0).xyz;
    }
    transformed += off;
  }`,
};
