"""Construction helper shared by the CLI paths.

Keeping it here (rather than in `cli.py`) lets the local pipeline builder use the
same logic without importing the CLI module.
"""

from __future__ import annotations

import logging
import os

from .config import MemoryConfig
from .provider import MemoryProvider

logger = logging.getLogger(__name__)


def build_memory_provider(
    *,
    backend: str | None,
    sidecar_python: str | None = None,
    sidecar_script: str | None = None,
    memory_root: str | None = None,
    extraction_base_url: str | None = None,
    extraction_model: str | None = None,
    max_context_chars: int = 1200,
    sidecar_backend: str = "real",
    unlocked: bool = False,
) -> MemoryProvider | None:
    """Build and start the provider, or return None when the backend is off.

    ``unlocked`` must stay False for callers that own a security gate; they
    unlock the provider from the gate callback instead.
    """
    # Environment fallback so a parent process (the desktop app) can pass paths
    # without putting them in argv, where they would surface in process listings.
    backend = backend or os.environ.get("S2S_MEMORY_BACKEND")
    sidecar_python = sidecar_python or os.environ.get("S2S_MEMORY_SIDECAR_PYTHON")
    sidecar_script = sidecar_script or os.environ.get("S2S_MEMORY_SIDECAR_SCRIPT")
    memory_root = memory_root or os.environ.get("S2S_MEMORY_ROOT")
    extraction_base_url = extraction_base_url or os.environ.get("S2S_MEMORY_BASE_URL")
    extraction_model = extraction_model or os.environ.get("S2S_MEMORY_MODEL")
    embedder_backend = os.environ.get("S2S_MEMORY_EMBEDDER", "qmd").strip() or "qmd"
    embedder_base_url = os.environ.get("S2S_MEMORY_EMBEDDER_BASE_URL")
    raw_chars = os.environ.get("S2S_MEMORY_MAX_CHARS")
    if raw_chars and raw_chars.isdigit():
        max_context_chars = int(raw_chars)
    if not backend or backend == "off":
        return None
    provider = MemoryProvider(
        MemoryConfig(
            backend=backend,
            sidecar_python=sidecar_python,
            sidecar_script=sidecar_script,
            memory_root=memory_root,
            extraction_base_url=extraction_base_url,
            extraction_model=extraction_model,
            embedder_backend=embedder_backend,
            embedder_base_url=embedder_base_url,
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
