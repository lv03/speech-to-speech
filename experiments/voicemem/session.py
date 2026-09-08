"""Session-batched write path: debounce, dedup, sensitive-content filter.

Why batching: one `vm.ingest()` is a cloud extraction call and measured 12–32 s
per utterance. One completed voice session is one observation unit, so a
session's final turns are joined into a single ingest — N short turns no longer
cost N extractions, and later turns in the session can correct earlier ones.

What this layer owns:

- **dedup** keyed on `(session_id, turn_id, turn_revision)`, persisted so a
  process restart does not re-ingest history. Keys are marked seen only after a
  successful write, so a crash between buffering and writing retries instead of
  losing the turn. The adapter's in-memory dedup stays as a second safety net;
- **sensitive-content filter** — memory is the worst place for a leaked key or ID
  number to persist;
- **debounce + worker thread**, because ingestion must never block the audio or
  event loop.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol, runtime_checkable

#: Same intent as qwen-audio-agent's filter: drop the utterance instead of
#: storing a credential, a national ID or medical details in the memory store.
SENSITIVE = re.compile(
    r"(?:api[_ -]?key|secret|token|password|passwd|credential"
    r"|密码|密钥|验证码|令牌|证件号|身份证|银行卡"
    r"|病史|病历|诊断|用药"
    r"|\bsk-[A-Za-z0-9_-]{8,}"
    r"|\b\d{15,19}\b)",
    re.IGNORECASE,
)

DEFAULT_MAX_TURNS_PER_BATCH = 12
DEFAULT_MAX_BATCH_CHARS = 4000
DEFAULT_DEBOUNCE_S = 2.0
DEFAULT_MAX_DEDUP_ENTRIES = 20_000


@runtime_checkable
class TurnWriter(Protocol):
    """What this layer needs from the adapter: one batched write."""

    def ingest_final_turn(self, text: str, *, turn_id: str, turn_revision: int) -> bool: ...


@dataclass(frozen=True)
class SubmitResult:
    accepted: bool
    reason: str = ""


@dataclass
class _Entry:
    key: str
    turn_id: str
    text: str


@dataclass
class _SessionBuffer:
    session_id: str
    entries: list[_Entry] = field(default_factory=list)
    chars: int = 0
    timer: threading.Timer | None = None


class SessionWriter:
    """Collects final turns per session and writes them in batches, off-thread."""

    def __init__(
        self,
        writer: TurnWriter,
        *,
        state_path: str | Path | None = None,
        debounce_s: float = DEFAULT_DEBOUNCE_S,
        max_turns_per_batch: int = DEFAULT_MAX_TURNS_PER_BATCH,
        max_batch_chars: int = DEFAULT_MAX_BATCH_CHARS,
        max_dedup_entries: int = DEFAULT_MAX_DEDUP_ENTRIES,
        sensitive: re.Pattern[str] | None = None,
        on_error: Callable[[BaseException], None] | None = None,
        spawn: Callable[[Callable[[], None]], object] | None = None,
    ) -> None:
        self._writer = writer
        self._debounce_s = max(0.0, float(debounce_s))
        self._max_turns = max(1, int(max_turns_per_batch))
        self._max_chars = max(1, int(max_batch_chars))
        self._max_dedup = max(1, int(max_dedup_entries))
        self._sensitive = sensitive if sensitive is not None else SENSITIVE
        self._on_error = on_error or (lambda _exc: None)
        self._spawn = spawn or self._spawn_thread
        self._state_path = Path(state_path).expanduser() if state_path else None
        self._lock = threading.RLock()
        self._buffers: dict[str, _SessionBuffer] = {}
        self._inflight: set[threading.Thread] = set()
        self._seen_order: list[str] = []
        self._seen: set[str] = set()
        self._load_state()

    # ── public API ───────────────────────────────────────────────────────────

    def submit_final_turn(
        self,
        text: str,
        *,
        turn_id: str,
        turn_revision: int,
        session_id: str,
    ) -> SubmitResult:
        """Buffer one final transcription. Returns why it was dropped, if it was."""
        cleaned = (text or "").strip()
        if not cleaned:
            return SubmitResult(False, "empty")
        if not turn_id:
            return SubmitResult(False, "missing_turn_id")
        if turn_revision is None or int(turn_revision) < 0:
            return SubmitResult(False, "bad_revision")
        if self._sensitive.search(cleaned):
            return SubmitResult(False, "sensitive")

        entry = _Entry(
            key=self._key(session_id, turn_id, int(turn_revision)),
            turn_id=turn_id,
            text=cleaned,
        )
        with self._lock:
            if entry.key in self._seen:
                return SubmitResult(False, "duplicate")
            if self._is_buffered_locked(entry.key):
                return SubmitResult(False, "duplicate")
            buffer = self._buffers.get(session_id)
            if buffer is None:
                buffer = _SessionBuffer(session_id=session_id)
                self._buffers[session_id] = buffer
            buffer.entries.append(entry)
            buffer.chars += len(cleaned)
            ready = len(buffer.entries) >= self._max_turns or buffer.chars >= self._max_chars
            if buffer.timer is not None:
                buffer.timer.cancel()
                buffer.timer = None
            if not ready:
                buffer.timer = threading.Timer(self._debounce_s, self._flush_session, args=(session_id,))
                buffer.timer.daemon = True
                buffer.timer.start()
                return SubmitResult(True)
            entries = self._take_locked(session_id)
        self._write(session_id, entries)
        return SubmitResult(True)

    def flush(self, session_id: str | None = None) -> int:
        """Write buffered turns now and wait for in-flight writes to land."""
        with self._lock:
            sessions = [session_id] if session_id is not None else list(self._buffers)
        written = 0
        for name in sessions:
            with self._lock:
                entries = self._take_locked(name)
            if entries:
                self._write(name, entries)
                written += 1
        self._wait_inflight()
        return written

    def pending(self, session_id: str | None = None) -> int:
        with self._lock:
            if session_id is not None:
                buffer = self._buffers.get(session_id)
                return len(buffer.entries) if buffer else 0
            return sum(len(buffer.entries) for buffer in self._buffers.values())

    def close(self) -> None:
        """Cancel timers and flush everything."""
        with self._lock:
            for buffer in self._buffers.values():
                if buffer.timer is not None:
                    buffer.timer.cancel()
                    buffer.timer = None
        self.flush()

    # ── internals ────────────────────────────────────────────────────────────

    @staticmethod
    def _key(session_id: str, turn_id: str, turn_revision: int) -> str:
        payload = f"{session_id}\0{turn_id}\0{int(turn_revision)}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _is_buffered_locked(self, key: str) -> bool:
        return any(entry.key == key for buffer in self._buffers.values() for entry in buffer.entries)

    def _take_locked(self, session_id: str) -> list[_Entry]:
        buffer = self._buffers.pop(session_id, None)
        if buffer is None or not buffer.entries:
            return []
        if buffer.timer is not None:
            buffer.timer.cancel()
            buffer.timer = None
        return buffer.entries

    def _flush_session(self, session_id: str) -> None:
        with self._lock:
            entries = self._take_locked(session_id)
        if entries:
            self._write(session_id, entries)

    def _write(self, session_id: str, entries: list[_Entry]) -> None:
        batch = batch_text([entry.text for entry in entries])

        def run() -> None:
            try:
                self._writer.ingest_final_turn(batch, turn_id=batch_id(batch), turn_revision=0)
            except BaseException as exc:  # noqa: BLE001 - a memory write must not kill the host
                self._requeue(session_id, entries)
                self._on_error(exc)
            else:
                self._mark_seen([entry.key for entry in entries])
            finally:
                with self._lock:
                    self._inflight.discard(threading.current_thread())

        spawned = self._spawn(run)
        if isinstance(spawned, threading.Thread):
            with self._lock:
                self._inflight.add(spawned)

    def _wait_inflight(self, timeout_s: float | None = None) -> None:
        """Join worker threads so flush/close mean "written", not "queued"."""
        deadline = None if timeout_s is None else time.monotonic() + timeout_s
        while True:
            with self._lock:
                threads = list(self._inflight)
            if not threads:
                return
            for thread in threads:
                remaining = None if deadline is None else max(0.0, deadline - time.monotonic())
                thread.join(remaining)
            with self._lock:
                self._inflight = {thread for thread in self._inflight if thread.is_alive()}
                if not self._inflight:
                    return
            if deadline is not None and time.monotonic() >= deadline:
                return

    def _requeue(self, session_id: str, entries: list[_Entry]) -> None:
        """Put failed turns back so the next submit or flush retries them."""
        with self._lock:
            buffer = self._buffers.get(session_id)
            if buffer is None:
                buffer = _SessionBuffer(session_id=session_id)
                self._buffers[session_id] = buffer
            for entry in entries:
                if not any(existing.key == entry.key for existing in buffer.entries):
                    buffer.entries.append(entry)
                    buffer.chars += len(entry.text)

    @staticmethod
    def _spawn_thread(run: Callable[[], None]) -> threading.Thread:
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        return thread

    # ── persisted dedup ──────────────────────────────────────────────────────

    def _mark_seen(self, keys: list[str]) -> None:
        with self._lock:
            for key in keys:
                if key in self._seen:
                    continue
                self._seen.add(key)
                self._seen_order.append(key)
            overflow = len(self._seen_order) - self._max_dedup
            if overflow > 0:
                dropped = self._seen_order[:overflow]
                self._seen_order = self._seen_order[overflow:]
                self._seen.difference_update(dropped)
        self._save_state()

    def _load_state(self) -> None:
        if self._state_path is None or not self._state_path.exists():
            return
        try:
            data = json.loads(self._state_path.read_text("utf-8"))
        except (OSError, ValueError):
            return
        entries = data.get("seen") if isinstance(data, dict) else data
        if isinstance(entries, list):
            self._seen_order = [str(item) for item in entries][-self._max_dedup:]
            self._seen = set(self._seen_order)

    def _save_state(self) -> None:
        if self._state_path is None:
            return
        with self._lock:
            payload = json.dumps({"version": 1, "seen": self._seen_order}, ensure_ascii=False)
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._state_path.with_suffix(self._state_path.suffix + ".tmp")
        temporary.write_text(payload, encoding="utf-8")
        os.chmod(temporary, 0o600)
        temporary.replace(self._state_path)


def batch_text(texts: list[str]) -> str:
    """Join a session's turns the way the extractor expects to read them."""
    return "\n".join(f"- {text}" for text in texts)


def batch_id(batch: str) -> str:
    return f"batch-{hashlib.sha256(batch.encode('utf-8')).hexdigest()[:16]}"


__all__ = [
    "DEFAULT_DEBOUNCE_S",
    "DEFAULT_MAX_BATCH_CHARS",
    "DEFAULT_MAX_TURNS_PER_BATCH",
    "SENSITIVE",
    "SessionWriter",
    "SubmitResult",
    "TurnWriter",
    "batch_id",
    "batch_text",
]
