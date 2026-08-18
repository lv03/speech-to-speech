"""TaskQueue 状态机测试。"""
from __future__ import annotations

from gateway.task_queue import TaskQueue


def test_create_and_get() -> None:
    q = TaskQueue()
    task = q.create("帮我写个函数", "pi")
    assert task.status == "queued"
    assert q.get(task.id) is task
    assert q.list() == [task]


def test_lifecycle_transitions() -> None:
    q = TaskQueue()
    task = q.create("测试任务", "codex")

    assert q.mark_running(task.id).status == "running"
    assert q.complete(task.id, "完成了").status == "completed"
    assert q.get(task.id).result == "完成了"
    assert q.is_terminal(task.id)


def test_fail_and_cancel() -> None:
    q = TaskQueue()
    t1 = q.create("a", "pi")
    q.mark_running(t1.id)
    assert q.fail(t1.id, "boom").status == "failed"
    assert q.get(t1.id).error == "boom"

    t2 = q.create("b", "pi")
    q.mark_cancelling(t2.id)
    assert q.cancel(t2.id).status == "cancelled"
    assert q.is_terminal(t2.id)


def test_persistence_roundtrip(tmp_path) -> None:
    path = tmp_path / "tasks.json"
    q = TaskQueue(persistence_path=path)
    t = q.create("持久化任务", "pi")
    q.mark_running(t.id)
    q.complete(t.id, "结果")

    # 重新加载
    q2 = TaskQueue(persistence_path=path)
    loaded = q2.get(t.id)
    assert loaded is not None
    assert loaded.status == "completed"
    assert loaded.result == "结果"


def test_public_view_hides_internals() -> None:
    q = TaskQueue()
    t = q.create("p", "pi")
    t.tool_calls = [{"name": "bash", "status": "running", "raw": "secret"}]
    public = t.to_public()
    assert "raw" not in public["tool_calls"][0]
    assert public["tool_calls"][0] == {"name": "bash", "status": "running"}
