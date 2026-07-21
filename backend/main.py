"""
main.py — FastAPI entry point for the Phase 1 Voice Assistant

Pipeline:
    POST /chat  →  Whisper (ASR)  →  SharedLLM → Ollama kimi-k2.7-code (LLM)  →  KittenTTS  →  WAV response

Run:
    uvicorn main:app --reload --port 8000
"""
import os
import sys
import io
import json
import logging
import tempfile
import urllib.parse
from typing import Annotated

# Force UTF-8 for Windows console to prevent 'charmap' encoding crash
if isinstance(sys.stdout, io.TextIOWrapper):
    sys.stdout.reconfigure(encoding="utf-8")
if isinstance(sys.stderr, io.TextIOWrapper):
    sys.stderr.reconfigure(encoding="utf-8")

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from config import CORS_ORIGINS, OLLAMA_HOST, OLLAMA_MODEL, WHISPER_MODEL, KITTEN_MODEL
from asr.whisper_asr import transcribe
from llm.ollama_llm import generate_response
from tts.kitten_tts import synthesize


def _parse_history(history_json: str | None) -> list[dict[str, str]]:
    """Safely parse and validate the optional JSON history field."""
    if not history_json or history_json in ("null", "undefined"):
        return []
    try:
        parsed = json.loads(history_json)
        if not isinstance(parsed, list):
            return []
        return [
            {"role": str(t["role"]), "content": str(t["content"])}
            for t in parsed
            if isinstance(t, dict) and "role" in t and "content" in t
        ]
    except (json.JSONDecodeError, TypeError, ValueError):
        return []

# ── Logging ───────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s  %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

# ── App ───────────────────────────────────────────────────────────────
app = FastAPI(
    title="Voice Assistant API",
    description="Phase 1 MVP — Whisper → Ollama kimi-k2.7-code → KittenTTS",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Transcript", "X-Response"],
)

from websocket import router as websocket_router
app.include_router(websocket_router)


# ── Routes ────────────────────────────────────────────────────────────

@app.get("/health", tags=["meta"])
async def health():
    """Quick health check — also shows active config."""
    return {
        "status": "ok",
        "asr_model":   WHISPER_MODEL,
        "llm_host":    OLLAMA_HOST,
        "llm_model":   OLLAMA_MODEL,
        "tts_model":   KITTEN_MODEL,
    }


@app.post("/chat", tags=["pipeline"])
async def chat(
    audio: UploadFile = File(..., description="Audio file from the browser (WebM/WAV/MP4)"),
    history: Annotated[str, Form()] = "[]",
):
    """
    Full voice pipeline:
    1. Accept audio upload from browser
    2. Transcribe with faster-whisper tiny
    3. Generate response with Ollama kimi-k2.7-code (with optional history)
    4. Synthesize with KittenTTS
    5. Return WAV audio + transcript headers
    """
    tmp_path: str | None = None

    try:
        # ── Step 0: Parse optional conversation history ────────────
        parsed_history = _parse_history(history)

        # ── Step 1: Save uploaded audio to a temp file ──────────────
        ext = os.path.splitext(audio.filename or "audio.webm")[1] or ".webm"
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            content = await audio.read()
            tmp.write(content)
            tmp_path = tmp.name
        logger.info("Saved upload to %s (%d bytes)", tmp_path, len(content))

        # ── Step 2: ASR ──────────────────────────────────────────────
        transcript = transcribe(tmp_path)
        if not transcript:
            raise HTTPException(
                status_code=422,
                detail="Could not transcribe audio — please speak clearly and try again.",
            )

        # ── Step 3: LLM ──────────────────────────────────────────────
        response_text = await generate_response(transcript, parsed_history)
        if not response_text:
            raise HTTPException(
                status_code=502,
                detail="LLM returned an empty response.",
            )

        # ── Step 4: TTS ──────────────────────────────────────────────
        wav_bytes = synthesize(response_text)

        # ── Step 5: Return WAV + metadata headers ────────────────────
        # Encode headers safely (strip newlines, URL-encode for ASCII compatibility)
        safe_transcript   = urllib.parse.quote(transcript.replace("\n", " ")[:500])
        safe_response     = urllib.parse.quote(response_text.replace("\n", " ")[:500])

        return Response(
            content=wav_bytes,
            media_type="audio/wav",
            headers={
                "X-Transcript": safe_transcript,
                "X-Response":   safe_response,
            },
        )

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Pipeline failed: %s", exc)
        raise HTTPException(status_code=500, detail=f"Internal pipeline error: {exc}") from exc
    finally:
        # Always clean up the temp file
        if tmp_path and os.path.exists(tmp_path):
            os.unlink(tmp_path)
            logger.debug("Cleaned up temp file: %s", tmp_path)
