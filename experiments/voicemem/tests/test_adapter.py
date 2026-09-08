"""Adapter tests. No voicemem install required: every test injects a fake backend.

Run from the repository root:

    PYTHONPATH=experiments/voicemem ./.venv/bin/python -m pytest experiments/voicemem/tests -q

CI is scoped to ``tests/`` (``.github/workflows/ci.yml``), so these stay opt-in
and never couple the v1 suite to the experiment.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from adapter import (  # noqa: E402
    CloudExtractionNotConsentedError,
    MemoryHit,
    MemoryLockedError,
    VoiceMemAdapter,
    _force_telemetry_off,
)


class FakeBackend:
    def __init__(self) -> None:
        self.ingested: list[tuple[str, str]] = []
        self.queries: list[tuple[str, int]] = []
        self.deleted = 0
        self.fail_next_ingest = False

    def ingest(self, text: str, *, speaker: str) -> None:
        if self.fail_next_ingest:
            self.fail_next_ingest = False
            raise RuntimeError("backend write failed")
        self.ingested.append((text, speaker))

    def search(self, query: str, *, top_k: int):
        self.queries.append((query, top_k))
        return [MemoryHit(text=f"fact about {query}", memory_id="m1", score=0.9)]

    def delete_all(self) -> None:
        self.deleted += 1


def unlocked_adapter(backend: FakeBackend | None = None, **kwargs):
    backend = backend or FakeBackend()
    adapter = VoiceMemAdapter(
        memory_root="/tmp/voicemem-test-root",
        backend=backend,
        is_unlocked=lambda: True,
        **kwargs,
    )
    return adapter, backend


# ── gate 4: locked sessions must not read or write ───────────────────────────


def test_default_permission_is_locked():
    adapter = VoiceMemAdapter(memory_root="/tmp/voicemem-test-root", backend=FakeBackend())
    with pytest.raises(MemoryLockedError):
        adapter.ingest_final_turn("我对坚果过敏", turn_id="t1", turn_revision=1)
    with pytest.raises(MemoryLockedError):
        adapter.recall("我对什么过敏")
    with pytest.raises(MemoryLockedError):
        adapter.delete_all()


def test_permission_can_be_wired_after_construction():
    backend = FakeBackend()
    adapter = VoiceMemAdapter(memory_root="/tmp/voicemem-test-root", backend=backend)
    adapter.set_permission(lambda: True)
    assert adapter.ingest_final_turn("我对坚果过敏", turn_id="t1", turn_revision=1) is True
    assert backend.ingested == [("我对坚果过敏", "user")]


def test_locking_again_blocks_reads():
    adapter, _ = unlocked_adapter()
    state = {"unlocked": True}
    adapter.set_permission(lambda: state["unlocked"])
    state["unlocked"] = False
    with pytest.raises(MemoryLockedError):
        adapter.recall("我对什么过敏")


# ── gate 3: final-only ingestion, deduplicated by (turn_id, turn_revision) ───


def test_same_turn_and_revision_is_ignored():
    adapter, backend = unlocked_adapter()
    assert adapter.ingest_final_turn("第一句", turn_id="t1", turn_revision=1) is True
    assert adapter.ingest_final_turn("第一句", turn_id="t1", turn_revision=1) is False
    assert backend.ingested == [("第一句", "user")]


def test_older_revision_is_ignored_but_newer_wins():
    adapter, backend = unlocked_adapter()
    adapter.ingest_final_turn("第二版", turn_id="t1", turn_revision=2)
    assert adapter.ingest_final_turn("第一版", turn_id="t1", turn_revision=1) is False
    assert adapter.ingest_final_turn("第三版", turn_id="t1", turn_revision=3) is True
    assert [text for text, _ in backend.ingested] == ["第二版", "第三版"]


def test_different_turns_are_independent():
    adapter, backend = unlocked_adapter()
    adapter.ingest_final_turn("甲", turn_id="t1", turn_revision=1)
    adapter.ingest_final_turn("乙", turn_id="t2", turn_revision=1)
    assert len(backend.ingested) == 2


def test_empty_text_and_bad_revision_are_rejected():
    adapter, backend = unlocked_adapter()
    with pytest.raises(ValueError):
        adapter.ingest_final_turn("   ", turn_id="t1", turn_revision=1)
    with pytest.raises(ValueError):
        adapter.ingest_final_turn("有效文本", turn_id="", turn_revision=1)
    with pytest.raises(ValueError):
        adapter.ingest_final_turn("有效文本", turn_id="t1", turn_revision=-1)
    assert backend.ingested == []


def test_failed_write_does_not_consume_the_revision():
    adapter, backend = unlocked_adapter()
    backend.fail_next_ingest = True
    with pytest.raises(RuntimeError):
        adapter.ingest_final_turn("重试这句", turn_id="t1", turn_revision=1)
    assert adapter.ingest_final_turn("重试这句", turn_id="t1", turn_revision=1) is True
    assert backend.ingested == [("重试这句", "user")]


# ── recall and delete ───────────────────────────────────────────────────────


def test_recall_returns_normalized_hits_and_uses_default_top_k():
    adapter, backend = unlocked_adapter(top_k=3)
    hits = adapter.recall("我对什么过敏")
    assert backend.queries == [("我对什么过敏", 3)]
    assert hits[0].text == "fact about 我对什么过敏"
    assert hits[0].memory_id == "m1"
    assert hits[0].channel == "leftbrain"


def test_recall_override_and_empty_query():
    adapter, backend = unlocked_adapter()
    adapter.recall("问题", top_k=7)
    assert backend.queries == [("问题", 7)]
    assert adapter.recall("   ") == ()
    assert len(backend.queries) == 1


def test_delete_all_clears_dedup_state():
    adapter, backend = unlocked_adapter()
    adapter.ingest_final_turn("一句", turn_id="t1", turn_revision=1)
    adapter.delete_all()
    assert backend.deleted == 1
    assert adapter.ingest_final_turn("一句", turn_id="t1", turn_revision=1) is True


# ── gate 7: cloud extraction needs explicit consent ────────────────────────


def test_memory_is_inert_without_cloud_consent():
    adapter = VoiceMemAdapter(
        memory_root="/tmp/voicemem-test-root",
        is_unlocked=lambda: True,
    )
    with pytest.raises(CloudExtractionNotConsentedError):
        adapter.recall("任何问题")


def test_memory_root_must_be_explicit():
    with pytest.raises(ValueError):
        VoiceMemAdapter(memory_root="")


# ── telemetry guard (mem0 defaults MEM0_TELEMETRY=true) ─────────────────────


def test_telemetry_guard_forces_false(monkeypatch):
    monkeypatch.delenv("MEM0_TELEMETRY", raising=False)
    _force_telemetry_off()
    import os

    assert os.environ["MEM0_TELEMETRY"] == "false"


def test_telemetry_guard_rejects_enabled(monkeypatch):
    monkeypatch.setenv("MEM0_TELEMETRY", "true")
    with pytest.raises(Exception):
        _force_telemetry_off()
