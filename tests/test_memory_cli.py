"""CLI plumbing for the optional memory backend."""

from __future__ import annotations

import argparse

import pytest

from speech_to_speech import cli


def _namespace(**overrides):
    values = {
        "memory_backend": "off",
        "memory_sidecar_python": None,
        "memory_sidecar_script": None,
        "memory_root": None,
        "memory_max_chars": 1200,
    }
    values.update(overrides)
    return argparse.Namespace(**values)


def test_memory_is_off_by_default():
    assert cli._build_memory_provider(_namespace()) is None


def test_enabling_without_paths_fails_closed():
    with pytest.raises(Exception):
        cli._build_memory_provider(_namespace(memory_backend="voicemem"))


def test_enabled_provider_starts_and_unlocks_when_requested(monkeypatch):
    calls: list[str] = []

    class FakeProvider:
        degraded_reason = ""

        def __init__(self, config):
            calls.append(f"init:{config.backend}")

        def start(self):
            calls.append("start")
            return True

        def set_unlocked(self, unlocked):
            calls.append(f"unlocked:{unlocked}")

    monkeypatch.setattr("speech_to_speech.memory.factory.MemoryProvider", FakeProvider)
    provider = cli._build_memory_provider(
        _namespace(
            memory_backend="voicemem",
            memory_sidecar_python="/usr/bin/python3",
            memory_sidecar_script=__file__,
            memory_root="/tmp/memory",
        ),
        unlocked=True,
    )
    assert isinstance(provider, FakeProvider)
    assert calls == ["init:voicemem", "start", "unlocked:True"]


def test_failed_start_leaves_the_provider_locked(monkeypatch):
    calls: list[str] = []

    class FakeProvider:
        degraded_reason = "boom"

        def __init__(self, config):
            del config

        def start(self):
            return False

        def set_unlocked(self, unlocked):
            calls.append(f"unlocked:{unlocked}")

    monkeypatch.setattr("speech_to_speech.memory.factory.MemoryProvider", FakeProvider)
    provider = cli._build_memory_provider(
        _namespace(
            memory_backend="voicemem",
            memory_sidecar_python="/usr/bin/python3",
            memory_sidecar_script=__file__,
            memory_root="/tmp/memory",
        ),
        unlocked=True,
    )
    assert provider is not None
    assert calls == []
