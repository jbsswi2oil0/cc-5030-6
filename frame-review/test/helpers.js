'use strict';

const fs = require('fs');
const path = require('path');

const SAMPLES = path.join(__dirname, '..', 'data', 'samples');

async function uploadClip(page, file, uploadName) {
  await page.setInputFiles('#fileInput', {
    name: uploadName || path.basename(file),
    mimeType: 'video/mp4',
    buffer: fs.readFileSync(file)
  });
  await page.click('#uploadForm button[type=submit]');
  // wait until the engine reports a verified frame and overlay unlocks
  await page.waitForSelector('#seekState.ready', { timeout: 30000 });
  await page.waitForSelector('#waitOverlay', { state: 'hidden', timeout: 15000 });
}

async function gotoFrame(page, n) {
  await page.fill('#frameInput', String(n));
  await page.click('#btnGo');
  await page.waitForFunction(
    (target) => {
      const el = document.querySelector('#frameInfo b');
      return el && el.textContent === String(target);
    },
    n,
    { timeout: 15000 }
  );
}

async function currentVerifiedFrame(page) {
  return page.evaluate(() => {
    const el = document.querySelector('#frameInfo b');
    return el ? Number(el.textContent) : null;
  });
}

async function currentPts(page) {
  return page.evaluate(() => {
    const m = document.getElementById('frameInfo').textContent.match(/绝对PTS\s*(-?[\d.]+)/);
    return m ? Number(m[1]) : null;
  });
}

async function drawRegion(page, fromRel, toRel) {
  // The added anchor panel makes the page taller than a short viewport; a
  // gotoFrame fill can scroll the video partly out of view. Scroll it into
  // view first so pointer coordinates map to the real frame box.
  await page.locator('#video').scrollIntoViewIfNeeded();
  // Ensure the overlay canvas has re-aligned to the current video content
  // box before issuing pointer events (ResizeObserver settles a frame later).
  await page.waitForFunction(() => {
    const v = document.getElementById('video').getBoundingClientRect();
    const c = document.getElementById('overlay').getBoundingClientRect();
    return Math.abs(v.left - c.left) < 1.5 && Math.abs(v.top - c.top) < 1.5 &&
      Math.abs(v.width - c.width) < 1.5 && Math.abs(v.height - c.height) < 1.5;
  }, { timeout: 5000 });

  // The POST is issued on pointerup; without waiting for it, a caller that
  // reads the annotation list immediately can observe the previous write.
  const cid = await currentContentId(page);
  const before = cid ? (await annotationsFor(page, cid)).length : 0;

  const box = await page.locator('#video').boundingBox();
  if (!box || box.y < 0 || box.y + box.height > page.viewportSize().height) {
    await page.locator('#video').evaluate((el) => el.scrollIntoView({ block: 'center' }));
  }
  const freshBox = await page.locator('#video').boundingBox();
  const b = freshBox && freshBox.y >= 0 ? freshBox : box;
  await page.mouse.move(b.x + b.width * fromRel[0], b.y + b.height * fromRel[1]);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * toRel[0], b.y + b.height * toRel[1], { steps: 4 });
  await page.mouse.up();

  if (cid) {
    await page.waitForFunction(
      async ({ cid, before }) => {
        const r = await fetch(`/api/media/${cid}/annotations`);
        const j = await r.json();
        return (j.annotations || []).length > before;
      },
      { cid, before },
      { timeout: 10000 }
    );
  }
}

async function lastAnnotation(page, contentId) {
  return page.evaluate(async (cid) => {
    const r = await fetch(cid ? `/api/media/${cid}/annotations` : '/api/annotations');
    const all = (await r.json()).annotations || [];
    return all[all.length - 1];
  }, contentId || null);
}

async function annotationsFor(page, contentId) {
  return page.evaluate(async (cid) => {
    const r = await fetch(`/api/media/${cid}/annotations`);
    const j = await r.json();
    return j.annotations || [];
  }, contentId);
}

async function setAuthor(page, name) {
  // fill fires input+change, but a pending poll/render can rewrite the field
  // from state right after. Set the value, fire change, then verify the app
  // actually adopted it before the caller writes an annotation.
  await page.fill('#authorInput', name);
  await page.dispatchEvent('#authorInput', 'change');
  await page.waitForFunction(
    (expected) => document.getElementById('authorInput').value === expected,
    name,
    { timeout: 5000 }
  );
}

async function currentContentId(page) {
  return page.evaluate(() => {
    // metaBox shows a 16-char truncated id; the full id lives in the select value
    const sel = document.getElementById('mediaSelect');
    return sel && sel.value ? sel.value : null;
  });
}

async function clickAndWaitFrame(page, selector, expectedFrame) {
  await page.click(selector);
  await page.waitForFunction(
    (target) => {
      const el = document.querySelector('#frameInfo b');
      return el && el.textContent === String(target);
    },
    expectedFrame,
    { timeout: 15000 }
  );
}

async function setViewportAndReload(page, size) {
  await page.setViewportSize(size);
  await page.waitForTimeout(300);
}

module.exports = {
  SAMPLES,
  uploadClip,
  gotoFrame,
  currentVerifiedFrame,
  currentPts,
  drawRegion,
  lastAnnotation,
  annotationsFor,
  currentContentId,
  setAuthor,
  setViewportAndReload,
  clickAndWaitFrame
};
