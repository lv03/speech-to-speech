"""Embeddings served by the QMD daemon (patched ``POST /embed`` route).

The memory backend reuses the embedding model QMD already has loaded instead of
downloading and loading a second one. QMD's HTTP server exposes that model
through a route added by ``desktop/patches/qmd-embed-route.patch``; this module
is the Python client for it.

Design notes:

- one reused ``httpx.Client`` (a fresh client per call measured 50-80 ms extra);
- every call goes through voicemem's ``(model, text)`` embedding cache when
  voicemem is importable, which turns repeated turns into 0 calls;
- ``probe()`` fails closed: if the daemon is not reachable, memory reports a
  degraded state instead of silently switching to another model.
"""

from __future__ import annotations

from typing import Any, Callable, Sequence

DEFAULT_TIMEOUT_S = 30.0


class EmbeddingUnavailableError(RuntimeError):
    """Raised when the embedding endpoint cannot serve vectors."""


def embed_cache_resolve(model: str, texts: list[str], compute: Callable[[list[str]], list[list[float]]]) -> list[list[float]]:
    """Reuse voicemem's in-process (model, text) embedding cache when available.

    voicemem only wires this into its built-in OpenAI embedders; injected
    embedders bypass it, which is why a turn issued 8-11 calls instead of ~4.
    """
    try:
        from voicemem.utils.common import embed_cache
    except ImportError:  # pragma: no cover - voicemem is present in practice
        return compute(texts)
    return embed_cache.resolve(model, texts, compute)


class QmdEmbedder:
    """OpenAI-embeddings-shaped client for the QMD daemon's ``POST /embed`` route."""

    def __init__(self, *, base_url: str, timeout: float = DEFAULT_TIMEOUT_S) -> None:
        self.base_url = base_url.rstrip("/")
        self.timeout = float(timeout)
        self._dimensions: int | None = None
        self._client: Any = None

    # ── transport ────────────────────────────────────────────────────────────

    def _http(self):
        if self._client is None:
            import httpx

            self._client = httpx.Client(timeout=self.timeout)
        return self._client

    def _post(self, texts: list[str], *, is_query: bool) -> list[list[float]]:
        try:
            response = self._http().post(
                f"{self.base_url}/embed",
                json={"texts": texts, "isQuery": is_query},
            )
            response.raise_for_status()
            payload = response.json()
        except Exception as exc:  # noqa: BLE001 - every failure is "unavailable"
            raise EmbeddingUnavailableError(f"QMD embed endpoint failed: {type(exc).__name__}") from exc
        rows = sorted(payload["data"], key=lambda row: row.get("index", 0))
        return [list(map(float, row["embedding"])) for row in rows]

    # ── embedder interface (voicemem's TextEmbedder) ──────────────────────────

    @property
    def model_name(self) -> str:
        return f"qmd-embed ({self.base_url})"

    @property
    def dimensions(self) -> int:
        if self._dimensions is None:
            self._dimensions = len(self._post(["dimension probe"], is_query=False)[0])
        return self._dimensions

    def embed_texts(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        return embed_cache_resolve(self.model_name, list(texts), lambda batch: self._post(batch, is_query=False))

    def embed_query_text(self, text: str) -> list[float]:
        return embed_cache_resolve(self.model_name, [text], lambda batch: self._post(batch, is_query=True))[0]

    def encode(self, texts: Sequence[str], normalize_embeddings: bool = True):
        """SentenceTransformer-compatible shim for voicemem's slot classifier."""
        import numpy as np

        # The classifier marks queries with a "query: " prefix; batch by role so a
        # slot matrix costs one call instead of one per slot.
        prepared = [(text, text.startswith("query: ")) for text in texts]
        rows: list[list[float] | None] = [None] * len(prepared)
        for is_query in (False, True):
            indexes = [index for index, (_, query) in enumerate(prepared) if query is is_query]
            if not indexes:
                continue
            batch = [prepared[index][0] for index in indexes]

            def _compute(items: list[str], query_role: bool = is_query) -> list[list[float]]:
                return self._post(items, is_query=query_role)

            vectors = embed_cache_resolve(self.model_name, batch, _compute)
            for index, vector in zip(indexes, vectors):
                rows[index] = vector
        matrix = np.asarray(rows, dtype="float32")
        if normalize_embeddings:
            norms = np.linalg.norm(matrix, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            matrix = matrix / norms
        return matrix

    # ── lifecycle ────────────────────────────────────────────────────────────

    def probe(self) -> int:
        """Verify the endpoint serves vectors. Raises EmbeddingUnavailableError."""
        return self.dimensions

    def close(self) -> None:
        if self._client is not None:
            try:
                self._client.close()
            finally:
                self._client = None


__all__ = ["DEFAULT_TIMEOUT_S", "EmbeddingUnavailableError", "QmdEmbedder", "embed_cache_resolve"]
