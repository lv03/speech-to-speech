"""Memory vector-store backend selection: layout, config and the install seam.

No mem0/sqlite-vec needed here: the seam is exercised with a stub module, which
is also what keeps the voice process free of those imports.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
# The sidecar venv does not install this package; it puts src/ on sys.path (the
# sidecar script does the same), so the test must too.
for extra in (REPO_ROOT / "src", REPO_ROOT / "experiments" / "voicemem"):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

from adapter import MemoryNotConfiguredError, _install_vector_store  # noqa: E402

from speech_to_speech.memory import MemoryConfig  # noqa: E402
from speech_to_speech.memory.config import (  # noqa: E402
    VECTOR_STORE_QDRANT,
    VECTOR_STORE_SQLITE_VEC,
    MemoryConfigError,
)
from speech_to_speech.memory.factory import build_memory_provider  # noqa: E402
from speech_to_speech.memory.vector_store_layout import (  # noqa: E402
    legacy_qdrant_present,
    migration_hint,
    needs_migration,
    qdrant_storage_path,
    sqlite_vec_path,
    vectors_dir,
)


def _legacy_layout(memory_root: Path) -> Path:
    storage = qdrant_storage_path(memory_root)
    storage.parent.mkdir(parents=True, exist_ok=True)
    storage.write_bytes(b"qdrant")
    return storage


# ── layout ───────────────────────────────────────────────────────────────────


def test_both_backends_live_under_voiceMem_vectors_dir(tmp_path):
    assert vectors_dir(tmp_path) == tmp_path / "vectors"
    assert sqlite_vec_path(tmp_path) == tmp_path / "vectors" / "voicemem.sqlite"
    assert qdrant_storage_path(tmp_path) == tmp_path / "vectors" / "collection" / "voicemem" / "storage.sqlite"


def test_collection_name_is_configurable(tmp_path):
    assert sqlite_vec_path(tmp_path, collection="other").name == "other.sqlite"


def test_legacy_qdrant_detected_by_collection_dir_or_meta_file(tmp_path):
    assert legacy_qdrant_present(tmp_path) is False

    _legacy_layout(tmp_path)
    assert legacy_qdrant_present(tmp_path) is True

    fresh = tmp_path / "meta-only"
    vectors_dir(fresh).mkdir(parents=True)
    (vectors_dir(fresh) / "meta.json").write_text("{}", encoding="utf-8")
    assert legacy_qdrant_present(fresh) is True


def test_needs_migration_only_when_legacy_exists_without_sqlite_file(tmp_path):
    assert needs_migration(tmp_path) is False  # fresh root

    _legacy_layout(tmp_path)
    assert needs_migration(tmp_path) is True

    sqlite_vec_path(tmp_path).write_bytes(b"sqlite")
    assert needs_migration(tmp_path) is False


def test_migration_hint_names_the_script_and_the_rollback(tmp_path):
    _legacy_layout(tmp_path)

    hint = migration_hint(tmp_path)

    assert "migrate_vectors.py" in hint
    assert "S2S_MEMORY_VECTOR_STORE=qdrant" in hint
    assert str(tmp_path) in hint


# ── config ───────────────────────────────────────────────────────────────────


def _config(tmp_path: Path, **overrides) -> MemoryConfig:
    values = {
        "backend": "voicemem",
        "sidecar_python": sys.executable,
        "sidecar_script": str(REPO_ROOT / "experiments" / "voicemem" / "sidecar.py"),
        "memory_root": str(tmp_path / "mem"),
        "extraction_base_url": "http://127.0.0.1:9/v1",
        "embedder_backend": "qmd",
        "embedder_base_url": "http://127.0.0.1:9",
    }
    values.update(overrides)
    return MemoryConfig(**values)


def test_vector_store_defaults_to_sqlite_vec(tmp_path):
    config = _config(tmp_path)

    config.validate()

    assert config.vector_store == VECTOR_STORE_SQLITE_VEC
    assert config.child_env()["S2S_MEMORY_VECTOR_STORE"] == VECTOR_STORE_SQLITE_VEC


def test_vector_store_qdrant_is_still_allowed(tmp_path):
    config = _config(tmp_path, vector_store=VECTOR_STORE_QDRANT)

    config.validate()

    assert config.child_env()["S2S_MEMORY_VECTOR_STORE"] == VECTOR_STORE_QDRANT


def test_unknown_vector_store_fails_closed(tmp_path):
    with pytest.raises(MemoryConfigError, match="vector_store must be one of"):
        _config(tmp_path, vector_store="chroma").validate()


def test_child_env_pins_vector_store_over_the_parent_environment(tmp_path, monkeypatch):
    """A stray value in the parent environment must not move the store."""
    monkeypatch.setenv("S2S_MEMORY_VECTOR_STORE", "chroma")

    env = _config(tmp_path, vector_store=VECTOR_STORE_QDRANT).child_env()

    assert env["S2S_MEMORY_VECTOR_STORE"] == VECTOR_STORE_QDRANT


def test_factory_reads_vector_store_from_env(tmp_path, monkeypatch):
    seen = {}

    class _Recorder:
        def __init__(self, config):
            seen["config"] = config

        def start(self):
            return True

    monkeypatch.setattr("speech_to_speech.memory.factory.MemoryProvider", _Recorder)
    monkeypatch.setenv("S2S_MEMORY_VECTOR_STORE", "qdrant")

    build_memory_provider(
        backend="voicemem",
        sidecar_python=sys.executable,
        sidecar_script=str(REPO_ROOT / "experiments" / "voicemem" / "sidecar.py"),
        memory_root=str(tmp_path / "mem"),
        extraction_base_url="http://127.0.0.1:9/v1",
    )

    assert seen["config"].vector_store == "qdrant"


# ── install seam ─────────────────────────────────────────────────────────────


def _stub_store_module(monkeypatch, calls: list[str]) -> None:
    module = types.ModuleType("speech_to_speech.memory.stores.sqlite_vec")
    module.install_vector_store = lambda provider: calls.append(provider)
    monkeypatch.setitem(sys.modules, "speech_to_speech.memory.stores.sqlite_vec", module)


def test_install_is_a_noop_for_qdrant(tmp_path, monkeypatch):
    calls: list[str] = []
    _stub_store_module(monkeypatch, calls)
    monkeypatch.setenv("S2S_MEMORY_VECTOR_STORE", "qdrant")

    _install_vector_store(tmp_path)

    assert calls == []


def test_install_defaults_to_sqlite_vec(tmp_path, monkeypatch):
    calls: list[str] = []
    _stub_store_module(monkeypatch, calls)
    monkeypatch.delenv("S2S_MEMORY_VECTOR_STORE", raising=False)

    _install_vector_store(tmp_path)

    assert calls == ["sqlite_vec"]


def test_install_rejects_unknown_provider(tmp_path, monkeypatch):
    monkeypatch.setenv("S2S_MEMORY_VECTOR_STORE", "chroma")

    with pytest.raises(MemoryNotConfiguredError, match="S2S_MEMORY_VECTOR_STORE must be"):
        _install_vector_store(tmp_path)


def test_install_refuses_to_start_empty_over_a_legacy_store(tmp_path, monkeypatch):
    """The migration gate: never look like memory was lost."""
    calls: list[str] = []
    _stub_store_module(monkeypatch, calls)
    _legacy_layout(tmp_path)
    monkeypatch.delenv("S2S_MEMORY_VECTOR_STORE", raising=False)

    with pytest.raises(MemoryNotConfiguredError, match="migrate_vectors.py"):
        _install_vector_store(tmp_path)

    assert calls == []
