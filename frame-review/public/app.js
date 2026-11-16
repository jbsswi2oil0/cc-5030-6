'use strict';

const G = window.FrameGeometry;

const els = {};
const state = {
  media: null,
  engine: null,
  annotations: [],
  track: 'main',
  filterTrack: 'all',
  author: localStorage.getItem('fr-author') || 'reviewer-A',
  sourceVersionId: null,
  drag: null,
  pollTimer: null,
  pendingOpenId: null
};

function $(id) {
  return document.getElementById(id);
}

function api(method, url, body, rawUpload) {
  const opts = { method, headers: {} };
  if (body && !rawUpload) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  } else if (rawUpload) {
    opts.body = body;
  }
  return fetch(url, opts).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  });
}

function fmtTime(t) {
  return (t >= 0 ? '+' : '') + t.toFixed(6) + 's';
}

/* ---------------- media loading ---------------- */

async function loadMediaList() {
  const { media } = await api('GET', '/api/media');
  const sel = $('mediaSelect');
  sel.innerHTML = '';
  if (media.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = '(尚未上传素材)';
    opt.value = '';
    sel.appendChild(opt);
  }
  for (const m of media) {
    const opt = document.createElement('option');
    const latest = m.versions[m.versions.length - 1];
    opt.value = m.contentId;
    opt.textContent = `${latest.fileName} · ${m.frameTable.frameCount}帧 · ${m.contentId.slice(0, 8)}… · ${m.versions.length}版`;
    sel.appendChild(opt);
  }
  return media;
}

async function uploadFile(file) {
  setWait(`正在上传并解码帧表：${file.name}`);
  try {
    const data = await api('PUT', `/api/media?name=${encodeURIComponent(file.name)}`, file, true);
    await loadMediaList();
    $('mediaSelect').value = data.media.contentId;
    await openMedia(data.media.contentId);
    if (data.reUpload) {
      flash(`同名/同内容再次上传：已作为新版本挂载到内容身份 ${data.media.contentId.slice(0, 12)}`);
    }
  } catch (e) {
    flash('上传失败：' + e.message, true);
    clearWait();
  }
}

async function openMedia(contentId, annotationId) {
  if (!contentId) return;
  setWait('正在加载媒体与精确帧表…');
  const { media } = await api('GET', `/api/media/${contentId}`);
  state.media = media;
  state.sourceVersionId = media.versions[media.versions.length - 1].versionId;

  const ft = media.frameTable;
  $('video').src = `/api/media/${contentId}/file`;
  $('video').load();

  await new Promise((resolve) => {
    const v = $('video');
    const onLoaded = () => {
      v.removeEventListener('loadedmetadata', onLoaded);
      resolve();
    };
    v.addEventListener('loadedmetadata', onLoaded);
  });

  if (state.engine) state.engine.destroy();
  state.engine = new FrameEngine($('video'), ft);
  state.engine.onStateChange = (s) => renderEngineState(s);
  // Read-only inspection hook for automated frame/wait verification.
  window.__frameReview = {
    get engine() { return state.engine; },
    get media() { return state.media; }
  };
  await refreshAnnotations(false);
  buildTrackOptions();
  renderMeta();

  const idx = new URLSearchParams(location.search).get('frame');
  const openId = annotationId || new URLSearchParams(location.search).get('annotation');
  let target = 0;
  if (openId) {
    const a = state.annotations.find((x) => x.annotationId === openId);
    if (a) target = resolveAnnotationFrame(a);
  } else if (idx !== null) {
    target = Math.min(Number(idx), ft.frameCount - 1);
  }
  await state.engine.seekToFrame(target);
  clearWait();
  startPolling();
  if (openId) highlightAnnotation(openId);
}

/* Resolve a stored annotation to a frame index in THIS frame table.
   Same content → exact PTS. Re-encoded content → nearest within half step. */
function resolveAnnotationFrame(a) {
  const ft = state.media.frameTable;
  const frames = ft.frames;
  const byIndex = frames[a.frameIndex];
  if (byIndex && Math.abs(byIndex.ptsTime - a.ptsTime) <= 1e-6) return a.frameIndex;
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < frames.length; i++) {
    const d = Math.abs(frames[i].ptsTime - a.ptsTime);
    if (d < bestDiff) {
      bestDiff = d;
      best = i;
    }
  }
  const step = best > 0 ? frames[best].time - frames[best - 1].time : 1 / 30;
  if (bestDiff > step / 2 + 1e-9) {
    flash(`注释 ${a.annotationId.slice(0, 6)} 的帧时间在当前版本无可靠对应`, true);
  }
  return best;
}

/* ---------------- waiting overlay ---------------- */

function setWait(text) {
  $('waitOverlay').classList.add('visible');
  $('waitText').textContent = text;
}
function clearWait() {
  $('waitOverlay').classList.remove('visible');
}
function flash(text, isError) {
  const el = $('flash');
  el.textContent = text;
  el.className = 'flash visible' + (isError ? ' error' : '');
  setTimeout(() => el.classList.remove('visible'), 4000);
}

function renderEngineState(s) {
  const badge = $('seekState');
  if (s === 'seeking') {
    badge.textContent = '定位中…等待目标帧解码';
    badge.className = 'state-badge waiting';
    $('waitOverlay').classList.add('visible');
    $('waitText').textContent = '等待目标帧解码到位（当前画面可能仍是旧帧，标注已锁定）';
  } else {
    badge.textContent = '已定位到实际帧';
    badge.className = 'state-badge ready';
    $('waitOverlay').classList.remove('visible');
  }
  renderFrameInfo();
}

function renderMeta() {
  const ft = state.media.frameTable;
  const latestVersion = state.media.versions[state.media.versions.length - 1];
  $('metaBox').innerHTML = `
    <div><b>内容身份</b> <code>${state.media.contentId.slice(0, 16)}…</code></div>
    <div><b>编码尺寸</b> ${ft.codedWidth}×${ft.codedHeight} · 旋转元数据 ${ft.rotation}° ·
        ${ft.isCfr ? `CFR ${ft.frameRate}fps` : 'VFR 变帧率（按真实 PTS 定位）'}</div>
    <div><b>总帧数</b> ${ft.frameCount} · 时长 ${ft.durationSec.toFixed(3)}s · time_base ${ft.timeBase || 'n/a'}</div>
    <div><b>当前版本</b> ${state.sourceVersionId}（${latestVersion.fileName}）</div>`;
}

/* ---------------- frame info / controls ---------------- */

function renderFrameInfo() {
  if (!state.engine) return;
  const ft = state.media.frameTable;
  const idx = state.engine.verifiedFrame;
  const box = $('frameInfo');
  if (idx === null) {
    box.innerHTML = '目标帧尚未确认显示，禁止标注';
    return;
  }
  const f = ft.frames[idx];
  const step = state.engine.estimatedStep(idx);
  const ct = $('video').currentTime;
  const ptsMatch = Math.abs(ct - f.ptsTime) <= step * 0.45 + 1e-9;
  box.innerHTML = `帧 <b>${idx}</b> / ${ft.frameCount - 1}
    · 定位依据 绝对PTS ${f.ptsTime.toFixed(6)}s
    · 相对时间轴 ${fmtTime(f.time)}
    · 帧步进 ~${step.toFixed(6)}s
    · 播放器 currentTime=${ct.toFixed(6)}（与PTS${ptsMatch ? '一致✓' : '不符✗'}，currentTime 不作存储依据）`;
  $('frameInput').value = idx;
  drawOverlay();
  renderAnnotationList();
}

/* ---------------- coordinate mapping ---------------- */

function geometry() {
  const video = $('video');
  const rect = video.getBoundingClientRect();
  const ft = state.media.frameTable;
  const disp = G.displaySize(ft.codedWidth, ft.codedHeight, ft.rotation);
  const fit = G.containRect(disp.width, disp.height, rect.width, rect.height);
  return { rect, fit, rotation: ft.rotation };
}

/* ---------------- overlay drawing ---------------- */

const canvas = $('overlay');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const video = $('video');
  const dpr = window.devicePixelRatio || 1;
  // Match the video's layout box via its offset metrics. The video is
  // flex-centered with sub-pixel getBoundingClientRect positions, so deriving
  // the canvas offset from rect math rounds differently and leaves a 1px gap.
  // offsetLeft/offsetTop are the exact integer layout position the browser
  // assigned the video within the (positioned) stage.
  const cssW = video.offsetWidth;
  const cssH = video.offsetHeight;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  canvas.style.left = video.offsetLeft + 'px';
  canvas.style.top = video.offsetTop + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawOverlay();
}

function drawOverlay() {
  if (!state.engine) return;
  const { rect, fit, rotation } = geometry();
  ctx.clearRect(0, 0, rect.width, rect.height);

  // annotation regions (for the current frame)
  const idx = state.engine.verifiedFrame;
  for (const a of state.annotations) {
    if (state.filterTrack !== 'all' && a.track !== state.filterTrack) continue;
    if (a.frameIndex !== idx) continue;
    const box = G.materialRectToClient(a.region, rect, fit, rotation);
    const isMine = a.author === state.author;
    ctx.lineWidth = 2;
    ctx.strokeStyle = isMine ? '#ff5d5d' : '#4db6ff';
    ctx.fillStyle = isMine ? 'rgba(255,93,93,0.15)' : 'rgba(77,182,255,0.15)';
    ctx.fillRect(box.left - rect.left, box.top - rect.top, box.width, box.height);
    ctx.strokeRect(box.left - rect.left, box.top - rect.top, box.width, box.height);
    const label = `${a.track} · ${a.author}`;
    ctx.font = '12px monospace';
    const tw = ctx.measureText(label).width + 8;
    ctx.fillStyle = isMine ? '#ff5d5d' : '#4db6ff';
    ctx.fillRect(box.left - rect.left, box.top - rect.top - 16, tw, 16);
    ctx.fillStyle = '#101418';
    ctx.fillText(label, box.left - rect.left + 4, box.top - rect.top - 4);
  }

  // active drag
  if (state.drag) {
    const x = Math.min(state.drag.start.x, state.drag.current.x) - rect.left;
    const y = Math.min(state.drag.start.y, state.drag.current.y) - rect.top;
    const w = Math.abs(state.drag.current.x - state.drag.start.x);
    const h = Math.abs(state.drag.current.y - state.drag.start.y);
    ctx.strokeStyle = '#ffd24d';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }
}

/* ---------------- mouse interaction ---------------- */

function eventPoint(e) {
  // FrameGeometry.clientToMaterial subtracts the element rect itself, so it
  // expects absolute viewport client coords, not video-relative deltas.
  return { x: e.clientX, y: e.clientY };
}

function onPointerDown(e) {
  if (!state.engine || state.engine.isWaiting || state.engine.verifiedFrame === null) {
    flash('目标帧未到位，不能在旧帧上标注', true);
    return;
  }
  state.drag = { start: eventPoint(e), current: eventPoint(e) };
  canvas.setPointerCapture(e.pointerId);
}

function onPointerMove(e) {
  if (!state.drag) return;
  state.drag.current = eventPoint(e);
  drawOverlay();
}

async function onPointerUp(e) {
  if (!state.drag) return;
  const drag = state.drag;
  state.drag = null;
  const moved = Math.hypot(drag.current.x - drag.start.x, drag.current.y - drag.start.y);
  if (moved < 6) {
    drawOverlay();
    return;
  }
  const { rect, fit, rotation } = geometry();
  const region = G.clientRectToMaterial(drag.start, drag.current, rect, fit, rotation);
  await createAnnotation(region);
  drawOverlay();
}

async function createAnnotation(region) {
  const idx = state.engine.verifiedFrame;
  if (idx === null) {
    flash('帧未确认，拒绝写入注释', true);
    return;
  }
  const text = $('noteText').value.trim() || '技术注释（无文字）';
  setWait('写入注释（绑定内容身份/轨道/精确帧时间）…');
  try {
    const { annotation } = await api('POST', `/api/media/${state.media.contentId}/annotations`, {
      frameIndex: idx,
      region,
      text,
      track: state.track,
      author: state.author,
      sourceVersionId: state.sourceVersionId
    });
    state.annotations.push(annotation);
    $('noteText').value = '';
    renderAnnotationList();
    flash(`已绑定到帧 ${idx}（pts ${annotation.ptsTime.toFixed(6)}）区域已换算为素材坐标`);
  } catch (err) {
    flash('注释保存失败：' + err.message, true);
  } finally {
    clearWait();
  }
}

/* ---------------- annotation list ---------------- */

function buildTrackOptions() {
  const tracks = Array.from(new Set(['main', ...state.annotations.map((a) => a.track)]));
  for (const sel of [$('trackSelect'), $('filterSelect')]) {
    const cur = sel.value;
    sel.innerHTML = '';
    if (sel === $('filterSelect')) {
      const all = document.createElement('option');
      all.value = 'all';
      all.textContent = '全部轨道';
      sel.appendChild(all);
    }
    for (const t of tracks) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      sel.appendChild(o);
    }
    sel.value = tracks.includes(cur) ? cur : (sel === $('filterSelect') ? 'all' : 'main');
  }
  state.track = $('trackSelect').value;
  state.filterTrack = $('filterSelect').value;
}

function renderAnnotationList() {
  const list = $('annotationList');
  list.innerHTML = '';
  const idx = state.engine ? state.engine.verifiedFrame : null;
  const visible = state.annotations
    .filter((a) => state.filterTrack === 'all' || a.track === state.filterTrack)
    .slice()
    .sort((a, b) => a.frameIndex - b.frameIndex);

  for (const a of visible) {
    const li = document.createElement('div');
    li.className = 'ann' + (a.frameIndex === idx ? ' current' : '');
    li.dataset.id = a.annotationId;
    const here = resolveAnnotationFrame(a);
    li.innerHTML = `
      <div class="ann-head">
        <span class="ann-frame">帧 ${a.frameIndex}</span>
        <span class="ann-track">${a.track}</span>
        <span class="ann-author">${a.author}</span>
      </div>
      <div class="ann-text"></div>
      <div class="ann-meta">
        pts ${a.ptsTime.toFixed(6)} · 帧率 ${a.isCfr ? a.frameRate + 'fps' : 'VFR'}
        · 区域 (${a.region.xn.toFixed(3)},${a.region.yn.toFixed(3)} ${a.region.wn.toFixed(3)}×${a.region.hn.toFixed(3)})
      </div>
      <div class="ann-version" title="来源版本">来源版本：${a.sourceVersionId}<br>来源文件：${a.sourceFileName}</div>
      <div class="ann-actions">
        <button class="locate">定位到此帧</button>
        <a class="share" target="_blank">跨端分享链接</a>
      </div>`;
    li.querySelector('.ann-text').textContent = a.text;
    li.querySelector('.locate').addEventListener('click', () => locateAnnotation(a));
    const url = `${location.origin}/?media=${encodeURIComponent(state.media.contentId)}&annotation=${encodeURIComponent(a.annotationId)}`;
    li.querySelector('.share').href = url;
    list.appendChild(li);
  }
  $('annCount').textContent = `${visible.length} 条注释`;
}

async function locateAnnotation(a) {
  setWait('按内容身份与 PTS 定位到注释帧…');
  const target = resolveAnnotationFrame(a);
  const [shown] = await state.engine.seekToFrame(target);
  clearWait();
  highlightAnnotation(a.annotationId);
  if (shown !== target) flash(`解码器落在相邻帧 ${shown}（目标 ${target}），已重试`, true);
}

function highlightAnnotation(id) {
  renderAnnotationList();
  const el = document.querySelector(`.ann[data-id="${id}"]`);
  if (el) {
    el.classList.add('flash-hl');
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => el.classList.remove('flash-hl'), 2500);
  }
}

/* ---------------- polling (two-user collaboration) ---------------- */

async function refreshAnnotations(redraw = true) {
  if (!state.media) return;
  const { annotations } = await api('GET', `/api/media/${state.media.contentId}/annotations`);
  const before = state.annotations.length;
  state.annotations = annotations;
  buildTrackOptions();
  renderAnnotationList();
  if (redraw) drawOverlay();
  if (before !== annotations.length && before !== 0) flash('收到另一端的新注释');
}

function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => refreshAnnotations(true), 2000);
}

/* ---------------- init ---------------- */

function bindEvents() {
  $('uploadForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = $('fileInput').files[0];
    if (f) uploadFile(f);
  });
  $('mediaSelect').addEventListener('change', (e) => openMedia(e.target.value));
  $('authorInput').addEventListener('change', (e) => {
    state.author = e.target.value || 'reviewer';
    localStorage.setItem('fr-author', state.author);
    drawOverlay();
  });
  $('trackSelect').addEventListener('change', (e) => { state.track = e.target.value; });
  $('filterSelect').addEventListener('change', (e) => {
    state.filterTrack = e.target.value;
    drawOverlay();
    renderAnnotationList();
  });

  $('btnPrev').addEventListener('click', () => state.engine && state.engine.step(-1));
  $('btnNext').addEventListener('click', () => state.engine && state.engine.step(1));
  $('btnGo').addEventListener('click', async () => {
    const n = Number($('frameInput').value);
    if (!Number.isInteger(n)) return;
    setWait(`定位到帧 ${n}…`);
    await state.engine.seekToFrame(n);
    clearWait();
  });
  $('frameInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btnGo').click();
  });
  $('btnPlay').addEventListener('click', () => {
    const v = $('video');
    if (v.paused) v.play(); else v.pause();
  });
  $('video').addEventListener('timeupdate', () => {
    if (state.engine && !state.engine.isWaiting) renderFrameInfo();
  });

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  window.addEventListener('resize', resizeCanvas);
  // The video content box also changes when metadata loads or the flex
  // layout reflows, not only on window resize.
  new ResizeObserver(() => resizeCanvas()).observe($('video'));
  $('video').addEventListener('loadedmetadata', resizeCanvas);

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft') state.engine && state.engine.step(-1);
    if (e.key === 'ArrowRight') state.engine && state.engine.step(1);
  });
}

async function init() {
  $('authorInput').value = state.author;
  bindEvents();
  const media = await loadMediaList();
  const params = new URLSearchParams(location.search);
  const preselect = params.get('media') || (media[0] && media[0].contentId);
  if (preselect) {
    $('mediaSelect').value = preselect;
    await openMedia(preselect, params.get('annotation'));
  }
  resizeCanvas();
}

init().catch((e) => flash('初始化失败：' + e.message, true));
