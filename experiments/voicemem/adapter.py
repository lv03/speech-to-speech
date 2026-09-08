"""Experimental voicemem adapter — NOT part of the v1 runtime.

Nothing under ``src/``, ``desktop/`` or ``gateway/`` imports this module, and
``voicemem`` itself is imported lazily so the repository's own environment never
needs the 112 packages it drags in (see ``INTEGRATION_NOTES.md``).

Fixed interfaces, as required by ``docs/kb-memory-integration-proposal.md`` §10::

    ingest_final_turn(text, *, turn_id, turn_revision) -> bool
    recall(query, *, top_k=None) -> tuple[MemoryHit, ...]
    delete_all() -> None

Fail-closed rules encoded here:

1. ``memory_root`` must be explicit. voicemem otherwise writes into the process
   working directory (``voicemem_memoryspace/<space>/``), which for this repo
   would be the checkout.
2. A permission callable must report the session unlocked (voiceprint gate).
   The default reports locked, so nothing is readable or writable until the
   caller wires the real gate.
3. Cloud fact extraction requires an explicit consent flag. voicemem 0.2.3 has
   no local extraction path (``OPENAI_API_KEY`` is mandatory for fact
   extraction), so "not consented" means "memory disabled" — never a silent
   upload.
4. Only final transcriptions are accepted, deduplicated by
   ``(turn_id, turn_revision)``. A repeated or older revision is ignored.
5. ``MEM0_TELEMETRY`` is forced off: mem0 defaults it on and posts to
   ``https://us.i.posthog.com``.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol, Sequence, runtime_checkable

DEFAULT_TOP_K = 5


class MemoryLockedError(RuntimeError):
    """Raised when memory is touched while the session is not unlocked."""


class MemoryNotConfiguredError(RuntimeError):
    """Raised when the adapter has no backend and cannot build one."""


class CloudExtractionNotConsentedError(MemoryNotConfiguredError):
    """Raised when memory is used without explicit cloud-extraction consent."""


class MemoryBackendUnavailableError(MemoryNotConfiguredError):
    """Raised when voicemem is not importable in this interpreter."""


@dataclass(frozen=True)
class MemoryHit:
    """One normalized memory hit, safe to hand to a prompt builder."""

    text: str
    memory_id: str
    observed_at: str = ""
    score: float | None = None
    speaker: str = ""
    channel: str = "leftbrain"


@runtime_checkable
class MemoryBackend(Protocol):
    """The only surface the adapter needs from a backend."""

    def ingest(self, text: str, *, speaker: str) -> None: ...

    def search(self, query: str, *, top_k: int) -> Sequence[MemoryHit]: ...

    def delete_all(self) -> None: ...


class VoiceMemAdapter:
    """Three-interface, fail-closed wrapper around a memory backend.

    Pass ``backend`` in tests to avoid importing voicemem. In production the
    backend is built lazily from ``memory_root`` and requires
    ``allow_cloud_extraction=True``.
    """

    def __init__(
        self,
        *,
        memory_root: str | Path,
        user_id: str = "local-user",
        allow_cloud_extraction: bool = False,
        backend: MemoryBackend | None = None,
        is_unlocked: Callable[[], bool] | None = None,
        top_k: int = DEFAULT_TOP_K,
        api_key: str | None = None,
        base_url: str | None = None,
    ) -> None:
        if memory_root is None or not str(memory_root).strip():
            raise ValueError("memory_root must be an explicit app-private directory")
        self.memory_root = Path(memory_root).expanduser()
        self.user_id = user_id
        self.allow_cloud_extraction = bool(allow_cloud_extraction)
        self._top_k = int(top_k)
        self._is_unlocked = is_unlocked or (lambda: False)
        self._api_key = api_key
        self._base_url = base_url
        self._backend = backend
        self._seen: dict[str, int] = {}

    # ── fixed interface ──────────────────────────────────────────────────────

    def ingest_final_turn(self, text: str, *, turn_id: str, turn_revision: int) -> bool:
        """Store one *final* transcription.

        Returns True when it was written, False when the turn/revision was
        already stored. Call this only from a completed-transcription event;
        partial revisions must never reach this method.
        """
        self._require_unlocked()
        cleaned = (text or "").strip()
        if not cleaned:
            raise ValueError("text must not be empty")
        if not turn_id or not str(turn_id).strip():
            raise ValueError("turn_id is required for deduplication")
        if turn_revision is None or int(turn_revision) < 0:
            raise ValueError("turn_revision must be a non-negative integer")

        revision = int(turn_revision)
        previous = self._seen.get(turn_id)
        if previous is not None and revision <= previous:
            return False

        backend = self._ensure_backend()
        backend.ingest(cleaned, speaker="user")
        # Marked only after a successful write, so a failed write can be retried.
        self._seen[turn_id] = revision
        return True

    def recall(self, query: str, *, top_k: int | None = None) -> tuple[MemoryHit, ...]:
        """Retrieve memory relevant to *query*. Empty query returns no hits."""
        self._require_unlocked()
        cleaned = (query or "").strip()
        if not cleaned:
            return ()
        backend = self._ensure_backend()
        return tuple(backend.search(cleaned, top_k=int(top_k or self._top_k)))

    def delete_all(self) -> None:
        """Delete every memory this adapter owns, then forget the dedup state."""
        self._require_unlocked()
        backend = self._ensure_backend()
        backend.delete_all()
        self._seen.clear()

    def flush(self) -> None:
        """Run voicemem's session-boundary batch work, when a backend exists."""
        if self._backend is not None and hasattr(self._backend, "flush"):
            self._backend.flush()

    # ── gates ────────────────────────────────────────────────────────────────

    def set_permission(self, is_unlocked: Callable[[], bool]) -> None:
        """Wire the voiceprint/security gate. Must return True when unlocked."""
        self._is_unlocked = is_unlocked

    def _require_unlocked(self) -> None:
        if not self._is_unlocked():
            raise MemoryLockedError("memory is locked; unlock the session first")

    def _ensure_backend(self) -> MemoryBackend:
        if self._backend is not None:
            return self._backend
        if not self.allow_cloud_extraction:
            raise CloudExtractionNotConsentedError(
                "voicemem 0.2.3 extracts facts through an OpenAI-compatible chat endpoint "
                "(no local path), so memory stays disabled until cloud extraction is "
                "explicitly consented"
            )
        self._backend = _VoicememBackend(
            memory_root=self.memory_root,
            user_id=self.user_id,
            api_key=self._api_key,
            base_url=self._base_url,
            top_k=self._top_k,
        )
        return self._backend


class _VoicememBackend:
    """Real backend. Requires voicemem in an isolated venv."""

    def __init__(
        self,
        *,
        memory_root: Path,
        user_id: str,
        api_key: str | None = None,
        base_url: str | None = None,
        top_k: int = DEFAULT_TOP_K,
    ) -> None:
        _force_telemetry_off()
        self._memory_root = Path(memory_root)
        try:
            from voicemem.config import build_kwargs
            from voicemem.core import VoiceMem
        except ImportError as exc:  # pragma: no cover - depends on the venv
            raise MemoryBackendUnavailableError(
                "voicemem is not importable in this interpreter; install it in a dedicated venv "
                "(see experiments/voicemem/README.md)"
            ) from exc

        self._memory_root.mkdir(parents=True, exist_ok=True)
        resolved_key = api_key or os.environ.get("OPENAI_API_KEY")
        resolved_base_url = base_url or os.environ.get("OPENAI_BASE_URL")
        resolved_model = os.environ.get("OPENAI_MODEL") or os.environ.get("VOICEMEM_CHAT_MODEL")
        memory_language = (os.environ.get("VOICEMEM_MEMORY_LANGUAGE") or "zh").strip().lower()

        # build_kwargs wires the components; the audio/emotion switches are then
        # forced off because this project feeds voicemem its own STT text and v1
        # excludes the emotion graph.
        config: dict = {
            "api_key": resolved_key,
            "base_url": resolved_base_url,
            "mode": "leftbrain_only",
            "memory_root": str(self._memory_root),
            "user_id": user_id,
            # voicemem main defaults memory text to English; the product stores
            # Chinese facts, so the language must be pinned explicitly.
            "memory_language": memory_language,
            # Embeddings stay local (intfloat/multilingual-e5-small): the chat
            # and embedding endpoints are configured independently, which is
            # what gate 5 asks about.
            "embedding": {"provider": "local"},
            "slots": {"provider": "local"},
            "llm": {
                "provider": "openai",
                "config": {
                    "model": resolved_model,
                    "api_key": resolved_key,
                    "base_url": resolved_base_url,
                },
            },
        }
        if resolved_model:
            config["models"] = {"chat": resolved_model}
        kwargs = build_kwargs(config)
        kwargs.update(
            enable_scene=False,
            enable_music=False,
            enable_abnormal_sound=False,
            enable_voiceprint=False,
            enable_emotion=False,
            top_k=top_k,
        )
        self._vm = VoiceMem(**kwargs)

    def ingest(self, text: str, *, speaker: str) -> None:
        # Ingest is called synchronously on purpose: voicemem's Memory.remember()
        # is fire-and-forget in a daemon thread and swallows errors, which would
        # hide both write failures and the dedup state we just recorded.
        self._vm.Ingest(text, speaker=speaker)

    def search(self, query: str, *, top_k: int) -> Sequence[MemoryHit]:
        classification = self._vm.Classify(query)
        result = self._vm.Search(
            query,
            slots=classification.slots,
            entities=classification.entities,
            top_k=top_k,
        )
        hits = [
            MemoryHit(
                text=str(getattr(hit, "text", "")),
                memory_id=str(getattr(hit, "memory_id", "")),
                observed_at=str(getattr(hit, "observed_at", "") or ""),
                score=_as_float(getattr(hit, "score", None)),
                speaker=str(getattr(hit, "attributed_to", "") or ""),
                channel="leftbrain",
            )
            for hit in (getattr(result, "hits", None) or [])
        ]
        # Right-brain persona/emotion notes are kept separate by voicemem itself;
        # this adapter only surfaces left-brain facts for now (v1 excludes the
        # emotion graph), so rb_hits are deliberately dropped.
        return hits

    def delete_all(self) -> None:
        # voicemem 0.2.3 exposes delete_memory(memory_id) and delete_user(user_id)
        # on internal stores only, with no facade method. Removing the
        # app-private memory root is the supported-by-us equivalent; see GATES.md
        # (gate 6) for the open work item.
        if self._vm is not None:
            try:
                self._vm.Flush()
            except Exception:  # noqa: BLE001 - best effort before deletion
                pass
        if self._memory_root.exists():
            shutil.rmtree(self._memory_root)
        self._memory_root.mkdir(parents=True, exist_ok=True)

    def flush(self) -> None:
        self._vm.Flush()


def _as_float(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _force_telemetry_off() -> None:
    """mem0 defaults MEM0_TELEMETRY to True and posts to us.i.posthog.com."""
    current = os.environ.get("MEM0_TELEMETRY")
    if current is not None and current.strip().lower() not in ("false", "0", "no", ""):
        raise MemoryNotConfiguredError(
            "MEM0_TELEMETRY is enabled; disable it (MEM0_TELEMETRY=false) before using mem0"
        )
    os.environ["MEM0_TELEMETRY"] = "false"
