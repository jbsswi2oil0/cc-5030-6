'use strict';

/*
 * Annotation-anchor experiment, recomputable from committed samples.
 *
 * For every probe frame in the source clip it writes both anchor kinds, then
 * re-locates them in three derived copies:
 *
 *   reencode : same frames, CRF-30, rescaled to 256x192 (lossy identity)
 *   cut      : frames 15..44 with the timeline re-based to 0
 *   repeat   : the full clip concatenated twice (every shot appears twice)
 *
 * It reports, per anchor kind:
 *   - localization error: |located frame - expected source frame| (in frames)
 *   - ambiguity: how many frames fall inside the anchor's own threshold
 *
 * Exit code is non-zero if a content anchor's candidate count contradicts the
 * measured distance data, so this file cannot pass on a stale default.
 *
 * Usage: node tools/experiment-anchors.js [--write]
 *   --write  also refresh data/experiments/anchor-results.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { FFMPEG } = require('../server/fftools');
const { probeMedia } = require('../server/probe');
const { extractSignatures, lumaDistanceHex } = require('../server/signature');
const anchors = require('../server/anchors');

const ROOT = path.join(__dirname, '..');
const SAMPLES = path.join(ROOT, 'data', 'samples');
const OUT_DIR = path.join(ROOT, 'data', 'experiments');
const SOURCE = path.join(SAMPLES, 'cfr-frame-numbers.mp4');

// Probe frames spread across the clip; every one is asserted by the test.
const PROBE_FRAMES = [0, 1, 7, 15, 22, 30, 31, 44, 59];
const CUT_START = 15;
const CUT_END = 44;

function run(args) {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-600)}`);
}

function buildDerived(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const reencode = path.join(dir, 'reencode-crf30-256x192.mp4');
  const cut = path.join(dir, 'cut-15-44.mp4');
  const repeat = path.join(dir, 'repeat-twice.mp4');

  run([
    '-y', '-i', SOURCE,
    '-vf', 'scale=256:192',
    '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast',
    '-r', '30', '-use_editlist', '0', '-movflags', '+faststart', reencode
  ]);

  run([
    '-y', '-i', SOURCE,
    '-vf', `select=between(n\\,${CUT_START}\\,${CUT_END}),setpts=N/30/TB`,
    '-fps_mode', 'cfr', '-r', '30',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast',
    '-use_editlist', '0', cut
  ]);

  const listFile = path.join(dir, 'repeat-list.txt');
  fs.writeFileSync(listFile, `file '${SOURCE}'\nfile '${SOURCE}'\n`);
  run([
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-c:v', 'libx264', '-crf', '20', '-preset', 'veryfast',
    '-r', '30', '-use_editlist', '0', repeat
  ]);

  return { reencode, cut, repeat };
}

function loadMedia(filePath) {
  return {
    frameTable: probeMedia(filePath),
    signatureTable: extractSignatures(filePath)
  };
}

/*
 * Target indices (inside the derived copy) where a source probe frame appears.
 * Repeat shows the same shot twice on purpose, so it has two expected slots.
 * Returns [] when the source frame was cut away entirely.
 */
function expectedTargetFrames(kind, probe) {
  if (kind === 'reencode') return [probe];
  if (kind === 'cut') {
    if (probe < CUT_START || probe > CUT_END) return [];
    return [probe - CUT_START];
  }
  if (kind === 'repeat') return [probe, probe + 60];
  throw new Error('unknown kind ' + kind);
}

/* Probes that actually exist in this derived copy. */
function probesFor(kind) {
  return PROBE_FRAMES.filter((p) => expectedTargetFrames(kind, p).length > 0);
}

function minAbsError(locatedIndex, expectedTargets) {
  if (locatedIndex === null || locatedIndex === undefined) return null;
  return Math.min(...expectedTargets.map((t) => Math.abs(locatedIndex - t)));
}

function measure(kind, sourceMedia, targetMedia) {
  const probes = probesFor(kind);
  const rows = [];
  for (const probe of probes) {
    const expectedTargets = expectedTargetFrames(kind, probe);
    const timeAnchor = anchors.buildTimeAnchor(sourceMedia, probe);
    const contentAnchor = anchors.buildContentAnchor(sourceMedia, probe);
    const timeHit = anchors.locateByTime(timeAnchor, targetMedia.frameTable);
    const contentHit = anchors.locateByContent(contentAnchor, targetMedia.signatureTable);

    rows.push({
      probeFrame: probe,
      expectedTargetFrames: expectedTargets,
      time: timeHit ? {
        method: timeHit.method,
        reliable: timeHit.reliable,
        frameIndex: timeHit.frameIndex,
        errorFrames: timeHit.reliable
          ? minAbsError(timeHit.frameIndex, expectedTargets)
          : null,
        timelinePreserved: timeHit.timelinePreserved
      } : null,
      content: {
        status: contentHit.status,
        candidateCount: contentHit.candidateCount,
        ambiguity: contentHit.ambiguity,
        frameIndex: contentHit.frameIndex,
        distance: contentHit.distance,
        threshold: contentHit.threshold,
        // Error is only meaningful when there was a unique candidate.
        errorFrames: contentHit.status === 'resolved'
          ? minAbsError(contentHit.frameIndex, expectedTargets)
          : null
      }
    });
  }

  const reliableTimeRows = rows.filter((r) => r.time && r.time.reliable);
  const reliableTimeErrors = reliableTimeRows.map((r) => r.time.errorFrames);
  const resolvedContent = rows.filter((r) => r.content.status === 'resolved');
  const contentErrors = resolvedContent.map((r) => r.content.errorFrames);
  const ambiguities = rows.map((r) => r.content.ambiguity);

  return {
    kind,
    probeCount: rows.length,
    timeAnchor: {
      reliableHits: reliableTimeRows.length,
      unreliableHits: rows.filter((r) => r.time && !r.time.reliable).length,
      maxErrorFrames: reliableTimeErrors.length ? Math.max(...reliableTimeErrors) : null,
      errorsFrames: reliableTimeErrors
    },
    contentAnchor: {
      resolved: resolvedContent.length,
      ambiguous: rows.filter((r) => r.content.status === 'ambiguous').length,
      notFound: rows.filter((r) => r.content.status === 'not-found').length,
      maxErrorFrames: contentErrors.length ? Math.max(...contentErrors) : null,
      errorsFrames: contentErrors,
      ambiguityMin: ambiguities.length ? Math.min(...ambiguities) : null,
      ambiguityMax: ambiguities.length ? Math.max(...ambiguities) : null,
      ambiguities
    },
    rows
  };
}

/*
 * Frames that were cut away have no valid target. A content signature cannot
 * know that and will still return visually similar candidates; this records
 * the false-positive rate for absent frames instead of hiding it.
 */
function measureAbsent(kind, sourceMedia, targetMedia) {
  const absent = PROBE_FRAMES.filter((p) => expectedTargetFrames(kind, p).length === 0);
  return absent.map((probe) => {
    const contentAnchor = anchors.buildContentAnchor(sourceMedia, probe);
    const hit = anchors.locateByContent(contentAnchor, targetMedia.signatureTable);
    return {
      probeFrame: probe,
      status: hit.status,
      candidateCount: hit.candidateCount,
      frameIndex: hit.frameIndex,
      distance: hit.distance
    };
  });
}

/* Raw same-frame distance for every derived copy, independent of the locator. */
function signatureDrift(kind, sourceMedia, targetMedia) {
  const pairs = [];
  for (let t = 0; t < targetMedia.signatureTable.frames.length; t++) {
    const expected = kind === 'cut' ? t + CUT_START : kind === 'repeat' ? t % 60 : t;
    if (expected >= sourceMedia.signatureTable.frames.length) continue;
    pairs.push(lumaDistanceHex(
      sourceMedia.signatureTable.frames[expected].hex,
      targetMedia.signatureTable.frames[t].hex
    ));
  }
  pairs.sort((a, b) => a - b);
  return { count: pairs.length, min: pairs[0], median: pairs[Math.floor(pairs.length / 2)], max: pairs[pairs.length - 1] };
}

/*
 * Smallest distance between any two distinct frames of the source clip. This
 * is the separation the content threshold must stay below to avoid claiming a
 * unique match between genuinely different frames.
 */
function intraSourceMinDistance(sourceMedia) {
  const frames = sourceMedia.signatureTable.frames;
  let min = Infinity;
  let pair = null;
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      const d = lumaDistanceHex(frames[i].hex, frames[j].hex);
      if (d < min) {
        min = d;
        pair = [i, j];
      }
    }
  }
  return { min, pair };
}

function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-anchor-exp-'));
  const files = buildDerived(work);
  const sourceMedia = loadMedia(SOURCE);
  const intra = intraSourceMinDistance(sourceMedia);
  const results = {
    source: {
      file: path.relative(ROOT, SOURCE),
      frameCount: sourceMedia.frameTable.frameCount,
      signature: sourceMedia.signatureTable.kind,
      threshold: anchors.CONTENT_THRESHOLD,
      thresholdEvidence: anchors.CONTENT_THRESHOLD_EVIDENCE,
      intraSourceMinDistance: intra.min,
      intraSourceMinPair: intra.pair
    },
    probes: PROBE_FRAMES,
    targets: {}
  };

  for (const kind of ['reencode', 'cut', 'repeat']) {
    const targetMedia = loadMedia(files[kind]);
    results.targets[kind] = {
      signatureDrift: signatureDrift(kind, sourceMedia, targetMedia),
      absentProbes: measureAbsent(kind, sourceMedia, targetMedia),
      ...measure(kind, sourceMedia, targetMedia)
    };
  }

  // Guard against a default that hides errors: a content anchor must actually
  // be ambiguous somewhere in the repeated-shot copy, and the time anchor must
  // refuse the re-based cut timeline. If either stops being true the measured
  // claim and the code have diverged.
  const repeat = results.targets.repeat;
  const cut = results.targets.cut;
  const problems = [];
  if (repeat.contentAnchor.ambiguityMax < 2) {
    problems.push('repeat copy reports no content ambiguity: signature threshold collapsed');
  }
  if (cut.timeAnchor.reliableHits !== 0) {
    problems.push('cut timeline produced a "reliable" time hit');
  }
  // The selected threshold must sit below the distance between genuinely
  // different source frames; otherwise "unique" would be meaningless.
  if (!(anchors.CONTENT_THRESHOLD < intra.min)) {
    problems.push(`threshold ${anchors.CONTENT_THRESHOLD} is not below intra-source min distance ${intra.min}`);
  }
  // And re-encode drift must stay below the threshold, or re-encoded copies
  // would not be found at all.
  const maxReencodeDrift = results.targets.reencode.signatureDrift.max;
  if (!(maxReencodeDrift < anchors.CONTENT_THRESHOLD)) {
    problems.push(`re-encode drift ${maxReencodeDrift} exceeds threshold ${anchors.CONTENT_THRESHOLD}`);
  }
  for (const kind of ['reencode', 'cut', 'repeat']) {
    const t = results.targets[kind];
    const presentButMissing = t.rows.filter((r) => r.content.status === 'not-found');
    if (presentButMissing.length > 0) {
      problems.push(`${kind}: content anchor found no candidate for ${presentButMissing.length} present frame(s)`);
    }
  }

  results.checks = { problems, ok: problems.length === 0 };

  const text = JSON.stringify(results, null, 2);
  console.log(text);

  if (process.argv.includes('--write')) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'anchor-results.json'), text + '\n');
    console.log('\nwrote', path.relative(ROOT, path.join(OUT_DIR, 'anchor-results.json')));
  }

  if (problems.length) {
    console.error('\nEXPERIMENT CONTRADICTION:\n - ' + problems.join('\n - '));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { measure, measureAbsent, signatureDrift, intraSourceMinDistance, expectedTargetFrames, probesFor, PROBE_FRAMES, CUT_START, CUT_END };
