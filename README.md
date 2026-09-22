# Splitkit

Splits a song into a vocal stem and a backing track, finds its key and tempo,
and transposes or time-stretches it. Runs entirely in the browser with no
network access, no server and no dependencies.

## Using it

Open `dist/vocal-remover.html` in Chrome or Edge. That one file is the whole
application; it works offline and can be copied anywhere.

Drop in a song, wait for the separation pass, then use the faders or the
Karaoke preset to mix, and the Download buttons to save WAVs.

## Building

    npm run build      # regenerate dist/vocal-remover.html from src/
    npm test           # run the DSP test suite

Sources live under `src/`; the build inlines them into the single HTML file.
It emits a classic script rather than a module because Chrome refuses to load
`<script type="module">` over `file://`.

## How the separation works

Lead vocals are almost always mixed dead centre, identical in the left and
right channels. For each frequency bin the engine measures how alike the two
channels are and builds a soft 0..1 mask from that, applying it to both
channels so the result stays stereo. A band weighting keeps bass and cymbals —
also centre-panned — out of the vocal stem.

Only the vocal stem is synthesised; the backing track is the original minus
that, so the two stems always sum back to exactly the input.

This is signal processing, not a trained model. It works well on
well-separated stereo mixes and cannot do anything with a mono file.
