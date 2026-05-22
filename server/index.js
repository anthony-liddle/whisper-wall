// Whisper Wall server. One process: static HTTP + WebSocket on the same port.
// In-memory wall state. No persistence. See server/protocol.js for the wire
// format and server/wall-state.js for the state model.

const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { serve } = require('./static');
const { WallState } = require('./wall-state');
const {
  MAX_MESSAGE_BYTES,
  MAX_CONNECTIONS,
  STROKE_BEGIN_RATE_LIMIT_MS,
  parseClientMessage,
} = require('./protocol');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const httpServer = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  serve(req, res);
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });
const wall = new WallState();

// One Map keyed by ws so we can find the client record from event handlers.
const clients = new Map();

function newClientId() {
  return crypto.randomBytes(8).toString('hex');
}

function send(ws, obj) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    // Connection died mid-send; the close handler will clean up.
  }
}

// Broadcast to every connected client except the originator. The originator
// already drew the stroke locally and would otherwise double-render.
function broadcast(exceptWs, obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients.keys()) {
    if (ws === exceptWs) continue;
    if (ws.readyState !== ws.OPEN) continue;
    try {
      ws.send(data);
    } catch {
      // ignore; close handler will sweep
    }
  }
}

wss.on('connection', (ws, req) => {
  if (clients.size >= MAX_CONNECTIONS) {
    send(ws, { type: 'error', reason: 'server-full' });
    ws.close(1013, 'server full');
    return;
  }

  const clientId = newClientId();
  const record = {
    clientId,
    lastStrokeBeginAt: 0,
    remoteAddress: req.socket.remoteAddress,
  };
  clients.set(ws, record);

  const snapshot = wall.snapshot();
  console.log(
    `connect ${clientId} (${clients.size} live) ` +
      `-> wall-state: ${wall.completed.length} completed + ${wall.inFlight.size} in-flight ` +
      `(${snapshot.length} strokes)`,
  );

  send(ws, { type: 'hello', clientId });
  send(ws, { type: 'wall-state', strokes: snapshot });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Protocol is JSON-only.
      return;
    }
    const raw = data.toString('utf8');
    const parsed = parseClientMessage(raw);
    if (parsed.error) return; // silently drop malformed; not worth a round-trip
    const msg = parsed.msg;

    if (msg.type === 'stroke-begin') {
      const now = Date.now();
      if (now - record.lastStrokeBeginAt < STROKE_BEGIN_RATE_LIMIT_MS) return;
      record.lastStrokeBeginAt = now;
      wall.beginStroke({
        strokeId: msg.strokeId,
        clientId,
        originXFrac: msg.originXFrac,
        originYFrac: msg.originYFrac,
      });
      broadcast(ws, {
        type: 'stroke-begin',
        strokeId: msg.strokeId,
        clientId,
        originXFrac: msg.originXFrac,
        originYFrac: msg.originYFrac,
      });
      return;
    }

    if (msg.type === 'stroke-points') {
      const accepted = wall.appendPoints({ strokeId: msg.strokeId, points: msg.points });
      if (accepted.length === 0) return;
      broadcast(ws, {
        type: 'stroke-points',
        strokeId: msg.strokeId,
        points: accepted,
      });
      return;
    }

    if (msg.type === 'stroke-end') {
      const s = wall.endStroke({ strokeId: msg.strokeId });
      if (!s) return;
      broadcast(ws, { type: 'stroke-end', strokeId: msg.strokeId });
      return;
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    // The server drops this client's in-flight strokes (an interrupted
    // utterance must not become a permanent line). Tell other viewers to drop
    // the partial too, via stroke-abort — NOT stroke-end, which would commit it
    // and diverge from the server (the stroke would then vanish on next refresh).
    const dropped = wall.dropInFlightFrom(clientId);
    for (const strokeId of dropped) {
      broadcast(null, { type: 'stroke-abort', strokeId });
    }
  });

  ws.on('error', () => {
    // The close event will follow; nothing to do here beyond preventing crash.
  });
});

httpServer.listen(PORT, HOST, () => {
  console.log(`whisper-wall listening on http://${HOST}:${PORT}`);
  console.log(`  static:    http://${HOST}:${PORT}/wall.html`);
  console.log(`  websocket: ws://${HOST}:${PORT}/`);
});

function shutdown(signal) {
  console.log(`received ${signal}, shutting down`);
  for (const ws of clients.keys()) {
    try { ws.close(1001, 'server shutting down'); } catch {}
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
