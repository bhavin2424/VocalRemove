import { FFT } from './fft.js';

const TWO_PI = 2 * Math.PI;

export const STRETCH_DEFAULTS = {
  frameSize: 4096,
  analysisHop: 1024,
  /**
   * Keep the spectral envelope where it was instead of letting it ride up with the
   * pitch. Moving it is what turns a voice shifted up into a chipmunk and a voice
   * shifted down into a growl; holding it still keeps the singer sounding like the
   * same person in a different key.
   */
  preserveFormants: true,
  /**
   * Re-lock every bin to the incoming phase when a frame is mostly new energy.
   * Across a drum hit the running phase estimate is meaningless -- there is no steady
   * partial to track -- and carrying it through is what softens the attack and leaves
   * the kit sounding flammed.
   */
  transientThreshold: 1.6,
};

/** Wrap a phase difference into (-pi, pi]. */
function principalArgument(phase) {
  return phase - TWO_PI * Math.round(phase / TWO_PI);
}

function hann(size) {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((TWO_PI * i) / size));
  return w;
}

/**
 * Smooth the magnitude spectrum into an envelope: the broad shape a spectrum has
 * once the individual partials are averaged out. For a voice that shape is its
 * formants, which is to say the shape of the singer's throat, and it should not move
 * when the note does.
 *
 * A running sum keeps this at a constant cost per bin regardless of the width.
 */
function spectralEnvelope(mag, half, width, out) {
  const reach = Math.max(1, width >> 1);
  let sum = 0;
  let count = 0;
  for (let k = 0; k <= Math.min(half, reach); k++) { sum += mag[k]; count++; }
  for (let k = 0; k <= half; k++) {
    const entering = k + reach;
    const leaving = k - reach - 1;
    if (k > 0) {
      if (entering <= half) { sum += mag[entering]; count++; }
      if (leaving >= 0) { sum -= mag[leaving]; count--; }
    }
    out[k] = count > 0 ? sum / count : 0;
  }
}

const LANCZOS_LOBES = 3;

function lanczos(x) {
  if (x === 0) return 1;
  if (x <= -LANCZOS_LOBES || x >= LANCZOS_LOBES) return 0;
  const px = Math.PI * x;
  return (LANCZOS_LOBES * Math.sin(px) * Math.sin(px / LANCZOS_LOBES)) / (px * px);
}

/**
 * Read `input` at `ratio` samples per output sample, through a windowed-sinc kernel.
 *
 * Straight-line interpolation between neighbouring samples is cheap and audibly
 * wrong: it dulls the top octave and folds whatever sits above the new Nyquist back
 * down as aliasing, which is a good part of the metallic edge a naive pitch shifter
 * has. When the read runs faster than the source the kernel is widened by the same
 * factor, so it low-passes as it decimates rather than aliasing.
 */
function resampleTo(input, ratio, outLength) {
  const scale = Math.max(1, ratio);
  const radius = LANCZOS_LOBES * scale;
  const out = new Float64Array(outLength);

  for (let i = 0; i < outLength; i++) {
    const pos = i * ratio;
    const first = Math.ceil(pos - radius);
    const last = Math.floor(pos + radius);
    let sum = 0;
    let norm = 0;
    for (let j = first; j <= last; j++) {
      const w = lanczos((pos - j) / scale);
      if (w === 0) continue;
      if (j >= 0 && j < input.length) sum += input[j] * w;
      norm += w;
    }
    out[i] = Math.abs(norm) > 1e-9 ? sum / norm : 0;
  }
  return out;
}

/**
 * Stretch a set of channels in time, in lockstep, without changing their pitch.
 *
 * Standard phase vocoder at heart: estimate each bin's true frequency from how far
 * its phase advanced between analysis frames, then re-advance that phase over a
 * different synthesis hop. Two things are layered on top.
 *
 * Identity phase locking keeps it from sounding underwater. Advancing every bin on
 * its own lets the partials of one note drift apart from each other, so only spectral
 * peaks accumulate phase and the bins around a peak keep their original relationship
 * to it.
 *
 * Every channel is then rotated by the *same* phase correction, taken from their sum.
 * Running a separate vocoder per channel is what smears a stereo image: the two sides
 * accumulate phase independently, their relationship drifts, and a centred instrument
 * wanders and widens. Rotating both by one correction leaves the difference between
 * the channels exactly as it was recorded, so the image survives the shift.
 */
export function* stretchChannelsSteps(channels, factor, options = {}) {
  const opts = { ...STRETCH_DEFAULTS, ...options };
  const { frameSize, analysisHop } = opts;
  const count = channels.length;
  const sourceLength = channels[0].length;

  const fft = new FFT(frameSize);
  const half = frameSize >> 1;
  const window = hann(frameSize);

  const targetLength = Math.round(sourceLength * factor);
  const padded = targetLength + 2 * frameSize;
  const sums = [];
  const weights = new Float64Array(padded);
  for (let c = 0; c < count; c++) sums.push(new Float64Array(padded));

  const re = [];
  const im = [];
  for (let c = 0; c < count; c++) {
    re.push(new Float64Array(frameSize));
    im.push(new Float64Array(frameSize));
  }

  const refRe = new Float64Array(frameSize);
  const refIm = new Float64Array(frameSize);
  const magnitude = new Float64Array(half + 1);
  const phase = new Float64Array(half + 1);
  const previousPhase = new Float64Array(half + 1);
  const previousMagnitude = new Float64Array(half + 1);
  const runningPhase = new Float64Array(half + 1);
  const synthesisPhase = new Float64Array(half + 1);
  const envelope = new Float64Array(half + 1);
  const shifted = new Float64Array(half + 1);
  const correction = new Float64Array(half + 1);

  // Formants are restored against the pitch ratio the caller is about to apply with
  // the resampler, which is the whole of the shift that this stretch is not undoing.
  const pitchRatio = opts.formantRatio || 1;
  const wantFormants = opts.preserveFormants && Math.abs(pitchRatio - 1) > 1e-6;
  const envelopeWidth = Math.max(4, frameSize >> 6);

  const frames = Math.ceil((sourceLength + frameSize) / analysisHop) + 1;
  let fluxAverage = 0;

  for (let f = 0; f < frames; f++) {
    const inStart = f * analysisHop - frameSize + analysisHop;
    for (let c = 0; c < count; c++) {
      const src = channels[c];
      const cre = re[c];
      const cim = im[c];
      for (let i = 0; i < frameSize; i++) {
        const s = inStart + i;
        cre[i] = s >= 0 && s < src.length ? src[s] * window[i] : 0;
        cim[i] = 0;
      }
      fft.forward(cre, cim);
    }

    // The reference the phase is tracked on is the sum of the channels, so every
    // channel is corrected by one shared rotation.
    for (let k = 0; k <= half; k++) {
      let sr = 0;
      let si = 0;
      for (let c = 0; c < count; c++) { sr += re[c][k]; si += im[c][k]; }
      refRe[k] = sr / count;
      refIm[k] = si / count;
      magnitude[k] = Math.hypot(refRe[k], refIm[k]);
      phase[k] = Math.atan2(refIm[k], refRe[k]);
    }

    // Spectral flux against a running average: a frame that is mostly new energy is
    // an attack, and the phase history across it is worthless.
    let flux = 0;
    for (let k = 0; k <= half; k++) {
      const rise = magnitude[k] - previousMagnitude[k];
      if (rise > 0) flux += rise;
    }
    const transient = f > 0 && fluxAverage > 0 && flux > opts.transientThreshold * fluxAverage;
    fluxAverage = f === 0 ? flux : fluxAverage * 0.9 + flux * 0.1;

    if (transient) {
      for (let k = 0; k <= half; k++) synthesisPhase[k] = phase[k];
    } else {
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
    }

    for (let k = 0; k <= half; k++) {
      previousPhase[k] = phase[k];
      previousMagnitude[k] = magnitude[k];
      runningPhase[k] = synthesisPhase[k];
    }

    /*
     * Formant correction. The resampler about to run will carry the content at bin k
     * out to bin k * pitchRatio, taking the envelope with it. Pre-dividing by the
     * envelope that would land there and multiplying by the one that belongs there
     * leaves the envelope where it started while the partials still move.
     */
    if (wantFormants) {
      spectralEnvelope(magnitude, half, envelopeWidth, envelope);
      for (let k = 0; k <= half; k++) {
        const source = Math.min(half, Math.round(k * pitchRatio));
        shifted[k] = envelope[source];
      }
      let peak = 0;
      for (let k = 0; k <= half; k++) if (envelope[k] > peak) peak = envelope[k];
      const floor = peak * 1e-4 + 1e-12;
      let before = 0;
      let after = 0;
      for (let k = 0; k <= half; k++) {
        const c = shifted[k] / Math.max(envelope[k], floor);
        // Hold the correction inside a sane range: an envelope ratio can run away in
        // near-empty bins and turn quiet noise into a whistle.
        const clamped = c > 4 ? 4 : c < 0.25 ? 0.25 : c;
        correction[k] = clamped;
        before += magnitude[k];
        after += magnitude[k] * clamped;
      }
      // Reshaping the envelope must not change how loud the frame is. Without this
      // the correction quietly acts as a gain, and a shift of an octave arrives
      // several decibels down on where it started.
      const makeup = before > 0 && after > 0 ? before / after : 1;
      for (let k = 0; k <= half; k++) correction[k] *= makeup;
    }

    for (let c = 0; c < count; c++) {
      const cre = re[c];
      const cim = im[c];
      for (let k = 0; k <= half; k++) {
        // Rotate this channel by the shared correction, leaving its own magnitude and
        // its phase relative to the other channels untouched.
        const turn = synthesisPhase[k] - phase[k];
        const cos = Math.cos(turn);
        const sin = Math.sin(turn);
        let vr = cre[k] * cos - cim[k] * sin;
        let vi = cre[k] * sin + cim[k] * cos;
        if (wantFormants) { vr *= correction[k]; vi *= correction[k]; }
        cre[k] = vr;
        cim[k] = vi;
        if (k > 0 && k < half) {
          cre[frameSize - k] = vr;
          cim[frameSize - k] = -vi;
        }
      }
      cim[0] = 0;
      cim[half] = 0;
      fft.inverse(cre, cim);
    }

    const outStart = Math.round(f * analysisHop * factor) - frameSize + analysisHop;
    for (let i = 0; i < frameSize; i++) {
      const s = outStart + i;
      if (s < 0 || s >= padded) continue;
      const w = window[i];
      for (let c = 0; c < count; c++) sums[c][s] += re[c][i] * w;
      weights[s] += w * w;
    }

    if ((f & 31) === 0) yield f / frames;
  }

  const out = [];
  for (let c = 0; c < count; c++) {
    const channel = new Float64Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
      channel[i] = weights[i] > 1e-12 ? sums[c][i] / weights[i] : 0;
    }
    out.push(channel);
  }
  return out;
}

/** Stretch or compress audio in time without changing its pitch. */
export function* timeStretchSteps(samples, factor, options = {}) {
  const out = yield* stretchChannelsSteps([samples], factor, options);
  return out[0];
}

/**
 * Change pitch and tempo together, across every channel at once.
 *
 * Running a pitch shift and then a time stretch would put the audio through the
 * vocoder twice and smear it twice over. Folding both into one stretch and one
 * resample keeps the artefacts to a single pass: stretch by tempo x ratio, then
 * resample by ratio, which cancels the ratio out of the duration and leaves it in
 * the pitch.
 */
export function* transformChannelsSteps(channels, semitones, tempoFactor = 1, options = {}) {
  const ratio = Math.pow(2, semitones / 12);
  const targetLength = Math.round(channels[0].length * tempoFactor);
  const stretched = yield* stretchChannelsSteps(channels, tempoFactor * ratio, {
    ...options,
    formantRatio: ratio,
  });
  return stretched.map((channel) => resampleTo(channel, ratio, targetLength));
}

/** Transpose by a number of semitones, leaving the duration unchanged. */
export function* pitchShiftSteps(samples, semitones, options = {}) {
  const out = yield* transformChannelsSteps([samples], semitones, 1, options);
  return out[0];
}

export function* transformSteps(samples, semitones, tempoFactor = 1, options = {}) {
  const out = yield* transformChannelsSteps([samples], semitones, tempoFactor, options);
  return out[0];
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

/** Run a combined pitch and tempo change to completion. */
export function transform(samples, semitones, tempoFactor = 1, options = {}) {
  return drive(transformSteps(samples, semitones, tempoFactor, options));
}

/** Run a combined pitch and tempo change across channels held in lockstep. */
export function transformChannels(channels, semitones, tempoFactor = 1, options = {}) {
  return drive(transformChannelsSteps(channels, semitones, tempoFactor, options));
}
