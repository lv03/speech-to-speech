"""Shared pytest fixtures for the speech-to-speech test suite."""

from __future__ import annotations

import sys
from types import ModuleType

import pytest


@pytest.fixture
def stub_huggingface_hub(monkeypatch):
    """Patch ``huggingface_hub`` while keeping its submodules importable.

    Several handlers resolve cached Hub files lazily through
    ``huggingface_hub`` submodules, so tests that replace ``sys.modules`` with a
    bare ``SimpleNamespace`` break those imports. This fixture hands back a copy
    of the real module so tests can add just the attributes they fake.
    """
    import huggingface_hub

    fake = ModuleType("huggingface_hub")
    fake.__dict__.update(huggingface_hub.__dict__)
    monkeypatch.setitem(sys.modules, "huggingface_hub", fake)
    return fake
