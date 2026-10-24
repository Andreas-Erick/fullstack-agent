// Radial face: an 80-bar starburst around a particle orb. Grains swirl and burst outward with each
// syllable; sonar ripples at idle; a radar sweep while thinking; bars pull inward while listening.
import { BaseFace, audio, faceState, baseState, paletteFor, rgba, lerp, lerpColor } from './common.js';

const BARS = 80;

export class RadialFace extends BaseFace {
  constructor(canvas, opts) {
    super(canvas, opts);
    this.levels = new Float32Array(BARS);
    this.grains = Array.from({ length: opts?.compact ? 140 : 360 }, () => ({ a: Math.random() * Math.PI * 2, r: Math.random(), v: 0.2 + Math.random() * 0.8, burst: 0 }));
    const p = paletteFor('idle');
    this.cur = { main: p.main, accent: p.accent, energy: p.energy };
    this.ripples = [];
    this.prevLevel = 0;
  }

  layout() {
    this.cx = this.w / 2;
    this.cy = this.h / 2;
    this.R = Math.min(this.w, this.h) * (this.compact ? 0.2 : 0.14);
  }

  draw(dt) {
    const g = this.ctx;
    const shown = faceState();
    const st = baseState(shown); // core state for motion; colors use the exact one
    const target = paletteFor(shown);
    const k = 1 - Math.pow(0.02, dt);
    this.cur.main = lerpColor(this.cur.main, target.main, k);
    this.cur.accent = lerpColor(this.cur.accent, target.accent, k);
    this.cur.energy = lerp(this.cur.energy, target.energy, k);
    const { level, freq } = audio();
    const { cx, cy, R, w, h } = this;
    const main = this.cur.main;
    const accent = this.cur.accent;
    g.clearRect(0, 0, w, h);

    const amb = g.createRadialGradient(cx, cy, R * 0.3, cx, cy, Math.max(w, h) * 0.6);
    amb.addColorStop(0, rgba(main, 0.12 + level * 0.15));
    amb.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = amb;
    g.fillRect(0, 0, w, h);

    // Sonar ripples (idle) / syllable bursts (speaking)
    if (st === 'idle' && (!this.ripples.length || this.ripples[this.ripples.length - 1].r > R * 1.2)) this.ripples.push({ r: R, a: 0.5 });
    if (level - this.prevLevel > 0.12) {
      this.ripples.push({ r: R, a: 0.8 });
      for (const gr of this.grains) if (Math.random() < 0.3) gr.burst = 1;
    }
    this.prevLevel = level;
    g.lineWidth = 1.5;
    for (const rp of this.ripples) {
      rp.r += dt * R * 1.1;
      rp.a -= dt * 0.35;
      g.strokeStyle = rgba(main, Math.max(0, rp.a) * 0.6);
      g.beginPath();
      g.arc(cx, cy, rp.r, 0, Math.PI * 2);
      g.stroke();
    }
    this.ripples = this.ripples.filter((r) => r.a > 0);

    // Radar sweep while thinking
    if (st === 'thinking') {
      const a = this.t * 3;
      const sweep = g.createConicGradient ? g.createConicGradient(a, cx, cy) : null;
      if (sweep) {
        sweep.addColorStop(0, rgba(main, 0.35));
        sweep.addColorStop(0.12, rgba(main, 0));
        sweep.addColorStop(1, rgba(main, 0));
        g.fillStyle = sweep;
        g.beginPath();
        g.arc(cx, cy, R * 2.6, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Bars
    for (let i = 0; i < BARS; i++) {
      let v;
      if (freq) v = freq[Math.floor(2 + Math.abs((i / BARS) * 2 - 1) * Math.min(freq.length - 3, 110))] / 255;
      else if (st === 'listening') v = level * (0.5 + 0.5 * Math.sin(this.t * 10 + i));
      else if (st === 'thinking') v = 0.2 + 0.2 * Math.sin(this.t * 7 + i * 0.4);
      else v = 0.06 + 0.05 * Math.sin(this.t * 1.5 + i * 0.3);
      this.levels[i] = lerp(this.levels[i], v, 1 - Math.pow(0.001, dt));
      const ang = (i / BARS) * Math.PI * 2 - Math.PI / 2;
      const inward = st === 'listening' ? -1 : 1;
      const r0 = R * 1.35;
      const len = 4 + this.levels[i] * R * 1.1;
      g.strokeStyle = rgba(i % 2 ? accent : main, 0.35 + this.levels[i] * 0.65);
      g.lineWidth = Math.max(2, (Math.PI * 2 * r0) / BARS / 2.2);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      g.lineTo(cx + Math.cos(ang) * (r0 + len * inward), cy + Math.sin(ang) * (r0 + len * inward));
      g.stroke();
    }

    // Particle orb
    g.save();
    g.globalCompositeOperation = 'lighter';
    const spin = st === 'thinking' ? 2.4 : 0.5 + level;
    for (const gr of this.grains) {
      gr.a += dt * spin * gr.v * (gr.r < 0.5 ? 1 : -0.7);
      gr.burst = Math.max(0, gr.burst - dt * 1.5);
      const rr = R * (0.15 + gr.r * 0.85) * (1 + gr.burst * 1.4 + level * 0.25) + Math.sin(this.t * 2 + gr.a * 3) * 2;
      const x = cx + Math.cos(gr.a) * rr;
      const y = cy + Math.sin(gr.a) * rr;
      g.fillStyle = rgba(gr.r < 0.4 ? [255, 255, 255] : main, 0.35 + gr.burst * 0.5 + level * 0.3);
      g.fillRect(x, y, 1.6, 1.6);
    }
    g.restore();

    const core = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.6);
    core.addColorStop(0, rgba([255, 255, 255], 0.5 + level * 0.4));
    core.addColorStop(0.5, rgba(main, 0.35 + this.cur.energy * 0.3));
    core.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = core;
    g.beginPath();
    g.arc(cx, cy, R * 0.6, 0, Math.PI * 2);
    g.fill();
  }
}
