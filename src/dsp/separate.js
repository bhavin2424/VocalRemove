import { STFT } from './stft.js';

export const SEPARATION_DEFAULTS = {
  frameSize: 4096,
  hopSize: 1024,
  /** Mask steepness. Higher drives borderline bins towards fully in or fully out. */
  exponent: 2,
  /**
   * Nothing below this is touched at all: sub-bass and the body of a kick drum, where
   * no voice lives and anything removed is felt as the bottom falling out of the mix.
   */
  lowEdgeHz: 70,
  /**
   * Full strength begins here. Between the edge and this point the mask is ramped in
   * rather than switched on, because that octave is shared: it holds the fundamental
   * of a male voice and the bass guitar at the same time, both dead centre. A hard cut
   * here protects the bass perfectly and lets the whole fundamental of a male lead
   * through untouched, which is more than half of what a listener hears as the voice.
   */
  lowCutHz: 180,
  /** Above this, content is treated as cymbals and air, and kept likewise. */
  highCutHz: 10000,
  /**
   * How hard panned content is subtracted off the centre estimate. Above 1 this is
   * deliberate over-subtraction: it costs a little vocal-stem quality and buys a
   * noticeably cleaner backing track, which is the trade a karaoke track wants.
   */
  sideSubtraction: 1.35,
  /** How hard broadband content is subtracted, which is what protects the drums. */
  percussiveSubtraction: 1,
  /**
   * How hard sustained content is subtracted, which is what protects centre-panned
   * keys, pads and guitars. Stereo position cannot tell those from a lead vocal --
   * they are all dead centre -- so without this the accompaniment is gutted along
   * with the voice and the backing track comes out hollow.
   */
  sustainedSubtraction: 0.5,
  /**
   * Gain on the vocal estimate when it is removed from the backing track. At 1 the
   * two stems sum back to the input exactly; above 1 the backing track is scrubbed
   * harder at the cost of that guarantee.
   */
  overSubtraction: 1,
  /**
   * Find the note the voice is singing, and remove its fundamental by name rather
   * than by position.
   *
   * The harmonics above the low band separate cleanly, and they say what note is being
   * sung. That is enough to place the fundamental, which otherwise sits in the octave
   * shared with the bass guitar where nothing can pick it out.
   *
   * Off by default, because measured against the alternative it does not pay for
   * itself. On a male lead it buys about two decibels more removal and costs a quarter
   * of the bass; on a female lead, whose fundamental is above the low band anyway, it
   * buys nothing and still costs some. Worth turning on only for low male leads in
   * material where the bottom end matters less than the voice.
   */
  trackFundamental: false,
  /** The range a sung fundamental is looked for in, low male to high female. */
  minF0Hz: 75,
  maxF0Hz: 420,
  /**
   * How far the harmonic evidence must stand above the average for a frame to count as
   * sung at all. Too low and the comb chases the bass around during instrumental
   * passages; too high and quiet singing keeps its fundamental.
   */
  f0Confidence: 2.2,
};

/**
 * The fundamental of whatever is being sung, from the harmonics that separated well.
 *
 * Scored on harmonics two and up, and only above `fromBin`, because the fundamental
 * itself is exactly the part that could not be measured -- that is the whole reason
 * for looking. A run of harmonics at consistent spacing is the signature of one voice
 * on one note, and the bass, an octave or more below and on its own note, does not
 * produce it.
 */
function estimateF0(vocalEst, half, binsPerHz, opts, fromBin) {
  let bestHz = 0;
  let best = 0;
  let total = 0;
  let counted = 0;

  for (let k = fromBin; k <= half; k++) { total += vocalEst[k]; counted++; }
  const average = counted > 0 ? total / counted : 0;
  if (average <= 0) return 0;

  for (let hz = opts.minF0Hz; hz <= opts.maxF0Hz; hz++) {
    let score = 0;
    let used = 0;
    for (let h = 2; h <= 8; h++) {
      const k = Math.round(hz * h * binsPerHz);
      if (k > half) break;
      if (k < fromBin) continue;
      score += vocalEst[k];
      used++;
    }
    if (used >= 3 && score / used > best) { best = score / used; bestHz = hz; }
  }

  return best > opts.f0Confidence * average ? bestHz : 0;
}

/**
 * Width of the broadband floor estimate, as taps and the bin stride between them.
 *
 * Nine taps two bins apart span +/-8 bins, which at 4096 clears the four-bin main
 * lobe a windowed sine occupies. So a tonal peak sees a floor drawn from its far
 * skirt -- near zero, no penalty -- while a drum hit, broadband by nature, sees a
 * floor as tall as itself and is held out of the vocal stem.
 */
const FLOOR_TAPS = 9;
const FLOOR_STRIDE = 2;

/**
 * Width of the sustained estimate, as taps and the frame stride between them.
 *
 * Eleven taps four frames apart reach +/-20 frames, which at 1024 is a little under
 * half a second either side. Held notes sit still for that long and read as
 * accompaniment; a sung line, with its vibrato and its movement between notes, does
 * not hold any one bin for half a second and reads as voice.
 */
const TIME_TAPS = 11;
const TIME_STRIDE = 4;
const TIME_REACH = ((TIME_TAPS - 1) >> 1) * TIME_STRIDE;

/** Median of `count` values gathered in `scratch`, sorted in place. */
function medianOf(scratch, count) {
  for (let a = 1; a < count; a++) {
    const v = scratch[a];
    let b = a - 1;
    while (b >= 0 && scratch[b] > v) { scratch[b + 1] = scratch[b]; b--; }
    scratch[b + 1] = v;
  }
  return scratch[count >> 1];
}

/**
 * Median magnitude around each bin: an estimate of the broadband floor under it.
 *
 * A median rather than a mean, because a mean is dragged up by the very peak we are
 * trying to measure the floor beneath.
 */
function broadbandFloor(mag, half, out, scratch) {
  const centre = (FLOOR_TAPS - 1) >> 1;
  for (let k = 0; k <= half; k++) {
    for (let t = 0; t < FLOOR_TAPS; t++) {
      // Reflect at the band edges so the first and last bins get a real window.
      let idx = k + (t - centre) * FLOOR_STRIDE;
      if (idx < 0) idx = -idx;
      if (idx > half) idx = 2 * half - idx;
      scratch[t] = mag[idx];
    }
    out[k] = medianOf(scratch, FLOOR_TAPS);
  }
}

/**
 * Band weighting. Bass and kick drums are mixed dead centre too, so a centre
 * estimate alone would drag them into the vocal stem and leave a hollow backing
 * track. Raised-cosine edges avoid audible ringing at the transitions.
 */
function bandWeight(freq, lowEdge, lowCut, highCut) {
  const highEnd = highCut * 1.4;
  if (freq <= lowEdge || freq >= highEnd) return 0;
  if (freq < lowCut) return 0.5 - 0.5 * Math.cos((Math.PI * (freq - lowEdge)) / (lowCut - lowEdge));
  if (freq <= highCut) return 1;
  return 0.5 + 0.5 * Math.cos((Math.PI * (freq - highCut)) / (highEnd - highCut));
}

function buildBandWeights(frameSize, sampleRate, lowEdge, lowCut, highCut) {
  const half = frameSize >> 1;
  const w = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) w[k] = bandWeight((k * sampleRate) / frameSize, lowEdge, lowCut, highCut);
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
 * Split a stereo track into a vocal stem and a backing track.
 *
 * The mix is read as mid and side rather than left and right, and each bin of the
 * mid is asked three questions at once. How much of it is panned away from centre,
 * measured directly as the side magnitude. How much of it is broadband, measured as
 * the median across neighbouring bins, which is what a drum looks like. How much of
 * it is holding still, measured as the median across neighbouring frames, which is
 * what a held chord looks like. Whatever is left over is centred, tonal and moving,
 * and that is a lead vocal:
 *
 *   vocal ~= |mid| - sideSubtraction * |side|
 *                  - max(percussiveSubtraction * broadband, sustainedSubtraction * sustained)
 *
 * The last term is the one that matters most in practice. Keys, pads and rhythm
 * guitars are mixed dead centre just like the voice, so stereo position alone cannot
 * separate them and a centre-extraction engine strips them out along with the vocal,
 * which is what leaves a karaoke track sounding hollow. Time structure can separate
 * them, because a held chord occupies one bin for half a second and a sung phrase
 * never does.
 *
 * Subtraction rather than a correlation ratio is the other half of it. A correlation
 * between the channels collapses as soon as a panned instrument shares a bin with the
 * voice, so the mask goes soft exactly where the voice is loudest and the lead
 * survives into the backing track. Subtraction stays accurate there.
 *
 * Only the vocal stem is synthesised, as a true centre signal. The backing track is
 * the input minus that, which leaves the entire side signal untouched, so panned
 * instruments come through exactly as they were recorded and the stereo image is
 * preserved rather than rebuilt.
 *
 * Exposed as a generator that yields a 0..1 progress fraction. A file:// page cannot
 * spawn a Worker, so the browser drives this loop in slices to stay responsive;
 * `separate` below drives it straight through.
 */
export function* separateSteps(left, right, sampleRate, options = {}) {
  const opts = { ...SEPARATION_DEFAULTS, ...options };
  const length = Math.min(left.length, right.length);
  const stft = new STFT(opts.frameSize, opts.hopSize);
  const band = buildBandWeights(opts.frameSize, sampleRate, opts.lowEdgeHz, opts.lowCutHz, opts.highCutHz);

  const n = opts.frameSize;
  const half = n >> 1;
  const bins = half + 1;
  const frames = stft.frameCount(length);

  // The sustained estimate needs frames from either side of the one being written,
  // so analysis runs ahead of synthesis and the frames in between wait in a ring.
  const ring = 2 * TIME_REACH + 1;
  const midRe = new Float64Array(ring * n);
  const midIm = new Float64Array(ring * n);
  const midMag = new Float64Array(ring * bins);
  const sideMag = new Float64Array(ring * bins);

  const lre = new Float64Array(n);
  const lim = new Float64Array(n);
  const rre = new Float64Array(n);
  const rim = new Float64Array(n);
  const floor = new Float64Array(bins);
  const vocalEst = new Float64Array(bins);
  const f0Est = new Float64Array(bins);
  const binsPerHz = n / sampleRate;
  const lowCutBin = Math.round(opts.lowCutHz * binsPerHz);
  const sustained = new Float64Array(bins);
  const scratch = new Float64Array(Math.max(FLOOR_TAPS, TIME_TAPS));

  const accVocal = stft.createAccumulator(length);
  const total = frames + TIME_REACH;

  for (let f = 0; f < total; f++) {
    if (f < frames) {
      stft.analyzeFrame(left, f, lre, lim);
      stft.analyzeFrame(right, f, rre, rim);

      const slot = (f % ring) * n;
      const magSlot = (f % ring) * bins;
      for (let k = 0; k < n; k++) {
        midRe[slot + k] = (lre[k] + rre[k]) * 0.5;
        midIm[slot + k] = (lim[k] + rim[k]) * 0.5;
      }
      for (let k = 0; k <= half; k++) {
        midMag[magSlot + k] = Math.hypot(midRe[slot + k], midIm[slot + k]);
        sideMag[magSlot + k] = Math.hypot((lre[k] - rre[k]) * 0.5, (lim[k] - rim[k]) * 0.5);
      }
    }

    const fc = f - TIME_REACH;
    if (fc < 0) continue;

    const slot = (fc % ring) * n;
    const magSlot = (fc % ring) * bins;
    broadbandFloor(midMag.subarray(magSlot, magSlot + bins), half, floor, scratch);

    for (let k = 0; k <= half; k++) {
      for (let t = 0; t < TIME_TAPS; t++) {
        // Hold at the ends of the track rather than reflecting: there is no
        // meaningful "before the first frame" to average against.
        let g = fc + (t - ((TIME_TAPS - 1) >> 1)) * TIME_STRIDE;
        if (g < 0) g = 0;
        if (g > frames - 1) g = frames - 1;
        scratch[t] = midMag[(g % ring) * bins + k];
      }
      sustained[k] = medianOf(scratch, TIME_TAPS);
    }

    // The estimate first, across the whole spectrum and before any band weighting.
    // The band ramp decides how much of the estimate to act on, not how much of it
    // there is, and the fundamental search needs the unweighted version.
    for (let k = 0; k <= half; k++) {
      const structure = Math.max(
        opts.percussiveSubtraction * floor[k],
        opts.sustainedSubtraction * sustained[k]
      );
      const vocal = midMag[magSlot + k] - opts.sideSubtraction * sideMag[magSlot + k] - structure;
      vocalEst[k] = vocal > 0 ? vocal : 0;
    }

    let combLo = -1;
    let combHi = -1;
    if (opts.trackFundamental) {
      /*
       * The search runs on its own estimate, with the sustained part subtracted in
       * full rather than at the mask's setting. A bass guitar holding a note vanishes
       * under that; a voice, which moves, does not. Searching on the same half-strength
       * estimate the mask uses lets the bass score as well as the singer, and the comb
       * then locks onto the bass and notches the low end out of the backing track.
       */
      for (let k = 0; k <= half; k++) {
        const steady = Math.max(opts.percussiveSubtraction * floor[k], sustained[k]);
        const v = midMag[magSlot + k] - opts.sideSubtraction * sideMag[magSlot + k] - steady;
        f0Est[k] = v > 0 ? v : 0;
      }
      const f0 = estimateF0(f0Est, half, binsPerHz, opts, lowCutBin);
      if (f0 > 0 && f0 < opts.lowCutHz) {
        /*
         * The fundamental could not be measured where it sits, so it is taken on the
         * word of its own harmonics: however much voice was found at the octave and
         * the twelfth above, at least that much is here too. Capped at what the bin
         * actually holds, so this can only ever reclassify energy that is present.
         */
        let evidence = 0;
        for (let h = 2; h <= 4; h++) {
          const k = Math.round(f0 * h * binsPerHz);
          if (k <= half && vocalEst[k] > evidence) evidence = vocalEst[k];
        }
        const centre = f0 * binsPerHz;
        combLo = Math.max(0, Math.floor(centre - 1.5));
        combHi = Math.min(half, Math.ceil(centre + 1.5));
        for (let k = combLo; k <= combHi; k++) {
          const mag = midMag[magSlot + k];
          vocalEst[k] = Math.min(mag, Math.max(vocalEst[k], evidence));
        }
      }
    }

    for (let k = 0; k <= half; k++) {
      // A bin the fundamental was traced to is acted on at full strength whatever the
      // band ramp says, which is the point of having gone looking for it.
      const w = k >= combLo && k <= combHi ? 1 : band[k];
      const mag = midMag[magSlot + k];
      let mask = 0;
      if (w > 0 && mag > 1e-12) {
        const vocal = vocalEst[k];
        if (vocal > 0) {
          // Wiener form: whatever the subtraction did not claim is the accompaniment,
          // and the exponent decides how sharply the line between them is drawn.
          const accompaniment = mag - vocal;
          const v = Math.pow(vocal, opts.exponent);
          const a = Math.pow(accompaniment, opts.exponent);
          mask = (v / (v + a)) * w;
        }
      }
      midRe[slot + k] *= mask;
      midIm[slot + k] *= mask;
      if (k > 0 && k < half) {
        midRe[slot + n - k] *= mask;
        midIm[slot + n - k] *= mask;
      }
    }

    stft.addFrame(accVocal, fc, midRe.subarray(slot, slot + n), midIm.subarray(slot, slot + n));
    if ((f & 31) === 0) yield f / total;
  }

  const vocal = stft.finish(accVocal);
  const vocalsL = new Float64Array(length);
  const vocalsR = new Float64Array(length);
  const instrumentalL = new Float64Array(length);
  const instrumentalR = new Float64Array(length);
  const g = opts.overSubtraction;
  for (let i = 0; i < length; i++) {
    // A centre-panned lead is by definition the same in both channels, so the vocal
    // stem is that one signal on both sides rather than two separately masked ones.
    const v = vocal[i];
    vocalsL[i] = v;
    vocalsR[i] = v;
    instrumentalL[i] = left[i] - g * v;
    instrumentalR[i] = right[i] - g * v;
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
