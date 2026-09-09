#!/usr/bin/env python3
"""A/B probe: QMD-backed memory store vs the current mem0 + Qdrant store.

Same facts, same queries, same embedding model (the QMD daemon's Qwen3). Only
the storage and retrieval path differ, so the numbers isolate that change.

    # needs the patched QMD daemon (see desktop/patches/qmd-embed-route.patch)
    "$VENV/bin/python" experiments/voicemem/qmd_store_probe.py --daemon http://127.0.0.1:8126

The probe starts the daemon itself unless --daemon is given.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from qmd_store import QmdMemoryStore  # noqa: E402

from speech_to_speech.memory.embedder import QmdEmbedder  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
QMD_BIN = REPO / "desktop" / "node_modules" / "@tobilu" / "qmd" / "bin" / "qmd"
COLLECTION = "memfacts"

# 12 facts across four themes plus deliberate near-misses.
FACTS: list[tuple[str, str]] = [
    ("m01", "用户对坚果过敏，尤其是花生和腰果。"),
    ("m02", "用户对乳制品不耐受，喝牛奶会不舒服。"),
    ("m03", "用户不吃辣，火锅只点清汤。"),
    ("m04", "用户每周三晚上去健身房做力量训练。"),
    ("m05", "用户周末喜欢打羽毛球，一般打两个小时。"),
    ("m06", "用户每天跑步五公里，早上六点出门。"),
    ("m07", "用户在杭州的一家互联网公司做后端开发。"),
    ("m08", "用户的团队最近在做推荐系统重构。"),
    ("m09", "用户住在杭州滨江区，通勤坐地铁。"),
    ("m10", "用户喜欢喝手冲咖啡，偏好浅烘焙。"),
    ("m11", "用户养了一只叫墨墨的猫。"),
    ("m12", "用户计划十月去日本旅行，主要去京都。"),
]

QUERIES: list[tuple[str, str]] = [
    ("我对什么食物过敏？", "坚果"),
    ("我不能喝什么？", "乳制品"),
    ("我一般什么时候运动？", "每周三"),
    ("我在哪家公司上班？", "互联网"),
    ("我住在哪里？", "滨江"),
    ("我的猫叫什么名字？", "墨墨"),
]


def start_daemon(workdir: Path, port: int) -> subprocess.Popen:
    env = {
        **os.environ,
        "HOME": str(workdir / "home"),
        "XDG_CONFIG_HOME": str(workdir / "config"),
        "QMD_CONFIG_DIR": str(workdir / "config/qmd"),
        "XDG_CACHE_HOME": str(workdir / "cache"),
        "INDEX_PATH": str(workdir / "cache/qmd/index.sqlite"),
        "QMD_INDEX_PATH": str(workdir / "cache/qmd/index.sqlite"),
        "QMD_EMBED_MODEL": str(Path.home() / ".cache/qmd/models/hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf"),
        "QMD_RERANK_MODEL": str(Path.home() / ".cache/qmd/models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf"),
        "QMD_GENERATE_MODEL": str(Path.home() / ".cache/qmd/models/hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf"),
    }
    for key in ("home", "config/qmd", "cache/qmd"):
        (workdir / key).mkdir(parents=True, exist_ok=True)
    log = open(workdir / "daemon.log", "w")  # noqa: SIM115 - lives for the probe
    process = subprocess.Popen(
        ["node", str(QMD_BIN), "mcp", "--http", "--host", "127.0.0.1", "--port", str(port)],
        stdout=log,
        stderr=log,
        env=env,
    )
    import httpx

    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"http://127.0.0.1:{port}/health", timeout=1).status_code == 200:
                return process
        except Exception:  # noqa: BLE001
            time.sleep(0.5)
    process.kill()
    raise SystemExit("QMD daemon did not become healthy")


def index_env(workdir: Path) -> dict[str, str]:
    return {
        "HOME": str(workdir / "home"),
        "XDG_CONFIG_HOME": str(workdir / "config"),
        "QMD_CONFIG_DIR": str(workdir / "config/qmd"),
        "XDG_CACHE_HOME": str(workdir / "cache"),
        "INDEX_PATH": str(workdir / "cache/qmd/index.sqlite"),
        "QMD_INDEX_PATH": str(workdir / "cache/qmd/index.sqlite"),
        "QMD_EMBED_MODEL": str(Path.home() / ".cache/qmd/models/hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf"),
        "QMD_RERANK_MODEL": str(Path.home() / ".cache/qmd/models/hf_ggml-org_qwen3-reranker-0.6b-q8_0.gguf"),
        "QMD_GENERATE_MODEL": str(Path.home() / ".cache/qmd/models/hf_tobil_qmd-query-expansion-1.7B-q4_k_m.gguf"),
    }


def run_qmd(args: list[str], env: dict[str, str]) -> str:
    result = subprocess.run(["node", str(QMD_BIN), *args], capture_output=True, text=True, env={**os.environ, **env})
    if result.returncode != 0:
        raise SystemExit(f"qmd {' '.join(args)} failed: {(result.stderr or result.stdout)[:300]}")
    return result.stdout


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--daemon", default="", help="use an already-running daemon (skip starting one)")
    parser.add_argument("--port", type=int, default=8126)
    parser.add_argument("--top-k", type=int, default=5)
    parser.add_argument("--mode", choices=("vec-only", "hybrid"), default="hybrid")
    parser.add_argument("--keep", action="store_true", help="keep the temp workspace")
    args = parser.parse_args()

    workdir = Path("/tmp/qmd-store-probe")
    shutil.rmtree(workdir, ignore_errors=True)
    workdir.mkdir(parents=True)
    daemon = args.daemon
    process = None
    if not daemon:
        process = start_daemon(workdir, args.port)
        daemon = f"http://127.0.0.1:{args.port}"

    env = index_env(workdir)
    facts_dir = workdir / "facts"
    facts_dir.mkdir(parents=True)
    run_qmd(["collection", "add", str(facts_dir), "--name", COLLECTION], env)

    store = QmdMemoryStore(
        root=facts_dir,
        collection=COLLECTION,
        query_base_url=daemon,
        qmd_command=["node", str(QMD_BIN)],
        index_env=env,
        mode=args.mode,
    )
    store.add_records_with_ids("u", [(mid, text, "user", {"time_start": "2026-09-01"}) for mid, text in FACTS])

    # Reference store: voicemem's current mem0 + local Qdrant, same embedder.
    sys.path.insert(0, str(Path.home() / ".cache/speech-to-speech/voicemem-venv/lib/python3.11/site-packages"))
    from voicemem.leftbrain.mem0_backend_store import Mem0BackendStore

    qdrant_root = workdir / "qdrant"
    qdrant_root.mkdir(parents=True)
    embedder = QmdEmbedder(base_url=daemon)
    mem0_store = Mem0BackendStore(embedder, memory_root=qdrant_root)
    mem0_store.add_records_with_ids("u", [(mid, text, "user", {"time_start": "2026-09-01"}) for mid, text in FACTS])

    print(f"facts: {len(FACTS)} | queries: {len(QUERIES)} | mode={args.mode} | daemon={daemon}")
    print(f"{'query':<18} {'qdrant top1':<26} {'qmd top1':<26} {'qdrant ms':>9} {'qmd ms':>7}")
    qdrant_hits = qmd_hits = 0
    for query, expected in QUERIES:
        start = time.monotonic()
        reference = mem0_store.search(query, user_id="u", top_k=args.top_k)
        qdrant_ms = int((time.monotonic() - start) * 1000)
        start = time.monotonic()
        candidate = store.search(query, user_id="u", top_k=args.top_k)
        qmd_ms = int((time.monotonic() - start) * 1000)

        ref_top1 = reference[0].text if reference else ""
        cand_top1 = candidate[0].text if candidate else ""
        qdrant_ok = bool(reference) and expected in ref_top1
        qmd_ok = bool(candidate) and expected in cand_top1
        qdrant_hits += qdrant_ok
        qmd_hits += qmd_ok
        print(
            f"{query:<18} {ref_top1[:24]:<26} {cand_top1[:24]:<26} {qdrant_ms:>9} {qmd_ms:>7}"
            + ("" if qdrant_ok == qmd_ok else ("  ← qdrant" if qdrant_ok else "  ← qmd"))
        )

    print(f"\nTop-1 correct: qdrant {qdrant_hits}/{len(QUERIES)}, qmd {qmd_hits}/{len(QUERIES)}")
    print(f"memory dir: qdrant {sum(1 for _ in qdrant_root.rglob('*') if _.is_file())} files, "
          f"qmd {sum(1 for _ in facts_dir.rglob('*.md'))} markdown files")
    store.close()
    if process is not None:
        process.kill()
    if not args.keep:
        shutil.rmtree(workdir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
