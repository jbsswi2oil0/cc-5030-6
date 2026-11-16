'use strict';

/*
 * Frame-accurate seeking engine.
 *
 * The browser's <video>.currentTime is a floating point second and different
 * decoders round it to adjacent frames. We never trust the displayed decimal:
 * every seek targets a frame-table entry (index + exact pts) and the frame is
 * only considered "shown" once timeupdate reports a time inside that frame's
 * PTS window. While pending, the UI is in a waiting state and marking is
 * blocked, so a stale frame can never be annotated as the target frame.
 */
class FrameEngine {
  constructor(videoEl, frameTable) {
    this.video = videoEl;
    this.ft = frameTable;
    this.targetIndex = null;
    this.attempt = 0;
    this.maxAttempts = 4;
    this.pendingResolve = null;
    this.onStateChange = null;
    this.state = 'idle'; // idle | seeking | ready
    this.shownIndex = null;
    // Monotonic id stamped onto every seek; stale seeked/timeupdate events
    // queued by an earlier seek carry an older id and must be ignored,
    // otherwise a late event from the previous target hijacks the new one.
    this.seekToken = 0;
    this.destroyed = false;

    this._onTimeUpdate = () => this.handleTimeUpdate();
    this._onSeeked = () => this.handleSeeked();
    this._onSeeking = () => {
      this._lastSeekedToken = this.seekToken;
    };
    this._onPlaying = () => {
      if (this.state === 'seeking') this.handleTimeUpdate();
    };
    this.video.addEventListener('timeupdate', this._onTimeUpdate);
    this.video.addEventListener('seeked', this._onSeeked);
    this.video.addEventListener('seeking', this._onSeeking);
    this.video.addEventListener('playing', this._onPlaying);
  }

  destroy() {
    this.destroyed = true;
    this.video.removeEventListener('timeupdate', this._onTimeUpdate);
    this.video.removeEventListener('seeked', this._onSeeked);
    this.video.removeEventListener('seeking', this._onSeeking);
    this.video.removeEventListener('playing', this._onPlaying);
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(null);
    }
    this.targetIndex = null;
  }

  get frames() {
    return this.ft.frames;
  }

  currentFrameIndex() {
    return this.frameAt(this.video.currentTime);
  }

  frameAt(t) {
    const frames = this.frames;
    let lo = 0;
    let hi = frames.length - 1;
    let ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      // Browser currentTime runs on absolute presentation timestamps, so the
      // lookup must compare against ptsTime (not the timeline-relative time).
      if (frames[mid].ptsTime <= t + 1e-9) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  frameWindow(index) {
    const f = this.frames[index];
    const next = this.frames[index + 1];
    const start = f.ptsTime;
    const end = next
      ? next.ptsTime
      : f.ptsTime + (f.duration || this.estimatedStep(index));
    return { start, end };
  }

  estimatedStep(index) {
    const frames = this.frames;
    if (this.ft.step) return this.ft.step.num / this.ft.step.den;
    if (index > 0) return frames[index].ptsTime - frames[index - 1].ptsTime;
    if (frames.length > 1) return frames[1].ptsTime - frames[0].ptsTime;
    return 1 / 30;
  }

  isTimeInFrame(t, index) {
    const { start, end } = this.frameWindow(index);
    // Tolerance relative to the frame window: generous enough for decoder
    // rounding, but an adjacent frame (a full step away) can never pass.
    const step = end - start;
    const tol = Math.min(step * 0.45, 0.01);
    return t >= start - tol && t < end - tol;
  }

  setState(s) {
    if (this.state !== s) {
      this.state = s;
      if (this.onStateChange) this.onStateChange(s);
    }
  }

  handleSeeked() {
    if (this.destroyed) return;
    // A seeked event belongs to the most recent issued seek only. Events
    // delivered after a newer seek started are stale (common when seeks are
    // issued back-to-back) and must not touch the current target.
    if (this._lastSeekedToken !== undefined && this._lastSeekedToken !== this.seekToken) {
      return;
    }
    this.handleTimeUpdate();
  }

  handleTimeUpdate() {
    if (this.destroyed) return;
    if (this.targetIndex === null) {
      // Free playback / scrubbing: derive the shown frame from real PTS.
      this.shownIndex = this.currentFrameIndex();
      this.setState('ready');
      return;
    }
    const t = this.video.currentTime;
    if (this.isTimeInFrame(t, this.targetIndex)) {
      this.shownIndex = this.targetIndex;
      const resolve = this.pendingResolve;
      this.targetIndex = null;
      this.pendingResolve = null;
      this.attempt = 0;
      this.setState('ready');
      if (resolve) resolve(this.shownIndex);
    } else if (this.state === 'seeking') {
      this.retryIfNeeded();
    }
  }

  issueSeek(time) {
    this.seekToken += 1;
    this._lastSeekedToken = this.seekToken;
    this.video.currentTime = time;
  }

  retryIfNeeded() {
    if (this.attempt >= this.maxAttempts) {
      // Give up looping: settle on the frame the decoder actually presents,
      // but report it explicitly instead of pretending we hit the target.
      const resolved = this.currentFrameIndex();
      const resolve = this.pendingResolve;
      const failedTarget = this.targetIndex;
      this.targetIndex = null;
      this.pendingResolve = null;
      this.attempt = 0;
      this.shownIndex = resolved;
      this.setState('ready');
      if (resolve) resolve(resolved, failedTarget);
      return;
    }
    this.attempt += 1;
    const target = this.frames[this.targetIndex];
    // Small fixed-fraction nudge inside the frame window so rounding cannot
    // land on the previous boundary, while staying well clear of the next
    // frame. Capped at 3ms so the nudge never crosses the window itself.
    const nudge = Math.min(
      this.estimatedStep(this.targetIndex) * 0.05 * this.attempt,
      0.003
    );
    this.issueSeek(target.ptsTime + nudge);
  }

  /* Seek to an exact frame index from the table; resolves when verified. */
  seekToFrame(index) {
    if (index < 0) index = 0;
    if (index >= this.frames.length) index = this.frames.length - 1;
    if (this.pendingResolve) {
      const oldResolve = this.pendingResolve;
      this.pendingResolve = null;
      oldResolve(null);
    }
    this.attempt = 0;
    this.targetIndex = index;
    this.setState('seeking');
    this.video.pause();
    const target = this.frames[index];
    this.issueSeek(target.ptsTime);

    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  step(delta) {
    const base = this.targetIndex !== null ? this.targetIndex : (this.shownIndex ?? this.currentFrameIndex());
    return this.seekToFrame(base + delta);
  }

  get isWaiting() {
    return this.state === 'seeking';
  }

  get verifiedFrame() {
    if (this.targetIndex !== null) return null; // target not yet shown
    return this.shownIndex;
  }
}

window.FrameEngine = FrameEngine;
