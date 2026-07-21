"""
asr/whisper_asr.py — Speech-to-Text using faster-whisper (Tiny model)
"""
import logging
from faster_whisper import WhisperModel
from config import WHISPER_MODEL

logger = logging.getLogger(__name__)

_model: WhisperModel | None = None


def _get_model() -> WhisperModel:
    """Lazy-load the Whisper model on first call."""
    global _model
    if _model is None:
        logger.info("Loading Whisper model: %s (CPU / int8) …", WHISPER_MODEL)
        _model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        logger.info("Whisper model loaded.")
    return _model


def transcribe(audio_path: str) -> str:
    """
    Transcribe an audio file to text.

    Args:
        audio_path: Absolute path to a WAV/WebM/MP4 audio file.

    Returns:
        The full transcript as a single clean string.
    """
    model = _get_model()
    # Force language="en" to prevent auto-detect from failing on accents
    segments, info = model.transcribe(audio_path, beam_size=5, language="en")
    transcript = " ".join(seg.text.strip() for seg in segments).strip()
    logger.info("ASR transcript: %r (lang=%s, prob=%.2f)",
                transcript, info.language, info.language_probability)
    return transcript
