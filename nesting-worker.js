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

  const halfGap  = gap / 2;
  const step     = Math.max(2, Math.min(bb.w, bb.h) / 10);
  let best = null, bestScore = Infinity;

  // ── Груб скан ────────────────────────────────────────────
  for (let y = margin; y <= maxY; y += step) {
    if (deadline && Date.now() >= deadline) return null;
    for (let x = margin; x <= maxX; x += step) {
      const score = y * sw * 2 + x;
      if (score >= bestScore) continue;
      if (_validPos(poly, placed, x, y, halfGap, margin, sw, sh)) {
        bestScore = score;
        best = { x, y };
        break;  // BL: первото намерено в ред е достатъчно, мини на следващ ред
      }
    }
  }
  if (!best) return null;

  // ── Фино прецизиране ─────────────────────────────────────
  const fine = Math.max(0.5, step / 5);
  const range = step * 1.5;
  for (let y = Math.max(margin, best.y - range); y <= Math.min(maxY, best.y + range); y += fine) {
    if (deadline && Date.now() >= deadline) return best;
    for (let x = Math.max(margin, best.x - range); x <= Math.min(maxX, best.x + range); x += fine) {
      const score = y * sw * 2 + x;
      if (score >= bestScore) continue;
      if (_validPos(poly, placed, x, y, halfGap, margin, sw, sh)) {
        bestScore = score;
        best = { x, y };
      }
    }
  }

  return best;
}

function _validPos(poly, placed, tx, ty, halfGap, margin, sw, sh) {
  const moved = _translatePoly(poly, tx, ty);
  const bb    = _getBBox(moved);

  if (bb.minX < margin || bb.minY < margin ||
      bb.maxX > sw - margin || bb.maxY > sh - margin) return false;

  const expNew = halfGap > 0 ? _expandPoly(moved, halfGap) : moved;

  for (const p of placed) {
    const bb2 = _getBBox(p.poly);
    // Бърза AABB проверка
    if (bb.minX > bb2.maxX + halfGap * 2 || bb.maxX < bb2.minX - halfGap * 2 ||
        bb.minY > bb2.maxY + halfGap * 2 || bb.maxY < bb2.minY - halfGap * 2) continue;
    const expP = halfGap > 0 ? _expandPoly(p.poly, halfGap) : p.poly;
    if (_satOverlap(expNew, expP)) return false;
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

/** Прост radial expand — достатъчен за gap enforcement */
function _expandPoly(poly, d) {
  if (d <= 0) return poly;
  const cx = poly.reduce((s,p)=>s+p.x,0)/poly.length;
  const cy = poly.reduce((s,p)=>s+p.y,0)/poly.length;
  return poly.map(p => {
    const dx=p.x-cx, dy=p.y-cy, len=Math.sqrt(dx*dx+dy*dy)||1;
    return { x: p.x+dx/len*d, y: p.y+dy/len*d };
  });
}

/** SAT — Separating Axis Theorem */
function _satOverlap(A, B) {
  for (const poly of [A, B]) {
    for (let i=0; i<poly.length; i++) {
      const j=(i+1)%poly.length;
      const nx=poly[j].y-poly[i].y, ny=poly[i].x-poly[j].x;
      let minA=Infinity,maxA=-Infinity,minB=Infinity,maxB=-Infinity;
      for (const p of A) { const d=p.x*nx+p.y*ny; if(d<minA)minA=d; if(d>maxA)maxA=d; }
      for (const p of B) { const d=p.x*nx+p.y*ny; if(d<minB)minB=d; if(d>maxB)maxB=d; }
      if (minA > maxB || minB > maxA) return false;
    }
  }
  return true;
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
