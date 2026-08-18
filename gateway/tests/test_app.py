"""Gateway HTTP 接口测试（mock adapter）。"""
from __future__ import annotations

import time

from fastapi.testclient import TestClient

from gateway.agent_adapter.base import AgentResult
from gateway.app import create_app
from gateway.config import GatewayConfig


class FakeAdapter:
    kind = "fake"

    async def run(self, task_id, prompt, *, on_event=None, cancel_event=None):
        if on_event is not None:
            on_event("text_delta", {"delta": "结果"})
        return AgentResult(ok=True, text="结果文本", tool_calls=[])


def _client(monkeypatch):
    monkeypatch.setattr(
        "gateway.app.create_adapter",
        lambda kind, **kw: FakeAdapter(),
    )
    app = create_app(GatewayConfig(default_kind="pi"))
    return TestClient(app)


def _wait_terminal(client, task_id, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"/tasks/{task_id}")
        if r.json()["status"] in ("completed", "failed", "cancelled"):
            return r.json()
        time.sleep(0.05)
    raise AssertionError("任务超时未完成")


def test_health(monkeypatch):
    client = _client(monkeypatch)
    with client:
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json()["ok"] is True


def test_create_and_complete(monkeypatch):
    client = _client(monkeypatch)
    with client:
        r = client.post("/tasks", json={"prompt": "帮我写代码"})
        assert r.status_code == 202
        task_id = r.json()["id"]
        assert r.json()["status"] == "queued"

        final = _wait_terminal(client, task_id)
        assert final["status"] == "completed"
        assert final["result"] == "结果文本"


def test_get_nonexistent(monkeypatch):
    client = _client(monkeypatch)
    with client:
        r = client.get("/tasks/nope")
        assert r.status_code == 404


def test_unsupported_kind(monkeypatch):
    client = _client(monkeypatch)
    with client:
        r = client.post("/tasks", json={"prompt": "x", "kind": "gpt"})
        assert r.status_code == 400


def test_list_tasks(monkeypatch):
    client = _client(monkeypatch)
    with client:
        client.post("/tasks", json={"prompt": "a"})
        r = client.get("/tasks")
        assert r.status_code == 200
        assert len(r.json()) >= 1
