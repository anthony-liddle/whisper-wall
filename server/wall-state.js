// In-memory wall state. No persistence. A restart clears the wall -- that's
// intentional, matching the piece's ephemerality.
//
// Holds:
//   - completed: ordered list of finished strokes, oldest first, capped at
//                MAX_STROKES_ON_WALL. Sent to new arrivals as the existing wall.
//   - inFlight:  map of strokeId -> stroke for currently-being-drawn strokes,
//                so a new arrival mid-stroke sees the stroke in progress.
//
// Fade, eviction-by-fade, and the writing slot are rendering concerns. The
// server stays out of them and just holds raw geometry.

const { MAX_POINTS_PER_STROKE, MAX_STROKES_ON_WALL } = require('./protocol');

class WallState {
  constructor() {
    this.completed = [];
    this.inFlight = new Map();
  }

  beginStroke({ strokeId, clientId, originXFrac, originYFrac }) {
    // Replace any prior stroke with the same id (defensive against client reuse).
    this.inFlight.set(strokeId, {
      strokeId,
      clientId,
      originXFrac,
      originYFrac,
      points: [],
      complete: false,
    });
  }

  // Returns the points actually accepted (after the per-stroke cap), so the
  // caller can broadcast only those. Returns [] if there is no matching stroke.
  appendPoints({ strokeId, points }) {
    const s = this.inFlight.get(strokeId);
    if (!s) return [];
    const remaining = MAX_POINTS_PER_STROKE - s.points.length;
    if (remaining <= 0) return [];
    const accepted = points.length > remaining ? points.slice(0, remaining) : points;
    for (const p of accepted) s.points.push(p);
    return accepted;
  }

  endStroke({ strokeId }) {
    const s = this.inFlight.get(strokeId);
    if (!s) return null;
    this.inFlight.delete(strokeId);
    s.complete = true;
    this.completed.push(s);
    while (this.completed.length > MAX_STROKES_ON_WALL) {
      this.completed.shift();
    }
    return s;
  }

  // Drop all strokes from a disconnecting client whose strokes are still in
  // flight. Completed strokes stay on the wall.
  dropInFlightFrom(clientId) {
    const dropped = [];
    for (const [id, s] of this.inFlight) {
      if (s.clientId === clientId) {
        this.inFlight.delete(id);
        dropped.push(id);
      }
    }
    return dropped;
  }

  // Snapshot used for the wall-state message sent to new arrivals. Returns
  // completed strokes in chronological order (oldest first) followed by
  // currently-in-flight strokes.
  snapshot() {
    const strokes = [];
    for (const s of this.completed) {
      strokes.push({
        strokeId: s.strokeId,
        clientId: s.clientId,
        originXFrac: s.originXFrac,
        originYFrac: s.originYFrac,
        points: s.points,
        complete: true,
      });
    }
    for (const s of this.inFlight.values()) {
      strokes.push({
        strokeId: s.strokeId,
        clientId: s.clientId,
        originXFrac: s.originXFrac,
        originYFrac: s.originYFrac,
        points: s.points,
        complete: false,
      });
    }
    return strokes;
  }
}

module.exports = { WallState };
