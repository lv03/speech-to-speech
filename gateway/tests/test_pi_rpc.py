"""PiRpcAdapter 测试（mock 子进程）。"""
from __future__ import annotations

import json

import pytest

from gateway.agent_adapter.pi_rpc import PiRpcAdapter


class FakeStream:
    def __init__(self, lines: list[str]) -> None:
        self._lines = [l.encode("utf-8") for l in lines]
        self._pos = 0

    async def readline(self) -> bytes:
        if self._pos >= len(self._lines):
            return b""
        line = self._lines[self._pos]
        self._pos += 1
        return line


class FakeStdin:
    def __init__(self) -> None:
        self.writes: list[bytes] = []

    def write(self, data: bytes) -> None:
        self.writes.append(data)

    def close(self) -> None:
        pass


class FakeProcess:
    def __init__(self, stdout_lines: list[str], stderr_lines: list[str] | None = None) -> None:
        self.stdout = FakeStream(stdout_lines)
        self.stderr = FakeStream(stderr_lines or [])
        self.stdin = FakeStdin()
        self.returncode: int | None = 0

    async def wait(self) -> int:
        return 0

    def kill(self) -> None:
        self.returncode = -9


def _events(*lines: dict) -> list[str]:
    return [json.dumps(line, ensure_ascii=False) for line in lines]


def test_prompt_sent_and_text_collected(monkeypatch) -> None:
    proc = FakeProcess(_events(
        {"type": "agent_start"},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "你好"}},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "世界"}},
        {"type": "agent_settled"},
    ))

    async def fake_spawn(*args, **kwargs):
        return proc

    monkeypatch.setattr("gateway.agent_adapter.pi_rpc.asyncio.create_subprocess_exec", fake_spawn)

    adapter = PiRpcAdapter()
    result = __import__("asyncio").run(adapter.run("t1", "打个招呼"))

    assert result.ok
    assert result.text == "你好世界"
    # 验证 prompt 命令确实发出
    sent = [json.loads(w.decode("utf-8")) for w in proc.stdin.writes]
    assert sent[0]["type"] == "prompt"
    assert sent[0]["message"] == "打个招呼"


def test_settled_but_no_text_fails(monkeypatch) -> None:
    proc = FakeProcess(_events({"type": "agent_settled"}))

    async def fake_spawn(*args, **kwargs):
        return proc

    monkeypatch.setattr("gateway.agent_adapter.pi_rpc.asyncio.create_subprocess_exec", fake_spawn)

    result = __import__("asyncio").run(PiRpcAdapter().run("t1", "x"))
    assert not result.ok


def test_no_settled_fails(monkeypatch) -> None:
    # 进程只发了一个事件就退出（无 agent_settled）
    proc = FakeProcess(_events({"type": "agent_start"}))

    async def fake_spawn(*args, **kwargs):
        return proc

    monkeypatch.setattr("gateway.agent_adapter.pi_rpc.asyncio.create_subprocess_exec", fake_spawn)

    result = __import__("asyncio").run(PiRpcAdapter().run("t1", "x"))
    assert not result.ok
    assert "未正常完成" in result.error


def test_tool_events_emitted(monkeypatch) -> None:
    proc = FakeProcess(_events(
        {"type": "tool_execution_start", "toolName": "bash"},
        {"type": "tool_execution_end", "toolName": "bash", "isError": False},
        {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "done"}},
        {"type": "agent_settled"},
    ))

    async def fake_spawn(*args, **kwargs):
        return proc

    monkeypatch.setattr("gateway.agent_adapter.pi_rpc.asyncio.create_subprocess_exec", fake_spawn)

    events = []
    result = __import__("asyncio").run(PiRpcAdapter().run(
        "t1", "x", on_event=lambda e, p: events.append((e, p)),
    ))
    assert result.ok
    kinds = [e for e, _ in events]
    assert "tool_start" in kinds
    assert "tool_end" in kinds
    assert "completed" in kinds


def test_file_not_found_returns_error(monkeypatch) -> None:
    async def fake_spawn(*args, **kwargs):
        raise FileNotFoundError("no pi")

    monkeypatch.setattr("gateway.agent_adapter.pi_rpc.asyncio.create_subprocess_exec", fake_spawn)

    result = __import__("asyncio").run(PiRpcAdapter(bin_path="/nonexistent").run("t1", "x"))
    assert not result.ok
    assert "未找到" in result.error
