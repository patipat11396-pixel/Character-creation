import * as THREE from 'three';

// Drawn eyes: 10 styles of each part in models/eyes (from tools/slice_eyes.py),
// 400 px squares that line up, composed into one texture shown on the eye
// patches the model carries over each eye recess.
export const EYE_STYLES = 10;
export const EYE_COLORS = [
  { name: 'Brown', hex: '#7a4a26' },
  { name: 'Dark brown', hex: '#3e2617' },
  { name: 'Hazel', hex: '#9a7b2e' },
  { name: 'Green', hex: '#4f8f4c' },
  { name: 'Blue', hex: '#4d84c8' },
  { name: 'Grey', hex: '#8d99a6' },
  { name: 'Amber', hex: '#c98d2a' },
  { name: 'Black', hex: '#231d1a' },
];
export const EYE_DEFAULTS = {
  white: 1, iris: 1, pupil: 1, lash: 1,      // style of each part, 1-10
  color: '#7a4a26', blink: true,
};

const SIZE = 400;
const images = {};

function load(part, n) {
  const key = `${part}_${n}`;
  images[key] ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `models/eyes/${key}.png`;
  });
  return images[key];
}

function layer() {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  return c;
}

export class EyeTexture {
  constructor() {
    this.canvas = layer();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;                // glTF texture coordinates run top-down
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture, transparent: true, alphaTest: 0.03, roughness: 0.4,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.closed = false;
    this.request = 0;
  }

  /** Redraw for settings `s` (EYE_DEFAULTS shape). */
  async draw(s) {
    const request = ++this.request;
    const [white, iris, pupil, lash, closed] = await Promise.all([
      load('white', s.white), load('iris', s.iris), load('pupil', s.pupil),
      load('lash', s.lash), load('closed', s.lash),
    ]);
    if (request !== this.request) return;
    this.parts = { white, iris, pupil, lash, closed, color: s.color };
    this.render();
  }

  setClosed(closed) {
    if (closed === this.closed) return;
    this.closed = closed;
    this.render();
  }

  render() {
    const p = this.parts;
    if (!p) return;
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);
    if (this.closed) {
      ctx.drawImage(p.closed, 0, 0, SIZE, SIZE);
    } else {
      // Iris tinted with the eye colour (the drawings are grey), then the
      // pupil, both kept inside the eye white.
      const inner = layer();
      const ic = inner.getContext('2d');
      ic.drawImage(p.iris, 0, 0, SIZE, SIZE);
      ic.globalCompositeOperation = 'multiply';
      ic.fillStyle = p.color;
      ic.fillRect(0, 0, SIZE, SIZE);
      ic.globalCompositeOperation = 'destination-in';
      ic.drawImage(p.iris, 0, 0, SIZE, SIZE);
      ic.globalCompositeOperation = 'source-over';
      ic.drawImage(p.pupil, 0, 0, SIZE, SIZE);
      ic.globalCompositeOperation = 'destination-in';
      ic.drawImage(p.white, 0, 0, SIZE, SIZE);
      ctx.drawImage(p.white, 0, 0, SIZE, SIZE);
      ctx.drawImage(inner, 0, 0);
      ctx.drawImage(p.lash, 0, 0, SIZE, SIZE);
    }
    this.texture.needsUpdate = true;
  }
}

/** Random blinks: closed for ~0.13 s every 2.5-6 s. */
export class Blinker {
  constructor() {
    this.next = 2 + Math.random() * 3;
    this.until = 0;
    this.time = 0;
  }

  update(dt, enabled) {
    this.time += dt;
    if (!enabled) return false;
    if (this.time >= this.next) {
      this.until = this.time + 0.13;
      this.next = this.time + 2.5 + Math.random() * 3.5;
    }
    return this.time < this.until;
  }
}
