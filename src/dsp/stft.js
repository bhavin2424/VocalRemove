import { FFT } from './fft.js';

/**
 * Weighted overlap-add short-time Fourier transform.
 *
 * Analysis and synthesis both apply a Hann window, and `finish` divides by the
 * accumulated window energy. That last step is what makes reconstruction exact
 * everywhere including the first and last samples, where the window sum has
 * not yet reached its steady-state value.
 *
 * Frames are exposed one at a time rather than returned as a list: a
 * four-minute song at 4096/1024 is ten thousand frames, and holding them all
 * as complex spectra would cost well over half a gigabyte.
 */
export class STFT {
  constructor(frameSize, hopSize) {
    if (frameSize % hopSize !== 0) {
      throw new Error(`hop size ${hopSize} must divide frame size ${frameSize}`);
    }
    this.frameSize = frameSize;
    this.hopSize = hopSize;
    this.fft = new FFT(frameSize);

    this.window = new Float64Array(frameSize);
    for (let i = 0; i < frameSize; i++) {
      this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / frameSize));
    }
  }

  /**
   * Where frame `index` begins in the signal. The first frames start before
   * sample zero so that early samples sit under the body of a window rather
   * than its near-zero edge.
   */
  frameStart(index) {
    return index * this.hopSize - this.frameSize + this.hopSize;
  }

  frameCount(length) {
    return Math.ceil((length + this.frameSize - this.hopSize) / this.hopSize) + 1;
  }

  /** Fill `re`/`im` with the windowed spectrum of frame `index`. */
  analyzeFrame(signal, index, re, im) {
    const start = this.frameStart(index);
    const n = this.frameSize;
    for (let i = 0; i < n; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < signal.length ? signal[s] * this.window[i] : 0;
      im[i] = 0;
    }
    this.fft.forward(re, im);
  }

  createAccumulator(length) {
    return {
      length,
      sum: new Float64Array(length),
      weight: new Float64Array(length),
    };
  }

  /** Inverse-transform `re`/`im` and overlap-add it into the accumulator. */
  addFrame(acc, index, re, im) {
    this.fft.inverse(re, im);
    const start = this.frameStart(index);
    const n = this.frameSize;
    for (let i = 0; i < n; i++) {
      const s = start + i;
      if (s < 0 || s >= acc.length) continue;
      const w = this.window[i];
      acc.sum[s] += re[i] * w;
      acc.weight[s] += w * w;
    }
  }

  /** Normalise by accumulated window energy, yielding the output signal. */
  finish(acc) {
    const out = new Float64Array(acc.length);
    for (let i = 0; i < acc.length; i++) {
      out[i] = acc.weight[i] > 1e-12 ? acc.sum[i] / acc.weight[i] : 0;
    }
    return out;
  }
}
