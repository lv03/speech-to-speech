"""Injection policy for prefetched memory.

Decision recorded here: the experiment targets **shape B** — prefetch during the
turn, inject per response — but the injection itself is gated, because "inject
automatically" changes the v1 boundary that says no automatic RAG.

Gates, all must pass for a block to be injected:

1. memory enabled by the user (setting);
2. session unlocked (voiceprint / security gate);
3. a prefetch context exists and is non-empty;
4. the turn is a user turn in a normal response, not a tool result.

The block is emitted as its own system message placed immediately before the
user's latest message — the same shape voicemem's `inject()` and
qwen-audio-agent use, and per-response rather than session-level, because
session-level instructions were measurably ignored for the turn.
"""

from __future__ import annotations

from dataclasses import dataclass

DEFAULT_MAX_CHARS = 1200

HEADER_ZH = "已知的用户记忆（仅供你理解用户，不要逐字复述，也不要主动复述来源）："


@dataclass(frozen=True)
class InjectionDecision:
    inject: bool
    reason: str
    message: dict[str, str] | None = None
    chars: int = 0
    truncated: bool = False


def build_injection(
    context: str,
    *,
    enabled: bool = True,
    unlocked: bool = False,
    is_user_turn: bool = True,
    max_chars: int = DEFAULT_MAX_CHARS,
    header: str = HEADER_ZH,
) -> InjectionDecision:
    """Decide whether to inject *context* into the current response."""
    if not enabled:
        return InjectionDecision(False, "disabled")
    if not unlocked:
        return InjectionDecision(False, "locked")
    if not is_user_turn:
        return InjectionDecision(False, "not_user_turn")
    cleaned = (context or "").strip()
    if not cleaned:
        return InjectionDecision(False, "empty")

    truncated = False
    limit = max(1, int(max_chars))
    if len(cleaned) > limit:
        cleaned = _trim(cleaned, limit)
        truncated = True
    message = {"role": "system", "content": f"{header}\n{cleaned}"}
    return InjectionDecision(True, "injected", message=message, chars=len(cleaned), truncated=truncated)


def inject_into_messages(
    messages: list[dict[str, str]],
    decision: InjectionDecision,
) -> list[dict[str, str]]:
    """Return a copy of *messages* with the memory block before the latest user turn."""
    if not decision.inject or decision.message is None:
        return list(messages)
    out = list(messages)
    index = None
    for position in range(len(out) - 1, -1, -1):
        if out[position].get("role") == "user":
            index = position
            break
    if index is None:
        return out
    out.insert(index, dict(decision.message))
    return out


def _trim(text: str, limit: int) -> str:
    """Cut on a line boundary so the block never ends mid-sentence."""
    kept: list[str] = []
    used = 0
    for line in text.splitlines():
        if used + len(line) + 1 > limit and kept:
            break
        kept.append(line)
        used += len(line) + 1
    if not kept:
        return text[:limit]
    return "\n".join(kept)


__all__ = [
    "DEFAULT_MAX_CHARS",
    "HEADER_ZH",
    "InjectionDecision",
    "build_injection",
    "inject_into_messages",
]
