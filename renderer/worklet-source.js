// The capture worklet runs on the audio thread. It does as little as possible:
// downmix to mono, gather ~64 ms blocks, measure loudness, hand them over.
// All decisions about where an utterance starts and ends happen on the main
// thread, where they are easy to tune and to watch.

window.CAPTURE_WORKLET_SOURCE = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.blockSize = 1024;           // 64 ms at 16 kHz
    this.buffer = new Float32Array(this.blockSize);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channels = input.length;
    const frames = input[0].length;

    for (let i = 0; i < frames; i++) {
      let sample = 0;
      for (let c = 0; c < channels; c++) sample += input[c][i];
      sample /= channels;

      this.buffer[this.filled++] = sample;

      if (this.filled === this.blockSize) {
        let sum = 0;
        let peak = 0;
        for (let k = 0; k < this.blockSize; k++) {
          const v = this.buffer[k];
          sum += v * v;
          const a = v < 0 ? -v : v;
          if (a > peak) peak = a;
        }
        this.port.postMessage(
          {
            samples: this.buffer,
            rms: Math.sqrt(sum / this.blockSize),
            peak: peak,
          },
          [this.buffer.buffer]
        );
        this.buffer = new Float32Array(this.blockSize);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
`;
