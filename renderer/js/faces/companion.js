// Companion: a friendly character face. Eyes and mouth carry the state:
//   idle      – relaxed, blinks, glances around        listening – eyes wide, head tilted, rings react to the mic
//   thinking  – looks up, dots circle above it         working   – focused, narrowed eyes, sparks orbit
//   speaking  – mouth moves with the voice             happy     – ^ ^ eyes, a big smile, sparkles
//   sleeping  – eyes closed, slow breathing, z's       alert     – worried brows, a frown, red
import { BaseFace, audio, faceState, paletteFor, rgba, lerp, lerpColor } from './common.js';

// Target expression per state.
const LOOK = {
  idle: { open: 1, size: 1, smile: 0.35, mouth: 0, tilt: 0, brow: 0, squint: 0 },
  listening: { open: 1.15, size: 1.12, smile: 0.2, mouth: 0.08, tilt: 0.12, brow: 0.25, squint: 0 },
  thinking: { open: 0.75, size: 0.95, smile: 0.05, mouth: 0, tilt: -0.05, brow: 0.35, squint: 0.15 },
  working: { open: 0.55, size: 0.9, smile: 0.1, mouth: 0, tilt: 0, brow: -0.25, squint: 0.45 },
  speaking: { open: 1, size: 1, smile: 0.3, mouth: 0, tilt: 0, brow: 0.1, squint: 0 },
  happy: { open: 1, size: 1, smile: 1, mouth: 0.15, tilt: 0.06, brow: 0.3, squint: 0 },
  sleeping: { open: 0, size: 1, smile: 0.1, mouth: 0, tilt: 0.05, brow: 0, squint: 0 },
  alert: { open: 1.1, size: 0.9, smile: -0.6, mouth: 0.05, tilt: 0, brow: 0.6, squint: 0 },
};

export class CompanionFace extends BaseFace {
  constructor(canvas, opts) {
    super(canvas, opts);
    const p = paletteFor('idle');
    this.cur = { main: p.main, accent: p.accent, ...LOOK.idle };
    this.gaze = [0, 0];
    this.gazeTarget = [0, 0];
    this.nextGlance = 0;
    this.blink = 0;
    this.nextBlink = 2;
    this.level = 0;
    this.sparks = [];
    this.zs = [];
  }

  draw(dt) {
    const g = this.ctx;
    const { w, h } = this;
    const st = faceState();
    const target = paletteFor(st);
    const look = LOOK[st] || LOOK.idle;
    const k = 1 - Math.pow(0.004, dt);
    this.cur.main = lerpColor(this.cur.main, target.main, k);
    this.cur.accent = lerpColor(this.cur.accent, target.accent, k);
    for (const key of Object.keys(LOOK.idle)) this.cur[key] = lerp(this.cur[key], look[key], k);
    const { level } = audio();
    this.level = lerp(this.level, level, 1 - Math.pow(0.0005, dt));

    // Blinks (not while asleep or happy) and glances.
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && st !== 'sleeping' && st !== 'happy') {
      this.blink = 1;
      this.nextBlink = 2.5 + Math.random() * 4;
    }
    this.blink = Math.max(0, this.blink - dt * 7);
    this.nextGlance -= dt;
    if (st === 'thinking') this.gazeTarget = [0.35, -0.55];
    else if (st === 'working') this.gazeTarget = [Math.sin(this.t * 1.5) * 0.4, 0.3];
    else if (st === 'listening' || st === 'speaking' || st === 'happy') this.gazeTarget = [0, 0];
    else if (this.nextGlance <= 0) {
      this.gazeTarget = st === 'sleeping' ? [0, 0] : [(Math.random() - 0.5) * 0.8, (Math.random() - 0.5) * 0.5];
      this.nextGlance = 1.5 + Math.random() * 3;
    }
    this.gaze = [lerp(this.gaze[0], this.gazeTarget[0], 1 - Math.pow(0.002, dt)), lerp(this.gaze[1], this.gazeTarget[1], 1 - Math.pow(0.002, dt))];

    g.clearRect(0, 0, w, h);
    const H = Math.min(w, h) * (this.compact ? 0.34 : 0.26);
    const breathe = st === 'sleeping' ? Math.sin(this.t * 0.9) * 0.025 : Math.sin(this.t * 1.6) * 0.01;
    const bob = Math.sin(this.t * (st === 'happy' ? 6 : 1.4)) * H * (st === 'happy' ? 0.03 : 0.015);
    const cx = w / 2;
    const cy = h * (this.compact ? 0.46 : 0.47) + bob;
    const main = this.cur.main;
    const accent = this.cur.accent;

    // Ambient glow
    const amb = g.createRadialGradient(cx, cy, H * 0.3, cx, cy, Math.max(w, h) * 0.6);
    amb.addColorStop(0, rgba(main, 0.16 + this.level * 0.12));
    amb.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = amb;
    g.fillRect(0, 0, w, h);

    // Listening: rings pulse with the voice coming in.
    if (st === 'listening') {
      for (let i = 0; i < 3; i++) {
        const p = (this.t * 0.8 + i / 3) % 1;
        g.strokeStyle = rgba(accent, (1 - p) * (0.25 + this.level * 0.6));
        g.lineWidth = 2;
        g.beginPath();
        g.arc(cx, cy, H * (1.15 + p * 0.7), 0, Math.PI * 2);
        g.stroke();
      }
    }

    g.save();
    g.translate(cx, cy);
    g.rotate(this.cur.tilt * 0.35);
    g.scale(1 + breathe, 1 - breathe * 0.6);

    // Head: a soft rounded shape with a rim light.
    const head = g.createRadialGradient(-H * 0.3, -H * 0.4, H * 0.1, 0, 0, H * 1.1);
    head.addColorStop(0, rgba(lerpColor(main, [255, 255, 255], 0.25), 0.32));
    head.addColorStop(0.7, rgba(main, 0.14));
    head.addColorStop(1, rgba(main, 0.05));
    g.fillStyle = head;
    g.shadowColor = rgba(main, 0.7);
    g.shadowBlur = 30 + this.level * 30;
    roundBlob(g, H, this.t);
    g.fill();
    g.shadowBlur = 0;
    g.strokeStyle = rgba(main, 0.75);
    g.lineWidth = 2;
    roundBlob(g, H, this.t);
    g.stroke();

    // Eyes
    const eyeY = -H * 0.12;
    const eyeDX = H * 0.36;
    const eyeR = H * 0.15 * this.cur.size;
    const open = Math.max(0, this.cur.open * (1 - this.blink) * (1 - this.cur.squint * 0.5));
    for (const side of [-1, 1]) {
      const ex = side * eyeDX + this.gaze[0] * H * 0.08;
      const ey = eyeY + this.gaze[1] * H * 0.06;
      g.save();
      g.translate(ex, ey);
      if (st === 'happy' && this.cur.smile > 0.7) {
        // ^ ^
        g.strokeStyle = rgba([255, 255, 255], 0.95);
        g.lineWidth = Math.max(2.5, H * 0.045);
        g.lineCap = 'round';
        g.beginPath();
        g.arc(0, eyeR * 0.5, eyeR * 0.9, Math.PI * 1.15, Math.PI * 1.85);
        g.stroke();
      } else if (open < 0.08) {
        // closed: a gentle curve
        g.strokeStyle = rgba([255, 255, 255], 0.8);
        g.lineWidth = Math.max(2, H * 0.035);
        g.lineCap = 'round';
        g.beginPath();
        g.arc(0, -eyeR * 0.2, eyeR * 0.85, Math.PI * 0.15, Math.PI * 0.85);
        g.stroke();
      } else {
        g.scale(1, open);
        g.fillStyle = rgba([255, 255, 255], 0.95);
        g.shadowColor = rgba(main, 0.9);
        g.shadowBlur = 12;
        g.beginPath();
        g.ellipse(0, 0, eyeR, eyeR * 1.15, 0, 0, Math.PI * 2);
        g.fill();
        g.shadowBlur = 0;
        // pupil + highlight
        const px = this.gaze[0] * eyeR * 0.35;
        const py = this.gaze[1] * eyeR * 0.35;
        g.fillStyle = rgba(lerpColor(main, [0, 0, 0], 0.55), 1);
        g.beginPath();
        g.arc(px, py, eyeR * (st === 'listening' ? 0.62 : 0.52), 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.9)';
        g.beginPath();
        g.arc(px - eyeR * 0.2, py - eyeR * 0.25, eyeR * 0.16, 0, Math.PI * 2);
        g.fill();
      }
      g.restore();
      // Brows: raised (curious, worried) or lowered (focused).
      g.strokeStyle = rgba(accent, 0.85);
      g.lineWidth = Math.max(2, H * 0.03);
      g.lineCap = 'round';
      const by = eyeY - eyeR * 1.7 - this.cur.brow * H * 0.06;
      const slant = (st === 'alert' ? -1 : 1) * side * this.cur.brow * H * 0.05 - (this.cur.brow < 0 ? side * this.cur.brow * H * 0.08 : 0);
      g.beginPath();
      g.moveTo(ex - eyeR * 0.9, by + slant);
      g.lineTo(ex + eyeR * 0.9, by - slant);
      g.stroke();
    }

    // Cheeks when happy
    if (this.cur.smile > 0.6) {
      g.fillStyle = rgba(accent, (this.cur.smile - 0.6) * 0.6);
      for (const side of [-1, 1]) {
        g.beginPath();
        g.ellipse(side * H * 0.55, H * 0.12, H * 0.1, H * 0.06, 0, 0, Math.PI * 2);
        g.fill();
      }
    }

    // Mouth: a smile curve that opens with the voice while speaking.
    const mouthY = H * 0.32;
    const mw = H * (0.26 + Math.max(0, this.cur.smile) * 0.12);
    const talk = st === 'speaking' ? Math.min(1, this.level * 1.4) : 0;
    const openMouth = Math.max(this.cur.mouth, talk) * H * 0.22;
    g.strokeStyle = rgba([255, 255, 255], 0.9);
    g.fillStyle = rgba(lerpColor(main, [0, 0, 0], 0.6), 0.9);
    g.lineWidth = Math.max(2, H * 0.035);
    g.lineCap = 'round';
    g.beginPath();
    const curve = this.cur.smile * H * 0.16;
    g.moveTo(-mw, mouthY);
    g.quadraticCurveTo(0, mouthY + curve + openMouth, mw, mouthY);
    if (openMouth > 1.5) {
      g.quadraticCurveTo(0, mouthY + curve * 0.3 - openMouth * 0.15, -mw, mouthY);
      g.fill();
    }
    g.stroke();
    g.restore();

    // Thinking: dots circle above the head. Working: sparks orbit it.
    if (st === 'thinking') {
      for (let i = 0; i < 3; i++) {
        const a = this.t * 2.2 + (i * Math.PI * 2) / 3;
        g.fillStyle = rgba(accent, 0.5 + 0.5 * Math.sin(this.t * 4 + i));
        g.beginPath();
        g.arc(cx + Math.cos(a) * H * 0.35, cy - H * 1.35 + Math.sin(a) * H * 0.1, H * 0.06, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (st === 'working') {
      for (let i = 0; i < 4; i++) {
        const a = this.t * 2.6 + (i * Math.PI) / 2;
        const r = H * 1.3;
        g.fillStyle = rgba(i % 2 ? accent : main, 0.9);
        g.beginPath();
        g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.85, H * 0.045, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (st === 'happy' && Math.random() < dt * 10) this.sparks.push({ x: cx + (Math.random() - 0.5) * H * 2.6, y: cy - H * (0.6 + Math.random() * 0.8), t: 0 });
    for (const s of this.sparks) {
      s.t += dt;
      const a = Math.max(0, 1 - s.t);
      g.fillStyle = rgba(accent, a);
      star(g, s.x, s.y - s.t * H * 0.3, H * 0.05 * (1 + s.t));
    }
    this.sparks = this.sparks.filter((s) => s.t < 1);
    if (st === 'sleeping') {
      this.zAcc = (this.zAcc || 0) + dt;
      if (this.zAcc > 1.6) {
        this.zAcc = 0;
        this.zs.push({ t: 0 });
      }
    }
    for (const z of this.zs) {
      z.t += dt;
      g.fillStyle = rgba(accent, 0.8 * Math.min(1, z.t) * (1 - z.t / 4));
      g.font = `700 ${Math.round(H * (0.22 + z.t * 0.07))}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-display') || 'sans-serif'}`;
      g.fillText('z', cx + H * 0.7 + z.t * H * 0.18 + Math.sin(z.t * 2) * H * 0.08, cy - H * 0.8 - z.t * H * 0.3);
    }
    this.zs = this.zs.filter((z) => z.t < 4);
  }
}

// A slightly wobbly rounded head (squircle with a gentle, living edge).
function roundBlob(g, r, t) {
  g.beginPath();
  const n = 48;
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const wob = 1 + Math.sin(a * 3 + t * 0.8) * 0.012 + Math.sin(a * 5 - t * 0.6) * 0.008;
    const c = Math.cos(a);
    const s = Math.sin(a);
    // squircle radius
    const k = Math.pow(Math.pow(Math.abs(c), 3) + Math.pow(Math.abs(s), 3), -1 / 3);
    const rr = r * wob * (0.75 + 0.25 * k);
    const x = c * rr * 1.08;
    const y = s * rr;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.closePath();
}

function star(g, x, y, r) {
  g.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rr = i % 2 ? r * 0.35 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}
