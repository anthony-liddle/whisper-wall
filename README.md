# Whisper Wall

A shared web space where you speak into your microphone and your voice becomes a single continuous pen stroke on a wall. The strokes are abstract. No transcription, no recoverable speech, no language barrier. The wall holds about thirty lines. Older lines fall off the bottom. Nothing is recorded. Nothing persists between sessions.

The piece works in one move. You hold a key, you speak, and your voice writes itself. The hand that draws is sampled from the qualities of your voice during the first fraction of a second of speaking, so the same person sounds like the same hand across strokes, and different people leave visibly different marks. Whispers register quietly. Shouts arrive with weight. The line is not handwriting and not a waveform. It is a third thing, with its own grammar.

The whole shipped piece must fit in 2MB. No frameworks, no bundlers, no large dependencies. Internet speed is an accessibility issue, and the ceiling is in service of that. The audio never leaves the device. Only the resulting geometry travels over the wire.

## Repo Layout

- `prototype/prototype.html` — the working single-line baseline. Source of truth for visual behavior. Do not modify.
- `engine.js` — the LineEngine extracted from the prototype. Owns audio analysis, hand calibration, pen state, gestures, and flourishes. Emits stroke points relative to a supplied origin.
- `demo.html` — single-line demo built on top of the engine. Should look and behave identically to `prototype/prototype.html`.

## Running Locally

The piece needs to be served over HTTP (microphone access requires a secure context, and the engine is loaded as a sibling script). From the repo root:

```
npm start
```

That runs `npx serve .` — no install, no dependencies, just a one-shot static server. By default it picks an open port and prints the URL.

If you'd rather invoke it yourself:

```
npx serve .
# or, if serve has any quirks for your setup:
npx http-server . -p 8000
```

Then open `demo.html` at the printed URL. Hold the spacebar and speak.

To run the original prototype as a comparison, open `prototype/prototype.html` at the same host in another tab.
