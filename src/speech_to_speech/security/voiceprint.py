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
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)

DEFAULT_MODEL = "iic/speech_eres2netv2_sv_zh-cn_16k-common"
SAMPLE_RATE = 16000
DEFAULT_WAKE_WORD = "噜噜噜噜"


@dataclass
class VoiceprintProfile:
    """A stored speaker reference embedding and its provenance."""

    embedding: np.ndarray
    model_name: str = DEFAULT_MODEL
    wake_word: str = DEFAULT_WAKE_WORD
    takes: int = 1
    created_at: float = field(default_factory=time.time)

    def score(self, embedding: np.ndarray) -> float:
        """Cosine similarity in [0, 1] between this profile and *embedding*."""
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
        )
        return path

    @classmethod
    def load(cls, path: Path | str) -> VoiceprintProfile:
        path = Path(path)
        if not path.is_file():
            raise FileNotFoundError(f"Voiceprint profile not found: {path}")
        with np.load(path, allow_pickle=False) as data:
            return cls(
                embedding=data["embedding"],
                model_name=str(data["model_name"]),
                wake_word=str(data["wake_word"]),
                takes=int(data["takes"]),
                created_at=float(data["created_at"]),
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

    def enroll(self, takes: list[np.ndarray], wake_word: str = DEFAULT_WAKE_WORD) -> VoiceprintProfile:
        """Average several enrollment takes into a normalized profile."""
        if not takes:
            raise ValueError("At least one enrollment take is required")
        embeddings = np.stack([self.embed(take) for take in takes])
        mean = embeddings.mean(axis=0)
        norm = float(np.linalg.norm(mean))
        if norm == 0:
            raise ValueError("Enrollment produced a zero embedding")
        logger.info("Enrolled voiceprint from %d takes (model=%s)", len(takes), self.model_name)
        return VoiceprintProfile(
            embedding=(mean / norm), model_name=self.model_name, wake_word=wake_word, takes=len(takes)
        )
