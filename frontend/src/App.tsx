import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceOrb, type OrbState } from "./components/VoiceOrb";
import { AudioStreamRecorder, type SensitivityLevel } from "./audio/recorder";
import { StreamingClient } from "./websocket/socket";
import { checkHealth, type Turn } from "./services/api";
import { AudioPlaybackQueue } from "./audio/playback";

/** UI turn shape shown in the conversation history panel. */
interface HistoryItem {
  transcript: string;
  response: string;
  timestamp: string;
}

/** Convert completed UI history to the backend's {role, content} turn format. */
function toBackendTurns(history: HistoryItem[]): Turn[] {
  const turns: Turn[] = [];
  // history is stored newest-first; backend expects chronological order.
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    turns.push({ role: "user", content: h.transcript });
    if (h.response) {
      turns.push({ role: "assistant", content: h.response });
    }
  }
  return turns;
}

export default function App() {
  const [orbState, setOrbState] = useState<OrbState>("idle");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [backendOk, setBackendOk] = useState<boolean | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // Streaming state
  const [liveTranscript, setLiveTranscript] = useState<string>("");

  // Auto-stop (VAD) settings
  const [autoStop, setAutoStop] = useState<boolean>(true);
  const [sensitivity, setSensitivity] = useState<SensitivityLevel>("medium");

  const recorderRef = useRef<AudioStreamRecorder | null>(null);
  const wsClientRef = useRef<StreamingClient | null>(null);
  const playbackQueueRef = useRef<AudioPlaybackQueue | null>(null);
  const currentResponseRef = useRef<string>("");
  // Current turn being built in-flight (transcript + response).
  const pendingTurnRef = useRef<HistoryItem | null>(null);
  // Ref copy of completed history to pass into new connections without the in-flight turn.
  const historyRef = useRef<HistoryItem[]>([]);
  useEffect(() => { historyRef.current = history; }, [history]);

  // Refs mirroring state so the VAD callback (created once) reads fresh values.
  const autoStopRef = useRef<boolean>(autoStop);
  useEffect(() => { autoStopRef.current = autoStop; }, [autoStop]);
  const sensitivityRef = useRef<SensitivityLevel>(sensitivity);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);

  const orbStateRef = useRef<OrbState>(orbState);
  useEffect(() => { orbStateRef.current = orbState; }, [orbState]);
  // True while the AI is speaking; used to ignore echo-induced VAD speech.
  const isSpeakingRef = useRef<boolean>(false);
  // Guard so a queued VAD fire doesn't trigger stop after the user already stopped.
  const stopGuardRef = useRef<boolean>(false);
  // Buffer of recent audio frames captured while not actively streaming (e.g. during playback).
  // Flushed into a new WebSocket when barge-in starts, so the start of speech isn't lost.
  const preRollRef = useRef<Int16Array[]>([]);
  // True while we're waiting for a new WebSocket connection after barge-in.
  const reconnectingRef = useRef<boolean>(false);

  // Health check on mount
  useEffect(() => {
    checkHealth().then((ok) => {
      setBackendOk(ok);
      setStatus(ok ? "Backend connected. Ready to stream." : "⚠ Backend offline — start the FastAPI server.");
    });
  }, []);

  // ── Stop the current turn: stop mic + tell backend to finalize ───────
  // Triggered by the manual "stop" click.
  const stopRecording = useCallback(() => {
    setOrbState("processing");
    setStatus("Finalizing pipeline (LLM → TTS)…");

    if (recorderRef.current) {
      recorderRef.current.resetVAD();
    }
    if (wsClientRef.current) {
      wsClientRef.current.stop(); // Closes the WS, triggering backend finalizing
    }
  }, []);

  const handleOrbClick = useCallback(async () => {
    setError(null);

    if (orbState === "recording") {
      stopGuardRef.current = true;
      stopRecording();
      return;
    }

    // Either idle (new turn) or playing (manual barge-in).
    const isBargeIn = orbState === "playing";

    const createClientAndConnect = async () => {
      playbackQueueRef.current?.stop();
      isSpeakingRef.current = false;
      reconnectingRef.current = true;
      playbackQueueRef.current = new AudioPlaybackQueue(() => {
        isSpeakingRef.current = false;
        const completed = pendingTurnRef.current;
        if (completed) {
          completed.response = currentResponseRef.current;
          setHistory((h) => {
            const idx = h.findIndex((t) => t === completed);
            if (idx >= 0) {
              const newH = [...h];
              newH[idx] = completed;
              return newH;
            }
            return [completed, ...h];
          });
          pendingTurnRef.current = null;
        }
        setOrbState("idle");
        setStatus("Done. Tap to speak again.");
        setLiveTranscript("");
      });

      const priorHistory = toBackendTurns(historyRef.current);
      const client = new StreamingClient({
        history: priorHistory,
        onPartial: (text) => setLiveTranscript(text),
        onFinal: (text) => {
          setLiveTranscript(text);
          currentResponseRef.current = "";
          pendingTurnRef.current = {
            transcript: text,
            response: "",
            timestamp: new Date().toLocaleTimeString(),
          };
        },
        onLLMResponse: (text) => {
          setStatus("Generating voice response…");
          currentResponseRef.current += text + " ";
          const draft = pendingTurnRef.current;
          if (draft) {
            draft.response = currentResponseRef.current;
            setHistory((h) => {
              if (h.length > 0 && h[0] === draft) return h;
              return [draft, ...h];
            });
          }
        },
        onAudioResult: async (buffer) => {
          isSpeakingRef.current = true;
          setOrbState("playing");
          setStatus("Playing response…");
          await playbackQueueRef.current?.enqueue(buffer);
        },
        onAudioDone: () => {
          playbackQueueRef.current?.finish();
        },
        onError: (msg) => {
          setError(`Streaming error: ${msg}`);
          setOrbState("idle");
          setStatus("Something went wrong.");
          isSpeakingRef.current = false;
          reconnectingRef.current = false;
          playbackQueueRef.current?.stop();
          recorderRef.current?.stop();
        }
      });
      wsClientRef.current = client;
      await client.connect();

      // Connection is ready: flush any buffered pre-roll frames, then resume normal streaming.
      reconnectingRef.current = false;
      const buffered = preRollRef.current;
      preRollRef.current = [];
      for (const frame of buffered) {
        if (client.isOpen()) client.sendAudioChunk(frame);
      }
    };

    if (isBargeIn) {
      // Manual barge-in: kill the active response and open a fresh connection.
      stopGuardRef.current = false;
      playbackQueueRef.current?.stop();
      wsClientRef.current?.interrupt();
      setLiveTranscript("");
      setOrbState("recording");
      setStatus("Interrupted. Listening…");

      try {
        await createClientAndConnect();
        recorderRef.current?.resetVAD();
      } catch (e: any) {
        setError(e.message || "Barge-in connection failed.");
        setOrbState("idle");
        reconnectingRef.current = false;
      }
      return;
    }

    if (orbState !== "idle") return;

    // Start recording and streaming
    stopGuardRef.current = false;
    setLiveTranscript("");
    setOrbState("recording");
    setStatus("Listening…");

    try {
      await createClientAndConnect();

      const recorder = new AudioStreamRecorder({
        onChunk: (chunk) => {
          // While reconnecting after barge-in, buffer chunks so we don't lose the start of speech.
          if (reconnectingRef.current) {
            preRollRef.current.push(chunk);
            // Keep only the last ~1.5 s of pre-roll (30 ms frames = ~33 fps).
            if (preRollRef.current.length > 50) preRollRef.current.shift();
            return;
          }

          if (orbStateRef.current === "recording" && wsClientRef.current?.isOpen()) {
            wsClientRef.current.sendAudioChunk(chunk);
          } else {
            // Not actively streaming: keep a short rolling buffer for barge-in.
            preRollRef.current.push(chunk);
            if (preRollRef.current.length > 50) preRollRef.current.shift();
          }
        },
        onSpeechDetected: () => {
          // Ignore the AI's own voice while it is speaking through the speakers.
          if (isSpeakingRef.current) return;

          const state = orbStateRef.current;
          if (state === "playing" || state === "processing") {
            console.log("Barge-in detected!");
            playbackQueueRef.current?.stop();
            wsClientRef.current?.interrupt();
            setLiveTranscript("");
            setOrbState("recording");
            setStatus("Interrupted. Listening…");
            stopGuardRef.current = false;

            createClientAndConnect()
              .then(() => {
                // Fresh VAD state for the new question.
                recorderRef.current?.resetVAD();
              })
              .catch((e) => {
                setError("Barge-in reconnect failed: " + e.message);
                setOrbState("idle");
                reconnectingRef.current = false;
              });
          }
        },
        onSilenceDetected: () => {
          if (!autoStopRef.current || stopGuardRef.current || orbStateRef.current !== "recording") return;
          stopGuardRef.current = true;
          setStatus("Silence detected — finalizing…");
          stopRecording();
        }
      });

      recorder.setSensitivity(sensitivityRef.current);
      recorderRef.current = recorder;
      await recorder.start();
    } catch (e: any) {
      setError(e.message || "Failed to start recorder/websocket.");
      setOrbState("idle");
    }
  }, [orbState, liveTranscript, stopRecording]);

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <span className="logo-icon">◈</span>
          <span className="logo-text">VoiceArch Streaming</span>
        </div>
        <div className={`backend-badge ${backendOk === true ? "badge--ok" : backendOk === false ? "badge--err" : "badge--pending"}`}>
          <span className="badge-dot" />
          {backendOk === true ? "Backend Online" : backendOk === false ? "Backend Offline" : "Checking…"}
        </div>
      </header>

      <div className="pipeline-strip">
        {["🎤 Worklet", "⚡ WS Stream", "⚡ Whisper", "🧠 kimi-k2.7", "🔊 KittenTTS"].map((label, i) => (
          <div key={i} className="pipeline-step">
            <span>{label}</span>
            {i < 4 && <span className="pipeline-arrow">→</span>}
          </div>
        ))}
      </div>

      <main className="main">
        <div className="glass-card orb-card">
          <VoiceOrb state={orbState} onClick={handleOrbClick} />
          {status && <p className="status-text">{status}</p>}

          {/* Auto-Stop (VAD) controls */}
          <div className="vad-controls">
            <label className="vad-toggle">
              <input
                type="checkbox"
                checked={autoStop}
                onChange={(e) => setAutoStop(e.target.checked)}
                disabled={orbState === "recording"}
              />
              <span className="vad-toggle-track"><span className="vad-toggle-thumb" /></span>
              <span className="vad-toggle-label">Auto-Stop on Silence</span>
            </label>
            {autoStop && (
              <div className="vad-sensitivity">
                <span className="vad-sensitivity-label">Sensitivity</span>
                {(["low", "medium", "high"] as SensitivityLevel[]).map((lvl) => (
                  <button
                    key={lvl}
                    className={`vad-chip ${sensitivity === lvl ? "vad-chip--active" : ""}`}
                    onClick={() => {
                      setSensitivity(lvl);
                      recorderRef.current?.setSensitivity(lvl);
                    }}
                    disabled={orbState === "recording"}
                  >
                    {lvl}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Live Transcript Display */}
          {liveTranscript && orbState === "recording" && (
            <div className="live-transcript">
              <span className="live-transcript-label">Live:</span>
              <p className="live-transcript-text">{liveTranscript}</p>
            </div>
          )}

          {error && <p className="error-text">⚠ {error}</p>}
        </div>
      </main>

      {history.length > 0 && (
        <section className="history-section">
          <h2 className="history-title">Conversation</h2>
          <div className="history-list">
            {history.map((turn, i) => (
              <div key={i} className="turn-card glass-card">
                <div className="turn-time">{turn.timestamp}</div>
                <div className="turn-row turn-user">
                  <span className="turn-badge badge-user">You</span>
                  <p className="turn-text">{turn.transcript}</p>
                </div>
                <div className="turn-row turn-ai">
                  <span className="turn-badge badge-ai">AI</span>
                  <p className="turn-text">{turn.response}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
