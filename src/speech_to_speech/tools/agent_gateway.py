"""Agent Gateway 工具模块。

让语音 LLM 通过 OpenAI Realtime 工具调用驱动 coding agent（pi / Codex）
执行任务。本模块通过 ``--tool-module speech_to_speech.tools.agent_gateway``
加载，约定由 :func:`speech_to_speech.api.openai_realtime.audio_client.load_realtime_tool_module`
定义：

- ``TOOLS``：工具 schema 列表
- ``execute_tool(name, arguments)``：异步执行器，返回 str / ToolResult

Gateway 地址由 ``GATEWAY_URL`` 环境变量指定（默认 ``http://127.0.0.1:3101``）。
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://127.0.0.1:3101").rstrip("/")

#: 提交任务后是否让 LLM 立即生成一句确认（默认 True，与工具闭环一致）
CREATE_RESPONSE = True

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "spawn_agent_task",
        "description": (
            "把需要 coding agent 执行的任务交给后台 agent 异步执行。"
            "适合写代码、查文件、跑命令、改项目等多步工作。"
            "提交后立即返回任务 id，任务在后台执行，可用 get_agent_task_status 查询结果。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "给 coding agent 的完整任务描述（要具体、可执行）。",
                },
                "kind": {
                    "type": "string",
                    "enum": ["pi", "codex"],
                    "description": "后端 agent 类型，默认 pi。",
                },
            },
            "required": ["prompt"],
        },
    },
    {
        "type": "function",
        "name": "get_agent_task_status",
        "description": "查询后台 agent 任务的状态和最终结果。任务完成后会返回结果文本。",
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "spawn_agent_task 返回的任务 id。"},
            },
            "required": ["task_id"],
        },
    },
    {
        "type": "function",
        "name": "cancel_agent_task",
        "description": "取消一个仍在执行的后台 agent 任务。",
        "parameters": {
            "type": "object",
            "properties": {
                "task_id": {"type": "string", "description": "要取消的任务 id。"},
            },
            "required": ["task_id"],
        },
    },
]


async def _request(method: str, path: str, **kwargs: Any) -> dict[str, Any]:
    url = f"{GATEWAY_URL}{path}"
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.request(method, url, **kwargs)
    resp.raise_for_status()
    return resp.json()


async def execute_tool(name: str, arguments: dict[str, Any]) -> str:
    """执行 Agent Gateway 工具，返回 JSON 字符串结果。"""
    if name == "spawn_agent_task":
        prompt = str(arguments.get("prompt", "")).strip()
        if not prompt:
            raise ValueError("prompt 不能为空")
        kind = str(arguments.get("kind") or "pi").strip().lower()
        body: dict[str, Any] = {"prompt": prompt}
        if kind:
            body["kind"] = kind
        task = await _request("POST", "/tasks", json=body)
        return json.dumps({
            "task_id": task.get("id"),
            "status": task.get("status"),
            "hint": "任务已提交后台执行，稍后可用 get_agent_task_status 查询结果",
        }, ensure_ascii=False)

    if name == "get_agent_task_status":
        task_id = str(arguments.get("task_id", "")).strip()
        if not task_id:
            raise ValueError("task_id 不能为空")
        task = await _request("GET", f"/tasks/{task_id}")
        return json.dumps({
            "status": task.get("status"),
            "result": task.get("result") or None,
            "error": task.get("error") or None,
            "tool_calls": task.get("tool_calls") or [],
        }, ensure_ascii=False)

    if name == "cancel_agent_task":
        task_id = str(arguments.get("task_id", "")).strip()
        if not task_id:
            raise ValueError("task_id 不能为空")
        task = await _request("DELETE", f"/tasks/{task_id}")
        return json.dumps({
            "status": task.get("status"),
            "hint": "已请求取消任务",
        }, ensure_ascii=False)

    raise ValueError(f"未知工具：{name}")
