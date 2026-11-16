'use strict';

/*
 * Generate deterministic test clips:
 *   cfr-frame-numbers.mp4   320x240, 30fps, every frame carries its index
 *   vfr-irregular.mp4       same visuals, irregular per-frame durations (VFR)
 *   rotated-metadata.mp4    240x320 coded frame + 90° rotation metadata
 *
 * Frames are rendered with pngjs (no system-font dependency inside ffmpeg):
 * big frame number area, a per-frame unique corner color, and a grid so
 * region coordinate mapping can be checked pixel-wise.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { PNG } = require('pngjs');
const { FFMPEG, FFPROBE } = require('../server/fftools');

const OUT_DIR = path.join(__dirname, '..', 'data', 'samples');
const W = 320;
const H = 240;
const FRAMES = 60;

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.stderr}`);
}

/* Tiny 5x7 bitmap font, digits + letters we need */
const FONT = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000']
};

function drawText(png, text, x0, y0, scale, rgb) {
  let cx = x0;
  for (const ch of text) {
    const glyph = FONT[ch] || FONT[' '];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] === '1') {
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const x = cx + col * scale + sx;
              const y = y0 + row * scale + sy;
              if (x >= 0 && x < W && y >= 0 && y < H) {
                const idx = (W * y + x) << 2;
                png.data[idx] = rgb[0];
                png.data[idx + 1] = rgb[1];
                png.data[idx + 2] = rgb[2];
                png.data[idx + 3] = 255;
              }
            }
          }
        }
      }
    }
    cx += 6 * scale;
  }
}

function fillRect(png, x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const idx = (W * yy + xx) << 2;
      png.data[idx] = rgb[0];
      png.data[idx + 1] = rgb[1];
      png.data[idx + 2] = rgb[2];
      png.data[idx + 3] = 255;
    }
  }
}

function hsv(i) {
  const h = (i * 47) % 360;
  const c = 1;
  const x = 1 - Math.abs(((h / 60) % 2) - 1);
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function renderFrame(index, dir) {
  const png = new PNG({ width: W, height: H });
  // dark background
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 18;
    png.data[i + 1] = 22;
    png.data[i + 2] = 28;
    png.data[i + 3] = 255;
  }
  // grid lines every 40px -> region mapping reference
  for (let x = 0; x < W; x += 40) fillRect(png, x, 0, 1, H, [48, 56, 66]);
  for (let y = 0; y < H; y += 40) fillRect(png, 0, y, W, 1, [48, 56, 66]);

  // per-frame unique color block (top-left 40x40) — pixel identity check
  fillRect(png, 4, 4, 40, 40, hsv(index));
  // frame index as 3-digit text, huge in the center
  const label = String(index).padStart(2, '0');
  drawText(png, label, 110, 70, 8, [240, 240, 240]);
  drawText(png, 'FRAME', 104, 30, 3, [150, 190, 230]);
  // bottom strip binary-ish marker using the index bits
  for (let bit = 0; bit < 8; bit++) {
    if (index & (1 << bit)) fillRect(png, W - 90 + bit * 10, H - 20, 8, 12, [255, 210, 77]);
  }
  // fixed red target square at known material coords (x 200..260, y 150..210)
  fillRect(png, 200, 150, 60, 60, [230, 70, 70]);
  drawText(png, 'T', 220, 165, 4, [255, 255, 255]);

  const file = path.join(dir, `frame_${String(index).padStart(4, '0')}.png`);
  fs.writeFileSync(file, PNG.sync.write(png));
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-frames-'));
  console.log('rendering frames into', work);
  for (let i = 0; i < FRAMES; i++) renderFrame(i, work);

  // 1) CFR 30fps. -use_editlist 0 keeps Chromium from resetting currentTime
  // to zero on seek (its MP4 demuxer restarts streams carrying an elst atom).
  const cfr = path.join(OUT_DIR, 'cfr-frame-numbers.mp4');
  run(FFMPEG, [
    '-y', '-framerate', '30', '-i', path.join(work, 'frame_%04d.png'),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30',
    '-use_editlist', '0', '-movflags', '+faststart', cfr
  ]);

  // 2) VFR: concat demuxer with per-image duration.
  // Pattern: alternating ~2x and ~0.5x steps -> genuinely irregular PTS.
  const concat = path.join(work, 'vfr.txt');
  let lines = [];
  for (let i = 0; i < FRAMES; i++) {
    const dur = i % 2 === 0 ? 0.066667 : 0.016667;
    lines.push(`file '${path.join(work, `frame_${String(i).padStart(4, '0')}.png`)}'`);
    lines.push(`duration ${dur}`);
  }
  fs.writeFileSync(concat, lines.join('\n'));
  const vfr = path.join(OUT_DIR, 'vfr-irregular.mp4');
  run(FFMPEG, [
    '-y', '-f', 'concat', '-safe', '0', '-i', concat,
    '-vsync', 'vfr', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-use_editlist', '0', '-movflags', '+faststart', vfr
  ]);

  // 3) Rotation metadata. Step A: transpose the coded frame to portrait.
  // Step B: re-encode while applying the display matrix via the input-side
  // -display_rotation option (FFmpeg 7 dropped the legacy rotate tag).
  // Re-encoding (not -c copy) is required so no edit list atom is written:
  // an elst makes Chromium restart the media element back to t=0 on seek.
  const rotatedTmp = path.join(work, 'rotated-tmp.mp4');
  run(FFMPEG, [
    '-y', '-framerate', '30', '-i', path.join(work, 'frame_%04d.png'),
    '-vf', 'transpose=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-use_editlist', '0',
    rotatedTmp
  ]);
  const rotated = path.join(OUT_DIR, 'rotated-metadata.mp4');
  // Stream copy keeps the display matrix (re-encoding autorotates the coded
  // frames and drops it); -use_editlist 0 strips the elst atom so Chromium
  // does not restart the stream on seek.
  run(FFMPEG, [
    '-y', '-display_rotation', '90', '-i', rotatedTmp,
    '-c', 'copy', '-use_editlist', '0', '-movflags', '+faststart', rotated
  ]);

  // sanity probes
  for (const f of [cfr, vfr, rotated]) {
    const r = spawnSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_frames,avg_frame_rate,r_frame_rate:stream_side_data=rotation',
      '-of', 'json', f], { encoding: 'utf8' });
    console.log(path.basename(f), r.stdout.trim());
  }
  console.log('done ->', OUT_DIR);
}

main();
