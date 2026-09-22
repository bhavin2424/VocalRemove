/**
 * Plays both stems in lockstep through independent gain stages.
 *
 * The two sources are always started in the same call and scheduled to the
 * same clock time, so they cannot drift apart. Position is read back from the
 * audio clock rather than a timer, which keeps the playhead honest even while
 * the main thread is busy with a separation pass.
 */
class StemPlayer {
  constructor(context) {
    this.context = context;
    this.vocalGain = context.createGain();
    this.instrumentalGain = context.createGain();
    this.vocalGain.connect(context.destination);
    this.instrumentalGain.connect(context.destination);
    this.sources = [];
    this.playing = false;
    this.offset = 0;
    this.startedAt = 0;
    this.onEnded = null;
    this.vocalBuffer = null;
    this.instrumentalBuffer = null;
  }

  load(vocalBuffer, instrumentalBuffer) {
    this.stop();
    this.vocalBuffer = vocalBuffer;
    this.instrumentalBuffer = instrumentalBuffer;
    this.offset = 0;
  }

  get duration() {
    return this.vocalBuffer ? this.vocalBuffer.duration : 0;
  }

  get position() {
    if (!this.playing) return this.offset;
    const elapsed = this.context.currentTime - this.startedAt;
    return Math.max(0, Math.min(this.duration, this.offset + elapsed));
  }

  setGains(vocals, instrumental) {
    const now = this.context.currentTime;
    // Ramp rather than step: an instant gain change clicks audibly.
    this.vocalGain.gain.setTargetAtTime(vocals, now, 0.01);
    this.instrumentalGain.gain.setTargetAtTime(instrumental, now, 0.01);
  }

  play() {
    if (!this.vocalBuffer || this.playing) return;
    if (this.context.state === 'suspended') this.context.resume();
    if (this.offset >= this.duration - 0.01) this.offset = 0;

    const vocals = this.context.createBufferSource();
    vocals.buffer = this.vocalBuffer;
    vocals.connect(this.vocalGain);

    const instrumental = this.context.createBufferSource();
    instrumental.buffer = this.instrumentalBuffer;
    instrumental.connect(this.instrumentalGain);

    const at = this.context.currentTime + 0.02;
    vocals.start(at, this.offset);
    instrumental.start(at, this.offset);

    vocals.onended = () => {
      if (!this.playing) return;
      this.stop();
      this.offset = 0;
      if (this.onEnded) this.onEnded();
    };

    this.sources = [vocals, instrumental];
    this.startedAt = at;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    const where = this.position;
    this.stop();
    this.offset = where;
  }

  seek(seconds) {
    const wasPlaying = this.playing;
    this.stop();
    this.offset = Math.max(0, Math.min(this.duration, seconds));
    if (wasPlaying) this.play();
  }

  stop() {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch (error) {
        // Already stopped; nothing to unwind.
      }
    }
    this.sources = [];
    this.playing = false;
  }
}
