"""Security gate handler: wake word + voiceprint in front of the VAD stage.

The gate consumes the raw audio queue that would otherwise feed the VAD
directly. While locked it swallows every chunk and runs the wake-word
detector; a detection returns the wake word's audio segment (cropped with the
same energy trim used during enrollment) and the gate verifies it against the
enrolled voiceprint. Only after the speaker is verified does audio flow
downstream. The gate re-locks when the microphone has been quiet for
``security_timeout_s`` (any audible activity — user speech or assistant
playback leaking back through the mic — resets the timer) or when the client
session ends.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Iterator

import numpy as np

from speech_to_speech.baseHandler import BaseHandler
from speech_to_speech.pipeline.handler_types import VADIn
from speech_to_speech.security.voiceprint import SAMPLE_RATE, Voiceprint, VoiceprintProfile, VoiceprintVerifier
from speech_to_speech.security.wake_word import DEFAULT_WAKE_WORD, WakeWordDetector

logger = logging.getLogger(__name__)

# Peak float32 amplitude that counts as audible activity for the idle timer.
# Typical speech peaks at 0.05-0.5; background hiss stays well below 0.02.
_AUDIO_ACTIVITY_PEAK = 0.02

# Weight of each accepted live verification blended into the stored profile.
# Adapts the enrollment to the live microphone over time, shrinking the
# enrollment/live score gap; bounded so one bad sample cannot poison it.
_PROFILE_ADAPT_WEIGHT = 0.15


class SecurityGateHandler(BaseHandler[VADIn, VADIn]):
    """Gate raw PCM16 chunks on wake word + (optional) voiceprint."""

    def setup(
        self,
        wake_word: str = DEFAULT_WAKE_WORD,
        wake_word_variants: tuple[str, ...] | None = None,
        voiceprint_enrollment: str | Path | None = None,
        voiceprint_verifier: VoiceprintVerifier | None = None,
        voiceprint_threshold: float = 0.75,
        security_timeout_s: float = 60.0,
        unlock_acknowledgment: str = "",
        num_threads: int = 2,
    ) -> None:
        if not 0.0 < voiceprint_threshold <= 1.0:
            raise ValueError(f"voiceprint_threshold must be in (0, 1], got {voiceprint_threshold}")
        if voiceprint_enrollment and voiceprint_verifier:
            raise ValueError("Provide either voiceprint_enrollment or voiceprint_verifier, not both")
        self._wake_word = wake_word
        self._threshold = voiceprint_threshold
        self._timeout_s = max(0.0, security_timeout_s)
        # Exposed for the websocket router: when the gate unlocks, the router
        # asks the LLM for a short audible acknowledgment so the user knows
        # they may talk.
        self.unlock_acknowledgment = unlock_acknowledgment

        self._locked = True
        detector_kwargs: dict[str, Any] = {"wake_word": wake_word, "num_threads": num_threads}
        if wake_word_variants:
            detector_kwargs["variants"] = wake_word_variants
        self._detector = WakeWordDetector(**detector_kwargs)

        self._verifier: VoiceprintVerifier | None = voiceprint_verifier
        if self._verifier is None and voiceprint_enrollment:
            enrollment_path = Path(voiceprint_enrollment)
            profile = VoiceprintProfile.load(enrollment_path)
            voiceprint = Voiceprint(model_name=profile.model_name)
            self._verifier = VoiceprintVerifier(
                profile=profile,
                voiceprint=voiceprint,
                profile_path=enrollment_path,
            )

        if self._verifier is not None:
            logger.info(
                "Security gate: voiceprint enabled (threshold=%.2f)",
                self._threshold,
            )
            # Preload the model here, during pipeline construction, instead of
            # inside the first verification: loading funasr/torch on the live
            # handler thread while audio flows has wedged the thread before,
            # and this also removes the ~10 s first-wake delay.
            logger.info("Security gate: preloading voiceprint model...")
            self._verifier.preload()
            logger.info("Security gate: voiceprint model loaded")
        else:
            logger.info("Security gate: wake word only (no voiceprint profile configured)")

        self._idle_since: float | None = None
        logger.info("Security gate: locked (wake word %r)", self._wake_word)

    @property
    def is_locked(self) -> bool:
        """Whether the gate currently swallows audio (assistant unavailable)."""
        return self._locked

    # ── lock lifecycle ──────────────────────────────────────────────────────

    def _try_unlock(self, wake_audio: np.ndarray) -> None:
        if self._verifier is not None:
            if len(wake_audio) < SAMPLE_RATE // 2:
                logger.warning("Security gate: too little wake-word audio to verify, staying locked")
                return
            match = self._verifier.verify(wake_audio)
            if match.score < self._threshold:
                logger.info(
                    "Security gate: wake word heard but voice rejected (score=%.3f < %.2f)",
                    match.score,
                    self._threshold,
                )
                return
            logger.info(
                "Security gate: voiceprint accepted (score=%.3f >= %.2f)",
                match.score,
                self._threshold,
            )
            try:
                self._verifier.adapt(match.embedding, weight=_PROFILE_ADAPT_WEIGHT)
            except OSError:
                logger.warning("Security gate: could not save adapted voiceprint profile")
        self._locked = False
        self._idle_since = time.monotonic()
        logger.info("Security gate: unlocked (wake word %r)", self._wake_word)

    def _relock(self, reason: str) -> None:
        self._locked = True
        self._idle_since = None
        self._detector.reset()
        logger.info("Security gate: locked again (%s)", reason)

    # ── handler behaviour ───────────────────────────────────────────────────

    def process(self, item: VADIn) -> Iterator[VADIn]:
        raw = item[0] if isinstance(item, tuple) else item
        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

        if self._locked:
            wake_audio = self._detector.process(samples)
            if wake_audio is not None:
                self._try_unlock(wake_audio)
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
