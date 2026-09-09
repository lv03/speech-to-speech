#!/usr/bin/env python3
"""A/B probe: mem0 + local Qdrant vs mem0 + SQLite/sqlite-vec.

Same facts, same queries, same embedding model (the QMD daemon's Qwen3), same
mem0 version. Only the vector backend changes, so the numbers isolate the
storage-engine swap rather than confounding it with a different embedder.

    "$VENV/bin/python" experiments/voicemem/mem0_store_probe.py --embedder-url http://127.0.0.1:8130

Needs a running QMD daemon (patched ``POST /embed``). The probe fails loudly if
the endpoint is down instead of silently falling back to another model.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import time
from pathlib import Path
from statistics import median

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[1] / "src"))

# mem0 builds an OpenAI embedder + LLM client before we swap in the real
# embedder; dummy credentials keep that construction from raising. Neither is
# ever called (infer=False, no LLM path).
os.environ.setdefault("OPENAI_API_KEY", "probe-not-used")
os.environ.setdefault("MEM0_TELEMETRY", "false")

from speech_to_speech.memory.embedder import QmdEmbedder  # noqa: E402
from speech_to_speech.memory.stores.sqlite_vec import install_vector_store  # noqa: E402

FACTS: list[str] = [
    "用户对坚果过敏，尤其是花生和腰果。",
    "用户对乳制品不耐受，喝牛奶会不舒服。",
    "用户不吃辣，火锅只点清汤。",
    "用户每周三晚上去健身房做力量训练。",
    "用户周末喜欢打羽毛球，一般打两个小时。",
    "用户每天跑步五公里，早上六点出门。",
    "用户在杭州的一家互联网公司做后端开发。",
    "用户的团队最近在做推荐系统重构。",
    "用户住在杭州滨江区，通勤坐地铁。",
    "用户喜欢喝手冲咖啡，偏好浅烘焙。",
    "用户养了一只叫墨墨的猫。",
    "用户计划十月去日本旅行，主要去京都。",
]

QUERIES: list[tuple[str, str]] = [
    ("我对什么食物过敏？", "坚果"),
    ("我不能喝什么？", "乳制品"),
    ("我一般什么时候运动？", "周三"),
    ("我在哪家公司上班？", "互联网"),
    ("我住在哪里？", "滨江"),
    ("我的猫叫什么名字？", "墨墨"),
]


def build_memory(provider: str, directory: Path, embedder: QmdEmbedder):
    from mem0 import Memory
    from mem0.configs.base import MemoryConfig
    from mem0.embeddings.configs import EmbedderConfig
    from mem0.llms.configs import LlmConfig
    from mem0.vector_stores.configs import VectorStoreConfig

    directory.mkdir(parents=True, exist_ok=True)
    config = MemoryConfig(
        vector_store=VectorStoreConfig(
            provider=provider,
            config={
                "collection_name": "voicemem",
                "embedding_model_dims": embedder.dimensions,
                "path": str(directory),
                "on_disk": True,
            },
        ),
        embedder=EmbedderConfig(provider="openai", config={}),
        llm=LlmConfig(provider="openai", config={"model": "gpt-4o-mini"}),
        history_db_path=str(directory / "history.sqlite"),
    )
    memory = Memory(config)
    from voicemem.leftbrain.mem0_backend_store import _Mem0EmbedderAdapter

    memory.embedding_model = _Mem0EmbedderAdapter(embedder)
    return memory


def disk_usage(directory: Path) -> tuple[int, int]:
    files = [path for path in directory.rglob("*") if path.is_file()]
    return len(files), sum(path.stat().st_size for path in files) // 1024


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--embedder-url", default="http://127.0.0.1:8130")
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--keep", action="store_true")
    args = parser.parse_args()

    workdir = Path("/tmp/mem0-store-probe")
    shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True)

    embedder = QmdEmbedder(base_url=args.embedder_url)
    print(f"embedder: {embedder.model_name} dims={embedder.probe()}")

    directories = {"qdrant": workdir / "qdrant", "sqlite_vec": workdir / "sqlite"}
    # Order matters: install_vector_store redirects mem0's qdrant provider, so the
    # Qdrant arm must be constructed first or it would silently become sqlite-vec.
    stores = {"qdrant": build_memory("qdrant", directories["qdrant"], embedder)}
    install_vector_store("sqlite_vec")
    stores["sqlite_vec"] = build_memory("sqlite_vec", directories["sqlite_vec"], embedder)

    for label, memory in stores.items():
        start = time.monotonic()
        for text in FACTS:
            memory.add(
                messages=[{"role": "user", "content": text}],
                user_id="u",
                infer=False,
                metadata={"time_start": "2026-09-01"},
            )
        elapsed = int((time.monotonic() - start) * 1000)
        count = memory.get_all(filters={"user_id": "u"}, top_k=50)["results"]
        files, kb = disk_usage(directories[label])
        print(f"{label:<11} populate {elapsed:>6} ms | stored {len(count):>2} | {files} files {kb} KB")

    # Warm both embed caches (mem0 embeds the query before every store search, and
    # voicemem's cache is keyed per model -- without this the first store to run
    # pays the HTTP round trip and the comparison measures call order, not store).
    for memory in stores.values():
        for query, _ in QUERIES:
            memory.search(query, filters={"user_id": "u"}, top_k=args.top_k)

    print(f"\n{'query':<18} {'qdrant top1':<28} {'sqlite_vec top1':<28} {'q ms':>6} {'s ms':>6}")
    hits = {"qdrant": 0, "sqlite_vec": 0}
    for query, expected in QUERIES:
        row: dict[str, tuple[list[dict], int]] = {}
        for label, memory in stores.items():
            timings = []
            for _ in range(args.repeats):
                start = time.monotonic()
                found = memory.search(query, filters={"user_id": "u"}, top_k=args.top_k)["results"]
                timings.append((time.monotonic() - start) * 1000)
            row[label] = (found, round(median(timings), 1))
        top1 = {label: (str(found[0]["memory"]) if found else "<none>") for label, (found, _) in row.items()}
        for label in hits:
            hits[label] += 1 if expected in top1[label] else 0
        print(
            f"{query:<18} {top1['qdrant'][:26]:<28} {top1['sqlite_vec'][:26]:<28} "
            f"{row['qdrant'][1]:>6} {row['sqlite_vec'][1]:>6}"
        )

    print(f"\nTop-1 correct: qdrant {hits['qdrant']}/{len(QUERIES)}, sqlite_vec {hits['sqlite_vec']}/{len(QUERIES)}")

    # Cold-embedding cost for context: one never-seen query text per store.
    for label, memory in stores.items():
        start = time.monotonic()
        memory.search(f"未缓存的问题 {label}", filters={"user_id": "u"}, top_k=args.top_k)
        print(f"cold embed+search {label:<11} {round((time.monotonic() - start) * 1000, 1)} ms")

    if args.keep:
        print(f"\nkept: {workdir}")
    else:
        shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
