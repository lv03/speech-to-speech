"""Speaker verification via 3D-Speaker ERes2NetV2 (funasr).

A ``VoiceprintProfile`` stores one normalized enrollment embedding (averaged
over several takes) plus the metadata needed to reproduce verification. A
``Voiceprint`` lazily loads the funasr model and extracts embeddings from
16 kHz float32 audio. Matching is cosine similarity against a tunable
threshold; with enrollment and verification both using the wake word, the
same-speaker score sits near 1.0 and impostors score well below the default
0.75 threshold.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "iic/speech_eres2netv2_sv_zh-cn_16k-common"
SAMPLE_RATE = 16000
DEFAULT_WAKE_WORD = "你好，噜噜"

PROFILE_SCHEMA_VERSION = 2
CONVERSATION_ENROLLMENT_PROTOCOL = "conversation_v1"
LEGACY_ENROLLMENT_PROTOCOL = "legacy_wake_word_v1"


def _normalized(embedding: np.ndarray) -> np.ndarray:
    """Return a non-zero vector scaled to unit L2 norm."""
    value = np.asarray(embedding, dtype=np.float32).squeeze()
    norm = float(np.linalg.norm(value))
    if value.ndim != 1 or value.size == 0 or norm <= 0:
        raise ValueError("Voiceprint embedding must be a non-zero vector")
    return (value / norm).astype(np.float32)


@dataclass
class VoiceprintProfile:
    """A stored speaker reference embedding and its provenance."""

    embedding: np.ndarray
    model_name: str = DEFAULT_MODEL
    wake_word: str = DEFAULT_WAKE_WORD
    takes: int = 1
    created_at: float = field(default_factory=time.time)
    schema_version: int = PROFILE_SCHEMA_VERSION
    enrollment_protocol: str = CONVERSATION_ENROLLMENT_PROTOCOL
    total_duration_s: float = 0.0

    @property
    def supports_conversation_gate(self) -> bool:
        return (
            self.schema_version == PROFILE_SCHEMA_VERSION
            and self.enrollment_protocol == CONVERSATION_ENROLLMENT_PROTOCOL
        )

    def require_conversation_gate(self) -> None:
        if not self.supports_conversation_gate:
            raise ValueError(
                "Voiceprint profile uses legacy wake-word enrollment; "
                "re-enroll with `speech-to-speech voiceprint enroll`."
            )

    def score(self, embedding: np.ndarray) -> float:
        """Cosine similarity in [-1, 1] between this profile and *embedding*."""
        a = np.asarray(self.embedding, dtype=np.float32)
        b = np.asarray(embedding, dtype=np.float32)
        if a.shape != b.shape or a.size == 0:
            return 0.0
        norm = float(np.linalg.norm(a) * np.linalg.norm(b))
        if norm == 0:
            return 0.0
        return float(np.dot(a, b) / norm)

    def save(self, path: Path | str) -> Path:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        np.savez(
            path,
            embedding=np.asarray(self.embedding, dtype=np.float32),
            model_name=self.model_name,
            wake_word=self.wake_word,
            takes=self.takes,
            created_at=self.created_at,
            schema_version=self.schema_version,
            enrollment_protocol=self.enrollment_protocol,
            total_duration_s=self.total_duration_s,
        )
        return path

    @classmethod
    def load(cls, path: Path | str) -> VoiceprintProfile:
        path = Path(path)
        if not path.is_file():
            raise FileNotFoundError(f"Voiceprint profile not found: {path}")
        with np.load(path, allow_pickle=False) as data:
            schema_version = int(data["schema_version"]) if "schema_version" in data.files else 1
            enrollment_protocol = (
                str(data["enrollment_protocol"])
                if "enrollment_protocol" in data.files
                else LEGACY_ENROLLMENT_PROTOCOL
            )
            total_duration_s = float(data["total_duration_s"]) if "total_duration_s" in data.files else 0.0
            return cls(
                embedding=data["embedding"],
                model_name=str(data["model_name"]),
                wake_word=str(data["wake_word"]),
                takes=int(data["takes"]),
                created_at=float(data["created_at"]),
                schema_version=schema_version,
                enrollment_protocol=enrollment_protocol,
                total_duration_s=total_duration_s,
            )


class Voiceprint:
    """Lazily-loaded ERes2NetV2 embedding extractor."""

    def __init__(self, model_name: str = DEFAULT_MODEL) -> None:
        self.model_name = model_name
        self._model: Any = None

    @property
    def model(self) -> Any:
        if self._model is None:
            try:
                from funasr import AutoModel
            except ImportError as exc:  # pragma: no cover
                raise ImportError(
                    "Voiceprint verification requires funasr. Install it with "
                    "`pip install speech-to-speech[paraformer]`."
                ) from exc
            logger.info("Loading voiceprint model: %s", self.model_name)
            self._model = AutoModel(model=self.model_name, disable_update=True, disable_pbar=True)
            logger.info("Voiceprint model loaded")
        return self._model

    def embed(self, audio: np.ndarray) -> np.ndarray:
        """Extract a 192-dim speaker embedding from 16 kHz float32 audio."""
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim != 1 or len(audio) < SAMPLE_RATE // 2:
            raise ValueError(f"Voiceprint needs at least 0.5 s of 16 kHz mono audio, got {len(audio)} samples")
        result = self.model.generate(input=audio, fs=SAMPLE_RATE)
        return np.asarray(result[0]["spk_embedding"], dtype=np.float32).squeeze()

    def enroll(
        self,
        takes: list[np.ndarray],
        wake_word: str = DEFAULT_WAKE_WORD,
        enrollment_protocol: str = CONVERSATION_ENROLLMENT_PROTOCOL,
    ) -> VoiceprintProfile:
        """Average several enrollment takes into a normalized profile."""
        if not takes:
            raise ValueError("At least one enrollment take is required")
        normalized_takes = np.stack([_normalized(self.embed(take)) for take in takes])
        centroid = _normalized(normalized_takes.mean(axis=0))
        logger.info("Enrolled voiceprint from %d takes (model=%s)", len(takes), self.model_name)
        return VoiceprintProfile(
            embedding=centroid,
            model_name=self.model_name,
            wake_word=wake_word,
            takes=len(takes),
            enrollment_protocol=enrollment_protocol,
            total_duration_s=sum(len(take) for take in takes) / SAMPLE_RATE,
        )


@dataclass(frozen=True)
class VoiceprintMatch:
    """A speaker score plus the embedding that produced it."""

    score: float
    embedding: np.ndarray


class VoiceprintVerifier:
    """Thread-safe speaker scoring around one profile and one extractor."""

    def __init__(
        self,
        *,
        profile: VoiceprintProfile,
        voiceprint: Voiceprint,
        profile_path: Path | None = None,
    ) -> None:
        self.profile = profile
        self.voiceprint = voiceprint
        self.profile_path = Path(profile_path) if profile_path else None
        self._lock = Lock()

    @classmethod
    def load(
        cls,
        path: Path | str,
        *,
        require_conversation: bool = False,
    ) -> "VoiceprintVerifier":
        profile_path = Path(path)
        profile = VoiceprintProfile.load(profile_path)
        if require_conversation:
            profile.require_conversation_gate()
        return cls(
            profile=profile,
            voiceprint=Voiceprint(model_name=profile.model_name),
            profile_path=profile_path,
        )

    def preload(self) -> None:
        with self._lock:
            _ = self.voiceprint.model

    def verify(self, audio: np.ndarray) -> VoiceprintMatch:
        with self._lock:
            embedding = self.voiceprint.embed(audio)
            return VoiceprintMatch(self.profile.score(embedding), embedding)

    def adapt(self, embedding: np.ndarray, *, weight: float = 0.15) -> None:
        with self._lock:
            blended = (1.0 - weight) * self.profile.embedding + weight * embedding
            self.profile.embedding = _normalized(blended)
            if self.profile_path is not None:
                self.profile.save(self.profile_path)
