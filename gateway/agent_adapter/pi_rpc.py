"""pi coding agent 驱动（``pi --mode rpc``，JSONL over stdio）。

协议参考 pi 的 ``docs/rpc.md``：命令为逐行 JSON（stdin），事件为逐行 JSON
（stdout）。完成信号是 ``agent_settled`` 事件；取消通过 ``abort`` 命令。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from .base import AgentAdapter, AgentResult

logger = logging.getLogger(__name__)

# 从环境变量读取 pi 可执行文件路径，默认从 PATH 查找。
PI_BIN = os.environ.get("GATEWAY_PI_BIN", "pi")

# 权限请求默认策略："reject"（拒绝）或 "confirm"（确认）。Phase 2 接入语音
# 确认后由上层决策，此处仅作无上层决策时的兜底。
PERMISSION_POLICY = os.environ.get("GATEWAY_PI_PERMISSION_POLICY", "reject")


def _default_permission_reply(req: dict[str, Any]) -> dict[str, Any] | None:
    """按默认策略生成权限回复；返回 None 表示不回复（会等待超时）。"""
    method = req.get("method")
    req_id = req.get("id")
    if not req_id:
        return None
    if PERMISSION_POLICY == "confirm":
        if method == "confirm":
            return {"type": "extension_ui_response", "id": req_id, "confirmed": True}
        if method in ("select", "input", "editor"):
            return {"type": "extension_ui_response", "id": req_id, "cancelled": True}
        return None
    # 默认 reject：一律拒绝/取消
    if method == "confirm":
        return {"type": "extension_ui_response", "id": req_id, "confirmed": False}
    return {"type": "extension_ui_response", "id": req_id, "cancelled": True}


class PiRpcAdapter(AgentAdapter):
    """驱动 ``pi --mode rpc`` 子进程执行单个任务。"""

    kind = "pi"

    def __init__(
        self,
        *,
        bin_path: str = PI_BIN,
        provider: str | None = None,
        model: str | None = None,
        session_dir: str | None = None,
    ) -> None:
        self._bin = bin_path
        self._provider = provider or os.environ.get("GATEWAY_PI_PROVIDER") or None
        self._model = model or os.environ.get("GATEWAY_PI_MODEL") or None
        self._session_dir = session_dir or os.environ.get("GATEWAY_PI_SESSION_DIR") or None

    def _build_command(self) -> list[str]:
        cmd = [self._bin, "--mode", "rpc", "--no-session"]
        if self._provider:
            cmd += ["--provider", self._provider]
        if self._model:
            cmd += ["--model", self._model]
        if self._session_dir:
            cmd += ["--session-dir", self._session_dir]
        return cmd

    @staticmethod
    def _write(proc: asyncio.subprocess.Process, obj: dict[str, Any]) -> None:
        if proc.stdin is None:
            raise RuntimeError("pi 子进程 stdin 不可用")
        proc.stdin.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))

    async def run(
        self,
        task_id: str,
        prompt: str,
        *,
        on_event=None,
        cancel_event: asyncio.Event | None = None,
    ) -> AgentResult:
        cmd = self._build_command()
        logger.info("pi task=%s spawning %s", task_id, cmd)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            return AgentResult(
                ok=False,
                error=f"pi 可执行文件未找到：{self._bin}（可用 GATEWAY_PI_BIN 指定路径）",
            )

        # 消费 stderr，避免管道阻塞
        stderr_lines: list[str] = []

        async def _drain_stderr() -> None:
            assert proc.stderr is not None
            while True:
                line = await proc.stderr.readline()
                if not line:
                    break
                stderr_lines.append(line.decode("utf-8", "replace").rstrip())
                # 截断，避免无限增长
                if len(stderr_lines) > 200:
                    del stderr_lines[:100]

        stderr_task = asyncio.create_task(_drain_stderr())

        # 取消：向子进程发送 abort
        async def _watch_cancel() -> None:
            if cancel_event is None:
                return
            await cancel_event.wait()
            if proc.returncode is None:
                try:
                    self._write(proc, {"type": "abort"})
                except Exception:  # noqa: BLE001 - 子进程可能已退出
                    pass

        cancel_task = asyncio.create_task(_watch_cancel())

        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        settled = False
        exit_code: int | None = None

        def _emit(event_type: str, payload: dict[str, Any]) -> None:
            try:
                if on_event is not None:
                    on_event(event_type, payload)
            except Exception:  # noqa: BLE001 - 事件回调绝不能打断 agent 执行
                logger.exception("pi task=%s event callback failed", task_id)

        try:
            self._write(proc, {"type": "prompt", "message": prompt})

            assert proc.stdout is not None
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                raw = line.decode("utf-8", "replace").strip()
                if not raw:
                    continue
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning("pi task=%s 无法解析事件行：%.200s", task_id, raw)
                    continue

                etype = event.get("type")

                if etype == "message_update":
                    delta = event.get("assistantMessageEvent") or {}
                    if delta.get("type") == "text_delta":
                        text = delta.get("delta", "")
                        if text:
                            text_parts.append(text)
                            _emit("text_delta", {"delta": text})
                elif etype == "tool_execution_start":
                    tool_calls.append({
                        "name": event.get("toolName", ""),
                        "status": "running",
                    })
                    _emit("tool_start", {"name": event.get("toolName", "")})
                elif etype == "tool_execution_end":
                    tool_calls.append({
                        "name": event.get("toolName", ""),
                        "status": "completed" if not event.get("isError") else "failed",
                    })
                    _emit("tool_end", {
                        "name": event.get("toolName", ""),
                        "is_error": bool(event.get("isError")),
                    })
                elif etype == "extension_ui_request":
                    reply = _default_permission_reply(event)
                    _emit("permission", {
                        "id": event.get("id"),
                        "method": event.get("method"),
                        "title": event.get("title", ""),
                        "message": event.get("message", ""),
                        "auto": PERMISSION_POLICY,
                    })
                    if reply is not None:
                        self._write(proc, reply)
                elif etype == "agent_settled":
                    settled = True
                    break
                # 其余事件（agent_start/end、turn_*、compaction_* 等）忽略

        except asyncio.CancelledError:
            # 上层取消：尽力 abort 后向上传播
            if proc.returncode is None:
                try:
                    self._write(proc, {"type": "abort"})
                except Exception:  # noqa: BLE001
                    pass
            raise

        # 清理子进程
        try:
            if proc.returncode is None:
                try:
                    self._write(proc, {"type": "abort"})
                except Exception:  # noqa: BLE001
                    pass
                proc.stdin.close()
                try:
                    await asyncio.wait_for(proc.wait(), timeout=5)
                except asyncio.TimeoutError:
                    proc.kill()
                    await proc.wait()
            else:
                proc.stdin.close()
                await proc.wait()
        except Exception:  # noqa: BLE001
            pass
        exit_code = proc.returncode

        cancel_task.cancel()
        await asyncio.gather(cancel_task, return_exceptions=True)
        stderr_task.cancel()
        await asyncio.gather(stderr_task, return_exceptions=True)

        final_text = "".join(text_parts).strip()

        if settled and final_text:
            _emit("completed", {"text": final_text})
            return AgentResult(ok=True, text=final_text, tool_calls=tool_calls, exit_code=exit_code)

        # 未正常 settle：拼接诊断信息
        stderr_tail = "\n".join(stderr_lines[-20:])
        if not settled:
            detail = f"pi 进程未正常完成（exit={exit_code}）"
        else:
            detail = "pi 未产出文本结果"
        if stderr_tail:
            detail += f"\nstderr:\n{stderr_tail}"
        return AgentResult(ok=False, text=final_text, error=detail, tool_calls=tool_calls, exit_code=exit_code)
