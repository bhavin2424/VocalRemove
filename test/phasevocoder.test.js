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
