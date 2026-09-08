#!/usr/bin/env python3
"""Probe: does text-only speculative prefetch actually land before turn end?

Runs against the real voicemem in the dedicated venv (see `README.md`). It
ingests three Chinese facts once, then replays one Chinese question as a
sequence of partial transcriptions, the way our pipeline emits
`PartialTranscriptionEvent`, and measures:

- when speculation starts (first partial long enough),
- how long after that the memory block is already available,
- how much extra work the final transcription still costs at turn end.

Output is timings and booleans only — no transcript or memory text.

    set -a; . ~/.config/speech-to-speech/voicemem-smoke.env; set +a
    "$VENV/bin/python" experiments/voicemem/prefetch_probe.py --memory-root /tmp/voicemem-probe
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from adapter import VoiceMemAdapter  # noqa: E402

FACTS = [
    ("我对坚果过敏，尤其是花生", "t1"),
    ("我每周三晚上要去健身房", "t2"),
    ("我住在杭州，喜欢打羽毛球", "t3"),
]

# One question, delivered the way a streaming ASR would grow it.
PARTIALS = ["我对", "我对什么", "我对什么食物", "我对什么食物过敏"]
FINAL = "我对什么食物过敏？"


async def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--memory-root", required=True)
    parser.add_argument("--min-chars", type=int, default=6)
    parser.add_argument("--skip-ingest", action="store_true")
    args = parser.parse_args()

    adapter = VoiceMemAdapter(
        memory_root=args.memory_root,
        allow_cloud_extraction=True,
        is_unlocked=lambda: True,
    )

    if not args.skip_ingest:
        print(f"ingest: {len(FACTS)} facts")
        for text, turn_id in FACTS:
            start = time.monotonic()
            stored = adapter.ingest_final_turn(text, turn_id=turn_id, turn_revision=1)
            print(f"  {turn_id} stored={stored} ms={int((time.monotonic() - start) * 1000)}")

    stream = adapter.open_prefetch(min_chars=args.min_chars)
    started_at: float | None = None
    ready_at: float | None = None

    print("partials:")
    for text in PARTIALS:
        state = await stream.feed_partial("q1", 1, text)
        now = time.monotonic()
        if state.memory_context and started_at is None:
            started_at = now
            ready_at = now
        elif state.memory_context and started_at is not None and ready_at is None:
            ready_at = now
        print(
            f"  chars={len(text)} stale={state.stale} "
            f"context_chars={len(state.memory_context)}"
        )
        if state.memory_context and started_at is None:
            started_at = now

    turn_start = time.monotonic()
    final_state = await stream.feed_final("q1", 1, FINAL)
    final_ms = int((time.monotonic() - turn_start) * 1000)

    print("turn_over:")
    print(f"  context_chars={len(final_state.memory_context)}")
    print(f"  prefetch_ready={bool(final_state.memory_context)}")
    print(f"  final_ms={final_ms}")
    print(f"  result: {'PREFETCH_OK' if final_state.memory_context else 'NO_MEMORY'}")
    return 0 if final_state.memory_context else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
