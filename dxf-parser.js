/**
 * dxf-parser.js  v4.0
 * ─────────────────────────────────────────────────────────────
 * Standalone DXF parser. No UI dependencies.
 * Works in browser, Node.js, Web Worker.
 *
 * KEY FIXES vs v2:
 *  • LWPOLYLINE bulge: per-vertex association (not array-index)
 *  • LINE chaining: correct endpoint matching (sp[0] not sp)
 *  • Normalize AFTER chaining (not per-shape before)
 *  • Inner/outer detection via containment tree (from cnc_cam_v9)
 *  • Auto-detects nesting-result files (sheet+parts layout)
 *
 * parse(text) → {
 *   parts:    [{ outerPoly, holes[], bbox, area, layer, poly }]
 *   contours: [{ pts, bbox, area, layer, depth, source }]
 *   header, warnings, stats
 * }
 */
const DXFParser = (() => {

  const Geometry = (typeof SuperNestGeometry !== 'undefined')
    ? SuperNestGeometry
    : (typeof require !== 'undefined' ? require('./src/core/geometry/geometry.js') : null);

  const TOLERANCE  = 0.01;
  const ARC_STEP   = 2;
  const SPLINE_PTS = 64;
  const CHAIN_TOL  = 0.5;

  // Module-level helper (needed by _parseLwPolylineVerts outside parseEntities)
  const ai = v => Array.isArray(v) ? v : (v !== undefined ? [v] : []);

  // ══════════════════════════════════════════════════
  // 1. TOKENIZER
  // ══════════════════════════════════════════════════
  function tokenize(text) {
    const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const tokens = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const code = parseInt(lines[i].trim(), 10);
      if (!isNaN(code)) tokens.push({ code, value: lines[i + 1].trim() });
    }
    return tokens;
  }

  // ══════════════════════════════════════════════════
  // 2. SECTIONS
  // ══════════════════════════════════════════════════
  function splitSections(tokens) {
    const sections = {};
    let i = 0;
    while (i < tokens.length) {
      if (tokens[i].code === 0 && tokens[i].value === 'SECTION') {
        i++;
        if (tokens[i]?.code === 2) {
          const name = tokens[i].value;
          const start = ++i;
          while (i < tokens.length && !(tokens[i].code === 0 && tokens[i].value === 'ENDSEC')) i++;
          sections[name] = tokens.slice(start, i);
          i++;
        }
      } else { i++; }
    }
    return sections;
  }

  // ══════════════════════════════════════════════════
  // 3. HEADER
  // ══════════════════════════════════════════════════
  function parseHeader(tokens) {
    let insunits = 4, dimscale = 1;
    for (let i = 0; i < tokens.length - 1; i++) {
      if (tokens[i].code === 9) {
        if (tokens[i].value === '$INSUNITS') insunits = parseInt(tokens[i+1]?.value) || 4;
        if (tokens[i].value === '$DIMSCALE') dimscale = parseFloat(tokens[i+1]?.value) || 1;
      }
    }
    const toMM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000 };
    return { insunits, dimscale, mmScale: (toMM[insunits] || 1) * dimscale };
  }

  // ══════════════════════════════════════════════════
  // 4. BLOCKS
  // ══════════════════════════════════════════════════
  function parseBlocks(tokens) {
    const blocks = {};
    let i = 0;
    while (i < tokens.length) {
      if (tokens[i].code === 0 && tokens[i].value === 'BLOCK') {
        i++;
        let name = '';
        const bt = [];
        while (i < tokens.length && !(tokens[i].code === 0 && tokens[i].value === 'ENDBLK')) {
          if (tokens[i].code === 2) name = tokens[i].value;
          bt.push(tokens[i++]);
        }
        if (name) blocks[name] = bt;
      } else { i++; }
    }
    return blocks;
  }

  // ══════════════════════════════════════════════════
  // 5. ENTITY PARSER
  // ══════════════════════════════════════════════════
  function parseEntities(tokens, blocks, mmScale) {
    blocks  = blocks  || {};
    mmScale = mmScale || 1;
    const shapes = [];
    let i = 0;
    const sc = v => parseFloat(v || 0) * mmScale;
    const f  = v => parseFloat(v || 0);

    // collectProps: read group-code pairs until next entity (code 0).
    // CRITICAL: track bulge(42) → vertex index mapping for LWPOLYLINE.
    function collectProps() {
      const p = {};
      let yCount = 0;
      const bulgeMap = [];
      while (i < tokens.length) {
        if (tokens[i].code === 0) break;
        const { code, value } = tokens[i++];
        if (code === 20) yCount++;           // each Y = one vertex completed
        if (code === 42) bulgeMap.push([yCount - 1, parseFloat(value)]);
        if (p[code] !== undefined) {
          if (!Array.isArray(p[code])) p[code] = [p[code]];
          p[code].push(value);
        } else { p[code] = value; }
      }
      if (bulgeMap.length) p.__bulgeMap = bulgeMap;
      return p;
    }

    function push(s) {
      if (!s?.pts?.length) return;
      s.pts = _dedup(s.pts);
      if (s.pts.length >= 2) shapes.push(s);
    }

    while (i < tokens.length) {
      const t = tokens[i];
      if (t.code !== 0) { i++; continue; }
      i++;
      const type  = t.value.toUpperCase();
      const props = collectProps();
      const layer = props[8] || '0';

      if (type === 'LINE') {
        push({ pts:[{x:sc(props[10]),y:sc(props[20])},{x:sc(props[11]),y:sc(props[21])}],
               closed:false, source:'LINE', layer });
      }
      else if (type === 'LWPOLYLINE') {
        const closed = (parseInt(props[70]||'0') & 1) === 1;
        const verts  = _parseLwPolylineVerts(props, sc, f);
        if (verts.length >= 2)
          push({ pts: _expandBulgesVerts(verts, closed), closed, source:'LWPOLYLINE', layer });
      }
      else if (type === 'POLYLINE') {
        const closed = (parseInt(props[70]||'0') & 1) === 1;
        const pts = [];
        while (i < tokens.length) {
          if (tokens[i].code === 0 && tokens[i].value === 'SEQEND') { i++; break; }
          if (tokens[i].code === 0 && tokens[i].value === 'VERTEX') {
            i++; const vp = collectProps();
            pts.push({ x: sc(vp[10]), y: sc(vp[20]) });
          } else { i++; }
        }
        push({ pts, closed, source:'POLYLINE', layer });
      }
      else if (type === 'CIRCLE') {
        push({ pts:_circleArc(sc(props[10]),sc(props[20]),sc(props[40]),0,360,true),
               closed:true, source:'CIRCLE', layer });
      }
      else if (type === 'ARC') {
        push({ pts:_circleArc(sc(props[10]),sc(props[20]),sc(props[40]),f(props[50]),f(props[51]),false),
               closed:false, source:'ARC', layer });
      }
      else if (type === 'ELLIPSE') {
        const cx=sc(props[10]),cy=sc(props[20]),mx=sc(props[11]),my=sc(props[21]);
        const ratio=f(props[40]),sa=f(props[41]||'0'),ea=f(props[42]||String(Math.PI*2));
        const a=Math.sqrt(mx*mx+my*my),b=a*ratio,rot=Math.atan2(my,mx);
        const steps=Math.max(36,Math.ceil((ea-sa)/(ARC_STEP*Math.PI/180)));
        const pts=[];
        for(let j=0;j<=steps;j++){const tt=sa+(ea-sa)*j/steps;pts.push({
          x:cx+a*Math.cos(tt)*Math.cos(rot)-b*Math.sin(tt)*Math.sin(rot),
          y:cy+a*Math.cos(tt)*Math.sin(rot)+b*Math.sin(tt)*Math.cos(rot)});}
        push({ pts, closed:Math.abs(ea-sa-Math.PI*2)<0.01, source:'ELLIPSE', layer });
      }
      else if (type === 'SPLINE') {
        const closed=(parseInt(props[70]||'0')&1)===1;
        const degree=parseInt(props[71]||'3');
        const knots=ai(props[40]).map(f);
        const cxs=ai(props[10]).map(sc),cys=ai(props[20]).map(sc);
        const ctrl=cxs.map((x,j)=>({x,y:cys[j]||0}));
        if(ctrl.length>=2) push({ pts:_evalBSpline(ctrl,knots,degree,SPLINE_PTS),
                                   closed, source:'SPLINE', layer });
      }
      else if (type === 'HATCH') {
        _parseHatch(tokens, i, layer, sc, f).forEach(s => push(s));
      }
      else if (type === 'INSERT') {
        const bn=props[2],ix=sc(props[10]),iy=sc(props[20]);
        const sx=f(props[41]||'1'),sy=f(props[42]||'1'),rot=f(props[50]||'0')*Math.PI/180;
        if (bn && blocks[bn]) {
          parseEntities(blocks[bn], blocks, mmScale).forEach(sub => {
            sub.pts=sub.pts.map(p=>({
              x:ix+(p.x*sx)*Math.cos(rot)-(p.y*sy)*Math.sin(rot),
              y:iy+(p.x*sx)*Math.sin(rot)+(p.y*sy)*Math.cos(rot)}));
            sub.source='INSERT:'+bn;
            shapes.push(sub);
          });
        }
      }
    }
    return shapes;
  }

  // ══════════════════════════════════════════════════
  // 6. LWPOLYLINE — per-vertex bulge (v9 approach)
  // ══════════════════════════════════════════════════
  function _parseLwPolylineVerts(props, sc, f) {
    const xs = ai(props[10]);
    const ys = ai(props[20]);
    const verts = xs.map((x, j) => ({ x: sc(x), y: sc(ys[j] || '0'), bulge: 0 }));
    if (props.__bulgeMap) {
      for (const [vi, b] of props.__bulgeMap) {
        if (vi >= 0 && vi < verts.length) verts[vi].bulge = b;
      }
    }
    return verts;
  }

  function _expandBulgesVerts(verts, closed) {
    if (!verts.some(v => Math.abs(v.bulge) > 1e-9))
      return verts.map(v => ({ x: v.x, y: v.y }));
    const result = [];
    const n = closed ? verts.length : verts.length - 1;
    for (let k = 0; k < verts.length; k++) {
      result.push({ x: verts[k].x, y: verts[k].y });
      if (k < n && Math.abs(verts[k].bulge) > 1e-9) {
        const v2  = verts[(k + 1) % verts.length];
        const arc = _bulgeToArc(verts[k].x, verts[k].y, v2.x, v2.y, verts[k].bulge);
        if (arc) {
          const steps = Math.max(4, Math.ceil(Math.abs(arc.span) / (ARC_STEP * Math.PI / 180)));
          for (let s = 1; s < steps; s++) {
            const a = arc.sa + arc.span * s / steps;
            result.push({ x: arc.cx + arc.r * Math.cos(a), y: arc.cy + arc.r * Math.sin(a) });
          }
        }
      }
    }
    if (!closed && verts.length > 0)
      result.push({ x: verts[verts.length-1].x, y: verts[verts.length-1].y });
    return result;
  }

  // Exact port of v9 Geometry.bulgeToArc
  function _bulgeToArc(x1, y1, x2, y2, b) {
    const dx=x2-x1, dy=y2-y1, d=Math.sqrt(dx*dx+dy*dy);
    if (d < 1e-10) return null;
    const alpha = 4*Math.atan(Math.abs(b));
    const r     = d / (2*Math.sin(alpha/2));
    const mx=(x1+x2)/2, my=(y1+y2)/2;
    const h  = r*Math.cos(alpha/2);
    const px = -dy/d, py = dx/d;
    const sg = b > 0 ? 1 : -1;
    const cx = mx+sg*h*px, cy = my+sg*h*py;
    let sa = Math.atan2(y1-cy, x1-cx);
    let ea = Math.atan2(y2-cy, x2-cx);
    let span;
    if (b > 0) { span=ea-sa; if(span<0) span+=2*Math.PI; }
    else       { span=ea-sa; if(span>0) span-=2*Math.PI; }
    return { cx, cy, r, sa, span };
  }

  // ══════════════════════════════════════════════════
  // 7. HATCH PARSER
  // ══════════════════════════════════════════════════
  function _parseHatch(tokens, curI, layer, sc, f) {
    let start = curI - 2;
    while (start >= 0 && !(tokens[start]?.code === 0 && tokens[start]?.value === 'HATCH')) start--;
    if (start < 0) return [];
    const ht = [];
    let j = start + 1;
    while (j < tokens.length && tokens[j]?.code !== 0) ht.push(tokens[j++]);
    return _parseHatchTokens(ht, layer, sc, f);
  }

  function _parseHatchTokens(ht, layer, sc, f) {
    const shapes = [];
    let j = 0;
    const consume = () => ht[j++];
    const expectCode = c => { while(j<ht.length && ht[j]?.code!==c) j++; return j<ht.length?consume():null; };

    const t91 = expectCode(91);
    const nLoops = t91 ? parseInt(t91.value) : 0;
    if (!nLoops) return [];

    for (let loop = 0; loop < nLoops; loop++) {
      const t92 = expectCode(92); if (!t92) break;
      const pathType  = parseInt(t92.value);
      const isPolyline = (pathType & 2) !== 0;
      const isIsland   = (pathType & 16) !== 0;
      let pts = null;

      if (isPolyline) {
        const t93 = expectCode(93); const nV = t93 ? parseInt(t93.value) : 0;
        let closed = true;
        if (j < ht.length && ht[j]?.code === 72) { closed = parseInt(consume().value) === 1; }
        const verts = [], bulges = [];
        let vRead = 0;
        while (j < ht.length && vRead < nV) {
          const t = ht[j];
          if (t?.code === 10) { consume(); const x=sc(t.value); const ty=ht[j]; if(ty?.code===20){consume();verts.push({x,y:sc(ty.value)});} }
          else if (t?.code === 42) { consume(); bulges.push(f(t.value)); }
          else if (t?.code === 97) break;
          else consume();
          if (ht[j-1]?.code === 20) vRead++;
        }
        if (verts.length >= 3) pts = bulges.length ? _expandBulgesVerts(
          verts.map((v,i)=>({...v,bulge:bulges[i]||0})), closed) : verts;
      } else {
        const t93 = expectCode(93); const nEdges = t93 ? parseInt(t93.value) : 0;
        const ep = [];
        for (let e = 0; e < nEdges; e++) {
          const t72 = expectCode(72); if (!t72) break;
          const et = parseInt(t72.value);
          if (et === 1) {
            const x1=expectCode(10),y1=expectCode(20),x2=expectCode(11),y2=expectCode(21);
            if(x1&&y1) ep.push({x:sc(x1.value),y:sc(y1.value)});
            if(x2&&y2) ep.push({x:sc(x2.value),y:sc(y2.value)});
          } else if (et === 2) {
            const cx=expectCode(10),cy=expectCode(20),r=expectCode(40),sa=expectCode(50),ea=expectCode(51),ccw=expectCode(73);
            if(cx&&cy&&r&&sa&&ea){
              const arc=_circleArc(sc(cx.value),sc(cy.value),sc(r.value),f(sa.value),f(ea.value),false);
              if(ccw&&parseInt(ccw.value)===0) arc.reverse();
              ep.push(...arc);
            }
          } else if (et === 3) {
            const cx=expectCode(10),cy=expectCode(20),mx=expectCode(11),my=expectCode(21),rat=expectCode(40),sa=expectCode(50),ea=expectCode(51),ccw=expectCode(73);
            if(cx&&cy&&mx&&my&&rat&&sa&&ea){
              const a=Math.sqrt(sc(mx.value)**2+sc(my.value)**2),b2=a*f(rat.value),rot=Math.atan2(sc(my.value),sc(mx.value));
              const saR=f(sa.value)*Math.PI/180,eaR=f(ea.value)*Math.PI/180;
              let da=eaR-saR;
              if(ccw&&parseInt(ccw.value)===0&&da>0) da-=Math.PI*2;
              if(ccw&&parseInt(ccw.value)===1&&da<0) da+=Math.PI*2;
              const steps=Math.max(8,Math.ceil(Math.abs(da)/(ARC_STEP*Math.PI/180)));
              for(let s=0;s<=steps;s++){const tt=saR+da*s/steps;ep.push({
                x:sc(cx.value)+a*Math.cos(tt)*Math.cos(rot)-b2*Math.sin(tt)*Math.sin(rot),
                y:sc(cy.value)+a*Math.cos(tt)*Math.sin(rot)+b2*Math.sin(tt)*Math.cos(rot)});}
            }
          } else if (et === 4) {
            const deg=expectCode(94),_=expectCode(73),__=expectCode(74),nk=expectCode(75),nc=expectCode(76);
            const degree=deg?parseInt(deg.value):3,nKnots=nk?parseInt(nk.value):0,nCtrl=nc?parseInt(nc.value):0;
            const knots=[],ctrl=[];
            for(let k=0;k<nKnots;k++){const tk=expectCode(40);if(tk)knots.push(f(tk.value));}
            for(let c=0;c<nCtrl;c++){const tx=expectCode(10),ty=expectCode(20);if(tx&&ty)ctrl.push({x:sc(tx.value),y:sc(ty.value)});}
            if(ctrl.length>=2) ep.push(..._evalBSpline(ctrl,knots,degree,SPLINE_PTS));
          }
        }
        if (ep.length >= 3) pts = _dedup(ep);
      }

      if (pts?.length >= 3)
        shapes.push({ pts, closed:true, source:'HATCH', layer, hatchIsland:isIsland });

      while(j<ht.length && ht[j]?.code!==92 && ht[j]?.code!==75){
        if(ht[j]?.code===97){j++;const n=parseInt(consume()?.value||'0');j+=n;break;}
        j++;
      }
    }
    return shapes;
  }

  // ══════════════════════════════════════════════════
  // 8. CHAIN OPEN SEGMENTS → closed contours
  // ══════════════════════════════════════════════════
  function _chainSegments(openShapes) {
    if (!openShapes.length) return [];
    const segs = openShapes.map(s => ({ pts: s.pts, layer: s.layer, used: false }));
    const chains = [];
    const TOL2_THRESHOLD = CHAIN_TOL * CHAIN_TOL * 4;
    const d2 = (a, b) => (a.x-b.x)**2 + (a.y-b.y)**2;

    for (let si = 0; si < segs.length; si++) {
      if (segs[si].used) continue;
      segs[si].used = true;
      const chain = { pts: [...segs[si].pts], layer: segs[si].layer };

      let extended = true;
      while (extended) {
        extended = false;
        const tail = chain.pts[chain.pts.length - 1];
        let bestJ = -1, bestD = Infinity, bestRev = false;
        for (let j = 0; j < segs.length; j++) {
          if (segs[j].used) continue;
          // FIX: use sp[0] (start point) and ep (end point), not the array itself
          const sp = segs[j].pts[0], ep = segs[j].pts[segs[j].pts.length - 1];
          const d1 = d2(tail, sp), dr = d2(tail, ep);
          if (d1 < bestD) { bestD=d1; bestJ=j; bestRev=false; }
          if (dr < bestD) { bestD=dr; bestJ=j; bestRev=true; }
        }
        if (bestJ >= 0 && bestD <= TOL2_THRESHOLD) {
          segs[bestJ].used = true;
          const nxt = bestRev ? [...segs[bestJ].pts].reverse() : segs[bestJ].pts;
          chain.pts.push(...nxt.slice(1));
          extended = true;
        }
      }
      if (chain.pts.length >= 3) chains.push(chain);
    }
    return chains;
  }

  // ══════════════════════════════════════════════════
  // 9. BUILD CONTOURS (raw shapes → normalized closed)
  // ══════════════════════════════════════════════════
  function _buildContours(shapes) {
    const contours = [];
    let uid = 0;

    // IMPORTANT:
    // DXF has one common coordinate system. The previous version flipped Y
    // separately per contour using that contour's own maxY. That destroyed
    // the relative positions between contours, so holes/inner objects were
    // not assigned to their outer part correctly.
    const closedShapes = shapes.filter(s => s.closed);
    const chainedShapes = _chainSegments(shapes.filter(s => !s.closed))
      .map(c => ({ ...c, source: c.source || 'CHAINED' }));
    const allClosed = [...closedShapes, ...chainedShapes];

    const globalMaxY = allClosed.length
      ? Math.max(...allClosed.flatMap(s => (s.pts || []).map(p => p.y)))
      : 0;

    function add(rawPts, layer, source) {
      let pts = _dedup(rawPts);
      if (pts.length < 3) return;

      // DXF Y-up → screen Y-down, but with GLOBAL maxY so containment stays valid.
      const flipped = pts.map(p => ({ x: p.x, y: globalMaxY - p.y }));

      const origBbox = getBBox(flipped);
      const area     = Math.abs(polyArea(flipped));
      if (area < 0.5) return;

      // Normalized pts for each standalone outer part.
      const normPts = flipped.map(p => ({ x: p.x - origBbox.minX, y: p.y - origBbox.minY }));

      contours.push({
        id:       uid++,
        pts:      normPts,
        origPts:  flipped,
        bbox:     origBbox,
        normBbox: getBBox(normPts),
        area,
        layer,
        source,
        depth: 0,
      });
    }

    allClosed.forEach(s => add(s.pts, s.layer, s.source));

    contours.sort((a, b) => b.area - a.area);

    // Deduplicate near-identical contours, but don't accidentally remove
    // small holes just because they have same size. Use center proximity too.
    return contours.filter((a, i) =>
      !contours.slice(0, i).some(b =>
        Math.abs(a.bbox.w - b.bbox.w) < 0.5 &&
        Math.abs(a.bbox.h - b.bbox.h) < 0.5 &&
        Math.abs(a.bbox.cx - b.bbox.cx) < 0.5 &&
        Math.abs(a.bbox.cy - b.bbox.cy) < 0.5 &&
        Math.abs(a.area  - b.area)   < Math.max(1, a.area * 0.02)
      ));
  }

  // ══════════════════════════════════════════════════
  // 10. CONTAINMENT (ported from cnc_cam_v9)
  // ══════════════════════════════════════════════════
  function _bboxContains(o, i, eps = 0.1) {
    return o.minX <= i.minX + eps && o.maxX >= i.maxX - eps &&
           o.minY <= i.minY + eps && o.maxY >= i.maxY - eps;
  }

  function _containsContour(outer, inner) {
    if (outer.id === inner.id) return false;
    const ob = outer.bbox, ib = inner.bbox;
    if (!_bboxContains(ob, ib)) return false;
    const outerPts = outer.origPts || outer.pts;
    const innerPts = inner.origPts || inner.pts;
    const step = Math.max(1, Math.floor(innerPts.length / 36));
    let inside = 0, total = 0;
    for (let i = 0; i < innerPts.length; i += step) {
      total++;
      if (pointInPolygon(innerPts[i].x, innerPts[i].y, outerPts)) inside++;
    }
    if (!total || inside !== total) return false;
    // Extra interior probes (v9 guard against razor-thin overlaps)
    const tests = [
      {x:ib.cx, y:ib.cy},
      {x:ib.minX+(ib.maxX-ib.minX)*0.25, y:ib.cy},
      {x:ib.minX+(ib.maxX-ib.minX)*0.75, y:ib.cy},
      {x:ib.cx, y:ib.minY+(ib.maxY-ib.minY)*0.25},
      {x:ib.cx, y:ib.minY+(ib.maxY-ib.minY)*0.75},
    ];
    let good = 0;
    for (const t of tests) if (pointInPolygon(t.x, t.y, outerPts)) good++;
    return good >= 3;
  }

  function _buildTree(contours) {
    const sorted = [...contours].sort((a, b) => b.area - a.area);
    const parent   = new Map();
    const children = new Map();
    sorted.forEach(c => children.set(c.id, []));

    for (let i = 0; i < sorted.length; i++) {
      const inner = sorted[i];
      let best = null;
      for (let j = 0; j < sorted.length; j++) {
        if (i === j) continue;
        const outer = sorted[j];
        if (outer.area <= inner.area) continue;
        if (!_bboxContains(outer.bbox, inner.bbox)) continue;
        if (!_containsContour(outer, inner)) continue;
        if (!best || outer.area < best.area) best = outer;
      }
      if (best) { parent.set(inner.id, best.id); children.get(best.id).push(inner.id); }
    }

    const depth = new Map();
    const getDepth = id => {
      if (depth.has(id)) return depth.get(id);
      const pid = parent.get(id);
      const d = pid == null ? 0 : getDepth(pid) + 1;
      depth.set(id, d); return d;
    };
    sorted.forEach(c => getDepth(c.id));
    return { parent, children, depth };
  }

  // ══════════════════════════════════════════════════
  // 11. PARTS ASSEMBLY
  // ══════════════════════════════════════════════════
  function _assembleParts(contours) {
    if (!contours.length) return [];

    const contourMap = new Map(contours.map(c => [c.id, c]));
    const { children, depth } = _buildTree(contours);
    contours.forEach(c => { c.depth = depth.get(c.id) || 0; });

    // Auto-detect nesting result (sheet+parts layout):
    // In sheet DXF files there is usually one depth-0 sheet rectangle and
    // many depth-1 real parts. These depth-1 parts may contain depth-2 holes.
    const d0 = contours.filter(c => c.depth === 0);
    const d1 = contours.filter(c => c.depth === 1);
    const sheetLike = d0.filter(c =>
      c.layer === 'Sheet' ||
      c.source === 'RECTANGLE' ||
      (c.normBbox.w > 1000 && c.normBbox.h > 500 && c.area > 500000)
    );
    const isResult = d0.length >= 1 && d1.length >= Math.max(3, d0.length * 2);
    const base = isResult ? 1 : 0;

    const parts    = [];
    const assigned = new Set();
    const sorted   = [...contours].sort((a, b) => b.area - a.area);

    // Skip sheet boundaries in result files
    if (isResult) contours.filter(c => c.depth < base).forEach(c => assigned.add(c.id));

    function holePtsRelativeToOuter(hole, outer) {
      const pts = hole.origPts || hole.pts || [];
      // Convert hole from global flipped coordinates into the outer part's
      // normalized coordinate space. This preserves exact position inside part.
      return pts.map(p => ({
        x: p.x - outer.bbox.minX,
        y: p.y - outer.bbox.minY,
      }));
    }

    function addPartFromOuter(outer) {
      assigned.add(outer.id);

      const holeContours = (children.get(outer.id) || [])
        .map(id => contourMap.get(id))
        .filter(h => h && !assigned.has(h.id) && h.depth === outer.depth + 1)
        .sort((a, b) => b.area - a.area);

      holeContours.forEach(h => assigned.add(h.id));

      parts.push({
        id:        parts.length,
        outerPoly: outer.pts,
        holes:     holeContours.map(h => holePtsRelativeToOuter(h, outer)),
        holeMeta:  holeContours.map(h => ({ layer:h.layer, source:h.source, bbox:h.bbox, area:h.area })),
        bbox:      outer.normBbox,
        area:      outer.area,
        layer:     outer.layer,
        source:    outer.source,
        poly:      outer.pts,
      });
    }

    for (const outer of sorted) {
      if (assigned.has(outer.id) || outer.depth !== base) continue;
      addPartFromOuter(outer);
    }

    // Remaining even-depth islands → standalone parts.
    for (const c of sorted) {
      if (assigned.has(c.id)) continue;
      if ((c.depth - base) % 2 !== 0) continue;
      addPartFromOuter(c);
    }

    return parts;
  }

  // ══════════════════════════════════════════════════
  // 12. MAIN PARSE
  // ══════════════════════════════════════════════════
  function parse(text) {
    const warnings = [];
    if (!text || typeof text !== 'string')
      return { parts:[], contours:[], header:{mmScale:1}, warnings:['Невалиден вход'], stats:{} };

    const tokens   = tokenize(text);
    const sections = splitSections(tokens);
    const header   = sections.HEADER ? parseHeader(sections.HEADER) : { mmScale:1 };
    const blocks   = sections.BLOCKS ? parseBlocks(sections.BLOCKS) : {};

    if (!sections.ENTITIES?.length) warnings.push('Не е намерена ENTITIES секция');

    let rawShapes;
    try { rawShapes = parseEntities(sections.ENTITIES || [], blocks, header.mmScale); }
    catch(e) { warnings.push('Parse error: '+e.message); rawShapes = []; }

    const contours = _buildContours(rawShapes);
    if (!contours.length && rawShapes.length)
      warnings.push('Entities намерени, но без затворени контури');

    const parts = _assembleParts(contours);

    const stats = {
      totalEntities: rawShapes.length,
      totalContours: contours.length,
      totalParts:    parts.length,
      withHoles:     parts.filter(p => p.holes.length > 0).length,
      byType: {},
    };
    rawShapes.forEach(s => { stats.byType[s.source]=(stats.byType[s.source]||0)+1; });

    return { parts, contours, header, warnings, stats };
  }

  // ══════════════════════════════════════════════════
  // 13. GEOMETRY UTILS
  // ══════════════════════════════════════════════════
  function _circleArc(cx, cy, r, sa, ea, full) {
    if (full) { sa=0; ea=360; }
    if (ea < sa) ea += 360;
    const steps = Math.max(4, Math.ceil((ea-sa)/ARC_STEP));
    return Array.from({length:steps+1},(_,i)=>{
      const a=(sa+(ea-sa)*i/steps)*Math.PI/180;
      return {x:cx+r*Math.cos(a),y:cy+r*Math.sin(a)};
    });
  }

  function _evalBSpline(ctrl, knots, degree, n) {
    const deg = Math.min(degree, ctrl.length-1);
    if (!knots.length) { const m=ctrl.length+deg+1; knots=Array.from({length:m},(_,i)=>i/(m-1)); }
    const tMin=knots[deg], tMax=knots[knots.length-deg-1];
    return Array.from({length:n+1},(_,s)=>_deBoor(deg,ctrl,knots,tMin+(tMax-tMin)*s/n));
  }

  function _deBoor(deg, ctrl, knots, t) {
    let k=deg;
    for(let j=deg;j<knots.length-deg-1;j++){if(knots[j]<=t&&t<=knots[j+1]){k=j;break;}}
    const d=ctrl.slice(Math.max(0,k-deg),k+1).map(p=>({...p}));
    for(let r=1;r<=deg;r++){
      for(let j=deg;j>=r;j--){
        const idx=j+k-deg;
        if(idx<0||idx+deg-r+1>=knots.length)continue;
        const den=knots[idx+deg-r+1]-knots[idx];
        const a=den<1e-12?0:(t-knots[idx])/den;
        const dj=d[j]||ctrl[ctrl.length-1],dj1=d[j-1]||ctrl[0];
        d[j]={x:(1-a)*dj1.x+a*dj.x,y:(1-a)*dj1.y+a*dj.y};
      }
    }
    return d[deg]||ctrl[ctrl.length-1];
  }

  function _dedup(pts) {
    const TOL2=TOLERANCE*TOLERANCE, r=[pts[0]];
    for(let i=1;i<pts.length;i++){
      const p=r[r.length-1];
      if((pts[i].x-p.x)**2+(pts[i].y-p.y)**2>TOL2) r.push(pts[i]);
    }
    return r;
  }

  const getBBox = Geometry.getBBox;
  const normalizeToOrigin = Geometry.normalizeToOrigin;

  function flipY(pts) {
    const maxY=Math.max(...pts.map(p=>p.y)); return pts.map(p=>({x:p.x,y:maxY-p.y}));
  }

  const polyArea = Geometry.polyArea;
  const pointInPolygon = Geometry.pointInPolygon;

  return {
    parse, parseEntities,
    getBBox, normalizeToOrigin, flipY, polyArea, pointInPolygon,
    TOLERANCE,
  };

})();

if (typeof module !== 'undefined') module.exports = DXFParser;
