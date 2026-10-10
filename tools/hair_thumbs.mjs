// Pictures of each hairstyle for the menu's Hair tab: models/hair/thumbs/<id>.png,
// the hair alone (body hidden) in light grey on a transparent background; the
// menu tints them to the current hair colour.
// Needs the menu served on http://localhost:8123 and Playwright with Chromium:
//   python3 -m http.server 8123 &   node tools/hair_thumbs.mjs
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const styles = JSON.parse(readFileSync(`${ROOT}models/hair/index.json`, 'utf8'));
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
await page.goto('http://localhost:8123/index.html');
await page.waitForSelector('#loading.hidden', { state: 'attached', timeout: 180000 });
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('#loading.hidden', { state: 'attached', timeout: 180000 });
await page.selectOption('#anim', '');
await page.click('[data-tab="hair"]');
for (const s of styles) {
  await page.click(`[data-style="${s.id}"]`);
  await page.waitForTimeout(s.file ? 4000 : 800);
  await page.evaluate(() => {
    const cc = window.characterCreation;
    const ch = cc.characters[`${cc.state.body}:fixed`];
    ch.root.traverse((o) => { if (o.isMesh) o.visible = false; });     // hair only
    cc.scene.background.set(0xff00ff);                                // keyed out below
    cc.scene.traverse((o) => { if (o.isMesh && o.geometry.type === 'CircleGeometry') o.visible = false; });
    cc.setHairColor('#c8c8c8');
    const b = ch.body;
    const y = (b.chin_z + 0.55 * (b.top_z - b.chin_z)) / 100 - 0.02;
    cc.controls.target.set(0, y, 0);
    cc.camera.position.set(0.55, y + 0.12, 0.75);
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${ROOT}models/hair/thumbs/${s.id}.raw.png`,
    clip: { x: 130, y: 120, width: 520, height: 520 } });
  console.log(s.id);
}
await browser.close();
// Then key out the magenta: python3 tools/hair_thumbs_key.py
