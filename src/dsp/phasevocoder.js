import { FFT } from './fft.js';

const TWO_PI = 2 * Math.PI;

/** Wrap a phase difference into (-pi, pi]. */
function principalArgument(phase) {
  return phase - TWO_PI * Math.round(phase / TWO_PI);
}

/**
 * Stretch or compress audio in time without changing its pitch.
 *
 * Standard phase vocoder: estimate each bin's true frequency from how far its
 * phase advanced between analysis frames, then re-advance that phase over a
 * different synthesis hop.
 *
 * The identity phase-locking step is what keeps it from sounding underwater.
 * Advancing every bin independently lets the partials of one note drift out of
 * phase with each other; instead only spectral peaks accumulate phase, and the
 * bins around a peak keep their original phase relationship to it.
 */
export function* timeStretchSteps(samples, factor, options = {}) {
  const { frameSize = 2048, analysisHop = 512 } = options;
  const fft = new FFT(frameSize);
  const half = frameSize >> 1;

  const window = new Float64Array(frameSize);
  for (let i = 0; i < frameSize; i++) {
    window[i] = 0.5 * (1 - Math.cos((TWO_PI * i) / frameSize));
  }

  const targetLength = Math.round(samples.length * factor);
  const padded = targetLength + 2 * frameSize;
  const sum = new Float64Array(padded);
  const weight = new Float64Array(padded);

  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const magnitude = new Float64Array(half + 1);
  const phase = new Float64Array(half + 1);
  const previousPhase = new Float64Array(half + 1);
  const runningPhase = new Float64Array(half + 1);
  const synthesisPhase = new Float64Array(half + 1);

  const frames = Math.ceil((samples.length + frameSize) / analysisHop) + 1;

  for (let f = 0; f < frames; f++) {
    const inStart = f * analysisHop - frameSize + analysisHop;
    for (let i = 0; i < frameSize; i++) {
      const s = inStart + i;
      re[i] = s >= 0 && s < samples.length ? samples[s] * window[i] : 0;
      im[i] = 0;
    }
    fft.forward(re, im);

    for (let k = 0; k <= half; k++) {
      magnitude[k] = Math.hypot(re[k], im[k]);
      phase[k] = Math.atan2(im[k], re[k]);
    }

    // Peaks own their phase; their neighbours follow along.
    for (let k = 0; k <= half; k++) {
      const left = k > 0 ? magnitude[k - 1] : -1;
      const right = k < half ? magnitude[k + 1] : -1;
      if (magnitude[k] > left && magnitude[k] >= right) {
        const expected = (TWO_PI * k * analysisHop) / frameSize;
        const drift = principalArgument(phase[k] - previousPhase[k] - expected);
        runningPhase[k] = principalArgument(runningPhase[k] + (expected + drift) * factor);
        synthesisPhase[k] = runningPhase[k];
      } else {
        synthesisPhase[k] = Number.NaN;
      }
    }
    let nearestPeak = -1;
    for (let k = 0; k <= half; k++) {
      if (!Number.isNaN(synthesisPhase[k])) { nearestPeak = k; continue; }
      let peak = nearestPeak;
      for (let j = k + 1; j <= half; j++) {
        if (!Number.isNaN(synthesisPhase[j])) {
          if (peak < 0 || j - k < k - peak) peak = j;
          break;
        }
      }
      synthesisPhase[k] = peak >= 0
        ? runningPhase[peak] + (phase[k] - phase[peak])
        : phase[k];
    }
    for (let k = 0; k <= half; k++) {
      previousPhase[k] = phase[k];
      runningPhase[k] = synthesisPhase[k];
    }

    re[0] = magnitude[0] * Math.cos(synthesisPhase[0]); im[0] = 0;
    re[half] = magnitude[half] * Math.cos(synthesisPhase[half]); im[half] = 0;
    for (let k = 1; k < half; k++) {
      const c = magnitude[k] * Math.cos(synthesisPhase[k]);
      const s = magnitude[k] * Math.sin(synthesisPhase[k]);
      re[k] = c; im[k] = s;
      re[frameSize - k] = c; im[frameSize - k] = -s;
    }
    fft.inverse(re, im);

    const outStart = Math.round(f * analysisHop * factor) - frameSize + analysisHop;
    for (let i = 0; i < frameSize; i++) {
      const s = outStart + i;
      if (s < 0 || s >= padded) continue;
      const w = window[i];
      sum[s] += re[i] * w;
      weight[s] += w * w;
    }

    if ((f & 31) === 0) yield f / frames;
  }

  const out = new Float64Array(targetLength);
  for (let i = 0; i < targetLength; i++) {
    out[i] = weight[i] > 1e-12 ? sum[i] / weight[i] : 0;
  }
  return out;
}

/** Read `input` at `ratio` samples per output sample, linearly interpolated. */
function resampleTo(input, ratio, outLength) {
  const out = new Float64Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const base = Math.floor(pos);
    const frac = pos - base;
    const a = base >= 0 && base < input.length ? input[base] : 0;
    const b = base + 1 >= 0 && base + 1 < input.length ? input[base + 1] : 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Transpose by a number of semitones, leaving the duration unchanged.
 *
 * Stretch by the frequency ratio, then resample by the same ratio: the stretch
 * restores the length the resampling would otherwise change, and what is left
 * is a pure pitch change.
 */
export function* pitchShiftSteps(samples, semitones, options = {}) {
  const ratio = Math.pow(2, semitones / 12);
  const stretched = yield* timeStretchSteps(samples, ratio, options);
  return resampleTo(stretched, ratio, samples.length);
}

function drive(steps) {
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

/** Run a time stretch to completion. */
export function timeStretch(samples, factor, options = {}) {
  return drive(timeStretchSteps(samples, factor, options));
}

/** Run a pitch shift to completion. */
export function pitchShift(samples, semitones, options = {}) {
  return drive(pitchShiftSteps(samples, semitones, options));
}

/**
 * Change pitch and tempo together in a single pass.
 *
 * Running pitchShift and timeStretch one after the other would put the audio
 * through the vocoder twice and smear it twice over. Folding both into one
 * stretch and one resample keeps the artefacts to a single pass: stretch by
 * tempo x ratio, then resample by ratio, which cancels the ratio out of the
 * duration and leaves it in the pitch.
 */
export function* transformSteps(samples, semitones, tempoFactor = 1, options = {}) {
  const ratio = Math.pow(2, semitones / 12);
  const targetLength = Math.round(samples.length * tempoFactor);
  const stretched = yield* timeStretchSteps(samples, tempoFactor * ratio, options);
  return resampleTo(stretched, ratio, targetLength);
}

/** Run a combined pitch and tempo change to completion. */
export function transform(samples, semitones, tempoFactor = 1, options = {}) {
  return drive(transformSteps(samples, semitones, tempoFactor, options));
}
