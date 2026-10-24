// The agent face: a "living circuit board". Traces radiate from a central core and energy pulses
// travel along them. Colors, core shape and trace style come from the active theme; the motion
// reacts to the agent state:
//   idle      – slow, sparse outward pulses, breathing core
//   listening – pulses flow inward, driven by the microphone level
//   thinking  – fast pulses in both directions, spinning segmented ring
//   speaking  – outward bursts and a spectrum ring driven by the TTS audio
//   working   – satellites orbit the core while tools run
//   happy     – a burst of pulses and an expanding ring when a reply is done
//   sleeping  – dim, barely moving, with drifting "z"s
import { hexToRgb } from './themecore.js';
import { env } from './faces/env.js';
import { audio, faceState, paletteFor as themedPalette } from './faces/common.js';

const POLY = { octagon: [8, Math.PI / 8], hexagon: [6, 0], diamond: [4, 0], triangle: [3, -Math.PI / 2] };
const DIRS = Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4), Math.sin((i * Math.PI) / 4)]);

const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const lerp = (a, b, t) => a + (b - a) * t;
const lerpColor = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function faceTheme() {
  return env.theme();
}

const paletteFor = (st) => themedPalette(st);

export class CircuitFace {
  constructor(canvas, { compact = false } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.compact = compact;
    this.pulses = [];
    this.traces = [];
    this.chips = [];
    this.rings = []; // expanding rings (happy)
    this.zs = []; // drifting z's (sleeping)
    this.t = 0;
    this.last = performance.now();
    this.spawnAcc = 0;
    this.spin = 0;
    const p = paletteFor('idle');
    this.cur = { main: p.main, accent: p.accent, energy: p.energy, spinSpeed: p.spin };
    this.levels = new Float32Array(72);
    this.freq = null;
    this.avatar = null;
    this.label = 'N';
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.off = env.onTheme(() => this.generate());
    this.resize();
    this.loop = this.loop.bind(this);
    this.alive = true;
    requestAnimationFrame(this.loop);
  }

  destroy() {
    this.alive = false;
    this.ro.disconnect();
    this.off?.();
  }

  setAvatar(dataUrl) {
    if (!dataUrl) {
      this.avatar = null;
      return;
    }
    const img = new Image();
    img.onload = () => (this.avatar = img);
    img.src = dataUrl;
  }

  setLabel(name) {
    this.label = (name || 'N').trim().charAt(0).toUpperCase() || 'N';
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.generate();
  }

  // ---------------------------------------------------------------- layout
  generate() {
    if (!this.w) return;
    const { w, h } = this;
    const face = faceTheme().face;
    this.light = faceTheme().mode === 'light';
    const cx = w / 2;
    const cy = this.compact ? h * 0.45 : h * 0.46;
    this.cx = cx;
    this.cy = cy;
    this.R = Math.min(w, h) * (this.compact ? 0.17 : 0.12);
    const grid = Math.max(8, Math.min(w, h) / (this.compact ? 26 : 48));
    this.grid = grid;
    const count = Math.round((this.compact ? 46 : 120) * face.density);
    let seed = 1337;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const inBounds = (x, y) => x > 6 && y > 6 && x < w - 6 && y < h - 6;
    this.traces = [];

    const stars = [];
    if (face.traces === 'constellation') {
      for (let i = 0; i < count * 0.6; i++) {
        const x = 10 + rand() * (w - 20);
        const y = 10 + rand() * (h - 20);
        if (Math.hypot(x - cx, y - cy) > this.R * 2) stars.push([x, y]);
      }
    }

    for (let i = 0; i < count; i++) {
      const theta = (i / count) * Math.PI * 2 + (rand() - 0.5) * 0.05;
      const startR = this.R * (1.55 + rand() * 0.35);
      let x = cx + Math.cos(theta) * startR;
      let y = cy + Math.sin(theta) * startR;
      const pts = [[cx + Math.cos(theta) * this.R * 1.32, cy + Math.sin(theta) * this.R * 1.32], [x, y]];
      const maxLen = Math.max(w, h) * (0.35 + rand() * 0.55);

      if (face.traces === 'radial') {
        let len = maxLen;
        while (len > 10 && !inBounds(x + Math.cos(theta) * len, y + Math.sin(theta) * len)) len *= 0.9;
        pts.push([x + Math.cos(theta) * len, y + Math.sin(theta) * len]);
      } else if (face.traces === 'organic') {
        let ang = theta;
        let len = 0;
        const step = grid * 0.7;
        while (len < maxLen) {
          ang += (rand() - 0.5) * 0.55;
          const radial = Math.atan2(y - cy, x - cx);
          let diff = Math.atan2(Math.sin(ang - radial), Math.cos(ang - radial));
          if (Math.abs(diff) > 0.9) ang = radial + Math.sign(diff) * 0.9;
          const nx = x + Math.cos(ang) * step;
          const ny = y + Math.sin(ang) * step;
          if (!inBounds(nx, ny)) break;
          x = nx;
          y = ny;
          pts.push([x, y]);
          len += step;
        }
      } else if (face.traces === 'constellation') {
        // Hop from star to star, moving outward.
        let hops = 2 + Math.floor(rand() * 3);
        while (hops-- > 0 && stars.length) {
          const d0 = Math.hypot(x - cx, y - cy);
          const options = stars.filter(([sx, sy]) => Math.hypot(sx - cx, sy - cy) > d0 + grid && Math.hypot(sx - x, sy - y) < grid * 9);
          if (!options.length) break;
          const [sx, sy] = options[Math.floor(rand() * options.length)];
          pts.push([sx, sy]);
          x = sx;
          y = sy;
        }
      } else {
        // PCB routing: 45° segments that keep heading outward.
        let dir = Math.round(((theta + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
        let len = 0;
        while (len < maxLen) {
          const seg = (1 + Math.floor(rand() * 5)) * grid;
          const nx = x + DIRS[dir][0] * seg;
          const ny = y + DIRS[dir][1] * seg;
          if (!inBounds(nx, ny)) break;
          x = nx;
          y = ny;
          pts.push([x, y]);
          len += seg;
          const radialDir = Math.round(((Math.atan2(y - cy, x - cx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
          const options = [dir, (dir + 1) % 8, (dir + 7) % 8].filter((d) => Math.min((d - radialDir + 8) % 8, (radialDir - d + 8) % 8) <= 1);
          dir = options[Math.floor(rand() * options.length)] ?? radialDir;
        }
      }
      if (pts.length < 3) continue;
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      this.traces.push({ pts, cum, length: cum[cum.length - 1], flash: 0, pad: rand() > 0.35 ? 'pad' : 'via', width: rand() > 0.8 ? 2 : 1 });
    }
    this.stars = stars;

    // Decorative chips (circuit style only), away from the core.
    this.chips = [];
    const chipCount = face.traces === 'circuit' ? (this.compact ? 3 : 9) : 0;
    for (let i = 0; i < chipCount * 4 && this.chips.length < chipCount; i++) {
      const cw = grid * (2 + Math.floor(rand() * 3));
      const ch = grid * (1.5 + Math.floor(rand() * 2));
      const x = rand() * (w - cw - 20) + 10;
      const y = rand() * (h - ch - 20) + 10;
      if (Math.hypot(x + cw / 2 - cx, y + ch / 2 - cy) < this.R * 3.2) continue;
      if (this.chips.some((c) => x < c.x + c.w + grid && x + cw + grid > c.x && y < c.y + c.h + grid && y + ch + grid > c.y)) continue;
      this.chips.push({ x, y, w: cw, h: ch });
    }
    this.drawStatic();
  }

  drawStatic() {
    const t = faceTheme();
    const base = hexToRgb(t.colors.accent);
    const surface = hexToRgb(t.colors.surface);
    const k = this.light ? 1.8 : 1;
    const off = document.createElement('canvas');
    off.width = this.canvas.width;
    off.height = this.canvas.height;
    const g = off.getContext('2d');
    g.scale(this.dpr, this.dpr);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const smooth = t.face.traces === 'organic';
    for (const tr of this.traces) {
      g.strokeStyle = rgba(base, 0.1 * k);
      g.lineWidth = tr.width;
      g.beginPath();
      tracePath(g, tr.pts, smooth);
      g.stroke();
      const [ex, ey] = tr.pts[tr.pts.length - 1];
      g.fillStyle = rgba(base, 0.16 * k);
      g.strokeStyle = rgba(base, 0.22 * k);
      g.beginPath();
      g.arc(ex, ey, tr.pad === 'pad' ? 3 : 2, 0, Math.PI * 2);
      tr.pad === 'pad' ? g.fill() : g.stroke();
    }
    for (const [sx, sy] of this.stars || []) {
      g.fillStyle = rgba(base, 0.3 * k);
      g.beginPath();
      g.arc(sx, sy, 1.4, 0, Math.PI * 2);
      g.fill();
    }
    for (const c of this.chips) {
      g.fillStyle = rgba(surface, 0.9);
      g.strokeStyle = rgba(base, 0.18 * k);
      g.lineWidth = 1;
      g.fillRect(c.x, c.y, c.w, c.h);
      g.strokeRect(c.x + 0.5, c.y + 0.5, c.w, c.h);
      const pins = Math.max(2, Math.floor(c.w / (this.grid * 0.6)));
      g.fillStyle = rgba(base, 0.2 * k);
      for (let p = 0; p < pins; p++) {
        const px = c.x + ((p + 0.5) * c.w) / pins - 1.5;
        g.fillRect(px, c.y - 4, 3, 4);
        g.fillRect(px, c.y + c.h, 3, 4);
      }
    }
    this.staticLayer = off;
  }

  // ------------------------------------------------------------- animation
  pointAt(tr, s) {
    s = Math.max(0, Math.min(tr.length, s));
    let k = 1;
    while (k < tr.cum.length - 1 && tr.cum[k] < s) k++;
    const a = tr.pts[k - 1];
    const b = tr.pts[k];
    const segLen = tr.cum[k] - tr.cum[k - 1] || 1;
    const f = (s - tr.cum[k - 1]) / segLen;
    return [lerp(a[0], b[0], f), lerp(a[1], b[1], f), k];
  }

  slice(tr, a, b) {
    a = Math.max(0, a);
    b = Math.min(tr.length, b);
    if (b <= a) return [];
    const [ax, ay, ka] = this.pointAt(tr, a);
    const [bx, by, kb] = this.pointAt(tr, b);
    const pts = [[ax, ay]];
    for (let k = ka; k < kb; k++) pts.push(tr.pts[k]);
    pts.push([bx, by]);
    return pts;
  }

  spawn(dir, speed) {
    if (!this.traces.length) return;
    const tr = this.traces[(Math.random() * this.traces.length) | 0];
    this.pulses.push({ tr, s: dir > 0 ? 0 : tr.length, dir, speed: speed * (0.7 + Math.random() * 0.6), trail: 40 + Math.random() * 80 });
  }

  audioLevel() {
    return audio();
  }

  loop(now) {
    if (!this.alive) return;
    requestAnimationFrame(this.loop);
    if (!this.canvas.offsetParent || !this.w) {
      this.last = now;
      return;
    }
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt;
    this.update(dt);
    this.draw();
  }

  update(dt) {
    const st = env.agentState();
    const target = paletteFor(faceState());
    const k = 1 - Math.pow(0.02, dt);
    this.cur.main = lerpColor(this.cur.main, target.main, k);
    this.cur.accent = lerpColor(this.cur.accent, target.accent, k);
    this.cur.energy = lerp(this.cur.energy, target.energy, k);
    this.cur.spinSpeed = lerp(this.cur.spinSpeed, target.spin, k);
    this.spin += this.cur.spinSpeed * dt;

    const { level, freq } = this.audioLevel();
    this.level = lerp(this.level || 0, level, 1 - Math.pow(0.0005, dt));
    const unit = Math.min(this.w, this.h);

    let rate = 0;
    let dir = 1;
    let speed = unit * 0.35;
    if (st === 'idle') rate = this.compact ? 0.8 : 1.6;
    else if (st === 'listening') {
      rate = 3 + this.level * (this.compact ? 25 : 60);
      dir = -1;
      speed = unit * 0.55;
    } else if (st === 'thinking') {
      rate = this.compact ? 12 : 30;
      speed = unit * 0.9;
    } else if (st === 'speaking') {
      rate = 2 + this.level * (this.compact ? 30 : 80);
      speed = unit * 0.75;
    } else if (st === 'working') {
      rate = this.compact ? 8 : 20;
      speed = unit * 0.7;
    } else if (st === 'happy') {
      rate = this.compact ? 4 : 10;
      speed = unit * 0.9;
    } else if (st === 'sleeping') {
      rate = 0.25;
      speed = unit * 0.15;
    }
    // Entering a state can set off a one-time effect.
    if (st !== this.prevState) {
      if (st === 'happy') {
        for (let i = 0; i < (this.compact ? 16 : 40); i++) this.spawn(1, unit * (0.9 + Math.random() * 0.4));
        this.rings.push({ r: this.R * 1.2, a: 1 });
      }
      this.prevState = st;
    }
    this.orbit = (this.orbit || 0) + dt * (st === 'working' ? 2.6 : 0);
    this.orbitAlpha = lerp(this.orbitAlpha || 0, st === 'working' ? 1 : 0, 1 - Math.pow(0.02, dt));
    for (const r of this.rings) {
      r.r += unit * 0.45 * dt;
      r.a -= dt * 0.9;
    }
    this.rings = this.rings.filter((r) => r.a > 0);
    if (st === 'sleeping') {
      this.zAcc = (this.zAcc || 0) + dt;
      if (this.zAcc > 1.8) {
        this.zAcc = 0;
        this.zs.push({ x: this.R * 0.55, y: -this.R * 0.55, t: 0 });
      }
    }
    for (const z of this.zs) z.t += dt;
    this.zs = this.zs.filter((z) => z.t < 4);
    this.spawnAcc += rate * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      this.spawn(st === 'thinking' ? (Math.random() > 0.5 ? 1 : -1) : dir, speed);
    }
    if (this.pulses.length > 400) this.pulses.splice(0, this.pulses.length - 400);

    for (const p of this.pulses) {
      p.s += p.dir * p.speed * dt;
      if ((p.dir > 0 && p.s >= p.tr.length) || (p.dir < 0 && p.s <= 0)) {
        if (!p.dead) {
          if (p.dir > 0) p.tr.flash = 1;
          else this.coreFlash = Math.min(1, (this.coreFlash || 0) + 0.15);
        }
        p.dead = (p.dead || 0) + dt;
      }
    }
    this.pulses = this.pulses.filter((p) => !p.dead || p.dead < 0.25);
    for (const tr of this.traces) tr.flash = Math.max(0, tr.flash - dt * 1.8);
    this.coreFlash = Math.max(0, (this.coreFlash || 0) - dt * 1.5);

    const bars = this.levels.length;
    for (let i = 0; i < bars; i++) {
      let v;
      if (freq) {
        const idx = Math.floor(2 + Math.abs((i / bars) * 2 - 1) * 0.9 * Math.min(freq.length - 3, 110));
        v = freq[idx] / 255;
      } else if (st === 'listening') v = this.level * (0.5 + 0.5 * Math.sin(this.t * 9 + i * 0.7)) + 0.05;
      else if (st === 'thinking') v = 0.25 + 0.25 * Math.sin(this.t * 6 + i * 0.5);
      else if (st === 'working') v = 0.18 + 0.22 * Math.abs(Math.sin(this.t * 4 + i * 0.9));
      else if (st === 'happy') v = 0.3 + 0.3 * Math.sin(this.t * 5 + i * 0.3);
      else if (st === 'sleeping') v = 0.03 + 0.02 * Math.sin(this.t * 0.6 + i * 0.2);
      else v = 0.08 + 0.06 * Math.sin(this.t * 1.6 + i * 0.35);
      this.levels[i] = lerp(this.levels[i], v, 1 - Math.pow(0.001, dt));
    }
  }

  corePath(g, r) {
    const shape = faceTheme().face.core;
    g.beginPath();
    if (shape === 'circle' || !POLY[shape]) {
      g.arc(0, 0, r, 0, Math.PI * 2);
      return;
    }
    const [n, rot] = POLY[shape];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rot;
      i ? g.lineTo(Math.cos(a) * r, Math.sin(a) * r) : g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    g.closePath();
  }

  draw() {
    const g = this.ctx;
    const { w, h, cx, cy, R, dpr } = this;
    const theme = faceTheme();
    const glow = theme.face.glow;
    const smooth = theme.face.traces === 'organic';
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const main = this.cur.main;
    const accent = this.cur.accent;
    const energy = this.cur.energy;
    const blend = this.light ? 'source-over' : 'lighter';

    const amb = g.createRadialGradient(cx, cy, R * 0.5, cx, cy, Math.max(w, h) * 0.6);
    amb.addColorStop(0, rgba(main, (0.1 + this.level * 0.12) * (0.4 + glow)));
    amb.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = amb;
    g.fillRect(0, 0, w, h);

    if (this.staticLayer) {
      g.globalAlpha = 0.7 + energy * 0.3;
      g.drawImage(this.staticLayer, 0, 0, w, h);
      g.globalAlpha = 1;
    }

    g.save();
    g.globalCompositeOperation = blend;
    g.lineCap = 'round';
    g.lineJoin = 'round';

    for (const tr of this.traces) {
      if (tr.flash <= 0) continue;
      const [ex, ey] = tr.pts[tr.pts.length - 1];
      g.fillStyle = rgba(main, tr.flash * 0.8);
      g.beginPath();
      g.arc(ex, ey, 3 + tr.flash * 4, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = rgba(main, tr.flash * 0.15);
      g.lineWidth = 1.5;
      g.beginPath();
      tracePath(g, tr.pts, smooth);
      g.stroke();
    }

    for (const p of this.pulses) {
      const fade = p.dead ? 1 - p.dead / 0.25 : 1;
      const a = p.dir > 0 ? p.s - p.trail : p.s;
      const b = p.dir > 0 ? p.s : p.s + p.trail;
      const pts = this.slice(p.tr, a, b);
      if (pts.length < 2) continue;
      const head = p.dir > 0 ? pts[pts.length - 1] : pts[0];
      const tail = p.dir > 0 ? pts[0] : pts[pts.length - 1];
      const grad = g.createLinearGradient(tail[0], tail[1], head[0], head[1]);
      grad.addColorStop(0, rgba(main, 0));
      grad.addColorStop(1, rgba(main, 0.9 * fade));
      g.strokeStyle = grad;
      g.lineWidth = 2;
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.stroke();
      g.fillStyle = this.light ? rgba(main, 0.95 * fade) : rgba([255, 255, 255], 0.85 * fade);
      g.beginPath();
      g.arc(head[0], head[1], 1.6, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = rgba(main, 0.25 * fade * (0.5 + glow));
      g.beginPath();
      g.arc(head[0], head[1], 5, 0, Math.PI * 2);
      g.fill();
    }

    const bars = this.levels.length;
    const ringR = R * 1.32;
    for (let i = 0; i < bars; i++) {
      const ang = (i / bars) * Math.PI * 2 - Math.PI / 2 + this.spin * 0.15;
      const len = 3 + this.levels[i] * R * 0.75;
      g.strokeStyle = rgba(i % 2 ? accent : main, 0.35 + this.levels[i] * 0.6);
      g.lineWidth = Math.max(1.5, (Math.PI * 2 * ringR) / bars / 2.4);
      g.beginPath();
      g.moveTo(cx + Math.cos(ang) * ringR, cy + Math.sin(ang) * ringR);
      g.lineTo(cx + Math.cos(ang) * (ringR + len), cy + Math.sin(ang) * (ringR + len));
      g.stroke();
    }

    const segs = 12;
    g.lineWidth = 2;
    for (let i = 0; i < segs; i++) {
      const a0 = this.spin + (i / segs) * Math.PI * 2;
      g.strokeStyle = rgba(main, i % 3 === 0 ? 0.75 : 0.25);
      g.beginPath();
      g.arc(cx, cy, R * 1.18, a0, a0 + ((Math.PI * 2) / segs) * 0.6);
      g.stroke();
    }
    g.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const a0 = -this.spin * 1.7 + (i / 4) * Math.PI * 2;
      g.strokeStyle = rgba(accent, 0.55);
      g.beginPath();
      g.arc(cx, cy, R * 1.07, a0, a0 + 0.9);
      g.stroke();
    }

    // Happy: expanding rings.
    for (const ring of this.rings) {
      g.strokeStyle = rgba(main, ring.a * 0.7);
      g.lineWidth = 2 + ring.a * 2;
      g.beginPath();
      g.arc(cx, cy, ring.r, 0, Math.PI * 2);
      g.stroke();
    }
    // Working: three satellites orbit the core, each with a short trail.
    if (this.orbitAlpha > 0.02) {
      for (let i = 0; i < 3; i++) {
        const a = this.orbit * (1 + i * 0.25) + (i * Math.PI * 2) / 3;
        const r = R * (1.55 + i * 0.12);
        g.strokeStyle = rgba(accent, 0.35 * this.orbitAlpha);
        g.lineWidth = 2;
        g.beginPath();
        g.arc(cx, cy, r, a - 0.7, a);
        g.stroke();
        g.fillStyle = rgba(main, 0.95 * this.orbitAlpha);
        g.beginPath();
        g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 3.2, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.restore();

    // Core
    const sleeping = env.agentState() === 'sleeping';
    const breathe = 0.5 + 0.5 * Math.sin(this.t * (sleeping ? 0.7 : this.cur.spinSpeed > 1 ? 5 : 1.6));
    const coreGlow = 0.35 + energy * 0.25 + this.level * 0.4 + (this.coreFlash || 0) * 0.3 + breathe * 0.1;
    const cg = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.05);
    cg.addColorStop(0, rgba([255, 255, 255], Math.min(0.9, coreGlow * 0.5)));
    cg.addColorStop(0.35, rgba(main, Math.min(1, coreGlow)));
    cg.addColorStop(0.75, rgba(accent, 0.25));
    cg.addColorStop(1, 'rgba(0,0,0,0)');

    g.save();
    g.translate(cx, cy);
    this.corePath(g, R * 0.98);
    g.fillStyle = rgba(hexToRgb(theme.colors.surface), 0.92);
    g.fill();
    g.shadowColor = rgba(main, 0.9);
    g.shadowBlur = (18 + this.level * 30) * (0.3 + glow);
    g.strokeStyle = rgba(main, 0.85);
    g.lineWidth = 1.5;
    g.stroke();
    g.shadowBlur = 0;

    this.corePath(g, R * 0.9);
    g.save();
    g.clip();
    if (this.avatar) {
      const s = R * 1.8;
      g.globalAlpha = 0.9;
      g.drawImage(this.avatar, -s / 2, -s / 2, s, s);
      g.globalAlpha = 0.3 + this.level * 0.4;
      g.globalCompositeOperation = blend;
      g.fillStyle = cg;
      g.fillRect(-R, -R, R * 2, R * 2);
      g.globalAlpha = 1;
    } else {
      g.fillStyle = cg;
      g.fillRect(-R, -R, R * 2, R * 2);
      g.strokeStyle = rgba(main, 0.25);
      g.lineWidth = 1;
      for (let i = -3; i <= 3; i++) {
        g.beginPath();
        g.moveTo(-R, i * R * 0.22);
        g.lineTo(R, i * R * 0.22);
        g.stroke();
      }
      g.font = `700 ${Math.round(R * 0.62)}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-display') || 'sans-serif'}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillStyle = this.light ? rgba(main, 0.95) : rgba([255, 255, 255], 0.92);
      g.shadowColor = rgba(main, this.light ? 0.4 : 1);
      g.shadowBlur = 20 * (0.3 + glow);
      g.fillText(this.label, 0, R * 0.04);
      g.shadowBlur = 0;
    }
    g.restore();
    // Sleeping: z's drift up from the core.
    for (const z of this.zs) {
      const a = Math.min(1, z.t) * (1 - z.t / 4);
      g.font = `700 ${Math.round(R * (0.22 + z.t * 0.06))}px ${getComputedStyle(document.documentElement).getPropertyValue('--font-display') || 'sans-serif'}`;
      g.fillStyle = rgba(accent, 0.8 * a);
      g.fillText('z', z.x + Math.sin(z.t * 2) * R * 0.1 + z.t * R * 0.12, z.y - z.t * R * 0.25);
    }
    g.restore();
  }
}

// Straight polyline, or a smoothed curve through the points for organic traces.
function tracePath(g, pts, smooth) {
  g.moveTo(pts[0][0], pts[0][1]);
  if (!smooth || pts.length < 3) {
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    return;
  }
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  const last = pts[pts.length - 1];
  g.lineTo(last[0], last[1]);
}
