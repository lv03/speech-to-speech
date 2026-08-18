"""任务队列与 Work 状态机。

状态流转（Phase 1 简化版，无 delegated 层）：

    queued → running → completed
                   ├→ failed
                   └→ cancelling → cancelled

任务记录是「交付收据」而非 agent 内部状态的镜像；对外只暴露 prompt、状态、
最终结果与脱敏后的工具活动。已完成/失败的结果可持久化到磁盘，重启后保留。
"""
from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# 终结态
TERMINAL = ("completed", "failed", "cancelled")


@dataclass
class Task:
    id: str
    prompt: str
    kind: str
    status: str = "queued"
    result: str = ""
    error: str = ""
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)

    def to_public(self) -> dict[str, Any]:
        """对外暴露的脱敏视图（不含 agent 内部 sessionId/推理）。"""
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "prompt": self.prompt,
            "result": self.result,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "tool_calls": [{"name": t.get("name", ""), "status": t.get("status", "")} for t in self.tool_calls],
        }


class TaskQueue:
    """线程安全的任务注册表，可选 JSON 文件持久化。"""

    def __init__(self, *, persistence_path: str | Path | None = None) -> None:
        self._tasks: dict[str, Task] = {}
        self._lock = threading.Lock()
        self._path = Path(persistence_path) if persistence_path else None
        if self._path is not None:
            self._load()

    # ── 持久化 ────────────────────────────────────────────────────────────

    def _serialize(self) -> list[dict[str, Any]]:
        return [vars(t) for t in self._tasks.values()]

    def _load(self) -> None:
        assert self._path is not None
        if not self._path.is_file():
            return
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            for item in raw:
                task = Task(**item)
                self._tasks[task.id] = task
        except (json.JSONDecodeError, TypeError, OSError) as exc:
            logger.warning("任务持久化文件无法加载：%s", exc)

    def _save(self) -> None:
        if self._path is None:
            return
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._serialize(), ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(self._path)  # 原子替换
        except OSError as exc:
            logger.warning("任务持久化写入失败：%s", exc)

    def _persist(self) -> None:
        self._save()

    # ── 操作 ──────────────────────────────────────────────────────────────

    def create(self, prompt: str, kind: str) -> Task:
        with self._lock:
            task = Task(id=uuid.uuid4().hex[:12], prompt=prompt, kind=kind)
            self._tasks[task.id] = task
            self._persist()
            logger.info("task %s queued (kind=%s)", task.id, kind)
            return task

    def get(self, task_id: str) -> Task | None:
        with self._lock:
            return self._tasks.get(task_id)

    def list(self) -> list[Task]:
        with self._lock:
            return sorted(self._tasks.values(), key=lambda t: t.created_at, reverse=True)

    def transition(self, task_id: str, status: str, **fields: Any) -> Task | None:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return None
            task.status = status
            task.updated_at = time.time()
            for key, value in fields.items():
                if hasattr(task, key):
                    setattr(task, key, value)
            self._persist()
            return task

    def mark_running(self, task_id: str) -> Task | None:
        return self.transition(task_id, "running")

    def complete(self, task_id: str, result: str, tool_calls: list[dict[str, Any]] | None = None) -> Task | None:
        fields: dict[str, Any] = {"result": result}
        if tool_calls is not None:
            fields["tool_calls"] = tool_calls
        return self.transition(task_id, "completed", **fields)

    def fail(self, task_id: str, error: str, tool_calls: list[dict[str, Any]] | None = None) -> Task | None:
        fields: dict[str, Any] = {"error": error}
        if tool_calls is not None:
            fields["tool_calls"] = tool_calls
        return self.transition(task_id, "failed", **fields)

    def mark_cancelling(self, task_id: str) -> Task | None:
        return self.transition(task_id, "cancelling")

    def cancel(self, task_id: str) -> Task | None:
        return self.transition(task_id, "cancelled")

    def is_terminal(self, task_id: str) -> bool:
        task = self.get(task_id)
        return task is not None and task.status in TERMINAL
