#!/usr/bin/env python3
"""JSONL process boundary around the voicemem adapter.

The product must never import voicemem into the voice process: it drags torch,
transformers, funasr and mem0 with it, and mem0's local Qdrant store allows one
process per memory root. This sidecar owns the adapter; the parent talks to it
over stdin/stdout, one JSON object per line, and never shares memory state.

Protocol::

    {"id": "<opaque>", "method": "recall", "params": {...}}
    {"id": "<opaque>", "result": {...}}
    {"id": "<opaque>", "error": {"type": "MemoryLockedError", "detail": "..."}}

Methods: ``health``, ``set_permission``, ``recall``, ``observe``, ``prefetch_partial``,
``prefetch_final``, ``flush``, ``close``. The session starts **locked**; only an
explicit ``set_permission {"unlocked": true}`` from the parent opens reads and
writes.

Run it with the dedicated voicemem venv (``--backend real``), or with any
Python and ``--backend fake`` for tests::

    "$VENV/bin/python" experiments/voicemem/sidecar.py --memory-root /tmp/vm --backend real
    python experiments/voicemem/sidecar.py --memory-root /tmp/vm --backend fake
"""

from __future__ import annotations

import argparse
import asyncio
import inspect
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

from adapter import (  # noqa: E402
    MemoryHit,
    MemoryLockedError,
    VoiceMemAdapter,
)
from injection import DEFAULT_MAX_CHARS  # noqa: E402
from session import SessionWriter  # noqa: E402

PROTOCOL_VERSION = 1

_METHODS = {
    "health",
    "set_permission",
    "recall",
    "observe",
    "prefetch_partial",
    "prefetch_final",
    "flush",
    "close",
}


class _RawStreamAdapter:
    """Wraps a backend whose stream takes plain text (no turn identity)."""

    def __init__(self, stream) -> None:
        self._stream = stream

    async def feed_partial(self, turn_id: str, revision: int, text: str):
        del turn_id, revision
        return await self._stream.feed_partial(text)

    async def feed_final(self, turn_id: str, revision: int, text: str):
        del turn_id, revision
        return await self._stream.feed_text(text)


class FakePrefetchStream:
    """Async text stream over the fake store, mirroring voicemem's shape."""

    def __init__(self, memory: "FakeMemory") -> None:
        self._memory = memory

    async def feed_partial(self, text: str, ended: bool = False):
        # Like the real backend: speculation is asynchronous, so a partial tick
        # returns no context yet; the block arrives on the final tick.
        del text, ended
        return _FakeState(False, "")

    async def feed_text(self, text: str):
        del text
        return _FakeState(True, self._memory.context())


class _FakeState:
    def __init__(self, turn_over: bool, context: str) -> None:
        self.state = "turn_over" if turn_over else "listening"
        self.memory_context = context


class FakeMemory:
    """In-memory backend for tests: no voicemem, no network, no model."""

    def __init__(self) -> None:
        self.written: list[str] = []
        self.hits: list[str] = []

    def ingest_final_turn(self, text: str, *, turn_id: str, turn_revision: int) -> bool:
        self.written.append(text)
        self.hits = [line.lstrip("- ") for line in text.splitlines()]
        return True

    def context(self) -> str:
        return "\n".join(f"- {hit}" for hit in self.hits)

    def recall(self, query: str, *, top_k: int | None = None):
        del query, top_k
        return tuple(MemoryHit(text=hit, memory_id=f"m{index}") for index, hit in enumerate(self.hits))

    def delete_all(self) -> None:
        self.written.clear()
        self.hits.clear()

    def flush(self) -> None:
        return None

    def open_stream(self):
        return FakePrefetchStream(self)


class Sidecar:
    def __init__(
        self,
        *,
        memory_root: Path,
        backend: str,
        state_path: Path | None,
        debounce_s: float,
        max_context_chars: int = DEFAULT_MAX_CHARS,
    ) -> None:
        self._unlocked = False
        self._backend_name = backend
        self._max_context_chars = max_context_chars
        if backend == "fake":
            self._memory: Any = FakeMemory()
        else:
            self._memory = VoiceMemAdapter(
                memory_root=memory_root,
                allow_cloud_extraction=True,
                is_unlocked=lambda: self._unlocked,
            )
        self._writer = SessionWriter(
            self._memory,
            state_path=state_path,
            debounce_s=debounce_s,
            on_error=self._record_error,
        )
        self._last_error = ""
        self._streams: dict[str, Any] = {}
        self._loop = asyncio.new_event_loop()

    # ── methods ──────────────────────────────────────────────────────────────

    def health(self, _params: dict) -> dict:
        return {
            "ok": not self._last_error,
            "protocolVersion": PROTOCOL_VERSION,
            "backend": self._backend_name,
            "unlocked": self._unlocked,
            "pendingTurns": self._writer.pending(),
            "warning": self._last_error,
        }

    def set_permission(self, params: dict) -> dict:
        self._unlocked = bool(params.get("unlocked"))
        return {"unlocked": self._unlocked}

    def recall(self, params: dict) -> dict:
        self._require_unlocked()
        query = str(params.get("query", "")).strip()
        top_k = params.get("topK")
        hits = self._memory.recall(query, top_k=int(top_k) if top_k else None)
        context = "\n".join(f"- {hit.text}" for hit in hits)[: self._max_context_chars]
        return {"context": context, "hitCount": len(hits)}

    def observe(self, params: dict) -> dict:
        self._require_unlocked()
        session_id = str(params.get("sessionId", "")).strip() or "default"
        turns = params.get("turns") or []
        if not isinstance(turns, list):
            raise ValueError("turns must be a list")
        accepted: list[str] = []
        rejected: list[dict[str, str]] = []
        for turn in turns:
            if not isinstance(turn, dict):
                rejected.append({"turnId": "", "reason": "malformed"})
                continue
            turn_id = str(turn.get("turnId", ""))
            result = self._writer.submit_final_turn(
                str(turn.get("text", "")),
                turn_id=turn_id,
                turn_revision=int(turn.get("revision", 0) or 0),
                session_id=session_id,
            )
            if result.accepted:
                accepted.append(turn_id)
            else:
                rejected.append({"turnId": turn_id, "reason": result.reason})
        return {"accepted": accepted, "rejected": rejected, "pendingTurns": self._writer.pending(session_id)}

    def flush(self, params: dict) -> dict:
        self._require_unlocked()
        session_id = str(params.get("sessionId", "")).strip() or None
        return {"batches": self._writer.flush(session_id)}

    def prefetch_partial(self, params: dict) -> dict:
        return self._prefetch(params, final=False)

    def prefetch_final(self, params: dict) -> dict:
        return self._prefetch(params, final=True)

    def close(self, _params: dict) -> dict:
        self._writer.close()
        self._streams.clear()
        if not self._loop.is_closed():
            self._loop.close()
        return {"closed": True}

    # ── plumbing ─────────────────────────────────────────────────────────────

    def _prefetch(self, params: dict, *, final: bool) -> dict:
        """Drive one speculative retrieval tick; returns the memory block if ready."""
        self._require_unlocked()
        session_id = str(params.get("sessionId", "")).strip() or "default"
        stream = self._streams.get(session_id)
        if stream is None:
            stream = self._open_stream()
            self._streams[session_id] = stream
        turn_id = str(params.get("turnId", ""))
        revision = int(params.get("revision", 0) or 0)
        text = str(params.get("text", ""))
        if final:
            state = self._run(stream.feed_final(turn_id, revision, text))
        else:
            state = self._run(stream.feed_partial(turn_id, revision, text))
        context = str(getattr(state, "memory_context", "") or "")[: self._max_context_chars]
        return {"context": context, "stale": bool(getattr(state, "stale", False))}

    def _open_stream(self):
        """Return a turn-aware stream: the adapter's wrapper when available."""
        opener = getattr(self._memory, "open_prefetch", None)
        if opener is not None:
            return opener()
        opener = getattr(self._memory, "open_stream", None)
        if opener is None:
            raise ValueError("backend does not support prefetch")
        return _RawStreamAdapter(opener())

    def _run(self, awaitable):
        """Run a possibly-async backend call on the sidecar's persistent loop.

        A fresh ``asyncio.run`` per request would break voicemem's stream, whose
        speculation tasks belong to one loop for the life of the session.
        """
        if not inspect.isawaitable(awaitable):
            return awaitable
        return self._loop.run_until_complete(awaitable)

    def _require_unlocked(self) -> None:
        """The sidecar owns the permission state, so every backend is gated.

        The adapter re-checks for the real backend; the fake backend relies on
        this method alone.
        """
        if not self._unlocked:
            raise MemoryLockedError("memory is locked; unlock the session first")

    def _record_error(self, exc: BaseException) -> None:
        self._last_error = f"{type(exc).__name__}: {exc}"[:200]

    def handle(self, request: dict) -> dict:
        method = str(request.get("method", ""))
        params = request.get("params") or {}
        if not isinstance(params, dict):
            raise ValueError("params must be an object")
        handler = getattr(self, method, None)
        if method not in _METHODS or handler is None:
            raise ValueError(f"unsupported method: {method}")
        return handler(params)


def serve(sidecar: Sidecar, stdin=None, stdout=None) -> None:
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        request: Any = None
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise ValueError("request must be an object")
            response = {"id": request.get("id"), "result": sidecar.handle(request)}
        except MemoryLockedError as exc:
            response = {"id": _request_id(request), "error": {"type": "MemoryLockedError", "detail": str(exc)[:200]}}
        except Exception as exc:  # noqa: BLE001 - process boundary returns typed failures
            response = {
                "id": _request_id(request),
                "error": {"type": type(exc).__name__, "detail": str(exc)[:200]},
            }
        stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        stdout.flush()
        if isinstance(request, dict) and request.get("method") == "close":
            break


def _request_id(request: Any) -> Any:
    return request.get("id") if isinstance(request, dict) else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--memory-root", required=True, type=Path)
    parser.add_argument("--backend", choices=("real", "fake"), default="real")
    parser.add_argument("--state-path", type=Path, default=None, help="persisted dedup file")
    parser.add_argument("--debounce-s", type=float, default=2.0)
    args = parser.parse_args()

    state_path = args.state_path or (args.memory_root / "observed-turns.json")
    sidecar = Sidecar(
        memory_root=args.memory_root,
        backend=args.backend,
        state_path=state_path,
        debounce_s=args.debounce_s,
    )
    serve(sidecar)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
