import { STFT } from './stft.js';

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Major and minor keys that are conventionally written with flats. */
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1, 6]);      // F Bb Eb Ab Db Gb
const FLAT_MINOR = new Set([2, 7, 0, 5, 10, 3]);      // Dm Gm Cm Fm Bbm Ebm

/**
 * Krumhansl-Kessler key profiles: the perceived stability of each scale degree,
 * from the probe-tone experiments. Index 0 is the tonic.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];

function noteNames(tonicPc, mode) {
  const flat = mode === 'minor' ? FLAT_MINOR.has(tonicPc) : FLAT_MAJOR.has(tonicPc);
  return flat ? FLAT_NAMES : SHARP_NAMES;
}

const PITCH_CLASS = (() => {
  const map = new Map();
  SHARP_NAMES.forEach((n, i) => map.set(n, i));
  FLAT_NAMES.forEach((n, i) => map.set(n, i));
  return map;
})();

/** The seven notes of a key, spelled the way a musician would write them. */
export function scaleNotes(tonic, mode) {
  const pc = PITCH_CLASS.get(tonic);
  if (pc === undefined) throw new Error(`unknown note ${tonic}`);
  const names = noteNames(pc, mode);
  const steps = mode === 'minor' ? MINOR_STEPS : MAJOR_STEPS;
  return steps.map((s) => names[(pc + s) % 12]);
}

/**
 * The twelve tonics available in a mode, each spelled the way that key is written.
 *
 * A mode is not something transposing can change -- shifting every note by the same
 * amount moves a major song to another major key -- so the choice on offer is which
 * of the twelve tonics to land on, not which of the twenty-four keys.
 */
export function keysInMode(mode) {
  const out = [];
  for (let pc = 0; pc < 12; pc++) out.push(noteNames(pc, mode)[pc]);
  return out;
}

/**
 * The shortest way, in semitones, from one tonic to another.
 *
 * Every key is reachable in two directions, and the answer is folded into -6..+5 so
 * the shorter one wins. C to G is a fifth up or a fourth down and both arrive at G,
 * but moving down five semitones puts the audio through less of a stretch than
 * moving up seven, so it comes out sounding better.
 */
export function semitonesBetween(fromTonic, toTonic) {
  const from = PITCH_CLASS.get(fromTonic);
  const to = PITCH_CLASS.get(toTonic);
  if (from === undefined) throw new Error(`unknown note ${fromTonic}`);
  if (to === undefined) throw new Error(`unknown note ${toTonic}`);
  return ((((to - from) % 12) + 18) % 12) - 6;
}

/**
 * Fold the spectrum into twelve pitch classes, summed over the whole track.
 *
 * The band limit matters: below ~100 Hz the bins are too wide to resolve a
 * semitone, and above ~3 kHz most of the energy is harmonics and cymbals
 * rather than the notes actually being played.
 */
function chromagram(samples, sampleRate, { frameSize = 8192, hopSize = 4096, minHz = 100, maxHz = 3000 } = {}) {
  const stft = new STFT(frameSize, hopSize);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const chroma = new Float64Array(12);
  const half = frameSize >> 1;

  const binPc = new Int8Array(half + 1).fill(-1);
  for (let k = 1; k <= half; k++) {
    const freq = (k * sampleRate) / frameSize;
    if (freq < minHz || freq > maxHz) continue;
    const midi = 69 + 12 * Math.log2(freq / 440);
    binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
  }

  const frames = stft.frameCount(samples.length);
  for (let f = 0; f < frames; f++) {
    stft.analyzeFrame(samples, f, re, im);
    for (let k = 1; k <= half; k++) {
      const pc = binPc[k];
      if (pc < 0) continue;
      chroma[pc] += Math.hypot(re[k], im[k]);
    }
  }
  return chroma;
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * Detect the musical key by correlating the track's chroma against all 24
 * major and minor profiles and taking the best fit.
 */
export function detectKey(samples, sampleRate, options = {}) {
  const chroma = chromagram(samples, sampleRate, options);

  const scored = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const mode of ['major', 'minor']) {
      const base = mode === 'major' ? MAJOR_PROFILE : MINOR_PROFILE;
      const rotated = new Float64Array(12);
      for (let i = 0; i < 12; i++) rotated[i] = base[(i - tonic + 12) % 12];
      scored.push({
        tonic: noteNames(tonic, mode)[tonic],
        mode,
        name: `${noteNames(tonic, mode)[tonic]} ${mode}`,
        score: pearson(chroma, rotated),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  return {
    tonic: best.tonic,
    mode: best.mode,
    name: best.name,
    notes: scaleNotes(best.tonic, best.mode),
    confidence: Math.max(0, Math.min(1, best.score)),
    alternatives: scored.slice(1, 4).map((s) => ({ name: s.name, confidence: Math.max(0, s.score) })),
  };
}

/**
 * Detect tempo from the spectral flux onset envelope.
 *
 * A log-normal prior centred near 120 BPM breaks the octave ambiguity that
 * plain autocorrelation always has: a steady 140 BPM pulse correlates just as
 * well at 70 BPM, and without the prior the slower reading often wins.
 */
export function detectTempo(samples, sampleRate, { frameSize = 1024, hopSize = 256, minBpm = 60, maxBpm = 200 } = {}) {
  const stft = new STFT(frameSize, hopSize);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const half = frameSize >> 1;
  const frames = stft.frameCount(samples.length);

  const flux = new Float64Array(frames);
  let previous = new Float64Array(half + 1);
  let current = new Float64Array(half + 1);
  for (let f = 0; f < frames; f++) {
    stft.analyzeFrame(samples, f, re, im);
    let sum = 0;
    for (let k = 1; k <= half; k++) {
      current[k] = Math.hypot(re[k], im[k]);
      const rise = current[k] - previous[k];
      if (rise > 0) sum += rise;
    }
    flux[f] = sum;
    const swap = previous; previous = current; current = swap;
  }

  let mean = 0;
  for (let i = 0; i < frames; i++) mean += flux[i];
  mean /= frames || 1;
  for (let i = 0; i < frames; i++) flux[i] = Math.max(0, flux[i] - mean);

  const fps = sampleRate / hopSize;
  const minLag = Math.max(2, Math.floor((60 * fps) / maxBpm));
  const maxLag = Math.min(frames - 1, Math.ceil((60 * fps) / minBpm));

  const strength = new Float64Array(maxLag + 1);
  let bestLag = minLag;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let acf = 0;
    for (let i = lag; i < frames; i++) acf += flux[i] * flux[i - lag];
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.7, 2));
    strength[lag] = acf * prior;
    if (strength[lag] > bestScore) { bestScore = strength[lag]; bestLag = lag; }
  }

  // Parabolic interpolation: lag resolution alone is coarser than 1 BPM.
  let refined = bestLag;
  if (bestLag > minLag && bestLag < maxLag) {
    const a = strength[bestLag - 1];
    const b = strength[bestLag];
    const c = strength[bestLag + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) {
      const shift = (0.5 * (a - c)) / denom;
      if (Math.abs(shift) <= 1) refined = bestLag + shift;
    }
  }

  let energy = 0;
  for (let i = 0; i < frames; i++) energy += flux[i] * flux[i];
  return {
    bpm: (60 * fps) / refined,
    confidence: energy > 0 ? Math.max(0, Math.min(1, bestScore / energy)) : 0,
  };
}

/**
 * The key you land in after transposing by a number of semitones.
 *
 * Spelling is recomputed from the destination rather than carried over, so
 * shifting G major down a semitone reads as Gb major, the way it would be
 * written, instead of F# major.
 */
export function transposeKey(tonic, mode, semitones) {
  const pc = PITCH_CLASS.get(tonic);
  if (pc === undefined) throw new Error(`unknown note ${tonic}`);
  const shifted = (((pc + semitones) % 12) + 12) % 12;
  const name = noteNames(shifted, mode)[shifted];
  return { tonic: name, mode, name: `${name} ${mode}`, notes: scaleNotes(name, mode) };
}
