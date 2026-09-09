"""Fail-closed provider around the memory sidecar.

The voice loop calls this, never voicemem. Every method swallows sidecar
failures into a logged warning and a safe default (empty context, no injection),
because a memory outage must never break a conversation.
"""

from __future__ import annotations

import atexit
import logging
from collections.abc import Callable, Iterable, Mapping
from typing import Any

from .config import MemoryConfig
from .injection import DEFAULT_MAX_CHARS, InjectionDecision, build_injection
from .sidecar_client import SidecarClient, SidecarError

logger = logging.getLogger(__name__)


class MemoryProviderError(RuntimeError):
    """Raised only for programmer errors (bad config), never for outages."""


class MemoryProvider:
    """Prefetch, observe and inject; disabled by default."""

    def __init__(
        self,
        config: MemoryConfig,
        *,
        client: SidecarClient | None = None,
        client_factory: Callable[[], SidecarClient] | None = None,
    ) -> None:
        config.validate()
        self._config = config
        self._unlocked = False
        self._degraded_reason = ""
        self._client = client
        self._client_factory = client_factory or self._default_client_factory
        self._max_chars = int(config.max_context_chars or DEFAULT_MAX_CHARS)
        # The sidecar is a child process; make sure it is stopped even when the
        # session never started (e.g. the voice engine exits right after boot).
        atexit.register(self.close)

    # ── lifecycle ────────────────────────────────────────────────────────────

    @property
    def enabled(self) -> bool:
        return self._config.enabled

    @property
    def unlocked(self) -> bool:
        return self._unlocked

    @property
    def degraded_reason(self) -> str:
        return self._degraded_reason

    def start(self) -> bool:
        """Spawn the sidecar and verify it answers. Returns False when degraded."""
        if not self.enabled:
            return False
        try:
            client = self._ensure_client()
            health = client.health()
            self._degraded_reason = "" if health.get("ok") else str(health.get("warning") or "unhealthy")
            client.set_permission(unlocked=False)
            return bool(health.get("ok"))
        except SidecarError as exc:
            self._degrade("start", exc)
            return False

    def set_unlocked(self, unlocked: bool) -> None:
        """Mirror the voiceprint/security gate into the sidecar."""
        self._unlocked = bool(unlocked)
        if not self.enabled:
            return
        try:
            self._ensure_client().set_permission(unlocked=self._unlocked)
        except SidecarError as exc:
            self._degrade("set_permission", exc)

    def close(self) -> None:
        try:
            atexit.unregister(self.close)
        except Exception:  # pragma: no cover - unregister is best effort
            pass
        if self._client is not None:
            try:
                self._client.close()
            except SidecarError as exc:  # pragma: no cover - defensive
                logger.warning("memory sidecar close failed: %s", exc)
            finally:
                self._client = None
        self._unlocked = False

    # ── read path ────────────────────────────────────────────────────────────

    def prefetch_partial(self, *, session_id: str, turn_id: str, revision: int, text: str) -> str:
        return self._prefetch("prefetch_partial", session_id, turn_id, revision, text)

    def prefetch_final(self, *, session_id: str, turn_id: str, revision: int, text: str) -> str:
        return self._prefetch("prefetch_final", session_id, turn_id, revision, text)

    def build_injection(self, context: str, *, is_user_turn: bool = True) -> InjectionDecision:
        return build_injection(
            context,
            enabled=self.enabled,
            unlocked=self._unlocked,
            is_user_turn=is_user_turn,
            max_chars=self._max_chars,
        )

    # ── write path ───────────────────────────────────────────────────────────

    def observe(self, *, session_id: str, turns: Iterable[Mapping[str, Any]]) -> dict:
        """Queue final turns for batched extraction. Never blocks on extraction."""
        if not (self.enabled and self._unlocked):
            return {"accepted": [], "rejected": [], "pendingTurns": 0}
        payload = [
            {
                "turnId": str(turn.get("turn_id", turn.get("turnId", ""))),
                "revision": int(turn.get("turn_revision", turn.get("revision", 0)) or 0),
                "text": str(turn.get("text", "")),
            }
            for turn in turns
        ]
        try:
            return self._ensure_client().request("observe", {"sessionId": session_id, "turns": payload})
        except SidecarError as exc:
            self._degrade("observe", exc)
            return {"accepted": [], "rejected": [], "pendingTurns": 0}

    def flush(self, *, session_id: str | None = None) -> int:
        if not (self.enabled and self._unlocked):
            return 0
        params = {"sessionId": session_id} if session_id else {}
        try:
            result = self._ensure_client().request(
                "flush", params, timeout_ms=self._config.background_timeout_ms
            )
            return int(result.get("batches", 0))
        except SidecarError as exc:
            self._degrade("flush", exc)
            return 0

    def health(self) -> dict:
        if not self.enabled:
            return {"ok": True, "backend": "off"}
        try:
            return self._ensure_client().health()
        except SidecarError as exc:
            self._degrade("health", exc)
            return {"ok": False, "backend": "voicemem", "warning": self._degraded_reason}

    # ── internals ────────────────────────────────────────────────────────────

    def _prefetch(self, method: str, session_id: str, turn_id: str, revision: int, text: str) -> str:
        if not (self.enabled and self._unlocked):
            return ""
        cleaned = (text or "").strip()
        if not cleaned:
            return ""
        try:
            result = self._ensure_client().request(
                method,
                {
                    "sessionId": session_id,
                    "turnId": turn_id,
                    "revision": int(revision),
                    "text": cleaned,
                },
            )
            self._degraded_reason = ""
            return str(result.get("context", ""))[: self._max_chars]
        except SidecarError as exc:
            self._degrade(method, exc)
            return ""

    def _ensure_client(self) -> SidecarClient:
        if self._client is None:
            self._client = self._client_factory()
        return self._client

    def _default_client_factory(self) -> SidecarClient:
        assert self._config.sidecar_python and self._config.sidecar_script  # validated
        return SidecarClient(
            self._config.sidecar_python,
            [
                self._config.sidecar_script,
                "--memory-root",
                str(self._config.memory_root),
                "--backend",
                self._config.sidecar_backend,
            ],
            env=self._config.child_env(),
            timeout_ms=self._config.interactive_timeout_ms,
            background_timeout_ms=self._config.background_timeout_ms,
        )

    def _degrade(self, method: str, exc: BaseException) -> None:
        self._degraded_reason = f"{method}: {exc}"[:200]
        logger.warning("memory sidecar %s failed: %s", method, exc)


__all__ = ["MemoryProvider", "MemoryProviderError"]
