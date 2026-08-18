"""Agent adapter 抽象层。

统一 pi（``--mode rpc``，JSONL over stdio）和 Codex（``codex-acp``，ACP
JSON-RPC over stdio）两种 coding agent 的子进程驱动方式，对上层暴露统一的
``run`` 接口与事件回调。

每个任务 spawn 一个独立的 agent 子进程（任务隔离），任务结束即关闭进程。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# 事件回调：on_event(type, payload)。同步、快速返回，不得抛异常。
EventCallback = Any  # Callable[[str, dict[str, Any]], None]


@dataclass
class AgentResult:
    """单个 agent 任务完成后的结果。"""

    ok: bool
    text: str = ""
    error: str = ""
    #: 该任务执行过的工具调用（名称 + 脱敏参数），供进度投影
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    #: 子进程退出码（用于诊断）
    exit_code: int | None = None


class AgentAdapter:
    """驱动一个 coding agent 子进程执行单个任务的基类。"""

    #: 后端标识（如 "pi" / "codex"）
    kind: str = "base"

    async def run(
        self,
        task_id: str,
        prompt: str,
        *,
        on_event: EventCallback | None = None,
        cancel_event: Any = None,  # asyncio.Event
    ) -> AgentResult:
        """spawn 子进程，发送 prompt，收集事件流，返回最终结果。

        Args:
            task_id: 任务 id（用于日志与事件关联）。
            prompt: 发给 agent 的用户请求文本。
            on_event: 可选事件回调，接收 (type, payload)。type 取值：
                ``text_delta`` / ``tool_start`` / ``tool_end`` /
                ``permission`` / ``completed``。
            cancel_event: 可选 asyncio.Event，置位时取消任务（发送 abort）。

        Returns:
            AgentResult，``ok`` 表示 agent 正常完成并产出文本。
        """
        raise NotImplementedError
