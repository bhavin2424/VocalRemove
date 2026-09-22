import test from 'node:test';
import assert from 'node:assert/strict';
import { STFT } from '../src/dsp/stft.js';

function noise(n, seed = 999) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    x[i] = seed / 0x7fffffff - 0.5;
  }
  return x;
}

/** Analyse every frame and immediately resynthesise it, changing nothing. */
function roundTrip(signal, frameSize, hopSize) {
  const stft = new STFT(frameSize, hopSize);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const acc = stft.createAccumulator(signal.length);
  for (let f = 0; f < stft.frameCount(signal.length); f++) {
    stft.analyzeFrame(signal, f, re, im);
    stft.addFrame(acc, f, re, im);
  }
  return stft.finish(acc);
}

test('analysis followed by synthesis reconstructs the signal exactly', () => {
  const signal = noise(5000);
  const out = roundTrip(signal, 1024, 256);

  assert.equal(out.length, signal.length);
  let worst = 0;
  for (let i = 0; i < signal.length; i++) worst = Math.max(worst, Math.abs(out[i] - signal[i]));
  assert.ok(worst < 1e-9, `reconstruction error ${worst}`);
});

test('reconstruction holds at 50% overlap too', () => {
  const signal = noise(4096, 4242);
  const out = roundTrip(signal, 512, 256);

  let worst = 0;
  for (let i = 0; i < signal.length; i++) worst = Math.max(worst, Math.abs(out[i] - signal[i]));
  assert.ok(worst < 1e-9, `reconstruction error ${worst}`);
});

test('the very first and last samples are reconstructed, not faded out', () => {
  const signal = new Float64Array(3000).fill(0.5);
  const out = roundTrip(signal, 1024, 256);

  assert.ok(Math.abs(out[0] - 0.5) < 1e-9, `first sample was ${out[0]}`);
  assert.ok(Math.abs(out[out.length - 1] - 0.5) < 1e-9, `last sample was ${out[out.length - 1]}`);
});

test('frame count covers the whole signal', () => {
  const stft = new STFT(1024, 256);
  assert.ok(stft.frameCount(5000) * 256 >= 5000);
});

test('hop size must divide the frame size', () => {
  assert.throws(() => new STFT(1024, 300), /hop/i);
});
