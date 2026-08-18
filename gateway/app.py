"""Agent Gateway：FastAPI 应用。

独立 Python 服务，职责单一：接收语音引擎（或任意客户端）的任务请求，
spawn coding agent 子进程执行，广播进度/结果事件。

接口：
  POST   /tasks         创建任务（异步执行）
  GET    /tasks         任务列表
  GET    /tasks/{id}    任务详情
  DELETE /tasks/{id}    取消任务
  GET    /health        健康检查
  WS     /events        任务进度/结果事件流
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from .agent_adapter import create_adapter
from .config import GatewayConfig
from .task_queue import TaskQueue

logger = logging.getLogger(__name__)


class CreateTaskRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=100_000)
    kind: str | None = None  # None → 用配置的 default_kind


class GatewayApp:
    """组装 TaskQueue + agent 执行 + 事件广播。"""

    def __init__(self, config: GatewayConfig | None = None) -> None:
        self.config = config or GatewayConfig.from_env()
        self.queue = TaskQueue(persistence_path=self.config.persistence_path)
        # 广播队列：on_event 同步 put 到这里，broadcaster 消费后分发
        self._broadcast_queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        # task_id → cancel_event
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._broadcaster_task: asyncio.Task | None = None

    # ── 事件发布 ──────────────────────────────────────────────────────────

    def _emit_sync(self, event: dict[str, Any]) -> None:
        """同步发布事件（供 adapter 的 on_event 回调调用）。"""
        try:
            self._broadcast_queue.put_nowait(event)
        except Exception:  # noqa: BLE001
            logger.exception("事件发布失败")

    async def _broadcaster(self) -> None:
        while True:
            event = await self._broadcast_queue.get()
            for sub in list(self._subscribers):
                try:
                    sub.put_nowait(event)
                except asyncio.QueueFull:
                    logger.warning("订阅者队列满，丢弃事件")
                except Exception:  # noqa: BLE001
                    self._subscribers.discard(sub)

    # ── 任务执行 ──────────────────────────────────────────────────────────

    async def _run_task(self, task_id: str, prompt: str, kind: str) -> None:
        self.queue.mark_running(task_id)
        self._emit_sync({
            "task_id": task_id,
            "event": "status",
            "data": {"status": "running", "task": self.queue.get(task_id).to_public() if self.queue.get(task_id) else None},
        })

        adapter = create_adapter(kind)
        cancel_event = asyncio.Event()
        self._cancel_events[task_id] = cancel_event

        def on_event(etype: str, payload: dict[str, Any]) -> None:
            self._emit_sync({"task_id": task_id, "event": etype, "data": payload})

        try:
            result = await adapter.run(task_id, prompt, on_event=on_event, cancel_event=cancel_event)
        except asyncio.CancelledError:
            self.queue.cancel(task_id)
            self._emit_sync({"task_id": task_id, "event": "status", "data": {"status": "cancelled"}})
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("task %s 执行异常", task_id)
            self.queue.fail(task_id, str(exc))
        else:
            if result.ok:
                self.queue.complete(task_id, result.text, result.tool_calls)
            else:
                self.queue.fail(task_id, result.error, result.tool_calls)
        finally:
            self._cancel_events.pop(task_id, None)

        task = self.queue.get(task_id)
        self._emit_sync({
            "task_id": task_id,
            "event": "status",
            "data": {"status": task.status if task else "unknown", "task": task.to_public() if task else None},
        })

    # ── 应用构建 ──────────────────────────────────────────────────────────

    def build(self) -> FastAPI:
        @asynccontextmanager
        async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
            self._broadcaster_task = asyncio.create_task(self._broadcaster())
            try:
                yield
            finally:
                if self._broadcaster_task:
                    self._broadcaster_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError):
                        await self._broadcaster_task

        app = FastAPI(title="speech-to-speech Agent Gateway", lifespan=lifespan)

        @app.get("/health")
        async def health() -> dict[str, Any]:
            return {
                "ok": True,
                "default_kind": self.config.default_kind,
                "pending": len([t for t in self.queue.list() if t.status in ("queued", "running", "cancelling")]),
            }

        @app.post("/tasks", status_code=202)
        async def create_task(req: CreateTaskRequest) -> dict[str, Any]:
            kind = (req.kind or self.config.default_kind).strip().lower()
            if kind not in ("pi", "codex"):
                raise HTTPException(status_code=400, detail=f"不支持的 agent 后端：{kind}")
            task = self.queue.create(req.prompt, kind)
            asyncio.create_task(self._run_task(task.id, req.prompt, kind))
            return task.to_public()

        @app.get("/tasks")
        async def list_tasks() -> list[dict[str, Any]]:
            return [t.to_public() for t in self.queue.list()]

        @app.get("/tasks/{task_id}")
        async def get_task(task_id: str) -> dict[str, Any]:
            task = self.queue.get(task_id)
            if task is None:
                raise HTTPException(status_code=404, detail="任务不存在")
            return task.to_public()

        @app.delete("/tasks/{task_id}", status_code=202)
        async def cancel_task(task_id: str) -> dict[str, Any]:
            task = self.queue.get(task_id)
            if task is None:
                raise HTTPException(status_code=404, detail="任务不存在")
            if self.queue.is_terminal(task_id):
                return task.to_public()
            self.queue.mark_cancelling(task_id)
            cancel_event = self._cancel_events.get(task_id)
            if cancel_event is not None:
                cancel_event.set()
            else:
                # 尚未开始执行：直接取消
                self.queue.cancel(task_id)
            return self.queue.get(task_id).to_public()  # type: ignore[union-attr]

        @app.websocket("/events")
        async def events(ws: WebSocket) -> None:
            await ws.accept()
            sub: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=1000)
            self._subscribers.add(sub)
            try:
                # 先推送当前任务快照
                await ws.send_json({
                    "event": "snapshot",
                    "tasks": [t.to_public() for t in self.queue.list()],
                })
                while True:
                    event = await sub.get()
                    await ws.send_json(event)
            except WebSocketDisconnect:
                pass
            finally:
                self._subscribers.discard(sub)

        return app


def create_app(config: GatewayConfig | None = None) -> FastAPI:
    """创建 FastAPI 应用（供 uvicorn 入口与测试使用）。"""
    return GatewayApp(config).build()
