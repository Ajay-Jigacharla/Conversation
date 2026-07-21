# VoiceArch — Phase 1 Voice Assistant

> **Mic → Whisper (ASR) → Ollama kimi-k2.7-code (LLM) → KittenTTS → Speaker**

A minimal, end-to-end voice pipeline proving all four AI components work together.

---

## Stack

| Component | Technology |
|-----------|-----------|
| Frontend  | React + TypeScript (Vite) |
| Backend   | FastAPI + Uvicorn |
| ASR       | faster-whisper (`tiny`) |
| LLM       | Ollama `kimi-k2.7-code` |
| TTS       | KittenTTS ONNX (CPU-only, no espeak-ng needed) |

---

## Prerequisites

- Python 3.10–3.12
- Node.js 18+
- [Ollama](https://ollama.com) running with `kimi-k2.7-code` pulled:
  ```bash
  ollama pull kimi-k2.7-code
  ```
  > If using a shared/remote Ollama server, set `OLLAMA_HOST` in `.env`.

---

## Backend Setup

```bash
cd backend

# 1. Create and activate virtual environment
python -m venv .venv

# Windows PowerShell
.venv\Scripts\Activate.ps1

# macOS/Linux
# source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Configure environment
copy .env.example .env
# Edit .env — set OLLAMA_HOST if using a shared server

# 4. Start the server
uvicorn main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.  
Open `http://localhost:8000/docs` for the interactive Swagger UI.

### Verify backend
```bash
curl http://localhost:8000/health
```
Expected response:
```json
{
  "status": "ok",
  "asr_model": "tiny",
  "llm_host": "http://localhost:11434",
  "llm_model": "kimi-k2.7-code",
  "tts_model": "KittenML/kitten-tts-nano-0.8"
}
```

---

## Frontend Setup

```bash
cd frontend

# Install dependencies
npm install

# Start dev server
npm run dev
```

Open `http://localhost:5173` in your browser.

> If your backend is on a different port/host, create `frontend/.env`:
> ```
> VITE_API_URL=http://your-backend-host:8000
> ```

---

## Usage

1. Open `http://localhost:5173`
2. Click the **purple orb** → grant microphone permission
3. Speak your question
4. Click the **red orb** (stop) when done
5. Watch the pipeline status: `Transcribing → LLM → Synthesizing → Playing`
6. Hear the AI's response through your speakers

---

## Project Structure

```
voice-arch/
├── backend/
│   ├── .venv/              ← Python virtual environment (git-ignored)
│   ├── asr/
│   │   └── whisper_asr.py  ← faster-whisper transcription
│   ├── llm/
│   │   └── ollama_llm.py   ← Ollama kimi-k2.7-code HTTP client
│   ├── tts/
│   │   └── kitten_tts.py   ← KittenTTS synthesis
│   ├── config.py           ← All settings from .env
│   ├── main.py             ← FastAPI app + /chat endpoint
│   ├── requirements.txt
│   └── .env.example
│
├── frontend/
│   └── src/
│       ├── components/
│       │   └── VoiceOrb.tsx      ← Animated mic button
│       ├── hooks/
│       │   └── useAudioRecorder.ts
│       ├── services/
│       │   └── api.ts            ← POST /chat client
│       ├── App.tsx
│       └── index.css
│
└── README.md
```

---

## Configuration Reference (`.env`)

| Key | Default | Description |
|-----|---------|-------------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `kimi-k2.7-code` | Model tag to use |
| `WHISPER_MODEL` | `tiny` | Whisper model size |
| `KITTEN_MODEL` | `KittenML/kitten-tts-nano-0.8` | KittenTTS model |
| `KITTEN_VOICE` | `expr-voice-2-f` | TTS voice |
| `CORS_ORIGINS` | `http://localhost:5173` | Allowed frontend origins |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Backend Offline` badge in UI | Start `uvicorn main:app --reload --port 8000` |
| `Could not transcribe audio` | Speak louder / closer to mic; check browser mic permission |
| `httpx.ConnectError` | Ensure Ollama is running; check `OLLAMA_HOST` in `.env` |
| KittenTTS download slow | First run downloads ~25 MB model; subsequent calls are instant |
| `activate.ps1 cannot be loaded` | Run: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` |

