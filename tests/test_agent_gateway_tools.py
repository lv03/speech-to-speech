"""Agent Gateway 工具模块测试（mock Gateway HTTP）。"""
from __future__ import annotations

import json

import pytest

from speech_to_speech.tools import agent_gateway


class FakeResponse:
    def __init__(self, data: dict) -> None:
        self._data = data

    def raise_for_status(self) -> None:
        pass

    def json(self) -> dict:
        return self._data


class FakeClient:
    last_request: tuple | None = None
    response_data: dict = {}

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def request(self, method: str, url: str, **kwargs):
        FakeClient.last_request = (method, url, kwargs)
        return FakeResponse(FakeClient.response_data)


@pytest.fixture(autouse=True)
def _mock_client(monkeypatch):
    monkeypatch.setattr(agent_gateway.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(agent_gateway, "GATEWAY_URL", "http://gateway.test")
    FakeClient.last_request = None


def test_tools_schema_is_valid() -> None:
    names = [t["name"] for t in agent_gateway.TOOLS]
    assert names == ["spawn_agent_task", "get_agent_task_status", "cancel_agent_task"]
    for tool in agent_gateway.TOOLS:
        assert tool["type"] == "function"
        assert tool["name"]
        assert tool["description"]
        assert tool["parameters"]["type"] == "object"


async def test_spawn_agent_task() -> None:
    FakeClient.response_data = {"id": "abc123", "status": "queued"}
    result = await agent_gateway.execute_tool("spawn_agent_task", {"prompt": "写个函数", "kind": "pi"})

    method, url, kwargs = FakeClient.last_request
    assert method == "POST"
    assert url == "http://gateway.test/tasks"
    assert kwargs["json"] == {"prompt": "写个函数", "kind": "pi"}

    parsed = json.loads(result)
    assert parsed["task_id"] == "abc123"
    assert parsed["status"] == "queued"


async def test_spawn_defaults_kind() -> None:
    FakeClient.response_data = {"id": "x1", "status": "queued"}
    result = await agent_gateway.execute_tool("spawn_agent_task", {"prompt": "hello"})
    assert FakeClient.last_request[2]["json"] == {"prompt": "hello", "kind": "pi"}
    assert json.loads(result)["task_id"] == "x1"


async def test_get_agent_task_status() -> None:
    FakeClient.response_data = {"status": "completed", "result": "完成了", "error": None, "tool_calls": []}
    result = await agent_gateway.execute_tool("get_agent_task_status", {"task_id": "abc"})

    method, url, _ = FakeClient.last_request
    assert method == "GET"
    assert url == "http://gateway.test/tasks/abc"

    parsed = json.loads(result)
    assert parsed["status"] == "completed"
    assert parsed["result"] == "完成了"


async def test_cancel_agent_task() -> None:
    FakeClient.response_data = {"status": "cancelled"}
    result = await agent_gateway.execute_tool("cancel_agent_task", {"task_id": "abc"})
    assert FakeClient.last_request[0] == "DELETE"
    assert json.loads(result)["status"] == "cancelled"


async def test_unknown_tool() -> None:
    with pytest.raises(ValueError, match="未知工具"):
        await agent_gateway.execute_tool("nope", {})


async def test_empty_prompt_rejected() -> None:
    with pytest.raises(ValueError, match="不能为空"):
        await agent_gateway.execute_tool("spawn_agent_task", {"prompt": "  "})
