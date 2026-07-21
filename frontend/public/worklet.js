/**
 * worklet.js — AudioWorklet processor
 *
 * Buffers 480 samples (30 ms @ 16 kHz) and sends them to the main thread.
 * WebRTC VAD strictly requires 10, 20, or 30ms frames.
 */
class RecorderWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufferSize = 480;
    this.buffer     = new Float32Array(this.bufferSize);
    this.framesWritten = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channelData = input[0];
    for (let i = 0; i < channelData.length; i++) {
      this.buffer[this.framesWritten++] = channelData[i];

      if (this.framesWritten >= this.bufferSize) {
        const frameToSend = this.buffer;
        this.buffer = new Float32Array(this.bufferSize);
        this.framesWritten = 0;

        // Transfer the buffer to the main thread (zero-copy)
        this.port.postMessage({ audio: frameToSend }, [frameToSend.buffer]);
      }
    }
    return true; 
  }
}

registerProcessor('recorder-worklet', RecorderWorkletProcessor);