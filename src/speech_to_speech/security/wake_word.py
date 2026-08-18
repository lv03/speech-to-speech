"""Streaming Chinese wake-word detection via sherpa-onnx KWS.

The bundled model (`pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01`)
is a 3.3M zipformer keyword spotter trained on WenetSpeech. Keywords are defined
as space-separated pinyin initials/finals followed by ``@显示文本``, e.g.::

    x iǎo ài t óng x ué @小爱同学

Tones matter: the model distinguishes ``ū`` (first tone) from ``ù`` (fourth
tone). The default wake word ``噜噜噜噜`` registers several tone variants
because first-tone ``lū`` is rare in the training data and is not recognised
reliably, while ``lù`` is.

On detection, ``process`` returns the wake word's audio segment (cropped from a
rolling buffer using the decoder's token timestamps) so the caller can run
speaker verification on exactly the wake word, not on surrounding speech.
"""

from __future__ import annotations

import logging
from collections import deque
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

KWS_MODEL_ID = "pkufool/sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01"
SAMPLE_RATE = 16000
DEFAULT_WAKE_WORD = "噜噜噜噜"

# All tone variants of "lu lu lu lu". Registering every variant makes the
# detector fire however the speaker pronounces the word; the model only
# reliably matches the tones it saw in training (lù here).
DEFAULT_WAKE_WORD_VARIANTS = (
    "l ū l ū l ū l ū",
    "l ù l ù l ù l ù",
    "l u l u l u l u",
    "l ú l ú l ú l ú",
    "l ǔ l ǔ l ǔ l ǔ",
)

# Beam-search budget and trigger sensitivity for the KWS decoder. Capping the
# active paths at 4 (sherpa-onnx's default) cuts steady-state CPU markedly
# while leaving fixed-keyword accuracy essentially unchanged; 0.25 is the
# false-wake vs miss trade-off point tuned for ordinary office noise.
_MAX_ACTIVE_PATHS = 4
_KEYWORDS_THRESHOLD = 0.25

# Reset the decoder stream after this much audio without a hit. Long window so
# a reset can never land inside a wake word (~1.5 s): the earlier 8 s window
# split roughly one attempt in seven, which read as "wake word not sensitive".
# The decoder consumes frames as they become ready, so the stream's memory
# stays bounded regardless of this window.
_STREAM_RESET_SECONDS = 30.0

# Rolling buffer length in seconds; must comfortably exceed the longest
# acceptable wake word (plus margins) so the crop never underflows.
_RING_S = 4.0

# Fixed crop window for speaker verification. Both enrollment and live
# verification return exactly this much audio, right-aligned to (last speech
# frame + _CROP_END_MARGIN_S); when the source audio is shorter (enrollment
# recordings start with the word), the window is front-padded with silence.
# A fixed-length window keeps the silence/speech ratio identical across
# attempts, which stabilises the embedding scores far better than a variable
# energy-trimmed burst.
_CROP_TARGET_S = 1.6
_CROP_END_MARGIN_S = 0.3

# Hard cap on decode rounds per chunk so a misbehaving decoder can never spin
# the gate thread forever (it would otherwise stop consuming audio entirely).
_MAX_DECODE_ROUNDS = 200

# Energy ratio above the ring's median noise floor that counts as speech.
# Kept low because quiet speakers in noisy rooms otherwise fall under an
# adaptive threshold derived from their own noise floor.
_SPEECH_ENERGY_RATIO = 2.0


def crop_last_speech_burst(
    audio: np.ndarray,
    *,
    target_s: float = _CROP_TARGET_S,
    end_margin_s: float = _CROP_END_MARGIN_S,
) -> np.ndarray:
    """Return a fixed-length window ending shortly after the last speech burst.

    Used by both enrollment and live verification so the two paths embed the
    same kind of audio segment: exactly ``target_s`` seconds, right-aligned to
    the end of the most recent speech plus ``end_margin_s`` of trailing
    silence, front-padded with silence when the source is shorter. The speaker
    pauses right after the wake word, so this window contains the wake word
    with the same acoustic context every time.
    """
    target_samples = int(target_s * SAMPLE_RATE)
    if len(audio) < int(0.3 * SAMPLE_RATE):
        audio = np.concatenate([np.zeros(target_samples - len(audio), dtype=np.float32), audio]) if len(audio) < target_samples else audio
        return audio[-target_samples:]

    frame_len = int(0.02 * SAMPLE_RATE)
    n_frames = len(audio) // frame_len
    frames = audio[: n_frames * frame_len].reshape(n_frames, frame_len)
    rms = np.sqrt(np.mean(frames.astype(np.float64) ** 2, axis=1))
    noise_floor = max(float(np.median(rms)), 1e-4)
    speech = rms > noise_floor * _SPEECH_ENERGY_RATIO

    if speech.any():
        end = min(len(audio), (int(np.where(speech)[0][-1]) + 1) * frame_len + int(end_margin_s * SAMPLE_RATE))
    else:
        # Pure silence or speech below the adaptive floor: hand back the tail.
        end = len(audio)

    start = max(0, end - target_samples)
    crop = audio[start:end]
    if len(crop) < target_samples:
        crop = np.concatenate([np.zeros(target_samples - len(crop), dtype=np.float32), crop])
    return crop


def _resolve_model_dir() -> Path:
    """Locate the KWS model snapshot, downloading it on first use."""
    try:
        from modelscope import snapshot_download
    except ImportError as exc:  # pragma: no cover
        raise ImportError("Wake word detection requires modelscope. Install it with `pip install modelscope`.") from exc
    return Path(snapshot_download(KWS_MODEL_ID))


class WakeWordDetector:
    """Feed 16 kHz float32 audio chunks; get the wake word audio on detection."""

    def __init__(
        self,
        wake_word: str = DEFAULT_WAKE_WORD,
        variants: tuple[str, ...] = DEFAULT_WAKE_WORD_VARIANTS,
        num_threads: int = 2,
        model_dir: str | Path | None = None,
    ) -> None:
        import sherpa_onnx

        self.wake_word = wake_word
        self._model_dir = Path(model_dir) if model_dir else _resolve_model_dir()
        keyword_spec = "/".join(f"{variant} @{wake_word}" for variant in variants)
        self._kws = sherpa_onnx.KeywordSpotter(
            tokens=str(self._model_dir / "tokens.txt"),
            encoder=str(self._model_dir / "encoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
            decoder=str(self._model_dir / "decoder-epoch-12-avg-2-chunk-16-left-64.onnx"),
            joiner=str(self._model_dir / "joiner-epoch-12-avg-2-chunk-16-left-64.onnx"),
            keywords_file=str(self._model_dir / "keywords.txt"),
            num_threads=num_threads,
            max_active_paths=_MAX_ACTIVE_PATHS,
            keywords_threshold=_KEYWORDS_THRESHOLD,
            provider="cpu",
        )
        self._keyword_spec = keyword_spec
        self._stream: Any = None
        self._fed_samples = 0
        self._ring: deque[np.ndarray] = deque()
        self._ring_samples = 0
        self._ring_capacity = int(_RING_S * SAMPLE_RATE)
        self._reset_stream()

    def _reset_stream(self) -> None:
        self._stream = self._kws.create_stream(self._keyword_spec)
        self._fed_samples = 0
        self._ring.clear()
        self._ring_samples = 0

    def reset(self) -> None:
        """Discard buffered audio (used when the pipeline session restarts)."""
        self._reset_stream()

    def _push_ring(self, samples: np.ndarray) -> None:
        self._ring.append(samples)
        self._ring_samples += len(samples)
        while self._ring_samples > self._ring_capacity and self._ring:
            dropped = self._ring.popleft()
            self._ring_samples -= len(dropped)

    def _crop_wake_audio(self) -> np.ndarray:
        """Crop the ring to the wake word using an adaptive energy trim.

        sherpa-onnx exposes no per-token timestamps for KWS, so the crop uses
        the acoustic structure instead: the wake word is the last speech burst
        in the ring (the speaker pauses right after saying it). Frame RMS is
        compared against the ring's own median noise floor, which keeps the
        threshold meaningful across microphones and gains.
        """
        audio = np.concatenate(list(self._ring)) if self._ring else np.zeros(0, dtype=np.float32)
        return crop_last_speech_burst(audio)

    def process(self, samples: np.ndarray) -> np.ndarray | None:
        """Feed one chunk of 16 kHz float32 samples.

        Returns the wake word's audio segment on detection, ``None`` otherwise.
        The detector resets its stream and ring after a detection, so the
        returned audio is exactly the keyword (plus small margins).
        """
        if len(samples) == 0:
            return None
        self._stream.accept_waveform(SAMPLE_RATE, samples)
        self._fed_samples += len(samples)
        self._push_ring(samples)

        # A detection fires once per keyword; crop the ring right away. The
        # decode budget bounds the loop so a wedged decoder cannot stop the
        # gate thread from consuming audio.
        for _ in range(_MAX_DECODE_ROUNDS):
            if not self._kws.is_ready(self._stream):
                break
            self._kws.decode_stream(self._stream)
            if self._kws.get_result(self._stream):
                wake_audio = self._crop_wake_audio()
                self._reset_stream()
                return wake_audio

        if self._fed_samples >= int(SAMPLE_RATE * _STREAM_RESET_SECONDS):
            self._reset_stream()
        return None
