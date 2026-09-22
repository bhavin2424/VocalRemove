import test from 'node:test';
import assert from 'node:assert/strict';
import { detectKey, detectTempo, scaleNotes } from '../src/dsp/analyze.js';

const SR = 22050;
const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Render a sequence of chords, one second each, as summed sine tones. */
function renderChords(chords, seconds = 1) {
  const per = Math.round(SR * seconds);
  const out = new Float64Array(per * chords.length);
  chords.forEach((chord, ci) => {
    for (const midi of chord) {
      const f = midiToHz(midi);
      for (let i = 0; i < per; i++) {
        // Fade each chord in and out so onsets do not smear across the chroma.
        const env = Math.sin((Math.PI * i) / per);
        out[ci * per + i] += (0.3 * env * Math.sin((2 * Math.PI * f * i) / SR)) / chord.length;
      }
    }
  });
  return out;
}

/** A click track: one short decaying burst per beat. */
function clickTrack(bpm, seconds = 8) {
  const out = new Float64Array(SR * seconds);
  const period = (60 / bpm) * SR;
  for (let beat = 0; beat * period < out.length; beat++) {
    const start = Math.round(beat * period);
    for (let i = 0; i < 400 && start + i < out.length; i++) {
      out[start + i] = Math.exp(-i / 60) * Math.sin((2 * Math.PI * 1800 * i) / SR);
    }
  }
  return out;
}

test('identifies a G major progression as G major', () => {
  // G - C - D - G
  const audio = renderChords([[55, 59, 62], [60, 64, 67], [62, 66, 69], [55, 59, 62]]);
  const key = detectKey(audio, SR);
  assert.equal(key.name, 'G major');
});

test('identifies a C major progression as C major', () => {
  // C - F - G - C
  const audio = renderChords([[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]]);
  const key = detectKey(audio, SR);
  assert.equal(key.name, 'C major');
});

test('identifies an A minor progression as A minor', () => {
  // Am - Dm - Em - Am
  const audio = renderChords([[57, 60, 64], [62, 65, 69], [64, 67, 71], [57, 60, 64]]);
  const key = detectKey(audio, SR);
  assert.equal(key.name, 'A minor');
});

test('reports runner-up keys alongside the winner', () => {
  const audio = renderChords([[55, 59, 62], [60, 64, 67], [62, 66, 69], [55, 59, 62]]);
  const key = detectKey(audio, SR);
  assert.ok(key.alternatives.length >= 2);
  assert.ok(key.confidence > 0 && key.confidence <= 1);
});

test('finds 120 BPM in a 120 BPM click track', () => {
  const bpm = detectTempo(clickTrack(120), SR).bpm;
  assert.ok(Math.abs(bpm - 120) < 2, `got ${bpm}`);
});

test('finds 90 BPM in a 90 BPM click track', () => {
  const bpm = detectTempo(clickTrack(90), SR).bpm;
  assert.ok(Math.abs(bpm - 90) < 2, `got ${bpm}`);
});

test('does not fall for the half-time octave error', () => {
  const bpm = detectTempo(clickTrack(140), SR).bpm;
  assert.ok(Math.abs(bpm - 140) < 3, `got ${bpm}, likely a 70 BPM octave error`);
});

test('spells the G major scale with an F sharp', () => {
  assert.deepEqual(scaleNotes('G', 'major'), ['G', 'A', 'B', 'C', 'D', 'E', 'F#']);
});

test('spells the A minor scale with no accidentals', () => {
  assert.deepEqual(scaleNotes('A', 'minor'), ['A', 'B', 'C', 'D', 'E', 'F', 'G']);
});

test('spells F major with a B flat rather than an A sharp', () => {
  assert.deepEqual(scaleNotes('F', 'major'), ['F', 'G', 'A', 'Bb', 'C', 'D', 'E']);
});

test('transposing G major up two semitones gives A major', async () => {
  const { transposeKey } = await import('../src/dsp/analyze.js');
  const key = transposeKey('G', 'major', 2);
  assert.equal(key.name, 'A major');
  assert.deepEqual(key.notes, ['A', 'B', 'C#', 'D', 'E', 'F#', 'G#']);
});

test('transposing down a semitone from G major gives F# major', async () => {
  const { transposeKey } = await import('../src/dsp/analyze.js');
  assert.equal(transposeKey('G', 'major', -1).name, 'Gb major');
});

test('transposing by an octave comes back to the same key', async () => {
  const { transposeKey } = await import('../src/dsp/analyze.js');
  assert.equal(transposeKey('A', 'minor', 12).name, 'A minor');
});
