from queue import Queue
from threading import Event
from typing import Any, Optional

from pydantic import BaseModel, ConfigDict

from speech_to_speech.api.openai_realtime.service import RealtimeService
from speech_to_speech.pipeline.cancel_scope import CancelScope


class PipelineUnit(BaseModel):
    """One isolated realtime pipeline.

    Each unit owns its queues, events, RealtimeService, and the chain of handler
    instances (VAD, STT, transcription notifier, LM, LM output processor, TTS).
    Lives inside the pool managed by RealtimeServer; a transport route claims a
    free unit (``session is None``) on accept and releases it on disconnect.

    The per-session lifecycle (claim/release/drain, output gate, usage salvage,
    send loop) lives in ``session_lifecycle``; ``session`` here is an opaque
    handle owned by that module. Transport routes touch it only through
    ``is_claimed`` and the lifecycle functions, never through its internals.
    """

    model_config = ConfigDict(arbitrary_types_allowed=True)

    index: int
    service: RealtimeService
    cancel_scope: CancelScope
    should_listen: Event
    response_playing: Event
    input_queue: Queue
    output_queue: Queue
    text_output_queue: Queue
    text_prompt_queue: Queue
    handlers: list[Any]

    session: Optional[Any] = None

    @property
    def is_claimed(self) -> bool:
        """Whether a client currently holds this unit."""
        return self.session is not None

    # ── Cancel-scope wrappers ────────────────────────────────────────────
    # Encapsulate generation bookkeeping so the lifecycle layer never reaches
    # into cancel_scope internals (new_response/cancel/reset/is_stale/...).

    def new_response_generation(self) -> None:
        self.cancel_scope.new_response()

    def cancel_generation(self) -> None:
        self.cancel_scope.cancel()

    def reset_generation(self) -> None:
        self.cancel_scope.reset()

    def is_generation_stale(self, generation: int | None) -> bool:
        return generation is not None and self.cancel_scope.is_stale(generation)

    def is_generation_discarding(self, generation: int | None) -> bool:
        return self.cancel_scope.discarding and generation != self.cancel_scope.generation

    def mark_generation_done(self, generation: int | None) -> None:
        self.cancel_scope.response_done(generation)

    # ── Security gate ─────────────────────────────────────────────────────

    def is_security_locked(self) -> bool:
        """Whether a security gate is installed and currently locked.

        While locked, the pipeline must not answer any client-triggered
        request (text input included): audio is already swallowed by the gate,
        and this check extends the same silence to protocol-level response
        triggers such as the demo's startup greeting.
        """
        for handler in self.handlers:
            is_locked = getattr(handler, "is_locked", None)
            if is_locked is not None:
                return bool(is_locked)
        return False

    def security_unlock_acknowledgment(self) -> str | None:
        """The unlock-acknowledgment prompt of the installed security gate."""
        for handler in self.handlers:
            ack = getattr(handler, "unlock_acknowledgment", None)
            if ack is not None:
                return ack
        return None
