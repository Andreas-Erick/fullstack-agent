// AudioWorklet that streams microphone PCM to the main thread in ~40 ms frames with their RMS level
// and whether the frame is voiced (periodic, like a vowel) rather than noise like breathing.

// Pitch check: downsample to ~8 kHz, pre-emphasize (drops breath rumble), then look for a strong
// normalized autocorrelation peak at a pitch period between 70 and 400 Hz.
function isVoiced(x) {
  const d = Math.max(1, Math.round(sampleRate / 8000));
  const n = Math.floor(x.length / d);
  const y = new Float32Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < d; j++) s += x[i * d + j];
    s /= d;
    y[i] = s - 0.9 * prev;
    prev = s;
  }
  const rate = sampleRate / d;
  const minLag = Math.floor(rate / 400);
  const maxLag = Math.min(Math.ceil(rate / 70), n >> 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = 0; i + lag < n; i++) {
      xy += y[i] * y[i + lag];
      xx += y[i] * y[i];
      yy += y[i + lag] * y[i + lag];
    }
    const r = xx && yy ? xy / Math.sqrt(xx * yy) : 0;
    if (r > best) best = r;
  }
  return best > 0.5;
}
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = [];
    this.size = 0;
    this.frame = Math.round(sampleRate * 0.04);
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (ch) {
      this.buf.push(new Float32Array(ch));
      this.size += ch.length;
      if (this.size >= this.frame) {
        const out = new Float32Array(this.size);
        let o = 0;
        for (const b of this.buf) {
          out.set(b, o);
          o += b.length;
        }
        let sum = 0;
        for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
        const voiced = isVoiced(out);
        this.port.postMessage({ samples: out, rms: Math.sqrt(sum / out.length), voiced }, [out.buffer]);
        this.buf = [];
        this.size = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
