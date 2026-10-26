// Siren face: a mythological sea-nymph. Feathered ear-fins spread as she listens and sings, hair drifts
// like a current, a lyre halo turns faster while she thinks, song rings ripple out with her voice (and
// draw inward while listening), and a waveform glows inside her mouth as she speaks. The app's default
// face. Colors are the theme's per-state pair; the alert state turns her red and sends out a shockwave.
import { BaseFace, audio, faceState, baseState, paletteFor, rgba, lerp, lerpColor } from './common.js';

const TARGETS = {
  idle: { speed: 1.0, wingSpread: 0.35, wingAngle: 0.08, eyeOpen: 0.9, mouthOpen: 0.04, haloSpin: 0.2, glow: 0.6, hair: 0.28, smile: 0.1, alert: 0, inward: 0, gears: 0 },
  listening: { speed: 1.35, wingSpread: 0.72, wingAngle: 0.28, eyeOpen: 1.15, mouthOpen: 0.12, haloSpin: 0.45, glow: 0.85, hair: 0.45, smile: 0.15, alert: 0, inward: 1, gears: 0 },
  thinking: { speed: 1.75, wingSpread: 0.48, wingAngle: -0.05, eyeOpen: 0.55, mouthOpen: 0.05, haloSpin: 1.8, glow: 0.8, hair: 0.65, smile: 0, alert: 0, inward: 0, gears: 0.4 },
  working: { speed: 2.3, wingSpread: 0.65, wingAngle: 0.15, eyeOpen: 0.85, mouthOpen: 0.08, haloSpin: 3.1, glow: 0.9, hair: 0.85, smile: 0, alert: 0, inward: 0, gears: 1 },
  speaking: { speed: 1.65, wingSpread: 0.85, wingAngle: 0.22, eyeOpen: 1.05, mouthOpen: 0.55, haloSpin: 0.85, glow: 1.0, hair: 0.75, smile: 0.2, alert: 0, inward: 0, gears: 0 },
  happy: { speed: 1.45, wingSpread: 0.92, wingAngle: 0.32, eyeOpen: 0.8, mouthOpen: 0.28, haloSpin: 1.1, glow: 0.95, hair: 0.5, smile: 1, alert: 0, inward: 0, gears: 0 },
  sleeping: { speed: 0.35, wingSpread: 0.12, wingAngle: -0.22, eyeOpen: 0, mouthOpen: 0.02, haloSpin: 0.05, glow: 0.28, hair: 0.12, smile: 0.05, alert: 0, inward: 0, gears: 0 },
  alert: { speed: 2.8, wingSpread: 1.0, wingAngle: 0.45, eyeOpen: 1.28, mouthOpen: 0.48, haloSpin: 3.6, glow: 1.0, hair: 1.15, smile: -0.4, alert: 1, inward: 0, gears: 0.2 },
};
const RINGS = 4;
const WHITE = [255, 255, 255];
const reduced = matchMedia('(prefers-reduced-motion: reduce)');

export class SirenFace extends BaseFace {
  constructor(canvas, opts) {
    super(canvas, opts);
    this.cur = { ...TARGETS.idle };
    const p = paletteFor('idle');
    this.main = p.main;
    this.accent = p.accent;
    this.sim = 0;
    this.lvl = 0;
    this.rings = [0, 0.25, 0.5, 0.75];
    this.blinkTimer = 3.2;
    this.blink = 0;
    this.samples = new Array(64).fill(0);
    const count = opts?.compact ? 18 : 28;
    this.particles = Array.from({ length: count }, (_, i) => ({
      angle: (i / count) * Math.PI * 2,
      dist: 0.25 + Math.random() * 0.85,
      size: 0.008 + Math.random() * 0.018,
      speed: 0.2 + Math.random() * 0.45,
      note: i % 5 === 0,
    }));
  }

  layout() {
    this.cx = this.w / 2;
    this.cy = this.h / 2;
    this.R = Math.min(this.w, this.h) * 0.36; // nothing clips at any size
  }

  // 64 waveform samples while speaking (or a gentle stand-in), as the original custom face read them.
  readSamples(wave, level) {
    for (let i = 0; i < 64; i++) this.samples[i] = wave ? wave[Math.floor((i / 64) * wave.length)] : Math.sin(i / 4 + this.t * 8) * level * 0.5;
    return this.samples;
  }

  draw(dt) {
    const g = this.ctx;
    const shown = faceState();
    const target = TARGETS[shown] || TARGETS[baseState(shown)] || TARGETS.idle;
    const pal = paletteFor(shown);
    const ease = (k) => Math.min(1, dt * k);
    this.main = lerpColor(this.main, pal.main, ease(6));
    this.accent = lerpColor(this.accent, pal.accent, ease(6));
    for (const k of Object.keys(target)) this.cur[k] = lerp(this.cur[k], target[k], ease(5.5));
    const { level, wave } = audio();
    this.lvl = lerp(this.lvl, level, ease(12));
    const cur = this.cur;
    const lvl = this.lvl;
    const motion = reduced.matches ? 0.25 : 1;
    this.sim += dt * cur.speed * motion;
    const sim = this.sim;

    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blink = Math.min(1, this.blink + dt * 18);
      if (this.blink >= 1) this.blinkTimer = 2.8 + Math.random() * 3.5;
    } else this.blink = Math.max(0, this.blink - dt * 12);

    const { cx, cy, R, w, h } = this;
    g.clearRect(0, 0, w, h);
    if (R <= 5) return;
    const samples = this.readSamples(wave, lvl);
    const main = this.main;
    const acc = this.accent;
    const hi = lerpColor(main, WHITE, 0.55);
    const glow = cur.glow;
    const floatY = Math.sin(sim * 1.6) * R * 0.03 * motion;
    const floatX = Math.cos(sim * 1.1) * R * 0.015 * motion;
    const tilt = Math.sin(sim * 0.9) * 0.035 * motion;

    this.aura(g, cx, cy, R, lvl, sim, main, acc, glow);
    this.halo(g, cx, cy, R, dt, lvl, sim, samples, shown, main, acc, hi, glow);
    this.hair(g, cx + floatX, cy + floatY, R, sim, main, acc, hi, glow);
    g.save();
    g.translate(cx + floatX, cy + floatY);
    g.rotate(tilt);
    this.fins(g, R, lvl, sim, samples, main, acc, hi, glow);
    this.head(g, R, lvl, sim, main, acc, hi, glow);
    this.eyes(g, R, sim, shown, main, acc, hi, glow);
    this.mouth(g, R, lvl, shown, samples, sim, acc, hi, glow);
    g.restore();
    this.motes(g, cx, cy, R, dt, lvl, shown, motion, acc, hi, glow);
  }

  aura(g, cx, cy, R, lvl, sim, main, acc, glow) {
    const r = R * (1.25 + lvl * 0.22 + Math.sin(sim * 2) * 0.04);
    const grad = g.createRadialGradient(cx, cy, R * 0.08, cx, cy, r);
    grad.addColorStop(0, rgba(main, 0.26 * glow));
    grad.addColorStop(0.45, rgba(acc, 0.14 * glow));
    grad.addColorStop(0.78, rgba(main, 0.04 * glow));
    grad.addColorStop(1, rgba(main, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
  }

  // Song rings (outward while singing, inward while listening), the lyre halo and the harp strings.
  halo(g, cx, cy, R, dt, lvl, sim, samples, shown, main, acc, hi, glow) {
    const cur = this.cur;
    g.save();
    g.translate(cx, cy);
    const dir = cur.inward > 0.5 ? -1 : 1;
    const speed = (0.22 + lvl * 0.45) * (reduced.matches ? 0.3 : 1);
    for (let i = 0; i < RINGS; i++) {
      this.rings[i] = (this.rings[i] + dt * speed * dir + 1) % 1;
      const prog = this.rings[i];
      const ringR = R * (0.38 + prog * 0.82);
      g.beginPath();
      for (let s = 0; s <= 64; s++) {
        const a = (s / 64) * Math.PI * 2;
        const v = samples[s % 64] || Math.sin(a * 6 + sim * 4) * 0.15;
        const r = ringR + v * R * (0.04 + lvl * 0.14) * Math.sin(prog * Math.PI);
        if (s === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath();
      g.strokeStyle = rgba(i % 2 === 0 ? main : acc, Math.sin(prog * Math.PI) * (0.18 + lvl * 0.32) * glow);
      g.lineWidth = Math.max(1, R * 0.008 * (1 + lvl));
      g.stroke();
    }

    const turn = sim * cur.haloSpin;
    g.save();
    g.rotate(turn);
    const haloR = R * 0.86;
    g.strokeStyle = rgba(acc, 0.3 * glow);
    g.lineWidth = Math.max(1, R * 0.009);
    g.setLineDash([R * 0.06, R * 0.04, R * 0.015, R * 0.04]);
    g.beginPath();
    g.arc(0, 0, haloR, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      g.fillStyle = rgba(hi, (0.35 + 0.35 * Math.sin(sim * 3 + i)) * glow);
      g.beginPath();
      g.arc(Math.cos(a) * haloR, Math.sin(a) * haloR, R * 0.016, 0, Math.PI * 2);
      g.fill();
    }
    if (cur.gears > 0.05 || shown === 'thinking') {
      g.rotate(-turn * 2.2);
      g.strokeStyle = rgba(main, (0.25 + cur.gears * 0.35) * glow);
      g.lineWidth = Math.max(1, R * 0.007);
      g.setLineDash([R * 0.02, R * 0.03]);
      g.beginPath();
      g.arc(0, 0, R * 0.72, 0, Math.PI * 2);
      g.stroke();
      g.setLineDash([]);
    }
    g.restore();

    for (let side = -1; side <= 1; side += 2) {
      for (let s = 0; s < 7; s++) {
        const frac = (s + 1) / 8;
        const sx = side * R * (0.38 + frac * 0.38);
        const top = -R * (0.55 - frac * 0.25);
        const bottom = R * (0.45 - frac * 0.2);
        const v = samples[(s * 7) % 64] || 0;
        const pluck = (v * R * 0.09 + Math.sin(sim * 8 + s) * R * 0.012 * lvl) * side;
        g.beginPath();
        g.moveTo(sx, top);
        g.quadraticCurveTo(sx + pluck, (top + bottom) / 2, sx * 0.85, bottom);
        g.strokeStyle = rgba(hi, (0.14 + Math.abs(v) * 0.45 + lvl * 0.25) * glow);
        g.lineWidth = Math.max(0.8, R * 0.005);
        g.stroke();
      }
    }
    g.restore();
  }

  hair(g, x, y, R, sim, main, acc, hi, glow) {
    const turbulence = this.cur.hair;
    g.save();
    g.translate(x, y);
    g.lineCap = 'round';
    for (let i = 0; i < 14; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      const idx = Math.floor(i / 2);
      const ratio = idx / 6;
      const sx = side * R * (0.12 + ratio * 0.22);
      const sy = -R * (0.28 - ratio * 0.18);
      const len = R * (0.68 + (1 - ratio) * 0.25);
      const w1 = Math.sin(sim * 2.1 + idx * 0.9 + side) * R * 0.16 * turbulence;
      const w2 = Math.cos(sim * 1.5 - idx * 0.7) * R * 0.22 * turbulence;
      const ex = sx + side * (R * 0.22 + ratio * R * 0.38) + w2;
      const ey = sy + len * (0.55 + ratio * 0.35) + Math.abs(w1) * 0.3;
      const c1 = [sx + side * R * 0.25 + w1, sy - R * 0.15];
      const c2 = [ex - w1 * 0.8, sy + len * 0.35 + w2 * 0.5];
      const grad = g.createLinearGradient(sx, sy, ex, ey);
      grad.addColorStop(0, rgba(i % 3 === 0 ? acc : main, 0.55 * glow));
      grad.addColorStop(0.6, rgba(acc, 0.28 * glow));
      grad.addColorStop(1, rgba(main, 0));
      for (const [style, width] of [[grad, R * 0.045 * (1 - ratio * 0.5)], [rgba(hi, 0.22 * glow), R * 0.008]]) {
        g.beginPath();
        g.moveTo(sx, sy);
        g.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], ex, ey);
        g.strokeStyle = style;
        g.lineWidth = width;
        g.stroke();
      }
    }
    g.restore();
  }

  // The feathered ear-fins: they spread with listening and singing, and flutter with the voice.
  fins(g, R, lvl, sim, samples, main, acc, hi, glow) {
    const cur = this.cur;
    for (let side = -1; side <= 1; side += 2) {
      g.save();
      g.scale(side, 1);
      g.translate(R * 0.29, -R * 0.04);
      for (let f = 0; f < 7; f++) {
        const fr = f / 6;
        const boost = Math.abs(samples[(f * 8) % 64] || 0) * 0.22;
        const rot = -0.58 + fr * 1.15 - cur.wingAngle * (1 - fr * 0.5);
        const spread = (0.5 - fr) * (cur.wingSpread * 0.45 + lvl * 0.25 + boost);
        const flutter = Math.sin(sim * 3.8 - f * 0.55) * 0.06 * cur.hair;
        g.save();
        g.rotate(rot - spread + flutter);
        const len = R * (0.54 - Math.abs(fr - 0.35) * 0.26) * (0.85 + cur.wingSpread * 0.22 + lvl * 0.15);
        const width = R * (0.068 - fr * 0.02);
        const curve = -R * 0.04 * (1 - fr);
        const grad = g.createLinearGradient(0, 0, len, 0);
        grad.addColorStop(0, rgba(main, 0.65 * glow));
        grad.addColorStop(0.65, rgba(acc, (0.4 + boost) * glow));
        grad.addColorStop(1, rgba(hi, 0.08 * glow));
        const line = Math.max(1, R * 0.006);
        g.beginPath();
        g.moveTo(0, 0);
        g.quadraticCurveTo(len * 0.45, -width + curve, len, curve * 1.4);
        g.quadraticCurveTo(len * 0.55, width + curve * 0.6, 0, 0);
        g.closePath();
        g.fillStyle = grad;
        g.fill();
        g.strokeStyle = rgba(hi, (0.48 + lvl * 0.35) * glow);
        g.lineWidth = line;
        g.stroke();
        g.beginPath();
        g.moveTo(0, 0);
        g.quadraticCurveTo(len * 0.5, curve * 0.3, len * 0.88, curve * 1.15);
        g.lineWidth = line * 0.7;
        g.stroke();
        g.fillStyle = rgba(hi, (0.5 + lvl * 0.4) * glow);
        g.beginPath();
        g.arc(len * 0.78, curve * 0.95, R * 0.011, 0, Math.PI * 2);
        g.fill();
        g.restore();
      }
      g.restore();
    }
  }

  // Neck with glowing gills, the face, cheek scales and the crown with its mind-gem.
  head(g, R, lvl, sim, main, acc, hi, glow) {
    const neck = g.createLinearGradient(0, R * 0.28, 0, R * 0.68);
    neck.addColorStop(0, rgba(main, 0.32 * glow));
    neck.addColorStop(0.6, rgba(acc, 0.15 * glow));
    neck.addColorStop(1, rgba(main, 0));
    g.beginPath();
    g.moveTo(-R * 0.13, R * 0.26);
    g.quadraticCurveTo(-R * 0.15, R * 0.48, -R * 0.28, R * 0.64);
    g.quadraticCurveTo(0, R * 0.72, R * 0.28, R * 0.64);
    g.quadraticCurveTo(R * 0.15, R * 0.48, R * 0.13, R * 0.26);
    g.closePath();
    g.fillStyle = neck;
    g.fill();
    g.lineWidth = Math.max(1, R * 0.006);
    for (let side = -1; side <= 1; side += 2) {
      for (let i = 0; i < 3; i++) {
        const gy = R * (0.36 + i * 0.055);
        const gx = side * R * (0.075 + i * 0.01);
        g.beginPath();
        g.moveTo(gx, gy);
        g.quadraticCurveTo(gx + side * R * 0.05, gy + R * 0.015, gx + side * R * 0.08, gy - R * 0.005);
        g.strokeStyle = rgba(hi, (0.35 + lvl * 0.45 + 0.2 * Math.sin(sim * 4 + i)) * glow);
        g.stroke();
      }
    }

    g.beginPath();
    g.moveTo(0, -R * 0.38);
    g.bezierCurveTo(R * 0.26, -R * 0.38, R * 0.33, -R * 0.16, R * 0.3, R * 0.04);
    g.bezierCurveTo(R * 0.27, R * 0.21, R * 0.13, R * 0.33, 0, R * 0.37);
    g.bezierCurveTo(-R * 0.13, R * 0.33, -R * 0.27, R * 0.21, -R * 0.3, R * 0.04);
    g.bezierCurveTo(-R * 0.33, -R * 0.16, -R * 0.26, -R * 0.38, 0, -R * 0.38);
    g.closePath();
    const face = g.createRadialGradient(0, -R * 0.05, R * 0.04, 0, 0, R * 0.42);
    face.addColorStop(0, rgba(main, 0.24 * glow));
    face.addColorStop(0.65, rgba(acc, 0.38 * glow));
    face.addColorStop(1, rgba(main, 0.62 * glow));
    g.fillStyle = face;
    g.fill();
    g.strokeStyle = rgba(hi, (0.65 + lvl * 0.25) * glow);
    g.lineWidth = Math.max(1.2, R * 0.011);
    g.stroke();

    for (let side = -1; side <= 1; side += 2) {
      for (let d = 0; d < 4; d++) {
        g.fillStyle = rgba(hi, (0.35 + 0.45 * Math.sin(sim * 3.5 + d) + lvl * 0.3) * glow);
        g.beginPath();
        g.arc(side * R * (0.14 + d * 0.036), R * (0.04 + d * 0.014 - (d % 2) * 0.012), R * (0.009 - d * 0.0012), 0, Math.PI * 2);
        g.fill();
      }
    }

    g.save();
    g.translate(0, -R * 0.32);
    g.beginPath();
    g.moveTo(-R * 0.26, R * 0.08);
    g.quadraticCurveTo(0, -R * 0.08, R * 0.26, R * 0.08);
    g.quadraticCurveTo(0, -R * 0.01, -R * 0.26, R * 0.08);
    g.closePath();
    g.fillStyle = rgba(acc, 0.55 * glow);
    g.fill();
    g.strokeStyle = rgba(hi, 0.75 * glow);
    g.lineWidth = Math.max(1, R * 0.008);
    g.stroke();
    for (let i = 0; i < 7; i++) {
      const n = (i / 6) * 2 - 1;
      const len = R * (0.24 - Math.abs(n) * 0.12) * (1 + lvl * 0.15);
      g.save();
      g.rotate(n * 0.65);
      g.beginPath();
      g.moveTo(-R * 0.018, 0);
      g.lineTo(0, -len);
      g.lineTo(R * 0.018, 0);
      g.closePath();
      g.fillStyle = rgba(hi, (0.55 - Math.abs(n) * 0.2) * glow);
      g.fill();
      g.restore();
    }
    const pulse = 1 + 0.25 * Math.sin(sim * 5) + lvl * 0.2;
    g.beginPath();
    g.moveTo(0, -R * 0.07 * pulse);
    g.lineTo(R * 0.035 * pulse, 0);
    g.lineTo(0, R * 0.07 * pulse);
    g.lineTo(-R * 0.035 * pulse, 0);
    g.closePath();
    g.fillStyle = rgba(hi, 0.9 * glow);
    g.fill();
    g.strokeStyle = rgba(main, 0.9 * glow);
    g.lineWidth = Math.max(1, R * 0.007);
    g.stroke();
    g.restore();

    // Nose bridge
    g.beginPath();
    g.moveTo(0, -R * 0.14);
    g.lineTo(0, R * 0.045);
    g.moveTo(-R * 0.026, R * 0.055);
    g.quadraticCurveTo(0, R * 0.072, R * 0.026, R * 0.055);
    g.strokeStyle = rgba(hi, 0.42 * glow);
    g.lineWidth = Math.max(1, R * 0.007);
    g.lineCap = 'round';
    g.stroke();
  }

  // Slanted luminous eyes with slit pupils that widen with the voice; they glance about while thinking.
  eyes(g, R, sim, shown, main, acc, hi, glow) {
    const cur = this.cur;
    const open = Math.max(0, cur.eyeOpen * (1 - this.blink * 0.95));
    for (let side = -1; side <= 1; side += 2) {
      g.save();
      g.translate(side * R * 0.125, -R * 0.075);
      g.rotate(side * -0.12);
      const ew = R * 0.082;
      const eh = R * 0.044 * open;
      const lift = (cur.eyeOpen - 0.9) * R * 0.03 - cur.alert * R * 0.02;
      g.save();
      g.rotate(cur.alert * side * 0.22);
      g.beginPath();
      g.moveTo(-ew * 1.15, -R * 0.045 - lift);
      g.quadraticCurveTo(0, -R * 0.085 - lift, ew * 1.25, -R * 0.035 - lift);
      g.strokeStyle = rgba(hi, 0.75 * glow);
      g.lineWidth = Math.max(1.2, R * 0.01);
      g.lineCap = 'round';
      g.stroke();
      g.restore();
      if (open > 0.08) {
        g.beginPath();
        g.moveTo(-ew, 0);
        g.quadraticCurveTo(0, -eh * 1.35, ew, 0);
        g.quadraticCurveTo(0, eh * 1.35 * (1 - cur.smile * 0.45), -ew, 0);
        g.closePath();
        const eye = g.createRadialGradient(0, 0, R * 0.005, 0, 0, ew);
        eye.addColorStop(0, rgba(WHITE, 0.95 * glow));
        eye.addColorStop(0.55, rgba(hi, 0.85 * glow));
        eye.addColorStop(1, rgba(main, 0.45 * glow));
        g.fillStyle = eye;
        g.fill();
        g.strokeStyle = rgba(hi, 0.9 * glow);
        g.lineWidth = Math.max(1, R * 0.008);
        g.stroke();
        const gaze = shown === 'thinking' || shown === 'working' ? Math.sin(sim * 2.5) * ew * 0.25 * side : 0;
        g.beginPath();
        g.arc(gaze, 0, Math.min(eh * 0.85, ew * 0.45), 0, Math.PI * 2);
        g.strokeStyle = rgba(acc, 0.9 * glow);
        g.lineWidth = Math.max(1, R * 0.007);
        g.stroke();
        g.beginPath();
        g.ellipse(gaze, 0, R * (0.009 + this.lvl * 0.014), eh * 0.82, 0, 0, Math.PI * 2);
        g.fillStyle = rgba(main, 0.95);
        g.fill();
      } else {
        g.beginPath();
        g.moveTo(-ew, 0);
        g.quadraticCurveTo(0, R * 0.025, ew, 0);
        g.strokeStyle = rgba(hi, 0.7 * glow);
        g.lineWidth = Math.max(1.2, R * 0.01);
        g.stroke();
      }
      g.restore();
    }
  }

  mouth(g, R, lvl, shown, samples, sim, acc, hi, glow) {
    const cur = this.cur;
    g.save();
    g.translate(0, R * 0.175);
    const mw = R * (0.095 + lvl * 0.045 + Math.max(0, cur.smile) * 0.02);
    const opening = cur.mouthOpen * (0.35 + lvl * 1.45) + (shown === 'speaking' ? 0.08 + lvl * 0.35 : 0);
    const mh = R * Math.min(0.11, Math.max(0.006, opening * 0.14));
    const corner = -cur.smile * R * 0.028;
    g.beginPath();
    g.moveTo(-mw, corner);
    g.quadraticCurveTo(-mw * 0.45, -mh - R * 0.018, 0, -mh * 0.75);
    g.quadraticCurveTo(mw * 0.45, -mh - R * 0.018, mw, corner);
    g.quadraticCurveTo(0, mh * 1.35 + R * 0.012, -mw, corner);
    g.closePath();
    const lips = g.createRadialGradient(0, 0, R * 0.005, 0, 0, mw);
    lips.addColorStop(0, rgba(hi, (0.45 + lvl * 0.5) * glow));
    lips.addColorStop(1, rgba(acc, 0.25 * glow));
    g.fillStyle = lips;
    g.fill();
    g.strokeStyle = rgba(hi, (0.75 + lvl * 0.25) * glow);
    g.lineWidth = Math.max(1.1, R * 0.009);
    g.stroke();
    if (mh > R * 0.014 || lvl > 0.04) {
      g.save();
      g.clip();
      g.beginPath();
      for (let i = 0; i <= 24; i++) {
        const t = i / 24;
        const v = samples[Math.floor(t * 63)] || Math.sin(t * 12 + sim * 14);
        const y = v * mh * (0.8 + lvl * 1.4) * Math.sin(t * Math.PI);
        if (i === 0) g.moveTo((t * 2 - 1) * mw * 0.92, y);
        else g.lineTo((t * 2 - 1) * mw * 0.92, y);
      }
      g.strokeStyle = rgba(WHITE, 0.92);
      g.lineWidth = Math.max(1.2, R * 0.01);
      g.stroke();
      g.restore();
    }
    g.restore();
  }

  // Sea-foam pearls and little notes; drawn in while listening, drifting out while singing. The name
  // (or an alert) on a plaque below, and an alert shockwave.
  motes(g, cx, cy, R, dt, lvl, shown, motion, acc, hi, glow) {
    const cur = this.cur;
    g.save();
    g.translate(cx, cy);
    this.particles.forEach((p, i) => {
      const speed = p.speed * cur.speed * motion;
      if (cur.inward > 0.5) {
        p.dist -= dt * speed * 0.45 * (1 + lvl);
        if (p.dist < 0.22) p.dist = 1.05;
      } else {
        p.dist += dt * speed * 0.35 * (1 + lvl * 1.5);
        if (p.dist > 1.12) p.dist = 0.25;
      }
      p.angle += dt * 0.25 * (i % 2 === 0 ? 1 : -1) * cur.speed * motion;
      const x = Math.cos(p.angle) * R * p.dist;
      const y = Math.sin(p.angle) * R * p.dist;
      const a = Math.sin(((p.dist - 0.22) / 0.9) * Math.PI) * (0.45 + lvl * 0.45) * glow;
      const r = R * p.size * (1 + lvl * 0.5);
      g.fillStyle = rgba(i % 2 === 0 ? hi : acc, Math.max(0, a));
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
      if (p.note && (shown === 'speaking' || shown === 'happy' || lvl > 0.15)) {
        g.beginPath();
        g.moveTo(x + r, y);
        g.lineTo(x + r, y - r * 3.2);
        g.quadraticCurveTo(x + r * 2.4, y - r * 2.4, x + r * 2.2, y - r * 1.4);
        g.strokeStyle = rgba(hi, Math.max(0, a) * 0.85);
        g.lineWidth = Math.max(1, R * 0.005);
        g.stroke();
      }
    });
    if (cur.alert > 0.05) {
      const shock = R * (0.78 + 0.06 * Math.sin(this.sim * 12));
      g.strokeStyle = rgba(acc, 0.55 * cur.alert);
      g.lineWidth = Math.max(1.2, R * 0.01);
      g.beginPath();
      for (let i = 0; i <= 32; i++) {
        const a = (i / 32) * Math.PI * 2 + this.sim * 0.8;
        const r = i % 2 === 0 ? shock : shock + R * 0.1 * cur.alert;
        if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath();
      g.stroke();
    }
    if (this.name && Math.min(this.w, this.h) >= 220) {
      g.font = `600 ${Math.max(10, Math.min(16, Math.round(R * 0.095)))}px Cinzel, Georgia, serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = rgba(hi, 0.52 * glow);
      g.fillText(this.name.toUpperCase(), 0, R * 1.08);
    }
    g.restore();
  }
}
