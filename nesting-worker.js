/**
 * nesting-worker.js  v2.0
 * ─────────────────────────────────────────────────────────────
 * Самостоятелна подпрограма за нестинг изчисления.
 * Работи като Web Worker — напълно изолирана от UI нишката.
 *
 * ПРОТОКОЛ (postMessage):
 *
 * → { type:'start',  data: NestingRequest  }  — стартирай
 * → { type:'stop'                           }  — прекъсни
 *
 * ← { type:'progress', data: { pct, msg }  }  — прогрес 0-100
 * ← { type:'log',      data: string        }  — debug лог
 * ← { type:'result',   data: NestingResult }  — финален резултат
 * ← { type:'error',    data: string        }  — грешка
 *
 * NestingRequest {
 *   pieces: [{
 *     id, partId, name, color,
 *     poly: [{x,y}],       ← outer contour (normalized to origin)
 *     holes: [[{x,y}]],    ← inner holes (optional, for future toolpath)
 *     bbox: {w,h},
 *     rotationLock: bool
 *   }],
 *   sheets: [{
 *     id, name, width, height, qty
 *   }],
 *   settings: {
 *     partGap:        number,   ← мм между детайлите
 *     sheetBorderGap: number,   ← мм отстояние от ръба
 *     rotation:       'none'|'90'|'45'|'free',
 *     rotStep:        number,   ← градуси при 'free'
 *     quality:        0-100,    ← 0=fast, 100=quality
 *   }
 * }
 *
 * NestingResult {
 *   sheets: [{
 *     sheetId, sheet,
 *     placements: [{
 *       ...piece,
 *       poly: [{x,y}],   ← финална позиция
 *       angle: number,   ← приложена ротация
 *     }],
 *     efficiency: number  ← % запълване
 *   }],
 *   totalPlaced:      number,
 *   totalPieces:      number,
 *   unplaced:         piece[],
 *   overallEfficiency: number
 * }
 */

'use strict';

// ── Управление на жизнения цикъл ─────────────────────────────
let _stopped = false;

self.onmessage = async (e) => {
  if (e.data.type === 'stop')  { _stopped = true;  return; }
  if (e.data.type === 'start') {
    _stopped = false;
    try {
      await _runNesting(e.data.data);
    } catch (err) {
      self.postMessage({ type: 'error', data: err.message });
    }
  }
};

// ── Комуникационни helpers ────────────────────────────────────
const _log  = msg => self.postMessage({ type: 'log',      data: msg });
const _prog = (pct, msg) => self.postMessage({ type: 'progress', data: { pct, msg } });

// ══════════════════════════════════════════════════════════════
// ЯДРО НА НЕСТИНГА
// ══════════════════════════════════════════════════════════════
async function _runNesting({ pieces, sheets, settings }) {
  _log('Нестинг стартиран...');
  _prog(2, 'Подготовка...');

  settings = settings || {};
  const gap    = settings.partGap        || 0;
  const margin = settings.sheetBorderGap || 0;

  // Качество = времеви бюджет.
  // 0%  = 1 минута, 50% ≈ 2 минути, 100% = 3 минути.
  const quality = Math.max(0, Math.min(100, Number(settings.quality) || 0));
  const timeLimitMs = Math.max(60000, Math.min(180000,
    Number(settings.timeLimitMs) ||
    Number(settings.nestingTimeMs) ||
    ((Number(settings.nestingTime) || 0) * 1000) ||
    (60000 + quality * 1200)
  ));
  const startedAt = Date.now();
  const deadline  = startedAt + timeLimitMs;

  const timeLeftSec = () => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  const timeUp = () => Date.now() >= deadline;

  _log(`Времеви лимит: ${Math.round(timeLimitMs / 1000)} сек.`);
  _prog(3, `Лимит: ${Math.round(timeLimitMs / 1000)} сек.`);

  // ── Ротационни ъгли ──────────────────────────────────────
  const rotAngles = _buildRotAngles(settings);

  // ── Сортиране: най-голямото парче първо ───────────────────
  const sorted = [...pieces].sort((a, b) => b.bbox.w * b.bbox.h - a.bbox.w * a.bbox.h);
  const sheetQueue = _expandSheetQueue(sheets);

  const allSheets = [];
  let remaining   = [...sorted];
  let sheetIdx    = 0;
  const total     = sorted.length;
  let stoppedByTime = false;

  function finish(reason) {
    const totalPlaced = allSheets.reduce((s, sh) => s + sh.placements.length, 0);
    const totalArea   = allSheets.reduce((s, sh) => s + sh.sheet.width * sh.sheet.height, 0);
    const usedArea    = allSheets.reduce((s, sh) =>
      s + sh.placements.reduce((ss, p) => {
        const bb = _getBBox(p.poly); return ss + bb.w * bb.h;
      }, 0), 0);
    const overallEfficiency = totalArea > 0 ? usedArea / totalArea * 100 : 0;

    const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
    const msg = reason === 'time'
      ? `Готово по времеви лимит (${elapsedSec} сек.)`
      : reason === 'sheets'
        ? 'Готово — няма повече налични листа'
        : 'Готово!';

    _prog(100, msg);
    _log(`✓ ${totalPlaced}/${total} детайла · ${allSheets.length} листа · ${overallEfficiency.toFixed(1)}% ефективност · ${elapsedSec} сек.`);

    self.postMessage({
      type: 'result',
      data: {
        sheets: allSheets,
        totalPlaced,
        totalPieces: total,
        unplaced: remaining,
        overallEfficiency,
        stoppedByTime: reason === 'time',
        stoppedBySheets: reason === 'sheets',
        elapsedSec,
        timeLimitSec: Math.round(timeLimitMs / 1000),
      }
    });
  }

  // ── Основен цикъл: лист по лист ──────────────────────────
  outer:
  while (remaining.length > 0 && sheetIdx < sheetQueue.length) {
    if (_stopped) { _log('Спряно от потребителя'); return; }
    if (timeUp()) { stoppedByTime = true; break; }

    const sheetDef = sheetQueue[sheetIdx];
    const sw = sheetDef.width, sh = sheetDef.height;
    _log(`Лист ${sheetIdx + 1} (${sw}×${sh}мм) — ${remaining.length} детайла...`);

    const placed   = [];
    const unplaced = [];

    for (let pi = 0; pi < remaining.length; pi++) {
      if (_stopped) return;
      if (timeUp()) {
        unplaced.push(...remaining.slice(pi));
        stoppedByTime = true;
        break;
      }

      const piece = remaining[pi];
      const basePct = ((total - remaining.length + pi) / Math.max(1,total)) * 82 + 5;
      const timePct = Math.min(95, ((Date.now() - startedAt) / timeLimitMs) * 95);
      const pct = Math.round(Math.max(basePct, timePct));
      if (pi % 3 === 0) _prog(pct, `Лист ${sheetIdx+1}: ${piece.name} · остават ~${timeLeftSec()} сек.`);

      // Намери най-добрата позиция при всички позволени ъгли
      let best = null;

      for (const angle of (piece.rotationLock ? [0] : rotAngles)) {
        if (timeUp()) { stoppedByTime = true; break; }

        const rotated = angle === 0
          ? _normalizeToOrigin(piece.poly)
          : _normalizeToOrigin(_rotatePoly(piece.poly, angle));

        const bb = _getBBox(rotated);
        if (bb.w > sw - 2*margin || bb.h > sh - 2*margin) continue;

        const pos = _findPosition(placed, rotated, sw, sh, gap, margin, deadline);
        if (!pos) continue;

        const score = pos.y * sw * 2 + pos.x;
        if (!best || score < best.score)
          best = { pos, poly: rotated, angle, score };
      }

      if (stoppedByTime) {
        unplaced.push(piece, ...remaining.slice(pi + 1));
        break;
      }

      if (best) {
        placed.push({
          ...piece,
          poly:    _translatePoly(best.poly, best.pos.x, best.pos.y),
          angle:   best.angle,
          sheetId: sheetDef.id,
        });
      } else {
        unplaced.push(piece);
      }

      // Yield за да не блокираме Worker event loop
      if (pi % 10 === 0) await _yield();
    }

    if (placed.length) {
      const efficiency = _sheetEfficiency(placed, sw, sh);
      allSheets.push({ sheetId: sheetDef.id, sheet: sheetDef, placements: placed, efficiency });
      _log(`Лист ${sheetIdx+1}: ${placed.length} бр., ${efficiency.toFixed(1)}% ефективност`);
    }

    remaining = unplaced;
    sheetIdx++;

    if (stoppedByTime) break outer;
  }

  await _yield();
  finish(stoppedByTime ? 'time' : (remaining.length ? 'sheets' : 'done'));
}



function _expandSheetQueue(sheets) {
  const queue = [];
  for (const sheet of Array.isArray(sheets) ? sheets : []) {
    const qty = Math.max(1, Math.floor(Number(sheet.qty) || 1));
    for (let copy = 0; copy < qty; copy++) {
      queue.push({
        ...sheet,
        id: `${sheet.id}_${copy + 1}`,
        sourceSheetId: sheet.id,
        copyNo: copy + 1,
        qty: 1,
      });
    }
  }
  return queue;
}

// ══════════════════════════════════════════════════════════════
// ПОЗИЦИОНИРАНЕ — NFP Bottom-Left Fill
// ══════════════════════════════════════════════════════════════

/**
 * _findPosition — намира най-ниско-вляво свободно място.
 * Двустепенно сканиране: груб проход + фино прецизиране.
 */
function _findPosition(placed, poly, sw, sh, gap, margin, deadline) {
  const bb       = _getBBox(poly);
  const maxX     = sw - margin - bb.w;
  const maxY     = sh - margin - bb.h;
  if (maxX < margin || maxY < margin) return null;

  const safeGap = Math.max(0, Number(gap) || 0);
  const step    = Math.max(2, Math.min(bb.w, bb.h) / 10);
  let best = null, bestScore = Infinity;

  const tryPos = (x, y) => {
    x = Math.min(maxX, Math.max(margin, x));
    y = Math.min(maxY, Math.max(margin, y));
    const score = y * sw * 2 + x;
    if (score >= bestScore) return;
    if (_validPos(poly, placed, x, y, safeGap, margin, sw, sh)) {
      bestScore = score;
      best = { x, y };
    }
  };

  // ── Точни BL кандидати ────────────────────────────────────
  // Сканирането със стъпка може да пропусне позиции, които лежат точно до
  // вече поставен детайл (например 2×50мм в 100мм лист). Затова първо
  // проверяваме координати, образувани от десните/горните ръбове на
  // поставените детайли плюс желания gap.
  const xs = new Set([margin, maxX]);
  const ys = new Set([margin, maxY]);
  for (const p of placed) {
    const pbb = _getBBox(p.poly);
    xs.add(pbb.maxX + safeGap);
    ys.add(pbb.maxY + safeGap);
  }
  const xList = [...xs].filter(x => x >= margin - 1e-7 && x <= maxX + 1e-7).sort((a, b) => a - b);
  const yList = [...ys].filter(y => y >= margin - 1e-7 && y <= maxY + 1e-7).sort((a, b) => a - b);
  for (const y of yList) {
    if (deadline && Date.now() >= deadline) return best;
    for (const x of xList) tryPos(x, y);
  }

  // ── Груб скан ────────────────────────────────────────────
  for (let y = margin; y <= maxY + 1e-7; y += step) {
    if (deadline && Date.now() >= deadline) return best;
    const yy = Math.min(y, maxY);
    for (let x = margin; x <= maxX + 1e-7; x += step) {
      const xx = Math.min(x, maxX);
      tryPos(xx, yy);
      if (best && Math.abs(best.y - yy) < 1e-7) break; // BL: първото в реда стига
    }
  }
  if (!best) return null;

  // ── Фино прецизиране ─────────────────────────────────────
  const fine = Math.max(0.5, step / 5);
  const range = step * 1.5;
  for (let y = Math.max(margin, best.y - range); y <= Math.min(maxY, best.y + range) + 1e-7; y += fine) {
    if (deadline && Date.now() >= deadline) return best;
    for (let x = Math.max(margin, best.x - range); x <= Math.min(maxX, best.x + range) + 1e-7; x += fine) {
      tryPos(Math.min(x, maxX), Math.min(y, maxY));
    }
  }

  return best;
}

function _validPos(poly, placed, tx, ty, gap, margin, sw, sh) {
  const moved = _translatePoly(poly, tx, ty);
  const bb    = _getBBox(moved);
  const safeGap = Math.max(0, Number(gap) || 0);

  if (bb.minX < margin || bb.minY < margin ||
      bb.maxX > sw - margin || bb.maxY > sh - margin) return false;

  for (const p of placed) {
    const bb2 = _getBBox(p.poly);
    // Бърза AABB проверка: ако по една ос има поне gap разстояние, няма конфликт.
    if (bb.maxX + safeGap <= bb2.minX || bb2.maxX + safeGap <= bb.minX ||
        bb.maxY + safeGap <= bb2.minY || bb2.maxY + safeGap <= bb.minY) continue;

    if (_polygonsOverlap(moved, p.poly)) return false;
    if (safeGap > 0 && _polygonDistance(moved, p.poly) < safeGap - 1e-7) return false;
  }
  return true;
}

// ══════════════════════════════════════════════════════════════
// ГЕОМЕТРИЯ  (изолирана — не зависи от DXFParser)
// ══════════════════════════════════════════════════════════════
function _getBBox(pts) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for (const p of pts) {
    if(p.x<minX)minX=p.x; if(p.y<minY)minY=p.y;
    if(p.x>maxX)maxX=p.x; if(p.y>maxY)maxY=p.y;
  }
  return { minX,minY,maxX,maxY, w:maxX-minX, h:maxY-minY };
}

function _normalizeToOrigin(poly) {
  const bb = _getBBox(poly);
  return poly.map(p => ({ x: p.x - bb.minX, y: p.y - bb.minY }));
}

function _translatePoly(poly, tx, ty) {
  return poly.map(p => ({ x: p.x + tx, y: p.y + ty }));
}

function _rotatePoly(poly, deg) {
  const r = deg * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  return poly.map(p => ({ x: p.x*cos - p.y*sin, y: p.x*sin + p.y*cos }));
}

function _polygonsOverlap(A, B) {
  for (let i = 0; i < A.length; i++) {
    const a1 = A[i], a2 = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      const b1 = B[j], b2 = B[(j + 1) % B.length];
      if (_segmentsProperIntersect(a1, a2, b1, b2)) return true;
    }
  }
  if (A.some(pt => _pointInPolyStrict(pt, B)) || B.some(pt => _pointInPolyStrict(pt, A))) return true;
  if (_edgeMidpoints(A).some(pt => _pointInPolyStrict(pt, B)) ||
      _edgeMidpoints(B).some(pt => _pointInPolyStrict(pt, A))) return true;
  return _samePolygonFootprint(A, B);
}

function _edgeMidpoints(poly) {
  return poly.map((p, i) => {
    const q = poly[(i + 1) % poly.length];
    return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  });
}

function _samePolygonFootprint(A, B) {
  return A.every(pt => _pointOnPolyBoundary(pt, B)) && B.every(pt => _pointOnPolyBoundary(pt, A));
}

function _pointOnPolyBoundary(pt, poly) {
  for (let i = 0; i < poly.length; i++) {
    if (_pointOnSegment(pt, poly[i], poly[(i + 1) % poly.length])) return true;
  }
  return false;
}

function _polygonDistance(A, B) {
  if (_polygonsOverlap(A, B)) return 0;
  let min = Infinity;
  for (let i = 0; i < A.length; i++) {
    const a1 = A[i], a2 = A[(i + 1) % A.length];
    for (let j = 0; j < B.length; j++) {
      const b1 = B[j], b2 = B[(j + 1) % B.length];
      min = Math.min(min, _segmentDistance(a1, a2, b1, b2));
      if (min <= 1e-7) return 0;
    }
  }
  return min;
}

function _segmentsProperIntersect(a, b, c, d) {
  const o1 = _orient(a, b, c);
  const o2 = _orient(a, b, d);
  const o3 = _orient(c, d, a);
  const o4 = _orient(c, d, b);
  return ((o1 > 1e-7 && o2 < -1e-7) || (o1 < -1e-7 && o2 > 1e-7)) &&
         ((o3 > 1e-7 && o4 < -1e-7) || (o3 < -1e-7 && o4 > 1e-7));
}

function _pointInPolyStrict(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (_pointOnSegment(pt, a, b)) return false;
    const crosses = (a.y > pt.y) !== (b.y > pt.y);
    if (crosses) {
      const x = (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x;
      if (x > pt.x) inside = !inside;
    }
  }
  return inside;
}

function _segmentDistance(a, b, c, d) {
  if (_segmentsProperIntersect(a, b, c, d)) return 0;
  return Math.min(
    _pointSegmentDistance(a, c, d),
    _pointSegmentDistance(b, c, d),
    _pointSegmentDistance(c, a, b),
    _pointSegmentDistance(d, a, b)
  );
}

function _pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function _pointOnSegment(p, a, b) {
  if (Math.abs(_orient(a, b, p)) > 1e-7) return false;
  return p.x >= Math.min(a.x, b.x) - 1e-7 && p.x <= Math.max(a.x, b.x) + 1e-7 &&
         p.y >= Math.min(a.y, b.y) - 1e-7 && p.y <= Math.max(a.y, b.y) + 1e-7;
}

function _orient(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function _sheetEfficiency(placements, sw, sh) {
  const sheetArea = sw * sh;
  if (!sheetArea) return 0;
  const used = placements.reduce((s,p)=>{const b=_getBBox(p.poly);return s+b.w*b.h;},0);
  return used / sheetArea * 100;
}

// ══════════════════════════════════════════════════════════════
// НАСТРОЙКИ
// ══════════════════════════════════════════════════════════════
function _buildRotAngles(settings) {
  const { rotation, rotStep } = settings;
  if (!rotation || rotation === 'none') return [0];
  if (rotation === '90')  return [0, 90, 180, 270];
  if (rotation === '45')  return [0, 45, 90, 135, 180, 225, 270, 315];
  // 'free' — стъпка rotStep градуса
  const step = Math.max(1, rotStep || 3);
  return Array.from({ length: Math.floor(360 / step) }, (_, i) => i * step);
}

// ══════════════════════════════════════════════════════════════
// UTILS
// ══════════════════════════════════════════════════════════════
const _yield = () => new Promise(r => setTimeout(r, 0));
