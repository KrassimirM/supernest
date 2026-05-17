/*
 * SuperNest canvas renderer
 * ─────────────────────────
 * Standalone Step 2 canvas renderer. Keeps all canvas drawing,
 * pan/zoom, hover, selection, and fit-view behavior out of the app shell.
 */
(function (global) {
  'use strict';

  const Geometry = global.SuperNestGeometry || null;

  class SuperNestRenderer {
    constructor(options) {
      this.canvas = options.canvas || null;
      this.ctx = this.canvas?.getContext('2d') || null;
      this.wrap = options.wrap || null;
      this.getNestResult = options.getNestResult || (() => null);
      this.getEmptyElement = options.getEmptyElement || (() => null);
      this.getCoordsElement = options.getCoordsElement || (() => null);
      this.onPartSelect = options.onPartSelect || (() => {});
      this.background = options.background || '#141412';

      this.currentSheet = 0;
      this.viewScale = 1;
      this.viewOffset = { x: 40, y: 40 };
      this.panning = false;
      this.lastMouse = { x: 0, y: 0 };
      this.hoverPart = null;
      this.selectedPart = null;
    }

    bind() {
      if (!this.canvas) return;
      this.canvas.addEventListener('wheel', event => this.onWheel(event), { passive: false });
      this.canvas.addEventListener('mousedown', event => this.onMouseDown(event));
      this.canvas.addEventListener('mousemove', event => this.onMouseMove(event));
      this.canvas.addEventListener('mouseup', event => this.onMouseUp(event));
      this.canvas.addEventListener('mouseleave', () => {
        this.panning = false;
        this.hoverPart = null;
        this.render();
      });
    }

    resize() {
      if (!this.canvas) return;
      const wrap = this.wrap || this.canvas.parentElement;
      if (!wrap) return;
      this.canvas.width = wrap.offsetWidth;
      this.canvas.height = wrap.offsetHeight;
      this.render();
    }

    render() {
      if (!this.canvas || !this.ctx) return;
      const width = this.canvas.width;
      const height = this.canvas.height;
      const ctx = this.ctx;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, width, height);

      const result = this.getNestResult();
      const empty = this.getEmptyElement();
      if (empty) empty.hidden = !!result;

      if (!result?.sheets?.length) return;

      const sheetResult = result.sheets[this.currentSheet];
      if (!sheetResult) return;

      const { sheet, placements } = sheetResult;
      const sheetWidth = sheet.width;
      const sheetHeight = sheet.height;
      const scale = this.viewScale;
      const offsetX = this.viewOffset.x;
      const offsetY = this.viewOffset.y;

      this.drawGrid(ctx, sheetWidth, sheetHeight, scale, offsetX, offsetY);
      this.drawSheet(ctx, sheetWidth, sheetHeight, scale, offsetX, offsetY);

      for (const placement of placements) {
        this.drawPart(
          ctx,
          placement,
          scale,
          offsetX,
          offsetY,
          this.hoverPart === placement,
          this.selectedPart === placement
        );
      }

      this.drawDimensions(ctx, sheetWidth, sheetHeight, scale, offsetX, offsetY);
    }

    drawGrid(ctx, sheetWidth, sheetHeight, scale, offsetX, offsetY) {
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.lineWidth = 0.5;
      const gridMM = sheetHeight >= 2000 ? 200 : 100;

      for (let x = 0; x <= sheetWidth; x += gridMM) {
        ctx.beginPath();
        ctx.moveTo(offsetX + x * scale, offsetY);
        ctx.lineTo(offsetX + x * scale, offsetY + sheetHeight * scale);
        ctx.stroke();
      }

      for (let y = 0; y <= sheetHeight; y += gridMM) {
        ctx.beginPath();
        ctx.moveTo(offsetX, offsetY + y * scale);
        ctx.lineTo(offsetX + sheetWidth * scale, offsetY + y * scale);
        ctx.stroke();
      }
    }

    drawSheet(ctx, sheetWidth, sheetHeight, scale, offsetX, offsetY) {
      ctx.fillStyle = 'rgba(255,255,255,0.025)';
      ctx.fillRect(offsetX, offsetY, sheetWidth * scale, sheetHeight * scale);
      ctx.strokeStyle = 'rgba(255,255,255,0.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(offsetX, offsetY, sheetWidth * scale, sheetHeight * scale);
    }

    drawPart(ctx, placement, scale, offsetX, offsetY, isHover, isSelected) {
      const poly = placement.poly;
      if (!poly?.length) return;

      ctx.beginPath();
      ctx.moveTo(offsetX + poly[0].x * scale, offsetY + poly[0].y * scale);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo(offsetX + poly[i].x * scale, offsetY + poly[i].y * scale);
      }
      ctx.closePath();

      ctx.fillStyle = isSelected ? placement.color + '55' : isHover ? placement.color + '44' : placement.color + '28';
      ctx.fill();
      ctx.strokeStyle = isSelected ? placement.color : isHover ? placement.color + 'ee' : placement.color + '99';
      ctx.lineWidth = isSelected ? 1.5 : 1;
      ctx.stroke();

      const bbox = this.bbox(poly);
      const boxWidth = bbox.w * scale;
      if (boxWidth <= 28) return;

      const centerX = offsetX + (bbox.minX + bbox.maxX) / 2 * scale;
      const centerY = offsetY + (bbox.minY + bbox.maxY) / 2 * scale;
      const fontSize = Math.max(8, Math.min(11, boxWidth / 9));
      const label = placement.name?.length > 12 ? placement.name.slice(0, 10) + '…' : (placement.name || '');

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = `${fontSize}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, centerX, centerY);

      if (placement.angle && boxWidth > 80) {
        ctx.fillStyle = 'rgba(93,189,46,0.7)';
        ctx.font = `${fontSize * 0.8}px monospace`;
        ctx.fillText(`${placement.angle}°`, centerX, centerY + fontSize + 2);
      }
    }

    drawDimensions(ctx, sheetWidth, sheetHeight, scale, offsetX, offsetY) {
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.font = '10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(`${sheetWidth} мм`, offsetX + sheetWidth * scale / 2, offsetY - 6);
      ctx.save();
      ctx.translate(offsetX - 6, offsetY + sheetHeight * scale / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${sheetHeight} мм`, 0, 0);
      ctx.restore();
    }

    selectSheet(index) {
      this.currentSheet = index;
      this.selectedPart = null;
      this.fitView();
      this.render();
      this.onPartSelect(null);
    }

    zoomIn() {
      this.viewScale *= 1.2;
      this.render();
    }

    zoomOut() {
      this.viewScale *= 0.8;
      this.render();
    }

    fitView() {
      if (!this.canvas) return;
      const result = this.getNestResult();
      if (!result?.sheets?.[this.currentSheet]) return;

      const { sheet } = result.sheets[this.currentSheet];
      const width = this.canvas.width || 800;
      const height = this.canvas.height || 600;
      const pad = 50;
      this.viewScale = Math.min((width - pad * 2) / sheet.width, (height - pad * 2) / sheet.height);
      this.viewOffset = {
        x: (width - sheet.width * this.viewScale) / 2,
        y: (height - sheet.height * this.viewScale) / 2,
      };
    }

    getCurrentSheet() {
      return this.currentSheet;
    }

    onWheel(event) {
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 0.88;
      const rect = this.canvas.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      this.viewOffset.x = mouseX - (mouseX - this.viewOffset.x) * factor;
      this.viewOffset.y = mouseY - (mouseY - this.viewOffset.y) * factor;
      this.viewScale *= factor;
      this.render();
    }

    onMouseDown(event) {
      this.panning = true;
      this.lastMouse = { x: event.clientX, y: event.clientY };
    }

    onMouseMove(event) {
      if (this.panning) {
        this.viewOffset.x += event.clientX - this.lastMouse.x;
        this.viewOffset.y += event.clientY - this.lastMouse.y;
        this.lastMouse = { x: event.clientX, y: event.clientY };
        this.render();
        this.updateCoords(event);
        return;
      }

      const result = this.getNestResult();
      if (!result?.sheets?.[this.currentSheet]) return;

      const rect = this.canvas.getBoundingClientRect();
      const mouseX = (event.clientX - rect.left - this.viewOffset.x) / this.viewScale;
      const mouseY = (event.clientY - rect.top - this.viewOffset.y) / this.viewScale;
      const prev = this.hoverPart;
      this.hoverPart = null;

      for (const placement of result.sheets[this.currentSheet].placements) {
        if (this.pointInPoly({ x: mouseX, y: mouseY }, placement.poly)) {
          this.hoverPart = placement;
          break;
        }
      }

      if (this.hoverPart !== prev) {
        this.render();
        this.canvas.style.cursor = this.hoverPart ? 'pointer' : 'grab';
      }
    }

    onMouseUp(event) {
      const moved = Math.abs(event.clientX - this.lastMouse.x) > 3 || Math.abs(event.clientY - this.lastMouse.y) > 3;
      this.panning = false;

      if (!moved && this.hoverPart) {
        this.selectedPart = this.selectedPart === this.hoverPart ? null : this.hoverPart;
        this.render();
        this.onPartSelect(this.selectedPart);
      }
    }

    updateCoords(event) {
      const coords = this.getCoordsElement();
      if (!coords) return;

      const rect = this.canvas.getBoundingClientRect();
      const mouseX = (event.clientX - rect.left - this.viewOffset.x) / this.viewScale;
      const mouseY = (event.clientY - rect.top - this.viewOffset.y) / this.viewScale;
      coords.textContent = `${mouseX.toFixed(0)}, ${mouseY.toFixed(0)} мм`;
    }

    pointInPoly(point, poly) {
      if (Geometry) return Geometry.pointInPoly(point, poly);

      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x;
        const yi = poly[i].y;
        const xj = poly[j].x;
        const yj = poly[j].y;
        if (((yi > point.y) !== (yj > point.y)) && (point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi)) {
          inside = !inside;
        }
      }
      return inside;
    }

    bbox(points) {
      if (Geometry) return Geometry.getBBox(points);

      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;

      for (const point of points) {
        if (point.x < minX) minX = point.x;
        if (point.y < minY) minY = point.y;
        if (point.x > maxX) maxX = point.x;
        if (point.y > maxY) maxY = point.y;
      }

      return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
    }
  }

  global.SuperNestRenderer = SuperNestRenderer;
})(window);
