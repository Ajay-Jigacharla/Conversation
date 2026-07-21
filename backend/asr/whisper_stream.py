"""
asr/whisper_stream.py — Streaming ASR engine using faster-whisper.

Maintains a growing audio buffer of PCM int16 samples.
Periodically transcribes the buffer to provide partial transcripts.
"""
import logging
import numpy as np
from faster_whisper import WhisperModel
from asr.whisper_asr import _get_model

logger = logging.getLogger(__name__)

class StreamingTranscriber:
    def __init__(self):
        self.audio_buffer = bytearray()
        self.model: WhisperModel = _get_model()

    def append_chunk(self, chunk: bytes):
        """Append raw 16-bit PCM chunk to the buffer."""
        self.audio_buffer.extend(chunk)

    def transcribe_partial(self) -> str:
        """
        Convert current buffer to float32 numpy array and transcribe.
        Returns the transcript of everything said so far.
        """
        if len(self.audio_buffer) == 0:
            return ""

        # Convert raw 16-bit PCM bytes to int16 numpy array
        audio_int16 = np.frombuffer(self.audio_buffer, dtype=np.int16)
        
        # Convert int16 to float32 in range [-1.0, 1.0] expected by Whisper
        audio_float32 = audio_int16.astype(np.float32) / 32768.0

        segments, info = self.model.transcribe(
            audio_float32, 
            beam_size=1, # fast decoding for streaming
            language="en", 
            without_timestamps=True,
            condition_on_previous_text=False
        )
        
        transcript = " ".join(seg.text.strip() for seg in segments).strip()
        return transcript

    def transcribe_final(self) -> str:
        """
        Final pass transcription with better beam search.
        """
        if len(self.audio_buffer) == 0:
            return ""

        audio_int16 = np.frombuffer(self.audio_buffer, dtype=np.int16)
        audio_float32 = audio_int16.astype(np.float32) / 32768.0

        segments, info = self.model.transcribe(
            audio_float32, 
            beam_size=5, 
            without_timestamps=True
        )
        
        transcript = " ".join(seg.text.strip() for seg in segments).strip()
        return transcript
