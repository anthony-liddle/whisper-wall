// LineEngine — Whisper Wall
//
// Audio-driven stroke generator extracted from prototype_20.html. Owns:
// audio graph (mic -> gain -> analyser), ambient calibration, pitch and
// spectral analysis, the per-stroke hand calibration, the pen state machine,
// onset-driven letter zones, and the flourish system.
//
// Does NOT own: DOM, canvas, keyboard input, where strokes appear on screen,
// network transport. Points emitted by tick() are RELATIVE to the origin
// passed into beginStroke({ originX, originY }) so the caller can place
// strokes anywhere on the page.
//
// The tuned constants below are the result of many iterations. Do not
// "clean them up" without preserving what they were tuned for.

(function () {
  const FFT_SIZE = 2048;
  const HAND_CAL_MS = 350;
  const WARMUP_MS = 350;
  const PITCH_SMOOTHING = 8;
  const RMS_SMOOTHING = 6;
  const CENTROID_SMOOTHING = 12;
  const FRAMES_TO_LIFT = 4;
  const FRAMES_TO_DROP = 2;
  const ABUSE_RATIO = 15;
  const MIN_ONSET_GAP_MS = 280; // longer gap between gestures — fewer, more committed firings
  const MIN_WIDTH = 1.2;
  const MAX_WIDTH = 8;
  const AMBIENT_RESUME_MS = 250;

  class LineEngine {
    constructor(opts = {}) {
      this.gainBoost = opts.gainBoost != null ? opts.gainBoost : 15;

      // Audio graph (filled in by start)
      this.audioCtx = null;
      this.analyser = null;
      this.micStream = null;
      this.micSource = null;
      this.micGainNode = null;
      this.micLabel = "unknown";

      // Working buffers
      this._freqData = new Uint8Array(FFT_SIZE / 2);
      this._timeData = new Uint8Array(FFT_SIZE);
      this._pitchBuffer = new Float32Array(FFT_SIZE);

      // Hand — per-stroke constants derived from voice during the 350ms warmup.
      // The hand sets the rules of writing; the pen plays within them.
      this.hand = {
        slant: 0,
        baselineY: 0, // relative frame: baseline is the origin's Y
        xHeight: 30,
        tremorFreq: 0.15,
        tremorPhase: 0,
        loopBias: 0,
        forwardSpeed: 1.2,
      };

      // Pen — relative coordinates. x is distance from origin along the writing
      // direction; yLocal is signed vertical distance from baseline.
      this.pen = {
        x: 0,
        yLocal: 0,
        pressure: 0.4,
        down: true,
        quietFrames: 0,
        voiceFrames: 0,
        _inUpstroke: false,
      };

      this.isDrawing = false;
      this.ornamentsEnabled = false;

      // Calibration / smoothing state
      this._pitchHistory = [];
      this._rmsHistory = [];
      this._centroidHistory = [];
      this._centroidVariance = 0;
      this._handSamples = [];
      this._handCalibrated = false;
      this._lineStartTime = 0;

      // Event state
      this._inVowel = false;
      this._vowelFrames = 0;
      this._lastAmpPeakAt = -10000;
      this._downstrokeProgress = -1;
      this._downstrokeStartY = 0;
      this._downstrokeTargetDepth = 0;

      this._belowVoiceFrames = 0;
      this._lastLiftAt = -10000;

      this._prevAvgRMS = 0;
      this._inLetterZone = false;
      this._letterZoneStart = 0;
      this._letterZoneStartX = 0;
      this._nextStrokeDirection = 1;
      this._lastOnsetAt = -10000;

      this._zoneHasHook = false;
      this._zoneHasLoop = false;
      this._zoneHasOvershoot = false;
      this._zoneDepthScale = 1;
      this._zoneDuration = 180;

      this._sustainedIntenseFrames = 0;
      this._highPitchHeldFrames = 0;
      this._lastFlourishAt = -10000;

      this.ambientRMS = 0.003;

      // Timestamp of the last endStroke(). Used to pause ambient calibration
      // for AMBIENT_RESUME_MS after a stroke ends, so the tail of the
      // utterance (room reverb, breath, throat settle) does not get folded
      // into the room floor. Initialised far in the past so the very first
      // frame can calibrate freely.
      this._endStrokeAt = -1e9;

      // Live readouts for the host to surface in debug UI
      this._lastRMS = 0;
      this._lastPitch = 0;
      this._lastHasVoice = false;

      // Origin currently passed by the host. Stored for reference; the engine
      // emits points relative to (0, 0) — the host translates at paint time.
      this._originX = 0;
      this._originY = 0;
    }

    // Wire mic -> explicit gain -> analyser. Many built-in mics (especially
    // MacBook internals) come in at very low levels through getUserMedia and
    // AGC alone is not reliable. The 15x boost happens before the analyser.
    async start(audioCtx, micStream) {
      this.audioCtx = audioCtx;
      this.micStream = micStream;

      const tracks = micStream.getAudioTracks();
      if (tracks.length > 0) {
        this.micLabel = tracks[0].label || "unknown";
      }

      this.micSource = audioCtx.createMediaStreamSource(micStream);
      this.micGainNode = audioCtx.createGain();
      this.micGainNode.gain.value = this.gainBoost;

      this.analyser = audioCtx.createAnalyser();
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0.25;

      this.micSource.connect(this.micGainNode);
      this.micGainNode.connect(this.analyser);
    }

    setOrnaments(on) {
      this.ornamentsEnabled = !!on;
    }

    getHand() {
      return Object.assign({}, this.hand);
    }

    getStatus() {
      return {
        rms: this._lastRMS,
        ambient: this.ambientRMS,
        pitch: this._lastPitch,
        hasVoice: this._lastHasVoice,
        micLabel: this.micLabel,
        penDown: this.pen.down,
        penX: this.pen.x,
        isDrawing: this.isDrawing,
        handCalibrated: this._handCalibrated,
      };
    }

    // ----- Audio feature extraction -----

    _getRMS() {
      this.analyser.getByteTimeDomainData(this._timeData);
      let sum = 0;
      for (let i = 0; i < this._timeData.length; i++) {
        const v = (this._timeData[i] - 128) / 128;
        sum += v * v;
      }
      return Math.sqrt(sum / this._timeData.length);
    }

    _getSpectralFeatures() {
      this.analyser.getByteFrequencyData(this._freqData);
      const sampleRate = this.audioCtx.sampleRate;
      const binCount = this._freqData.length;
      const nyquist = sampleRate / 2;
      const hzPerBin = nyquist / binCount;

      let total = 0;
      let weighted = 0;
      let lowEnergy = 0; // 80 - 400 Hz (voiced fundamentals)
      let midEnergy = 0; // 400 - 2000 Hz
      let highEnergy = 0; // 2000 - 8000 Hz (whisper's main band)

      for (let i = 0; i < binCount; i++) {
        const hz = i * hzPerBin;
        const v = this._freqData[i] / 255;
        total += v;
        weighted += v * hz;
        if (hz >= 80 && hz <= 400) lowEnergy += v;
        else if (hz > 400 && hz <= 2000) midEnergy += v;
        else if (hz > 2000 && hz <= 8000) highEnergy += v;
      }

      const centroidHz = total > 0 ? weighted / total : 0;
      // 500Hz -> 0, 4000Hz -> 1
      const centroidNorm = Math.max(0, Math.min(1, (centroidHz - 500) / 3500));
      return { centroidNorm, lowEnergy, midEnergy, highEnergy, total };
    }

    // Autocorrelation pitch detection. Returns Hz, or 0 if no clear pitch
    // (unvoiced speech, silence, or noise).
    _detectPitch() {
      this.analyser.getFloatTimeDomainData(this._pitchBuffer);
      const sampleRate = this.audioCtx.sampleRate;
      const SIZE = this._pitchBuffer.length;

      let energy = 0;
      for (let i = 0; i < SIZE; i++) energy += this._pitchBuffer[i] * this._pitchBuffer[i];
      if (energy < 0.01) return 0;

      const minLag = Math.floor(sampleRate / 500);
      const maxLag = Math.min(SIZE - 1, Math.floor(sampleRate / 70));

      let bestLag = -1;
      let bestCorr = 0;
      for (let lag = minLag; lag < maxLag; lag++) {
        let corr = 0;
        for (let i = 0; i < SIZE - lag; i++) {
          corr += this._pitchBuffer[i] * this._pitchBuffer[i + lag];
        }
        if (corr > bestCorr) {
          bestCorr = corr;
          bestLag = lag;
        }
      }
      if (bestLag === -1) return 0;

      const normalizedCorr = bestCorr / energy;
      if (normalizedCorr < 0.4) return 0;

      return sampleRate / bestLag;
    }

    // ----- Stroke lifecycle -----

    beginStroke(opts) {
      opts = opts || {};
      this._originX = opts.originX || 0;
      this._originY = opts.originY || 0;

      // Pen starts at the origin in the local frame. The host translates at
      // paint time. Pen is initially LIFTED — voice lands it.
      this.pen.x = 0;
      this.pen.yLocal = 0;
      this.pen.pressure = 0.35;
      this.pen.down = false;
      this.pen.quietFrames = 0;
      this.pen.voiceFrames = 0;
      this.pen._inUpstroke = false;

      // Hand baseline lives at y=0 in the local frame.
      this.hand.baselineY = 0;
      this.hand.slant = 0;
      this.hand.xHeight = 28;
      this.hand.tremorFreq = 0.15;
      this.hand.tremorPhase = 0;
      this.hand.loopBias = 0;
      this.hand.forwardSpeed = 1.0;

      this._pitchHistory = [];
      this._rmsHistory = [];
      this._centroidHistory = [];
      this._handSamples = [];
      this._handCalibrated = false;
      this._centroidVariance = 0;

      this._inVowel = false;
      this._vowelFrames = 0;
      this._lastAmpPeakAt = -10000;
      this._downstrokeProgress = -1;
      this._belowVoiceFrames = 0;
      this._lastLiftAt = -10000;
      this._prevAvgRMS = 0;
      this._inLetterZone = false;
      this._letterZoneStart = 0;
      this._letterZoneStartX = 0;
      this._nextStrokeDirection = 1;
      this._lastOnsetAt = -10000;
      this._zoneHasHook = false;
      this._zoneHasLoop = false;
      this._zoneHasOvershoot = false;
      this._zoneDepthScale = 1;
      this._zoneDuration = 180;
      this._sustainedIntenseFrames = 0;
      this._highPitchHeldFrames = 0;
      this._lastFlourishAt = -10000;

      this._lineStartTime = performance.now();
      this.isDrawing = true;
    }

    endStroke() {
      this.isDrawing = false;
      this._endStrokeAt = performance.now();
    }

    // Hand calibration. Maps voice qualities to writing qualities
    // deterministically — same voice produces a similar hand each time;
    // different voices produce distinct hands.
    _calibrateHand() {
      if (this._handSamples.length < 5) {
        this._handCalibrated = true;
        return;
      }
      let avgPitch = 0,
        avgRMS = 0,
        avgCentroid = 0;
      let pitchVar = 0;
      let pitchCount = 0;
      for (const s of this._handSamples) {
        avgRMS += s.rms;
        avgCentroid += s.centroid;
        if (s.pitch > 0) {
          avgPitch += s.pitch;
          pitchCount++;
        }
      }
      avgRMS /= this._handSamples.length;
      avgCentroid /= this._handSamples.length;
      if (pitchCount > 0) avgPitch /= pitchCount;
      for (const s of this._handSamples) {
        if (s.pitch > 0) {
          const d = s.pitch - avgPitch;
          pitchVar += d * d;
        }
      }
      if (pitchCount > 1) pitchVar = Math.sqrt(pitchVar / pitchCount);

      // SLANT: higher pitch = more forward slant. Range ~-0.15 to +0.25 rad.
      const pitchNorm = avgPitch > 0 ? Math.max(0, Math.min(1, (avgPitch - 100) / 200)) : 0.5;
      this.hand.slant = -0.15 + pitchNorm * 0.4;

      // X-HEIGHT: louder voice = taller writing; centroid nudges it. 18..45 px.
      const loudness = Math.min(1, avgRMS * 8);
      this.hand.xHeight = 18 + loudness * 22 + avgCentroid * 5;

      // TREMOR FREQUENCY: pitch variance -> writing rhythm.
      this.hand.tremorFreq = 0.08 + Math.min(0.2, pitchVar / 200);

      // LOOP BIAS: spectral centroid biases loop direction.
      this.hand.loopBias = (avgCentroid - 0.5) * 1.8;

      // FORWARD SPEED: lower-pitched voices write a touch slower.
      this.hand.forwardSpeed = 0.7 + pitchNorm * 0.6;

      this._handCalibrated = true;
    }

    // Advance one frame. Returns an array of points {x, y, w, alpha} emitted
    // this frame, in the stroke's local frame (relative to origin). May return
    // [] if not drawing, no voice, or pen is up.
    tick() {
      if (!this.analyser) return [];

      const rms = this._getRMS();
      const spec = this._getSpectralFeatures();
      const pitch = this._detectPitch();

      this._lastRMS = rms;
      this._lastPitch = pitch;

      // Continuously calibrate ambient RMS when NOT drawing. The brief pause
      // after endStroke() keeps the tail of the utterance — residual room
      // reverb, breath, throat settle — from being folded into the floor.
      // Without it the floor drifts upward across a session and later strokes
      // come out dottier than earlier ones.
      const ambientReady =
        performance.now() - this._endStrokeAt > AMBIENT_RESUME_MS;
      if (!this.isDrawing && ambientReady && rms < 0.03) {
        this.ambientRMS = this.ambientRMS * 0.98 + rms * 0.02;
      }

      // Voice presence: above ambient, OR a detected pitch, OR absolute RMS
      // clearly speech regardless of ambient (the gain boost makes ambient
      // noisier too, so absolute thresholds are also reliable).
      const hasVoice = rms > this.ambientRMS * 1.4 || pitch > 0 || rms > 0.05;
      this._lastHasVoice = hasVoice;

      if (!this.isDrawing) return [];

      const elapsed = performance.now() - this._lineStartTime;
      const inWarmup = elapsed < WARMUP_MS;

      const emitted = [];

      if (!(hasVoice || inWarmup)) {
        // No voice — pen lifts after quiet frames accumulate.
        this.pen.quietFrames++;
        this.pen.voiceFrames = 0;
        if (this.pen.quietFrames >= FRAMES_TO_LIFT) this.pen.down = false;
        return emitted;
      }

      const now = performance.now();

      // Smooth audio features
      this._rmsHistory.push(rms);
      if (this._rmsHistory.length > RMS_SMOOTHING) this._rmsHistory.shift();
      const avgRMS = this._rmsHistory.reduce((a, b) => a + b, 0) / this._rmsHistory.length;

      if (pitch > 0) {
        this._pitchHistory.push(pitch);
        if (this._pitchHistory.length > PITCH_SMOOTHING) this._pitchHistory.shift();
      }

      this._centroidHistory.push(spec.centroidNorm);
      if (this._centroidHistory.length > CENTROID_SMOOTHING) this._centroidHistory.shift();
      const meanCentroid =
        this._centroidHistory.reduce((a, b) => a + b, 0) / this._centroidHistory.length;
      let varSum = 0;
      for (let i = 0; i < this._centroidHistory.length; i++) {
        const d = this._centroidHistory[i] - meanCentroid;
        varSum += d * d;
      }
      this._centroidVariance = Math.sqrt(varSum / this._centroidHistory.length);

      // Hand calibration during the first HAND_CAL_MS of the stroke.
      if (!this._handCalibrated) {
        this._handSamples.push({
          rms: rms,
          pitch: pitch,
          centroid: spec.centroidNorm,
        });
        if (elapsed >= HAND_CAL_MS) {
          this._calibrateHand();
        }
      }

      // PEN LIFT — the line is mostly broken. Brief moments of connection.
      const liftThreshold = Math.max(0.025, this.ambientRMS * 3.5);
      if (avgRMS < liftThreshold) {
        this.pen.quietFrames++;
        this.pen.voiceFrames = 0;
        if (this.pen.quietFrames >= 3) {
          if (this.pen.down) {
            this._lastLiftAt = now;
          }
          this.pen.down = false;
        }
      } else {
        this.pen.voiceFrames++;
        this.pen.quietFrames = 0;
        if (this.pen.voiceFrames >= FRAMES_TO_DROP) {
          if (!this.pen.down) {
            // Just landed. Long lift = word boundary: gap forward + return toward baseline.
            const liftDuration = now - this._lastLiftAt;
            if (liftDuration > 120) {
              this.pen.x += this.hand.xHeight * 0.5 + Math.random() * this.hand.xHeight * 0.4;
              this.pen.yLocal = this.pen.yLocal * 0.3;
            }
          }
          this.pen.down = true;
        }
      }

      // ABUSE LEVEL relative to ambient
      const ambientRatio = avgRMS / Math.max(0.002, this.ambientRMS);
      const abuseLevel = Math.min(1, Math.max(0, (ambientRatio - ABUSE_RATIO) / 25));

      // EVENT DETECTION: vowel (sustained voiced) vs consonant (transient).
      const isVoiced = pitch > 0;
      const isStable = this._centroidVariance < 0.03 && avgRMS > 0.015;
      this._inVowel = isVoiced && isStable;

      if (this._inVowel) this._vowelFrames++;
      else this._vowelFrames = 0;

      const ampPeak = avgRMS > 0.04 && rms > avgRMS * 1.15;
      if (ampPeak && now - this._lastAmpPeakAt > 150 && this._downstrokeProgress < 0) {
        this._lastAmpPeakAt = now;
        this._downstrokeProgress = 0;
        this._downstrokeStartY = this.pen.yLocal;
        const intensity = Math.min(1, avgRMS * 8);
        this._downstrokeTargetDepth = this.hand.xHeight * (0.5 + intensity * 0.7);
      }

      if (this.pen.down) {
        // ONSET DETECTION: only the most emphatic moments fire gestures.
        // Most syllables produce nothing. The eye should be surprised when
        // something happens.
        const rmsDelta = avgRMS - this._prevAvgRMS;
        const onsetThreshold = Math.max(0.025, this.ambientRMS * 4);
        const isOnset =
          rmsDelta > onsetThreshold &&
          avgRMS > 0.045 &&
          now - this._lastOnsetAt > MIN_ONSET_GAP_MS;

        if (isOnset) {
          this._lastOnsetAt = now;
          this._inLetterZone = true;
          this._letterZoneStart = now;
          this._letterZoneStartX = this.pen.x;
          this._nextStrokeDirection *= -1;

          this._zoneHasHook = isVoiced && Math.random() < 0.6;
          const pitchNorm =
            pitch > 0 ? Math.max(0, Math.min(1, (pitch - 100) / 200)) : 0.5;
          this._zoneHasLoop = pitchNorm > 0.5 && Math.random() < 0.6;
          this._zoneHasOvershoot = rmsDelta > onsetThreshold * 1.4;

          // Dramatic depth scale when a gesture fires — 2-3x the previous tuning.
          const intensity = Math.min(1, avgRMS * 12);
          this._zoneDepthScale = 1.6 + intensity * 1.4 + (Math.random() - 0.5) * 0.4;

          this._zoneDuration = isVoiced
            ? 220 + Math.random() * 100
            : 140 + Math.random() * 60;
        }

        const zoneAge = now - this._letterZoneStart;
        if (this._inLetterZone && zoneAge > this._zoneDuration) {
          this._inLetterZone = false;
        }

        let targetYLocal = 0;
        let inUpstroke = false;

        if (this._inLetterZone) {
          const t = zoneAge / this._zoneDuration;
          const arcHeight = this.hand.xHeight * this._zoneDepthScale;

          // PRIMARY ARC: asymmetric — fast confident downstroke, slower upstroke.
          let arcShape;
          if (t < 0.42) {
            const dt = t / 0.42;
            arcShape = Math.sin(dt * Math.PI * 0.5);
          } else {
            const dt = (t - 0.42) / 0.58;
            arcShape = Math.cos(dt * Math.PI * 0.5);
            inUpstroke = true;
          }
          targetYLocal = arcShape * arcHeight * this._nextStrokeDirection;

          // HOOK at the start: small counter-direction nudge for the first 10%.
          if (this._zoneHasHook && t < 0.1) {
            const hookT = t / 0.1;
            const hookCurve = Math.sin(hookT * Math.PI);
            targetYLocal -= hookCurve * arcHeight * 0.15 * this._nextStrokeDirection;
          }

          // LOOP at the apex: small circular motion around the high point.
          if (this._zoneHasLoop && t > 0.32 && t < 0.55) {
            const loopT = (t - 0.32) / 0.23;
            const loopAngle = loopT * Math.PI * 2;
            const loopRadius = arcHeight * 0.18;
            targetYLocal +=
              Math.sin(loopAngle) * loopRadius * -this._nextStrokeDirection;
          }

          // OVERSHOOT at the end: pen passes baseline slightly before settling.
          if (this._zoneHasOvershoot && t > 0.85) {
            const overT = (t - 0.85) / 0.15;
            const overCurve = Math.sin(overT * Math.PI);
            targetYLocal -= overCurve * arcHeight * 0.12 * this._nextStrokeDirection;
          }
        }

        // Very subtle tremor — sub-pixel, applied to position not heading.
        this.hand.tremorPhase += this.hand.tremorFreq;
        const tremor = Math.sin(this.hand.tremorPhase) * 0.15;

        // Easing: stronger when committing to a gesture, gentler when connecting.
        const ease = this._inLetterZone ? 0.4 : 0.18;
        this.pen.yLocal += (targetYLocal - this.pen.yLocal) * ease;
        this.pen.yLocal += tremor;

        this.pen._inUpstroke = inUpstroke;
      }

      this._prevAvgRMS = avgRMS;

      // PRESSURE from centroid stability + abuse boost
      const stability = 1 - Math.min(1, this._centroidVariance * 8);
      const targetPressure = 0.3 + stability * 0.55 + abuseLevel * 0.15;
      this.pen.pressure += (targetPressure - this.pen.pressure) * 0.2;

      // Forward speed in the hand's frame
      const speedFromAmp = Math.min(2.2, 0.5 + Math.log10(1 + avgRMS * 200) * 1.4);
      const forwardStep = speedFromAmp * this.hand.forwardSpeed * (this.pen.down ? 1 : 1.3);

      const prevX = this.pen.x;
      const prevYLocal = this.pen.yLocal;
      this.pen.x += forwardStep;

      // SLANT: small per-step Y shift in direction of motion. Tilts vertical
      // strokes without making the whole baseline drift.
      const slantStep = Math.tan(this.hand.slant) * forwardStep * 0.15;

      const prevScreenY = this.hand.baselineY + prevYLocal;
      const currScreenY = this.hand.baselineY + this.pen.yLocal + slantStep;

      // Width: thin connectors, dramatic gestures.
      const directionWidthMult = this.pen._inUpstroke ? 0.55 : 1.0;
      const inGestureMult = this._inLetterZone ? 1.0 : 0.32;
      const width =
        (MIN_WIDTH + this.pen.pressure * (MAX_WIDTH - MIN_WIDTH)) *
        directionWidthMult *
        inGestureMult;

      if (this.pen.down) {
        const dx = this.pen.x - prevX;
        const dy = currScreenY - prevScreenY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const steps = Math.max(1, Math.ceil(dist / 0.9));
        const wobbleAmp = 0.5 + abuseLevel * 4;

        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const wobble = (Math.random() - 0.5) * wobbleAmp;
          const dirX = dx / Math.max(dist, 0.001);
          const dirY = dy / Math.max(dist, 0.001);
          const perpX = -dirY * wobble;
          const perpY = dirX * wobble;
          const alpha = (0.72 + Math.random() * 0.2) * (0.55 + this.pen.pressure * 0.45);
          emitted.push({
            x: prevX + dx * t + perpX,
            y: prevScreenY + dy * t + perpY,
            w: width * (0.88 + Math.random() * 0.2),
            alpha: alpha,
          });
        }

        // ABUSE SPLATTER
        if (abuseLevel > 0.1) {
          if (Math.random() < abuseLevel * 0.7) {
            const splatterCount = 1 + Math.floor(abuseLevel * 4);
            for (let i = 0; i < splatterCount; i++) {
              const angle = Math.random() * Math.PI * 2;
              const distFromPen = 4 + Math.random() * (10 + abuseLevel * 30);
              emitted.push({
                x: this.pen.x + Math.cos(angle) * distFromPen,
                y: currScreenY + Math.sin(angle) * distFromPen,
                w: 0.8 + Math.random() * (1.5 + abuseLevel * 2),
                alpha: 0.4 + Math.random() * 0.4,
              });
            }
          }
        }

        // FLOURISHES — rare surprising marks at exceptional moments.
        if (avgRMS > 0.08) this._sustainedIntenseFrames++;
        else this._sustainedIntenseFrames = Math.max(0, this._sustainedIntenseFrames - 2);

        if (pitch > 280 && isVoiced) this._highPitchHeldFrames++;
        else this._highPitchHeldFrames = Math.max(0, this._highPitchHeldFrames - 2);

        const flourishCooldown = now - this._lastFlourishAt > 600;

        if (flourishCooldown) {
          // FLOURISH 1: long trailing tail — held intensity bleeds ink forward.
          if (this._sustainedIntenseFrames > 18 && Math.random() < 0.04) {
            this._lastFlourishAt = now;
            this._sustainedIntenseFrames = 0;
            const trailLen = 20 + Math.random() * 60;
            const trailAngle = (Math.random() - 0.5) * 0.4;
            const trailSteps = Math.floor(trailLen / 1.2);
            const trailFadeStart = 0.6 + Math.random() * 0.2;
            for (let i = 0; i < trailSteps; i++) {
              const tt = i / trailSteps;
              const fadeIn = Math.min(1, tt * 4);
              const fadeOut =
                tt > trailFadeStart ? 1 - (tt - trailFadeStart) / (1 - trailFadeStart) : 1;
              const fade = fadeIn * fadeOut;
              emitted.push({
                x: this.pen.x + tt * trailLen,
                y:
                  currScreenY +
                  Math.sin(trailAngle) * tt * trailLen +
                  (Math.random() - 0.5) * 0.6,
                w: 0.7 + Math.random() * 0.4,
                alpha: fade * (0.45 + Math.random() * 0.2),
              });
            }
          }
          // FLOURISH 2: scattered dot cluster — held high pitch rings nearby.
          else if (this._highPitchHeldFrames > 12 && Math.random() < 0.05) {
            this._lastFlourishAt = now;
            this._highPitchHeldFrames = 0;
            const dotCount = 5 + Math.floor(Math.random() * 8);
            const clusterRadius = 12 + Math.random() * 18;
            const clusterAngle = -Math.PI / 2 + (Math.random() - 0.5) * 0.6;
            const cx = this.pen.x + Math.cos(clusterAngle) * clusterRadius * 0.6;
            const cy = currScreenY + Math.sin(clusterAngle) * clusterRadius * 0.6;
            for (let i = 0; i < dotCount; i++) {
              const a = Math.random() * Math.PI * 2;
              const r = Math.random() * clusterRadius * 0.7;
              emitted.push({
                x: cx + Math.cos(a) * r,
                y: cy + Math.sin(a) * r,
                w: 0.6 + Math.random() * 0.9,
                alpha: 0.35 + Math.random() * 0.35,
              });
            }
          }
          // FLOURISH 3: sharp emphatic mark — single thick stroke on plosives.
          else if (rms - this._prevAvgRMS > 0.08 && Math.random() < 0.25) {
            this._lastFlourishAt = now;
            const markLen = 8 + Math.random() * 16;
            const markSteps = Math.ceil(markLen / 0.8);
            const markAngle = Math.PI / 2 + (Math.random() - 0.5) * 0.5;
            const markX = this.pen.x + (Math.random() - 0.5) * 4;
            for (let i = 0; i < markSteps; i++) {
              const tt = i / markSteps;
              const fade = 1 - tt * 0.6;
              emitted.push({
                x: markX + Math.cos(markAngle) * tt * markLen,
                y: currScreenY + Math.sin(markAngle) * tt * markLen + 3,
                w: 1.5 + Math.random() * 1.2,
                alpha: fade * (0.55 + Math.random() * 0.25),
              });
            }
          }
        }
      }

      // Ornamental sibilants (toggleable)
      if (this.ornamentsEnabled && this.pen.down) {
        const isSibilant =
          meanCentroid > 0.55 &&
          this._centroidVariance > 0.06 &&
          (pitch === 0 || pitch > 300);
        if (isSibilant && avgRMS < 0.08 && Math.random() < 0.4) {
          for (let i = 0; i < 4; i++) {
            const t = (i / 4 - 0.5) * 2;
            const localX = this.pen.x + Math.cos(this.hand.slant + Math.PI / 2) * 4 * t;
            const localY = currScreenY + Math.sin(this.hand.slant + Math.PI / 2) * 4 * t;
            emitted.push({
              x: localX,
              y: localY,
              w: 0.8 + Math.random() * 0.6,
              alpha: 0.35 + Math.random() * 0.3,
            });
          }
        }
      }

      return emitted;
    }
  }

  window.LineEngine = LineEngine;
})();
