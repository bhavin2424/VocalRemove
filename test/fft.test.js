import test from 'node:test';
import assert from 'node:assert/strict';
import { FFT } from '../src/dsp/fft.js';

/** Largest absolute difference between two arrays. */
function maxDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

test('forward then inverse returns the original signal', () => {
  const n = 1024;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  // Deterministic pseudo-random signal.
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    re[i] = seed / 0x7fffffff - 0.5;
  }
  const original = Float64Array.from(re);

  fft.forward(re, im);
  fft.inverse(re, im);

  assert.ok(maxDiff(re, original) < 1e-10, `round-trip error ${maxDiff(re, original)}`);
  assert.ok(Math.max(...im.map(Math.abs)) < 1e-10, 'imaginary part should vanish');
});

test('a pure cosine puts all its energy in one bin', () => {
  const n = 512;
  const k = 7;
  const fft = new FFT(n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * k * i) / n);

  fft.forward(re, im);

  const mag = (j) => Math.hypot(re[j], im[j]);
  // A real cosine of amplitude 1 splits into two bins of magnitude n/2.
  assert.ok(Math.abs(mag(k) - n / 2) < 1e-6, `bin ${k} magnitude was ${mag(k)}`);
  assert.ok(Math.abs(mag(n - k) - n / 2) < 1e-6, `mirror bin magnitude was ${mag(n - k)}`);
  for (let j = 0; j < n; j++) {
    if (j !== k && j !== n - k) {
      assert.ok(mag(j) < 1e-6, `bin ${j} should be empty, was ${mag(j)}`);
    }
  }
});

test('rejects sizes that are not a power of two', () => {
  assert.throws(() => new FFT(1000), /power of two/i);
});
