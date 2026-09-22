/**
 * The mirrored stem view: vocals above the centre line, instrumental below,
 * sharing one timeline and one playhead.
 *
 * Seeing both stems as a single shape is the point of this screen, so it gets
 * the space and nothing around it competes for attention.
 */
class WaveformView {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.vocalPeaks = null;
    this.instrumentalPeaks = null;
    this.position = 0;
    this.duration = 1;
    this.width = 0;
    this.height = 0;
    this.colours = {
      vocals: '#e8a33d',
      instrumental: '#4fb9a5',
      axis: '#33424f',
      playhead: '#e6edf3',
    };
  }

  /** Match the backing store to the CSS size so the lines stay crisp. */
  resize() {
    const ratio = window.devicePixelRatio || 1;
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  setPeaks(vocalPeaks, instrumentalPeaks, duration) {
    this.vocalPeaks = vocalPeaks;
    this.instrumentalPeaks = instrumentalPeaks;
    this.duration = duration || 1;
    this.draw();
  }

  setPosition(seconds) {
    this.position = seconds;
    this.draw();
  }

  /** Seconds at a given x offset, for click-to-seek. */
  timeAt(x) {
    if (!this.width) return 0;
    return Math.max(0, Math.min(this.duration, (x / this.width) * this.duration));
  }

  draw() {
    if (!this.width) this.resize();
    const ctx = this.context;
    const axis = this.height / 2;

    ctx.clearRect(0, 0, this.width, this.height);

    ctx.strokeStyle = this.colours.axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, axis + 0.5);
    ctx.lineTo(this.width, axis + 0.5);
    ctx.stroke();

    if (!this.vocalPeaks) return;
    this.drawHalf(this.vocalPeaks, axis, -1, this.colours.vocals);
    this.drawHalf(this.instrumentalPeaks, axis, 1, this.colours.instrumental);

    const x = (this.position / this.duration) * this.width;
    ctx.strokeStyle = this.colours.playhead;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, this.height);
    ctx.stroke();
  }

  drawHalf(peaks, axis, direction, colour) {
    const ctx = this.context;
    const usable = this.height / 2 - 6;
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(0, axis);
    for (let c = 0; c < peaks.length; c++) {
      const x = (c / peaks.length) * this.width;
      ctx.lineTo(x, axis + direction * peaks[c] * usable);
    }
    ctx.lineTo(this.width, axis);
    ctx.closePath();
    ctx.fill();
  }
}
