'use strict';

const { spawnSync } = require('child_process');
const { FFMPEG } = require('./fftools');

/*
 * Frame content signature.
 *
 * One decoded frame is reduced to a 16x16 mean-luma grid (256 bytes). The
 * signature is a *similarity* fingerprint for re-encoded / rescaled copies,
 * never an identity claim: repeated shots, fades and near-identical adjacent
 * frames produce identical or nearly identical signatures. Every caller must
 * report candidate counts instead of treating the nearest neighbour as unique.
 *
 * Grid size picked by measurement (tools/experiment-anchors.js): 8x8 luma
 * collides on adjacent frames of the committed samples, 32x32 dHash drifts
 * 87..112/1024 bits after a CRF-30 rescale. 16x16 luma keeps re-encode drift
 * (~1.5) below the smallest distance between distinct source frames (~3.2).
 */

const GRID = 16;
const DEFAULT_DISTANCE_THRESHOLD = 2.5;

function decodeGray(filePath, width, height) {
  const res = spawnSync(
    FFMPEG,
    [
      '-v', 'error',
      '-i', filePath,
      '-fps_mode', 'passthrough',
      '-vf', `scale=${width}:${height}:flags=area,format=gray`,
      '-f', 'rawvideo',
      '-pix_fmt', 'gray',
      '-'
    ],
    { encoding: null, maxBuffer: 1024 * 1024 * 1024 }
  );
  if (res.status !== 0) {
    throw new Error(`signature decode failed: ${String(res.stderr).slice(-500)}`);
  }
  const frameBytes = width * height;
  if (res.stdout.length === 0 || res.stdout.length % frameBytes !== 0) {
    throw new Error('signature decode produced a partial frame');
  }
  return res.stdout;
}

/*
 * Extract one signature per decoded frame, in decode order. The caller pairs
 * them with the authoritative frame table and must fail loudly when the counts
 * differ (a signature table silently shorter than the frame table would shift
 * every later match).
 */
function extractSignatures(filePath, opts = {}) {
  const grid = opts.grid || GRID;
  const raw = decodeGray(filePath, grid, grid);
  const frameBytes = grid * grid;
  const count = raw.length / frameBytes;
  const frames = [];
  for (let i = 0; i < count; i++) {
    frames.push({
      index: i,
      hex: raw.subarray(i * frameBytes, (i + 1) * frameBytes).toString('hex')
    });
  }
  return { kind: `luma-grid-${grid}`, grid, frames };
}

function lumaDistanceHex(aHex, bHex) {
  if (aHex.length !== bHex.length) throw new Error('signature width mismatch');
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum / a.length);
}

/* Every frame within threshold, sorted by distance then index. */
function candidatesWithin(signatureTable, signatureHex, threshold) {
  const out = [];
  for (const f of signatureTable.frames) {
    const distance = lumaDistanceHex(f.hex, signatureHex);
    if (distance <= threshold) out.push({ frameIndex: f.index, distance });
  }
  out.sort((x, y) => (x.distance - y.distance) || (x.frameIndex - y.frameIndex));
  return out;
}

/* Nearest frame regardless of threshold, for diagnostics only. */
function nearestFrame(signatureTable, signatureHex) {
  let best = null;
  for (const f of signatureTable.frames) {
    const distance = lumaDistanceHex(f.hex, signatureHex);
    if (!best || distance < best.distance) best = { frameIndex: f.index, distance };
  }
  return best;
}

module.exports = {
  GRID,
  DEFAULT_DISTANCE_THRESHOLD,
  extractSignatures,
  lumaDistanceHex,
  candidatesWithin,
  nearestFrame
};
