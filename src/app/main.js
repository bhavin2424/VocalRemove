const el = (id) => document.getElementById(id);

const ui = {
  dropzone: el('dropzone'),
  dropError: el('drop-error'),
  fileInput: el('file-input'),
  openFile: el('open-file'),

  progressPanel: el('progress-panel'),
  progressLabel: el('progress-label'),
  progressBar: el('progress-bar'),

  workspace: el('workspace'),
  monoNotice: el('mono-notice'),
  waveform: el('waveform'),
  play: el('play'),
  time: el('time'),
  trackName: el('track-name'),

  faderVocals: el('fader-vocals'),
  faderInstrumental: el('fader-instrumental'),
  valueVocals: el('value-vocals'),
  valueInstrumental: el('value-instrumental'),
  muteVocals: el('mute-vocals'),
  muteInstrumental: el('mute-instrumental'),
  presets: Array.from(document.querySelectorAll('.preset')),

  keyName: el('key-name'),
  keyConfidence: el('key-confidence'),
  scaleRow: el('scale-row'),
  factBpm: el('fact-bpm'),
  factDuration: el('fact-duration'),

  strength: el('strength'),
  strengthOut: el('strength-out'),
  transpose: el('transpose'),
  transposeOut: el('transpose-out'),
  tempo: el('tempo'),
  tempoOut: el('tempo-out'),
  apply: el('apply'),
  applyNote: el('apply-note'),

  downloadVocals: el('download-vocals'),
  downloadInstrumental: el('download-instrumental'),
  downloadMix: el('download-mix'),
};

const view = new WaveformView(ui.waveform);
let player = null;

const state = {
  name: '',
  sampleRate: 44100,
  source: null,      // the decoded original, as stereo floats
  separated: null,   // stems straight out of the separator
  rendered: null,    // stems after transpose and tempo, what you hear
  key: null,
  appliedStrength: 2,
};

const MIX_PRESETS = {
  original: { vocals: 1, instrumental: 1 },
  karaoke: { vocals: 0, instrumental: 1 },
  acapella: { vocals: 1, instrumental: 0 },
};

/**
 * Drive a DSP generator without freezing the page.
 *
 * A file:// page cannot spawn a Worker, so the only way to keep the interface
 * alive during a minute of signal processing is to hand control back to the
 * browser every so often. Yielding on elapsed time rather than a fixed step
 * count keeps that responsive whatever the machine's speed.
 */
async function run(steps, label) {
  ui.progressLabel.textContent = label;
  let step = steps.next();
  let lastBreak = performance.now();
  while (!step.done) {
    if (typeof step.value === 'number') {
      ui.progressBar.style.width = (step.value * 100).toFixed(1) + '%';
    }
    if (performance.now() - lastBreak > 40) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      lastBreak = performance.now();
    }
    step = steps.next();
  }
  ui.progressBar.style.width = '100%';
  return step.value;
}

function showStage(stage) {
  ui.dropzone.hidden = stage !== 'idle';
  ui.progressPanel.hidden = stage !== 'working';
  ui.workspace.hidden = stage !== 'ready';
}

function separationOptions() {
  // The slider reads as "how hard to push"; the engine wants a mask exponent.
  return { exponent: 1 + Number(ui.strength.value) * 0.04 };
}

async function loadFile(file) {
  ui.dropError.textContent = '';
  showStage('working');
  ui.progressBar.style.width = '0%';
  ui.progressLabel.textContent = 'Reading the file';

  let buffer;
  try {
    buffer = await decodeFile(file);
  } catch (error) {
    showStage('idle');
    ui.dropError.textContent = 'That file could not be decoded. Try an MP3, WAV, FLAC, M4A or OGG.';
    return;
  }

  state.name = file.name;
  state.sampleRate = buffer.sampleRate;
  state.source = toStereo(buffer);

  await separateCurrent();
  await analyseCurrent();
  await renderCurrent();

  ui.trackName.textContent = state.name;
  showStage('ready');
  applyMix();
}

async function separateCurrent() {
  const { left, right } = state.source;
  const result = await run(
    separateSteps(left, right, state.sampleRate, separationOptions()),
    'Separating vocals from the backing track'
  );
  state.separated = result;
  state.appliedStrength = Number(ui.strength.value);
  ui.monoNotice.hidden = !result.mono;
}

async function analyseCurrent() {
  ui.progressLabel.textContent = 'Finding the key and tempo';
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Read the key off the instrumental: vocal vibrato blurs the chroma.
  const instrumental = state.separated.instrumental;
  const analysis = monoForAnalysis(instrumental.left, instrumental.right, state.sampleRate);
  state.key = detectKey(analysis.samples, analysis.sampleRate);
  state.tempo = detectTempo(analysis.samples, analysis.sampleRate);
}

/** Apply the current transpose and tempo, and rebuild everything downstream. */
async function renderCurrent() {
  const semitones = Number(ui.transpose.value);
  const tempoFactor = Number(ui.tempo.value) / 100;
  const stems = state.separated;

  if (semitones === 0 && tempoFactor === 1) {
    state.rendered = { vocals: stems.vocals, instrumental: stems.instrumental };
  } else {
    const label = 'Transposing and stretching';
    const vocals = {
      left: await run(transformSteps(stems.vocals.left, semitones, tempoFactor), label),
      right: await run(transformSteps(stems.vocals.right, semitones, tempoFactor), label),
    };
    const instrumental = {
      left: await run(transformSteps(stems.instrumental.left, semitones, tempoFactor), label),
      right: await run(transformSteps(stems.instrumental.right, semitones, tempoFactor), label),
    };
    state.rendered = { vocals, instrumental };
  }

  const rate = state.sampleRate;
  const vocalBuffer = toAudioBuffer(state.rendered.vocals.left, state.rendered.vocals.right, rate);
  const instrumentalBuffer = toAudioBuffer(state.rendered.instrumental.left, state.rendered.instrumental.right, rate);

  if (!player) {
    player = new StemPlayer(vocalBuffer.context || audioContext());
    player.onEnded = () => {
      ui.play.textContent = 'Play';
      view.setPosition(0);
      updateClock();
    };
  }
  player.load(vocalBuffer, instrumentalBuffer);

  view.resize();
  const columns = Math.max(200, Math.floor(view.width));
  view.setPeaks(
    computePeaks(state.rendered.vocals.left, state.rendered.vocals.right, columns),
    computePeaks(state.rendered.instrumental.left, state.rendered.instrumental.right, columns),
    player.duration
  );

  paintReadout();
  updateClock();
  applyMix();
}

function paintReadout() {
  const semitones = Number(ui.transpose.value);
  const key = semitones === 0
    ? state.key
    : transposeKey(state.key.tonic, state.key.mode, semitones);

  ui.keyName.textContent = key.name;
  ui.keyConfidence.textContent = semitones === 0
    ? `Detected with ${(state.key.confidence * 100).toFixed(0)}% confidence`
    : `${state.key.name} transposed by ${semitones > 0 ? '+' : ''}${semitones}`;

  ui.scaleRow.replaceChildren(...key.notes.map((note) => {
    const li = document.createElement('li');
    li.textContent = note;
    return li;
  }));

  const bpm = state.tempo.bpm * (Number(ui.tempo.value) / 100);
  ui.factBpm.textContent = bpm.toFixed(0);
  ui.factDuration.textContent = formatTime(player ? player.duration : 0);
}

function applyMix() {
  if (!player) return;
  const vocals = ui.muteVocals.getAttribute('aria-pressed') === 'true'
    ? 0 : Number(ui.faderVocals.value) / 100;
  const instrumental = ui.muteInstrumental.getAttribute('aria-pressed') === 'true'
    ? 0 : Number(ui.faderInstrumental.value) / 100;
  player.setGains(vocals, instrumental);
  ui.valueVocals.textContent = Math.round(vocals * 100) + '%';
  ui.valueInstrumental.textContent = Math.round(instrumental * 100) + '%';
}

function updateClock() {
  if (!player) return;
  ui.time.textContent = formatTime(player.position) + ' / ' + formatTime(player.duration);
}

function tick() {
  if (player && player.playing) {
    view.setPosition(player.position);
    updateClock();
  }
  requestAnimationFrame(tick);
}

function markPendingChanges() {
  const changed =
    Number(ui.strength.value) !== state.appliedStrength ||
    Number(ui.transpose.value) !== state.renderedTranspose ||
    Number(ui.tempo.value) !== state.renderedTempo;
  ui.apply.disabled = !changed;
  ui.applyNote.textContent = changed ? 'Not applied yet' : '';
}

function rememberRenderSettings() {
  state.renderedTranspose = Number(ui.transpose.value);
  state.renderedTempo = Number(ui.tempo.value);
}

/* ---------- wiring ---------- */

ui.openFile.addEventListener('click', () => ui.fileInput.click());
ui.fileInput.addEventListener('change', () => {
  if (ui.fileInput.files[0]) loadFile(ui.fileInput.files[0]);
});

for (const event of ['dragenter', 'dragover']) {
  ui.dropzone.addEventListener(event, (e) => {
    e.preventDefault();
    ui.dropzone.classList.add('is-over');
  });
}
for (const event of ['dragleave', 'drop']) {
  ui.dropzone.addEventListener(event, () => ui.dropzone.classList.remove('is-over'));
}
ui.dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file) loadFile(file);
});
ui.dropzone.addEventListener('click', () => ui.fileInput.click());

ui.play.addEventListener('click', () => {
  if (!player) return;
  if (player.playing) {
    player.pause();
    ui.play.textContent = 'Play';
  } else {
    player.play();
    ui.play.textContent = 'Pause';
  }
  updateClock();
});

ui.waveform.addEventListener('click', (e) => {
  if (!player) return;
  const bounds = ui.waveform.getBoundingClientRect();
  player.seek(view.timeAt(e.clientX - bounds.left));
  view.setPosition(player.position);
  updateClock();
});

for (const fader of [ui.faderVocals, ui.faderInstrumental]) {
  fader.addEventListener('input', () => {
    ui.presets.forEach((p) => p.setAttribute('aria-pressed', 'false'));
    applyMix();
  });
}

for (const button of [ui.muteVocals, ui.muteInstrumental]) {
  button.addEventListener('click', () => {
    const on = button.getAttribute('aria-pressed') === 'true';
    button.setAttribute('aria-pressed', String(!on));
    applyMix();
  });
}

for (const preset of ui.presets) {
  preset.addEventListener('click', () => {
    const mix = MIX_PRESETS[preset.dataset.preset];
    ui.faderVocals.value = String(mix.vocals * 100);
    ui.faderInstrumental.value = String(mix.instrumental * 100);
    ui.muteVocals.setAttribute('aria-pressed', 'false');
    ui.muteInstrumental.setAttribute('aria-pressed', 'false');
    ui.presets.forEach((p) => p.setAttribute('aria-pressed', String(p === preset)));
    applyMix();
  });
}

ui.strength.addEventListener('input', () => {
  ui.strengthOut.textContent = ui.strength.value;
  markPendingChanges();
});
ui.transpose.addEventListener('input', () => {
  const v = Number(ui.transpose.value);
  ui.transposeOut.textContent = v > 0 ? '+' + v : String(v);
  markPendingChanges();
});
ui.tempo.addEventListener('input', () => {
  ui.tempoOut.textContent = ui.tempo.value + '%';
  markPendingChanges();
});

ui.apply.addEventListener('click', async () => {
  const wasPlaying = player && player.playing;
  if (player) player.pause();
  ui.play.textContent = 'Play';
  showStage('working');
  ui.progressBar.style.width = '0%';

  if (Number(ui.strength.value) !== state.appliedStrength) {
    await separateCurrent();
    await analyseCurrent();
  }
  await renderCurrent();
  rememberRenderSettings();
  markPendingChanges();
  showStage('ready');
  if (wasPlaying) {
    player.play();
    ui.play.textContent = 'Pause';
  }
});

function stemFilename(suffix) {
  const base = state.name.replace(/\.[^.]+$/, '') || 'track';
  return `${base} - ${suffix}.wav`;
}

ui.downloadVocals.addEventListener('click', () => {
  const s = state.rendered.vocals;
  downloadBytes(encodeWav([s.left, s.right], state.sampleRate), stemFilename('vocals'));
});
ui.downloadInstrumental.addEventListener('click', () => {
  const s = state.rendered.instrumental;
  downloadBytes(encodeWav([s.left, s.right], state.sampleRate), stemFilename('instrumental'));
});
ui.downloadMix.addEventListener('click', () => {
  const vocalLevel = ui.muteVocals.getAttribute('aria-pressed') === 'true'
    ? 0 : Number(ui.faderVocals.value) / 100;
  const instrumentalLevel = ui.muteInstrumental.getAttribute('aria-pressed') === 'true'
    ? 0 : Number(ui.faderInstrumental.value) / 100;
  const { vocals, instrumental } = state.rendered;
  const left = new Float64Array(vocals.left.length);
  const right = new Float64Array(vocals.right.length);
  for (let i = 0; i < left.length; i++) {
    left[i] = vocals.left[i] * vocalLevel + instrumental.left[i] * instrumentalLevel;
    right[i] = vocals.right[i] * vocalLevel + instrumental.right[i] * instrumentalLevel;
  }
  downloadBytes(encodeWav([left, right], state.sampleRate), stemFilename('mix'));
});

window.addEventListener('resize', () => {
  if (!ui.workspace.hidden && state.rendered) {
    view.resize();
    view.draw();
  }
});

rememberRenderSettings();
markPendingChanges();
showStage('idle');
requestAnimationFrame(tick);
