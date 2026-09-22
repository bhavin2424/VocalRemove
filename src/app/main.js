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
  targetKey: el('target-key'),
  keyTargetNote: el('key-target-note'),
  factBpm: el('fact-bpm'),
  factDuration: el('fact-duration'),

  strength: el('strength'),
  strengthOut: el('strength-out'),
  pitch: el('pitch'),
  pitchOut: el('pitch-out'),
  pitchWarning: el('pitch-warning'),
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
  rendered: null,    // stems after the pitch and tempo change, what you hear
  key: null,
  tempo: null,
  appliedStrength: null,
  renderedPitch: 0,
  renderedTempo: 100,
};

const MIX_PRESETS = {
  original: { vocals: 1, instrumental: 1 },
  karaoke: { vocals: 0, instrumental: 1 },
  acapella: { vocals: 1, instrumental: 0 },
};

/** Past this many semitones the stretch is far enough to hear. */
const LARGE_SHIFT = 7;

/**
 * Drive a DSP generator without freezing the page.
 *
 * A file:// page cannot spawn a Worker, so the only way to keep the interface alive
 * during a minute of signal processing is to hand control back to the browser every
 * so often. Yielding on elapsed time rather than a fixed step count keeps that
 * responsive whatever the machine's speed.
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

/**
 * The slider reads as "how hard to push"; the engine wants three numbers, and they
 * only make sense moved together.
 *
 * Pushing harder sharpens the mask, takes more of the vocal estimate back out of the
 * backing track, and eases off the protection that holds centre-panned chords in
 * place. That last one is the real cost. Keys and rhythm guitars sit in the middle of
 * the mix exactly where the voice does, so scrubbing the voice harder always takes
 * some of them with it, and this slider is where that trade is made.
 */
function separationOptions() {
  const push = Number(ui.strength.value) / 100;
  return {
    exponent: 1.4 + push * 2.0,
    // Held deliberately short of the point where the subtraction overshoots. Past
    // that the residual crosses through silence and comes back up phase-inverted, so
    // the top of the slider would remove less of the singer than the middle of it.
    overSubtraction: 1 + push * 0.45,
    sustainedSubtraction: 0.75 - push * 0.25,
  };
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
  ui.pitch.value = '0';
  ui.tempo.value = '100';

  await separateCurrent();
  await analyseCurrent();
  populateKeyChoices();
  await renderCurrent();

  ui.trackName.textContent = state.name;
  rememberRenderSettings();
  markPendingChanges();
  showStage('ready');
  applyMix();
}

async function separateCurrent() {
  const { left, right } = state.source;
  const result = await run(
    separateSteps(left, right, state.sampleRate, separationOptions()),
    'Separating the vocals from the backing track'
  );
  state.separated = result;
  state.appliedStrength = Number(ui.strength.value);
  ui.monoNotice.hidden = !result.mono;
}

async function analyseCurrent() {
  ui.progressLabel.textContent = 'Finding the key and tempo';
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Read the key off the backing track: vocal vibrato blurs the chroma.
  const instrumental = state.separated.instrumental;
  const analysis = monoForAnalysis(instrumental.left, instrumental.right, state.sampleRate);
  state.key = detectKey(analysis.samples, analysis.sampleRate);
  state.tempo = detectTempo(analysis.samples, analysis.sampleRate);
}

/** Apply the current pitch shift and tempo, and rebuild everything downstream. */
async function renderCurrent() {
  const semitones = Number(ui.pitch.value);
  const tempoFactor = Number(ui.tempo.value) / 100;
  const stems = state.separated;

  if (semitones === 0 && tempoFactor === 1) {
    state.rendered = { vocals: stems.vocals, instrumental: stems.instrumental };
  } else {
    const label = semitones === 0 ? 'Changing the tempo' : 'Changing the key';
    // Both channels of a stem go through in one call, so the vocoder can rotate them
    // by a single shared phase correction and leave the stereo image where it was.
    const [vocalsL, vocalsR] = await run(
      transformChannelsSteps([stems.vocals.left, stems.vocals.right], semitones, tempoFactor),
      label
    );
    const [instrumentalL, instrumentalR] = await run(
      transformChannelsSteps([stems.instrumental.left, stems.instrumental.right], semitones, tempoFactor),
      label
    );
    state.rendered = {
      vocals: { left: vocalsL, right: vocalsR },
      instrumental: { left: instrumentalL, right: instrumentalR },
    };
  }

  const rate = state.sampleRate;
  const vocalBuffer = toAudioBuffer(state.rendered.vocals.left, state.rendered.vocals.right, rate);
  const instrumentalBuffer = toAudioBuffer(state.rendered.instrumental.left, state.rendered.instrumental.right, rate);

  if (!player) {
    player = new StemPlayer(audioContext());
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

/*
 * Renders are long, and the controls that start one are sliders somebody is dragging.
 * Rather than queue up a render per nudge, a request that arrives mid-render just
 * marks that another is wanted, and the loop picks up the settings as they finally
 * stand once the current pass finishes.
 */
let rendering = false;
let renderWanted = false;

async function requestRender() {
  if (!state.separated) return;
  if (rendering) {
    renderWanted = true;
    return;
  }

  rendering = true;
  const wasPlaying = player && player.playing;
  if (player) player.pause();
  ui.play.textContent = 'Play';

  try {
    do {
      renderWanted = false;
      showStage('working');
      ui.progressBar.style.width = '0%';
      await renderCurrent();
    } while (renderWanted);
  } finally {
    rendering = false;
    rememberRenderSettings();
    markPendingChanges();
    showStage('ready');
    if (wasPlaying) {
      player.play();
      ui.play.textContent = 'Pause';
    }
  }
}

/** Fill the key menu with the twelve tonics of the detected mode. */
function populateKeyChoices() {
  const mode = state.key.mode;
  ui.targetKey.replaceChildren(...keysInMode(mode).map((tonic) => {
    const option = document.createElement('option');
    option.value = tonic;
    option.textContent = `${tonic} ${mode}`;
    return option;
  }));
  syncKeyChoice();
}

/** Point the key menu at whatever key the current pitch shift actually lands on. */
function syncKeyChoice() {
  if (!state.key) return;
  const semitones = Number(ui.pitch.value);
  const landing = semitones === 0
    ? state.key
    : transposeKey(state.key.tonic, state.key.mode, semitones);
  ui.targetKey.value = landing.tonic;
  ui.keyTargetNote.textContent = semitones === 0
    ? 'as recorded'
    : `${semitones > 0 ? 'up' : 'down'} ${Math.abs(semitones)} ` +
      `${Math.abs(semitones) === 1 ? 'semitone' : 'semitones'} from ${state.key.name}`;
}

function paintPitchControl() {
  const semitones = Number(ui.pitch.value);
  const sign = semitones > 0 ? '+' : '';
  const unit = Math.abs(semitones) === 1 ? 'semitone' : 'semitones';
  ui.pitchOut.textContent = `${sign}${semitones} ${unit}`;

  const large = Math.abs(semitones) >= LARGE_SHIFT;
  ui.pitchWarning.hidden = !large;
  ui.pitchWarning.textContent = large
    ? `${Math.abs(semitones)} semitones is a long way to move a recording. The further it ` +
      'goes the more the audio is stretched and resampled, so expect it to soften, and ' +
      'to hear some smearing on drums and cymbals. Smaller shifts hold up better.'
    : '';
}

function paintReadout() {
  const semitones = Number(ui.pitch.value);
  const key = semitones === 0
    ? state.key
    : transposeKey(state.key.tonic, state.key.mode, semitones);

  ui.keyName.textContent = key.name;
  ui.keyConfidence.textContent = semitones === 0
    ? `Detected with ${(state.key.confidence * 100).toFixed(0)}% confidence`
    : `${state.key.name} shifted by ${semitones > 0 ? '+' : ''}${semitones}`;

  ui.scaleRow.replaceChildren(...key.notes.map((note) => {
    const li = document.createElement('li');
    li.textContent = note;
    return li;
  }));

  // The vocoder holds the tempo through a pitch shift, so the BPM only follows the
  // tempo control.
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

/**
 * Only the vocal removal strength needs the Apply button. It changes the separation
 * itself, which means running the whole analysis again; pitch and tempo only restage
 * stems that are already separated, so they apply themselves as soon as the slider
 * is let go.
 */
function markPendingChanges() {
  const changed = state.separated !== null && Number(ui.strength.value) !== state.appliedStrength;
  ui.apply.disabled = !changed;
  ui.applyNote.textContent = changed ? 'Not applied yet' : '';
}

function rememberRenderSettings() {
  state.renderedPitch = Number(ui.pitch.value);
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

// Choosing a key sets the pitch shift that lands on it, taking the shorter of the
// two ways round.
ui.targetKey.addEventListener('change', () => {
  if (!state.key) return;
  ui.pitch.value = String(semitonesBetween(state.key.tonic, ui.targetKey.value));
  paintPitchControl();
  syncKeyChoice();
  requestRender();
});

ui.pitch.addEventListener('input', () => {
  paintPitchControl();
  syncKeyChoice();
});
ui.pitch.addEventListener('change', () => requestRender());

ui.tempo.addEventListener('input', () => {
  ui.tempoOut.textContent = ui.tempo.value + '%';
});
ui.tempo.addEventListener('change', () => requestRender());

ui.strength.addEventListener('input', () => {
  ui.strengthOut.textContent = ui.strength.value;
  markPendingChanges();
});

ui.apply.addEventListener('click', async () => {
  if (!state.source || rendering) return;
  const wasPlaying = player && player.playing;
  if (player) player.pause();
  ui.play.textContent = 'Play';
  showStage('working');
  ui.progressBar.style.width = '0%';

  rendering = true;
  try {
    await separateCurrent();
    await analyseCurrent();
    populateKeyChoices();
    await renderCurrent();
  } finally {
    rendering = false;
    rememberRenderSettings();
    markPendingChanges();
    showStage('ready');
    if (wasPlaying) {
      player.play();
      ui.play.textContent = 'Pause';
    }
  }
});

function stemFilename(suffix) {
  const base = state.name.replace(/\.[^.]+$/, '') || 'track';
  const semitones = Number(ui.pitch.value);
  const key = semitones === 0 ? '' : ` (${transposeKey(state.key.tonic, state.key.mode, semitones).name})`;
  return `${base} - ${suffix}${key}.wav`;
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

paintPitchControl();
rememberRenderSettings();
markPendingChanges();
showStage('idle');
requestAnimationFrame(tick);
