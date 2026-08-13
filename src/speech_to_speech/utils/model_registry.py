"""Process-wide registry of loaded inference models.

The speech pipeline and the standalone audio API both construct STT/TTS
handlers. Naively, each construction loads its own copy of the model weights,
doubling memory (e.g. Fun-ASR-Nano ~0.8B and Qwen3-TTS ~1.7B). This registry
makes model construction idempotent per process: the first caller loads the
model, every later caller for the same key receives the same instance.

Concurrency: models are not generally thread-safe, so each :class:`SharedModel`
carries a re-entrant lock. Callers that run a single synchronous inference can
use :meth:`SharedModel.run`; callers that stream (iterate a generator) can hold
``shared.lock`` across the iteration.
"""

from __future__ import annotations

import threading
from typing import Any, Callable, Hashable

_RegistryKey = Hashable


class SharedModel:
    """A lazily-loaded model instance shared across callers, with a lock."""

    def __init__(self, loader: Callable[[], Any]) -> None:
        self._loader = loader
        self._model: Any = None
        self._lock = threading.RLock()

    @property
    def lock(self) -> threading.RLock:
        return self._lock

    def load(self) -> Any:
        """Return the shared model, loading it on first access."""
        with self._lock:
            if self._model is None:
                self._model = self._loader()
            return self._model

    def run(self, fn: Callable[[Any], Any]) -> Any:
        """Run ``fn(model)`` under the shared lock and return its result.

        Suitable for synchronous inference calls. For streaming callers that
        must hold the lock across iteration, use ``with shared.lock:`` instead.
        """
        with self._lock:
            return fn(self.load())


_registry: dict[_RegistryKey, SharedModel] = {}
_registry_lock = threading.Lock()


def get_shared_model(key: _RegistryKey, loader: Callable[[], Any]) -> SharedModel:
    """Return the :class:`SharedModel` for *key*, creating it on first use."""
    with _registry_lock:
        model = _registry.get(key)
        if model is None:
            model = SharedModel(loader)
            _registry[key] = model
        return model


def reset_shared_models() -> None:
    """Clear the registry (used by tests)."""
    with _registry_lock:
        _registry.clear()


def canonical_device(device: str | None) -> str:
    """Return the device that will actually be used for *device*.

    Mirrors the fallback behaviour of the funasr/torch loaders: an unavailable
    accelerator resolves to ``"cpu"``. Callers use this to build registry keys
    so a model requested as ``"cuda"`` and one requested as ``"cpu"`` on the
    same CUDA-less host still share the same instance.
    """
    if not device:
        return "cpu"
    kind = device.split(":")[0].lower()
    if kind in ("cuda", "mps"):
        import torch

        available = torch.cuda.is_available() if kind == "cuda" else torch.backends.mps.is_available()
        return kind if available else "cpu"
    return kind
