"""mem0 vector store backed by SQLite + the sqlite-vec extension.

Replaces mem0's embedded Qdrant (``QdrantConfig(path=...)``) as the memory vector
backend. Measured parity and the cost/benefit analysis are in
``experiments/voicemem/STORE_SWAP.md``; the short version:

- one SQLite file instead of a Qdrant directory tree, with the same engine family
  the app already uses for QMD's index and mem0's history;
- no ``qdrant-client``/``grpcio`` (≈45 MB installed, ≈58 MB RSS);
- SQLite allows concurrent connections, so the "Storage folder ... is already
  accessed by another instance of Qdrant client" failure mode disappears;
- retrieval is at parity (identical Top-1 rows, 0.9-1.2 ms vs 0.4-0.6 ms per
  search, both far below the ~25 ms QMD embedding round trip).

mem0 2.0.20 has no sqlite-vec provider, so ``install_vector_store`` registers one
through two public-ish dict hooks and redirects VoiceMem's hardcoded
``provider="qdrant"``. See that function for the exact seam.

Interface details verified against mem0 2.0.20 source, not assumed:

- ``insert(vectors, payloads, ids)`` receives ``vectors=[embedding]`` (a list of
  vectors) while ``search(query, vectors, ...)`` receives a *flat* vector;
- ``search`` results are read as attributes (``mem.id`` / ``mem.payload`` /
  ``mem.score``, with a ``.get`` fallback), so plain dicts would be dropped as
  "no payload";
- ``keyword_search`` is deliberately *not* overridden: the inherited base method
  returns ``None``, and mem0 logs "this store does not support keyword search"
  and disables BM25. Overriding it with an identical ``return None`` would hide
  that truthful warning.
"""

from __future__ import annotations

import builtins
import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from mem0.vector_stores.base import VectorStoreBase

#: sqlite-vec's own default. 1024 rows x 1024 dims x 4 bytes is a ~4 MB file for an
#: empty collection; see create_col.
DEFAULT_CHUNK_SIZE = 1024

#: vec0 rejects ``k`` above 4096. VoiceMem asks mem0 for 10_000 candidates when it
#: narrows by memory id, and mem0 multiplies that by 4 before calling the store,
#: so the store has to clamp rather than forward the request.
MAX_KNN_K = 4096

#: Set while a process has already installed the provider (idempotence).
_INSTALLED = False
_REDIRECTED = False


@dataclass
class SqliteVecHit:
    """One search/list row, shaped like Qdrant's ``ScoredPoint``."""

    id: str
    payload: dict = field(default_factory=dict)
    score: float = 0.0

    # mem0 falls back to `mem.get("id")` when `hasattr(mem, "id")` is false, but
    # other call sites (and our own probes) may use item access.
    def __getitem__(self, key: str) -> Any:
        return getattr(self, key)

    def get(self, key: str, default: Any = None) -> Any:
        return getattr(self, key, default)


#: Module-level alias: inside the class body the method name ``list`` shadows the
#: builtin in annotations.
VecHits = list[SqliteVecHit]


class SqliteVecStore(VectorStoreBase):
    """Dense-vector store in one SQLite file, using the sqlite-vec extension.

    Layout: a ``vec0`` virtual table for the embeddings plus a plain table for
    the JSON payload, both keyed by the mem0 memory id. Two tables keep the
    extension's fixed column types away from arbitrary payload fields.
    """

    def __init__(
        self,
        *,
        collection_name: str = "memories",
        path: str | None = None,
        embedding_model_dims: int = 1024,
        distance: Any = "cosine",
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        **_ignored: Any,
    ) -> None:
        if not path:
            raise ValueError("SqliteVecStore requires an explicit path")
        if str(distance).lower() not in ("cosine", "distance.cosine"):
            raise ValueError("sqlite-vec store supports cosine distance only")
        self.collection_name = collection_name
        self.embedding_model_dims = int(embedding_model_dims)
        self.chunk_size = max(int(chunk_size), 1)
        self.directory = Path(path).expanduser()
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db_path = self.directory / f"{collection_name}.sqlite"
        self._conn = self._connect()
        self.create_col(self.embedding_model_dims, on_disk=True)

    # ── plumbing ─────────────────────────────────────────────────────────────

    def _connect(self) -> sqlite3.Connection:
        import sqlite_vec

        connection = sqlite3.connect(self.db_path)
        connection.enable_load_extension(True)
        sqlite_vec.load(connection)
        connection.enable_load_extension(False)
        return connection

    def _rows(self, sql: str, params: tuple = ()) -> list[dict]:
        cursor = self._conn.execute(sql, params)
        columns = [column[0] for column in cursor.description or []]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]

    @staticmethod
    def _as_vector(vector: Any) -> list[float]:
        """Accept a flat embedding or a single-element list of embeddings."""
        if vector and isinstance(vector[0], (list, tuple)):
            return [float(value) for value in vector[0]]
        return [float(value) for value in vector]

    # ── schema ───────────────────────────────────────────────────────────────

    def create_col(self, vector_size: int | None = None, on_disk: bool = True, distance: Any = None) -> None:
        dims = int(vector_size or self.embedding_model_dims)
        self.embedding_model_dims = dims
        # vec0 preallocates one chunk of vectors up front: chunk_size rows x dims
        # x 4 bytes. The default (1024 rows) reserves ~4 MB per collection even
        # when empty, so the knob is exposed rather than inherited silently.
        self._conn.execute(
            f"CREATE VIRTUAL TABLE IF NOT EXISTS {self.collection_name}_vec "
            f"USING vec0(id TEXT PRIMARY KEY, embedding float[{dims}] distance_metric=cosine, "
            f"chunk_size={self.chunk_size})"
        )
        self._conn.execute(
            f"CREATE TABLE IF NOT EXISTS {self.collection_name}_payload (id TEXT PRIMARY KEY, payload TEXT NOT NULL)"
        )
        self._conn.commit()

    # ── writes ───────────────────────────────────────────────────────────────

    def insert(
        self, vectors: list[list[float]], payloads: Optional[list[dict]] = None, ids: Optional[list[str]] = None
    ) -> None:
        payloads = payloads or [{} for _ in vectors]
        ids = ids or [str(index) for index in range(len(vectors))]
        for vector, payload, memory_id in zip(vectors, payloads, ids):
            self._conn.execute(
                f"INSERT OR REPLACE INTO {self.collection_name}_vec (id, embedding) VALUES (?, ?)",
                (str(memory_id), json.dumps(self._as_vector(vector))),
            )
            self._conn.execute(
                f"INSERT OR REPLACE INTO {self.collection_name}_payload (id, payload) VALUES (?, ?)",
                (str(memory_id), json.dumps(payload or {}, ensure_ascii=False)),
            )
        self._conn.commit()

    def update(self, vector_id: str, vector: Optional[list[float]] = None, payload: Optional[dict] = None) -> None:
        if vector is not None:
            self._conn.execute(
                f"UPDATE {self.collection_name}_vec SET embedding = ? WHERE id = ?",
                (json.dumps(self._as_vector(vector)), str(vector_id)),
            )
        if payload is not None:
            self._conn.execute(
                f"INSERT OR REPLACE INTO {self.collection_name}_payload (id, payload) VALUES (?, ?)",
                (str(vector_id), json.dumps(payload, ensure_ascii=False)),
            )
        self._conn.commit()

    def delete(self, vector_id: str) -> None:
        self._conn.execute(f"DELETE FROM {self.collection_name}_vec WHERE id = ?", (str(vector_id),))
        self._conn.execute(f"DELETE FROM {self.collection_name}_payload WHERE id = ?", (str(vector_id),))
        self._conn.commit()

    # ── reads ────────────────────────────────────────────────────────────────

    def get(self, vector_id: str) -> Optional[SqliteVecHit]:
        rows = self._rows(
            f"SELECT id, payload FROM {self.collection_name}_payload WHERE id = ?",
            (str(vector_id),),
        )
        if not rows:
            return None
        return SqliteVecHit(id=str(rows[0]["id"]), payload=json.loads(rows[0]["payload"]), score=0.0)

    def search(
        self,
        query: str,
        vectors: Any,
        top_k: int = 5,
        filters: Optional[dict] = None,
    ) -> list[SqliteVecHit]:
        if vectors is None or len(vectors) == 0:
            return []
        embedding = json.dumps(self._as_vector(vectors))
        # vec0 KNN cannot push a payload predicate down, so over-fetch and filter
        # in Python. mem0 asks for max(top_k*4, 60) itself; keep that headroom,
        # but stay inside vec0's k ceiling.
        probe_k = min(max(int(top_k) * 4, 60), MAX_KNN_K)
        rows = self._rows(
            f"SELECT v.id AS id, v.distance AS distance, p.payload AS payload "
            f"FROM {self.collection_name}_vec v "
            f"LEFT JOIN {self.collection_name}_payload p ON p.id = v.id "
            f"WHERE v.embedding MATCH ? AND k = ? "
            f"ORDER BY v.distance",
            (embedding, probe_k),
        )
        results: list[SqliteVecHit] = []
        for row in rows:
            payload = json.loads(row["payload"]) if row["payload"] else {}
            if not _matches(payload, filters):
                continue
            results.append(
                SqliteVecHit(
                    id=str(row["id"]),
                    payload=payload,
                    score=max(0.0, 1.0 - float(row["distance"])),
                )
            )
            if len(results) >= int(top_k):
                break
        return results

    def list(self, filters: Optional[dict] = None, top_k: Optional[int] = None) -> VecHits:
        rows = self._rows(f"SELECT id, payload FROM {self.collection_name}_payload ORDER BY id")
        results: list[SqliteVecHit] = []
        for row in rows:
            payload = json.loads(row["payload"])
            if not _matches(payload, filters):
                continue
            results.append(SqliteVecHit(id=str(row["id"]), payload=payload))
            if top_k and len(results) >= int(top_k):
                break
        return results

    def list_cols(self) -> builtins.list[str]:
        return [self.collection_name]

    def delete_col(self) -> None:
        self._conn.execute(f"DROP TABLE IF EXISTS {self.collection_name}_vec")
        self._conn.execute(f"DROP TABLE IF EXISTS {self.collection_name}_payload")
        self._conn.commit()

    def col_info(self) -> dict:
        """Describe the collection; a deleted collection reports zero rows."""
        rows = self._rows(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            (f"{self.collection_name}_payload",),
        )
        if not rows:
            return {"name": self.collection_name, "count": 0, "dims": self.embedding_model_dims}
        count = self._rows(f"SELECT COUNT(*) AS count FROM {self.collection_name}_payload")
        return {"name": self.collection_name, "count": count[0]["count"], "dims": self.embedding_model_dims}

    def reset(self) -> None:
        self.delete_col()
        self.create_col(self.embedding_model_dims, on_disk=True)


def _matches(payload: dict, filters: Optional[dict]) -> bool:
    """Minimal filter support: equality, operator dicts, ``$or``/``$not``."""
    if not filters:
        return True
    for key, expected in filters.items():
        if key in ("AND", "OR", "NOT", "$or", "$and", "$not"):
            continue  # mem0 flattens logical operators before calling the store
        actual = payload.get(key)
        if isinstance(expected, dict):
            if "ne" in expected and actual == expected["ne"]:
                return False
            if "eq" in expected and actual != expected["eq"]:
                return False
            if "in" in expected and actual not in expected["in"]:
                return False
            if "nin" in expected and actual in expected["nin"]:
                return False
            if "gt" in expected and not (actual is not None and actual > expected["gt"]):
                return False
            if "gte" in expected and not (actual is not None and actual >= expected["gte"]):
                return False
            if "lt" in expected and not (actual is not None and actual < expected["lt"]):
                return False
            if "lte" in expected and not (actual is not None and actual <= expected["lte"]):
                return False
            if "contains" in expected and expected["contains"] not in str(actual or ""):
                return False
            if "icontains" in expected and expected["icontains"].lower() not in str(actual or "").lower():
                return False
        elif actual != expected:
            return False
    return True


def _register_provider() -> None:
    """Teach mem0's factory about this provider (no fork required)."""
    from mem0.utils.factory import VectorStoreFactory

    VectorStoreFactory.provider_to_class["sqlite_vec"] = "speech_to_speech.memory.stores.sqlite_vec.SqliteVecStore"


def _register_config_model() -> None:
    """Make ``VectorStoreConfig(provider="sqlite_vec", ...)`` validate.

    mem0 validates the provider name twice: ``VectorStoreConfig`` checks a
    hardcoded ``_provider_configs`` table and imports
    ``mem0.configs.vector_stores.<provider>`` for a matching pydantic model.
    Both hooks are plain dicts, so a provider can be added at import time
    without touching mem0's source: expose a config model under a synthetic
    module name, then point the table at it.
    """
    import sys
    import types

    from pydantic import BaseModel, Field

    class SqliteVecConfig(BaseModel):
        collection_name: str = Field("memories", description="Name of the collection")
        embedding_model_dims: Optional[int] = Field(1024, description="Dimensions of the embedding model")
        path: Optional[str] = Field("/tmp/sqlite-vec", description="Directory holding the SQLite file")
        distance: str = Field("cosine", description="Distance metric (cosine only)")
        chunk_size: int = Field(DEFAULT_CHUNK_SIZE, description="vec0 rows preallocated per chunk")
        on_disk: Optional[bool] = Field(True, description="Accepted for signature parity with QdrantConfig")

    module_name = "mem0.configs.vector_stores.sqlite_vec"
    module = types.ModuleType(module_name)
    setattr(module, "SqliteVecConfig", SqliteVecConfig)
    sys.modules[module_name] = module

    from mem0.vector_stores.configs import VectorStoreConfig

    providers = VectorStoreConfig.__private_attributes__["_provider_configs"].default
    providers["sqlite_vec"] = "SqliteVecConfig"


def _redirect_qdrant_to_sqlite_vec() -> None:
    """Rewrite ``provider="qdrant"`` to ``sqlite_vec`` in mem0's config.

    VoiceMem hardcodes ``VectorStoreConfig(provider="qdrant", ...)`` when it
    builds ``MemoryConfig``, so there is no configuration seam above mem0's own
    pydantic class. The path is unchanged (``<memory_root>/vectors``), which is
    why only the provider name has to be rewritten.

    Upstream fix to prefer: make the provider configurable in VoiceMem, after
    which this shim can be deleted (see ``experiments/voicemem/STORE_SWAP.md``).
    """
    global _REDIRECTED
    if _REDIRECTED:
        return
    from mem0.vector_stores.configs import VectorStoreConfig

    original_init = VectorStoreConfig.__init__

    def patched_init(self, **data):  # noqa: ANN001 - pydantic passes **data
        if data.get("provider") == "qdrant":
            data = dict(data)
            data["provider"] = "sqlite_vec"
            data["config"] = dict(data.get("config") or {})
        original_init(self, **data)

    VectorStoreConfig.__init__ = patched_init
    _REDIRECTED = True


def install_vector_store(provider: str) -> None:
    """Make the mem0 store VoiceMem builds use ``provider``.

    Idempotent. Must run before the first ``VoiceMem``/``mem0.Memory`` is
    constructed in this process. ``"qdrant"`` is a no-op: VoiceMem already asks
    for it.
    """
    global _INSTALLED
    if provider != "sqlite_vec":
        if provider != "qdrant":
            raise ValueError(f"unsupported memory vector store: {provider!r}")
        return
    if _INSTALLED:
        return
    try:
        import sqlite_vec  # noqa: F401
    except ImportError as exc:
        raise ImportError(
            "the 'sqlite-vec' package is required for S2S_MEMORY_VECTOR_STORE=sqlite_vec; "
            "install it in the sidecar venv (see experiments/voicemem/provision.py)"
        ) from exc
    _register_provider()
    _register_config_model()
    _redirect_qdrant_to_sqlite_vec()
    _INSTALLED = True


__all__ = [
    "DEFAULT_CHUNK_SIZE",
    "MAX_KNN_K",
    "SqliteVecHit",
    "SqliteVecStore",
    "install_vector_store",
]
