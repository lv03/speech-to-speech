"""Text-only speculative prefetch over voicemem's streaming API.

Why this exists: the product already emits partial transcriptions
(`PartialTranscriptionEvent` / `TranscriptionCompletedEvent`, both carrying
`turn_id` / `turn_revision`). voicemem's `VoiceStream` can consume **text**, so
we drive its in-turn speculation with our own STT output and never load its ASR.

Contract (async, because voicemem's stream API is async):

    state = await stream.feed_partial(turn_id, revision, text)
    state = await stream.feed_final(turn_id, revision, final_text)
    state.memory_context -> str ("" when nothing is worth injecting)

Staleness is handled here, not by the caller: a result whose
``(turn_id, turn_revision)`` is no longer the newest one seen is dropped, so a
slow prefetch from an earlier revision can never overwrite a newer turn.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, Sequence, runtime_checkable

DEFAULT_MIN_CHARS = 6


@dataclass(frozen=True)
class PrefetchState:
    """What the caller needs from a stream tick."""

    turn_over: bool
    memory_context: str
    stale: bool = False


@dataclass
class _Turn:
    turn_id: str
    revision: int
    partial: str = ""
    started: bool = False


@runtime_checkable
class PrefetchBackend(Protocol):
    """Minimal surface of voicemem's `VoiceStream` that we rely on."""

    async def feed_partial(self, text: str, ended: bool = False): ...

    async def feed_text(self, text: str): ...


class PrefetchStream:
    """Turn-aware wrapper around a text-only `PrefetchBackend`."""

    def __init__(self, backend: PrefetchBackend, *, min_chars: int = DEFAULT_MIN_CHARS) -> None:
        self._backend = backend
        self._min_chars = max(1, int(min_chars))
        self._current: _Turn | None = None
        self._latest: tuple[str, int] | None = None

    async def feed_partial(self, turn_id: str, revision: int, text: str) -> PrefetchState:
        """Feed a partial transcription. Starts speculation once it is long enough."""
        cleaned = (text or "").strip()
        if not cleaned:
            return PrefetchState(turn_over=False, memory_context="")
        if not self._is_newest(turn_id, revision):
            return PrefetchState(turn_over=False, memory_context="", stale=True)
        self._latest = (turn_id, revision)
        turn = self._current
        if turn is None or turn.turn_id != turn_id or turn.revision != revision:
            turn = _Turn(turn_id=turn_id, revision=revision)
            self._current = turn
        turn.partial = cleaned
        if len(cleaned) < self._min_chars:
            return PrefetchState(turn_over=False, memory_context="")
        state = await self._backend.feed_partial(cleaned)
        turn.started = True
        return PrefetchState(turn_over=False, memory_context=_context_of(state))

    async def feed_final(self, turn_id: str, revision: int, text: str) -> PrefetchState:
        """Feed the final transcription and return the memory context for the turn."""
        cleaned = (text or "").strip()
        if not self._is_newest(turn_id, revision):
            return PrefetchState(turn_over=False, memory_context="", stale=True)
        self._latest = (turn_id, revision)
        turn = self._current
        if turn is None or turn.turn_id != turn_id or turn.revision != revision:
            # No usable speculation (short turn, first event was already final).
            turn = _Turn(turn_id=turn_id, revision=revision)
            self._current = turn
        if not cleaned:
            self._current = None
            return PrefetchState(turn_over=True, memory_context="")
        if not turn.started:
            await self._backend.feed_partial(cleaned)
            turn.started = True
        state = await self._backend.feed_text(cleaned)
        self._current = None
        return PrefetchState(turn_over=True, memory_context=_context_of(state))

    def cancel(self) -> None:
        """Drop the in-flight turn (session locked, barge-in, or engine restart)."""
        self._current = None

    def _is_newest(self, turn_id: str, revision: int) -> bool:
        if self._latest is None:
            return True
        latest_id, latest_revision = self._latest
        if turn_id != latest_id:
            return True  # a new turn always wins
        return revision >= latest_revision


class VoicememPrefetchStream:
    """Real backend: voicemem's text-only stream, created from an existing VoiceMem."""

    def __init__(self, vm, *, min_chars: int = DEFAULT_MIN_CHARS) -> None:
        self._vm = vm
        self._min_chars = min_chars
        self._stream: PrefetchBackend | None = None

    def _ensure(self) -> PrefetchBackend:
        if self._stream is None:
            # Text-only: no VAD/ASR model is loaded until feed() sees PCM.
            self._stream = self._vm.stream(spec_min_chars=self._min_chars)
        return self._stream

    async def feed_partial(self, text: str, ended: bool = False):
        return await self._ensure().feed_partial(text, ended=ended)

    async def feed_text(self, text: str):
        return await self._ensure().feed_text(text)


def _context_of(state) -> str:
    return str(getattr(state, "memory_context", "") or "")


def render_context(hits: Sequence[str], *, header: str) -> str:
    """Render a memory block from plain strings (used by tests and fake backends)."""
    lines = [f"- {hit}" for hit in hits if str(hit).strip()]
    if not lines:
        return ""
    return "\n".join([header, *lines])


__all__ = [
    "DEFAULT_MIN_CHARS",
    "PrefetchBackend",
    "PrefetchState",
    "PrefetchStream",
    "VoicememPrefetchStream",
    "render_context",
]
