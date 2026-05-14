/**
 * SpyWheelCanvas — half-wheel drum-style country picker.
 *
 * Displays a 180° visible arc (top semicircle) with the pointer at the apex.
 * Every 10° represents one country slot (~18 visible at a time).
 * Countries wrap: after the last, the first repeats.
 *
 * Animation (rotation) is decoupled from country data.
 * _inView is recomputed each frame from rotation + country list.
 * Only countries whose slot falls within the visible arc are rendered.
 *
 * Usage:
 *   const wheel = new SpyWheelCanvas(canvasEl, countries);
 *   wheel.onSelect = (name) => { ... };
 *   wheel.start();
 *   wheel.spin();
 *   wheel.stop();
 */
export class SpyWheelCanvas {
  constructor(canvas, countries) {
    this.canvas    = canvas;
    this.ctx       = canvas.getContext('2d');
    this.countries = countries;   // [{ name, flag? }]

    this.SLOT    = Math.PI / 18;  // 10° per country slot
    this.VISIBLE = Math.PI;       // 180° visible arc

    this.rotation  = 0;           // continuous rotation (radians); pure animation value
    this.spinning  = false;
    this._animState          = null;  // { startR, targetR, startTime, duration }
    this._renderRafId        = null;

    this.onSelect            = null;  // callback(name)
    this._selectedIndex      = 0;
    this._lastSelectedIndex  = -1;

    // Countries currently within the visible 180° arc
    this._inView = [];            // [{ country, index, midAngle }]

    this._dragStartAngle = null;
    this._dragLastAngle  = null;
    this._dragVelocity   = 0;   // radians/ms during drag
    this._dragLastTime   = 0;

    this._bindEvents();
  }

  // ── Public ────────────────────────────────────────────────────────────────

  start() {
    if (!this._renderRafId) this._loop();
  }

  stop() {
    if (this._renderRafId) cancelAnimationFrame(this._renderRafId);
    this._renderRafId = null;
    this._animState   = null;
    this.spinning     = false;
  }

  spin() {
    const count = this.countries.length;
    if (!count) return;

    const targetIndex = Math.floor(Math.random() * count);
    const SLOT        = this.SLOT;
    const totalWrap   = count * SLOT;

    // Bring both current and target into [0, totalWrap)
    const curMod = ((this.rotation % totalWrap) + totalWrap) % totalWrap;
    const tarMod = ((targetIndex * SLOT) % totalWrap + totalWrap) % totalWrap;
    const diff   = ((tarMod - curMod) + totalWrap) % totalWrap;

    // Add several full wraps for visual drama
    const fullSpins = (4 + Math.floor(Math.random() * 4)) * totalWrap;

    this._dragVelocity = 0;
    this._animState = {
      startR:    this.rotation,
      targetR:   this.rotation + fullSpins + diff,
      startTime: performance.now(),
      duration:  3000,
    };
    this.spinning = true;
  }

  get selectedName() {
    return this.countries[this._selectedIndex]?.name ?? null;
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /** Single RAF loop: advance animation → compute in-view → fire callback → draw. */
  _loop() {
    // 1. Advance animation
    if (this._animState) {
      const { startR, targetR, startTime, duration } = this._animState;
      const t     = Math.min(1, (performance.now() - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      this.rotation = startR + (targetR - startR) * eased;
      if (t >= 1) {
        this.spinning   = false;
        this._animState = null;
      }
    } else if (this._dragVelocity !== 0 && this._dragStartAngle === null) {
      // Coast to a stop after drag release (exponential decay)
      this.rotation      += this._dragVelocity * 16; // ~60fps frame budget
      this._dragVelocity *= 0.88;                    // friction
      if (Math.abs(this._dragVelocity) < 0.00005) this._dragVelocity = 0;
    }

    // 2. Determine which countries are inside the 180° visible arc
    this._computeInView();

    // 3. Notify when selected country changes
    if (this._selectedIndex !== this._lastSelectedIndex) {
      this._lastSelectedIndex = this._selectedIndex;
      if (this.onSelect) this.onSelect(this.selectedName);
    }

    // 4. Render
    this._draw();

    this._renderRafId = requestAnimationFrame(() => this._loop());
  }

  /**
   * Populate _inView with countries whose slot midpoint falls inside the
   * top semicircle (canvas angles [-π, 0]).  Countries wrap via modular
   * arithmetic so the list is seamless regardless of how many countries
   * there are.
   */
  _computeInView() {
    const count = this.countries.length;
    this._inView = [];
    if (!count) return;

    const SLOT      = this.SLOT;
    const totalWrap = count * SLOT;   // radians for one full pass through all countries

    for (let i = 0; i < count; i++) {
      // How far country i is from the pointer, normalised to ±(totalWrap/2)
      let offset = this.rotation - i * SLOT;
      offset = ((offset % totalWrap) + totalWrap) % totalWrap;
      if (offset > totalWrap / 2) offset -= totalWrap;

      // Canvas angle of this country's midpoint (pointer = −π/2 = 12 o'clock)
      const midAngle = -Math.PI / 2 + offset;

      // Visible arc: top semicircle = canvas angles in [−π, 0]
      if (midAngle >= -Math.PI && midAngle <= 0) {
        this._inView.push({ country: this.countries[i], index: i, midAngle });
      }
    }

    // Selected country = closest slot to the pointer (−π/2)
    let best = null, bestDist = Infinity;
    for (const item of this._inView) {
      const d = Math.abs(item.midAngle + Math.PI / 2);
      if (d < bestDist) { bestDist = d; best = item; }
    }
    if (best) this._selectedIndex = best.index;
  }

  _draw() {
    const { canvas, ctx } = this;
    const W      = canvas.width;
    const H      = canvas.height;
    const margin = 10;
    const cx     = W / 2;
    const cy     = H - margin;       // wheel centre at bottom edge
    const R      = H - margin - 6;   // radius nearly fills the height

    ctx.clearRect(0, 0, W, H);

    // ── Clip to top semicircle ──────────────────────────────────────────────
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, R + 4, -Math.PI, 0, false);
    ctx.lineTo(cx + R + 4, cy + 4);
    ctx.lineTo(cx - R - 4, cy + 4);
    ctx.closePath();
    ctx.clip();

    // Background gradient
    const bgGrad = ctx.createRadialGradient(cx, cy, R * 0.08, cx, cy, R);
    bgGrad.addColorStop(0, '#0f2035');
    bgGrad.addColorStop(1, '#080f1a');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, W, H);

    // ── Draw in-view pie segments ───────────────────────────────────────────
    const SLOT     = this.SLOT;
    // Only show labels for countries within ~86° of the pointer
    const LABEL_ARC = Math.PI * 0.48;

    for (const item of this._inView) {
      const { midAngle, index } = item;
      const isSelected = index === this._selectedIndex;
      const startA = midAngle - SLOT / 2;
      const endA   = midAngle + SLOT / 2;

      // Segment fill
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, startA, endA);
      ctx.closePath();

      if (isSelected) {
        ctx.fillStyle = '#1e5c9e';
      } else {
        ctx.fillStyle = index % 2 === 0 ? '#172d48' : '#122338';
      }
      ctx.fill();

      ctx.strokeStyle = '#0a1628';
      ctx.lineWidth   = 1;
      ctx.stroke();

      // ── Label ──────────────────────────────────────────────────────────
      const distFromPointer = Math.abs(midAngle + Math.PI / 2);
      if (distFromPointer > LABEL_ARC) continue;

      const c    = item.country;
      const flag = c.flag || '';
      if (!flag) continue; // guesser-wheel blank entries / no flag data

      const labelR = R * 0.58;
      const lx     = cx + Math.cos(midAngle) * labelR;
      const ly     = cy + Math.sin(midAngle) * labelR;

      // Fade flags toward the edges
      const alpha = isSelected ? 1 : Math.max(0.4, 1 - distFromPointer / LABEL_ARC * 0.65);
      const fontSize = isSelected ? 20 : 14;

      ctx.save();
      ctx.globalAlpha  = alpha;
      ctx.font         = `${fontSize}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(flag, lx, ly);
      ctx.restore();
    }

    ctx.restore(); // remove clip

    // ── Decorations ────────────────────────────────────────────────────────

    // Outer rim
    ctx.beginPath();
    ctx.arc(cx, cy, R, -Math.PI, 0);
    ctx.strokeStyle = 'rgba(99,179,237,0.35)';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Inner ring accent
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.18, -Math.PI, 0);
    ctx.strokeStyle = 'rgba(99,179,237,0.15)';
    ctx.lineWidth   = 1;
    ctx.stroke();

    // Centre hub
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.07, 0, 2 * Math.PI);
    ctx.fillStyle   = '#0a1628';
    ctx.fill();
    ctx.strokeStyle = 'rgba(99,179,237,0.5)';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Pointer triangle (chevron pointing down at the rim, 12 o'clock)
    const tipX = cx;
    const tipY = cy - R - 2;
    ctx.beginPath();
    ctx.moveTo(tipX - 10, tipY - 18);
    ctx.lineTo(tipX,      tipY);
    ctx.lineTo(tipX + 10, tipY - 18);
    ctx.closePath();
    ctx.fillStyle   = '#63b3ed';
    ctx.fill();
    ctx.strokeStyle = '#93c5fd';
    ctx.lineWidth   = 1;
    ctx.stroke();

    // Pointer guide line (hub → rim)
    ctx.beginPath();
    ctx.moveTo(cx, cy - R * 0.08);
    ctx.lineTo(cx, cy - R + 2);
    ctx.strokeStyle = 'rgba(99,179,237,0.25)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Drag interaction ──────────────────────────────────────────────────────

  _angleFromEvent(e) {
    const rect    = this.canvas.getBoundingClientRect();
    const scaleX  = this.canvas.width  / rect.width;
    const scaleY  = this.canvas.height / rect.height;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = (clientX - rect.left) * scaleX - this.canvas.width  / 2;
    const dy = (clientY - rect.top)  * scaleY - (this.canvas.height - 10);
    return Math.atan2(dy, dx);
  }

  _bindEvents() {
    const onStart = (e) => {
      if (this.spinning) return;
      e.preventDefault();
      this._dragStartAngle = this._angleFromEvent(e);
      this._dragLastAngle  = this._dragStartAngle;
      this._dragVelocity   = 0;
      this._dragLastTime   = performance.now();
    };

    const onMove = (e) => {
      if (this._dragStartAngle === null || this.spinning) return;
      e.preventDefault();
      const now   = performance.now();
      const angle = this._angleFromEvent(e);
      const delta = angle - this._dragLastAngle;
      const dt    = now - this._dragLastTime || 1;

      this.rotation       += delta;
      // Smooth velocity with a light EMA so brief jitter doesn't dominate
      this._dragVelocity   = this._dragVelocity * 0.6 + (delta / dt) * 0.4;
      this._dragLastAngle  = angle;
      this._dragLastTime   = now;
    };

    const onEnd = () => {
      this._dragStartAngle = null;
      // Velocity is already set; the loop will coast it down
    };

    this.canvas.addEventListener('mousedown',  onStart);
    this.canvas.addEventListener('mousemove',  onMove);
    this.canvas.addEventListener('mouseup',    onEnd);
    this.canvas.addEventListener('mouseleave', onEnd);
    this.canvas.addEventListener('touchstart', onStart, { passive: false });
    this.canvas.addEventListener('touchmove',  onMove,  { passive: false });
    this.canvas.addEventListener('touchend',   onEnd);
  }
}
