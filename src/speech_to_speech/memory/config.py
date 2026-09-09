"""Configuration for the optional memory backend."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping

BACKEND_OFF = "off"
BACKEND_VOICEMEM = "voicemem"

#: mem0 vector backend inside the sidecar. ``sqlite_vec`` keeps the whole stack on
#: SQLite (one file, no qdrant-client/grpcio, concurrent connections);
#: ``qdrant`` is the pre-2026-09 default and stays as the rollback path.
VECTOR_STORE_SQLITE_VEC = "sqlite_vec"
VECTOR_STORE_QDRANT = "qdrant"
VECTOR_STORES = (VECTOR_STORE_SQLITE_VEC, VECTOR_STORE_QDRANT)


class MemoryConfigError(ValueError):
    """Raised when memory is enabled without the inputs it needs."""


@dataclass(frozen=True)
class MemoryConfig:
    """Everything the provider needs to reach the sidecar.

    ``sidecar_python`` must be an interpreter that has voicemem installed (its
    own venv, never the application runtime); ``sidecar_script`` is the JSONL
    entry point; ``memory_root`` is the app-private memory directory.
    """

    backend: str = BACKEND_OFF
    sidecar_python: str | None = None
    sidecar_script: str | None = None
    memory_root: str | None = None
    sidecar_backend: str = "real"  # "real" uses voicemem; "fake" is for tests
    #: OpenAI-compatible endpoint used for fact extraction (writes). Required:
    #: voicemem would otherwise default to api.openai.com, which is neither the
    #: user's choice nor necessarily reachable.
    extraction_base_url: str | None = None
    #: Chat model used for fact extraction (empty = voicemem default).
    extraction_model: str | None = None
    #: Where memory embeddings come from. Only "qmd" is supported in the product:
    #: it reuses the model the QMD daemon already has loaded.
    embedder_backend: str = "qmd"
    #: QMD daemon base URL (its patched /embed route lives there).
    embedder_base_url: str | None = None
    #: mem0's vector backend in the sidecar (see VECTOR_STORES). SQLite/sqlite-vec
    #: by default: same engine family as QMD's index and mem0's history, no
    #: qdrant-client/grpcio, and no single-client-per-directory lock.
    vector_store: str = VECTOR_STORE_SQLITE_VEC
    max_context_chars: int = 1200
    min_partial_chars: int = 6
    interactive_timeout_ms: int = 30_000
    background_timeout_ms: int = 120_000
    env: Mapping[str, str] = field(default_factory=dict)

    @property
    def enabled(self) -> bool:
        return self.backend == BACKEND_VOICEMEM

    def validate(self) -> None:
        """Fail closed when enabled without its required inputs."""
        if not self.enabled:
            return
        missing = [
            name
            for name, value in (
                ("sidecar_python", self.sidecar_python),
                ("sidecar_script", self.sidecar_script),
                ("memory_root", self.memory_root),
                ("extraction_base_url", self.extraction_base_url),
                ("embedder_base_url", self.embedder_base_url),
            )
            if not value
        ]
        if missing:
            raise MemoryConfigError("memory backend 'voicemem' requires " + ", ".join(missing))
        if not os.path.exists(str(self.sidecar_script)):
            raise MemoryConfigError(f"sidecar script not found: {self.sidecar_script}")
        if not os.path.exists(str(self.sidecar_python)):
            raise MemoryConfigError(f"sidecar interpreter not found: {self.sidecar_python}")
        if self.vector_store not in VECTOR_STORES:
            raise MemoryConfigError(
                f"memory vector_store must be one of {', '.join(VECTOR_STORES)}; got {self.vector_store!r}"
            )

    def child_env(self) -> dict[str, str]:
        """Environment for the sidecar process (inherits ours, then overrides)."""
        merged = dict(os.environ)
        merged.update({str(key): str(value) for key, value in self.env.items()})
        # mem0 defaults telemetry to on and posts to us.i.posthog.com.
        merged.setdefault("MEM0_TELEMETRY", "false")
        merged.setdefault("VOICEMEM_MEMORY_LANGUAGE", "zh")
        # The extraction endpoint is scoped to the sidecar child only: exporting
        # OPENAI_BASE_URL in the voice process could redirect other components.
        if self.extraction_base_url:
            merged["OPENAI_BASE_URL"] = self.extraction_base_url
        if self.extraction_model:
            merged["OPENAI_MODEL"] = self.extraction_model
        # Embeddings always come from the QMD daemon; there is no silent fallback
        # to a locally downloaded model.
        merged["S2S_MEMORY_EMBEDDER"] = self.embedder_backend
        if self.embedder_base_url:
            merged["S2S_MEMORY_EMBEDDER_BASE_URL"] = self.embedder_base_url
        # Pinned, not inherited: a stray value in the parent environment must not
        # silently change where memory is stored.
        merged["S2S_MEMORY_VECTOR_STORE"] = self.vector_store
        return merged


__all__ = [
    "BACKEND_OFF",
    "BACKEND_VOICEMEM",
    "VECTOR_STORE_QDRANT",
    "VECTOR_STORE_SQLITE_VEC",
    "VECTOR_STORES",
    "MemoryConfig",
    "MemoryConfigError",
]
