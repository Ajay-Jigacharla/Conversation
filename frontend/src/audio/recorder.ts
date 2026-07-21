/**
 * audio/recorder.ts — WebRTC VAD
 *
 * Uses @echogarden/fvad-wasm (a WASM port of Google's WebRTC VAD) to robustly
 * distinguish human speech from background noise.
 */
import fvadFactory from "@echogarden/fvad-wasm";

const SAMPLE_RATE = 16_000;

// ── Timing constants (in frames) ─────────────────────────────────────────────
const SPEECH_PAD_FRAMES = 4;  // 120 ms consecutive speech to confirm voice start
const MIN_SPEECH_FRAMES = 6;  // 180 ms minimum — rejects isolated clicks
const REDEMPTION_FRAMES = 34; // ~1000 ms silence hangover

// ── Sensitivity presets ──────────────────────────────────────────────────────
// WebRTC VAD mode: 0 (least aggressive) to 3 (most aggressive at filtering out noise).
// Note: "high sensitivity" means it triggers easily (so mode 0/1).
// "Low sensitivity" means it demands clearer speech (mode 3).
export const SENSITIVITY_PRESETS = {
  low: { mode: 3 }, // Aggressive noise filtering (needs loud/clear speech)
  medium: { mode: 2 }, // Balanced
  high: { mode: 0 }, // Very sensitive to any speech-like sound
} as const;
export type SensitivityLevel = keyof typeof SENSITIVITY_PRESETS;

export interface RecorderOptions {
  onChunk: (data: Int16Array) => void;
  onSpeechDetected?: () => void;
  onSilenceDetected?: () => void;
}

type VADState = "idle" | "speaking";

export class AudioStreamRecorder {
  // Web Audio
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;

  // WebRTC VAD (WASM)
  private fvadModule: any = null;
  private fvadInst: number = 0;
  private fvadBufferPtr: number = 0;

  // Callbacks
  private readonly onChunk: (data: Int16Array) => void;
  private readonly onSpeechDetected?: () => void;
  private readonly onSilenceDetected?: () => void;

  // Settings
  private sensitivity: SensitivityLevel = "medium";

  // VAD state
  private vadState: VADState = "idle";
  private speechFrameCount = 0;  // consecutive confirmed-speech frames
  private silenceFrameCount = 0;  // consecutive non-speech frames during speaking
  private totalSpeechFrames = 0;  // total speech frames in current utterance

  constructor(opts: RecorderOptions) {
    this.onChunk = opts.onChunk;
    this.onSpeechDetected = opts.onSpeechDetected;
    this.onSilenceDetected = opts.onSilenceDetected;
  }

  setSensitivity(level: SensitivityLevel): void {
    this.sensitivity = level;
    if (this.fvadModule && this.fvadInst) {
      this.fvadModule._fvad_set_mode(this.fvadInst, SENSITIVITY_PRESETS[level].mode);
    }
  }

  resetVAD(): void {
    this.vadState = "idle";
    this.speechFrameCount = 0;
    this.silenceFrameCount = 0;
    this.totalSpeechFrames = 0;
    if (this.fvadModule && this.fvadInst) {
      this.fvadModule._fvad_reset(this.fvadInst);
    }
  }

  async start(): Promise<void> {
    this.resetVAD();

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
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // ── 2. Set up AudioWorklet ───────────────────────────────────────────
      this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });

      // Browsers may start the AudioContext in a suspended state; resume it now
      // while we're inside a user gesture (the orb click that triggered start).
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
        this._step(int16);
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

  private _step(frame: Int16Array): void {
    if (!this.fvadModule || !this.fvadInst || frame.length !== 480) return;

    // Copy Int16 frame into WASM heap
    this.fvadModule.HEAP16.set(frame, this.fvadBufferPtr >> 1);

    // Process: 1 = speech, 0 = silence, -1 = error
    const isSpeech = this.fvadModule._fvad_process(this.fvadInst, this.fvadBufferPtr, frame.length) === 1;

    switch (this.vadState) {
      case "idle": {
        if (isSpeech) {
          this.speechFrameCount++;
          if (this.speechFrameCount >= SPEECH_PAD_FRAMES) {
            this.vadState = "speaking";
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
          this.silenceFrameCount = 0;
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
