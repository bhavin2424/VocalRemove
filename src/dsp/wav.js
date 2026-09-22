/**
 * Encode float channels as a 16-bit PCM WAV file.
 *
 * Written by hand rather than pulled from a library so the built page stays a
 * single self-contained file with no dependencies to inline.
 */
export function encodeWav(channels, sampleRate) {
  if (!channels || channels.length === 0) {
    throw new Error('encodeWav needs at least one channel');
  }

  const channelCount = channels.length;
  const frames = channels[0].length;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frames * blockAlign;

  const bytes = new Uint8Array(44 + dataSize);
  const view = new DataView(bytes.buffer);

  const writeAscii = (offset, text) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, 'WAVE');

  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);             // fmt chunk size
  view.setUint16(20, 1, true);              // uncompressed PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);             // bits per sample

  writeAscii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      const raw = channels[c][i] || 0;
      const clamped = raw > 1 ? 1 : raw < -1 ? -1 : raw;
      // Negative range reaches one step further than positive in two's complement.
      view.setInt16(offset, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  }

  return bytes;
}
