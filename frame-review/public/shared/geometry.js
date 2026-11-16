/*
 * Shared geometry math, used by both the browser (window.FrameGeometry)
 * and Node (module.exports). Single source of truth for coordinate mapping.
 *
 * Coordinate spaces:
 *   client  : CSS pixels relative to the <video> element box
 *   display : normalized 0..1 in the displayed (post-rotation, letterboxed) frame
 *   material: normalized 0..1 in the coded source frame, before rotation
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.FrameGeometry = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function displaySize(codedWidth, codedHeight, rotation) {
    const swapped = rotation === 90 || rotation === 270;
    return swapped
      ? { width: codedHeight, height: codedWidth }
      : { width: codedWidth, height: codedHeight };
  }

  /* object-fit: contain rect inside an element box, in CSS px */
  function containRect(dispWidth, dispHeight, boxWidth, boxHeight) {
    const scale = Math.min(boxWidth / dispWidth, boxHeight / dispHeight);
    const w = dispWidth * scale;
    const h = dispHeight * scale;
    return { x: (boxWidth - w) / 2, y: (boxHeight - h) / 2, w, h, scale };
  }

  function clamp01(v) {
    return Math.min(1, Math.max(0, v));
  }

  /* normalized display coords -> normalized material coords (inverse rotation) */
  function displayToMaterial(nx, ny, rotation) {
    switch (rotation) {
      case 90:
        return { xn: ny, yn: 1 - nx };
      case 180:
        return { xn: 1 - nx, yn: 1 - ny };
      case 270:
        return { xn: 1 - ny, yn: nx };
      default:
        return { xn: nx, yn: ny };
    }
  }

  /* normalized material coords -> normalized display coords (apply rotation) */
  function materialToDisplay(xn, yn, rotation) {
    switch (rotation) {
      case 90:
        return { xn: 1 - yn, yn: xn };
      case 180:
        return { xn: 1 - xn, yn: 1 - yn };
      case 270:
        return { xn: yn, yn: 1 - xn };
      default:
        return { xn, yn };
    }
  }

  /*
   * Map a client-space point (px inside the element box) to material space.
   * Points landing on the letterbox bars are clamped to the frame edge.
   */
  function clientToMaterial(clientX, clientY, rect, fit, rotation) {
    const xCss = clientX - rect.left;
    const yCss = clientY - rect.top;
    const nx = clamp01((xCss - fit.x) / fit.w);
    const ny = clamp01((yCss - fit.y) / fit.h);
    return displayToMaterial(nx, ny, rotation);
  }

  function materialToClient(xn, yn, rect, fit, rotation) {
    const d = materialToDisplay(xn, yn, rotation);
    return {
      x: rect.left + fit.x + d.xn * fit.w,
      y: rect.top + fit.y + d.yn * fit.h
    };
  }

  /* Transform a material-axis-aligned normalized rect to client-space box */
  function materialRectToClient(region, rect, fit, rotation) {
    const corners = [
      materialToDisplay(region.xn, region.yn, rotation),
      materialToDisplay(region.xn + region.wn, region.yn, rotation),
      materialToDisplay(region.xn, region.yn + region.hn, rotation),
      materialToDisplay(region.xn + region.wn, region.yn + region.hn, rotation)
    ];
    const minX = Math.min(...corners.map((c) => c.xn));
    const maxX = Math.max(...corners.map((c) => c.xn));
    const minY = Math.min(...corners.map((c) => c.yn));
    const maxY = Math.max(...corners.map((c) => c.yn));
    return {
      left: rect.left + fit.x + minX * fit.w,
      top: rect.top + fit.y + minY * fit.h,
      width: (maxX - minX) * fit.w,
      height: (maxY - minY) * fit.h
    };
  }

  /* Client drag rect (two points) to normalized material rect */
  function clientRectToMaterial(p1, p2, rect, fit, rotation) {
    const a = clientToMaterial(p1.x, p1.y, rect, fit, rotation);
    const b = clientToMaterial(p2.x, p2.y, rect, fit, rotation);
    const xn = Math.min(a.xn, b.xn);
    const yn = Math.min(a.yn, b.yn);
    return {
      xn,
      yn,
      wn: Math.abs(b.xn - a.xn),
      hn: Math.abs(b.yn - a.yn)
    };
  }

  return {
    displaySize,
    containRect,
    displayToMaterial,
    materialToDisplay,
    clientToMaterial,
    materialToClient,
    materialRectToClient,
    clientRectToMaterial
  };
});
