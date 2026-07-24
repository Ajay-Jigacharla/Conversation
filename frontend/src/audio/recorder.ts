/**
 * audio/recorder.ts — WebRTC VAD
 *
 * Uses @echogarden/fvad-wasm (a WASM port of Google's WebRTC VAD) to robustly
 * distinguish human speech from background noise.
 *
 * During AI playback, the microphone also picks up speaker echo. WebRTC VAD
 * may classify that echo as speech and stay stuck in the "speaking" state,
 * making it miss a real user interruption. To handle this, the recorder can be
 * put into barge-in mode via setBargeInMode(true). In that mode, a confirmed
 * speech frame is only reported as a barge-in if its RMS energy is above a
 * threshold high enough to reject quiet echo but accept a user speaking nearby.
 */

import fvadFactory from "@echogarden/fvad-wasm";

const SAMPLE_RATE = 16_000;

// ── Timing constants (in frames) ─────────────────────────────────────────────
const SPEECH_PAD_FRAMES = 4;  // 120 ms consecutive speech to confirm voice start
const MIN_SPEECH_FRAMES = 10; // ~300 ms minimum — rejects room echo & micro clicks
const REDEMPTION_FRAMES = 34; // ~1000 ms silence hangover

// ── Barge-in energy threshold ──────────────────────────────────────────────────
// Filters out background noise, TTS echo, and breath exhales (< 0.015 RMS).
// Audible conversational human voice typically ranges from 0.015 to 0.04 RMS.
const BARGE_IN_RMS_THRESHOLD = 0.015;
// 5 consecutive frames (~150ms) rejects breath puffs/clicks/TTS bleeding while detecting real spoken words
const BARGE_IN_SPEECH_FRAMES = 5; 

// ── Sensitivity presets ──────────────────────────────────────────────────────
// WebRTC VAD mode: 0 (least aggressive) to 3 (most aggressive at filtering out noise).
// Note: "high sensitivity" means it triggers easily (so mode 0/1).
// "Low sensitivity" means it demands clearer speech (mode 3).
export const SENSITIVITY_PRESETS = {
  low:    { mode: 3 }, // Aggressive noise filtering (needs loud/clear speech)
  medium: { mode: 2 }, // Balanced
  high:   { mode: 0 }, // Very sensitive to any speech-like sound
} as const;
export type SensitivityLevel = keyof typeof SENSITIVITY_PRESETS;

export interface RecorderOptions {
  onChunk: (data: Int16Array) => void;
  /** Fired when the VAD transitions from idle to speaking (normal mode). */
  onSpeechDetected?: () => void;
  /** Fired during barge-in mode when a high-energy speech frame is detected. */
  onBargeIn?: () => void;
  onSilenceDetected?: () => void;
}

type VADState = "idle" | "speaking";

export class AudioStreamRecorder {
  // Web Audio
  private audioContext:  AudioContext       | null = null;
  private mediaStream:   MediaStream        | null = null;
  private workletNode:   AudioWorkletNode   | null = null;

  // WebRTC VAD (WASM)
  private fvadModule: any = null;
  private fvadInst: number = 0;
  private fvadBufferPtr: number = 0;

  // Callbacks
  private readonly onChunk:           (data: Int16Array) => void;
  private readonly onSpeechDetected?: () => void;
  private readonly onBargeIn?:        () => void;
  private readonly onSilenceDetected?: () => void;

  // Settings
  private sensitivity: SensitivityLevel = "medium";
  private bargeInMode = false;

  // VAD state
  private vadState:           VADState = "idle";
  private speechFrameCount    = 0;  // consecutive confirmed-speech frames
  private silenceFrameCount   = 0;  // consecutive non-speech frames during speaking
  private totalSpeechFrames   = 0;  // total speech frames in current utterance
  // Barge-in debounce counter (resets when a non-speech/high-energy frame occurs).
  private bargeInSpeechCount  = 0;

  // Adaptive User Voice Calibration (learns user's actual speaking voice volume)
  private userVoiceSum        = 0;
  private userVoiceFrameCount = 0;
  private measuredUserVoiceRMS = 0;

  constructor(opts: RecorderOptions) {
    this.onChunk           = opts.onChunk;
    this.onSpeechDetected  = opts.onSpeechDetected;
    this.onBargeIn         = opts.onBargeIn;
    this.onSilenceDetected = opts.onSilenceDetected;
  }

  setSensitivity(level: SensitivityLevel): void {
    this.sensitivity = level;
    if (this.fvadModule && this.fvadInst) {
      const mode = this.bargeInMode ? 1 : SENSITIVITY_PRESETS[level].mode;
      this.fvadModule._fvad_set_mode(this.fvadInst, mode);
    }
  }

  /**
   * Enable/disable barge-in mode.
   * When enabled, the recorder will report high-energy speech frames via
   * onBargeIn even if the underlying VAD is already in a "speaking" state.
   */
  setBargeInMode(enabled: boolean): void {
    this.bargeInMode = enabled;
    this.bargeInSpeechCount = 0;
    if (this.fvadModule && this.fvadInst) {
      // Mode 1 targets voiced speech formants while rejecting unvoiced breath noise
      const mode = enabled ? 1 : SENSITIVITY_PRESETS[this.sensitivity].mode;
      this.fvadModule._fvad_set_mode(this.fvadInst, mode);
    }
  }

  resetVAD(): void {
    this.vadState = "idle";
    this.speechFrameCount = 0;
    this.silenceFrameCount = 0;
    this.totalSpeechFrames = 0;
    this.bargeInSpeechCount = 0;
    this.bargeInMode = false;
    if (this.fvadModule && this.fvadInst) {
      this.fvadModule._fvad_set_mode(this.fvadInst, SENSITIVITY_PRESETS[this.sensitivity].mode);
    }
  }

  async start(): Promise<void> {
    this.resetVAD();
    this.bargeInMode = false;

    try {
      // ── 0. Initialize WebRTC VAD WASM module ─────────────────────────────
      if (!this.fvadModule) {
        this.fvadModule = await fvadFactory();
        this.fvadInst = this.fvadModule._fvad_new();
        this.fvadModule._fvad_set_sample_rate(this.fvadInst, SAMPLE_RATE);
        this.fvadModule._fvad_set_mode(this.fvadInst, SENSITIVITY_PRESETS[this.sensitivity].mode);
        // Allocate buffer for 480 Int16 samples (960 bytes)
        this.fvadBufferPtr = this.fvadModule._malloc(480 * 2);
      }

      // ── 1. Open microphone ───────────────────────────────────────────────
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount:    1,
          sampleRate:      SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl:  true,
        },
      });

      // ── 2. Set up AudioWorklet ───────────────────────────────────────────
      this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }

      await this.audioContext.audioWorklet.addModule(
        `/worklet.js?v=${Date.now()}`
      );

      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.workletNode = new AudioWorkletNode(
        this.audioContext,
        "recorder-worklet"
      );

      // ── 3. Process frames from worklet ───────────────────────────────────
      this.workletNode.port.onmessage = (event: MessageEvent) => {
        const { audio } = event.data as { audio: Float32Array };
        if (!audio || audio.length === 0) return;

        // Convert Float32 → Int16 PCM
        const int16 = new Int16Array(audio.length);
        for (let i = 0; i < audio.length; i++) {
          const clamped = Math.max(-1, Math.min(1, audio[i]));
          int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
        }

        this.onChunk(int16);
        this._step(int16, audio);
      };

      // ── 4. Wire up the audio graph ───────────────────────────────────────
      source.connect(this.workletNode);
      const silentGain = this.audioContext.createGain();
      silentGain.gain.value = 0;
      this.workletNode.connect(silentGain);
      silentGain.connect(this.audioContext.destination);

    } catch (err) {
      console.error("[Recorder] Failed to start:", err);
      throw err;
    }
  }

  stop(): void {
    this.workletNode?.disconnect();
    this.workletNode = null;
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    this.audioContext?.close();
    this.audioContext = null;
    // We intentionally don't free the WASM module/buffer here so we can reuse
    // it on the next turn without reallocating.
  }

  // ── VAD state machine ─────────────────────────────────────────────────────

  private _step(frame: Int16Array, float32: Float32Array): void {
    if (!this.fvadModule || !this.fvadInst || frame.length !== 480) return;

    // Copy Int16 frame into WASM heap
    this.fvadModule.HEAP16.set(frame, this.fvadBufferPtr >> 1);

    // Process: 1 = speech, 0 = silence, -1 = error
    const rawSpeech = this.fvadModule._fvad_process(this.fvadInst, this.fvadBufferPtr, frame.length) === 1;
    const currentRms = computeRMS(float32);

    // Filter out low-level room noise/fan static (< 0.0025 RMS) to prevent false-positive speech
    const isSpeech = rawSpeech && currentRms >= 0.0025;

    // ── Adaptive Calibration: Learn user's voice energy while they speak ─────
    if (!this.bargeInMode && this.vadState === "speaking" && isSpeech && currentRms > 0.003) {
      this.userVoiceSum += currentRms;
      this.userVoiceFrameCount++;
      this.measuredUserVoiceRMS = this.userVoiceSum / this.userVoiceFrameCount;
    }

    // Dynamic threshold adapts to 75% of the user's measured voice volume,
    // clamped between a safe noise floor (0.015) and 0.04.
    const dynamicThreshold = this.measuredUserVoiceRMS > 0.003
      ? Math.max(0.015, Math.min(0.04, this.measuredUserVoiceRMS * 0.75))
      : BARGE_IN_RMS_THRESHOLD;

    const highEnergyBargeIn = this.bargeInMode && isSpeech && currentRms >= dynamicThreshold;

    if (highEnergyBargeIn) {
      this.bargeInSpeechCount++;
      if (this.bargeInSpeechCount >= BARGE_IN_SPEECH_FRAMES) {
        this.bargeInSpeechCount = 0;
        console.log(`[VAD] Dynamic Barge-in detected (rms=${currentRms.toFixed(4)}, target=${dynamicThreshold.toFixed(4)}, userCalibrated=${this.measuredUserVoiceRMS.toFixed(4)})`);
        this.onBargeIn?.();
      }
    } else {
      this.bargeInSpeechCount = 0;
    }

    switch (this.vadState) {
      case "idle": {
        if (isSpeech) {
          this.speechFrameCount++;
          if (this.speechFrameCount >= SPEECH_PAD_FRAMES) {
            this.vadState          = "speaking";
            this.totalSpeechFrames = this.speechFrameCount;
            this.silenceFrameCount = 0;
            this.onSpeechDetected?.();
          }
        } else {
          this.speechFrameCount = Math.max(0, this.speechFrameCount - 1);
        }
        break;
      }

      case "speaking": {
        if (isSpeech) {
          this.totalSpeechFrames++;
          // Instead of wiping out silence progress to 0 on isolated noise frames,
          // decrement by 2 so ambient clicks/breath noise don't stall silence detection indefinitely.
          this.silenceFrameCount = Math.max(0, this.silenceFrameCount - 2);
        } else {
          this.silenceFrameCount++;

          if (this.silenceFrameCount >= REDEMPTION_FRAMES) {
            if (this.totalSpeechFrames >= MIN_SPEECH_FRAMES) {
              this.onSilenceDetected?.();
            } else {
              console.debug(`[VAD] Suppressed micro-utterance`);
            }
            this.resetVAD();
          }
        }
        break;
      }
    }
  }
}

function computeRMS(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    sum += s * s;
  }
  return Math.sqrt(sum / samples.length);
}
