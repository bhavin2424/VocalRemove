import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../src/dsp/wav.js';

const ascii = (bytes, at, len) => String.fromCharCode(...bytes.slice(at, at + len));
const u32 = (b, at) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24);
const u16 = (b, at) => b[at] | (b[at + 1] << 8);
const i16 = (b, at) => (u16(b, at) << 16) >> 16;

test('writes a RIFF/WAVE container with fmt and data chunks', () => {
  const bytes = encodeWav([new Float64Array(10)], 44100);
  assert.equal(ascii(bytes, 0, 4), 'RIFF');
  assert.equal(ascii(bytes, 8, 4), 'WAVE');
  assert.equal(ascii(bytes, 12, 4), 'fmt ');
  assert.equal(ascii(bytes, 36, 4), 'data');
});

test('records the channel count, sample rate and bit depth', () => {
  const bytes = encodeWav([new Float64Array(10), new Float64Array(10)], 48000);
  assert.equal(u16(bytes, 20), 1, 'format should be uncompressed PCM');
  assert.equal(u16(bytes, 22), 2, 'channel count');
  assert.equal(u32(bytes, 24), 48000, 'sample rate');
  assert.equal(u16(bytes, 34), 16, 'bits per sample');
});

test('byte rate and block align match the format', () => {
  const bytes = encodeWav([new Float64Array(4), new Float64Array(4)], 44100);
  assert.equal(u32(bytes, 28), 44100 * 2 * 2, 'byte rate');
  assert.equal(u16(bytes, 32), 4, 'block align');
});

test('chunk sizes agree with the actual byte length', () => {
  const frames = 100;
  const bytes = encodeWav([new Float64Array(frames), new Float64Array(frames)], 44100);
  const dataSize = frames * 2 * 2;
  assert.equal(bytes.length, 44 + dataSize);
  assert.equal(u32(bytes, 40), dataSize, 'data chunk size');
  assert.equal(u32(bytes, 4), bytes.length - 8, 'RIFF chunk size');
});

test('interleaves the channels', () => {
  const left = Float64Array.from([1, 1, 1]);
  const right = Float64Array.from([-1, -1, -1]);
  const bytes = encodeWav([left, right], 44100);
  assert.equal(i16(bytes, 44), 32767, 'first sample should come from the left channel');
  assert.equal(i16(bytes, 46), -32768, 'second sample should come from the right channel');
});

test('samples survive the round trip', () => {
  const input = Float64Array.from([0, 0.5, -0.5, 0.25]);
  const bytes = encodeWav([input], 44100);
  for (let i = 0; i < input.length; i++) {
    const decoded = i16(bytes, 44 + i * 2) / 32767;
    assert.ok(Math.abs(decoded - input[i]) < 1e-4, `sample ${i}: ${decoded} vs ${input[i]}`);
  }
});

test('clamps out-of-range samples instead of wrapping them around', () => {
  const bytes = encodeWav([Float64Array.from([3, -3])], 44100);
  assert.equal(i16(bytes, 44), 32767);
  assert.equal(i16(bytes, 46), -32768);
});

test('rejects an empty channel list', () => {
  assert.throws(() => encodeWav([], 44100), /channel/i);
});
