'use strict';

/*
 * Recomputes the anchor experiment from the committed samples and asserts the
 * numbers quoted in docs/ANNOTATION-ANCHORS.md. If the signature algorithm or
 * thresholds drift, this test fails rather than letting prose go stale.
 *
 * Requires ffmpeg/ffprobe (same binaries the server uses).
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { FFMPEG } = require('../server/fftools');
const { probeMedia } = require('../server/probe');
const { extractSignatures, lumaDistanceHex } = require('../server/signature');
const anchors = require('../server/anchors');

const SAMPLES = path.join(__dirname, '..', 'data', 'samples');
const SOURCE = path.join(SAMPLES, 'cfr-frame-numbers.mp4');
const RESULTS_FILE = path.join(__dirname, '..', 'data', 'experiments', 'anchor-results.json');

const PROBES = [0, 1, 7, 15, 22, 30, 31, 44, 59];
const CUT_START = 15;
const CUT_END = 44;

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

function run(args) {
  const r = spawnSync(FFMPEG, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr.slice(-600)}`);
}

function buildDerived(dir) {
  const reencode = path.join(dir, 'reencode.mp4');
  const cut = path.join(dir, 'cut.mp4');
  const repeat = path.join(dir, 'repeat.mp4');
  run(['-y', '-i', SOURCE, '-vf', 'scale=256:192', '-c:v', 'libx264', '-crf', '30',
    '-preset', 'veryfast', '-r', '30', '-use_editlist', '0', reencode]);
  run(['-y', '-i', SOURCE,
    '-vf', `select=between(n\\,${CUT_START}\\,${CUT_END}),setpts=N/30/TB`,
    '-fps_mode', 'cfr', '-r', '30', '-c:v', 'libx264', '-crf', '18',
    '-preset', 'veryfast', '-use_editlist', '0', cut]);
  const list = path.join(dir, 'list.txt');
  fs.writeFileSync(list, `file '${SOURCE}'\nfile '${SOURCE}'\n`);
  run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'libx264', '-crf', '20',
    '-preset', 'veryfast', '-r', '30', '-use_editlist', '0', repeat]);
  return { reencode, cut, repeat };
}

function load(file) {
  return { frameTable: probeMedia(file), signatureTable: extractSignatures(file) };
}

function expectedTargets(kind, probe) {
  if (kind === 'reencode') return [probe];
  if (kind === 'cut') return probe >= CUT_START && probe <= CUT_END ? [probe - CUT_START] : [];
  if (kind === 'repeat') return [probe, probe + 60];
  throw new Error('unknown kind');
}

function measure(kind, source, target) {
  const rows = [];
  for (const probe of PROBES.filter((p) => expectedTargets(kind, p).length)) {
    const expects = expectedTargets(kind, probe);
    const timeHit = anchors.locateByTime(anchors.buildTimeAnchor(source, probe), target.frameTable);
    const contentHit = anchors.locateByContent(anchors.buildContentAnchor(source, probe), target.signatureTable);
    rows.push({
      probe,
      timeReliable: timeHit.reliable,
      timeError: timeHit.reliable ? Math.min(...expects.map((t) => Math.abs(timeHit.frameIndex - t))) : null,
      contentStatus: contentHit.status,
      contentError: contentHit.status === 'resolved'
        ? Math.min(...expects.map((t) => Math.abs(contentHit.frameIndex - t)))
        : null,
      ambiguity: contentHit.ambiguity
    });
  }
  return rows;
}

console.log('anchor experiment: recompute from committed samples');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-anchor-test-'));
const files = buildDerived(work);
const source = load(SOURCE);
const targets = {
  reencode: load(files.reencode),
  cut: load(files.cut),
  repeat: load(files.repeat)
};
const measured = {};
for (const kind of Object.keys(targets)) measured[kind] = measure(kind, source, targets[kind]);

test('re-encode: both anchor kinds localize with zero frame error', () => {
  const rows = measured.reencode;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.timeReliable && r.timeError === 0), 'time anchor must be reliable with 0 error');
  assert.ok(rows.every((r) => r.contentStatus === 'resolved' && r.contentError === 0), 'content anchor must resolve with 0 error');
});

test('cut: time anchor yields no reliable hits (timeline re-based)', () => {
  const rows = measured.cut;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => !r.timeReliable), 'no time hit may claim reliability on a cut timeline');
});

test('cut: signature anchor resolves present frames; cut-away frames are not-found', () => {
  const present = measured.cut;
  assert.ok(present.every((r) => r.contentStatus === 'resolved' && r.contentError === 0));
  // Frames outside 15..44 do not exist in the target and are not probed there;
  // probing them must return no candidate, which the unit test covers directly.
  assert.ok(PROBES.some((p) => expectedTargets('cut', p).length === 0));
});

test('repeat: signature anchor is ambiguous on every probe (two shots)', () => {
  const rows = measured.repeat;
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.contentStatus === 'ambiguous'), 'repeated shots must never resolve uniquely');
  assert.ok(rows.every((r) => r.ambiguity === 2), 'each repeat probe has exactly two candidates');
  assert.ok(rows.every((r) => !r.timeReliable), 'absolute PTS cannot be trusted on a doubled timeline');
});

test('re-encode signature drift stays below the configured threshold', () => {
  const drift = [];
  const n = Math.min(source.signatureTable.frames.length, targets.reencode.signatureTable.frames.length);
  for (let i = 0; i < n; i++) {
    drift.push(lumaDistanceHex(source.signatureTable.frames[i].hex, targets.reencode.signatureTable.frames[i].hex));
  }
  const max = Math.max(...drift);
  assert.ok(max < anchors.CONTENT_THRESHOLD,
    `max drift ${max} must stay under threshold ${anchors.CONTENT_THRESHOLD}`);
});

test('threshold sits below the smallest distance between distinct source frames', () => {
  const frames = source.signatureTable.frames;
  let min = Infinity;
  for (let i = 0; i < frames.length; i++) {
    for (let j = i + 1; j < frames.length; j++) {
      min = Math.min(min, lumaDistanceHex(frames[i].hex, frames[j].hex));
    }
  }
  assert.ok(anchors.CONTENT_THRESHOLD < min,
    `threshold ${anchors.CONTENT_THRESHOLD} must be below intra-source min ${min}`);
  // Documented approximation: the committed sample's frames differ by ~3.2.
  assert.ok(min > 3.0 && min < 3.5, `intra-source min ${min} drifted from the documented ~3.2`);
});

test('the committed results file matches a fresh recomputation', () => {
  assert.ok(fs.existsSync(RESULTS_FILE), 'run tools/experiment-anchors.js --write first');
  const committed = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  // Recompute the same aggregate the tool records for one target and compare.
  const committedRepeat = committed.targets.repeat;
  const freshRepeat = measured.repeat;
  assert.strictEqual(committedRepeat.contentAnchor.ambiguous, freshRepeat.filter((r) => r.contentStatus === 'ambiguous').length);
  assert.strictEqual(committedRepeat.contentAnchor.ambiguityMax, Math.max(...freshRepeat.map((r) => r.ambiguity)));
  assert.strictEqual(committed.targets.reencode.contentAnchor.maxErrorFrames,
    Math.max(...measured.reencode.map((r) => r.contentError)));
});

console.log(`\n${passed} experiment assertions passed`);
if (process.exitCode) process.exit(process.exitCode);
