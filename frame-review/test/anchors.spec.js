// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const H = require('./helpers');

const CFR = path.join(H.SAMPLES, 'cfr-frame-numbers.mp4');
const { FFMPEG } = require('../server/fftools');

/*
 * Derived copies used by the anchor panel. Built once per run into a temp dir
 * so they can be uploaded as *different content identities* (the store keys
 * content by byte hash, so re-uploading the same file would merge versions).
 */
let derived = null;

function ffmpeg(args) {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.slice(-500));
}

function buildDerived() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-anchor-e2e-'));
  const reencode = path.join(dir, 'anchor-reencode.mp4');
  const cut = path.join(dir, 'anchor-cut.mp4');
  const repeat = path.join(dir, 'anchor-repeat.mp4');

  ffmpeg(['-y', '-i', CFR, '-vf', 'scale=256:192', '-c:v', 'libx264', '-crf', '30',
    '-preset', 'veryfast', '-r', '30', '-use_editlist', '0', reencode]);
  ffmpeg(['-y', '-i', CFR,
    '-vf', 'select=between(n\\,15\\,44),setpts=N/30/TB', '-fps_mode', 'cfr', '-r', '30',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-use_editlist', '0', cut]);
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, `file '${CFR}'\nfile '${CFR}'\n`);
  ffmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-crf', '20',
    '-preset', 'veryfast', '-r', '30', '-use_editlist', '0', repeat]);
  return { dir, reencode, cut, repeat };
}

test.beforeAll(async ({ request }) => {
  await request.post('/api/test/reset');
  derived = buildDerived();
});

test.beforeEach(async ({ request }) => {
  await request.post('/api/test/reset');
});

async function selectByText(page, selectId, text) {
  await page.selectOption(selectId, { label: text });
}

/* Upload the shared clips through the UI and keep their content ids. */
async function uploadViaApi(page, file, name) {
  const body = await page.evaluate(async ({ name, b64 }) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const r = await fetch(`/api/media?name=${encodeURIComponent(name)}`, { method: 'PUT', body: bytes });
    return r.json();
  }, { name, b64: fs.readFileSync(file).toString('base64') });
  return body.media.contentId;
}

test.describe('注释锚点对照面板', () => {
  test('点选帧写入注释后，两种锚点显示写入自检结果，且签名阈值被显式记录', async ({ page }) => {
    await page.goto('/');
    await H.uploadClip(page, CFR, 'anchor-src.mp4');
    await H.gotoFrame(page, 22);
    const cid = await H.currentContentId(page);
    await page.fill('#noteText', '锚点对照测试注释');
    await H.drawRegion(page, [0.3, 0.3], [0.6, 0.6]);

    // The new annotation is auto-selected and the panel is populated.
    await expect(page.locator('#anchorTarget')).toContainText('来源帧 22');
    await expect(page.locator('#timeAnchorCard')).toContainText('PTS 精确命中');
    await expect(page.locator('#contentAnchorCard')).toContainText('luma-grid-16');
    await expect(page.locator('#contentAnchorCard')).toContainText('唯一');

    const ann = await H.lastAnnotation(page, cid);
    expect(ann.anchors.time.kind).toBe('media-time-interval');
    expect(ann.anchors.content.kind).toBe('content-signature');
    expect(ann.anchors.content.threshold).toBeGreaterThan(0);
    expect(ann.anchors.content.thresholdEvidence).toContain('experiment-anchors');
    expect(ann.anchorCheck.time.reliable).toBe(true);
    expect(ann.anchorCheck.content.candidateCount).toBe(1);
  });

  test('点选注释卡片可切换锚点面板；编辑文字后帧与锚点保持不变', async ({ page }) => {
    await page.goto('/');
    await H.uploadClip(page, CFR, 'anchor-edit.mp4');
    const cid = await H.currentContentId(page);
    await H.gotoFrame(page, 10);
    await page.fill('#noteText', '原始文字');
    await H.drawRegion(page, [0.4, 0.4], [0.6, 0.6]);
    await H.gotoFrame(page, 40);
    await page.fill('#noteText', '第二条');
    await H.drawRegion(page, [0.2, 0.2], [0.4, 0.4]);

    const before = await H.annotationsFor(page, cid);
    const first = before.find((a) => a.frameIndex === 10);

    // Clicking a card body selects it (not the locate button).
    await page.locator('.ann', { hasText: '原始文字' }).click();
    await expect(page.locator('#anchorTarget')).toContainText('来源帧 10');

    // Edit flow: edit -> save. Frame and both anchors must be unchanged.
    await page.locator('.ann', { hasText: '原始文字' }).locator('.edit').click();
    await page.fill('#noteText', '修改后的文字');
    await page.click('#btnSaveEdit');
    await expect.poll(async () => (await H.annotationsFor(page, cid)).find((a) => a.annotationId === first.annotationId).text)
      .toBe('修改后的文字');

    const after = (await H.annotationsFor(page, cid)).find((a) => a.annotationId === first.annotationId);
    expect(after.frameIndex).toBe(10);
    expect(after.anchors).toEqual(first.anchors);
    await expect(page.locator('.ann', { hasText: '修改后的文字' })).toBeVisible();
  });

  test('重编码素材：两种锚点都定位到同一帧，面板显示可靠/唯一且实际跳到该帧', async ({ page }) => {
    const srcId = await page.goto('/').then(() => uploadViaApi(page, CFR, 'anchor-reencode-src.mp4'));
    const reId = await uploadViaApi(page, derived.reencode, 'anchor-reencode.mp4');

    await page.goto(`/?media=${srcId}`);
    await page.waitForSelector('#seekState.ready', { timeout: 30000 });
    await H.gotoFrame(page, 18);
    await page.fill('#noteText', '重编码后仍应定位');
    await H.drawRegion(page, [0.3, 0.3], [0.55, 0.55]);

    // Point the compare target at the re-encoded copy.
    await page.selectOption('#anchorTargetSelect', reId);
    await page.click('#btnCompare');
    await expect(page.locator('#anchorCompareState')).toContainText('时间锚点：可靠');
    await expect(page.locator('#anchorCompareState')).toContainText('签名锚点：唯一');

    // The panel result drives the review canvas: it sought to frame 18.
    await expect.poll(() => H.currentVerifiedFrame(page)).toBe(18);
  });

  test('剪切素材：时间锚点标注不可靠，签名锚点给出对应帧', async ({ page }) => {
    const srcId = await page.goto('/').then(() => uploadViaApi(page, CFR, 'anchor-cut-src.mp4'));
    const cutId = await uploadViaApi(page, derived.cut, 'anchor-cut.mp4');

    await page.goto(`/?media=${srcId}`);
    await page.waitForSelector('#seekState.ready', { timeout: 30000 });
    // Source frame 30 lives at cut index 15.
    await H.gotoFrame(page, 30);
    await page.fill('#noteText', '剪切后该帧前移 15 帧');
    await H.drawRegion(page, [0.3, 0.3], [0.55, 0.55]);

    await page.selectOption('#anchorTargetSelect', cutId);
    await page.click('#btnCompare');
    await expect(page.locator('#anchorCompareState')).toContainText('时间锚点：不可靠');
    await expect(page.locator('#anchorCompareState')).toContainText('签名锚点：唯一');
    // An unreliable time hit must not move the review canvas to the wrong
    // frame; the source view stays where the reviewer left it.
    await expect(page.locator('#flash')).toContainText('时间锚点不可靠，未移动审阅画面');
    expect(await H.currentVerifiedFrame(page)).toBe(30);
  });

  test('重复镜头素材：签名锚点必须显示歧义候选数量，不谎称唯一', async ({ page }) => {
    const srcId = await page.goto('/').then(() => uploadViaApi(page, CFR, 'anchor-repeat-src.mp4'));
    const repId = await uploadViaApi(page, derived.repeat, 'anchor-repeat.mp4');

    await page.goto(`/?media=${srcId}`);
    await page.waitForSelector('#seekState.ready', { timeout: 30000 });
    await H.gotoFrame(page, 12);
    await page.fill('#noteText', '重复镜头无法唯一识别');
    await H.drawRegion(page, [0.3, 0.3], [0.55, 0.55]);

    await page.selectOption('#anchorTargetSelect', repId);
    await page.click('#btnCompare');
    await expect(page.locator('#anchorCompareState')).toContainText('签名锚点：歧义');
    await expect(page.locator('#anchorCompareState')).toContainText('2 个候选');
    await expect(page.locator('#anchorCompareState')).toContainText('时间锚点：不可靠');
    expect(await H.currentVerifiedFrame(page)).toBe(12);
  });

  test('目标缺少时基差异时，把定位失败反馈回审阅界面而非静默吞掉', async ({ page }) => {
    const srcId = await page.goto('/').then(() => uploadViaApi(page, CFR, 'anchor-err-src.mp4'));
    await page.goto(`/?media=${srcId}`);
    await page.waitForSelector('#seekState.ready', { timeout: 30000 });
    await H.gotoFrame(page, 5);
    await page.fill('#noteText', '错误路径注释');
    await H.drawRegion(page, [0.3, 0.3], [0.5, 0.5]);
    const cid = await H.currentContentId(page);
    const ann = await H.lastAnnotation(page, cid);

    // Corrupt the target id to force the API to reject the comparison.
    await page.evaluate((target) => {
      const sel = document.getElementById('anchorTargetSelect');
      const opt = document.createElement('option');
      opt.value = 'missing-content-id';
      opt.textContent = 'missing';
      sel.appendChild(opt);
      sel.value = target;
    }, 'missing-content-id');
    await page.click('#btnCompare');

    await expect(page.locator('#anchorCompareState')).toContainText('定位失败');
    await expect(page.locator('#flash')).toContainText('锚点对照失败');
    // Review canvas is untouched by the failed comparison.
    expect(await H.currentVerifiedFrame(page)).toBe(5);
    // And the annotation is still intact with both anchors.
    const still = (await H.annotationsFor(page, cid)).find((a) => a.annotationId === ann.annotationId);
    expect(still.anchors.time.kind).toBe('media-time-interval');
  });

  test('相同字节重传：内容身份不变、签名表沿用、注释锚点仍可对照', async ({ page }) => {
    const cid = await page.goto('/').then(() => uploadViaApi(page, CFR, 'anchor-reupload.mp4'));
    await page.goto(`/?media=${cid}`);
    await page.waitForSelector('#seekState.ready', { timeout: 30000 });
    await H.gotoFrame(page, 17);
    await page.fill('#noteText', '重传前的注释');
    await H.drawRegion(page, [0.3, 0.3], [0.55, 0.55]);
    const before = await H.lastAnnotation(page, cid);

    // Identical bytes again: same content id, new version, same signature kind.
    const again = await uploadViaApi(page, CFR, 'anchor-reupload.mp4');
    expect(again).toBe(cid);

    const media = await page.evaluate(async (id) => (await (await fetch(`/api/media/${id}`)).json()).media, cid);
    expect(media.versions).toHaveLength(2);
    expect(media.signature.kind).toBe('luma-grid-16');
    expect(media.signature.frameCount).toBe(media.frameTable.frameCount);

    // The earlier annotation keeps both anchors and still compares to itself.
    const r = await page.evaluate(async ({ cid, aid }) =>
      (await (await fetch(`/api/media/${cid}/annotations/${aid}?target=${cid}`)).json()),
    { cid, aid: before.annotationId });
    expect(r.result.time.reliable).toBe(true);
    expect(r.result.content.status).toBe('resolved');
    expect(r.result.content.candidateCount).toBe(1);
  });

  test('旧注释（无锚点）在面板显示需重新标注，而不是默认值', async ({ page }) => {
    await page.goto('/');
    await H.uploadClip(page, CFR, 'anchor-legacy.mp4');
    const cid = await H.currentContentId(page);
    await H.gotoFrame(page, 8);
    await page.fill('#noteText', '旧注释');
    await H.drawRegion(page, [0.3, 0.3], [0.5, 0.5]);
    const ann = await H.lastAnnotation(page, cid);

    // Simulate a pre-anchor annotation by stripping the anchor fields from the
    // list response the client receives (the server itself always writes them).
    await page.route(`**/api/media/${cid}/annotations`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      for (const a of body.annotations) {
        if (a.annotationId === ann.annotationId) {
          delete a.anchors;
          delete a.anchorCheck;
        }
      }
      await route.fulfill({ response, json: body });
    });

    await page.reload();
    await page.waitForSelector('#seekState.ready', { timeout: 30000 });
    await page.locator('.ann', { hasText: '旧注释' }).click();

    await expect(page.locator('.ann-anchors')).toContainText('无锚点');
    await expect(page.locator('#timeAnchorCard')).toContainText('旧注释没有锚点');
    await expect(page.locator('#contentAnchorCard')).toContainText('旧注释没有锚点');
  });
});
