"""On-disk layout of the memory vector store, per backend.

Kept dependency-free (no mem0, no sqlite-vec) so the voice process, the adapter
and the tests can reason about the layout without the sidecar venv.

Both backends live under ``<memory_root>/vectors`` because that is the path
VoiceMem computes (``voicemem.utils.common.space.vectors``); only the contents
differ:

- Qdrant (local mode): ``vectors/meta.json`` + ``vectors/collection/<name>/storage.sqlite``
- SQLite/sqlite-vec:   ``vectors/<collection>.sqlite``

Switching backends is therefore a migration, not a rename: the two layouts share
no file. ``needs_migration`` is what keeps a switch from silently starting with an
empty memory.
"""

from __future__ import annotations

from pathlib import Path

#: mem0 collection name VoiceMem hardcodes (see voicemem.leftbrain.mem0_backend_store).
DEFAULT_COLLECTION = "voicemem"

#: Qdrant local mode writes these next to its collection directory.
QDRANT_META_FILE = "meta.json"
QDRANT_COLLECTION_DIR = "collection"


def vectors_dir(memory_root: str | Path) -> Path:
    """The directory VoiceMem hands mem0 as ``path``."""
    return Path(memory_root).expanduser() / "vectors"


def sqlite_vec_path(memory_root: str | Path, *, collection: str = DEFAULT_COLLECTION) -> Path:
    """The SQLite file the sqlite-vec backend reads and writes."""
    return vectors_dir(memory_root) / f"{collection}.sqlite"


def qdrant_storage_path(memory_root: str | Path, *, collection: str = DEFAULT_COLLECTION) -> Path:
    """The Qdrant local-mode storage file for ``collection``."""
    return vectors_dir(memory_root) / QDRANT_COLLECTION_DIR / collection / "storage.sqlite"


def legacy_qdrant_present(memory_root: str | Path, *, collection: str = DEFAULT_COLLECTION) -> bool:
    """True when a Qdrant-backed store exists for this memory root."""
    root = vectors_dir(memory_root)
    if qdrant_storage_path(memory_root, collection=collection).is_file():
        return True
    # A meta.json without a collection dir is still Qdrant's (empty) store.
    return (root / QDRANT_META_FILE).is_file()


def needs_migration(memory_root: str | Path, *, collection: str = DEFAULT_COLLECTION) -> bool:
    """True when switching to sqlite-vec would start from an empty store.

    Only meaningful for the sqlite-vec backend: legacy data exists and the SQLite
    file has not been created yet.
    """
    if sqlite_vec_path(memory_root, collection=collection).exists():
        return False
    return legacy_qdrant_present(memory_root, collection=collection)


def migration_hint(memory_root: str | Path, *, collection: str = DEFAULT_COLLECTION) -> str:
    """Operator-facing message for the fail-closed path in the adapter."""
    return (
        f"memory at {Path(memory_root)} still uses mem0's Qdrant store "
        f"({qdrant_storage_path(memory_root, collection=collection)}), and no "
        f"{sqlite_vec_path(memory_root, collection=collection).name} exists yet. "
        "Migrate it first:\n"
        f"  <sidecar python> experiments/voicemem/migrate_vectors.py --memory-root {Path(memory_root)}\n"
        "or keep the old backend with S2S_MEMORY_VECTOR_STORE=qdrant."
    )


__all__ = [
    "DEFAULT_COLLECTION",
    "QDRANT_COLLECTION_DIR",
    "QDRANT_META_FILE",
    "legacy_qdrant_present",
    "migration_hint",
    "needs_migration",
    "qdrant_storage_path",
    "sqlite_vec_path",
    "vectors_dir",
]
