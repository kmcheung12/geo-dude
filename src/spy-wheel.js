/**
 * SpyWheelCanvas — roulette-style country picker.
 *
 * Usage:
 *   const wheel = new SpyWheelCanvas(canvasEl, countries);
 *   wheel.onSelect = (name) => { ... };
 *   wheel.start();      // begin render loop
 *   wheel.spin();       // animate to random country
 *   wheel.stop();       // cancel render loop
 */
export class SpyWheelCanvas {
  constructor(canvas, countries) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.countries = countries;          // [{ name, flag? }]
    this.anglePerSegment = (2 * Math.PI) / countries.length;
    this.rotation = 0;                   // current rotation in radians
    this.velocity = 0;                   // rad/frame during spin animation
    this.spinning = false;
    this.rafId = null;
    this.onSelect = null;                // callback(name)
    this._selectedIndex = 0;
    this._dragStartAngle = null;
    this._dragLastAngle = null;
    this._lastVelocity = 0;

    this._bindEvents();
  }

  // ── Public ──────────────────────────────────────────────

  start() {
    this._render();
  }

  stop() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  spin() {
    // Pick a random target index, animate there
    const targetIndex = Math.floor(Math.random() * this.countries.length);
    const targetAngle = targetIndex * this.anglePerSegment;
    // Add several full rotations for drama
    const fullSpins = (5 + Math.floor(Math.random() * 5)) * 2 * Math.PI;
    const delta = fullSpins + targetAngle - (this.rotation % (2 * Math.PI));
    this._animateTo(this.rotation + delta, 2500);
  }

  get selectedName() {
    return this.countries[this._selectedIndex]?.name ?? null;
  }

  // ── Private ─────────────────────────────────────────────

  _normalise() {
    const count = this.countries.length;
    const raw = ((this.rotation % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    // Pointer is at 9 o'clock (left edge, π radians from 3 o'clock start)
    const pointerAngle = Math.PI;
    const idx = Math.round((pointerAngle - raw) / this.anglePerSegment);
    this._selectedIndex = ((idx % count) + count) % count;
  }

  _animateTo(targetAngle, durationMs) {
    this.spinning = true;
    const startAngle = this.rotation;
    const startTime = performance.now();
    const easeOut = t => 1 - Math.pow(1 - t, 3);

    const step = (now) => {
      const t = Math.min(1, (now - startTime) / durationMs);
      this.rotation = startAngle + (targetAngle - startAngle) * easeOut(t);
      this._normalise();
      if (this.onSelect) this.onSelect(this.selectedName);
      if (t < 1) {
        this.rafId = requestAnimationFrame(step);
      } else {
        this.spinning = false;
      }
    };
    this.rafId = requestAnimationFrame(step);
  }

  _render() {
    const { canvas, ctx, countries } = this;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(cx, cy) - 2;
    const visibleArc = Math.PI * 0.75; // ~135° visible arc centred on pointer
    const segAngle = this.anglePerSegment;

    ctx.clearRect(0, 0, W, H);

    // Draw only segments within visible arc of pointer (π radians = left)
    const pointer = Math.PI;
    for (let i = 0; i < countries.length; i++) {
      const midAngle = i * segAngle - this.rotation;
      const norm = ((midAngle - pointer + Math.PI * 3) % (2 * Math.PI)) - Math.PI;
      if (Math.abs(norm) > visibleArc) continue;

      const startA = i * segAngle - this.rotation;
      const endA = startA + segAngle;

      // Segment fill
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, startA, endA);
      ctx.closePath();
      ctx.fillStyle = i % 2 === 0 ? '#1a3a5c' : '#1e4976';
      ctx.fill();
      ctx.strokeStyle = '#0a1628';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Flag + name label
      const labelAngle = startA + segAngle / 2;
      const labelR = R * 0.72;
      const lx = cx + Math.cos(labelAngle) * labelR;
      const ly = cy + Math.sin(labelAngle) * labelR;

      ctx.save();
      ctx.translate(lx, ly);
      ctx.rotate(labelAngle + Math.PI / 2);
      ctx.font = `${Math.max(10, Math.min(13, W / 20))}px sans-serif`;
      ctx.fillStyle = '#e2e8f0';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const c = countries[i];
      const flag = c.flag || '';
      ctx.fillText(`${flag} ${c.name}`.trim(), 0, 0);
      ctx.restore();
    }

    // Hub
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.12, 0, 2 * Math.PI);
    ctx.fillStyle = '#0a1628';
    ctx.fill();
    ctx.strokeStyle = 'rgba(99,179,237,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Outer ring
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, 2 * Math.PI);
    ctx.strokeStyle = 'rgba(99,179,237,0.5)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Pointer (left edge, pointing right)
    const px = cx - R - 4;
    const py = cy;
    ctx.beginPath();
    ctx.moveTo(px, py - 8);
    ctx.lineTo(px + 14, py);
    ctx.lineTo(px, py + 8);
    ctx.closePath();
    ctx.fillStyle = '#63b3ed';
    ctx.fill();

    this.rafId = requestAnimationFrame(() => this._render());
  }

  _angleFromEvent(e) {
    const rect = this.canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    const dx = clientX - rect.left - this.canvas.width / 2;
    const dy = clientY - rect.top  - this.canvas.height / 2;
    return Math.atan2(dy, dx);
  }

  _bindEvents() {
    const onStart = (e) => {
      if (this.spinning) return;
      e.preventDefault();
      this._dragStartAngle = this._angleFromEvent(e);
      this._dragLastAngle = this._dragStartAngle;
      this._lastVelocity = 0;
    };
    const onMove = (e) => {
      if (this._dragStartAngle === null) return;
      e.preventDefault();
      const angle = this._angleFromEvent(e);
      const delta = angle - this._dragLastAngle;
      this._lastVelocity = delta;
      this.rotation -= delta;
      this._normalise();
      if (this.onSelect) this.onSelect(this.selectedName);
      this._dragLastAngle = angle;
    };
    const onEnd = () => { this._dragStartAngle = null; };

    this.canvas.addEventListener('mousedown',  onStart);
    this.canvas.addEventListener('mousemove',  onMove);
    this.canvas.addEventListener('mouseup',    onEnd);
    this.canvas.addEventListener('touchstart', onStart, { passive: false });
    this.canvas.addEventListener('touchmove',  onMove,  { passive: false });
    this.canvas.addEventListener('touchend',   onEnd);
  }
}
