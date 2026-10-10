import * as THREE from 'three';

export const HAIR_COLORS = [
  { id: 'black', name: 'Black', hex: '#1d1a19' },
  { id: 'brown', name: 'Brown', hex: '#4b2e1d' },
  { id: 'blonde', name: 'Blonde', hex: '#c9a265' },
  { id: 'red', name: 'Red', hex: '#8f3a1c' },
];

// How one hairstyle sits on the head. Each style keeps its own fit.
export const FIT_DEFAULTS = {
  size: 1, width: 1, height: 1, depth: 1,            // overall and per-axis scale
  up: 0, forward: 0, side: 0,                         // cm along the head's axes
  tilt: 0, turn: 0, roll: 0,                          // degrees
};
export const FIT_KEYS = Object.keys(FIT_DEFAULTS);

export const HAIR_DEFAULTS = {
  style: 'bald',
  color: '#4b2e1d',
  ...FIT_DEFAULTS,                                    // the current style's fit
  weight: 1, stiffness: 0.5, bounce: 0.5,             // physics of the swinging parts
};

// Spheres the ponytail cannot pass through, each carried by a bone. The head's
// is given on the reference head (mesh cm) and moved with the body's head map;
// the others sit at an offset (mesh cm: x side, y back, z up) from their bone.
const HEAD_COLLIDER = { bone: 'Head', centre: [0, 14.4, 149.6], radius: 14 };
const COLLIDERS = [
  { bone: 'Neck', offset: [0, -1.8, 1.7], radius: 4.5 },
  { bone: 'Spine2', offset: [0, -3, -0.7], radius: 10 },
  { bone: 'Spine1', offset: [0, -3.2, -4.6], radius: 6.5 },
  { bone: 'Hips', offset: [0, 3, -9], radius: 11 },
];
// Mesh centimetres (Z up, front -Y) -> world metres (Y up, front +Z).
const meshToWorld = (v) => new THREE.Vector3(v[0], v[2], -v[1]).multiplyScalar(0.01);
const DOWN = new THREE.Vector3(0, -1, 0);
const STEP = 1 / 60;
const MAX_BEND = THREE.MathUtils.degToRad(60); // per bone, away from its rest direction
const TAIL_RADIUS = 0.025; // m, how far the tail's centreline keeps from a collider

const _v = new THREE.Vector3();
const _head = new THREE.Vector3();
const _target = new THREE.Vector3();
const _next = new THREE.Vector3();
const _rest = new THREE.Vector3();
const _id = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
const _wq = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _inv = new THREE.Quaternion();
const DEG = THREE.MathUtils.RAD2DEG;

/**
 * Drives one hairstyle on one character. A hairstyle file (tools/build_hair.py)
 * holds a HairRoot bone and chains Chain<c>_1 … Chain<c>_End for the parts that
 * swing, all in the character's bind pose. HairRoot is moved under the
 * character's Head bone so the hair follows the head; the fit settings move
 * HairRoot, and each chain is a spring simulation.
 */
export class HairRig {
  /**
   * @param gltfScene     the loaded hairstyle file's scene
   * @param bodyMesh      the character's body (for colliders)
   * @param headBone      the character's Head bone
   * @param headBindWorld the Head bone's world matrix in the bind pose
   * @param headMap       world matrix taking the reference head (the one the
   *                      hairstyles were built on) onto this body's head
   * @param headMapCm     the same map in mesh cm: { scale, offset }
   */
  constructor(gltfScene, bodyMesh, headBone, headBindWorld, headMap, headMapCm) {
    gltfScene.updateMatrixWorld(true);
    let mesh = null;
    gltfScene.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
    this.mesh = mesh;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    const bones = mesh.skeleton.bones;
    const byName = (n) => bones.find((b) => b.name === n);
    this.root = byName('HairRoot');
    // Moved onto this body's head, then held as a child of the head.
    const local = headBindWorld.clone().invert().multiply(headMap).multiply(this.root.matrixWorld);
    this.head = headBone;
    headBone.add(this.root);
    local.decompose(this.root.position, this.root.quaternion, this.root.scale);
    this.rest = { position: this.root.position.clone(), quaternion: this.root.quaternion.clone(), scale: this.root.scale.clone() };
    this.links = [];
    for (let c = 1; byName(`Chain${c}_1`); c++) {
      const chain = [];
      for (let k = 1; byName(`Chain${c}_${k}`); k++) chain.push(byName(`Chain${c}_${k}`));
      chain.push(byName(`Chain${c}_End`));
      // Hair is held near the tie: the first bones are stiffer and bend less.
      chain.slice(0, -1).forEach((bone, i) => this.links.push({
        bone, rest: bone.quaternion.clone(), child: chain[i + 1].position.clone(),
        stiffness: [4, 2.2, 1.4][i] ?? 1,
        maxBend: THREE.MathUtils.degToRad([15, 30, 45][i] ?? 60),
        p: new THREE.Vector3(), prev: new THREE.Vector3(),
      }));
    }
    this.settled = false;

    // Colliders: mesh space -> each bone's local space through its inverse
    // bind matrix, so they follow the bone in any pose.
    const skeleton = bodyMesh.skeleton;
    const head = HEAD_COLLIDER.centre.map((v, k) => headMapCm.scale[k] * v + headMapCm.offset[k]);
    const specs = [
      { bone: HEAD_COLLIDER.bone, world: meshToWorld(head), radius: HEAD_COLLIDER.radius * headMapCm.scale[0] },
      ...COLLIDERS.map((c) => {
        const i = skeleton.bones.findIndex((b) => b.name === c.bone);
        const bind = new THREE.Vector3().setFromMatrixPosition(skeleton.boneInverses[i].clone().invert());
        return { bone: c.bone, world: bind.add(meshToWorld(c.offset)), radius: c.radius };
      }),
    ];
    this.colliders = specs.map((c) => {
      const i = skeleton.bones.findIndex((b) => b.name === c.bone);
      const offset = c.world.clone().applyMatrix4(skeleton.boneInverses[i]);
      return { bone: skeleton.bones[i], offset, radius: c.radius, world: new THREE.Vector3(), worldRadius: 0 };
    });
    this.time = 0;
  }

  reset() {
    this.settled = false;
  }

  /** Put this hairstyle on the character (its mesh goes into `scene`). */
  attach(scene) {
    this.head.add(this.root);
    scene.add(this.mesh);
    this.settled = false;
  }

  /** Take this hairstyle off the character. */
  detach() {
    this.root.removeFromParent();
    this.mesh.removeFromParent();
  }

  /**
   * Place HairRoot from the fit settings. HairRoot's own axes are the head's
   * in the bind pose: +X the character's left, -Y forward, +Z up.
   */
  fit(s) {
    _v.set(s.side, -s.forward, s.up).applyQuaternion(this.rest.quaternion);
    this.root.position.copy(this.rest.position).add(_v);
    _euler.set(-s.tilt / DEG, s.roll / DEG, s.turn / DEG, 'XYZ');
    this.root.quaternion.copy(this.rest.quaternion).multiply(_q.setFromEuler(_euler));
    this.root.scale.copy(this.rest.scale).multiply(_v.set(s.width, s.depth, s.height)).multiplyScalar(s.size);
  }

  /** The fit settings that reproduce HairRoot's current transform (after a gizmo drag). */
  readFit(s) {
    _inv.copy(this.rest.quaternion).invert();
    _v.copy(this.root.position).sub(this.rest.position).applyQuaternion(_inv);
    const out = { side: _v.x, forward: -_v.y, up: _v.z };
    _euler.setFromQuaternion(_q.copy(_inv).multiply(this.root.quaternion), 'XYZ');
    Object.assign(out, { tilt: -_euler.x * DEG, roll: _euler.y * DEG, turn: _euler.z * DEG });
    _v.copy(this.root.scale).divide(this.rest.scale).divideScalar(s.size);
    Object.assign(out, { width: _v.x, depth: _v.y, height: _v.z });
    // A drag that starts right on the scale handle's centre can produce wild
    // values; keep everything finite and within sensible limits.
    const limits = { side: [-8, 8], forward: [-10, 10], up: [-10, 20], tilt: [-45, 45], roll: [-45, 45], turn: [-45, 45] };
    for (const [k, v] of Object.entries(out)) {
      if (!Number.isFinite(v)) { out[k] = s[k]; continue; }
      out[k] = k in limits ? THREE.MathUtils.clamp(v, ...limits[k]) : THREE.MathUtils.clamp(v, 0.3, 3);
    }
    return out;
  }

  update(dt, s) {
    this.fit(s);
    this.root.updateMatrixWorld(true);
    for (const c of this.colliders) {
      c.world.copy(c.offset).applyMatrix4(c.bone.matrixWorld);
      c.worldRadius = c.radius * _v.setFromMatrixScale(c.bone.matrixWorld).x;
    }
    // Spring bone (as in VRM): stiffness pushes each tail back along its rest
    // direction, gravity pulls it down, drag takes speed out.
    const drag = 0.5 - 0.42 * s.bounce;
    const stiff = (0.4 + 3.6 * s.stiffness) * STEP;
    const gravity = 0.45 * s.weight * STEP;
    if (!this.links.length) return;
    if (!this.settled) {
      this.solve(0, 0, 0, true);
      this.settled = true;
    }
    this.time = Math.min(this.time + dt, 4 * STEP);
    while (this.time >= STEP) {
      this.time -= STEP;
      this.solve(drag, stiff, gravity, false);
    }
  }

  solve(drag, stiff, gravity, snap) {
    for (const l of this.links) {
      const bone = l.bone;
      bone.quaternion.copy(l.rest);
      bone.updateMatrixWorld(true);
      bone.getWorldPosition(_head);
      _target.copy(l.child).applyMatrix4(bone.matrixWorld);
      const length = _head.distanceTo(_target);
      if (snap || l.p.distanceTo(_target) > 1) {
        l.p.copy(_target);
        l.prev.copy(_target);
        // Spheres this bone starts in or reaches into at rest (a low ponytail
        // at the nape, twin tails tied at the sides of the head): colliding
        // with them would throw it out sideways.
        l.skip = new Set(this.colliders.filter((c) =>
          Math.min(_target.distanceTo(c.world), _head.distanceTo(c.world)) < c.worldRadius + TAIL_RADIUS));
      } else {
        _rest.copy(_target).sub(_head).normalize();
        _next.copy(l.p).sub(l.prev).multiplyScalar(1 - drag).add(l.p)
          .addScaledVector(_rest, stiff * l.stiffness)
          .addScaledVector(DOWN, gravity);
        this.constrain(_next, _head, length, l.skip);
        this.limit(_next, _head, _rest, length, l.maxBend);
        l.prev.copy(l.p);
        l.p.copy(_next);
      }
      // Turn the bone from its rest direction towards the simulated point.
      const from = _v.copy(_target).sub(_head).normalize();
      const to = _next.copy(l.p).sub(_head).normalize();
      _q.setFromUnitVectors(from, to);
      bone.getWorldQuaternion(_wq);
      bone.parent.getWorldQuaternion(_pq).invert();
      bone.quaternion.copy(_pq.multiply(_q.multiply(_wq)));
      bone.updateMatrixWorld(true);
    }
  }

  /** Keep the bone within maxBend of its rest direction. */
  limit(p, head, rest, length, maxBend = MAX_BEND) {
    _v.copy(p).sub(head).normalize();
    _q.setFromUnitVectors(rest, _v);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(_q.w)));
    if (angle > maxBend) {
      _q.copy(_id.identity().slerp(_q, maxBend / angle));
      p.copy(rest).applyQuaternion(_q).multiplyScalar(length).add(head);
    }
  }

  constrain(p, head, length, skip) {
    p.sub(head).setLength(length).add(head);
    for (const c of this.colliders) {
      if (skip?.has(c)) continue;
      const min = c.worldRadius + TAIL_RADIUS;
      _v.copy(p).sub(c.world);
      if (_v.lengthSq() < min * min) {
        p.copy(c.world).add(_v.setLength(min));
        p.sub(head).setLength(length).add(head);
      }
    }
  }
}

export function hairMaterial(hex) {
  const m = new THREE.MeshPhysicalMaterial({ roughness: 0.45, sheen: 0.6, sheenRoughness: 0.4 });
  setHairColor(m, hex);
  return m;
}

export function setHairColor(material, hex) {
  material.color.set(hex);
  material.sheenColor.set(hex).lerp(new THREE.Color(0xffffff), 0.35);
}
