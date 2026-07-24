import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceOrb, type OrbState } from "./components/VoiceOrb";
import { AudioStreamRecorder, type SensitivityLevel } from "./audio/recorder";
import { StreamingClient } from "./websocket/socket";
import { checkHealth, type Turn } from "./services/api";
import { AudioPlaybackQueue } from "./audio/playback";

/** Convert UI history (newest-first) to backend chronological order.
 *  Excludes the in-flight user turn that hasn't been answered yet. */
function toBackendTurns(history: Turn[], inFlightContent?: string): Turn[] {
  const turns: Turn[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    turns.push(history[i]);
  }
  if (inFlightContent) {
    turns.push({ role: "user", content: inFlightContent });
  }
  return turns;
}

export default function App() {
  const [orbState, setOrbState]     = useState<OrbState>("idle");
  const [status, setStatus]         = useState<string>("");
  const [error, setError]           = useState<string | null>(null);
  const [backendOk, setBackendOk]   = useState<boolean | null>(null);
  const [history, setHistory]       = useState<Turn[]>([]);

  // Streaming state
  const [liveTranscript, setLiveTranscript] = useState<string>("");

  // Auto-stop (VAD) settings
  const [autoStop, setAutoStop] = useState<boolean>(true);
  const [sensitivity, setSensitivity] = useState<SensitivityLevel>("medium");

  const recorderRef       = useRef<AudioStreamRecorder | null>(null);
  const wsClientRef       = useRef<StreamingClient | null>(null);
  const playbackQueueRef  = useRef<AudioPlaybackQueue | null>(null);

  // Current user turn being transcribed.
  const inFlightUserRef = useRef<Turn | null>(null);
  // Accumulated assistant response for the current turn.
  const partialResponseRef = useRef<string>("");

  // Ref copy of completed history to pass into new connections.
  const historyRef = useRef<Turn[]>([]);
  useEffect(() => { historyRef.current = history; }, [history]);

  // Refs mirroring state so callbacks created once read fresh values.
  const autoStopRef = useRef<boolean>(autoStop);
  useEffect(() => { autoStopRef.current = autoStop; }, [autoStop]);
  const sensitivityRef = useRef<SensitivityLevel>(sensitivity);
  useEffect(() => { sensitivityRef.current = sensitivity; }, [sensitivity]);
  const orbStateRef = useRef<OrbState>(orbState);
  useEffect(() => { orbStateRef.current = orbState; }, [orbState]);

  const setOrbStateSync = useCallback((state: OrbState) => {
    orbStateRef.current = state;
    setOrbState(state);
  }, []);

  // True while the AI is speaking.
  const isSpeakingRef = useRef<boolean>(false);

  // ── stopGuardRef ────────────────────────────────────────────────────────────
  // True when silence auto-stop must be suppressed.
  // Set to TRUE by: onSilenceDetected (after it fires, to prevent double-fire),
  //                 and manual orb click during recording.
  // Set to FALSE by: fresh turn start (handleOrbClick line ~295),
  //                  and after WS reconnect + resetVAD completes (auto-listen path).
  // NEVER touched inside startNewTurn — that way Turn 1 keeps stopGuard=false
  // as set by handleOrbClick, and Turn 2+ restores it via the .then() callback.
  const stopGuardRef = useRef<boolean>(false);

  // True while a new WebSocket is being established.
  const reconnectingRef = useRef<boolean>(false);
  // Queues silence stop if silence was detected while WS was connecting.
  const pendingSilenceStopRef = useRef<boolean>(false);

  // Prevents concurrent auto barge-ins from firing multiple reconnects.
  const bargeInInProgressRef = useRef<boolean>(false);

  // Buffer of recent audio frames captured while not actively streaming.
  const preRollRef = useRef<Int16Array[]>([]);

  // Reference to the currently active StreamingClient; stale clients are ignored.
  const activeClientRef = useRef<StreamingClient | null>(null);

  // Health check on mount
  useEffect(() => {
    checkHealth().then((ok) => {
      setBackendOk(ok);
      setStatus(ok ? "Backend connected. Ready to stream." : "⚠ Backend offline — start the FastAPI server.");
    });
  }, []);

  // ── Commit the current assistant response as an interrupted turn ───────
  const commitInterruptedTurn = useCallback(() => {
    const userTurn = inFlightUserRef.current;
    const partialResponse = partialResponseRef.current.trim();

    setHistory((h) => {
      const turns: Turn[] = [];
      if (userTurn) turns.push(userTurn);
      if (partialResponse) {
        turns.push({ role: "assistant", content: partialResponse, interrupted: true });
      }
      return [...turns, ...h];
    });

    inFlightUserRef.current = null;
    partialResponseRef.current = "";
  }, []);

  // ── Stop the current turn: tell backend to finalize ───────────────────
  const stopRecording = useCallback(() => {
    setOrbStateSync("processing");
    setStatus("Finalizing pipeline (LLM → TTS)…");

    if (recorderRef.current) {
      recorderRef.current.resetVAD();
    }
    if (wsClientRef.current) {
      wsClientRef.current.stop();
    }
  }, [setOrbStateSync]);

  // ── Stable ref to startNewTurn so closures (playbackQueue.onDone, onBargeIn)
  //    always call the latest version without stale captures. ────────────────
  const createClientAndConnectRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // ── startNewTurn ──────────────────────────────────────────────────────────
  const startNewTurn = useCallback(async () => {
    playbackQueueRef.current?.stop();
    isSpeakingRef.current = false;
    pendingSilenceStopRef.current = false;
    reconnectingRef.current = true;   // ← blocks onSilenceDetected during WS connect

    playbackQueueRef.current = new AudioPlaybackQueue(() => {
      // ── onDone: AI finished speaking → auto-listen for next turn ──────
      isSpeakingRef.current = false;

      // Clean VAD and arm silence guard synchronously right as listening begins
      recorderRef.current?.setBargeInMode(false);
      recorderRef.current?.resetVAD();
      stopGuardRef.current = false;
      preRollRef.current = [];

      // Commit completed turn to history.
      const userTurn = inFlightUserRef.current;
      const response = partialResponseRef.current.trim();
      if (userTurn || response) {
        setHistory((h) => {
          const turns: Turn[] = [];
          if (userTurn) turns.push(userTurn);
          if (response) turns.push({ role: "assistant", content: response });
          return [...turns, ...h];
        });
      }
      inFlightUserRef.current = null;
      partialResponseRef.current = "";

      // Switch orb to listening mode immediately so the user sees feedback.
      setLiveTranscript("");
      setOrbStateSync("recording");
      setStatus("Listening…");

      // Open a fresh WebSocket for Turn N+1 in background.
      createClientAndConnectRef.current()
        .catch((e) => {
          console.error("Failed to auto-connect for next turn:", e);
          stopGuardRef.current = false;
          setOrbStateSync("idle");
          setStatus("Tap to speak.");
        });
    });

    const priorHistory = toBackendTurns(historyRef.current, inFlightUserRef.current?.content);

    const client = new StreamingClient({
      history: priorHistory,
      onPartial: (text) => setLiveTranscript(text),
      onFinal: (text) => {
        setLiveTranscript(text);
        partialResponseRef.current = "";
        inFlightUserRef.current = {
          role: "user",
          content: text,
          timestamp: new Date().toLocaleTimeString(),
        };
      },
      onLLMResponse: (text) => {
        setStatus("Generating voice response…");
        partialResponseRef.current += text + " ";

        const response = partialResponseRef.current.trim();
        const userTurn = inFlightUserRef.current;
        if (userTurn && response) {
          setHistory((h) => {
            const draftAssistant: Turn = { role: "assistant", content: response };
            const isSameUserAtTop =
              h.length >= 2 &&
              h[0].role === "assistant" &&
              h[1].role === "user" &&
              h[1].content === userTurn.content &&
              h[1].timestamp === userTurn.timestamp;

            if (isSameUserAtTop) {
              const newH = [...h];
              newH[0] = draftAssistant;
              return newH;
            }
            return [draftAssistant, userTurn, ...h];
          });
        }
      },
      onAudioResult: async (buffer) => {
        isSpeakingRef.current = true;
        recorderRef.current?.setBargeInMode(true);
        setOrbStateSync("playing");
        setStatus("Playing response…");
        await playbackQueueRef.current?.enqueue(buffer);
      },
      onAudioDone: () => {
        isSpeakingRef.current = false;
        recorderRef.current?.setBargeInMode(false);
        playbackQueueRef.current?.finish();
      },
      onNoSpeech: () => {
        console.log("[App] Backend reported no speech detected.");
        inFlightUserRef.current = null;
        partialResponseRef.current = "";
        setLiveTranscript("");
        recorderRef.current?.resetVAD();
        stopGuardRef.current = false;
        setOrbStateSync("recording");
        setStatus("Listening…");

        createClientAndConnectRef.current()
          .catch((e) => {
            console.error("Failed to auto-connect after no_speech:", e);
            stopGuardRef.current = false;
            setOrbStateSync("idle");
            setStatus("Tap to start continuous conversation.");
          });
      },
      onError: (msg) => {
        setError(`Streaming error: ${msg}`);
        setOrbStateSync("idle");
        setStatus("Something went wrong.");
        isSpeakingRef.current = false;
        reconnectingRef.current = false;
        stopGuardRef.current = false;
        playbackQueueRef.current?.stop();
        recorderRef.current?.stop();
      }
    });

    wsClientRef.current = client;
    activeClientRef.current = client;
    await client.connect();

    // WS open — flush pre-roll frames buffered during reconnect.
    reconnectingRef.current = false;
    const buffered = preRollRef.current;
    preRollRef.current = [];
    for (const frame of buffered) {
      if (activeClientRef.current === client && client.isOpen()) {
        client.sendAudioChunk(frame);
      }
    }

    // If silence occurred while WS was connecting, execute stop immediately now.
    if (pendingSilenceStopRef.current && orbStateRef.current === "recording") {
      console.log("[App] Executing queued silence stop after WS connected.");
      pendingSilenceStopRef.current = false;
      stopGuardRef.current = true;
      setStatus("Silence detected — finalizing…");
      stopRecording();
    }
  }, [setOrbStateSync, stopRecording]);

  useEffect(() => {
    createClientAndConnectRef.current = startNewTurn;
  }, [startNewTurn]);

  // ── handleOrbClick ────────────────────────────────────────────────────────
  const handleOrbClick = useCallback(async () => {
    setError(null);

    // ── Recording → manually stop ──────────────────────────────────────
    if (orbState === "recording") {
      stopGuardRef.current = true;
      stopRecording();
      return;
    }

    const isBargeIn = orbState === "playing" || orbState === "processing";

    // ── Playing / Processing → barge-in ───────────────────────────────
    if (isBargeIn) {
      if (bargeInInProgressRef.current) return;
      bargeInInProgressRef.current = true;
      stopGuardRef.current = false;
      isSpeakingRef.current = false;
      recorderRef.current?.setBargeInMode(false);
      recorderRef.current?.resetVAD();
      playbackQueueRef.current?.stop();
      wsClientRef.current?.interrupt();
      commitInterruptedTurn();
      setLiveTranscript("");
      setOrbStateSync("recording");
      setStatus("Interrupted. Listening…");

      try {
        await createClientAndConnectRef.current();
      } catch (e: any) {
        setError(e.message || "Barge-in connection failed.");
        setOrbStateSync("idle");
        reconnectingRef.current = false;
        stopGuardRef.current = false;
      } finally {
        bargeInInProgressRef.current = false;
      }
      return;
    }

    if (orbState !== "idle") return;

    // ── Idle → start fresh Turn 1 ──────────────────────────────────────
    stopGuardRef.current = false;
    setLiveTranscript("");
    setOrbStateSync("recording");
    setStatus("Listening…");

    try {
      await createClientAndConnectRef.current();

      const recorder = new AudioStreamRecorder({
        onChunk: (chunk) => {
          if (reconnectingRef.current) {
            preRollRef.current.push(chunk);
            if (preRollRef.current.length > 50) preRollRef.current.shift();
            return;
          }

          if (orbStateRef.current === "recording" && wsClientRef.current?.isOpen()) {
            wsClientRef.current.sendAudioChunk(chunk);
          } else {
            preRollRef.current.push(chunk);
            if (preRollRef.current.length > 50) preRollRef.current.shift();
          }
        },

        onSpeechDetected: () => {
          // VAD transitioned idle → speaking during normal recording.
        },

        onBargeIn: () => {
          if (reconnectingRef.current) return;
          if (bargeInInProgressRef.current) return;

          const state = orbStateRef.current;
          if (state === "playing" || state === "processing") {
            console.log("[App] Barge-in detected!");
            bargeInInProgressRef.current = true;
            stopGuardRef.current = false;
            isSpeakingRef.current = false;
            playbackQueueRef.current?.stop();
            recorderRef.current?.setBargeInMode(false);
            recorderRef.current?.resetVAD();
            wsClientRef.current?.interrupt();
            commitInterruptedTurn();
            setLiveTranscript("");
            setOrbStateSync("recording");
            setStatus("Interrupted. Listening…");

            createClientAndConnectRef.current()
              .catch((e) => {
                setError("Barge-in reconnect failed: " + e.message);
                setOrbStateSync("idle");
                stopGuardRef.current = false;
                reconnectingRef.current = false;
              })
              .finally(() => {
                bargeInInProgressRef.current = false;
              });
          }
        },

        onSilenceDetected: () => {
          if (
            !autoStopRef.current ||
            stopGuardRef.current ||
            orbStateRef.current !== "recording"
          ) return;

          stopGuardRef.current = true;   // prevent double-fire

          if (reconnectingRef.current) {
            console.log("[App] Silence detected during WS connect — queuing stop.");
            pendingSilenceStopRef.current = true;
            setStatus("Silence detected — finalizing…");
            return;
          }

          setStatus("Silence detected — finalizing…");
          stopRecording();
        },
      });

      recorder.setSensitivity(sensitivityRef.current);
      recorderRef.current = recorder;
      await recorder.start();
    } catch (e: any) {
      setError(e.message || "Failed to start recorder/websocket.");
      setOrbStateSync("idle");
    }
  }, [orbState, stopRecording, commitInterruptedTurn, setOrbStateSync]);

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
              <div key={i} className={`turn-card glass-card ${turn.interrupted ? "turn-card--interrupted" : ""}`}>
                <div className="turn-time">{turn.timestamp ?? ""}</div>
                <div className={`turn-row ${turn.role === "user" ? "turn-user" : "turn-ai"}`}>
                  <span className={`turn-badge ${turn.role === "user" ? "badge-user" : "badge-ai"}`}>
                    {turn.role === "user" ? "You" : turn.interrupted ? "AI (interrupted)" : "AI"}
                  </span>
                  <p className="turn-text">{turn.content}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
