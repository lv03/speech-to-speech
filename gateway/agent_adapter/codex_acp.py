"""Codex 驱动（``codex-acp``，ACP JSON-RPC 2.0 over stdio）。

Codex 非原生 ACP，需通过官方适配器 ``@agentclientprotocol/codex-acp``
（Node 包）桥接。适配器以 stdio 子进程运行，客户端与其通信 ACP 协议。

默认通过 ``npx -y @agentclientprotocol/codex-acp`` 按需运行；也可用
``GATEWAY_CODEX_ACP_BIN`` 指定已安装的 ``codex-acp`` 可执行文件。

.. note::
   本模块基于 ACP 规范与 qwen-audio-agent 的 acp-process-client 实现推断，
   Codex 未在当前环境安装，method 名与字段需在装好 codex-acp 后联调验证。
   关键假设：initialize / session/new / session/prompt / session/cancel；
   进度走 session/update 通知；文本从 agent_message_chunk 提取。
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

from .base import AgentAdapter, AgentResult

logger = logging.getLogger(__name__)

CODEX_ACP_BIN = os.environ.get("GATEWAY_CODEX_ACP_BIN", "")
CODEX_ACP_PACKAGE = os.environ.get(
    "GATEWAY_CODEX_ACP_PACKAGE", "@agentclientprotocol/codex-acp"
)

# ACP protocolVersion（与 @agentclientprotocol/sdk 对齐）
ACP_PROTOCOL_VERSION = 1


class CodexAcpAdapter(AgentAdapter):
    """驱动 ``codex-acp`` 子进程执行单个任务。"""

    kind = "codex"

    def __init__(self, *, cwd: str | None = None) -> None:
        self._cwd = cwd or os.getcwd()

    def _build_command(self) -> list[str]:
        if CODEX_ACP_BIN:
            return [CODEX_ACP_BIN]
        return ["npx", "-y", CODEX_ACP_PACKAGE]

    @staticmethod
    def _request(msg_id: int, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "id": msg_id, "method": method, "params": params}

    @staticmethod
    def _notify(method: str, params: dict[str, Any]) -> dict[str, Any]:
        return {"jsonrpc": "2.0", "method": method, "params": params}

    @staticmethod
    def _write(proc: asyncio.subprocess.Process, obj: dict[str, Any]) -> None:
        if proc.stdin is None:
            raise RuntimeError("codex-acp 子进程 stdin 不可用")
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
        logger.info("codex task=%s spawning %s", task_id, cmd)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=self._cwd,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            return AgentResult(
                ok=False,
                error="codex-acp 未找到（需安装 npx 或设 GATEWAY_CODEX_ACP_BIN）",
            )

        stderr_task = asyncio.create_task(self._drain_stderr(proc, stderr_lines := []))
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        result_text = ""
        stop_reason = ""
        msg_id = 0
        error = ""

        def _next_id() -> int:
            nonlocal msg_id
            msg_id += 1
            return msg_id

        def _emit(etype: str, payload: dict[str, Any]) -> None:
            try:
                if on_event is not None:
                    on_event(etype, payload)
            except Exception:  # noqa: BLE001
                logger.exception("codex task=%s event callback failed", task_id)

        try:
            assert proc.stdout is not None

            # 1) 握手
            self._write(proc, self._request(_next_id(), "initialize", {
                "protocolVersion": ACP_PROTOCOL_VERSION,
                "clientCapabilities": {},
                "clientInfo": {"name": "speech-to-speech-gateway", "title": "speech-to-speech Gateway", "version": "0.1.0"},
            }))

            # 2) 建会话
            self._write(proc, self._request(_next_id(), "session/new", {
                "cwd": self._cwd,
                "mcpServers": [],
            }))
            session_id = ""

            # 3) 发 prompt（带取消监听）
            cancel_task = asyncio.create_task(self._watch_cancel(proc, session_id, cancel_event))
            try:
                prompt_id = _next_id()
                self._write(proc, self._request(prompt_id, "session/prompt", {
                    "sessionId": session_id,  # 占位，待 session/new 响应后重发
                    "prompt": [{"type": "text", "text": prompt}],
                }))
            finally:
                pass

            # 主读取循环：处理响应与通知
            pending_prompt = True
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                raw = line.decode("utf-8", "replace").strip()
                if not raw:
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                method = msg.get("method")
                if "id" in msg and method:
                    # 响应
                    if method == "initialize":
                        ver = (msg.get("result") or {}).get("protocolVersion")
                        if ver != ACP_PROTOCOL_VERSION:
                            error = f"ACP 协议版本不兼容：agent={ver} client={ACP_PROTOCOL_VERSION}"
                            break
                    elif method == "session/new":
                        session_id = (msg.get("result") or {}).get("sessionId", "")
                        # 现在知道了 sessionId，重发 prompt
                        prompt_id = _next_id()
                        self._write(proc, self._request(prompt_id, "session/prompt", {
                            "sessionId": session_id,
                            "prompt": [{"type": "text", "text": prompt}],
                        }))
                    elif method == "session/prompt":
                        result = msg.get("result") or {}
                        stop_reason = result.get("stopReason", "")
                        pending_prompt = False
                        if stop_reason in ("cancelled", "cancel"):
                            error = "任务被取消"
                        break
                elif method:
                    # 通知（agent → client）
                    if method == "session/update":
                        params = msg.get("params") or {}
                        update = params.get("update") or {}
                        kind = update.get("sessionUpdate")
                        if kind == "agent_message_chunk":
                            content = update.get("content") or {}
                            if content.get("type") == "text":
                                text = content.get("text", "")
                                if text:
                                    text_parts.append(text)
                                    _emit("text_delta", {"delta": text})
                        elif kind in ("tool_call", "tool_call_update"):
                            name = update.get("name") or update.get("title") or ""
                            if name:
                                tool_calls.append({"name": name, "status": "running"})
                                _emit("tool_start", {"name": name})

            if session_id and pending_prompt is False and not error:
                result_text = "".join(text_parts).strip()

        except asyncio.CancelledError:
            if proc.returncode is None:
                try:
                    self._write(proc, self._notify("session/cancel", {"sessionId": ""}))
                except Exception:  # noqa: BLE001
                    pass
            raise

        # 清理
        try:
            if proc.returncode is None:
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

        stderr_task.cancel()
        await asyncio.gather(stderr_task, return_exceptions=True)

        if not error and result_text:
            _emit("completed", {"text": result_text})
            return AgentResult(ok=True, text=result_text, tool_calls=tool_calls, exit_code=proc.returncode)
        if not error:
            error = f"codex 未产出文本结果（stopReason={stop_reason or 'unknown'}）"
        return AgentResult(ok=False, text=result_text, error=error, tool_calls=tool_calls, exit_code=proc.returncode)

    @staticmethod
    async def _drain_stderr(proc: asyncio.subprocess.Process, lines: list[str]) -> None:
        assert proc.stderr is not None
        while True:
            line = await proc.stderr.readline()
            if not line:
                break
            lines.append(line.decode("utf-8", "replace").rstrip())
            if len(lines) > 200:
                del lines[:100]

    @staticmethod
    async def _watch_cancel(
        proc: asyncio.subprocess.Process,
        session_id: str,
        cancel_event: asyncio.Event | None,
    ) -> None:
        if cancel_event is None:
            return
        await cancel_event.wait()
        if proc.returncode is None:
            try:
                CodexAcpAdapter._write(proc, CodexAcpAdapter._notify(
                    "session/cancel", {"sessionId": session_id},
                ))
            except Exception:  # noqa: BLE001
                pass
