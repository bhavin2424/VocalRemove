# Splitkit

Splits a song into a vocal stem and a backing track, finds its key and tempo,
and moves it to whatever key you want to sing in. Runs entirely in the browser
with no network access, no server and no dependencies.

## Using it

Open `dist/vocal-remover.html` in Chrome or Edge. That one file is the whole
application; it works offline and can be copied anywhere.

Drop in a song, wait for the separation pass, then use the faders or the
Karaoke preset to mix, and the Download buttons to save WAVs.

Pick a key from the **Play in** menu to move the song there, or drag the
**Pitch shift** slider to move it by ear, anywhere from twelve semitones down
to twelve up. Either way the tempo stays exactly where it was; the Tempo slider
is what changes that, and it leaves the pitch alone in turn. Both apply as soon
as you let go of the control.

## Building

    npm run build      # regenerate dist/vocal-remover.html from src/
    npm test           # run the DSP test suite

Sources live under `src/`; the build inlines them into the single HTML file.
It emits a classic script rather than a module because Chrome refuses to load
`<script type="module">` over `file://`.

## How the separation works

The mix is read as mid and side rather than left and right, and every frequency
bin of the mid is asked three questions at once.

How much of it is panned away from the centre, which the side magnitude measures
directly. How much of it is broadband, measured as the median across neighbouring
bins, which is what a drum looks like. How much of it is holding still, measured
as the median across neighbouring frames, which is what a held chord looks like.
Whatever is left over is centred, tonal and moving, and that is a lead vocal.

That third question is the one that decides whether a karaoke track sounds
finished. Keys, pads and rhythm guitars are mixed dead centre exactly like the
voice, so nothing about stereo position separates them, and an engine that goes
by position alone strips the chords out along with the singer and leaves a
hollow backing track. Time structure does separate them: a held chord occupies
one bin for half a second and a sung phrase never does.

Only the vocal stem is synthesised, as a true centre signal. The backing track
is the input minus that, which leaves the whole side signal untouched, so panned
instruments come through exactly as they were recorded.

The **Vocal removal** slider sets how hard to push. Pushing harder sharpens the
mask and subtracts more, and it eases off the protection that keeps centred
chords in place, because scrubbing the voice harder always takes some of the
music mixed in the same place with it. At the lowest setting the two stems sum
back to the input exactly; above that the backing track is deliberately
over-scrubbed and they no longer do.

This is signal processing, not a trained model. It works well on well-separated
stereo mixes and cannot do anything with a mono file.

## How the key change works

A phase vocoder estimates each bin's true frequency from how far its phase moved
between frames, then re-advances that phase over a longer or shorter hop.
Stretching by the pitch ratio and then resampling by the same ratio cancels the
ratio out of the duration and leaves it in the pitch, which is why the tempo
survives.

Three things separate this from a naive shifter:

**The channels move together.** A separate vocoder per channel lets their phases
drift apart, and a centred instrument wanders and widens as a result. Both
channels are rotated by one shared phase correction taken from their sum, so the
difference between them survives the shift and the stereo image holds.

**The formants stay put.** The broad shape of a spectrum is the shape of the
singer's throat, and it should not ride up with the note. Holding it still is
what keeps a voice shifted up sounding like the same person rather than a
chipmunk.

**Resampling goes through a windowed sinc.** Straight-line interpolation between
samples is cheap and audibly wrong: it dulls the top octave and folds everything
above the new Nyquist back down as aliasing, which is a good part of the metallic
edge a naive shifter has.

Large shifts still cost something — the further the audio moves the more it is
stretched and resampled — so the app says so past seven semitones.
