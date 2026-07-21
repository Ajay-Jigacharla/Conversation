/**
 * api.ts — Backend communication service
 *
 * Sends a recorded audio Blob to POST /chat and returns:
 *   - audioBuffer: ArrayBuffer of the WAV response
 *   - transcript:  what Whisper heard
 *   - response:    what the LLM said
 */

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export type ChatRole = "user" | "assistant";

export interface Turn {
  role: ChatRole;
  content: string;
  timestamp?: string;
}

export interface ChatResult {
  audioBuffer: ArrayBuffer;
  transcript: string;
  response: string;
}

export async function sendAudio(audioBlob: Blob, history: Turn[] = []): Promise<ChatResult> {
  const form = new FormData();
  form.append("audio", audioBlob, "recording.webm");
  form.append("history", JSON.stringify(history));

  const res = await fetch(`${API_BASE}/chat`, {
    method: "POST",
    body: form,
  });

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      detail = json.detail ?? detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }

  const audioBuffer = await res.arrayBuffer();
  const transcript  = decodeURIComponent(res.headers.get("X-Transcript") ?? "");
  const response    = decodeURIComponent(res.headers.get("X-Response")   ?? "");

  return { audioBuffer, transcript, response };
}

export async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
