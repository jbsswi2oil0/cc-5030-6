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
  pendingOpenId: null,
  selectedAnnotationId: null,
  editingId: null,
  lastAnchorResult: null
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
  state.selectedAnnotationId = null;
  cancelEdit();
  renderAnchorState(null);
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
  await loadAnchorTargets();

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
  if (openId) {
    const opened = state.annotations.find((x) => x.annotationId === openId);
    if (opened) selectAnnotation(opened);
    highlightAnnotation(openId);
  } else {
    renderAnchorPanel(null);
  }
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

function syncOverlayBox() {
  const video = $('video');
  const dpr = window.devicePixelRatio || 1;
  // Match the video's layout box via its offset metrics. The video is
  // flex-centered with sub-pixel getBoundingClientRect positions, so deriving
  // the canvas offset from rect math rounds differently and leaves a 1px gap.
  // offsetLeft/offsetTop are the exact integer layout position the browser
  // assigned the video within the (positioned) stage.
  const cssW = video.offsetWidth;
  const cssH = video.offsetHeight;
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  const left = video.offsetLeft + 'px';
  const top = video.offsetTop + 'px';
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  if (canvas.style.width !== cssW + 'px') canvas.style.width = cssW + 'px';
  if (canvas.style.height !== cssH + 'px') canvas.style.height = cssH + 'px';
  if (canvas.style.left !== left) canvas.style.left = left;
  if (canvas.style.top !== top) canvas.style.top = top;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resizeCanvas() {
  syncOverlayBox();
  drawOverlay();
}

function drawOverlay() {
  if (!state.engine) return;
  // A flex reflow (e.g. meta text wrapping or font load) can move the video
  // without changing its size, which a ResizeObserver on the video misses.
  // Re-read the layout box on every draw so the overlay can never stay on a
  // stale offset.
  syncOverlayBox();
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
  // A region drag always creates a new annotation. Leaving an edit open would
  // silently discard the edited text, so end editing first and say so.
  if (state.editingId) {
    cancelEdit();
    flash('已退出编辑：画面框选始终创建新注释');
  }
  const text = $('noteText').value.trim() || '技术注释（无文字）';
  setWait('写入注释（绑定内容身份/轨道/精确帧时间）…');
  try {
    const { annotation } = await api('POST', `/api/media/${state.media.contentId}/annotations`, {
      frameIndex: idx,
      verifiedFrameIndex: state.engine.verifiedFrame,
      region,
      text,
      track: state.track,
      author: state.author,
      sourceVersionId: state.sourceVersionId
    });
    state.annotations.push(annotation);
    $('noteText').value = '';
    renderAnnotationList();
    selectAnnotation(annotation);
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
    li.className = 'ann' + (a.frameIndex === idx ? ' current' : '')
      + (a.annotationId === state.selectedAnnotationId ? ' selected' : '');
    li.dataset.id = a.annotationId;
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
      <div class="ann-anchors"></div>
      <div class="ann-version" title="来源版本">来源版本：${a.sourceVersionId}<br>来源文件：${a.sourceFileName}</div>
      <div class="ann-actions">
        <button class="locate">定位到此帧</button>
        <button class="edit">编辑注释</button>
        <a class="share" target="_blank">跨端分享链接</a>
      </div>`;
    li.querySelector('.ann-text').textContent = a.text;
    li.querySelector('.ann-anchors').innerHTML = anchorSummary(a);
    li.querySelector('.locate').addEventListener('click', () => locateAnnotation(a));
    li.querySelector('.edit').addEventListener('click', () => startEdit(a));
    const url = `${location.origin}/?media=${encodeURIComponent(state.media.contentId)}&annotation=${encodeURIComponent(a.annotationId)}`;
    li.querySelector('.share').href = url;
    list.appendChild(li);
  }
  $('annCount').textContent = `${visible.length} 条注释`;
}

function anchorSummary(a) {
  if (!a.anchors) return '<span class="bad">无锚点（旧注释）</span>';
  const t = a.anchors.time;
  const c = a.anchors.content;
  const check = a.anchorCheck || {};
  const timeCheck = check.time ? (check.time.reliable ? '写入自检可靠' : '写入自检不可靠') : '写入自检缺失';
  return `<span class="ok">时间</span> pts ${t.ptsTime.toFixed(6)} · ${timeCheck}`
    + ` · <span class="ok">签名</span> ${c.algorithm} 阈值 ${c.threshold}`;
}

function startEdit(a) {
  state.editingId = a.annotationId;
  $('noteText').value = a.text;
  $('noteText').focus();
  $('btnSaveEdit').hidden = false;
  $('btnCancelEdit').hidden = false;
  $('uploadForm').classList.add('editing');
  flash(`正在编辑帧 ${a.frameIndex} 的注释；帧锚点保持不变`);
}

function cancelEdit() {
  state.editingId = null;
  $('noteText').value = '';
  $('btnSaveEdit').hidden = true;
  $('btnCancelEdit').hidden = true;
}

async function saveEdit() {
  const id = state.editingId;
  if (!id) return;
  try {
    const { annotation } = await api('PATCH', `/api/media/${state.media.contentId}/annotations/${id}`, {
      text: $('noteText').value,
      track: state.track,
      author: state.author
    });
    const i = state.annotations.findIndex((x) => x.annotationId === id);
    if (i >= 0) state.annotations[i] = annotation;
    cancelEdit();
    renderAnnotationList();
    drawOverlay();
    flash('注释已更新（帧与两种锚点未变）');
  } catch (err) {
    flash('注释更新失败：' + err.message, true);
  }
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

/* ---------------- anchor comparison panel ---------------- */

async function loadAnchorTargets() {
  const { media } = await api('GET', '/api/media');
  const sel = $('anchorTargetSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  for (const m of media) {
    const opt = document.createElement('option');
    opt.value = m.contentId;
    const latest = m.versions[m.versions.length - 1];
    opt.textContent = `${latest.fileName} · ${m.frameTable.frameCount}帧 · ${m.contentId.slice(0, 8)}…`;
    sel.appendChild(opt);
  }
  if (sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
  else if (state.media) sel.value = state.media.contentId;
}

function selectAnnotation(a) {
  state.selectedAnnotationId = a.annotationId;
  renderAnchorPanel(a);
  renderAnnotationList();
}

function renderAnchorPanel(a) {
  $('btnCompare').disabled = !a;
  $('anchorTarget').textContent = a
    ? `注释 ${a.annotationId.slice(0, 6)} · 来源帧 ${a.frameIndex} · 轨道 ${a.track}`
    : '未选择注释';
  if (!a) {
    $('timeAnchorCard').querySelector('.anchor-body').textContent = '选择一条注释后显示定位结果';
    $('contentAnchorCard').querySelector('.anchor-body').textContent = '选择一条注释后显示定位结果';
    return;
  }
  if (!a.anchors) {
    const legacy = '<span class="bad">旧注释没有锚点；无法用两种定位器复算，需重新标注。</span>';
    $('timeAnchorCard').querySelector('.anchor-body').innerHTML = legacy;
    $('contentAnchorCard').querySelector('.anchor-body').innerHTML = legacy;
    return;
  }
  const check = a.anchorCheck;
  const t = check && check.time;
  const c = check && check.content;
  const statusText = c
    ? ({ resolved: '唯一', ambiguous: '歧义', 'not-found': '无候选' }[c.status] || c.status)
    : '';
  $('timeAnchorCard').querySelector('.anchor-body').innerHTML = t
    ? `<div>帧内区间 ${a.anchors.time.intervalSec.toFixed(6)}s · 时基 <code>${a.anchors.time.timeBase}</code></div>
       <div>写入自检：<span class="${t.reliable ? 'ok' : 'bad'}">${t.reliable ? 'PTS 精确命中' : '不可靠'}</span>（${t.method}）</div>
       <div>时间轴指纹一致：${t.timelinePreserved ? '<span class="ok">是</span>' : '<span class="bad">否</span>'}</div>`
    : '<span class="bad">缺少写入自检结果</span>';
  $('contentAnchorCard').querySelector('.anchor-body').innerHTML = c
    ? `<div>算法 <code>${a.anchors.content.algorithm}</code> · 阈值 <code>${a.anchors.content.threshold}</code></div>
       <div>写入自检：候选 ${c.candidateCount} 个 · 状态 <span class="${c.status === 'resolved' ? 'ok' : 'warn'}">${statusText}</span></div>
       <div class="anchor-candidates">${c.candidates.map((x) => `帧${x.frameIndex} d=${x.distance.toFixed(3)}`).join(' · ') || '无候选'}</div>`
    : '<span class="bad">缺少写入自检结果</span>';
  renderAnchorState(null);
}

function renderAnchorState(result, error) {
  const el = $('anchorCompareState');
  if (error) {
    el.innerHTML = `<span class="bad">定位失败：${error}</span>`;
    return;
  }
  if (!result) {
    el.textContent = '尚未对目标素材重新定位';
    return;
  }
  const t = result.result && result.result.time;
  const c = result.result && result.result.content;
  if (!t || !c) {
    el.innerHTML = `<span class="bad">${result.error || '目标缺少锚点结果'}</span>`;
    return;
  }
  const timeText = t.reliable
    ? `<span class="ok">可靠</span> 帧 ${t.frameIndex}`
    : `<span class="bad">不可靠</span> 最近帧 ${t.frameIndex}（${t.method}）`;
  const contentText = c.status === 'resolved'
    ? `<span class="ok">唯一</span> 帧 ${c.frameIndex}（${c.candidateCount} 候选）`
    : c.status === 'ambiguous'
      ? `<span class="warn">歧义 ${c.ambiguity} 个候选</span>（首候选帧 ${c.frameIndex}）`
      : `<span class="bad">无候选</span>`;
  el.innerHTML = `时间锚点：${timeText} ｜ 签名锚点：${contentText}`;
}

async function compareAnchors() {
  const a = state.annotations.find((x) => x.annotationId === state.selectedAnnotationId);
  if (!a) {
    flash('请先在注释列表中选择一条注释', true);
    return;
  }
  const target = $('anchorTargetSelect').value;
  if (!target) return;
  $('anchorCompareState').textContent = '重新定位中…';
  try {
    const r = await api('GET', `/api/media/${state.media.contentId}/annotations/${a.annotationId}?target=${encodeURIComponent(target)}`);
    state.lastAnchorResult = r;
    renderAnchorState(r);
    const t = r.result && r.result.time;
    // Only a reliable time hit is allowed to move the review canvas. An
    // unreliable hit (cut/re-timed target) names a frame too, but seeking to
    // it would present the wrong picture as if it were the annotation.
    if (t && t.reliable) {
      setWait('按时间锚点结果定位到目标帧…');
      await state.engine.seekToFrame(t.frameIndex);
      clearWait();
      flash(`已按可靠时间锚点定位到帧 ${t.frameIndex}；签名结果见锚点面板`);
    } else if (t) {
      flash('时间锚点不可靠，未移动审阅画面；请查看锚点面板中的候选帧', true);
    } else {
      flash('锚点结果缺少时间定位，未移动审阅画面', true);
    }
  } catch (err) {
    renderAnchorState(null, err.message);
    flash('锚点对照失败：' + err.message, true);
  }
}

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
  $('btnSaveEdit').addEventListener('click', saveEdit);
  $('btnCancelEdit').addEventListener('click', cancelEdit);
  $('btnCompare').addEventListener('click', compareAnchors);
  $('annotationList').addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    const card = e.target.closest('.ann');
    if (!card) return;
    const a = state.annotations.find((x) => x.annotationId === card.dataset.id);
    if (a) selectAnnotation(a);
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
  await loadAnchorTargets();
  resizeCanvas();
}

init().catch((e) => flash('初始化失败：' + e.message, true));
