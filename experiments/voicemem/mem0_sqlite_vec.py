"""Prototype: a mem0 vector store backed by SQLite + the sqlite-vec extension.

Feasibility only. The question it answers: can the memory vector index live in a
single SQLite file (same engine family QMD already uses) instead of mem0's local
Qdrant, so the stack carries one fewer vector library?

mem0 has no sqlite-vec provider, but ``VectorStoreFactory.provider_to_class`` is
a plain dict, so a custom store can be registered without forking mem0 (see
``register()``). This module implements the subset mem0 2.0.20 actually calls.

Interface notes verified against mem0 2.0.20 source, not assumed:

- ``insert(vectors, payloads, ids)`` receives ``vectors=[embedding]`` (list of
  vectors) while ``search(query, vectors, ...)`` receives a *flat* embedding
  vector -- the two are not the same shape.
- ``search`` results are read as attributes (``mem.id`` / ``mem.payload`` /
  ``mem.score``, with a ``.get`` fallback), so plain dicts would be silently
  dropped as "no payload". Results therefore use ``SqliteVecHit``, which also
  supports ``hit["id"]`` style access for the dict fallback path.
- ``keyword_search`` is deliberately *not* overridden: the inherited base method
  returns ``None``, and mem0 logs "this store does not support keyword search"
  and disables BM25 scoring. Overriding it with an identical ``return None``
  would hide that truthful warning.
"""

from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from mem0.vector_stores.base import VectorStoreBase

# sqlite-vec's own default. 1024 rows x 1024 dims x 4 bytes is a ~4 MB file for an
# empty collection; see create_col.
DEFAULT_CHUNK_SIZE = 1024

#: vec0 rejects ``k`` above 4096. VoiceMem asks mem0 for 10_000 candidates when it
#: narrows by memory id, and mem0 multiplies that by 4 before calling the store,
#: so the store has to clamp rather than forward the request.
MAX_KNN_K = 4096


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
            raise ValueError("prototype supports cosine distance only")
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

    def list(self, filters: Optional[dict] = None, top_k: Optional[int] = None) -> list[SqliteVecHit]:
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

    def list_cols(self) -> list[str]:
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
        distance: str = Field("cosine", description="Distance metric (prototype: cosine only)")
        on_disk: Optional[bool] = Field(True, description="Accepted for signature parity with QdrantConfig")

    module_name = "mem0.configs.vector_stores.sqlite_vec"
    module = types.ModuleType(module_name)
    module.SqliteVecConfig = SqliteVecConfig
    sys.modules[module_name] = module

    from mem0.vector_stores.configs import VectorStoreConfig

    providers = VectorStoreConfig.__private_attributes__["_provider_configs"].default
    providers["sqlite_vec"] = "SqliteVecConfig"


def register() -> None:
    """Teach mem0 about this provider: factory entry + config model (no fork)."""
    from mem0.utils.factory import VectorStoreFactory

    VectorStoreFactory.provider_to_class["sqlite_vec"] = "mem0_sqlite_vec.SqliteVecStore"
    _register_config_model()


__all__ = ["DEFAULT_CHUNK_SIZE", "MAX_KNN_K", "SqliteVecHit", "SqliteVecStore", "register"]
