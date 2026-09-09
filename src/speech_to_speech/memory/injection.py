"""Injection policy for prefetched memory (product copy of the experiment policy).

Gates, all required: memory enabled, session unlocked, non-empty context, user
turn. The block rides its own system message immediately before the latest user
message, per response — session-level instructions are measurably ignored for
the turn (upstream examples 05 and qwen-audio-agent both hit this).
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


__all__ = ["DEFAULT_MAX_CHARS", "HEADER_ZH", "InjectionDecision", "build_injection", "inject_into_messages"]
