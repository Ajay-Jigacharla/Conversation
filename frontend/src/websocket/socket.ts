/**
 * websocket/socket.ts
 * Manages the WebSocket connection to FastAPI for streaming audio and receiving JSON updates.
 */

import type { Turn } from "../services/api";

const WS_BASE = (import.meta.env.VITE_API_URL ?? "http://localhost:8000").replace("http", "ws");

export type SocketCallbacks = {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onLLMResponse: (text: string) => void;
  onAudioResult: (buffer: ArrayBuffer) => void;
  onAudioDone?: () => void;
  onNoSpeech?: () => void;
  onError: (msg: string) => void;
};

export interface StreamingClientOptions extends SocketCallbacks {
  history?: Turn[];
}

export class StreamingClient {
  private ws: WebSocket | null = null;
  private callbacks: SocketCallbacks;
  private history: Turn[];
  private aborted = false;

  constructor(opts: StreamingClientOptions) {
    this.callbacks = opts;
    this.history = opts.history ?? [];
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_BASE}/ws/stream`);
      this.ws.binaryType = "arraybuffer";

      this.ws.onopen = () => {
        // Send conversation history immediately, before audio chunks.
        if (this.history.length > 0) {
          this.ws?.send(JSON.stringify({ type: "history", history: this.history }));
        }
        resolve();
      };

      this.ws.onerror = (e) => {
        if (this.aborted) return;
        console.error("WebSocket error:", e);
        this.callbacks.onError("WebSocket connection failed.");
        reject(e);
      };

      this.ws.onmessage = (event) => {
        if (this.aborted) return;

        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);
            if (data.type === "partial") {
              this.callbacks.onPartial(data.text);
            } else if (data.type === "final_transcript") {
              this.callbacks.onFinal(data.text);
            } else if (data.type === "llm_partial") {
              this.callbacks.onLLMResponse(data.text);
            } else if (data.type === "audio_done") {
              this.callbacks.onAudioDone?.();
            } else if (data.type === "no_speech") {
              this.callbacks.onNoSpeech?.();
            } else if (data.type === "error") {
              this.callbacks.onError(data.message);
            }
          } catch (e) {
            console.error("Error parsing WS message:", e);
          }
        } else if (event.data instanceof ArrayBuffer) {
          // Binary data means a TTS WAV chunk has arrived.
          this.callbacks.onAudioResult(event.data);
        }
      };

      this.ws.onclose = () => {
        // Websocket closed
      };
    });
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  sendAudioChunk(chunk: Int16Array) {
    if (this.isOpen()) {
      // Int16Array is a valid BufferSource; sending the typed array avoids
      // the SharedArrayBuffer typing pitfall of `.buffer`.
      this.ws!.send(chunk as unknown as ArrayBuffer);
    }
  }

  stop() {
    // Sending a stop message tells the backend to finalize and return results.
    // The backend will close the socket once it finishes sending the audio.
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "stop" }));
    }
  }

  interrupt() {
    // Immediate cancellation. Send interrupt to kill backend tasks, then disconnect.
    // After this, the old client's callbacks will be ignored so they cannot
    // override the new barge-in state.
    this.aborted = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "interrupt" }));
      this.ws.close();
    }
  }
}
