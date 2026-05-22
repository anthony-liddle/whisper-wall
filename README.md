# Whisper Wall

A shared web space where you speak into your microphone and your voice becomes a single continuous pen stroke on a wall. The strokes are abstract. No transcription, no recoverable speech, no language barrier. The wall holds about thirty lines. Older lines fall off the bottom. Nothing is recorded. Nothing persists between sessions.

The piece works in one move. You hold a key, you speak, and your voice writes itself. The hand that draws is sampled from the qualities of your voice during the first fraction of a second of speaking, so the same person sounds like the same hand across strokes, and different people leave visibly different marks. Whispers register quietly. Shouts arrive with weight. The line is not handwriting and not a waveform. It is a third thing, with its own grammar.

The whole shipped piece must fit in 2MB. No frameworks, no bundlers, no large dependencies. Internet speed is an accessibility issue, and the ceiling is in service of that. The audio never leaves the device. Only the resulting geometry travels over the wire.

## Repo Layout

- `prototype/prototype.html` — the working single-line baseline. Source of truth for visual behavior. Do not modify.
- `engine.js` — the LineEngine extracted from the prototype. Owns audio analysis, hand calibration, pen state, gestures, and flourishes. Emits stroke points relative to a supplied origin.
- `demo.html` — single-line demo built on top of the engine. Should look and behave identically to `prototype/prototype.html`.

## Repo Layout (server)

- `server/index.js` — wires HTTP + WebSocket on a single port. Static files plus the realtime protocol.
- `server/static.js` — minimal static-file handler with a strict allowlist.
- `server/wall-state.js` — in-memory wall state: ordered list of completed strokes (cap ~30) plus in-flight strokes. No persistence.
- `server/protocol.js` — wire protocol constants and message validation.

## Running Locally

The piece needs to be served over HTTP (microphone access requires a secure context, and the engine is loaded as a sibling script). From the repo root:

```
pnpm install
pnpm start
```

That runs `node server/index.js`, which serves both the static files and the WebSocket on the same port (default `3000`). Open <http://localhost:3000/wall.html>, click Enter, hold the spacebar and speak.

To test multi-client locally, open the same URL in two browser windows (or two browsers). Strokes drawn in one appear in real time on the other. A third window arriving late receives the wall as it currently stands.

The single-line `demo.html` and `prototype/prototype.html` are local-only and remain unchanged — they are also served by the dev server at the same host.

## Wire Protocol

JSON over a single WebSocket at `/`. Origin positions travel as viewport fractions; point coordinates travel in engine-native units, and each receiving client re-scales to its own line-height.

| Direction | Message | Fields |
|-----------|---------|--------|
| S→C | `hello` | `clientId` |
| S→C | `wall-state` | `strokes[]` (oldest first; each has `strokeId`, `clientId`, `originXFrac`, `originYFrac`, `points[]`, `complete`) |
| C→S, S→C | `stroke-begin` | `strokeId`, `originXFrac`, `originYFrac` (S→C also carries `clientId`) |
| C→S, S→C | `stroke-points` | `strokeId`, `points[]` of `{x, y, w, alpha, fadeOffset}` |
| C→S, S→C | `stroke-end` | `strokeId` |

The server never echoes a message back to its originator — the originator already drew the stroke locally.

Caps: 64 KB per message, 10 000 points per stroke, one `stroke-begin` per connection per 2 s, 100 concurrent connections.

## Deploying to Fly.io

```
fly launch          # first time only; pick a region and accept the existing fly.toml
fly deploy
fly scale count 1   # REQUIRED: run exactly one machine (see below)
```

Fly serves the app at `https://<app-name>.fly.dev/wall.html`. HTTPS (and `wss://` for the WebSocket) is handled at the edge; the Node process speaks plain HTTP/WS internally. The Dockerfile builds a Node 22 image, installs production deps with pnpm, and runs `node server/index.js`.

### Single machine is required

The wall lives in **one process's memory**. There is no shared datastore. That means the app must run on **exactly one machine**:

- `fly launch` defaults to creating **two** machines for high availability. With two machines there are two independent walls. Fly's load balancer routes each connection to either one, so a draw lands on machine A while a later refresh may hit machine B and show an **empty wall** — even though the app is "running" the whole time.
- Run `fly scale count 1` to collapse to a single machine. Confirm with `fly status` (one `started` machine, no others).
- `fly.toml` sets `auto_stop_machines = 'off'` and `min_machines_running = 1` so the one machine stays warm and the shared wall survives between visits.

The server holds wall state in memory only. A new deploy or a machine restart clears the wall — this is intentional, matching the piece's ephemerality. (Idle no longer clears it, now that the machine is kept warm.)

## Privacy

No audio data ever crosses the network. The microphone feed lives entirely in the browser; only the geometry the engine has already abstracted into `{x, y, w, alpha}` points travels over the socket. A line on the wall has no recoverable relationship to the speech that drew it.
