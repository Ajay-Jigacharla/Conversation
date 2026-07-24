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
  private decodingCount = 0; // Tracks buffers currently being asynchronously decoded
  private onDone?: PlaybackDone;
  private done = false;
  private stopped = false;

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

  private fireDone() {
    if (this.onDone) {
      const cb = this.onDone;
      this.onDone = undefined;
      cb();
    }
  }

  /**
   * Decode and schedule a WAV ArrayBuffer to play in sequence.
   * First chunk starts as soon as it's decoded; later chunks are appended to
   * the end of the previous chunk for gapless playback.
   */
  async enqueue(wavBuffer: ArrayBuffer) {
    if (this.stopped) return;
    this.decodingCount++;

    try {
      const ctx = this.ensureContext();
      const decoded = await ctx.decodeAudioData(wavBuffer);
      if (this.stopped) return;

      const source = ctx.createBufferSource();
      source.buffer = decoded;
      source.connect(ctx.destination);

      const playTime = Math.max(ctx.currentTime, this.nextPlayTime);
      source.start(playTime);
      this.nextPlayTime = playTime + decoded.duration;
      this.pendingSources++;

      source.onended = () => {
        if (this.stopped) return;
        this.pendingSources--;
        if (this.done && this.pendingSources === 0 && this.decodingCount === 0) {
          this.fireDone();
        }
      };
    } catch (err) {
      console.error("[AudioPlaybackQueue] Failed to decode WAV chunk:", err);
    } finally {
      this.decodingCount--;
      // Check if finish() was called while we were decoding this chunk
      if (this.done && this.pendingSources === 0 && this.decodingCount === 0 && !this.stopped) {
        this.fireDone();
      }
    }
  }

  /** Mark the queue as complete; onDone fires once the last chunk finishes playing. */
  finish() {
    if (this.stopped) return;
    this.done = true;
    if (this.pendingSources === 0 && this.decodingCount === 0) {
      this.fireDone();
    }
  }

  /** Stop all scheduled audio immediately and suppress the done callback. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ctx && this.ctx.state !== "closed") {
      this.ctx.close();
      this.ctx = null;
    }
    this.pendingSources = 0;
    this.decodingCount = 0;
    this.done = true;
  }
}
