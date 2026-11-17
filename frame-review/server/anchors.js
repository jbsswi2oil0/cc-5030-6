'use strict';

const { candidatesWithin, DEFAULT_DISTANCE_THRESHOLD } = require('./signature');

/*
 * Annotation anchors and their two locators.
 *
 * Time anchor ("media-time-interval"):
 *   one frame's absolute PTS + its interval + the timeline fingerprint
 *   (timeBase, firstPtsTime, frameCount). Exact PTS is only trusted as a
 *   content match when the target timeline fingerprint is unchanged. A cut
 *   that re-bases the timeline can still produce an exact PTS hit on the
 *   wrong content, so that case is reported as unreliable, never as success.
 *
 * Content anchor ("content-signature"):
 *   the 16x16 luma fingerprint of the annotated frame plus the calibrated
 *   distance threshold. It survives re-encoding/rescaling, but it cannot
 *   distinguish repeated shots: every candidate inside the threshold is
 *   returned and ambiguity is the candidate count.
 *
 * Threshold is written into every anchor. The locator refuses to run without
 * one; there is no "nearest frame" fallback that would hide a miss.
 */

const CONTENT_THRESHOLD = DEFAULT_DISTANCE_THRESHOLD;
const CONTENT_THRESHOLD_EVIDENCE = 'tools/experiment-anchors.js (re-encoded own<=1.48, wrong>=2.96; cut own<=0.44, wrong>=3.15; repeat own<=0.54, wrong>=3.11)';

function frameIntervalSec(frameTable, index) {
  const frames = frameTable.frames;
  const frame = frames[index];
  const next = frames[index + 1];
  if (next) return next.ptsTime - frame.ptsTime;
  if (typeof frame.duration === 'number' && frame.duration > 0) return frame.duration;
  if (frameTable.step) return frameTable.step.num / frameTable.step.den;
  return 0;
}

function buildTimeAnchor(media, frameIndex) {
  const ft = media.frameTable;
  const frame = ft.frames[frameIndex];
  if (!frame) throw new Error('frameIndex out of range for time anchor');
  return {
    kind: 'media-time-interval',
    frameIndex,
    pts: frame.pts,
    ptsTime: frame.ptsTime,
    relativeTime: frame.time,
    intervalSec: frameIntervalSec(ft, frameIndex),
    timeBase: ft.timeBase,
    firstPtsTime: ft.firstPtsTime,
    frameRate: ft.frameRate,
    isCfr: ft.isCfr,
    frameCount: ft.frameCount,
    durationSec: ft.durationSec
  };
}

function buildContentAnchor(media, frameIndex, options = {}) {
  const table = media.signatureTable;
  if (!table) throw new Error('media has no signature table');
  const sig = table.frames[frameIndex];
  if (!sig) throw new Error('frameIndex out of signature table range');
  const threshold = options.threshold === undefined ? CONTENT_THRESHOLD : options.threshold;
  if (!Number.isFinite(threshold) || threshold <= 0) {
    throw new Error('content anchor requires an explicit positive threshold');
  }
  return {
    kind: 'content-signature',
    frameIndex,
    algorithm: table.kind,
    grid: table.grid,
    signature: sig.hex,
    threshold,
    thresholdEvidence: CONTENT_THRESHOLD_EVIDENCE
  };
}

function buildAnchors(media, frameIndex, options = {}) {
  return {
    time: buildTimeAnchor(media, frameIndex),
    content: buildContentAnchor(media, frameIndex, options)
  };
}

function timelinePreserved(anchor, frameTable) {
  return (
    frameTable.frameCount === anchor.frameCount &&
    frameTable.timeBase === anchor.timeBase &&
    Math.abs(frameTable.firstPtsTime - anchor.firstPtsTime) <= 1e-9
  );
}

/*
 * Locate a time anchor in a target frame table.
 * Returns null only when the target has no frames at all. Every hit carries
 * the method and whether the target timeline fingerprint matches the source,
 * so a "hit" on a cut/re-timed timeline is explicitly untrustworthy.
 */
function locateByTime(anchor, frameTable) {
  if (!anchor || anchor.kind !== 'media-time-interval') {
    throw new Error('locateByTime requires a media-time-interval anchor');
  }
  const frames = frameTable.frames;
  if (frames.length === 0) return null;
  const preserved = timelinePreserved(anchor, frameTable);

  const exact = frames.find((f) => Math.abs(f.ptsTime - anchor.ptsTime) <= 1e-6);
  if (exact) {
    return {
      method: 'exact-pts',
      frameIndex: exact.index,
      targetPtsTime: exact.ptsTime,
      targetRelativeTime: exact.time,
      indexDelta: exact.index - anchor.frameIndex,
      timeDeltaSec: exact.time - anchor.relativeTime,
      timelinePreserved: preserved,
      reliable: preserved,
      note: preserved
        ? '绝对 PTS 命中且时间轴指纹一致'
        : '绝对 PTS 命中，但目标帧数/时基/起始 PTS 已变：该命中不能证明是同一画面'
    };
  }

  // No exact PTS: does the anchor interval overlap a target frame interval?
  for (let i = 0; i < frames.length; i++) {
    const start = frames[i].ptsTime;
    const end = start + frameIntervalSec(frameTable, i);
    if (anchor.ptsTime >= start && anchor.ptsTime < end) {
      return {
        method: 'interval-overlap',
        frameIndex: frames[i].index,
        targetPtsTime: frames[i].ptsTime,
        targetRelativeTime: frames[i].time,
        indexDelta: frames[i].index - anchor.frameIndex,
        timeDeltaSec: frames[i].time - anchor.relativeTime,
        timelinePreserved: false,
        reliable: false,
        note: '仅区间重叠，目标时间轴与来源不一致'
      };
    }
  }

  // Last resort: nearest relative timeline position. Never reliable.
  let best = 0;
  let bestDiff = Infinity;
  for (const f of frames) {
    const d = Math.abs(f.time - anchor.relativeTime);
    if (d < bestDiff) {
      bestDiff = d;
      best = f.index;
    }
  }
  return {
    method: 'relative-time-nearest',
    frameIndex: best,
    targetPtsTime: frames[best].ptsTime,
    targetRelativeTime: frames[best].time,
    indexDelta: best - anchor.frameIndex,
    timeDeltaSec: frames[best].time - anchor.relativeTime,
    timelinePreserved: false,
    reliable: false,
    note: '目标中无对应 PTS/区间，仅按相对时间取最近帧（不可靠）'
  };
}

/*
 * Locate a content anchor. Ambiguity is always the number of candidates
 * inside the anchor's own threshold; a unique candidate is "resolved", more
 * than one is "ambiguous", zero is "not-found". No threshold defaulting.
 */
function locateByContent(anchor, signatureTable) {
  if (!anchor || anchor.kind !== 'content-signature') {
    throw new Error('locateByContent requires a content-signature anchor');
  }
  if (!signatureTable) throw new Error('target media has no signature table');
  if (!Number.isFinite(anchor.threshold) || anchor.threshold <= 0) {
    throw new Error('content anchor has no calibrated threshold');
  }
  if (anchor.algorithm !== signatureTable.kind) {
    throw new Error(`signature algorithm mismatch: anchor ${anchor.algorithm} vs target ${signatureTable.kind}`);
  }
  const candidates = candidatesWithin(signatureTable, anchor.signature, anchor.threshold);
  const status = candidates.length === 0 ? 'not-found' : candidates.length === 1 ? 'resolved' : 'ambiguous';
  return {
    method: 'content-signature',
    threshold: anchor.threshold,
    candidateCount: candidates.length,
    candidates: candidates.slice(0, 16),
    frameIndex: candidates.length ? candidates[0].frameIndex : null,
    distance: candidates.length ? candidates[0].distance : null,
    ambiguity: candidates.length,
    status,
    note: status === 'not-found'
      ? `阈值 ${anchor.threshold} 内无候选`
      : status === 'ambiguous'
        ? `阈值 ${anchor.threshold} 内 ${candidates.length} 个候选：签名不能唯一识别重复画面`
        : `阈值 ${anchor.threshold} 内唯一候选`
  };
}

function runLocators(anchors, targetMedia) {
  if (!anchors || !anchors.time || !anchors.content) {
    throw new Error('annotation has no anchor pair');
  }
  return {
    time: locateByTime(anchors.time, targetMedia.frameTable),
    content: locateByContent(anchors.content, targetMedia.signatureTable)
  };
}

module.exports = {
  CONTENT_THRESHOLD,
  CONTENT_THRESHOLD_EVIDENCE,
  frameIntervalSec,
  buildTimeAnchor,
  buildContentAnchor,
  buildAnchors,
  timelinePreserved,
  locateByTime,
  locateByContent,
  runLocators
};
