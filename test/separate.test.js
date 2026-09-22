import test from 'node:test';
import assert from 'node:assert/strict';
import { separate } from '../src/dsp/separate.js';

const SR = 44100;
/**
 * Two seconds, not one. The engine judges a bin by how it behaves for about half a
 * second either side, so a one-second clip is almost entirely track edge.
 */
const N = SR * 2;

function mk() {
  return new Float64Array(N);
}

/** A steady sine: what a held synth note or an organ chord looks like. */
function held(freq, amp = 1) {
  const x = mk();
  let phase = 0;
  for (let i = 0; i < N; i++) {
    phase += (2 * Math.PI * freq) / SR;
    x[i] = amp * Math.sin(phase);
  }
  return x;
}

/**
 * A sung line: a harmonic stack that moves between notes and carries vibrato.
 *
 * A dead-steady sine is not a stand-in for a voice. The engine separates the lead
 * by the fact that it moves, so a lead that never moves is, correctly, not a lead.
 */
function sung(amp = 0.5) {
  const x = mk();
  const notes = [329.63, 392.0, 349.23, 440.0];
  const phase = new Float64Array(5);
  let f = notes[0];
  for (let i = 0; i < N; i++) {
    const time = i / SR;
    f += (notes[Math.floor(time * 2) % notes.length] - f) * 0.00012;
    const vib = 1 + 0.015 * Math.sin(2 * Math.PI * 5.5 * time);
    let s = 0;
    for (let h = 1; h <= 4; h++) {
      phase[h] += (2 * Math.PI * f * vib * h) / SR;
      s += (1 / h) * Math.sin(phase[h]);
    }
    x[i] = amp * s;
  }
  return x;
}

/** Broadband hits twice a second: what a drum kit looks like. */
function hits(amp = 0.5) {
  const x = mk();
  let seed = 4242;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const period = Math.round(SR / 2);
  for (let i = 0; i < N; i++) {
    x[i] = amp * Math.exp(-((i % period) / SR) * 40) * rnd();
  }
  return x;
}

function mix(...parts) {
  const x = mk();
  for (const p of parts) for (let i = 0; i < N; i++) x[i] += p[i];
  return x;
}

/**
 * Least-squares gain of `reference` inside `signal`: the fraction of that component
 * which survived. Robust where a single-frequency probe is not, because a moving
 * voice does not sit on one frequency.
 */
function survives(signal, reference) {
  let num = 0;
  let den = 0;
  for (let i = 0; i < signal.length; i++) {
    num += signal[i] * reference[i];
    den += reference[i] * reference[i];
  }
  return den > 0 ? num / den : 0;
}

/** Centre-panned sung lead, hard-left guitar. */
function stereoMix() {
  const lead = sung();
  const guitar = held(1200, 0.5);
  return { left: mix(lead, guitar), right: mix(lead), lead, guitar };
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

test('a sung lead ends up in the vocal stem', () => {
  const { left, right, lead } = stereoMix();
  const r = separate(left, right, SR);

  const kept = survives(r.vocals.left, lead);
  assert.ok(kept > 0.55, `only ${(kept * 100).toFixed(0)}% of the lead survived in the vocal stem`);
});

test('a sung lead is suppressed in the backing track', () => {
  const { left, right, lead } = stereoMix();
  const r = separate(left, right, SR);

  const leak = survives(r.instrumental.left, lead);
  assert.ok(leak < 0.45, `lead leaked into the backing track at ${(leak * 100).toFixed(0)}%`);
});

test('a hard-panned guitar is suppressed in the vocal stem', () => {
  const { left, right, guitar } = stereoMix();
  const r = separate(left, right, SR);

  const leak = survives(r.vocals.left, guitar);
  assert.ok(leak < 0.15, `guitar leaked into the vocal stem at ${(leak * 100).toFixed(0)}%`);
});

test('a hard-panned guitar is kept in the backing track', () => {
  const { left, right, guitar } = stereoMix();
  const r = separate(left, right, SR);

  const kept = survives(r.instrumental.left, guitar);
  assert.ok(kept > 0.85, `only ${(kept * 100).toFixed(0)}% of the guitar survived in the backing track`);
});

test('centre-panned bass stays in the backing track instead of following the lead', () => {
  const bass = held(60, 0.5);
  const lead = sung();
  const both = mix(bass, lead);
  const r = separate(both, Float64Array.from(both), SR);

  assert.ok(survives(r.vocals.left, bass) < 0.15, 'bass leaked into the vocal stem');
  assert.ok(survives(r.instrumental.left, bass) > 0.85, 'bass was lost from the backing track');
});

test('a held centre-panned chord stays in the backing track', () => {
  // The case that makes a karaoke track sound hollow. Keys and pads sit dead centre
  // exactly like the voice, so nothing about stereo position tells them apart, and an
  // engine that goes by position alone strips the chords out along with the singer.
  const chord = mix(held(261.63, 0.3), held(329.63, 0.3), held(392.0, 0.3));
  const lead = sung();
  const left = mix(chord, lead);
  const right = mix(chord, lead);
  const r = separate(left, right, SR);

  // Around half survives at the default setting, against roughly a tenth for an
  // engine that goes by stereo position alone. How much is kept is a deliberate
  // trade against how much of the voice is removed, and the split strength control
  // is what moves it.
  const kept = survives(r.instrumental.left, chord);
  assert.ok(kept > 0.45, `only ${(kept * 100).toFixed(0)}% of the held chord survived the separation`);
});

test('centre-panned drums stay in the backing track', () => {
  const drums = hits();
  const lead = sung();
  const both = mix(drums, lead);
  const r = separate(both, Float64Array.from(both), SR);

  const kept = survives(r.instrumental.left, drums);
  assert.ok(kept > 0.85, `only ${(kept * 100).toFixed(0)}% of the drums survived the separation`);
});

test('over-subtraction pushes a stubborn lead further out of the backing track', () => {
  // A lead with a little stereo width, the way any real vocal has once there is
  // reverb on it. It is never fully captured, so a residual is always left behind,
  // and over-subtraction is the control that scrubs it down.
  const lead = sung();
  const chord = mix(held(261.63, 0.3), held(392.0, 0.3));
  const wideL = mk();
  const wideR = mk();
  const dl = Math.round(0.013 * SR);
  const dr = Math.round(0.019 * SR);
  for (let i = 0; i < N; i++) {
    wideL[i] = lead[i] + (i >= dl ? 0.18 * lead[i - dl] : 0) + chord[i];
    wideR[i] = lead[i] + (i >= dr ? 0.18 * lead[i - dr] : 0) + chord[i];
  }

  const plain = separate(wideL, wideR, SR);
  const harder = separate(wideL, wideR, SR, { overSubtraction: 1.4 });

  const before = Math.abs(survives(plain.instrumental.left, lead));
  const after = Math.abs(survives(harder.instrumental.left, lead));
  assert.ok(after < before, `over-subtraction did not reduce the residual: ${before.toFixed(3)} -> ${after.toFixed(3)}`);
});

test('at the default setting the stems still sum back exactly', () => {
  // Over-subtraction is what trades that guarantee away, so it must be off unless
  // it is asked for.
  const { left, right } = stereoMix();
  const r = separate(left, right, SR);
  let worst = 0;
  for (let i = 0; i < N; i++) {
    worst = Math.max(worst, Math.abs(r.vocals.right[i] + r.instrumental.right[i] - right[i]));
  }
  assert.ok(worst < 1e-6, `default settings broke the sum guarantee, worst error ${worst}`);
});

test('a mono track is reported as mono rather than silently yielding an empty stem', () => {
  const same = mix(sung(), held(1200, 0.5));
  const r = separate(same, Float64Array.from(same), SR);

  assert.equal(r.mono, true);
});

test('a genuine stereo track is not reported as mono', () => {
  const { left, right } = stereoMix();
  assert.equal(separate(left, right, SR).mono, false);
});
