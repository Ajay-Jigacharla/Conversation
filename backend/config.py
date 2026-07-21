"""
config.py — centralised settings loaded from .env
"""
import os
from dotenv import load_dotenv

load_dotenv()

# ── SharedLLM Gateway ────────────────────────────────────────────────
SHAREDLLM_KEY: str = os.getenv("SHAREDLLM_KEY", "")

# ── Ollama (via SharedLLM) ────────────────────────────────────────────
OLLAMA_HOST: str = os.getenv("OLLAMA_HOST", "https://api.sharedllm.com/ollama")
OLLAMA_MODEL: str = os.getenv("OLLAMA_MODEL", "kimi-k2.7-code")

# ── Whisper ASR ───────────────────────────────────────────────────────
WHISPER_MODEL: str = os.getenv("WHISPER_MODEL", "tiny")

# ── Kitten TTS ────────────────────────────────────────────────────────
KITTEN_MODEL: str = os.getenv("KITTEN_MODEL", "KittenML/kitten-tts-nano-0.8")
KITTEN_VOICE: str = os.getenv("KITTEN_VOICE", "expr-voice-2-f")

# ── CORS ──────────────────────────────────────────────────────────────
CORS_ORIGINS: list[str] = os.getenv(
    "CORS_ORIGINS", "http://localhost:5173"
).split(",")
