import test from 'node:test';
import assert from 'node:assert/strict';
import { separate } from '../src/dsp/separate.js';

const SR = 44100;
const DURATION = 1;
const N = SR * DURATION;

/** A sine of the given frequency and amplitude. */
function tone(freq, amp = 1) {
  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

function mix(...parts) {
  const x = new Float64Array(N);
  for (const p of parts) for (let i = 0; i < N; i++) x[i] += p[i];
  return x;
}

/** Amplitude of the component at `freq`, measured by complex correlation. */
function ampAt(x, freq) {
  let re = 0, im = 0;
  for (let i = 0; i < x.length; i++) {
    const p = (2 * Math.PI * freq * i) / SR;
    re += x[i] * Math.cos(p);
    im += x[i] * Math.sin(p);
  }
  return (2 * Math.hypot(re, im)) / x.length;
}

/** Centre-panned lead at 441 Hz, hard-left guitar at 1200 Hz. */
function stereoMix() {
  const vocal = tone(441, 0.5);
  const guitar = tone(1200, 0.5);
  return { left: mix(vocal, guitar), right: mix(vocal), vocal, guitar };
}

test('the two stems sum back to the original signal', () => {
  const { left, right } = stereoMix();
  const r = separate(left, right, SR);

  let worst = 0;
  for (let i = 0; i < N; i++) {
    worst = Math.max(worst, Math.abs(r.vocals.left[i] + r.instrumental.left[i] - left[i]));
    worst = Math.max(worst, Math.abs(r.vocals.right[i] + r.instrumental.right[i] - right[i]));
  }
  assert.ok(worst < 1e-6, `stems did not sum back to the original, worst error ${worst}`);
});

test('a centre-panned lead ends up in the vocal stem', () => {
  const { left, right } = stereoMix();
  const r = separate(left, right, SR);

  const kept = ampAt(r.vocals.left, 441) / ampAt(left, 441);
  assert.ok(kept > 0.8, `only ${(kept * 100).toFixed(0)}% of the lead survived in the vocal stem`);
});

test('a hard-panned guitar is suppressed in the vocal stem', () => {
  const { left, right } = stereoMix();
  const r = separate(left, right, SR);

  const leak = ampAt(r.vocals.left, 1200) / ampAt(left, 1200);
  assert.ok(leak < 0.15, `guitar leaked into the vocal stem at ${(leak * 100).toFixed(0)}%`);
});

test('a hard-panned guitar is kept in the instrumental stem', () => {
  const { left, right } = stereoMix();
  const r = separate(left, right, SR);

  const kept = ampAt(r.instrumental.left, 1200) / ampAt(left, 1200);
  assert.ok(kept > 0.8, `only ${(kept * 100).toFixed(0)}% of the guitar survived in the instrumental`);
});

test('a centre-panned lead is suppressed in the instrumental stem', () => {
  const { left, right } = stereoMix();
  const r = separate(left, right, SR);

  const leak = ampAt(r.instrumental.left, 441) / ampAt(left, 441);
  assert.ok(leak < 0.25, `lead leaked into the instrumental at ${(leak * 100).toFixed(0)}%`);
});

test('centre-panned bass stays in the instrumental instead of following the vocal', () => {
  const bass = tone(60, 0.5);
  const lead = tone(441, 0.5);
  const left = mix(bass, lead);
  const right = mix(bass, lead);
  const r = separate(left, right, SR);

  const inVocals = ampAt(r.vocals.left, 60) / ampAt(left, 60);
  const inInstrumental = ampAt(r.instrumental.left, 60) / ampAt(left, 60);
  assert.ok(inVocals < 0.15, `bass leaked into the vocal stem at ${(inVocals * 100).toFixed(0)}%`);
  assert.ok(inInstrumental > 0.85, `bass was lost from the instrumental, only ${(inInstrumental * 100).toFixed(0)}%`);
});

test('a mono track is reported as mono rather than silently yielding an empty stem', () => {
  const same = mix(tone(441, 0.5), tone(1200, 0.5));
  const r = separate(same, Float64Array.from(same), SR);

  assert.equal(r.mono, true);
});

test('a genuine stereo track is not reported as mono', () => {
  const { left, right } = stereoMix();
  assert.equal(separate(left, right, SR).mono, false);
});
