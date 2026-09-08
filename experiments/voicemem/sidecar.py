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

Methods: ``health``, ``set_permission``, ``recall``, ``observe``, ``flush``,
``close``. The session starts **locked**; only an explicit
``set_permission {"unlocked": true}`` from the parent opens reads and writes.

Run it with the dedicated voicemem venv (``--backend real``), or with any
Python and ``--backend fake`` for tests::

    "$VENV/bin/python" experiments/voicemem/sidecar.py --memory-root /tmp/vm --backend real
    python experiments/voicemem/sidecar.py --memory-root /tmp/vm --backend fake
"""

from __future__ import annotations

import argparse
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


class FakeMemory:
    """In-memory backend for tests: no voicemem, no network, no model."""

    def __init__(self) -> None:
        self.written: list[str] = []
        self.hits: list[str] = []

    def ingest_final_turn(self, text: str, *, turn_id: str, turn_revision: int) -> bool:
        self.written.append(text)
        self.hits = [line.lstrip("- ") for line in text.splitlines()]
        return True

    def recall(self, query: str, *, top_k: int | None = None):
        del query, top_k
        return tuple(MemoryHit(text=hit, memory_id=f"m{index}") for index, hit in enumerate(self.hits))

    def delete_all(self) -> None:
        self.written.clear()
        self.hits.clear()

    def flush(self) -> None:
        return None


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

    def close(self, _params: dict) -> dict:
        self._writer.close()
        return {"closed": True}

    # ── plumbing ─────────────────────────────────────────────────────────────

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
        if method not in {"health", "set_permission", "recall", "observe", "flush", "close"} or handler is None:
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
