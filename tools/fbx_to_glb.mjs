// Convert the hair FBX to a plain GLB (positions and indices only) so the
// Python pipeline can read it. Needs the `three` npm package:
//   npm i three@0.170.0 && node tools/fbx_to_glb.mjs models/source/hair.fbx models/source/hair.glb
import fs from 'fs';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

globalThis.self = globalThis;
const [src, dst] = process.argv.slice(2);
const buf = fs.readFileSync(src);
const root = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
root.updateMatrixWorld(true);

const positions = [];
root.traverse((o) => {
  if (!o.isMesh) return;
  const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
  const p = g.attributes.position.array;
  const idx = g.index ? g.index.array : null;
  const n = idx ? idx.length : p.length / 3;
  for (let i = 0; i < n; i++) {
    const k = idx ? idx[i] : i;
    positions.push(p[3 * k], p[3 * k + 1], p[3 * k + 2]);
  }
});

// Triangle soup -> GLB with one non-indexed primitive (welded later in Python).
const pos = new Float32Array(positions);
const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < pos.length; i += 3) {
  for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], pos[i + k]); max[k] = Math.max(max[k], pos[i + k]); }
}
const gltf = {
  asset: { version: '2.0', generator: 'Character-creation tools/fbx_to_glb.mjs' },
  scenes: [{ nodes: [0] }], scene: 0, nodes: [{ mesh: 0, name: 'Hair' }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  buffers: [{ byteLength: pos.byteLength }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }],
  accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3', min, max }],
};
let json = Buffer.from(JSON.stringify(gltf));
json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
const bin = Buffer.from(pos.buffer);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const chunk = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.write(type, 4, 'ascii'); return b; };
fs.writeFileSync(dst, Buffer.concat([header, chunk(json.length, 'JSON'), json, chunk(bin.length, 'BIN\0'), bin]));
console.log(`wrote ${dst}: ${pos.length / 9} triangles`);
