import { STFT } from './stft.js';

export const SEPARATION_DEFAULTS = {
  frameSize: 4096,
  hopSize: 1024,
  /** Mask steepness. Higher pulls more borderline content out of the vocal stem. */
  exponent: 2,
  /** Below this, content is treated as bass and kept in the instrumental. */
  lowCutHz: 180,
  /** Above this, content is treated as cymbals and air, and kept likewise. */
  highCutHz: 10000,
};

/**
 * How centred a frequency bin is, from the two channel spectra.
 *
 *   2 * Re(L * conj(R)) / (|L|^2 + |R|^2)
 *
 * One expression covering both things that matter: it reaches 1 only when the
 * two channels agree in phase AND in magnitude, falls to 0 when either channel
 * is silent, and goes negative for out-of-phase content. Lead vocals sit near
 * 1 because they are almost always mixed dead centre.
 */
function centredness(lre, lim, rre, rim) {
  const dot = lre * rre + lim * rim;
  const energy = lre * lre + lim * lim + rre * rre + rim * rim;
  if (energy < 1e-20) return 0;
  return (2 * dot) / energy;
}

/**
 * Band weighting. Bass and kick drums are mixed dead centre too, so centredness
 * alone would drag them into the vocal stem and leave a hollow instrumental.
 * Raised-cosine edges avoid audible ringing at the transitions.
 */
function bandWeight(freq, lowCut, highCut) {
  const lowEnd = lowCut * 1.6;
  const highEnd = highCut * 1.4;
  if (freq <= lowCut || freq >= highEnd) return 0;
  if (freq < lowEnd) return 0.5 - 0.5 * Math.cos((Math.PI * (freq - lowCut)) / (lowEnd - lowCut));
  if (freq <= highCut) return 1;
  return 0.5 + 0.5 * Math.cos((Math.PI * (freq - highCut)) / (highEnd - highCut));
}

function buildBandWeights(frameSize, sampleRate, lowCut, highCut) {
  const w = new Float64Array(frameSize);
  const half = frameSize >> 1;
  for (let k = 0; k <= half; k++) {
    const weight = bandWeight((k * sampleRate) / frameSize, lowCut, highCut);
    w[k] = weight;
    if (k > 0 && k < half) w[frameSize - k] = weight;
  }
  return w;
}

/** True when the two channels carry effectively the same signal. */
function isMono(left, right) {
  let diff = 0;
  let total = 0;
  for (let i = 0; i < left.length; i++) {
    const d = left[i] - right[i];
    diff += d * d;
    total += left[i] * left[i] + right[i] * right[i];
  }
  return total === 0 || diff / total < 1e-6;
}

/**
 * Split a stereo track into a vocal stem and an instrumental stem.
 *
 * Only the vocal stem is synthesised; the instrumental is the original minus
 * that. Overlap-add is linear, so the subtraction yields exactly what masking
 * with (1 - mask) would have produced, for half the inverse transforms, and it
 * makes the two stems sum back to the original bit for bit.
 *
 * Exposed as a generator that yields a 0..1 progress fraction. A file:// page
 * cannot spawn a Worker, so the browser drives this loop in slices to stay
 * responsive; `separate` below drives it straight through.
 */
export function* separateSteps(left, right, sampleRate, options = {}) {
  const opts = { ...SEPARATION_DEFAULTS, ...options };
  const length = Math.min(left.length, right.length);
  const stft = new STFT(opts.frameSize, opts.hopSize);
  const band = buildBandWeights(opts.frameSize, sampleRate, opts.lowCutHz, opts.highCutHz);

  const lre = new Float64Array(opts.frameSize);
  const lim = new Float64Array(opts.frameSize);
  const rre = new Float64Array(opts.frameSize);
  const rim = new Float64Array(opts.frameSize);

  const accL = stft.createAccumulator(length);
  const accR = stft.createAccumulator(length);
  const frames = stft.frameCount(length);

  for (let f = 0; f < frames; f++) {
    stft.analyzeFrame(left, f, lre, lim);
    stft.analyzeFrame(right, f, rre, rim);

    for (let k = 0; k < opts.frameSize; k++) {
      const w = band[k];
      let mask = 0;
      if (w > 0) {
        const c = centredness(lre[k], lim[k], rre[k], rim[k]);
        if (c > 0) mask = Math.pow(c, opts.exponent) * w;
      }
      lre[k] *= mask; lim[k] *= mask;
      rre[k] *= mask; rim[k] *= mask;
    }

    stft.addFrame(accL, f, lre, lim);
    stft.addFrame(accR, f, rre, rim);
    if ((f & 31) === 0) yield f / frames;
  }

  const vocalsL = stft.finish(accL);
  const vocalsR = stft.finish(accR);
  const instrumentalL = new Float64Array(length);
  const instrumentalR = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    instrumentalL[i] = left[i] - vocalsL[i];
    instrumentalR[i] = right[i] - vocalsR[i];
  }

  return {
    vocals: { left: vocalsL, right: vocalsR },
    instrumental: { left: instrumentalL, right: instrumentalR },
    mono: isMono(left.subarray(0, length), right.subarray(0, length)),
  };
}

/** Run the separation to completion in one go. */
export function separate(left, right, sampleRate, options = {}) {
  const steps = separateSteps(left, right, sampleRate, options);
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}
