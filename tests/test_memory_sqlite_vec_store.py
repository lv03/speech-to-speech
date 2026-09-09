"""Contract tests for the sqlite-vec mem0 store and the Qdrant migration.

Skipped unless mem0 + sqlite-vec are importable (they live in the sidecar venv,
not the project venv):

    ~/.cache/speech-to-speech/voicemem-venv/bin/python -m pytest tests/test_memory_sqlite_vec_store.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
# The sidecar venv does not install this package; it puts src/ on sys.path (the
# sidecar script does the same), so the test must too.
for extra in (REPO_ROOT / "src", REPO_ROOT / "experiments" / "voicemem"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

from speech_to_speech.memory.vector_store_layout import sqlite_vec_path, vectors_dir  # noqa: E402

pytest.importorskip("mem0")
pytest.importorskip("sqlite_vec")

from mem0.vector_stores.base import VectorStoreBase  # noqa: E402
from migrate_vectors import migrate  # noqa: E402

from speech_to_speech.memory.stores.sqlite_vec import (  # noqa: E402
    SqliteVecStore,
    install_vector_store,
)

DIMS = 8


def _vector(*values: float) -> list[float]:
    return list(values) + [0.0] * (DIMS - len(values))


def _store(tmp_path: Path, **kwargs) -> SqliteVecStore:
    return SqliteVecStore(
        collection_name="facts",
        path=str(tmp_path / "vectors"),
        embedding_model_dims=DIMS,
        chunk_size=16,
        **kwargs,
    )


# ── store contract ───────────────────────────────────────────────────────────


def test_roundtrip_insert_and_search(tmp_path):
    store = _store(tmp_path)
    store.insert(
        vectors=[_vector(1.0), _vector(0.0, 1.0)],
        payloads=[{"data": "坚果过敏", "user_id": "u"}, {"data": "猫叫墨墨", "user_id": "u"}],
        ids=["a", "b"],
    )

    hits = store.search("query", _vector(1.0), top_k=2)

    assert [hit.id for hit in hits] == ["a", "b"]
    assert hits[0].payload["data"] == "坚果过敏"
    assert hits[0].score > hits[1].score


def test_search_accepts_flat_and_nested_vectors(tmp_path):
    """mem0 passes a flat vector to search but a list of vectors to insert."""
    store = _store(tmp_path)
    store.insert(vectors=[_vector(1.0)], payloads=[{"data": "x"}], ids=["a"])

    assert store.search("q", _vector(1.0), top_k=1)[0].id == "a"
    assert store.search("q", [_vector(1.0)], top_k=1)[0].id == "a"
    assert store.search("q", [], top_k=1) == []


def test_search_filters_on_payload(tmp_path):
    store = _store(tmp_path)
    store.insert(
        vectors=[_vector(1.0), _vector(1.0)],
        payloads=[{"data": "mine", "user_id": "u"}, {"data": "theirs", "user_id": "other"}],
        ids=["a", "b"],
    )

    hits = store.search("q", _vector(1.0), top_k=5, filters={"user_id": "u"})

    assert [hit.id for hit in hits] == ["a"]


def test_search_honours_top_k(tmp_path):
    store = _store(tmp_path)
    store.insert(
        vectors=[_vector(1.0) for _ in range(5)],
        payloads=[{"data": str(index)} for index in range(5)],
        ids=[str(index) for index in range(5)],
    )

    assert len(store.search("q", _vector(1.0), top_k=2)) == 2


def test_search_clamps_oversized_top_k(tmp_path):
    """VoiceMem asks for 10_000 candidates; vec0 caps k at 4096."""
    store = _store(tmp_path)
    store.insert(vectors=[_vector(1.0)], payloads=[{"data": "a"}], ids=["a"])

    assert [hit.id for hit in store.search("q", _vector(1.0), top_k=10_000)] == ["a"]


def test_get_update_and_delete(tmp_path):
    store = _store(tmp_path)
    store.insert(vectors=[_vector(1.0)], payloads=[{"data": "old"}], ids=["a"])

    assert store.get("a").payload["data"] == "old"
    assert store.get("missing") is None

    store.update("a", vector=_vector(0.0, 1.0), payload={"data": "new"})

    assert store.get("a").payload["data"] == "new"
    assert store.search("q", _vector(0.0, 1.0), top_k=1)[0].payload["data"] == "new"

    store.delete("a")

    assert store.get("a") is None
    assert store.search("q", _vector(0.0, 1.0), top_k=1) == []


def test_list_col_info_reset_and_delete_col(tmp_path):
    store = _store(tmp_path)
    store.insert(
        vectors=[_vector(1.0), _vector(0.0, 1.0)],
        payloads=[{"data": "a", "user_id": "u"}, {"data": "b", "user_id": "other"}],
        ids=["a", "b"],
    )

    assert [hit.id for hit in store.list(filters={"user_id": "u"})] == ["a"]
    assert [hit.id for hit in store.list(top_k=1)] == ["a"]
    assert store.col_info()["count"] == 2
    assert store.list_cols() == ["facts"]

    store.reset()

    assert store.col_info()["count"] == 0

    store.insert(vectors=[_vector(1.0)], payloads=[{"data": "a"}], ids=["a"])
    store.delete_col()

    assert store.col_info()["count"] == 0


def test_keyword_search_is_inherited_so_mem0_disables_bm25(tmp_path):
    """Returning None from an override would hide mem0's truthful warning."""
    store = _store(tmp_path)

    assert type(store).keyword_search is VectorStoreBase.keyword_search
    assert store.keyword_search("q") is None


def test_second_store_on_same_path_sees_writes(tmp_path):
    """SQLite allows concurrent connections; Qdrant's local mode does not.

    VoiceMem's own comment records 137/152 eval questions failing with
    "Storage folder ... is already accessed by another instance of Qdrant
    client", which is why it caches one Memory client per memory_root.
    """
    first = _store(tmp_path)
    second = _store(tmp_path)

    first.insert(vectors=[_vector(1.0)], payloads=[{"data": "shared"}], ids=["a"])

    assert second.get("a").payload["data"] == "shared"
    assert [hit.id for hit in second.search("q", _vector(1.0), top_k=1)] == ["a"]


def test_install_teaches_mem0_factory_and_config(tmp_path):
    from mem0.utils.factory import VectorStoreFactory
    from mem0.vector_stores.configs import VectorStoreConfig

    install_vector_store("sqlite_vec")

    assert VectorStoreFactory.provider_to_class["sqlite_vec"].endswith("SqliteVecStore")
    config = VectorStoreConfig(
        provider="sqlite_vec",
        config={"collection_name": "facts", "path": str(tmp_path / "v"), "embedding_model_dims": DIMS},
    )
    assert config.config.path == str(tmp_path / "v")


def test_install_redirects_voicemems_hardcoded_qdrant(tmp_path):
    """The seam that makes the swap work without patching VoiceMem."""
    from mem0.vector_stores.configs import VectorStoreConfig

    install_vector_store("sqlite_vec")

    config = VectorStoreConfig(
        provider="qdrant",
        config={"collection_name": "voicemem", "path": str(tmp_path / "vectors"), "embedding_model_dims": DIMS},
    )

    assert config.provider == "sqlite_vec"
    assert config.config.path == str(tmp_path / "vectors")


def test_install_is_idempotent(tmp_path):
    install_vector_store("sqlite_vec")
    install_vector_store("sqlite_vec")  # must not double-wrap VectorStoreConfig.__init__


def test_requires_path_and_cosine(tmp_path):
    with pytest.raises(ValueError, match="requires an explicit path"):
        SqliteVecStore(collection_name="facts", embedding_model_dims=DIMS)

    with pytest.raises(ValueError, match="cosine distance only"):
        _store(tmp_path, distance="euclid")


def test_chunk_size_controls_preallocation(tmp_path):
    """vec0 reserves chunk_size rows up front; keep the small test file small."""
    store = _store(tmp_path)
    store.insert(vectors=[_vector(1.0)], payloads=[{"data": "a"}], ids=["a"])

    assert store.db_path.exists()
    assert store.db_path.stat().st_size < 512 * 1024


# ── migration ────────────────────────────────────────────────────────────────


def _legacy_store(tmp_path: Path, points: list[tuple[str, list[float], dict]]):
    qdrant_client = pytest.importorskip("qdrant_client")
    from mem0.vector_stores.qdrant import Qdrant

    store = Qdrant(
        collection_name="voicemem",
        embedding_model_dims=DIMS,
        path=str(vectors_dir(tmp_path)),
    )
    store.insert(
        vectors=[vector for _, vector, _ in points],
        payloads=[payload for _, _, payload in points],
        ids=[memory_id for memory_id, _, _ in points],
    )
    store.client.close()
    assert qdrant_client is not None
    return store


def test_migration_copies_points_without_re_embedding(tmp_path):
    _legacy_store(
        tmp_path,
        [
            ("11111111-1111-1111-1111-111111111111", _vector(1.0), {"data": "坚果过敏", "user_id": "u"}),
            ("22222222-2222-2222-2222-222222222222", _vector(0.0, 1.0), {"data": "猫叫墨墨", "user_id": "u"}),
        ],
    )

    assert migrate(memory_root=tmp_path, collection="voicemem", batch=8, dry_run=False) == 0

    store = SqliteVecStore(
        collection_name="voicemem",
        path=str(vectors_dir(tmp_path)),
        embedding_model_dims=DIMS,
    )
    assert store.col_info()["count"] == 2
    hits = store.search("q", _vector(1.0), top_k=1)
    assert hits[0].payload["data"] == "坚果过敏"
    assert hits[0].id == "11111111-1111-1111-1111-111111111111"


def test_migration_dry_run_writes_nothing(tmp_path):
    _legacy_store(tmp_path, [("11111111-1111-1111-1111-111111111111", _vector(1.0), {"data": "x"})])

    assert migrate(memory_root=tmp_path, collection="voicemem", batch=8, dry_run=True) == 0

    assert not sqlite_vec_path(tmp_path).exists()


def test_migration_refuses_to_overwrite_existing_sqlite_file(tmp_path):
    _legacy_store(tmp_path, [("11111111-1111-1111-1111-111111111111", _vector(1.0), {"data": "x"})])
    sqlite_vec_path(tmp_path).write_bytes(b"already here")

    assert migrate(memory_root=tmp_path, collection="voicemem", batch=8, dry_run=False) == 2


def test_migration_reports_nothing_to_do(tmp_path):
    assert migrate(memory_root=tmp_path, collection="voicemem", batch=8, dry_run=False) == 2
