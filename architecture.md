# VoiceArch Streaming: System Architecture & Data Flow

This document details the complete end-to-end architecture of the real-time AI voice agent. The system is designed for low latency, utilizing streaming WebSockets, concurrent processing, and a heavily optimized audio pipeline.

## High-Level Architecture

The architecture consists of a React-based frontend that handles real-time audio processing and a FastAPI Python backend that coordinates the AI models (ASR, LLM, TTS) using an asynchronous producer-consumer pipeline.

```mermaid
graph TD
    subgraph Frontend ["Frontend (React / TypeScript)"]
        Mic[fa:fa-microphone Microphone] --> AudioCtx[Web Audio API<br>AudioWorklet]
        AudioCtx --> VAD[WebRTC VAD<br>fvad-wasm]
        VAD -- 16kHz PCM Chunks --> WS_Client[WebSocket Client]
        
        WS_Client -- Gapless WAV --> PlaybackQueue[Audio Playback Queue]
        PlaybackQueue --> Speaker[fa:fa-volume-up Speaker]
    end

    subgraph Backend ["Backend (FastAPI / Python)"]
        WS_Server[WebSocket Server]
        
        WS_Server -- Audio Bytes --> Whisper[faster-whisper<br>Speech-to-Text]
        Whisper -- Final Transcript --> LLM[LLM Engine<br>Claude / Kimi]
        
        LLM -- Streaming Tokens --> Queue[asyncio Queue<br>Sentence Buffer]
        Queue -- Complete Sentences --> KittenTTS[KittenTTS<br>ONNX Text-to-Speech]
        
        KittenTTS -- WAV Audio Bytes --> WS_Server
    end

    WS_Client <==>|Full-Duplex WS| WS_Server
```

> [!NOTE]
> **Barge-in (Interruption)**: If the WebRTC VAD detects the user speaking (above a dynamic threshold) while the AI is playing audio, the frontend instantly halts the `PlaybackQueue` and sends an `interrupt` signal to the `WS_Server`. The backend immediately cancels the active LLM and TTS tasks, readying the system for the user's new input.

---

## Complete Pipeline Flowchart & Latency Breakdown

The following sequence diagram illustrates the exact chronological flow of data during a single conversation turn, along with the approximate latency introduced at each step.

```mermaid
sequenceDiagram
    participant U as User
    participant VAD as WebRTC VAD (Frontend)
    participant WS as WebSocket
    participant ASR as faster-whisper
    participant LLM as Claude / LLM
    participant TTS as KittenTTS
    participant P as Playback (Frontend)

    Note over U, P: Turn 1 Starts - User Speaks
    U->>VAD: "Hello, how are you?"
    Note right of VAD: Latency: ~10-30ms (Buffer)
    VAD->>WS: Streams 16kHz PCM chunks
    WS->>ASR: Forwards audio bytes
    
    U->>VAD: (User stops speaking)
    Note right of VAD: Silence Detected (Hangover: ~1000ms)
    VAD->>WS: Sends {"type": "stop"}
    
    WS->>ASR: finalize_stream()
    Note right of ASR: Transcribing... (Latency: ~200-400ms)
    ASR-->>WS: Final Transcript: "Hello, how are you?"
    
    WS->>LLM: Generate Response
    Note right of LLM: Time To First Token (TTFT): ~400-800ms
    LLM-->>WS: Streams tokens ("I'm", " doing", " well!")
    
    Note over WS, TTS: Async Producer-Consumer Pipeline
    WS->>TTS: Sentences placed in asyncio Queue
    Note right of TTS: Synthesis (Latency: ~100-300ms per sentence)
    TTS-->>WS: Returns 24kHz WAV bytes
    
    WS->>P: Streams binary audio chunks
    Note right of P: Web Audio API decoding (Latency: ~20ms)
    P->>U: Plays AI Voice ("I'm doing well!")
    
    Note over U, P: Total Perceived Latency (End of speech to audio start): ~1.5 - 2.5 seconds
```

## Technology Stack Summary

### Frontend
*   **Framework**: React 19, TypeScript, Vite
*   **Audio Capture**: Web Audio API `AudioWorklet` for main-thread-blocking free audio processing.
*   **Silence Detection / Barge-in**: `@echogarden/fvad-wasm` (WASM port of Google's WebRTC VAD algorithm). Calibrates to room noise dynamically.
*   **Playback**: Custom `AudioPlaybackQueue` utilizing `AudioContext` for seamless, gapless stitching of incoming audio chunks.

### Backend
*   **Server**: FastAPI & Uvicorn (Asynchronous WebSocket routing).
*   **ASR (Speech-to-Text)**: `faster-whisper` (CTranslate2). Highly optimized for rapid real-time partial/final transcriptions.
*   **LLM Engine**: `ollama` / `sllm` (Running models like Claude or Kimi). Integrated as an async streaming generator.
*   **TTS (Text-to-Speech)**: `KittenTTS`. An ultra-lightweight (25-80MB) CPU-only ONNX model capable of synthesizing speech significantly faster than real-time.

> [!TIP]
> **Performance Optimization**: The backend utilizes an overlapping asynchronous pipeline. While the TTS engine is synthesizing Sentence 1, the LLM is already generating Sentence 2, and the frontend is actively playing the audio for Sentence 1. This drastically reduces perceived latency.
