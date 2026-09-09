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

import logging
import os
import shutil
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Protocol, Sequence, runtime_checkable

# The sidecar venv does not install this package; every consumer (sidecar,
# smoke scripts, tests) gets src/ on the path the same way.
_SRC = Path(__file__).resolve().parents[2] / "src"
if _SRC.is_dir() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from speech_to_speech.memory.config import VECTOR_STORE_QDRANT, VECTOR_STORE_SQLITE_VEC  # noqa: E402
from speech_to_speech.memory.embedder import EmbeddingUnavailableError, QmdEmbedder  # noqa: E402
from speech_to_speech.memory.embedder import embed_cache_resolve as _embed_cache_resolve  # noqa: E402
from speech_to_speech.memory.vector_store_layout import migration_hint, needs_migration  # noqa: E402

logger = logging.getLogger(__name__)

DEFAULT_TOP_K = 5


def _install_vector_store(memory_root: Path) -> None:
    """Point mem0 at the configured vector backend before VoiceMem builds it.

    Fails closed when switching to sqlite-vec would start from an empty store
    while a Qdrant store still holds the only copy of the memories: silently
    appearing to lose every memory is worse than refusing to start.
    """
    provider = (os.environ.get("S2S_MEMORY_VECTOR_STORE") or VECTOR_STORE_SQLITE_VEC).strip().lower()
    if provider == VECTOR_STORE_QDRANT:
        return
    if provider != VECTOR_STORE_SQLITE_VEC:
        raise MemoryNotConfiguredError(
            f"S2S_MEMORY_VECTOR_STORE must be {VECTOR_STORE_SQLITE_VEC!r} or "
            f"{VECTOR_STORE_QDRANT!r}; got {provider!r}"
        )
    if needs_migration(memory_root):
        raise MemoryNotConfiguredError(migration_hint(memory_root))
    try:
        from speech_to_speech.memory.stores.sqlite_vec import install_vector_store
    except ImportError as exc:  # pragma: no cover - depends on the sidecar venv
        raise MemoryBackendUnavailableError(
            "S2S_MEMORY_VECTOR_STORE=sqlite_vec requires mem0 and sqlite-vec in the sidecar venv"
        ) from exc
    try:
        install_vector_store(provider)
    except ImportError as exc:
        raise MemoryBackendUnavailableError(str(exc)) from exc


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



#: Qwen3-Embedding's documented query format (documents are raw text).
QWEN3_QUERY_PREFIX = "Instruct: Retrieve relevant documents for the given query\nQuery: "


class RemoteOpenAIEmbedder:
    """Embeddings from an OpenAI-compatible ``/embeddings`` endpoint.

    Exists so the memory store can reuse an embedding model the project already
    runs elsewhere (e.g. the QMD GGUF served by llama-server) instead of
    downloading and loading a second model. Also exposes ``encode()`` so
    voicemem's local slot classifier can share the same remote model.
    """

    def __init__(
        self,
        *,
        base_url: str,
        model: str = "embedding",
        api_key: str = "sk-local",
        query_prefix: str = "",
        doc_prefix: str = "",
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.api_key = api_key
        self.query_prefix = query_prefix
        self.doc_prefix = doc_prefix
        self.timeout = float(timeout)
        self._dimensions: int | None = None
        self._client = None

    def _http(self):
        if self._client is None:
            import httpx

            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _post(self, inputs: list[str]) -> list[list[float]]:
        response = self._http().post(
            f"{self.base_url}/embeddings",
            json={"model": self.model, "input": inputs},
            headers={"Authorization": f"Bearer {self.api_key}"},
        )
        response.raise_for_status()
        payload = response.json()
        rows = sorted(payload["data"], key=lambda row: row.get("index", 0))
        return [list(map(float, row["embedding"])) for row in rows]

    @property
    def model_name(self) -> str:
        return f"{self.model} (remote {self.base_url})"

    @property
    def dimensions(self) -> int:
        if self._dimensions is None:
            self._dimensions = len(self._post(["dimension probe"])[0])
        return self._dimensions

    def embed_texts(self, texts):
        if not texts:
            return []
        return self._post([f"{self.doc_prefix}{text}" for text in texts])

    def embed_query_text(self, text: str):
        return self._post([f"{self.query_prefix}{text}"])[0]

    def encode(self, texts, normalize_embeddings: bool = True):
        """SentenceTransformer-compatible shim for voicemem's slot classifier."""
        import numpy as np

        prepared = [
            f"{self.query_prefix}{text[len('query: '):]}"
            if text.startswith("query: ")
            else f"{self.doc_prefix}{text}"
            for text in texts
        ]
        matrix = np.asarray(self._post(prepared), dtype="float32")
        if normalize_embeddings:
            norms = np.linalg.norm(matrix, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            matrix = matrix / norms
        return matrix





def _warm_classifier(classifier) -> None:
    """Build the slot matrix once, before any concurrent classify call.

    Two threads classifying at the same time both see an empty matrix and each
    embed the 7 slot descriptions; the embedding cache cannot dedupe concurrent
    identical batches.
    """
    try:
        classifier._slots_matrix()  # noqa: SLF001 - voicemem exposes no public warmup
    except Exception:  # noqa: BLE001 - warmup must never block startup
        pass


#: Loaded llama.cpp models, keyed by (path, n_ctx). voicemem issues ~11 embedding
#: calls per turn, so the model must be loaded once and reused.
_LLAMA_CACHE: dict[tuple[str, int], Any] = {}


def _l2_normalize(rows: list[list[float]]) -> list[list[float]]:
    import numpy as np

    matrix = np.asarray(rows, dtype="float32")
    norms = np.linalg.norm(matrix, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    return (matrix / norms).tolist()


class LlamaCppEmbedder:
    """In-process embeddings from a GGUF via llama.cpp (Metal on macOS).

    Reuses the model file the project already ships for QMD, without an HTTP
    hop: voicemem issues ~11 embedding calls per turn, and a network round trip
    per call is what made the llama-server variant 10x slower.
    """

    def __init__(
        self,
        *,
        model_path: str,
        n_ctx: int = 2048,
        n_gpu_layers: int = -1,
        query_prefix: str = "",
        doc_prefix: str = "",
        verbose: bool = False,
    ) -> None:
        self.model_path = str(Path(model_path).expanduser())
        self.query_prefix = query_prefix
        self.doc_prefix = doc_prefix
        self._n_ctx = int(n_ctx)
        self._n_gpu_layers = int(n_gpu_layers)
        self._verbose = bool(verbose)
        self._dimensions: int | None = None
        # llama.cpp contexts are not thread-safe; voicemem calls embeddings from
        # the speculation worker thread, so every call is serialized.
        self._lock = threading.Lock()

    def _llama(self):
        key = (self.model_path, self._n_ctx)
        instance = _LLAMA_CACHE.get(key)
        if instance is None:
            try:
                import llama_cpp
            except ImportError as exc:
                raise MemoryNotConfiguredError(
                    "S2S_MEMORY_EMBEDDER=llama-cpp requires llama-cpp-python in the sidecar venv"
                ) from exc
            instance = llama_cpp.Llama(
                model_path=self.model_path,
                embedding=True,
                n_ctx=self._n_ctx,
                n_gpu_layers=self._n_gpu_layers,
                pooling_type=llama_cpp.LLAMA_POOLING_TYPE_LAST,
                verbose=self._verbose,
            )
            _LLAMA_CACHE[key] = instance
        return instance

    @property
    def model_name(self) -> str:
        return f"{Path(self.model_path).name} (llama.cpp)"

    @property
    def dimensions(self) -> int:
        if self._dimensions is None:
            self._dimensions = int(self._llama().n_embd())
        return self._dimensions

    def _embed(self, texts: list[str]) -> list[list[float]]:
        with self._lock:
            payload = self._llama().create_embedding(texts)
        rows = sorted(payload["data"], key=lambda row: row.get("index", 0))
        return _l2_normalize([list(map(float, row["embedding"])) for row in rows])

    def embed_texts(self, texts):
        if not texts:
            return []
        return _embed_cache_resolve(
            self.model_name, [f"{self.doc_prefix}{text}" for text in texts], self._embed
        )

    def embed_query_text(self, text: str):
        return _embed_cache_resolve(self.model_name, [f"{self.query_prefix}{text}"], self._embed)[0]

    def encode(self, texts, normalize_embeddings: bool = True):
        import numpy as np

        prepared = [
            f"{self.query_prefix}{text[len('query: '):]}"
            if text.startswith("query: ")
            else f"{self.doc_prefix}{text}"
            for text in texts
        ]
        # _embed already L2-normalizes; the slot classifier relies on that.
        return np.asarray(_embed_cache_resolve(self.model_name, prepared, self._embed), dtype="float32")



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

    def open_prefetch(self, *, min_chars: int | None = None):
        """Open a text-only speculative prefetch stream on this memory store.

        Returns a `prefetch.PrefetchStream`; callers feed partial transcriptions
        and read `memory_context` at turn end. Requires the same unlock and
        consent gates as any other read.
        """
        self._require_unlocked()
        backend = self._ensure_backend()
        opener = getattr(backend, "open_stream", None)
        if opener is None:
            raise MemoryNotConfiguredError("this backend does not support streaming prefetch")
        try:
            import prefetch as prefetch_module
        except ImportError as exc:  # pragma: no cover - depends on sys.path
            raise MemoryNotConfiguredError(
                "experiments/voicemem must be on sys.path to import prefetch"
            ) from exc
        kwargs = {} if min_chars is None else {"min_chars": min_chars}
        return prefetch_module.PrefetchStream(opener(), **kwargs)

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
        embedder_kind = os.environ.get("S2S_MEMORY_EMBEDDER", "local").strip().lower()
        if embedder_kind in ("qmd", "qmd-embed"):
            embed_base = os.environ.get("S2S_MEMORY_EMBEDDER_BASE_URL", "").strip()
            if not embed_base:
                raise MemoryNotConfiguredError(
                    "S2S_MEMORY_EMBEDDER=qmd requires S2S_MEMORY_EMBEDDER_BASE_URL"
                )
            from voicemem.leftbrain.cognitive_graph.local_query_classifier import LocalQueryClassifier

            shared = QmdEmbedder(base_url=embed_base)
            # Fail closed: if the QMD daemon is not serving embeddings, memory must
            # report a degraded state rather than quietly loading another model.
            try:
                dimensions = shared.probe()
            except EmbeddingUnavailableError as exc:
                raise MemoryBackendUnavailableError(
                    f"memory embeddings unavailable at {embed_base} ({exc})"
                ) from exc
            logger.info("Memory embeddings served by QMD (%s, %d dims)", embed_base, dimensions)
            # One classifier object (not a factory): two instances would build the
            # slot matrix twice, and the concurrent duplicate misses the embed cache.
            classifier = LocalQueryClassifier(model=shared)
            _warm_classifier(classifier)
            kwargs["embedding"] = lambda: shared
            for key in ("slots", "schema"):
                kwargs[key] = classifier
        elif embedder_kind in ("llama-cpp", "llamacpp"):
            gguf = os.environ.get("S2S_MEMORY_EMBEDDER_GGUF", "").strip()
            if not gguf:
                raise MemoryNotConfiguredError(
                    "S2S_MEMORY_EMBEDDER=llama-cpp requires S2S_MEMORY_EMBEDDER_GGUF"
                )
            from voicemem.leftbrain.cognitive_graph.local_query_classifier import LocalQueryClassifier

            local = LlamaCppEmbedder(
                model_path=gguf,
                query_prefix=os.environ.get("S2S_MEMORY_EMBEDDER_QUERY_PREFIX", QWEN3_QUERY_PREFIX),
                doc_prefix=os.environ.get("S2S_MEMORY_EMBEDDER_DOC_PREFIX", ""),
                n_ctx=int(os.environ.get("S2S_MEMORY_EMBEDDER_CTX", "2048")),
                n_gpu_layers=int(os.environ.get("S2S_MEMORY_EMBEDDER_GPU_LAYERS", "-1")),
            )
            classifier = LocalQueryClassifier(model=local)
            _warm_classifier(classifier)
            kwargs["embedding"] = lambda: local
            for key in ("slots", "schema"):
                kwargs[key] = classifier
        elif embedder_kind in ("openai-compat", "remote"):
            embed_base = os.environ.get("S2S_MEMORY_EMBEDDER_BASE_URL", "").strip()
            if not embed_base:
                raise MemoryNotConfiguredError(
                    "S2S_MEMORY_EMBEDDER=openai-compat requires S2S_MEMORY_EMBEDDER_BASE_URL"
                )
            remote = RemoteOpenAIEmbedder(
                base_url=embed_base,
                model=os.environ.get("S2S_MEMORY_EMBEDDER_MODEL", "embedding"),
                query_prefix=os.environ.get("S2S_MEMORY_EMBEDDER_QUERY_PREFIX", QWEN3_QUERY_PREFIX),
                doc_prefix=os.environ.get("S2S_MEMORY_EMBEDDER_DOC_PREFIX", ""),
            )
            from voicemem.leftbrain.cognitive_graph.local_query_classifier import LocalQueryClassifier

            kwargs["embedding"] = lambda: remote
            # main's build_kwargs emits the canonical key `slots`; older builds used
            # `schema`. Overriding only the alias lets the default factory win
            # (`_canon` uses setdefault), which silently keeps loading E5.
            for key in ("slots", "schema"):
                kwargs[key] = lambda: LocalQueryClassifier(model=remote)

        _install_vector_store(self._memory_root)

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

    def open_stream(self):
        """Text-only speculative prefetch stream over this instance's VoiceMem."""
        try:
            import prefetch as prefetch_module
        except ImportError as exc:  # pragma: no cover - depends on sys.path
            raise MemoryNotConfiguredError(
                "experiments/voicemem must be on sys.path to import prefetch"
            ) from exc
        return prefetch_module.VoicememPrefetchStream(self._vm)


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
