#!/usr/bin/env python3
"""Gate 5 smoke: Chinese ingest/search through the adapter.

Requires the two things this experiment deliberately does not install:

1. voicemem in a dedicated venv (see ``README.md``); run this script with that
   interpreter.
2. An OpenAI-compatible chat endpoint for fact extraction
   (``OPENAI_API_KEY``, optional ``OPENAI_BASE_URL`` / ``OPENAI_MODEL``).
   voicemem 0.2.3 has no local extraction path, so without a key this fails
   closed by design.

    OPENAI_API_KEY=... OPENAI_BASE_URL=https://api.deepseek.com \\
      OPENAI_MODEL=deepseek-v4-flash \\
      /path/to/voicemem-venv/bin/python experiments/voicemem/zh_smoke.py \\
        --memory-root /tmp/voicemem-smoke

It prints only counts, ids, timings and a boolean per assertion — never the
transcript text, so its output is safe to paste into a report.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from adapter import VoiceMemAdapter  # noqa: E402

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


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--memory-root", required=True, help="app-private memory directory")
    parser.add_argument("--top-k", type=int, default=5)
    args = parser.parse_args()

    if not os.environ.get("OPENAI_API_KEY"):
        print("BLOCKED: OPENAI_API_KEY is unset; voicemem 0.2.3 cannot extract facts locally")
        return 2

    adapter = VoiceMemAdapter(
        memory_root=args.memory_root,
        allow_cloud_extraction=True,
        is_unlocked=lambda: True,
        top_k=args.top_k,
    )

    print(f"ingest: {len(FACTS)} Chinese facts")
    for text, turn_id in FACTS:
        start = time.monotonic()
        stored = adapter.ingest_final_turn(text, turn_id=turn_id, turn_revision=1)
        print(f"  turn={turn_id} stored={stored} ms={int((time.monotonic() - start) * 1000)}")

    failures = 0
    for query, expected in QUERIES:
        start = time.monotonic()
        hits = adapter.recall(query)
        elapsed_ms = int((time.monotonic() - start) * 1000)
        joined = " ".join(hit.text for hit in hits)
        hit_at_1 = bool(hits) and any(word in hits[0].text for word in expected)
        hit_at_k = any(word in joined for word in expected)
        failures += 0 if hit_at_1 else 1
        print(
            f"query={query!r} hits={len(hits)} top1_match={hit_at_1} "
            f"topk_match={hit_at_k} ms={elapsed_ms}"
        )

    print(f"result: {'PASS' if failures == 0 else f'FAIL ({failures} top-1 misses)'}")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
