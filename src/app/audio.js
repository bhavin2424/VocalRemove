/** Shared AudioContext, created lazily so the page does not open one on load. */
let sharedContext = null;
function audioContext() {
  if (!sharedContext) sharedContext = new (window.AudioContext || window.webkitAudioContext)();
  return sharedContext;
}

/** Decode any format the browser can read into an AudioBuffer. */
async function decodeFile(file) {
  const bytes = await file.arrayBuffer();
  return await audioContext().decodeAudioData(bytes);
}

/**
 * Pull a buffer apart into two Float64Array channels.
 *
 * A mono file is widened into two identical channels so that everything
 * downstream only ever has to deal with stereo.
 */
function toStereo(buffer) {
  const left = Float64Array.from(buffer.getChannelData(0));
  const right = buffer.numberOfChannels > 1
    ? Float64Array.from(buffer.getChannelData(1))
    : Float64Array.from(left);
  return { left, right };
}

/** Build a playable AudioBuffer from a pair of float channels. */
function toAudioBuffer(left, right, sampleRate) {
  const buffer = audioContext().createBuffer(2, left.length, sampleRate);
  buffer.copyToChannel(Float32Array.from(left), 0);
  buffer.copyToChannel(Float32Array.from(right), 1);
  return buffer;
}

/**
 * Sum to mono and decimate, for analysis only.
 *
 * Key and tempo detection need nothing above about 3 kHz, so running them at a
 * quarter of the sample rate cuts the work fourfold and changes no answer.
 * Averaging each group of samples is a crude anti-alias filter, which is all
 * this needs.
 */
function monoForAnalysis(left, right, sampleRate, targetRate = 11025) {
  const factor = Math.max(1, Math.round(sampleRate / targetRate));
  const outLength = Math.floor(left.length / factor);
  const out = new Float64Array(outLength);
  for (let i = 0; i < outLength; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) {
      const s = i * factor + j;
      sum += (left[s] + right[s]) * 0.5;
    }
    out[i] = sum / factor;
  }
  return { samples: out, sampleRate: sampleRate / factor };
}

/** Peak envelope per pixel column, for waveform drawing. */
function computePeaks(left, right, columns) {
  const peaks = new Float32Array(columns);
  const perColumn = Math.max(1, Math.floor(left.length / columns));
  for (let c = 0; c < columns; c++) {
    const start = c * perColumn;
    const end = Math.min(left.length, start + perColumn);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const v = Math.abs(left[i]) + Math.abs(right[i]);
      if (v > peak) peak = v;
    }
    peaks[c] = Math.min(1, peak / 2);
  }
  return peaks;
}

function formatTime(seconds) {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return Math.floor(safe / 60) + ':' + String(safe % 60).padStart(2, '0');
}

/** Hand the browser a file to save, without leaving the page. */
function downloadBytes(bytes, filename) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
