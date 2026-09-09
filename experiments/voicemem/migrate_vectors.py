#!/usr/bin/env python3
"""One-time migration: mem0's local Qdrant store → SQLite/sqlite-vec.

Both backends store the *same* vectors (same embedder, same dimensions), so the
migration copies rows — it never re-embeds and never calls the extraction
endpoint. Run it with the sidecar venv (it needs mem0 and qdrant-client to read
the old store):

    VENV="$HOME/.cache/speech-to-speech/voicemem-venv"
    "$VENV/bin/python" experiments/voicemem/migrate_vectors.py --memory-root <dir>

Nothing is deleted. After verifying the printed counts (and a recall query), the
old layout can be removed by hand:

    rm -rf <memory-root>/vectors/collection <memory-root>/vectors/meta.json

Exit codes: 0 = migrated or already migrated, 2 = nothing to do / refused.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
_SRC = HERE.parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from speech_to_speech.memory.stores.sqlite_vec import SqliteVecStore  # noqa: E402
from speech_to_speech.memory.vector_store_layout import (  # noqa: E402
    DEFAULT_COLLECTION,
    legacy_qdrant_present,
    qdrant_storage_path,
    sqlite_vec_path,
    vectors_dir,
)


def _dims_from_space_json(memory_root: Path) -> int | None:
    """VoiceMem records the embedding dimensions in ``<space>.json``."""
    for path in sorted(memory_root.glob("*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - a broken description file is not fatal
            continue
        dims = ((doc or {}).get("mem0") or {}).get("dims")
        if dims:
            return int(dims)
    return None


def _iter_qdrant_points(client, collection: str, batch: int):
    offset = None
    while True:
        points, offset = client.scroll(
            collection_name=collection,
            limit=batch,
            offset=offset,
            with_payload=True,
            with_vectors=True,
        )
        for point in points:
            yield point
        if offset is None:
            return


def _flat_vector(vector) -> list[float]:
    if isinstance(vector, dict):  # named vectors: {"": [...]} (+ optional bm25)
        vector = vector.get("") or next(iter(vector.values()))
    return [float(value) for value in vector]


def migrate(*, memory_root: Path, collection: str, batch: int, dry_run: bool) -> int:
    source = qdrant_storage_path(memory_root, collection=collection)
    target = sqlite_vec_path(memory_root, collection=collection)

    if not legacy_qdrant_present(memory_root, collection=collection):
        print(f"nothing to migrate: no Qdrant store at {source}")
        return 2
    if target.exists():
        print(f"refusing to overwrite {target}; delete it first if the migration must be re-run")
        return 2

    # mem0's Qdrant store class builds its client from the same path VoiceMem
    # passes, so opening it here sees exactly what the sidecar saw.
    from mem0.vector_stores.qdrant import Qdrant

    dims = _dims_from_space_json(memory_root)
    store = Qdrant(
        collection_name=collection,
        embedding_model_dims=dims or 1024,
        path=str(vectors_dir(memory_root)),
    )
    count = store.client.count(collection_name=collection, exact=True).count
    print(f"source {source}: {count} points (dims={dims or 'inferred'})")
    if dry_run:
        print(f"dry run: would write {count} points into {target}")
        return 0

    if dims is None:
        first = next(iter(_iter_qdrant_points(store.client, collection, batch)), None)
        dims = len(_flat_vector(first.vector)) if first is not None else 1024
    target_store = SqliteVecStore(
        collection_name=collection,
        path=str(vectors_dir(memory_root)),
        embedding_model_dims=int(dims),
    )

    written = 0
    for point in _iter_qdrant_points(store.client, collection, batch):
        target_store.insert(
            vectors=[_flat_vector(point.vector)],
            payloads=[dict(point.payload or {})],
            ids=[str(point.id)],
        )
        written += 1
        if written % 200 == 0:
            print(f"  migrated {written}/{count}")

    stored = target_store.col_info()["count"]
    print(f"target {target}: {stored} rows ({target.stat().st_size // 1024} KB), dims={dims}")
    if stored != count:
        print(f"MISMATCH: source {count} vs target {stored}", file=sys.stderr)
        return 1
    print("migration complete; the old layout is untouched:")
    print(f"  rm -rf {vectors_dir(memory_root) / 'collection'} {vectors_dir(memory_root) / 'meta.json'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--memory-root", required=True, type=Path)
    parser.add_argument("--collection", default=DEFAULT_COLLECTION)
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = args.memory_root.expanduser()
    if not root.is_dir():
        print(f"memory root not found: {root}", file=sys.stderr)
        return 2
    return migrate(memory_root=root, collection=args.collection, batch=args.batch, dry_run=args.dry_run)


if __name__ == "__main__":
    raise SystemExit(main())
