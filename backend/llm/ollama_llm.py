"""
llm/ollama_llm.py — LLM response generation via local Ollama server
Model: kimi-k2.7-code (or whatever is set in .env)
"""
import logging
import httpx
from config import OLLAMA_HOST, OLLAMA_MODEL, SHAREDLLM_KEY

logger = logging.getLogger(__name__)

# ── SharedLLM header ──────────────────────────────────────────────────
# When OLLAMA_HOST points at the SharedLLM gateway the X-SharedLLM-Key
# header is required for authentication. For a raw local Ollama instance
# (no gateway) the header is simply ignored.
def _build_headers() -> dict[str, str]:
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if SHAREDLLM_KEY:
        headers["X-SharedLLM-Key"] = SHAREDLLM_KEY
    elif "sharedllm.com" in OLLAMA_HOST:
        # Key is required for the SharedLLM gateway — fail fast with a clear message
        # rather than letting every request hit a silent 401 deep in the pipeline.
        raise RuntimeError(
            "SHAREDLLM_KEY is not set but OLLAMA_HOST points at the SharedLLM gateway. "
            "Add SHAREDLLM_KEY=sk-sharedllm-... to backend/.env and restart the server."
        )
    return headers

SYSTEM_PROMPT = (
    "You are a helpful, friendly voice assistant. "
    "Keep your responses concise, natural, and conversational — "
    "as if you are speaking out loud to a person. "
    "Avoid markdown, bullet points, headers, or code blocks unless the user "
    "explicitly asks for code. Aim for 1 to 3 sentences for most answers. "
    "If a previous assistant message was marked as interrupted, treat it as "
    "a partial response that the user cut off. Use it as context, but answer "
    "the user's latest request rather than continuing the cut-off response."
)


# ── Conversation history helpers ───────────────────────────────────────
# A "turn" is dict with role ("user" | "assistant") and content (str).
_MAX_HISTORY_TURNS = 10


def _build_messages(transcript: str, history: list[dict[str, str]] | None = None) -> list[dict[str, str]]:
    """Construct [system, *history, user] message list for Ollama."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if history:
        # Keep only valid turns and trim to the last N to protect context window.
        # Preserve a small hint for interrupted assistant turns so the model knows
        # the response was cut off by the user.
        valid: list[dict[str, str]] = []
        for t in history[-_MAX_HISTORY_TURNS:]:
            if t.get("role") not in ("user", "assistant") or not isinstance(t.get("content"), str):
                continue
            content = t["content"]
            if t.get("role") == "assistant" and t.get("interrupted"):
                content = f"[Interrupted] {content}"
            valid.append({"role": str(t["role"]), "content": content})
        messages.extend(valid)
    messages.append({"role": "user", "content": transcript})
    return messages


async def generate_response(transcript: str, history: list[dict[str, str]] | None = None) -> str:
    """
    Send transcript to the Ollama model and return the text response.

    Args:
        transcript: The user's spoken words as text.
        history: Optional list of prior {role, content} turns to include as context.

    Returns:
        The model's response as a plain string.

    Raises:
        httpx.HTTPStatusError: If the Ollama API returns an error.
    """
    url = f"{OLLAMA_HOST}/api/chat"
    payload = {
        "model": OLLAMA_MODEL,
        "messages": _build_messages(transcript, history),
        "stream": False,
    }

    logger.info("Sending to Ollama [%s] @ %s with %d history turn(s)…", OLLAMA_MODEL, OLLAMA_HOST, len(history or []))

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(url, json=payload, headers=_build_headers())
        response.raise_for_status()

    data = response.json()
    text: str = data["message"]["content"].strip()
    logger.info("LLM response (%d chars): %r …", len(text), text[:80])
    return text


import json
from typing import AsyncGenerator

async def generate_response_stream(transcript: str, history: list[dict[str, str]] | None = None) -> AsyncGenerator[str, None]:
    """
    Stream response from the Ollama model.
    Yields chunks of text split by sentence boundaries (., !, ?) to preserve TTS prosody.

    Args:
        transcript: The user's spoken words as text.
        history: Optional list of prior {role, content} turns.
    """
    url = f"{OLLAMA_HOST}/api/chat"
    payload = {
        "model": OLLAMA_MODEL,
        "messages": _build_messages(transcript, history),
        "stream": True,
    }

    logger.info(
        "Streaming from Ollama [%s] @ %s with %d history turn(s)…",
        OLLAMA_MODEL, OLLAMA_HOST, len(history or [])
    )

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", url, json=payload, headers=_build_headers()) as response:
            response.raise_for_status()
            
            sentence_buffer = ""
            async for line in response.aiter_lines():
                if not line: continue
                try:
                    data = json.loads(line)
                    chunk = data.get("message", {}).get("content", "")
                    if chunk:
                        sentence_buffer += chunk
                        
                        # Extract as many sentences as possible from the current buffer
                        while True:
                            found_boundary = False
                            punctuations = ['. ', '! ', '? ', '.\\n', '!\\n', '?\\n']
                            for p in punctuations:
                                real_p = p.replace('\\n', '\n')
                                if real_p in sentence_buffer:
                                    parts = sentence_buffer.split(real_p, 1)
                                    yield (parts[0] + real_p.strip()).strip()
                                    sentence_buffer = parts[1] if len(parts) > 1 else ""
                                    found_boundary = True
                                    break
                            
                            if not found_boundary:
                                break
                except json.JSONDecodeError:
                    pass
            
            # Flush remaining buffer
            if sentence_buffer.strip():
                yield sentence_buffer.strip()
