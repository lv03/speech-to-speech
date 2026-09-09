#!/usr/bin/env python3
"""End-to-end store swap probe: run VoiceMem's real path on qdrant vs sqlite-vec.

``zh_smoke.py`` proves the adapter works; this probe proves the *storage engine*
can be swapped underneath it without touching VoiceMem's code, by rewriting the
one hardcoded value (``VectorStoreConfig(provider="qdrant")`` in
``voicemem.leftbrain.mem0_backend_store``) at import time.

    OPENAI_API_KEY=... OPENAI_BASE_URL=... OPENAI_MODEL=... \\
      "$VENV/bin/python" experiments/voicemem/store_swap_smoke.py --store sqlite_vec

Prints counts, ids, timings and booleans only -- never transcript text.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "src"))

os.environ.setdefault("MEM0_TELEMETRY", "false")

from adapter import VoiceMemAdapter  # noqa: E402
from mem0_sqlite_vec import register  # noqa: E402

FACTS = [
    ("我对坚果过敏，尤其是花生", "t1"),
    ("我每周三晚上要去健身房", "t2"),
    ("我住在台北，工作在内湖", "t3"),
]

QUERIES = [
    ("我对什么食物过敏", ("过敏", "花生", "坚果")),
    ("我什么时候去健身房", ("周三", "健身房", "晚上")),
    ("我住哪里", ("台北", "内湖")),
]


def patch_qdrant_to(provider: str) -> None:
    """Rewrite mem0's vector-store provider without editing mem0 or voicemem.

    VoiceMem hardcodes ``provider="qdrant"`` when it builds ``MemoryConfig``, so
    the only no-fork seam is mem0's pydantic config class. Wrapping its
    ``__init__`` also exercises the *validated* config path (see
    ``mem0_sqlite_vec.register``), unlike constructing a store directly.
    """
    from mem0.vector_stores.configs import VectorStoreConfig

    original_init = VectorStoreConfig.__init__

    def patched_init(self, **data):  # noqa: ANN001 - pydantic passes **data
        if data.get("provider") == "qdrant":
            data = dict(data)
            data["provider"] = provider
            data["config"] = dict(data.get("config") or {})
        original_init(self, **data)

    VectorStoreConfig.__init__ = patched_init


def describe_tree(root: Path) -> str:
    files = sorted(path for path in root.rglob("*") if path.is_file())
    total = sum(path.stat().st_size for path in files) // 1024
    names = ", ".join(f"{path.relative_to(root)}({path.stat().st_size // 1024}K)" for path in files)
    return f"{len(files)} files {total} KB: {names}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--memory-root", required=True)
    parser.add_argument("--store", choices=("qdrant", "sqlite_vec"), default="sqlite_vec")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        print("BLOCKED: OPENAI_API_KEY unset; voicemem has no local extraction path")
        return 2

    if args.store == "sqlite_vec":
        register()
        patch_qdrant_to("sqlite_vec")

    root = Path(args.memory_root)
    shutil.rmtree(root, ignore_errors=True)

    adapter = VoiceMemAdapter(
        memory_root=str(root),
        allow_cloud_extraction=True,
        is_unlocked=lambda: True,
        top_k=args.top_k,
    )

    from voicemem.leftbrain.mem0_backend_store import Mem0BackendStore  # noqa: F401

    print(f"store={args.store} root={root}")
    for text, turn_id in FACTS:
        start = time.monotonic()
        stored = adapter.ingest_final_turn(text, turn_id=turn_id, turn_revision=1)
        print(f"  ingest turn={turn_id} stored={stored} ms={int((time.monotonic() - start) * 1000)}")

    from voicemem.leftbrain import mem0_backend_store

    for memory in mem0_backend_store._MEM0_CLIENT_CACHE.values():
        store = memory.vector_store
        embedder = memory.embedding_model
        print(
            f"  vector_store={type(store).__module__}.{type(store).__name__} "
            f"embedder={type(embedder).__name__} "
            f"rows={getattr(store, 'col_info', lambda: {})()}"
        )

    failures = 0
    for query, expected in QUERIES:
        start = time.monotonic()
        hits = adapter.recall(query)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        joined = " ".join(hit.text for hit in hits)
        hit_at_1 = bool(hits) and any(word in hits[0].text for word in expected)
        hit_at_k = any(word in joined for word in expected)
        failures += 0 if hit_at_1 else 1
        print(f"  query={query!r} hits={len(hits)} top1_match={hit_at_1} topk_match={hit_at_k} ms={elapsed_ms}")

    print(f"  layout: {describe_tree(root)}")
    print(f"result: {'PASS' if failures == 0 else f'FAIL ({failures} top-1 misses)'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
