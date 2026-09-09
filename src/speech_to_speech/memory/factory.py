"""Construction helper shared by the CLI paths.

Keeping it here (rather than in `cli.py`) lets the local pipeline builder use the
same logic without importing the CLI module.
"""

from __future__ import annotations

import logging

from .config import MemoryConfig
from .provider import MemoryProvider

logger = logging.getLogger(__name__)


def build_memory_provider(
    *,
    backend: str | None,
    sidecar_python: str | None = None,
    sidecar_script: str | None = None,
    memory_root: str | None = None,
    max_context_chars: int = 1200,
    sidecar_backend: str = "real",
    unlocked: bool = False,
) -> MemoryProvider | None:
    """Build and start the provider, or return None when the backend is off.

    ``unlocked`` must stay False for callers that own a security gate; they
    unlock the provider from the gate callback instead.
    """
    if not backend or backend == "off":
        return None
    provider = MemoryProvider(
        MemoryConfig(
            backend=backend,
            sidecar_python=sidecar_python,
            sidecar_script=sidecar_script,
            memory_root=memory_root,
            max_context_chars=int(max_context_chars),
            sidecar_backend=sidecar_backend,
        )
    )
    if not provider.start():
        logger.warning(
            "Memory backend %s is enabled but the sidecar did not start: %s",
            backend,
            provider.degraded_reason or "unknown",
        )
    elif unlocked:
        provider.set_unlocked(True)
    return provider


__all__ = ["build_memory_provider"]
