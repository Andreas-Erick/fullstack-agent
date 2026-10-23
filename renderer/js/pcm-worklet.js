// AudioWorklet that streams microphone PCM to the main thread in ~40 ms frames with their RMS level.
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
        this.port.postMessage({ samples: out, rms: Math.sqrt(sum / out.length) }, [out.buffer]);
        this.buf = [];
        this.size = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
