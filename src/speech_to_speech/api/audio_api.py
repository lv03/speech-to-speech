"""Standalone ASR + TTS HTTP API (OpenAI-compatible).

Mounts ``POST /v1/audio/transcriptions`` and ``POST /v1/audio/speech`` on the
existing FastAPI app, reusing the STT/TTS handler classes directly (bypassing
the VAD → LLM → TTS pipeline). This gives other services a standard,
OpenAI-SDK-compatible way to call the local models:

    POST /v1/audio/transcriptions   multipart: file + model + language + hotwords
    POST /v1/audio/speech           JSON: {model, input, voice} → audio/wav

Supported models (Phase 1, per design review):
    - STT: ``paraformer`` (paraformer-zh), ``fun-asr-nano`` (Fun-ASR-Nano-2512)
    - TTS: ``qwen3`` (Qwen3-TTS CustomVoice)

Model instances are loaded lazily on first use and each is guarded by a lock so
inference is serialized (models are not thread-safe). Like ``llm_proxy.py``,
these endpoints perform no authentication and no throttling of their own: run
them on a trusted network or behind a gateway that owns access control.
"""

from __future__ import annotations

import asyncio
import io
import json
import logging
import threading
import wave
from queue import Queue
from sys import platform
from threading import Event
from typing import Any, Callable

import numpy as np
from fastapi import FastAPI, File, Form, Response, UploadFile
from pydantic import BaseModel

from speech_to_speech.pipeline.messages import TTSInput, VADAudio

logger = logging.getLogger(__name__)

PIPELINE_SR = 16000

# The STT backends this API serves, in a stable order for error messages.
_STT_MODEL_NAMES = ("fun-asr-nano", "paraformer")


class AudioApiConfig(BaseModel):
    """Configuration for the standalone ASR/TTS endpoints."""

    enabled: bool = False
    device: str | None = None


class _ErrorDetail(BaseModel):
    message: str
    type: str


class _ErrorEnvelope(BaseModel):
    error: _ErrorDetail


class _SpeechRequest(BaseModel):
    model: str = "qwen3"
    input: str
    voice: str | None = None


def _error_response(status_code: int, message: str, error_type: str) -> Response:
    envelope = _ErrorEnvelope(error=_ErrorDetail(message=message, type=error_type))
    return Response(
        content=json.dumps(envelope.model_dump(), ensure_ascii=False),
        status_code=status_code,
        media_type="application/json",
    )


def _resolve_device(device: str | None) -> str:
    if device:
        return device
    return "mps" if platform == "darwin" else "cuda"


# ── Lazy, lock-serialized model workers ──────────────────────────────────────


class _Worker:
    """Lazily builds one handler and serializes inference with a lock."""

    def __init__(self, builder: Callable[[], Any]) -> None:
        self._builder = builder
        self._handler: Any = None
        self._lock = threading.Lock()

    def run(self, fn: Callable[[Any], Any]) -> Any:
        with self._lock:
            if self._handler is None:
                logger.info("Lazy-loading model for standalone audio API...")
                self._handler = self._builder()
            return fn(self._handler)


# Process-wide registry: one model instance per (kind, name, device).
_workers: dict[tuple[str, str, str], _Worker] = {}
_workers_lock = threading.Lock()


def _get_worker(kind: str, name: str, device: str, builder: Callable[[], Any]) -> _Worker:
    key = (kind, name, device)
    with _workers_lock:
        worker = _workers.get(key)
        if worker is None:
            worker = _Worker(builder)
            _workers[key] = worker
        return worker


# ── Handler builders (lazy imports keep module import light) ─────────────────


def _build_paraformer(device: str):
    from speech_to_speech.STT.paraformer_handler import ParaformerSTTHandler

    return ParaformerSTTHandler(
        Event(),
        queue_in=Queue(),
        queue_out=Queue(),
        setup_kwargs={"model_name": "paraformer-zh", "device": device, "gen_kwargs": {}},
    )


def _build_fun_asr_nano(device: str):
    from speech_to_speech.STT.fun_asr_nano_handler import FunASRNanoSTTHandler

    return FunASRNanoSTTHandler(
        Event(),
        queue_in=Queue(),
        queue_out=Queue(),
        setup_kwargs={
            "model_name": "FunAudioLLM/Fun-ASR-Nano-2512",
            "device": device,
            "hub": "hf",
            "gen_kwargs": {},
        },
    )


def _build_qwen3(device: str):
    from speech_to_speech.TTS.qwen3_tts_handler import Qwen3TTSHandler

    return Qwen3TTSHandler(
        Event(),
        queue_in=Queue(),
        queue_out=Queue(),
        setup_args=(Event(),),
        setup_kwargs={
            "device": device,
            "cancel_scope": None,
            "speculative_turns": None,
        },
    )


# ── Audio decoding / encoding ────────────────────────────────────────────────


class _AudioDecodeError(Exception):
    pass


def _decode_audio(data: bytes) -> np.ndarray:
    """Decode uploaded audio to 16kHz mono float32, like the pipeline's VAD output."""
    import soundfile as sf

    try:
        audio, sample_rate = sf.read(io.BytesIO(data), dtype="float32", always_2d=False)
    except Exception as exc:
        raise _AudioDecodeError(f"could not decode audio: {type(exc).__name__}: {exc}") from exc

    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=1)
    if sample_rate != PIPELINE_SR:
        from scipy.signal import resample_poly

        audio = resample_poly(audio, PIPELINE_SR, sample_rate).astype(np.float32)
    return audio.astype(np.float32)


def _to_wav(chunks: list[Any], sample_rate: int = PIPELINE_SR) -> bytes:
    """Concatenate int16 audio chunks into a mono WAV file."""
    arrays: list[np.ndarray] = []
    for chunk in chunks:
        if isinstance(chunk, bytes):
            arr = np.frombuffer(chunk, dtype=np.int16)
        else:
            arr = np.asarray(chunk)
        if arr.dtype != np.int16:
            arr = (np.clip(arr, -1.0, 1.0) * 32767.0).astype(np.int16)
        arrays.append(arr.astype(np.int16))
    pcm = np.concatenate(arrays) if arrays else np.zeros(0, dtype=np.int16)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm.tobytes())
    return buf.getvalue()


# ── Inference helpers ────────────────────────────────────────────────────────


def _transcribe(worker: _Worker, name: str, audio: np.ndarray, hotwords: str | None, language: str | None) -> str:
    terms = [term.strip() for term in (hotwords or "").replace("，", " ").split(" ") if term.strip()]

    def fn(handler: Any) -> str:
        if name == "fun-asr-nano":
            # Reset per-request params so a request without hotwords/language
            # never inherits a previous request's values.
            handler.gen_kwargs["hotwords"] = terms
            handler.gen_kwargs["language"] = language
        else:  # paraformer-zh
            if terms:
                handler.gen_kwargs["hotword"] = " ".join(terms)
            else:
                handler.gen_kwargs.pop("hotword", None)
        results = list(handler.process(VADAudio(audio=audio, mode="final")))
        for result in results:
            if getattr(result, "text", None):
                return result.text
        return ""

    return worker.run(fn)


def _synthesize(worker: _Worker, text: str, voice: str | None) -> bytes:
    def fn(handler: Any) -> bytes:
        if voice:
            handler.speaker = voice
        chunks = list(handler.process(TTSInput(text=text)))
        return _to_wav(chunks)

    return worker.run(fn)


# ── Mounting ─────────────────────────────────────────────────────────────────


def mount_audio_api(app: FastAPI, config: AudioApiConfig | None) -> None:
    """Mount ASR/TTS routes on *app* according to *config*.

    When disabled, both paths still answer 501 with the reason, so a
    misconfigured deployment is diagnosed in one request (mirrors llm_proxy).
    """
    config = config or AudioApiConfig()

    if not config.enabled:
        reason = "The audio API is disabled. Start the server with --enable_audio_api to enable it."
        for path in ("/v1/audio/transcriptions", "/v1/audio/speech"):
            _mount_unavailable(app, path, reason)
        return

    device = _resolve_device(config.device)
    logger.info("Audio API enabled: STT models=%s, TTS model=qwen3, device=%s", _STT_MODEL_NAMES, device)

    def stt_worker(name: str) -> _Worker:
        builder = _build_fun_asr_nano if name == "fun-asr-nano" else _build_paraformer

        def make() -> Any:
            return builder(device)

        return _get_worker("stt", name, device, make)

    def tts_worker() -> _Worker:
        return _get_worker("tts", "qwen3", device, lambda: _build_qwen3(device))

    @app.post("/v1/audio/transcriptions")
    async def transcriptions(
        file: UploadFile = File(...),
        model: str = Form("fun-asr-nano"),
        language: str | None = Form(None),
        hotwords: str | None = Form(None),
    ):
        if model not in _STT_MODEL_NAMES:
            return _error_response(400, f"Unsupported model {model!r}; choose one of: {', '.join(_STT_MODEL_NAMES)}.", "invalid_request_error")

        try:
            audio = await asyncio.to_thread(_decode_audio, await file.read())
            worker = stt_worker(model)
            text = await asyncio.to_thread(_transcribe, worker, model, audio, hotwords, language)
        except _AudioDecodeError as exc:
            return _error_response(400, str(exc), "invalid_audio")
        except Exception as exc:  # noqa: BLE001
            logger.error("Audio API transcription failed: %s", exc, exc_info=True)
            return _error_response(500, f"Transcription failed: {type(exc).__name__}: {exc}", "server_error")

        return Response(
            content=json.dumps({"text": text}, ensure_ascii=False),
            status_code=200,
            media_type="application/json",
        )

    @app.post("/v1/audio/speech")
    async def speech(request: _SpeechRequest):
        if request.model != "qwen3":
            return _error_response(400, f"Unsupported model {request.model!r}; only 'qwen3' is served.", "invalid_request_error")
        if not request.input.strip():
            return _error_response(400, "The 'input' field must be a non-empty string.", "invalid_request_error")

        try:
            worker = tts_worker()
            wav_bytes = await asyncio.to_thread(_synthesize, worker, request.input, request.voice)
        except Exception as exc:  # noqa: BLE001
            logger.error("Audio API speech synthesis failed: %s", exc, exc_info=True)
            return _error_response(500, f"Speech synthesis failed: {type(exc).__name__}: {exc}", "server_error")

        return Response(content=wav_bytes, status_code=200, media_type="audio/wav")


def _mount_unavailable(app: FastAPI, path: str, reason: str) -> None:
    @app.post(path)
    async def unavailable() -> Response:
        return _error_response(501, reason, "not_implemented")
