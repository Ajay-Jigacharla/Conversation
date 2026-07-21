"""
websocket.py — FastAPI WebSocket router for streaming audio
"""
import logging
import asyncio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import json

from asr.whisper_stream import StreamingTranscriber
from llm.ollama_llm import generate_response
from tts.kitten_tts import synthesize

logger = logging.getLogger(__name__)

router = APIRouter()


# Sentinel placed on the TTS queue to signal that the LLM producer is done.
QUEUE_DONE = None


def _parse_history(payload: dict) -> list[dict[str, str]]:
    """Validate an incoming history payload into clean {role, content} turns."""
    raw = payload.get("history")
    if not isinstance(raw, list):
        return []
    return [
        {"role": str(t["role"]), "content": str(t["content"])}
        for t in raw
        if isinstance(t, dict) and "role" in t and "content" in t
    ]


@router.websocket("/ws/stream")
async def websocket_stream(websocket: WebSocket):
    await websocket.accept()
    logger.info("WebSocket connected for streaming.")

    transcriber = StreamingTranscriber()
    audio_queue = asyncio.Queue()
    streaming_active = True
    history: list[dict[str, str]] = []

    # Background task to process audio incrementally
    async def process_audio():
        last_transcript = ""
        while streaming_active:
            try:
                # Wait for at least one chunk to be processed
                _ = await asyncio.wait_for(audio_queue.get(), timeout=0.5)
                # Process any other accumulated chunks instantly
                while not audio_queue.empty():
                    audio_queue.get_nowait()

                # We've appended chunks to the transcriber via the receive task.
                # Now transcribe the partial buffer.
                partial_text = transcriber.transcribe_partial()
                if partial_text and partial_text != last_transcript:
                    logger.debug("Partial: %s", partial_text)
                    await websocket.send_json({"type": "partial", "text": partial_text})
                    last_transcript = partial_text
            except asyncio.TimeoutError:
                # No new audio in the last 500ms, just continue
                pass
            except Exception as e:
                logger.error("Error in process_audio: %s", e)
                break

    processor_task = asyncio.create_task(process_audio())

    try:
        while True:
            # Expect binary 16-bit PCM from the frontend, or JSON control messages
            message = await websocket.receive()

            if "bytes" in message and message["bytes"]:
                transcriber.append_chunk(message["bytes"])
                await audio_queue.put(True)  # signal that new data arrived

            if "text" in message and message["text"]:
                data = json.loads(message["text"])

                if data.get("type") == "history":
                    history = _parse_history(data)
                    logger.info("Received %d history turn(s) via websocket.", len(history))
                    continue

                if data.get("type") == "stop" or "stop" in message["text"]:
                    logger.info("Client requested stop. Breaking receive loop.")
                    break

                if data.get("type") == "interrupt":
                    logger.info("Client requested interrupt before finalization.")
                    # Cancel partial transcription; don't run the response pipeline.
                    streaming_active = False
                    processor_task.cancel()
                    try:
                        await websocket.close()
                    except RuntimeError:
                        pass
                    return

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected, finalizing stream.")
    except Exception as e:
        logger.error("WebSocket error: %s", e)
    finally:
        streaming_active = False
        processor_task.cancel()

        # Run final pipeline
        try:
            logger.info("Running final pipeline...")
            final_text = transcriber.transcribe_final()

            if not final_text:
                logger.info("No speech detected in stream.")
            else:
                await websocket.send_json({"type": "final_transcript", "text": final_text})
                await _stream_response(websocket, final_text, history)
        except Exception as e:
            logger.error("Error during finalization: %s", e)
            try:
                await websocket.send_json({"type": "error", "message": str(e)})
            except:
                pass

        # Finally, close the websocket (if it's not already closed by the client)
        try:
            await websocket.close()
        except RuntimeError:
            pass


async def _stream_response(
    websocket: WebSocket,
    final_text: str,
    history: list[dict[str, str]],
) -> None:
    """
    Stream the LLM response to the client while overlapping TTS synthesis.

    Producer (LLM) enqueues sentences into an asyncio.Queue. Consumer (TTS)
    pulls them, synthesizes in a thread pool, and sends WAV bytes as soon as
    each chunk is ready. Bounded queue adds backpressure if TTS is slower.
    """
    logger.info("Generating and streaming LLM response...")
    from llm.ollama_llm import generate_response_stream

    llm_stream = generate_response_stream(final_text, history)

    # Bounded so the LLM doesn't race far ahead of TTS and waste context/tokens.
    tts_queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=2)

    async def llm_producer() -> None:
        """Feed sentences into the TTS queue and signal completion."""
        try:
            async for sentence in llm_stream:
                if sentence:
                    logger.info("LLM sentence: %s", sentence)
                    await websocket.send_json({"type": "llm_partial", "text": sentence})
                    await tts_queue.put(sentence)
        except Exception as exc:
            logger.error("LLM producer error: %s", exc)
            raise
        finally:
            await tts_queue.put(QUEUE_DONE)

    async def tts_consumer() -> None:
        """Pull sentences, synthesize, and send audio chunks to the client."""
        try:
            while True:
                sentence = await tts_queue.get()
                if sentence is QUEUE_DONE:
                    tts_queue.task_done()
                    break

                # Run TTS synchronously in a thread
                wav_bytes = await asyncio.to_thread(synthesize, sentence)

                # Send the final audio back over the socket as binary
                await websocket.send_bytes(wav_bytes)
                tts_queue.task_done()
        except Exception as exc:
            logger.error("TTS consumer error: %s", exc)
            raise

    producer_task = asyncio.create_task(llm_producer())
    consumer_task = asyncio.create_task(tts_consumer())

    # asyncio.gather() returns a Future, NOT a coroutine.
    # asyncio.create_task() requires a coroutine — passing a Future raises
    # "a coroutine was expected, got <_GatheringFuture pending>".
    # Fix: wrap in an async def so create_task receives a real coroutine.
    async def _run_pipeline() -> None:
        await asyncio.gather(producer_task, consumer_task, return_exceptions=True)

    pipeline_task = asyncio.create_task(_run_pipeline())

    # Background listener for instant barge-in cancellation
    async def listen_for_interrupt():
        try:
            while True:
                msg = await websocket.receive()
                if "text" in msg and "interrupt" in msg.get("text", ""):
                    logger.info("Barge-in interrupt received from client!")
                    break
        except Exception:
            pass  # Socket closed

    listen_task = asyncio.create_task(listen_for_interrupt())

    try:
        done, pending = await asyncio.wait(
            {pipeline_task, listen_task},
            return_when=asyncio.FIRST_COMPLETED,
        )

        if listen_task in done:
            logger.info("Pipeline cancelled due to barge-in interrupt.")
            # Cancel the pipeline task — this propagates to producer + consumer.
            pipeline_task.cancel()
            try:
                await pipeline_task
            except asyncio.CancelledError:
                pass
        else:
            logger.info("Final response stream complete.")
            await websocket.send_json({"type": "audio_done"})

    except Exception as exc:
        logger.error("Error during streaming response: %s", exc)
        raise
    finally:
        for task in (producer_task, consumer_task, listen_task, pipeline_task):
            if not task.done():
                task.cancel()
