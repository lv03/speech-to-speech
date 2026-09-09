"""Configuration for the optional memory backend."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping

BACKEND_OFF = "off"
BACKEND_VOICEMEM = "voicemem"


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
            )
            if not value
        ]
        if missing:
            raise MemoryConfigError(
                "memory backend 'voicemem' requires " + ", ".join(missing)
            )
        if not os.path.exists(str(self.sidecar_script)):
            raise MemoryConfigError(f"sidecar script not found: {self.sidecar_script}")
        if not os.path.exists(str(self.sidecar_python)):
            raise MemoryConfigError(f"sidecar interpreter not found: {self.sidecar_python}")

    def child_env(self) -> dict[str, str]:
        """Environment for the sidecar process (inherits ours, then overrides)."""
        merged = dict(os.environ)
        merged.update({str(key): str(value) for key, value in self.env.items()})
        # mem0 defaults telemetry to on and posts to us.i.posthog.com.
        merged.setdefault("MEM0_TELEMETRY", "false")
        merged.setdefault("VOICEMEM_MEMORY_LANGUAGE", "zh")
        return merged


__all__ = ["BACKEND_OFF", "BACKEND_VOICEMEM", "MemoryConfig", "MemoryConfigError"]
