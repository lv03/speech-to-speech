"""Parent-side client for the voicemem sidecar (`sidecar.py`).

Owns the child process, request/response correlation, timeouts, stderr capture
and restart-on-death. The parent never imports voicemem; it only speaks JSONL.
"""

from __future__ import annotations

import json
import subprocess
import threading
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import Any

DEFAULT_TIMEOUT_MS = 30_000
DEFAULT_BACKGROUND_TIMEOUT_MS = 120_000


class SidecarError(RuntimeError):
    """Raised when the sidecar fails, exits, or returns a typed error."""

    def __init__(self, message: str, *, detail: str = "") -> None:
        super().__init__(message)
        self.detail = detail


class SidecarTimeout(SidecarError):
    """Raised when a request exceeds its deadline."""


class SidecarClient:
    """Thin, restart-aware client. Start it with `start()` or lazily on first use."""

    def __init__(
        self,
        command: str,
        args: Sequence[str] = (),
        *,
        env: Mapping[str, str] | None = None,
        cwd: str | None = None,
        timeout_ms: int = DEFAULT_TIMEOUT_MS,
        background_timeout_ms: int = DEFAULT_BACKGROUND_TIMEOUT_MS,
        popen: Callable[..., subprocess.Popen] = subprocess.Popen,
    ) -> None:
        self.command = command
        self.args = list(args)
        self.env = dict(env) if env is not None else None
        self.cwd = cwd
        self.timeout_ms = int(timeout_ms)
        self.background_timeout_ms = max(int(timeout_ms), int(background_timeout_ms))
        self._popen = popen
        self._child: subprocess.Popen | None = None
        self._lock = threading.RLock()
        self._pending: dict[str, dict[str, Any]] = {}
        self._reader: threading.Thread | None = None
        self._stderr_tail = ""
        self._exit_error: str = ""

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self) -> None:
        with self._lock:
            if self._child is not None and self._child.poll() is None:
                return
            self._exit_error = ""
            self._child = self._popen(
                [self.command, *self.args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                env=self.env,
                cwd=self.cwd,
            )
            self._reader = threading.Thread(target=self._read_stdout, daemon=True)
            self._reader.start()
            threading.Thread(target=self._read_stderr, daemon=True).start()

    def close(self, *, timeout_ms: int | None = None) -> None:
        with self._lock:
            child = self._child
        if child is None:
            return
        try:
            if child.poll() is None:
                self.request("close", timeout_ms=timeout_ms or self.background_timeout_ms)
        except SidecarError:
            pass
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:  # pragma: no cover - defensive
                    child.kill()
            with self._lock:
                self._child = None
                self._reject_all(SidecarError("sidecar closed"))

    @property
    def stderr_tail(self) -> str:
        return self._stderr_tail

    @property
    def running(self) -> bool:
        with self._lock:
            return self._child is not None and self._child.poll() is None

    # ── requests ─────────────────────────────────────────────────────────────

    def request(self, method: str, params: dict[str, Any] | None = None, *, timeout_ms: int | None = None) -> dict:
        self.start()
        with self._lock:
            child = self._child
            if child is None or child.stdin is None:
                raise SidecarError("sidecar is not running", detail=self._stderr_tail)
            request_id = uuid.uuid4().hex
            entry: dict[str, Any] = {"event": threading.Event(), "result": None, "error": None}
            self._pending[request_id] = entry
            payload = json.dumps({"id": request_id, "method": method, "params": params or {}}, ensure_ascii=False)
            try:
                child.stdin.write(payload + "\n")
                child.stdin.flush()
            except OSError as exc:
                self._pending.pop(request_id, None)
                raise SidecarError(f"sidecar write failed: {exc}", detail=self._stderr_tail) from exc

        deadline = (timeout_ms or self.timeout_ms) / 1000
        if not entry["event"].wait(deadline):
            with self._lock:
                self._pending.pop(request_id, None)
            raise SidecarTimeout(f"sidecar {method} timed out", detail=self._stderr_tail)
        if entry["error"] is not None:
            error = entry["error"]
            raise SidecarError(
                f"{error.get('type', 'SidecarError')}: {error.get('detail', '')}",
                detail=self._stderr_tail,
            )
        result = entry["result"]
        return result if isinstance(result, dict) else {"result": result}

    # ── convenience ──────────────────────────────────────────────────────────

    def health(self) -> dict:
        return self.request("health")

    def set_permission(self, *, unlocked: bool) -> dict:
        return self.request("set_permission", {"unlocked": bool(unlocked)})

    def recall(self, query: str, *, top_k: int | None = None) -> dict:
        params: dict[str, Any] = {"query": query}
        if top_k is not None:
            params["topK"] = int(top_k)
        return self.request("recall", params)

    def observe(self, *, session_id: str, turns: Iterable[Mapping[str, Any]]) -> dict:
        payload = [
            {
                "turnId": str(turn.get("turn_id", turn.get("turnId", ""))),
                "revision": int(turn.get("turn_revision", turn.get("revision", 0)) or 0),
                "text": str(turn.get("text", "")),
            }
            for turn in turns
        ]
        return self.request("observe", {"sessionId": session_id, "turns": payload})

    def flush(self, *, session_id: str | None = None) -> dict:
        params = {"sessionId": session_id} if session_id else {}
        return self.request("flush", params, timeout_ms=self.background_timeout_ms)

    # ── internals ────────────────────────────────────────────────────────────

    def _read_stdout(self) -> None:
        child = self._child
        if child is None or child.stdout is None:
            return
        for line in child.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except ValueError:
                continue
            request_id = str(message.get("id", ""))
            with self._lock:
                entry = self._pending.pop(request_id, None)
            if entry is None:
                continue
            if "error" in message:
                entry["error"] = message["error"] or {}
            else:
                entry["result"] = message.get("result")
            entry["event"].set()
        code = child.wait()
        with self._lock:
            self._exit_error = f"sidecar exited ({code})"
            self._reject_all(SidecarError(self._exit_error, detail=self._stderr_tail))

    def _read_stderr(self) -> None:
        child = self._child
        if child is None or child.stderr is None:
            return
        for line in child.stderr:
            self._stderr_tail = line.strip()[:500] or self._stderr_tail

    def _reject_all(self, error: SidecarError) -> None:
        for entry in self._pending.values():
            entry["error"] = {"type": type(error).__name__, "detail": str(error)}
            entry["event"].set()
        self._pending.clear()


__all__ = [
    "DEFAULT_BACKGROUND_TIMEOUT_MS",
    "DEFAULT_TIMEOUT_MS",
    "SidecarClient",
    "SidecarError",
    "SidecarTimeout",
]
