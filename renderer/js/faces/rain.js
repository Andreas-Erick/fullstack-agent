// Code-rain face: falling glyphs that idle like a screensaver. When the agent speaks, a face (the
// agent's image, or a built-in portrait) emerges in the glyphs and breathes with the voice.
import { BaseFace, audio, faceState, paletteFor, rgba, lerp, lerpColor } from './common.js';

const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEF<>/*+=#';

export class RainFace extends BaseFace {
  constructor(canvas, opts) {
    super(canvas, opts);
    const p = paletteFor('idle');
    this.cur = { main: p.main };
    this.reveal = 0;
  }

  setAvatar(dataUrl) {
    super.setAvatar(dataUrl);
    this.mask = null;
  }

  layout() {
    this.cell = this.compact ? 11 : 16;
    this.cols = Math.ceil(this.w / this.cell);
    this.rows = Math.ceil(this.h / this.cell);
    this.drops = Array.from({ length: this.cols }, () => ({ y: Math.random() * -this.rows, v: 6 + Math.random() * 14 }));
    this.chars = Array.from({ length: this.cols * this.rows }, () => GLYPHS[(Math.random() * GLYPHS.length) | 0]);
    this.mask = null;
  }

  // Brightness mask (0..1 per cell) of the portrait, centered.
  buildMask() {
    const size = Math.min(this.cols, this.rows) * 0.8;
    const cv = document.createElement('canvas');
    cv.width = this.cols;
    cv.height = this.rows;
    const g = cv.getContext('2d');
    const x = (this.cols - size) / 2;
    const y = (this.rows - size) / 2;
    if (this.avatar) {
      g.save();
      g.beginPath();
      g.ellipse(this.cols / 2, this.rows / 2, size / 2.2, size / 2, 0, 0, Math.PI * 2);
      g.clip();
      g.drawImage(this.avatar, x, y, size, size);
      g.restore();
    } else {
      // Procedural portrait: head, eyes, mouth (the mouth is animated separately).
      g.fillStyle = '#888';
      g.beginPath();
      g.ellipse(this.cols / 2, this.rows / 2, size / 3, size / 2.3, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      for (const s of [-1, 1]) {
        g.beginPath();
        g.ellipse(this.cols / 2 + (s * size) / 8, this.rows / 2 - size / 10, size / 16, size / 30, 0, 0, Math.PI * 2);
        g.fill();
      }
    }
    const d = g.getImageData(0, 0, this.cols, this.rows).data;
    this.mask = new Float32Array(this.cols * this.rows);
    for (let i = 0; i < this.mask.length; i++) this.mask[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255 * (d[i * 4 + 3] / 255);
    this.maskSize = size;
  }

  draw(dt) {
    const g = this.ctx;
    const st = faceState();
    const target = paletteFor(st);
    this.cur.main = lerpColor(this.cur.main, target.main, 1 - Math.pow(0.02, dt));
    const main = this.cur.main;
    const { level } = audio();
    if (!this.mask) this.buildMask();
    const wantReveal = st === 'speaking' ? 1 : st === 'listening' ? 0.45 : st === 'thinking' ? 0.25 : 0;
    this.reveal = lerp(this.reveal, wantReveal, 1 - Math.pow(0.1, dt));
    const speed = st === 'thinking' ? 2.2 : st === 'speaking' ? 1.3 : 1;

    g.fillStyle = 'rgba(0,0,0,1)';
    g.clearRect(0, 0, this.w, this.h);
    g.font = `${this.cell - 2}px "JetBrains Mono", Consolas, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    const mouthY = this.rows / 2 + this.maskSize / 4.5;
    for (let c = 0; c < this.cols; c++) {
      const drop = this.drops[c];
      drop.y += dt * drop.v * speed;
      if (drop.y - 20 > this.rows) {
        drop.y = Math.random() * -10;
        drop.v = 6 + Math.random() * 14;
      }
      for (let r = 0; r < this.rows; r++) {
        const idx = r * this.cols + c;
        const dist = drop.y - r;
        let a = dist >= 0 && dist < 18 ? (1 - dist / 18) * 0.55 : 0.04;
        let m = this.mask[idx] || 0;
        // Animated mouth for the built-in portrait.
        if (!this.avatar && Math.abs(r - mouthY) < 1 + level * 3 && Math.abs(c - this.cols / 2) < this.maskSize / 8) m = 1;
        a = Math.max(a, m * this.reveal * (0.55 + level * 0.45 + 0.1 * Math.sin(this.t * 3 + r * 0.3)));
        if (a < 0.03) continue;
        if (Math.random() < 0.002) this.chars[idx] = GLYPHS[(Math.random() * GLYPHS.length) | 0];
        g.fillStyle = dist >= 0 && dist < 1 ? rgba([230, 255, 240], Math.min(1, a + 0.3)) : rgba(main, Math.min(1, a));
        g.fillText(this.chars[idx], c * this.cell + this.cell / 2, r * this.cell);
      }
    }
  }
}
