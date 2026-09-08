"""Tests for the prefetch, session-batch and injection layers. No voicemem needed."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from injection import HEADER_ZH, build_injection, inject_into_messages  # noqa: E402
from prefetch import PrefetchStream, render_context  # noqa: E402
from session import SessionWriter  # noqa: E402

# ── prefetch ─────────────────────────────────────────────────────────────────


class FakeStreamBackend:
    """Mirrors voicemem's text-only stream: partials start speculation."""

    def __init__(self, hits=("用户对坚果过敏",)) -> None:
        self.partials: list[str] = []
        self.finals: list[str] = []
        self.hits = hits

    async def feed_partial(self, text: str, ended: bool = False):
        self.partials.append(text)
        return _State(False, render_context(self.hits, header="MEM"))

    async def feed_text(self, text: str):
        self.finals.append(text)
        return _State(True, render_context(self.hits, header="MEM"))


class _State:
    def __init__(self, turn_over: bool, context: str) -> None:
        self.state = "turn_over" if turn_over else "listening"
        self.memory_context = context


async def test_short_partials_do_not_start_speculation():
    backend = FakeStreamBackend()
    stream = PrefetchStream(backend, min_chars=6)
    state = await stream.feed_partial("t1", 1, "我")
    assert state.turn_over is False
    assert backend.partials == []


async def test_long_partial_starts_speculation():
    backend = FakeStreamBackend()
    stream = PrefetchStream(backend, min_chars=6)
    state = await stream.feed_partial("t1", 1, "我对什么食物过敏")
    assert backend.partials == ["我对什么食物过敏"]
    assert "用户对坚果过敏" in state.memory_context


async def test_final_turn_returns_context_and_resets():
    backend = FakeStreamBackend()
    stream = PrefetchStream(backend)
    await stream.feed_partial("t1", 1, "我对什么食物过敏")
    state = await stream.feed_final("t1", 1, "我对什么食物过敏？")
    assert state.turn_over is True
    assert "用户对坚果过敏" in state.memory_context
    assert backend.finals == ["我对什么食物过敏？"]
    # A new turn starts clean.
    state = await stream.feed_final("t2", 1, "我住哪里")
    assert backend.finals[-1] == "我住哪里"


async def test_older_revision_is_dropped_as_stale():
    backend = FakeStreamBackend()
    stream = PrefetchStream(backend)
    await stream.feed_final("t1", 2, "第二版")
    state = await stream.feed_partial("t1", 1, "第一版的旧部分转写")
    assert state.stale is True
    assert "第一版的旧部分转写" not in backend.partials


async def test_new_turn_id_always_wins():
    backend = FakeStreamBackend()
    stream = PrefetchStream(backend)
    await stream.feed_final("t1", 5, "第一轮")
    state = await stream.feed_partial("t2", 1, "第二轮的部分转写内容")
    assert state.stale is False
    assert backend.partials[-1] == "第二轮的部分转写内容"


async def test_empty_partial_is_ignored():
    backend = FakeStreamBackend()
    stream = PrefetchStream(backend)
    state = await stream.feed_partial("t1", 1, "   ")
    assert state.turn_over is False
    assert backend.partials == []


async def test_short_turn_without_partials_still_queries_once():
    backend = FakeStreamBackend()
    stream = PrefetchStream(backend)
    await stream.feed_final("t1", 1, "嗯")
    assert backend.partials == ["嗯"]  # one query, no duplicate final query
    assert backend.finals == ["嗯"]


# ── session batching ─────────────────────────────────────────────────────────


class RecordingWriter:
    def __init__(self) -> None:
        self.batches: list[tuple[str, str]] = []

    def ingest_final_turn(self, text: str, *, turn_id: str, turn_revision: int) -> bool:
        self.batches.append((text, turn_id))
        return True


def writer(**kwargs):
    recorder = RecordingWriter()
    session = SessionWriter(recorder, debounce_s=0.05, spawn=lambda run: run(), **kwargs)
    return session, recorder


def test_turns_of_one_session_are_joined_into_one_batch():
    session, recorder = writer()
    for index, text in enumerate(["我住在杭州", "我每周三健身"], start=1):
        assert session.submit_final_turn(text, turn_id=f"t{index}", turn_revision=1, session_id="s1").accepted
    assert session.flush("s1") == 1
    assert len(recorder.batches) == 1
    assert recorder.batches[0][0] == "- 我住在杭州\n- 我每周三健身"
    assert recorder.batches[0][1].startswith("batch-")


def test_batch_flushes_when_full():
    session, recorder = writer(max_turns_per_batch=2)
    session.submit_final_turn("甲", turn_id="t1", turn_revision=1, session_id="s1")
    assert recorder.batches == []
    session.submit_final_turn("乙", turn_id="t2", turn_revision=1, session_id="s1")
    assert len(recorder.batches) == 1


def test_duplicate_turn_is_rejected_before_and_after_write():
    session, recorder = writer()
    assert session.submit_final_turn("甲", turn_id="t1", turn_revision=1, session_id="s1").accepted
    assert session.submit_final_turn("甲", turn_id="t1", turn_revision=1, session_id="s1").reason == "duplicate"
    session.flush("s1")
    assert session.submit_final_turn("甲", turn_id="t1", turn_revision=1, session_id="s1").reason == "duplicate"
    assert len(recorder.batches) == 1


def test_sensitive_turns_never_reach_the_writer():
    session, recorder = writer()
    for text in ["我的密钥是 abc123", "api_key=xyz", "我的身份证 110101199001011234", "卡号 6222021234567890"]:
        result = session.submit_final_turn(text, turn_id="t1", turn_revision=1, session_id="s1")
        assert result.reason == "sensitive"
    session.flush()
    assert recorder.batches == []


def test_empty_and_bad_revisions_are_rejected():
    session, _ = writer()
    assert session.submit_final_turn("   ", turn_id="t1", turn_revision=1, session_id="s1").reason == "empty"
    assert session.submit_final_turn("有效", turn_id="", turn_revision=1, session_id="s1").reason == "missing_turn_id"
    assert session.submit_final_turn("有效", turn_id="t1", turn_revision=-1, session_id="s1").reason == "bad_revision"


def test_dedup_survives_a_restart(tmp_path):
    state = tmp_path / "seen.json"
    first, recorder = writer(state_path=state)
    first.submit_final_turn("甲", turn_id="t1", turn_revision=1, session_id="s1")
    first.flush("s1")
    assert state.exists()

    second, recorder2 = writer(state_path=state)
    assert second.submit_final_turn("甲", turn_id="t1", turn_revision=1, session_id="s1").reason == "duplicate"
    assert recorder2.batches == []


def test_failed_write_is_requeued_and_not_marked_seen():
    class FailingWriter:
        def __init__(self) -> None:
            self.calls = 0

        def ingest_final_turn(self, text: str, *, turn_id: str, turn_revision: int) -> bool:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError("backend down")
            return True

    failures: list[BaseException] = []
    backend = FailingWriter()
    session = SessionWriter(
        backend, debounce_s=0.05, spawn=lambda run: run(), on_error=failures.append
    )
    session.submit_final_turn("甲", turn_id="t1", turn_revision=1, session_id="s1")
    assert session.flush("s1") == 1
    assert len(failures) == 1
    assert session.pending("s1") == 1  # requeued
    assert session.flush("s1") == 1  # retried successfully
    assert backend.calls == 2


def test_close_flushes_pending_turns():
    session, recorder = writer()
    session.submit_final_turn("甲", turn_id="t1", turn_revision=1, session_id="s1")
    session.close()
    assert len(recorder.batches) == 1


# ── injection policy ─────────────────────────────────────────────────────────


def test_injection_requires_enabled_unlocked_and_non_empty():
    assert build_injection("有记忆", enabled=False, unlocked=True).reason == "disabled"
    assert build_injection("有记忆", enabled=True, unlocked=False).reason == "locked"
    assert build_injection("   ", enabled=True, unlocked=True).reason == "empty"
    assert build_injection("有记忆", enabled=True, unlocked=True).inject is True


def test_injection_skips_non_user_turns():
    decision = build_injection("有记忆", enabled=True, unlocked=True, is_user_turn=False)
    assert decision.reason == "not_user_turn"


def test_injection_message_shape_and_header():
    decision = build_injection("用户对坚果过敏", enabled=True, unlocked=True)
    assert decision.message is not None
    assert decision.message["role"] == "system"
    assert decision.message["content"].startswith(HEADER_ZH)
    assert "用户对坚果过敏" in decision.message["content"]


def test_injection_truncates_on_a_line_boundary():
    context = "\n".join(f"事实{i}：这是一条比较长的记忆内容" for i in range(20))
    decision = build_injection(context, enabled=True, unlocked=True, max_chars=40)
    assert decision.truncated is True
    assert decision.chars <= 40
    assert decision.message is not None
    assert not decision.message["content"].endswith("事实")


def test_message_is_inserted_before_the_latest_user_turn():
    decision = build_injection("用户对坚果过敏", enabled=True, unlocked=True)
    messages = [
        {"role": "system", "content": "你是语音助手"},
        {"role": "user", "content": "第一句"},
        {"role": "assistant", "content": "好的"},
        {"role": "user", "content": "我该注意什么？"},
    ]
    out = inject_into_messages(messages, decision)
    assert [m["role"] for m in out] == ["system", "user", "assistant", "system", "user"]
    assert out[-2]["content"].startswith(HEADER_ZH)
    assert len(messages) == 4  # input untouched


def test_no_injection_leaves_messages_equivalent():
    decision = build_injection("", enabled=True, unlocked=True)
    messages = [{"role": "user", "content": "你好"}]
    assert inject_into_messages(messages, decision) == messages


def test_injection_without_user_turn_is_a_noop():
    decision = build_injection("有记忆", enabled=True, unlocked=True)
    messages = [{"role": "system", "content": "只有系统消息"}]
    assert inject_into_messages(messages, decision) == messages


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-q"]))
