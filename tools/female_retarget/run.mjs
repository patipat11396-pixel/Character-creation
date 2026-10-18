import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const ROOT = path.dirname(new URL(import.meta.url).pathname);
const CC = '/home/user/Character-creation';
const [,, out = 'c.png', clips = 'rest', exportTo = ''] = process.argv;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const ctx = await b.newContext({ viewport: { width: 1200, height: 600 } });
await ctx.route('http://local.test/**', async (route) => { const u = new URL(route.request().url()).pathname; const f = u.startsWith('/cc/') ? path.join(CC, u.slice(4)) : path.join(ROOT, u);
  try { route.fulfill({ body: await readFile(f), contentType: f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream' }); } catch { route.fulfill({ status: 404, body: '' }); } });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 200)); });
await p.goto('http://local.test/view.html'); await p.waitForFunction(() => window.ready, null, { timeout: 120000 });
console.log(await p.evaluate(() => window.convert()));
const url = await p.evaluate(async (clips) => {
  const { THREE, r, scene, cam, conv } = window; scene.add(conv.old); const bx = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.6, 0.2), new THREE.MeshBasicMaterial({ color: 0xff0000 })); bx.position.set(0.8, 0.8, 0); scene.add(bx);
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 600; const cx = canvas.getContext('2d');
  const mixer = new THREE.AnimationMixer(conv.old); const list = clips.split(','); const w = 1200 / list.length;
  list.forEach((spec, i) => { const [name, t, view] = spec.split('@'); mixer.stopAllAction();
    if (name === 'rest') conv.restPose(); else { const c = conv.gl.animations.find(a => a.name === name); mixer.clipAction(c).play(); mixer.setTime(+t || 0); }
    conv.old.updateMatrixWorld(true);
    const hips = conv.old.getObjectByName('Hips').getWorldPosition(new THREE.Vector3());
    const z = view === 'z' ? 0.45 : 1; const ang = view === 'side' ? Math.PI / 2 : view === 'back' ? Math.PI : 0;
    const tgt = view === 'z' ? conv.old.getObjectByName('Head').getWorldPosition(new THREE.Vector3()) : hips.clone().setY(hips.y * 0.95);
    const d = 4.2 * z; cam.position.set(tgt.x + Math.sin(ang) * d, tgt.y, tgt.z + Math.cos(ang) * d); cam.lookAt(tgt); cam.updateMatrixWorld(); cam.updateProjectionMatrix(); r.render(scene, cam); if (i === 0) console.log('cam', cam.position.toArray(), 'tgt', tgt.toArray(), 'fov', cam.fov, cam.aspect, cam.near, cam.far);
    cx.drawImage(r.domElement, (1200 - w) / 2, 0, w, 600, i * w, 0, w, 600); cx.fillText(spec, i * w + 4, 12); });
  return canvas.toDataURL(); }, clips);
await writeFile(path.join(ROOT, out), Buffer.from(url.split(',')[1], 'base64'));
if (exportTo) {
  const b64 = await p.evaluate(() => window.exportGLB());
  await writeFile(exportTo, Buffer.from(b64, 'base64')); console.log('exported', exportTo);
}
console.log(errs.filter(e => !e.includes('THREE.FBXLoader')).slice(0, 6)); await b.close();
