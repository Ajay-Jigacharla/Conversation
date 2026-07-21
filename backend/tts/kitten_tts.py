"""
tts/kitten_tts.py — Text-to-Speech using KittenTTS (CPU-only ONNX model)
No espeak-ng required. Ultra-lightweight, 25-80 MB model.
"""
import io
import logging
import numpy as np
import soundfile as sf
from kittentts import KittenTTS
from config import KITTEN_MODEL, KITTEN_VOICE

logger = logging.getLogger(__name__)

_tts: KittenTTS | None = None
SAMPLE_RATE = 24_000  # KittenTTS outputs 24 kHz audio


def _get_tts() -> KittenTTS:
    """Lazy-load KittenTTS on first call."""
    global _tts
    if _tts is None:
        logger.info("Loading KittenTTS model: %s …", KITTEN_MODEL)
        _tts = KittenTTS(KITTEN_MODEL)
        logger.info("KittenTTS model loaded.")
    return _tts


def synthesize(text: str) -> bytes:
    """
    Convert text to speech and return raw WAV bytes.

    Args:
        text: The text to synthesize (plain string, no markdown).

    Returns:
        WAV-encoded audio bytes ready to stream to the frontend.
    """
    tts = _get_tts()
    logger.info("Synthesizing %d chars with voice=%s …", len(text), KITTEN_VOICE)

    audio: np.ndarray = tts.generate(text, voice=KITTEN_VOICE, speed=1.6)

    # Encode as WAV in memory
    buffer = io.BytesIO()
    sf.write(buffer, audio, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    buffer.seek(0)
    wav_bytes = buffer.read()

    logger.info("TTS produced %d bytes of WAV audio.", len(wav_bytes))
    return wav_bytes
