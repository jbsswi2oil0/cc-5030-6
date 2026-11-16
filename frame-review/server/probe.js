'use strict';

const { spawnSync } = require('child_process');
const { FFPROBE } = require('./fftools');

function runFfprobe(args) {
  const res = spawnSync(FFPROBE, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`ffprobe failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

/* Extract rotation in degrees (0/90/180/270) from stream metadata / side data */
function readRotation(sideDataList, tags) {
  const normalize = (raw) => {
    let r = Number(raw) % 360;
    if (r < 0) r += 360;
    // Some ffprobe builds already negate the matrix value; older ones report
    // the raw matrix angle (clockwise-negative). Both conventions appear in
    // the wild, so accept whichever normalizes to a cardinal angle.
    if (r === 90 || r === 180 || r === 270) return r;
    const neg = (360 - r) % 360;
    if (neg === 90 || neg === 180 || neg === 270) return neg;
    return 0;
  };
  if (Array.isArray(sideDataList)) {
    for (const sd of sideDataList) {
      if (sd.rotation !== undefined) return normalize(sd.rotation);
    }
  }
  if (tags && tags.rotate !== undefined) return normalize(tags.rotate);
  return 0;
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

/*
 * Build the authoritative frame table for a media file.
 * Every frame keeps its integer pts + time_base so frame times are exact
 * rationals, never rounded display decimals. Works for CFR and VFR.
 */
function probeMedia(filePath) {
  const formatRaw = runFfprobe([
    '-v', 'error',
    '-show_entries', 'format=duration,bit_rate,format_name',
    '-of', 'json',
    filePath
  ]);
  const formatInfo = JSON.parse(formatRaw).format || {};

  const streamsRaw = runFfprobe([
    '-v', 'error',
    '-show_streams',
    '-of', 'json',
    filePath
  ]);
  const streams = JSON.parse(streamsRaw).streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw new Error('no video stream found');

  const rotation = readRotation(video.side_data_list, video.tags);

  const framesRaw = runFfprobe([
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'frame=pts,pts_time,duration,duration_time,pkt_pts_time,best_effort_timestamp_time,pict_type',
    '-of', 'json',
    filePath
  ]);
  const rawFrames = JSON.parse(framesRaw).frames || [];
  if (rawFrames.length === 0) throw new Error('ffprobe returned no frames');

  // Drop duplicate-pts entries (concat demuxer repeats the final frame).
  const deduped = [];
  for (const f of rawFrames) {
    const t = Number(f.pts_time ?? f.best_effort_timestamp_time ?? f.pkt_pts_time ?? 0);
    if (deduped.length && Math.abs(deduped[deduped.length - 1]._t - t) < 1e-9) continue;
    f._t = t;
    deduped.push(f);
  }

  const firstPtsTime = Number(
    deduped[0].pts_time ??
    deduped[0].best_effort_timestamp_time ??
    deduped[0].pkt_pts_time ??
    0
  );

  const frames = deduped.map((f, index) => {
    const ptsTime = Number(
      f.pts_time ?? f.best_effort_timestamp_time ?? f.pkt_pts_time ?? 0
    );
    // Timeline-relative time (browser currentTime semantics, first frame at 0)
    const timeSec = ptsTime - firstPtsTime;
    const duration = f.duration_time ? Number(f.duration_time) : null;
    return {
      index,
      pts: f.pts !== undefined ? Number(f.pts) : null,
      ptsTime,
      time: timeSec,
      duration,
      keyFrame: f.pict_type === 'I'
    };
  });

  // Constant frame rate detection: CFR when all inter-frame deltas are equal
  // within a relative rational tolerance (pts_time is a decimal rendering of
  // an exact rational, so a fixed 1e-9 absolute epsilon fails at fine
  // time_bases such as 1/15360).
  let isCfr = frames.length > 1;
  let frameRate = null;
  if (frames.length > 1) {
    const deltas = [];
    for (let i = 1; i < frames.length; i++) {
      deltas.push(frames[i].time - frames[i - 1].time);
    }
    const d0 = deltas[0];
    isCfr = deltas.every((d) => Math.abs(d - d0) <= Math.max(1e-9, d0 * 1e-4));
    if (isCfr && d0 > 0) {
      const fps = 1 / d0;
      const rounded = Math.round(fps);
      frameRate = Math.abs(fps - rounded) < 0.01 ? rounded : Number(fps.toFixed(3));
      // Exact rational step. Prefer the integer PTS delta over the stream
      // time_base (exact); fall back to a 1e6-scaled decimal.
      const tb = video.time_base ? video.time_base.split('/').map(Number) : null;
      if (tb && tb[0] && tb[1] && frames[1].pts !== null && frames[0].pts !== null) {
        const ptsDelta = frames[1].pts - frames[0].pts;
        const num0 = ptsDelta * tb[0];
        const den0 = tb[1];
        const g = gcd(num0, den0);
        var stepNum = num0 / g; // eslint-disable-line no-var
        var stepDen = den0 / g; // eslint-disable-line no-var
      } else {
        const scaled = Math.round(d0 * 1e6);
        const g = gcd(scaled, 1e6);
        var stepNum = scaled / g; // eslint-disable-line no-var
        var stepDen = 1e6 / g; // eslint-disable-line no-var
      }
    }
  }
  if (!isCfr) {
    stepNum = null;
    stepDen = null;
  }

  const last = frames[frames.length - 1];
  const duration = last.time + (last.duration || 0);

  return {
    codec: video.codec_name,
    codedWidth: video.width,
    codedHeight: video.height,
    rotation,
    frameCount: frames.length,
    durationSec: duration,
    isCfr,
    frameRate,
    timeBase: video.time_base || null,
    step: isCfr ? { num: stepNum, den: stepDen } : null,
    firstPtsTime,
    frames
  };
}

/* Find the frame index whose presentation time is the latest one <= t */
function frameIndexAtTime(frameTable, t) {
  const frames = frameTable.frames;
  let lo = 0;
  let hi = frames.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].time <= t + 1e-9) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/*
 * Resolve a stored annotation (frame index + pts time) against a possibly
 * different frame table (re-encoded re-upload). Prefer exact PTS match;
 * otherwise nearest frame within half a frame step.
 * Returns null when no reliable frame exists.
 */
function resolveFrame(frameTable, frameIndex, ptsTime) {
  const frames = frameTable.frames;
  if (frameIndex != null && frameIndex >= 0 && frameIndex < frames.length) {
    const f = frames[frameIndex];
    if (Math.abs(f.ptsTime - ptsTime) <= 1e-6) return frameIndex;
  }
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const d = Math.abs(frames[i].ptsTime - ptsTime);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  if (best < 0) return null;
  const step = best > 0
    ? frames[best].time - frames[best - 1].time
    : (frames[1] ? frames[1].time - frames[0].time : Infinity);
  return bestDiff <= step / 2 + 1e-9 ? best : null;
}

module.exports = { probeMedia, frameIndexAtTime, resolveFrame, readRotation };
