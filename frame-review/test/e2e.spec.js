// @ts-check
const { test, expect, chromium, request } = require('@playwright/test');
const path = require('path');
const H = require('./helpers');

const CFR = path.join(H.SAMPLES, 'cfr-frame-numbers.mp4');
const VFR = path.join(H.SAMPLES, 'vfr-irregular.mp4');
const ROT = path.join(H.SAMPLES, 'rotated-metadata.mp4');

test.beforeAll(async () => {
  const ctx = await request.newContext({ baseURL: 'http://localhost:8080' });
  await ctx.post('/api/test/reset');
  await ctx.dispose();
});

test.beforeEach(async ({ page, request }) => {
  // Each test starts from an empty store: content identity is a hash of the
  // bytes, so reusing the same sample file across tests would otherwise share
  // annotations and version histories.
  await request.post('/api/test/reset');
  await page.goto('/');
});

test.describe('帧精确定位（帧号视频）', () => {
  test('跳转到指定帧后确认的是帧表中的实际帧，而不是四舍五入的小数秒', async ({ page }) => {
    await H.uploadClip(page, CFR, 'cfr-frame-numbers.mp4');
    // frame 0 initially
    expect(await H.currentVerifiedFrame(page)).toBe(0);

    for (const n of [1, 29, 30, 31, 45, 59]) {
      await H.gotoFrame(page, n);
      expect(await H.currentVerifiedFrame(page)).toBe(n);
    }

    // The displayed reference currentTime must lie inside frame 30's actual
    // PTS window, proving PTS-window verification rather than a decimal-second
    // assumption. The window comes from the authoritative frame table because
    // this sample's first PTS is not zero.
    await H.gotoFrame(page, 30);
    const table = await page.evaluate(async () => (await (await fetch('/api/media')).json()).media);
    const cfr = table.find((m) => m.frameTable.isCfr === true && m.frameTable.frameCount === 60);
    const f30 = cfr.frameTable.frames[30];
    const f31 = cfr.frameTable.frames[31];
    const info = await page.textContent('#frameInfo');
    const cur = Number(info.match(/currentTime=([\d.]+)/)[1]);
    expect(cur).toBeGreaterThanOrEqual(f30.ptsTime - 0.008);
    expect(cur).toBeLessThan(f31.ptsTime - 0.008);
  });

  test('逐帧步进每次恰好移动一帧（CFR 与 VFR）', async ({ page }) => {
    await H.uploadClip(page, CFR);
    await H.gotoFrame(page, 10);
    await H.clickAndWaitFrame(page, '#btnNext', 11);
    expect(await H.currentVerifiedFrame(page)).toBe(11);
    await H.clickAndWaitFrame(page, '#btnPrev', 10);
    expect(await H.currentVerifiedFrame(page)).toBe(10);

    await page.goto('/');
    await H.uploadClip(page, VFR, 'vfr-irregular.mp4');
    await H.gotoFrame(page, 5);
    await H.clickAndWaitFrame(page, '#btnNext', 6);
    expect(await H.currentVerifiedFrame(page)).toBe(6);
    const pts6 = await H.currentPts(page);
    // frame 6 pts in the VFR clip: cumulative irregular steps (0.08/0.04…)
    const table = await page.evaluate(async () => (await (await fetch('/api/media')).json()).media);
    const vfr = table.find((m) => m.frameTable.isCfr === false);
    const expected = vfr.frameTable.frames[6].ptsTime;
    expect(Math.abs(pts6 - expected)).toBeLessThan(1e-6);
  });
});

test.describe('VFR 使用实际时间戳', () => {
  test('VFR 素材按真实 PTS 定位，不规则步进下仍命中正确帧号', async ({ page }) => {
    await H.uploadClip(page, VFR, 'vfr-irregular.mp4');
    for (const n of [0, 1, 2, 10, 30, 59]) {
      await H.gotoFrame(page, n);
      expect(await H.currentVerifiedFrame(page)).toBe(n);
    }

    // Pull the authoritative frame table and confirm the on-screen pts matches
    // the real (irregular) timestamp rather than an assumed 30fps grid.
    const media = await page.evaluate(async () => (await (await fetch('/api/media')).json()).media);
    const vfr = media.find((m) => m.frameTable.isCfr === false);
    const f0 = vfr.frameTable.frames[0];
    const f1 = vfr.frameTable.frames[1];
    const f2 = vfr.frameTable.frames[2];
    expect(f1.ptsTime - f0.ptsTime).not.toBeCloseTo(1 / 30, 2); // genuinely VFR

    await H.gotoFrame(page, 1);
    expect(await H.currentPts(page)).toBeCloseTo(f1.ptsTime, 6);
    await H.gotoFrame(page, 2);
    expect(await H.currentPts(page)).toBeCloseTo(f2.ptsTime, 6);
  });
});

test.describe('区域坐标：缩放、留黑边、旋转反算', () => {
  test('不同窗口尺寸下框选同一素材区域，归一化坐标一致', async ({ page }) => {
    await H.uploadClip(page, CFR, `geo-${Date.now()}.mp4`);
    await H.gotoFrame(page, 12);
    const cid = await H.currentContentId(page);

    // Wide window -> heavy horizontal letterbox for 4:3 video
    await page.setViewportSize({ width: 1280, height: 520 });
    await H.drawRegion(page, [0.42, 0.45], [0.62, 0.75]);
    const a1 = await H.lastAnnotation(page, cid);

    // Narrow/tall window -> vertical bars, very different CSS mapping
    await page.setViewportSize({ width: 480, height: 900 });
    await H.gotoFrame(page, 12);
    await H.drawRegion(page, [0.42, 0.45], [0.62, 0.75]);
    const a2 = await H.lastAnnotation(page, cid);

    expect(a2.frameIndex).toBe(a1.frameIndex);
    expect(Math.abs(a2.region.xn - a1.region.xn)).toBeLessThan(0.02);
    expect(Math.abs(a2.region.yn - a1.region.yn)).toBeLessThan(0.02);
    expect(Math.abs(a2.region.wn - a1.region.wn)).toBeLessThan(0.02);
    expect(Math.abs(a2.region.hn - a1.region.hn)).toBeLessThan(0.02);

    // And the stored coords correspond to the intended ~0.42..0.62 material band
    expect(a2.region.xn).toBeGreaterThan(0.38);
    expect(a2.region.xn).toBeLessThan(0.46);
  });

  test('点击落在留黑边上会被夹到画面边缘而不是产生越界坐标', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 520 });
    await H.uploadClip(page, CFR, `bar-${Date.now()}.mp4`);
    await H.gotoFrame(page, 3);
    const cid = await H.currentContentId(page);
    // far left = inside the black bar
    await H.drawRegion(page, [0.02, 0.5], [0.12, 0.6]);
    const a = await H.lastAnnotation(page, cid);
    expect(a.region.xn).toBeGreaterThanOrEqual(0);
    expect(a.region.xn).toBeLessThan(0.05);
    expect(a.region.xn + a.region.wn).toBeLessThanOrEqual(1);
    expect(a.region.yn).toBeGreaterThanOrEqual(0);
    expect(a.region.yn + a.region.hn).toBeLessThanOrEqual(1);
  });

  test('90°旋转素材：客户端拖拽坐标被反算到旋转前的素材坐标，往返一致', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await H.uploadClip(page, ROT, 'rotated-metadata.mp4');
    expect(await page.textContent('#metaBox')).toContain('旋转元数据 90°');
    const cid = await H.currentContentId(page);
    await H.gotoFrame(page, 7);

    await H.drawRegion(page, [0.3, 0.3], [0.55, 0.6]);
    const a = await H.lastAnnotation(page, cid);
    expect(a.frameIndex).toBe(7);

    // Region stored against the coded (pre-rotation) 240x320 frame.
    for (const k of ['xn', 'yn', 'wn', 'hn']) {
      expect(a.region[k]).toBeGreaterThanOrEqual(0);
      expect(a.region[k]).toBeLessThanOrEqual(1);
    }
    expect(a.region.wn).toBeGreaterThan(0.05);
    expect(a.region.hn).toBeGreaterThan(0.05);

    // The stored material region must equal the shared geometry module's
    // inverse-rotation mapping of the same client drag. Both the app and this
    // reference use absolute viewport client coords; clientToMaterial subtracts
    // the element rect internally.
    const expected = await page.evaluate(() => {
      const G = window.FrameGeometry;
      const video = document.getElementById('video');
      const rect = video.getBoundingClientRect();
      const meta = document.getElementById('metaBox').textContent;
      const m = meta.match(/(\d+)×(\d+)/);
      const rot = Number(meta.match(/旋转元数据 (\d+)/)[1]);
      const disp = G.displaySize(Number(m[1]), Number(m[2]), rot);
      const fit = G.containRect(disp.width, disp.height, rect.width, rect.height);
      const p1 = { x: rect.left + rect.width * 0.3, y: rect.top + rect.height * 0.3 };
      const p2 = { x: rect.left + rect.width * 0.55, y: rect.top + rect.height * 0.6 };
      const region = G.clientRectToMaterial(p1, p2, rect, fit, rot);
      return { region, rot, dispW: disp.width, dispH: disp.height };
    });
    expect(expected.rot).toBe(90);
    expect(expected.dispW).toBe(320);
    expect(expected.dispH).toBe(240);
    expect(Math.abs(a.region.xn - expected.region.xn)).toBeLessThan(0.01);
    expect(Math.abs(a.region.yn - expected.region.yn)).toBeLessThan(0.01);
    expect(Math.abs(a.region.wn - expected.region.wn)).toBeLessThan(0.01);
    expect(Math.abs(a.region.hn - expected.region.hn)).toBeLessThan(0.01);

    // Relocating via the annotation card lands back on frame 7.
    await H.gotoFrame(page, 20);
    await page.locator('.ann', { hasText: '帧 7' }).locator('.locate').click();
    await page.waitForFunction(() => {
      const el = document.querySelector('#frameInfo b');
      return el && el.textContent === '7';
    });
    expect(await page.locator('#overlay').isVisible()).toBe(true);
  });
});

test.describe('等待状态：旧帧不能被当作新帧标注', () => {
  test('引擎处于 seeking 时标注被锁定，就绪后才放行', async ({ page }) => {
    await H.uploadClip(page, CFR);
    await H.gotoFrame(page, 5);
    const cid = await H.currentContentId(page);
    const before = (await H.annotationsFor(page, cid)).length;

    // Start a real seek and, while the engine reports waiting, dispatch a
    // pointer drag directly on the overlay. The guard must reject it so no
    // annotation is written against a stale frame.
    const lockedOut = await page.evaluate(async () => {
      const engine = window.__frameReview.engine;
      const seekPromise = engine.seekToFrame(40);
      const rejectedImmediately = engine.isWaiting && engine.verifiedFrame === null;
      const canvas = document.getElementById('overlay');
      const r = canvas.getBoundingClientRect();
      const opts = { bubbles: true, clientX: r.left + r.width * 0.4, clientY: r.top + r.height * 0.4, pointerId: 1 };
      canvas.dispatchEvent(new PointerEvent('pointerdown', opts));
      const dragBlocked = !engine.isWaiting ? true : canvas.dispatchEvent(
        new PointerEvent('pointermove', { ...opts, clientX: r.left + r.width * 0.6, clientY: r.top + r.height * 0.6 })
      );
      await seekPromise;
      return { rejectedImmediately, dragBlocked, waitingSeen: rejectedImmediately };
    });
    expect(lockedOut.rejectedImmediately).toBe(true);
    expect((await H.annotationsFor(page, cid)).length).toBe(before);

    // Once the target frame is verified, the overlay unlocks and a real
    // Playwright drag creates exactly one annotation.
    expect(await H.currentVerifiedFrame(page)).toBe(40);
    await H.drawRegion(page, [0.3, 0.3], [0.6, 0.6]);
    expect((await H.annotationsFor(page, cid)).length).toBe(before + 1);
  });

  test('连续多次跳转过程中出现 waiting 态且最终稳定在目标帧', async ({ page }) => {
    await H.uploadClip(page, CFR);
    const sawWaiting = await page.evaluate(async () => {
      const engine = window.__frameReview.engine;
      let waiting = false;
      const p1 = engine.seekToFrame(50);
      if (engine.isWaiting) waiting = true;
      const p2 = engine.seekToFrame(10); // supersedes the first seek
      if (engine.isWaiting) waiting = true;
      const shown = await p2;
      return { waiting, shown, final: engine.verifiedFrame };
    });
    expect(sawWaiting.waiting).toBe(true);
    expect(sawWaiting.final).toBe(10);
  });
});

test.describe('内容身份与同名重复上传', () => {
  test('同名但内容不同的两个片段获得不同内容身份，注释不串台', async ({ page }) => {
    const sharedName = `same-name-${Date.now()}.mp4`;
    await H.uploadClip(page, CFR, sharedName);
    await H.gotoFrame(page, 20);
    await H.drawRegion(page, [0.25, 0.25], [0.5, 0.5]);
    const id1 = await H.currentContentId(page);
    expect(await H.annotationsFor(page, id1)).toHaveLength(1);

    // Different bytes, identical filename
    await H.uploadClip(page, VFR, sharedName);
    const id2 = await H.currentContentId(page);
    expect(id2).not.toBe(id1);
    expect(await H.annotationsFor(page, id2)).toHaveLength(0);

    // The media list now carries two distinct contents under one name
    const media = await page.evaluate(async () => (await (await fetch('/api/media')).json()).media);
    const named = media.filter((m) => m.versions.some((v) => v.fileName === sharedName));
    expect(named).toHaveLength(2);
    expect(named.map((m) => m.contentId).sort()).toEqual([id1, id2].sort());
  });

  test('相同字节再次上传挂为新版本，注释仍按内容身份可见并显示来源版本', async ({ page }) => {
    const unique = `reupload-${Date.now()}.mp4`;
    await H.uploadClip(page, CFR, unique);
    await H.gotoFrame(page, 15);
    await page.fill('#noteText', '第一版留下的注释');
    await H.drawRegion(page, [0.2, 0.2], [0.4, 0.4]);
    const id = await H.currentContentId(page);

    await H.uploadClip(page, CFR, unique);
    const sameId = await H.currentContentId(page);
    expect(sameId).toBe(id);

    const media = await page.evaluate(async (cid) =>
      (await (await fetch(`/api/media/${cid}`)).json()).media, id);
    expect(media.versions).toHaveLength(2);
    expect(media.versions[0].versionId).not.toBe(media.versions[1].versionId);
    expect(media.versions.every((v) => v.fileName === unique)).toBe(true);

    const anns = await H.annotationsFor(page, id);
    expect(anns).toHaveLength(1);
    expect(anns[0].sourceVersionId).toBe(media.versions[0].versionId);
    expect(await page.locator('.ann-version').first()).toContainText('来源版本：' + anns[0].sourceVersionId);
    expect(await page.locator('.ann-version').first()).toContainText(unique);
  });
});

test.describe('两位使用者跨端定位', () => {
  test('B 端打开分享链接后定位到 A 端注释的实际帧和区域', async ({ page }) => {
    await H.setAuthor(page, 'reviewer-A');
    await H.uploadClip(page, CFR, `collab-${Date.now()}.mp4`);
    await H.gotoFrame(page, 33);
    await page.fill('#noteText', '色彩断层，请核对');
    await H.drawRegion(page, [0.35, 0.3], [0.7, 0.65]);
    const cid = await H.currentContentId(page);
    const ann = await H.lastAnnotation(page, cid);
    expect(ann.author).toBe('reviewer-A');
    expect(ann.frameIndex).toBe(33);
    const storedRegion = ann.region;

    // Second browser context = the other reviewer on another machine
    const browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage']
    });
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const pageB = await context.newPage();
    await pageB.goto(`/?media=${cid}&annotation=${ann.annotationId}`);
    await pageB.waitForSelector('#seekState.ready', { timeout: 30000 });

    expect(await H.currentVerifiedFrame(pageB)).toBe(33);
    const ptsB = await H.currentPts(pageB);
    expect(Math.abs(ptsB - ann.ptsTime)).toBeLessThan(1e-6);

    await H.setAuthor(pageB, 'reviewer-B');
    // The annotation card is present and shows the source version
    const card = pageB.locator('.ann', { hasText: '色彩断层' });
    await expect(card).toBeVisible();
    await expect(card.locator('.ann-author')).toHaveText('reviewer-A');
    await expect(card.locator('.ann-version')).toContainText('来源版本');

    // B marks a region on the same frame using a different window size;
    // material-space coordinates are independent of window geometry.
    await pageB.setViewportSize({ width: 600, height: 850 });
    await H.gotoFrame(pageB, 33);
    await H.drawRegion(pageB, [0.35, 0.3], [0.7, 0.65]);
    const annB = await H.lastAnnotation(pageB, cid);
    expect(annB.author).toBe('reviewer-B');
    expect(annB.frameIndex).toBe(33);
    expect(Math.abs(annB.region.xn - storedRegion.xn)).toBeLessThan(0.02);
    expect(Math.abs(annB.region.yn - storedRegion.yn)).toBeLessThan(0.02);

    // A side polls and receives B's annotation without a reload
    await expect.poll(async () =>
      (await H.annotationsFor(page, cid)).length, { timeout: 8000 }).toBe(2);

    await browser.close();
  });

  test('跨端定位不依赖播放器进度：换窗口尺寸后按内容ID+PTS仍命中同一帧', async ({ page }) => {
    await H.uploadClip(page, VFR, `cross-vfr-${Date.now()}.mp4`);
    await H.gotoFrame(page, 23);
    await H.drawRegion(page, [0.4, 0.4], [0.6, 0.6]);
    const cid = await H.currentContentId(page);
    const ann = await H.lastAnnotation(page, cid);

    const browser = await chromium.launch({ args: ['--no-sandbox'] });
    const context = await browser.newContext({ viewport: { width: 1100, height: 480 } });
    const pageB = await context.newPage();
    await pageB.goto(`/?media=${cid}&annotation=${ann.annotationId}`);
    await pageB.waitForSelector('#seekState.ready', { timeout: 30000 });
    expect(await H.currentVerifiedFrame(pageB)).toBe(23);
    const pts = await H.currentPts(pageB);
    expect(Math.abs(pts - ann.ptsTime)).toBeLessThan(1e-6);
    await browser.close();
  });
});
