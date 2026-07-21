/**
 * audio/playback.ts
 * Streams decoded WAV chunks into a single AudioContext schedule so that audio
 * starts playing as soon as the first chunk is ready, instead of waiting for
 * the whole response to finish.
 */

export type PlaybackDone = () => void;

export class AudioPlaybackQueue {
  private ctx: AudioContext | null = null;
  private nextPlayTime = 0;
  private pendingSources = 0;
  private onDone?: PlaybackDone;
  private done = false;

  constructor(onDone?: PlaybackDone) {
    this.onDone = onDone;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new AudioContext();
      this.nextPlayTime = this.ctx.currentTime;
    }
    return this.ctx;
  }

  /**
   * Decode and schedule a WAV ArrayBuffer to play in sequence.
   * First chunk starts as soon as it's decoded; later chunks are appended to
   * the end of the previous chunk for gapless playback.
   */
  async enqueue(wavBuffer: ArrayBuffer) {
    const ctx = this.ensureContext();
    const decoded = await ctx.decodeAudioData(wavBuffer);
    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);

    const playTime = Math.max(ctx.currentTime, this.nextPlayTime);
    source.start(playTime);
    this.nextPlayTime = playTime + decoded.duration;
    this.pendingSources++;

    source.onended = () => {
      this.pendingSources--;
      if (this.done && this.pendingSources === 0) {
        this.onDone?.();
      }
    };
  }

  /** Mark the queue as complete; onDone fires once the last chunk finishes. */
  finish() {
    this.done = true;
    if (this.pendingSources === 0) {
      this.onDone?.();
    }
  }

  /** Stop all scheduled audio immediately. */
  stop() {
    if (this.ctx && this.ctx.state !== "closed") {
      this.ctx.close();
      this.ctx = null;
    }
    this.pendingSources = 0;
    this.done = true;
  }
}