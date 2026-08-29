"""Exact-text TTS speaker for the packaged ``local`` command.

The conversational pipeline cannot speak arbitrary text (its TTS is driven by
the LLM), but the desktop app needs to announce task completions verbatim. The
old ``speech-to-speech announce`` daemon solved that by loading a *second*
Qwen3-TTS model in a separate process, which contended with the pipeline on
Apple Silicon's MPS and corrupted output.

This module instead reuses the already-loaded model from the pipeline's TTS
handler, in the same process, and plays through ``sounddevice``. The handler's
``synthesize`` path shares the global MLX lock with conversational TTS, so the
two serialize instead of contending.

Protocol (stdin, one JSON object per line):

    {"type": "speak", "text": "任务已完成"}
    {"type": "shutdown"}

stdout emits a JSON line per completed request:

    {"type": "spoken", "text": "..."}
    {"type": "error", "error": "..."}
"""

from __future__ import annotations

import json
import logging
import select
import sys
from threading import Event
from typing import Any, TextIO

import numpy as np

logger = logging.getLogger(__name__)

PIPELINE_SAMPLE_RATE = 16000


class LocalSpeakServer:
    """Reads ``speak``/``shutdown`` JSONL from stdin and speaks via the TTS handler."""

    def __init__(
        self,
        stop_event: Event,
        tts_handler: Any,
        stream: TextIO | None = None,
    ) -> None:
        self.stop_event = stop_event
        self.tts_handler = tts_handler
        self._stream = stream if stream is not None else sys.stdin

    def synthesize(self, text: str) -> np.ndarray:
        """Synthesize *text* with the shared model and return int16 PCM (16 kHz)."""
        chunks: list[np.ndarray] = []
        for chunk in self.tts_handler.synthesize(text):
            chunks.append(np.asarray(chunk, dtype=np.int16).reshape(-1))
        if not chunks:
            raise RuntimeError("TTS 未产出音频")
        return np.concatenate(chunks)

    def _handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            return

        mtype = msg.get("type")
        if mtype == "shutdown":
            self.stop_event.set()
            return
        if mtype != "speak":
            return

        text = str(msg.get("text", "")).strip()
        if not text:
            return
        try:
            pcm = self.synthesize(text)
            import sounddevice as sd

            sd.play(pcm, PIPELINE_SAMPLE_RATE)
            sd.wait()
            print(json.dumps({"type": "spoken", "text": text}, ensure_ascii=False), flush=True)
        except Exception as exc:  # noqa: BLE001 - a failed speak must not kill the server
            logger.exception("speak failed")
            print(json.dumps({"type": "error", "error": str(exc)}, ensure_ascii=False), flush=True)

    def run(self) -> None:
        """Consume stdin JSONL until EOF, ``shutdown``, or ``stop_event``.

        Uses ``select`` so shutdown (stop_event) is observed within ~0.5s even
        while stdin is idle, instead of blocking forever on ``readline``.
        """
        while not self.stop_event.is_set():
            try:
                readable, _, _ = select.select([self._stream], [], [], 0.5)
            except (OSError, ValueError):
                # Stream closed or not selectable (e.g. a TTY without a real fd).
                break
            if not readable:
                continue
            line = self._stream.readline()
            if line == "":  # EOF from the parent closing stdin
                break
            self._handle_line(line)
