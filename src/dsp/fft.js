/**
 * Iterative radix-2 Cooley-Tukey FFT.
 *
 * Transforms run in place over separate real and imaginary Float64Arrays so
 * the hot loop allocates nothing: a four-minute song calls this on the order
 * of ten thousand times per channel, per pass.
 */
export class FFT {
  constructor(size) {
    if (size < 2 || (size & (size - 1)) !== 0) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;

    const bits = Math.round(Math.log2(size));
    this.reversed = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reversed[i] = r;
    }

    const half = size >> 1;
    this.cos = new Float64Array(half);
    this.sin = new Float64Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
  }

  /** Forward transform, in place, unnormalised. */
  forward(re, im) {
    this.#butterflies(re, im, false);
  }

  /** Inverse transform, in place, scaled by 1/N so that it undoes `forward`. */
  inverse(re, im) {
    this.#butterflies(re, im, true);
    const n = this.size;
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }

  #butterflies(re, im, conjugateTwiddles) {
    const n = this.size;
    const reversed = this.reversed;

    for (let i = 0; i < n; i++) {
      const j = reversed[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const stride = n / len;
      for (let base = 0; base < n; base += len) {
        for (let j = 0; j < half; j++) {
          const tw = j * stride;
          const wr = this.cos[tw];
          const wi = conjugateTwiddles ? -this.sin[tw] : this.sin[tw];
          const a = base + j;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}
