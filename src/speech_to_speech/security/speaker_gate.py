"""Progressive per-segment target-speaker verification.

``TargetSpeakerGate`` buffers nothing on its own; the caller (``VADHandler``)
keeps the segment audio and drives this state machine with the current speech
buffer. Verification runs on a single worker so the audio pipeline never
stops to wait for the speaker model, and at most one window is in flight per
segment. Any accepted window permanently opens the segment; the caller is
responsible for releasing the complete buffered prefix.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError
from dataclasses import dataclass
from enum import Enum
from typing import Protocol

import numpy as np

from speech_to_speech.security.voiceprint import SAMPLE_RATE, VoiceprintMatch

logger = logging.getLogger(__name__)

FIRST_CHECK_MS = 800
RETRY_HOP_MS = 500
WINDOW_MS = 1600
MIN_VERIFY_MS = 500
FINAL_WAIT_S = 1.0


class SpeakerVerifier(Protocol):
    def verify(self, audio: np.ndarray) -> VoiceprintMatch: ...


class GateStatus(str, Enum):
    IDLE = "idle"
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"


@dataclass(frozen=True)
class GateDecision:
    status: GateStatus
    max_score: float | None = None
    checks: int = 0
    reason: str | None = None
    latency_s: float | None = None


class TargetSpeakerGate:
    """Asynchronous sliding-window verification for one speech segment."""

    def __init__(
        self,
        verifier: SpeakerVerifier,
        threshold: float,
        *,
        first_check_ms: float = FIRST_CHECK_MS,
        retry_hop_ms: float = RETRY_HOP_MS,
        window_ms: float = WINDOW_MS,
        min_verify_ms: float = MIN_VERIFY_MS,
        final_wait_s: float = FINAL_WAIT_S,
    ) -> None:
        if not 0.0 < threshold <= 1.0:
            raise ValueError(f"voiceprint_threshold must be in (0, 1], got {threshold}")
        self.verifier = verifier
        self.threshold = threshold
        self.first_check_ms = first_check_ms
        self.retry_hop_ms = retry_hop_ms
        self.window_ms = window_ms
        self.min_verify_ms = min_verify_ms
        self.final_wait_s = final_wait_s

        self._executor = ThreadPoolExecutor(max_workers=1)
        self._generation = 0
        self._status = GateStatus.IDLE
        self._future: Future[tuple[int, VoiceprintMatch]] | None = None
        self._queued: tuple[float, np.ndarray] | None = None
        self._last_submit_ms: float | None = None
        self._max_score: float | None = None
        self._checks = 0
        self._reason: str | None = None
        self._start_time: float | None = None

    @property
    def _min_verify_samples(self) -> int:
        return int(self.min_verify_ms * SAMPLE_RATE / 1000)

    # ── public lifecycle ─────────────────────────────────────────────────────

    def start_segment(self) -> None:
        self._generation += 1
        self._status = GateStatus.PENDING
        self._future = None
        self._queued = None
        self._last_submit_ms = None
        self._max_score = None
        self._checks = 0
        self._reason = None
        self._start_time = time.monotonic()

    def observe(self, audio: np.ndarray, *, active_speech_ms: float) -> GateDecision:
        if self._status in (GateStatus.ACCEPTED, GateStatus.REJECTED):
            return self._decision()

        self._collect_done_future()

        if self._future is None and self._queued is not None and self._status is GateStatus.PENDING:
            queued_ms, queued_window = self._queued
            self._queued = None
            self._submit(queued_ms, queued_window)

        if self._status is not GateStatus.PENDING:
            return self._decision()

        samples = np.asarray(audio, dtype=np.float32)
        if len(samples) < self._min_verify_samples:
            return self._decision()

        due = (
            (self._last_submit_ms is None and active_speech_ms >= self.first_check_ms)
            or (
                self._last_submit_ms is not None
                and active_speech_ms >= self._last_submit_ms + self.retry_hop_ms
            )
        )
        if not due:
            return self._decision()

        window = self._window(samples)
        if self._future is None:
            self._submit(active_speech_ms, window)
        else:
            self._queued = (active_speech_ms, window)
        return self._decision()

    def finish(self, audio: np.ndarray) -> GateDecision:
        if self._status is GateStatus.ACCEPTED or self._status is GateStatus.REJECTED:
            return self._decision()

        if self._future is not None:
            self._wait_future(self.final_wait_s)
            if self._status is GateStatus.ACCEPTED or self._status is GateStatus.REJECTED:
                return self._decision()

        samples = np.asarray(audio, dtype=np.float32)
        if len(samples) < self._min_verify_samples:
            return self._mark_rejected("too_short")

        self._submit(len(samples) / SAMPLE_RATE * 1000, self._window(samples))
        self._wait_future(self.final_wait_s)
        if self._status is GateStatus.ACCEPTED or self._status is GateStatus.REJECTED:
            return self._decision()
        return self._mark_rejected("below_threshold")

    def reset(self) -> None:
        self._generation += 1
        self._status = GateStatus.IDLE
        self._future = None
        self._queued = None
        self._last_submit_ms = None
        self._max_score = None
        self._checks = 0
        self._reason = None
        self._start_time = None

    def close(self) -> None:
        self._generation += 1
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ── internals ────────────────────────────────────────────────────────────

    def _decision(self) -> GateDecision:
        latency_s = (time.monotonic() - self._start_time) if self._start_time is not None else None
        return GateDecision(
            status=self._status,
            max_score=self._max_score,
            checks=self._checks,
            reason=self._reason,
            latency_s=latency_s,
        )

    def _window(self, audio: np.ndarray) -> np.ndarray:
        window_samples = int(self.window_ms * SAMPLE_RATE / 1000)
        return np.asarray(audio[-window_samples:], dtype=np.float32).copy()

    def _submit(self, active_ms: float, window: np.ndarray) -> None:
        self._last_submit_ms = active_ms
        self._future = self._executor.submit(self._run_check, self._generation, window)

    def _run_check(self, generation: int, window: np.ndarray) -> tuple[int, VoiceprintMatch]:
        return generation, self.verifier.verify(window)

    def _collect_done_future(self) -> None:
        if self._future is None or not self._future.done():
            return
        future = self._future
        self._future = None
        try:
            generation, match = future.result()
        except Exception:
            self._mark_rejected("verification_error")
            return
        self._apply_result(generation, match)

    def _wait_future(self, timeout: float) -> None:
        if self._future is None:
            return
        future = self._future
        try:
            generation, match = future.result(timeout=timeout)
        except TimeoutError:
            self._future = None
            self._mark_rejected("verification_timeout")
            return
        except Exception:
            self._future = None
            self._mark_rejected("verification_error")
            return
        self._future = None
        self._apply_result(generation, match)

    def _apply_result(self, generation: int, match: VoiceprintMatch) -> None:
        if generation != self._generation:
            return
        self._checks += 1
        if self._max_score is None or match.score > self._max_score:
            self._max_score = match.score
        if match.score >= self.threshold:
            self._mark_accepted()

    def _mark_accepted(self) -> None:
        self._status = GateStatus.ACCEPTED
        self._reason = None
        self._log_decision()

    def _mark_rejected(self, reason: str) -> GateDecision:
        self._status = GateStatus.REJECTED
        self._reason = reason
        self._log_decision()
        return self._decision()

    def _log_decision(self) -> None:
        score = self._max_score if self._max_score is not None else float("nan")
        logger.info(
            "TargetSpeakerGate: segment %s (score=%.3f, threshold=%.2f, checks=%d, reason=%s)",
            self._status.value,
            score,
            self.threshold,
            self._checks,
            self._reason,
        )
