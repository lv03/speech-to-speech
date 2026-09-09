"""Prototype QMD-backed memory store: file layout and result mapping."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qmd_store import QmdMemoryStore, _parse  # noqa: E402


class _Response:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _Client:
    def __init__(self, payload):
        self.payload = payload
        self.calls = []

    def post(self, url, json=None):
        self.calls.append((url, json))
        return _Response(self.payload)


def _store(tmp_path, *, mode="vec-only", payload=None):
    store = QmdMemoryStore(
        root=tmp_path / "facts",
        collection="memfacts",
        query_base_url="http://127.0.0.1:9",
        qmd_command=["qmd"],
        mode=mode,
    )
    store.reindex = lambda: store.reindexed.append(True) if hasattr(store, "reindexed") else None  # type: ignore[method-assign]
    if not hasattr(store, "reindexed"):
        store.reindexed = []  # type: ignore[attr-defined]
    store._client = _Client(payload or {"results": []})  # noqa: SLF001
    return store


def test_add_writes_one_markdown_file_per_fact_and_reindexes(tmp_path):
    store = _store(tmp_path)
    ids = store.add_records_with_ids("u", [("m1", "用户对坚果过敏", "user", {"time_start": "2026-09-01"})])

    assert ids == ["m1"]
    path = tmp_path / "facts/u/m1.md"
    meta, body = _parse(path.read_text(encoding="utf-8"))
    assert body == "用户对坚果过敏"
    assert meta["user_id"] == "u"
    assert meta["observed_at"] == "2026-09-01"
    assert store.reindexed == [True]


def test_empty_text_is_skipped_and_does_not_reindex(tmp_path):
    store = _store(tmp_path)
    assert store.add_records_with_ids("u", [("m1", "   ", "user", {})]) == []
    assert store.reindexed == []


def test_list_ids_and_delete_and_update(tmp_path):
    store = _store(tmp_path)
    store.add_records_with_ids("u", [("m2", "乙", "user", {}), ("m1", "甲", "user", {})])
    assert store.list_ids(user_id="u") == ["m1", "m2"]

    assert store.update_memory("m1", "甲（修订）", observed_at="2026-09-02") is True
    _, body = _parse((tmp_path / "facts/u/m1.md").read_text(encoding="utf-8"))
    assert body == "甲（修订）"

    assert store.delete_memory("m2") is True
    assert store.list_ids(user_id="u") == ["m1"]
    assert store.delete_memory("missing") is False


def test_search_maps_qmd_results_and_filters(tmp_path):
    payload = {
        "results": [
            {"file": "qmd://memfacts/u/m1.md", "score": 0.91},
            {"file": "qmd://memfacts/u/m2.md", "score": 0.40},
            {"file": "qmd://memfacts/u/m3.md", "score": 0.99},
        ]
    }
    store = _store(tmp_path, payload=payload)
    store.add_records_with_ids(
        "u",
        [
            ("m1", "用户对坚果过敏", "user", {}),
            ("m2", "助手建议避开坚果", "assistant", {}),
            ("m3", "归档的旧事实", "user", {}),
        ],
    )
    (tmp_path / "facts/u/m3.md").write_text(
        (tmp_path / "facts/u/m3.md").read_text(encoding="utf-8").replace("archived: false", "archived: true"),
        encoding="utf-8",
    )

    hits = store.search("过敏", user_id="u", top_k=5)
    assert [hit.memory_id for hit in hits] == ["m1"]
    assert hits[0].score == 0.91

    with_assistant = store.search("过敏", user_id="u", top_k=5, include_assistant=True)
    assert [hit.memory_id for hit in with_assistant] == ["m1", "m2"]

    filtered = store.search("过敏", user_id="u", top_k=5, memory_id_filter=["m3"])
    assert filtered == []


def test_search_mode_selects_the_query_shape(tmp_path):
    store = _store(tmp_path, mode="vec-only")
    store.search("问题", user_id="u", top_k=3)
    assert store._client.calls[0][1]["searches"] == [{"type": "vec", "query": "问题"}]  # noqa: SLF001

    hybrid = _store(tmp_path, mode="hybrid")
    hybrid.search("问题", user_id="u", top_k=3)
    assert hybrid._client.calls[0][1]["searches"] == [  # noqa: SLF001
        {"type": "lex", "query": "问题"},
        {"type": "vec", "query": "问题"},
    ]
    assert hybrid._client.calls[0][1]["rerank"] is True  # noqa: SLF001


def test_unimplemented_methods_are_explicit(tmp_path):
    store = _store(tmp_path)
    calls = {
        "list_entries": lambda: store.list_entries(user_id="u"),
        "existing_for_extractor": lambda: store.existing_for_extractor("u"),
        "memory_ids_with_time_expr": lambda: store.memory_ids_with_time_expr("u", kind="date"),
        "archive_memory": lambda: store.archive_memory("m1"),
        "unarchive_memory": lambda: store.unarchive_memory("m1"),
    }
    for name, call in calls.items():
        try:
            call()
        except NotImplementedError:
            continue
        raise AssertionError(f"{name} should be NotImplementedError in the prototype")
