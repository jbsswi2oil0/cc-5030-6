'use strict';

/*
 * Resolve ffmpeg/ffprobe binaries. ffprobe-static ships no linux/arm64
 * binary, so prefer @ffprobe-installer where present.
 */
const ffmpegPath = require('ffmpeg-static');

let ffprobePath;
try {
  ffprobePath = require('@ffprobe-installer/ffprobe').path;
} catch (_) {
  ffprobePath = require('ffprobe-static').path;
}
const fs = require('fs');
if (!fs.existsSync(ffprobePath)) {
  try {
    ffprobePath = require('ffprobe-static').path;
  } catch (_) {
    /* keep existing */
  }
}

module.exports = { FFMPEG: ffmpegPath, FFPROBE: ffprobePath };
