import test from 'node:test';
import assert from 'node:assert/strict';
import { timeStretch, pitchShift } from '../src/dsp/phasevocoder.js';

const SR = 22050;
const N = SR;

function tone(freq, n = N) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

/** Amplitude of the component at `freq`, measured over the steady middle. */
function ampAt(x, freq) {
  const from = Math.floor(x.length * 0.2);
  const to = Math.floor(x.length * 0.8);
  let re = 0, im = 0;
  for (let i = from; i < to; i++) {
    const p = (2 * Math.PI * freq * i) / SR;
    re += x[i] * Math.cos(p);
    im += x[i] * Math.sin(p);
  }
  return (2 * Math.hypot(re, im)) / (to - from);
}

test('stretching to twice the length doubles the duration', () => {
  const out = timeStretch(tone(440), 2);
  assert.equal(out.length, 2 * N);
});

test('stretching does not change the pitch', () => {
  const out = timeStretch(tone(440), 2);
  assert.ok(ampAt(out, 440) > 0.3, `440 Hz amplitude fell to ${ampAt(out, 440).toFixed(3)}`);
  assert.ok(ampAt(out, 880) < 0.1, 'stretching introduced an octave artefact');
});

test('compressing to half the length halves the duration', () => {
  const out = timeStretch(tone(440), 0.5);
  assert.equal(out.length, Math.round(N * 0.5));
});

test('shifting up an octave doubles the frequency', () => {
  const out = pitchShift(tone(440), 12);
  assert.ok(ampAt(out, 880) > 3 * ampAt(out, 440), `880 Hz did not dominate: ${ampAt(out, 880).toFixed(3)} vs ${ampAt(out, 440).toFixed(3)}`);
});

test('shifting down an octave halves the frequency', () => {
  const out = pitchShift(tone(440), -12);
  assert.ok(ampAt(out, 220) > 3 * ampAt(out, 440), `220 Hz did not dominate: ${ampAt(out, 220).toFixed(3)} vs ${ampAt(out, 440).toFixed(3)}`);
});

test('shifting up a fifth lands on the right frequency', () => {
  const out = pitchShift(tone(440), 7);
  const fifth = 440 * Math.pow(2, 7 / 12);
  assert.ok(ampAt(out, fifth) > 3 * ampAt(out, 440), `expected energy at ${fifth.toFixed(1)} Hz`);
});

test('shifting preserves the duration', () => {
  const out = pitchShift(tone(440), 5);
  assert.equal(out.length, N);
});

test('shifting by zero semitones leaves the tone intact', () => {
  const out = pitchShift(tone(440), 0);
  assert.ok(ampAt(out, 440) > 0.35, `amplitude dropped to ${ampAt(out, 440).toFixed(3)}`);
});

test('transform changes pitch and tempo together in one pass', async () => {
  const { transform } = await import('../src/dsp/phasevocoder.js');
  const out = transform(tone(440), 12, 2);

  assert.equal(out.length, 2 * N, 'duration should follow the tempo factor');
  assert.ok(ampAt(out, 880) > 3 * ampAt(out, 440), 'pitch should follow the semitone shift');
});

test('transform with no change returns the same length', async () => {
  const { transform } = await import('../src/dsp/phasevocoder.js');
  assert.equal(transform(tone(440), 0, 1).length, N);
});

/** Pearson correlation between two channels: how tightly the image holds together. */
function correlation(a, b) {
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { num += a[i] * b[i]; da += a[i] * a[i]; db += b[i] * b[i]; }
  return num / Math.sqrt(da * db || 1e-12);
}

function rms(x) {
  let s = 0;
  for (const v of x) s += v * v;
  return Math.sqrt(s / x.length);
}

/** A stereo pair that is the same source with one side delayed, as any record is. */
function stereoPair() {
  const mono = tone(330, N * 2);
  const delay = Math.round(0.011 * SR);
  const left = Float64Array.from(mono);
  const right = new Float64Array(mono.length);
  for (let i = 0; i < mono.length; i++) {
    right[i] = mono[i] + (i >= delay ? 0.25 * mono[i - delay] : 0);
  }
  return { left, right };
}

test('shifting a stereo pair together holds the image where it was', async () => {
  const { transformChannels } = await import('../src/dsp/phasevocoder.js');
  const { left, right } = stereoPair();
  const before = correlation(left, right);

  for (const semitones of [4, 7, 12]) {
    const [l, r] = transformChannels([left, right], semitones, 1);
    const after = correlation(l, r);
    assert.ok(
      Math.abs(after - before) < 0.05,
      `${semitones} semitones moved the channel correlation from ${before.toFixed(3)} to ${after.toFixed(3)}`
    );
  }
});

test('shifting the channels apart is what smears the image', async () => {
  // The reason the stereo path exists at all. Running one vocoder per channel lets
  // their phases drift independently and the image widens and wanders.
  const { transformChannels, transform } = await import('../src/dsp/phasevocoder.js');
  const { left, right } = stereoPair();
  const before = correlation(left, right);

  const apart = correlation(transform(left, 7, 1), transform(right, 7, 1));
  const [tl, tr] = transformChannels([left, right], 7, 1);
  const together = correlation(tl, tr);

  assert.ok(
    Math.abs(together - before) < Math.abs(apart - before),
    `linked shifting (${together.toFixed(3)}) was no better than independent (${apart.toFixed(3)}) against ${before.toFixed(3)}`
  );
});

test('shifting does not change how loud the audio is', () => {
  // Formant correction reshapes the spectrum, and without a makeup gain it doubles as
  // a volume control: an octave up used to arrive more than ten decibels down.
  const source = tone(440, N * 2);
  const level = rms(source);
  for (const semitones of [-12, -7, -3, 3, 7, 12]) {
    const out = rms(pitchShift(source, semitones));
    const drift = 20 * Math.log10(out / level);
    assert.ok(Math.abs(drift) < 1.5, `${semitones} semitones changed the level by ${drift.toFixed(1)} dB`);
  }
});

test('the full range from minus twelve to plus twelve semitones is supported', () => {
  const source = tone(440, N);
  for (let semitones = -12; semitones <= 12; semitones++) {
    const out = pitchShift(source, semitones);
    assert.equal(out.length, N, `${semitones} semitones changed the duration`);
    assert.ok(Number.isFinite(rms(out)) && rms(out) > 0.05, `${semitones} semitones produced no signal`);
  }
});
