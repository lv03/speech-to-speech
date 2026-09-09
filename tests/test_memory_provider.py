"""Tests for the optional memory provider (sidecar boundary, fail-closed paths).

The sidecar is spawned with ``--backend fake`` from the experiment directory, so
these tests need no voicemem install, model or network.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from speech_to_speech.memory import MemoryConfig, MemoryProvider
from speech_to_speech.memory.config import MemoryConfigError

REPO_ROOT = Path(__file__).resolve().parents[1]
SIDECAR = REPO_ROOT / "experiments" / "voicemem" / "sidecar.py"


def _config(tmp_path: Path, **overrides) -> MemoryConfig:
    values = {
        "backend": "voicemem",
        "sidecar_python": sys.executable,
        "sidecar_script": str(SIDECAR),
        "memory_root": str(tmp_path / "mem"),
        "sidecar_backend": "fake",
        "interactive_timeout_ms": 15_000,
        "background_timeout_ms": 30_000,
    }
    values.update(overrides)
    return MemoryConfig(**values)


@pytest.fixture
def provider(tmp_path):
    instance = MemoryProvider(_config(tmp_path))
    yield instance
    instance.close()


def test_disabled_provider_does_nothing(tmp_path):
    instance = MemoryProvider(MemoryConfig())
    assert instance.enabled is False
    assert instance.start() is False
    assert instance.prefetch_final(session_id="s", turn_id="t", revision=1, text="我住哪里") == ""
    assert instance.build_injection("有记忆").inject is False
    assert instance.observe(session_id="s", turns=[{"turn_id": "t", "text": "x"}])["accepted"] == []
    assert instance.health()["backend"] == "off"
    instance.close()


def test_enabled_without_paths_is_rejected():
    with pytest.raises(MemoryConfigError):
        MemoryProvider(MemoryConfig(backend="voicemem"))


def test_start_locks_the_sidecar_and_reports_health(provider):
    assert provider.start() is True
    assert provider.unlocked is False
    assert provider.health()["ok"] is True


def test_locked_provider_never_prefetches_or_writes(provider):
    provider.start()
    assert provider.prefetch_final(session_id="s", turn_id="t", revision=1, text="我住哪里") == ""
    assert provider.observe(session_id="s", turns=[{"turn_id": "t", "text": "我住在杭州"}])["accepted"] == []


def test_unlocked_provider_observes_then_prefetches(provider):
    provider.start()
    provider.set_unlocked(True)
    accepted = provider.observe(session_id="s1", turns=[{"turn_id": "t1", "revision": 1, "text": "我住在杭州"}])
    assert accepted["accepted"] == ["t1"]
    assert provider.flush(session_id="s1") == 1
    context = provider.prefetch_final(session_id="s1", turn_id="t2", revision=1, text="我住哪里")
    assert "我住在杭州" in context


def test_injection_requires_unlock_and_content(provider):
    provider.start()
    provider.set_unlocked(True)
    decision = provider.build_injection("用户住在杭州")
    assert decision.inject is True
    assert decision.message is not None and decision.message["role"] == "system"

    assert provider.build_injection("").reason == "empty"
    provider.set_unlocked(False)
    assert provider.build_injection("用户住在杭州").reason == "locked"


def test_partial_before_final_returns_no_context(provider):
    provider.start()
    provider.set_unlocked(True)
    provider.observe(session_id="s1", turns=[{"turn_id": "t1", "text": "我对花生过敏"}])
    provider.flush(session_id="s1")
    assert provider.prefetch_partial(session_id="s1", turn_id="t2", revision=1, text="我对") == ""


def test_sidecar_crash_is_self_healing_but_stays_locked(provider):
    provider.start()
    provider.set_unlocked(True)
    client = provider._client  # noqa: SLF001 - test needs the process handle
    assert client is not None
    client._child.kill()  # noqa: SLF001
    client._child.wait()

    # The next call respawns the sidecar, which comes back locked, so the read
    # fails closed and the provider reports the outage.
    assert provider.prefetch_final(session_id="s", turn_id="t", revision=1, text="我住哪里") == ""
    assert provider.degraded_reason
    assert provider.health()["unlocked"] is False

    # Re-unlocking restores the read path.
    provider.set_unlocked(True)
    provider.observe(session_id="s1", turns=[{"turn_id": "t1", "text": "我住在杭州"}])
    provider.flush(session_id="s1")
    assert "我住在杭州" in provider.prefetch_final(session_id="s1", turn_id="t2", revision=1, text="我住哪里")
