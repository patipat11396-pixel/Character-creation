import * as THREE from 'three';

export const HAIR_COLORS = [
  { id: 'black', name: 'Black', hex: '#1d1a19' },
  { id: 'brown', name: 'Brown', hex: '#4b2e1d' },
  { id: 'blonde', name: 'Blonde', hex: '#c9a265' },
  { id: 'red', name: 'Red', hex: '#8f3a1c' },
];

export const HAIR_DEFAULTS = {
  color: '#4b2e1d',
  size: 1, up: 0, forward: 0, side: 0, tilt: 0,      // fit: scale, cm, cm, cm, degrees
  weight: 1, stiffness: 0.5, bounce: 0.5,             // ponytail physics
};

// Spheres the ponytail cannot pass through, in the body's mesh space (cm),
// each carried by a bone.
const COLLIDERS = [
  { bone: 'Head', centre: [0, 14.4, 149.6], radius: 14 },
  { bone: 'Neck', centre: [0, 16, 132], radius: 4.5 },
  { bone: 'Spine2', centre: [0, 12.5, 120], radius: 10 },
  { bone: 'Spine1', centre: [0, 10, 108], radius: 6.5 },
  { bone: 'Hips', centre: [0, 13, 90], radius: 11 },
];
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
const _tilt = new THREE.Quaternion();
const TILT_AXIS = new THREE.Vector3(1, 0, 0);

/**
 * Drives the hair of one character: the HairRoot bone (size, position, tilt
 * relative to the head) and a spring simulation of the ponytail bone chain.
 */
export class HairRig {
  constructor(hairMesh, bodyMesh) {
    const bones = hairMesh.skeleton.bones;
    const byName = (n) => bones.find((b) => b.name === n);
    this.root = byName('HairRoot');
    this.rest = { position: this.root.position.clone(), quaternion: this.root.quaternion.clone(), scale: this.root.scale.clone() };
    const chain = [];
    for (let i = 1; byName(`HairTail${i}`); i++) chain.push(byName(`HairTail${i}`));
    chain.push(byName('HairTailEnd'));
    this.links = chain.slice(0, -1).map((bone, i) => ({
      bone, rest: bone.quaternion.clone(), child: chain[i + 1].position.clone(),
      p: new THREE.Vector3(), prev: new THREE.Vector3(),
    }));
    this.settled = false;

    // Colliders: mesh space -> each bone's local space through its inverse
    // bind matrix, so they follow the bone in any pose.
    const skeleton = bodyMesh.skeleton;
    this.colliders = COLLIDERS.map((c) => {
      const i = skeleton.bones.findIndex((b) => b.name === c.bone);
      const offset = new THREE.Vector3(...c.centre).applyMatrix4(skeleton.boneInverses[i]);
      return { bone: skeleton.bones[i], offset, radius: c.radius, world: new THREE.Vector3(), worldRadius: 0 };
    });
    this.time = 0;
  }

  reset() {
    this.settled = false;
  }

  /** Place HairRoot from the fit settings: offsets in cm along the head's axes. */
  fit(s) {
    _v.set(s.side, -s.forward, s.up).applyQuaternion(this.rest.quaternion);
    this.root.position.copy(this.rest.position).add(_v);
    this.root.quaternion.copy(this.rest.quaternion).multiply(_tilt.setFromAxisAngle(TILT_AXIS, THREE.MathUtils.degToRad(-s.tilt)));
    this.root.scale.copy(this.rest.scale).multiplyScalar(s.size);
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
      } else {
        _rest.copy(_target).sub(_head).normalize();
        _next.copy(l.p).sub(l.prev).multiplyScalar(1 - drag).add(l.p)
          .addScaledVector(_rest, stiff)
          .addScaledVector(DOWN, gravity);
        this.constrain(_next, _head, length);
        this.limit(_next, _head, _rest, length);
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

  /** Keep the bone within MAX_BEND of its rest direction. */
  limit(p, head, rest, length) {
    _v.copy(p).sub(head).normalize();
    _q.setFromUnitVectors(rest, _v);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(_q.w)));
    if (angle > MAX_BEND) {
      _q.copy(_id.identity().slerp(_q, MAX_BEND / angle));
      p.copy(rest).applyQuaternion(_q).multiplyScalar(length).add(head);
    }
  }

  constrain(p, head, length) {
    p.sub(head).setLength(length).add(head);
    for (const c of this.colliders) {
      _v.copy(p).sub(c.world);
      const min = c.worldRadius + TAIL_RADIUS;
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
