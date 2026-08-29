"""Security gate handler: wake-word unlock in front of the VAD stage.

The gate consumes the raw audio queue that would otherwise feed the VAD
directly. While locked it swallows every chunk and runs the wake-word
detector; a detection unlocks the gate so audio flows downstream. Speaker
filtering is performed separately by the continuous voiceprint gate inside the
VAD stage. The gate re-locks when the microphone has been quiet for
``security_timeout_s`` (any audible activity — user speech or assistant
playback leaking back through the mic — resets the timer) or when the client
session ends.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable, Iterator

import numpy as np

from speech_to_speech.baseHandler import BaseHandler
from speech_to_speech.pipeline.handler_types import VADIn
from speech_to_speech.security.wake_word import DEFAULT_WAKE_WORD, WakeWordDetector

logger = logging.getLogger(__name__)

# Peak float32 amplitude that counts as audible activity for the idle timer.
# Typical speech peaks at 0.05-0.5; background hiss stays well below 0.02.
_AUDIO_ACTIVITY_PEAK = 0.02


class SecurityGateHandler(BaseHandler[VADIn, VADIn]):
    """Gate raw PCM16 chunks on wake-word detection."""

    def setup(
        self,
        wake_word: str = DEFAULT_WAKE_WORD,
        wake_word_variants: tuple[str, ...] | None = None,
        security_timeout_s: float = 60.0,
        unlock_acknowledgment: str = "",
        num_threads: int = 2,
        state_change_callback: Callable[[bool], None] | None = None,
    ) -> None:
        self._wake_word = wake_word
        self._timeout_s = max(0.0, security_timeout_s)
        # Exposed for the websocket router: when the gate unlocks, the router
        # asks the LLM for a short audible acknowledgment so the user knows
        # they may talk.
        self.unlock_acknowledgment = unlock_acknowledgment
        self._state_change_callback = state_change_callback

        self._locked = True
        detector_kwargs: dict[str, Any] = {"wake_word": wake_word, "num_threads": num_threads}
        if wake_word_variants:
            detector_kwargs["variants"] = wake_word_variants
        self._detector = WakeWordDetector(**detector_kwargs)

        self._idle_since: float | None = None
        logger.info("Security gate: locked (wake word %r)", self._wake_word)

    @property
    def is_locked(self) -> bool:
        """Whether the gate currently swallows audio (assistant unavailable)."""
        return self._locked

    # ── lock lifecycle ──────────────────────────────────────────────────────

    def _try_unlock(self) -> None:
        self._locked = False
        self._idle_since = time.monotonic()
        logger.info("Security gate: unlocked (wake word %r)", self._wake_word)
        self._notify_state_change()

    def _relock(self, reason: str) -> None:
        self._locked = True
        self._idle_since = None
        self._detector.reset()
        logger.info("Security gate: locked again (%s)", reason)
        self._notify_state_change()

    def set_state_change_callback(self, callback: Callable[[bool], None]) -> None:
        """Register a listener invoked on every locked/unlocked transition.

        The callback receives ``True`` when locked and ``False`` when unlocked.
        Used by the packaged ``local`` command to surface the gate state to the
        desktop app (which mirrors it as the orb's sleep/awake state). Only
        transitions are reported here; callers that need an initial snapshot
        can read ``is_locked`` separately and emit it themselves.
        """
        self._state_change_callback = callback

    def _notify_state_change(self) -> None:
        callback = getattr(self, "_state_change_callback", None)
        if callback is None:
            return
        try:
            callback(self._locked)
        except Exception:
            logger.exception("Security gate state-change callback failed")

    # ── handler behaviour ───────────────────────────────────────────────────

    def process(self, item: VADIn) -> Iterator[VADIn]:
        raw = item[0] if isinstance(item, tuple) else item
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

        if self._locked:
            wake_audio = self._detector.process(samples)
            if wake_audio is not None:
                self._try_unlock()
            # Locked: swallow audio, forward nothing downstream.
            return

        # Unlocked: enforce the idle timeout on audible activity. Any sound
        # above the noise floor (user speech, or assistant audio leaking back
        # through the mic) resets the timer; quiet for `_timeout_s` re-locks.
        if self._timeout_s > 0:
            now = time.monotonic()
            if float(np.abs(samples).max()) >= _AUDIO_ACTIVITY_PEAK:
                self._idle_since = now
            elif self._idle_since is None:
                self._idle_since = now
            elif now - self._idle_since >= self._timeout_s:
                self._relock(f"no activity for {self._timeout_s:.0f}s")
                return

        yield item

    def on_session_end(self) -> None:
        self._relock("session ended")
