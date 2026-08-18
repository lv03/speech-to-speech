"""Agent adapter 工厂：根据后端标识创建对应的子进程驱动。"""
from __future__ import annotations

from .base import AgentAdapter, AgentResult
from .codex_acp import CodexAcpAdapter
from .pi_rpc import PiRpcAdapter

__all__ = [
    "AgentAdapter",
    "AgentResult",
    "CodexAcpAdapter",
    "PiRpcAdapter",
    "create_adapter",
    "SUPPORTED_KINDS",
]

SUPPORTED_KINDS = ("pi", "codex")


def create_adapter(kind: str, **kwargs) -> AgentAdapter:
    """按后端标识创建 adapter。

    Args:
        kind: ``"pi"`` 或 ``"codex"``。
        kwargs: 透传给对应 adapter 的构造参数。

    Raises:
        ValueError: 未知后端。
    """
    normalized = str(kind or "").strip().lower()
    if normalized == "pi":
        return PiRpcAdapter(**kwargs)
    if normalized == "codex":
        return CodexAcpAdapter(**kwargs)
    raise ValueError(f"不支持的 agent 后端：{kind!r}（可选：{', '.join(SUPPORTED_KINDS)}）")
