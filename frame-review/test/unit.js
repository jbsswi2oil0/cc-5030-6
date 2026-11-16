'use strict';

/* Node-side unit tests: geometry mapping, frame table parsing, resolution. */
const assert = require('assert');
const path = require('path');
const G = require('../public/shared/geometry.js');
const { probeMedia, frameIndexAtTime, resolveFrame } = require('../server/probe');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok -', name);
  } catch (e) {
    console.error('  FAIL -', name, '\n   ', e.message);
    process.exitCode = 1;
  }
}

console.log('geometry: contain / letterbox');
test('containRect leaves horizontal bars for a 4:3 video in a wide box', () => {
  const fit = G.containRect(320, 240, 800, 300);
  assert.strictEqual(fit.w, 400);
  assert.strictEqual(fit.h, 300);
  assert.strictEqual(fit.x, 200); // 200px black bar on each side
  assert.strictEqual(fit.y, 0);
});

test('containRect leaves vertical bars for a wide video in a tall box', () => {
  const fit = G.containRect(320, 240, 320, 480);
  assert.strictEqual(fit.w, 320);
  assert.strictEqual(fit.h, 240);
  assert.strictEqual(fit.y, 120); // top/bottom bars
});

console.log('geometry: client -> material round trip (no rotation)');
test('click at displayed center maps to material center', () => {
  const rect = { left: 0, top: 0, width: 800, height: 300 };
  const fit = G.containRect(320, 240, 800, 300);
  const m = G.clientToMaterial(400, 150, rect, fit, 0);
  assert.ok(Math.abs(m.xn - 0.5) < 1e-12);
  assert.ok(Math.abs(m.yn - 0.5) < 1e-12);
});

test('click on a letterbox bar clamps to the frame edge', () => {
  const rect = { left: 0, top: 0, width: 800, height: 300 };
  const fit = G.containRect(320, 240, 800, 300);
  const m = G.clientToMaterial(10, 150, rect, fit, 0); // inside left black bar
  assert.strictEqual(m.xn, 0);
  assert.ok(Math.abs(m.yn - 0.5) < 1e-12);
});

test('material -> client -> material is identity', () => {
  const rect = { left: 12, top: 7, width: 640, height: 480 };
  const fit = G.containRect(320, 240, 640, 480);
  for (const [xn, yn] of [[0.1, 0.2], [0.75, 0.33], [0.99, 0.01]]) {
    const c = G.materialToClient(xn, yn, rect, fit, 0);
    const back = G.clientToMaterial(c.x, c.y, rect, fit, 0);
    assert.ok(Math.abs(back.xn - xn) < 1e-12);
    assert.ok(Math.abs(back.yn - yn) < 1e-12);
  }
});

console.log('geometry: rotation 90/180/270 inverses');
test('displayToMaterial is the inverse of materialToDisplay for all rotations', () => {
  for (const r of [0, 90, 180, 270]) {
    for (const [x, y] of [[0, 0], [0.25, 0.75], [1, 1], [0.3, 0.6]]) {
      const d = G.materialToDisplay(x, y, r);
      const m = G.displayToMaterial(d.xn, d.yn, r);
      assert.ok(Math.abs(m.xn - x) < 1e-12, `r=${r} x`);
      assert.ok(Math.abs(m.yn - y) < 1e-12, `r=${r} y`);
    }
  }
});

test('90° rotation swaps axes: material top-left displays at top-right', () => {
  const d = G.materialToDisplay(0, 0, 90);
  assert.deepStrictEqual(d, { xn: 1, yn: 0 });
  const m = G.displayToMaterial(1, 0, 90);
  assert.deepStrictEqual(m, { xn: 0, yn: 0 });
});

test('rotated client click round trip through contain rect', () => {
  // coded 240x320 with rotation 90 -> displayed 320x240
  const rect = { left: 0, top: 0, width: 800, height: 300 };
  const disp = G.displaySize(240, 320, 90);
  assert.deepStrictEqual(disp, { width: 320, height: 240 });
  const fit = G.containRect(disp.width, disp.height, 800, 300);
  const c = G.materialToClient(0.5, 0.5, rect, fit, 90);
  const back = G.clientToMaterial(c.x, c.y, rect, fit, 90);
  assert.ok(Math.abs(back.xn - 0.5) < 1e-12);
  assert.ok(Math.abs(back.yn - 0.5) < 1e-12);
});

test('clientRectToMaterial orders corners regardless of drag direction', () => {
  const rect = { left: 0, top: 0, width: 320, height: 240 };
  const fit = { x: 0, y: 0, w: 320, h: 240, scale: 1 };
  const r1 = G.clientRectToMaterial({ x: 200, y: 100 }, { x: 50, y: 200 }, rect, fit, 0);
  assert.ok(r1.xn < r1.xn + r1.wn);
  assert.strictEqual(r1.xn, 50 / 320);
  assert.strictEqual(r1.yn, 100 / 240);
  assert.strictEqual(r1.wn, 150 / 320);
  assert.strictEqual(r1.hn, 100 / 240);
});

console.log('probe: frame tables');
const samples = path.join(__dirname, '..', 'data', 'samples');

test('CFR clip reports 60 frames at 30fps with rational step', () => {
  const t = probeMedia(path.join(samples, 'cfr-frame-numbers.mp4'));
  assert.strictEqual(t.frameCount, 60);
  assert.strictEqual(t.isCfr, true);
  assert.strictEqual(t.frameRate, 30);
  assert.strictEqual(t.step.num / t.step.den, 1 / 30);
  assert.ok(Math.abs(t.frames[30].time - 1.0) < 1e-6);
});

test('VFR clip keeps real irregular timestamps and is never treated as CFR', () => {
  const t = probeMedia(path.join(samples, 'vfr-irregular.mp4'));
  assert.strictEqual(t.isCfr, false);
  assert.strictEqual(t.frameCount, 60);
  const d1 = t.frames[1].time - t.frames[0].time;
  const d2 = t.frames[2].time - t.frames[1].time;
  assert.ok(Math.abs(d1 - 0.08) < 1e-6);
  assert.ok(Math.abs(d2 - 0.04) < 1e-6);
  assert.notStrictEqual(d1, d2);
});

test('rotated clip exposes 90° metadata with portrait coded size', () => {
  const t = probeMedia(path.join(samples, 'rotated-metadata.mp4'));
  assert.strictEqual(t.rotation, 90);
  assert.strictEqual(t.codedWidth, 240);
  assert.strictEqual(t.codedHeight, 320);
});

console.log('probe: frame lookup / cross-version resolution');
test('frameIndexAtTime uses binary search on PTS, not rounded seconds', () => {
  const t = probeMedia(path.join(samples, 'vfr-irregular.mp4'));
  assert.strictEqual(frameIndexAtTime(t, 0), 0);
  assert.strictEqual(frameIndexAtTime(t, 0.079), 0); // just before frame 1's 0.08
  assert.strictEqual(frameIndexAtTime(t, 0.081), 1);
});

test('resolveFrame finds exact PTS match then nearest within half step', () => {
  const t = probeMedia(path.join(samples, 'cfr-frame-numbers.mp4'));
  assert.strictEqual(resolveFrame(t, 25, t.frames[25].ptsTime), 25);
  // drifted index, but same pts still resolves to the real frame
  assert.strictEqual(resolveFrame(t, 99, t.frames[25].ptsTime), 25);
  // pts far outside the timeline cannot be resolved
  assert.strictEqual(resolveFrame(t, 0, 999), null);
});

console.log(`\n${passed} unit assertions passed`);
if (process.exitCode) process.exit(process.exitCode);
