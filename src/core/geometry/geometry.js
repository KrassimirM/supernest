/*
 * Shared SuperNest geometry helpers.
 *
 * UMD-style export keeps the helpers available to browser scripts,
 * CommonJS consumers, and worker-like globals without forcing ES modules.
 */
(function (global) {
  'use strict';

  function getBBox(pts) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }

    return {
      minX,
      minY,
      maxX,
      maxY,
      w: maxX - minX,
      h: maxY - minY,
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
    };
  }

  function normalizeToOrigin(pts) {
    const bb = getBBox(pts);
    return pts.map(p => ({ x: p.x - bb.minX, y: p.y - bb.minY }));
  }

  function translatePoly(poly, tx, ty) {
    return poly.map(p => ({ x: p.x + tx, y: p.y + ty }));
  }

  function rotatePoly(poly, deg) {
    const r = deg * Math.PI / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    return poly.map(p => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }));
  }

  function polyArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    return a / 2;
  }

  function pointInPolygon(px, py, pts) {
    let ins = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x;
      const yi = pts[i].y;
      const xj = pts[j].x;
      const yj = pts[j].y;
      if (((yi > py) !== (yj > py)) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  }

  function pointInPoly(point, poly) {
    return pointInPolygon(point.x, point.y, poly);
  }

  const api = {
    getBBox,
    bbox: getBBox,
    normalizeToOrigin,
    normalize: normalizeToOrigin,
    translatePoly,
    translate: translatePoly,
    rotatePoly,
    rotate: rotatePoly,
    polyArea,
    polygonArea: polyArea,
    pointInPolygon,
    pointInPoly,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.SuperNestGeometry = global.SuperNestGeometry || api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
