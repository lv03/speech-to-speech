"""End-to-end tests for the JSONL sidecar boundary.

They spawn `sidecar.py --backend fake`, so no voicemem install, model or network
is involved; the real backend is exercised by `zh_smoke.py` / `prefetch_probe.py`
in the dedicated venv.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

from client import SidecarClient, SidecarError  # noqa: E402


@pytest.fixture
def sidecar(tmp_path):
    client = SidecarClient(
        sys.executable,
        [str(HERE / "sidecar.py"), "--memory-root", str(tmp_path / "mem"), "--backend", "fake", "--debounce-s", "0.05"],
        timeout_ms=15_000,
    )
    yield client
    client.close()


def test_health_reports_locked_fake_backend(sidecar):
    health = sidecar.health()
    assert health["ok"] is True
    assert health["backend"] == "fake"
    assert health["unlocked"] is False
    assert health["pendingTurns"] == 0


def test_writes_and_reads_require_an_unlock(sidecar):
    with pytest.raises(SidecarError, match="MemoryLockedError"):
        sidecar.observe(session_id="s1", turns=[{"turn_id": "t1", "text": "我对花生过敏"}])
    with pytest.raises(SidecarError, match="MemoryLockedError"):
        sidecar.recall("我对什么过敏")

    assert sidecar.set_permission(unlocked=True)["unlocked"] is True
    assert sidecar.observe(session_id="s1", turns=[{"turn_id": "t1", "text": "我对花生过敏"}])["accepted"] == ["t1"]


def test_observe_batches_then_flush_writes_once(sidecar):
    sidecar.set_permission(unlocked=True)
    first = sidecar.observe(
        session_id="s1",
        turns=[
            {"turn_id": "t1", "revision": 1, "text": "我住在杭州"},
            {"turn_id": "t2", "revision": 1, "text": "我每周三健身"},
        ],
    )
    assert first["accepted"] == ["t1", "t2"]
    assert first["pendingTurns"] == 2
    assert sidecar.flush(session_id="s1")["batches"] == 1
    context = sidecar.recall("我住哪里")["context"]
    assert "我住在杭州" in context and "我每周三健身" in context


def test_duplicate_and_sensitive_turns_are_rejected_with_reasons(sidecar):
    sidecar.set_permission(unlocked=True)
    result = sidecar.observe(
        session_id="s1",
        turns=[
            {"turn_id": "t1", "revision": 1, "text": "正常的一句话"},
            {"turn_id": "t1", "revision": 1, "text": "正常的一句话"},
            {"turn_id": "t2", "revision": 1, "text": "我的密钥是 sk-abcdefgh"},
        ],
    )
    reasons = {item["turnId"]: item["reason"] for item in result["rejected"]}
    assert reasons["t1"] == "duplicate"
    assert reasons["t2"] == "sensitive"


def test_dedup_survives_a_sidecar_restart(tmp_path):
    args = [
        str(HERE / "sidecar.py"),
        "--memory-root",
        str(tmp_path / "mem"),
        "--backend",
        "fake",
        "--debounce-s",
        "0.05",
    ]
    first = SidecarClient(sys.executable, args, timeout_ms=15_000)
    try:
        first.set_permission(unlocked=True)
        first.observe(session_id="s1", turns=[{"turn_id": "t1", "revision": 1, "text": "我住在杭州"}])
        first.flush(session_id="s1")
    finally:
        first.close()

    second = SidecarClient(sys.executable, args, timeout_ms=15_000)
    try:
        second.set_permission(unlocked=True)
        result = second.observe(session_id="s1", turns=[{"turn_id": "t1", "revision": 1, "text": "我住在杭州"}])
        assert result["accepted"] == []
        assert result["rejected"][0]["reason"] == "duplicate"
    finally:
        second.close()


def test_unknown_method_returns_a_typed_error(sidecar):
    with pytest.raises(SidecarError, match="unsupported method"):
        sidecar.request("nope")


def test_lock_after_unlock_blocks_reads_again(sidecar):
    sidecar.set_permission(unlocked=True)
    sidecar.observe(session_id="s1", turns=[{"turn_id": "t1", "text": "我住在杭州"}])
    sidecar.flush(session_id="s1")
    sidecar.set_permission(unlocked=False)
    with pytest.raises(SidecarError, match="MemoryLockedError"):
        sidecar.recall("我住哪里")


def test_child_exit_surfaces_a_clear_error(tmp_path):
    client = SidecarClient(
        sys.executable,
        [str(HERE / "sidecar.py"), "--memory-root", str(tmp_path / "mem"), "--backend", "fake"],
        timeout_ms=15_000,
    )
    client.start()
    assert client.running is True
    client._child.kill()  # simulate a crash
    client._child.wait()
    with pytest.raises(SidecarError, match="sidecar exited"):
        client.request("health")


def test_timeout_is_reported_without_killing_the_process(tmp_path):
    client = SidecarClient(
        sys.executable,
        [str(HERE / "sidecar.py"), "--memory-root", str(tmp_path / "mem"), "--backend", "fake"],
        timeout_ms=1,
    )
    try:
        with pytest.raises(SidecarError):
            client.request("health", timeout_ms=1)
        # A short timeout must not wedge the child: a normal request still works.
        assert client.request("health", timeout_ms=15_000)["backend"] == "fake"
    finally:
        client.close()
