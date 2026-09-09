"""Tests for the per-turn memory bridge (fake provider, no sidecar process)."""

from __future__ import annotations

from speech_to_speech.memory.bridge import MemoryBridge


class FakeProvider:
    def __init__(self, *, enabled=True, unlocked=True, context="") -> None:
        self._enabled = enabled
        self._unlocked = unlocked
        self._context = context
        self.partials: list[tuple[str, str]] = []
        self.finals: list[tuple[str, str]] = []
        self.observed: list[tuple[str, list[dict]]] = []
        self.flushes = 0
        self.closed = False

    @property
    def enabled(self):
        return self._enabled

    def set_unlocked(self, unlocked):
        self._unlocked = bool(unlocked)

    def prefetch_partial(self, *, session_id, turn_id, revision, text):
        self.partials.append((turn_id, text))
        return ""

    def prefetch_final(self, *, session_id, turn_id, revision, text):
        if not self._unlocked:
            return ""
        self.finals.append((turn_id, text))
        return self._context

    def observe(self, *, session_id, turns):
        if not self._unlocked:
            return {"accepted": [], "rejected": [], "pendingTurns": 0}
        self.observed.append((session_id, list(turns)))
        return {"accepted": [t["turn_id"] for t in turns], "rejected": [], "pendingTurns": len(turns)}

    def flush(self, *, session_id=None):
        self.flushes += 1
        return 0

    def close(self):
        self.closed = True

    def build_injection(self, context, *, is_user_turn=True):
        from speech_to_speech.memory.injection import build_injection

        return build_injection(context, enabled=self._enabled, unlocked=self._unlocked, is_user_turn=is_user_turn)


async def test_partial_warms_retrieval_without_injecting():
    provider = FakeProvider(context="用户对坚果过敏")
    bridge = MemoryBridge(provider)
    await bridge.on_partial(item_id="i1", text="我对什么")
    assert provider.partials == [("i1", "我对什么")]
    assert bridge.take_context("i1") == ""


async def test_final_returns_injection_and_queues_one_write():
    provider = FakeProvider(context="用户对坚果过敏")
    bridge = MemoryBridge(provider)
    decision = await bridge.on_final(item_id="i1", text="我对什么食物过敏？")
    assert decision.inject is True
    assert decision.message is not None and "用户对坚果过敏" in decision.message["content"]
    assert provider.finals == [("i1", "我对什么食物过敏？")]
    assert len(provider.observed) == 1
    assert bridge.take_context("i1") == "用户对坚果过敏"


async def test_same_item_is_observed_once():
    provider = FakeProvider(context="记忆")
    bridge = MemoryBridge(provider)
    await bridge.on_final(item_id="i1", text="第一版")
    await bridge.on_final(item_id="i1", text="最终版")
    assert len(provider.observed) == 1


async def test_locked_provider_produces_no_injection_and_no_writes():
    provider = FakeProvider(context="记忆", unlocked=False)
    bridge = MemoryBridge(provider)
    decision = await bridge.on_final(item_id="i1", text="我对什么食物过敏")
    assert decision.inject is False
    assert decision.reason == "locked"
    assert provider.observed == []


async def test_lock_changed_mirrors_into_provider():
    provider = FakeProvider(context="记忆", unlocked=False)
    bridge = MemoryBridge(provider)
    bridge.on_lock_changed(False)
    decision = await bridge.on_final(item_id="i1", text="我对什么食物过敏")
    assert decision.inject is True
    bridge.on_lock_changed(True)
    assert (await bridge.on_final(item_id="i2", text="我住哪里")).inject is False


async def test_disabled_provider_is_inert():
    provider = FakeProvider(enabled=False)
    bridge = MemoryBridge(provider)
    assert bridge.enabled is False
    assert (await bridge.on_final(item_id="i1", text="我住哪里")).reason == "disabled"
    await bridge.on_partial(item_id="i1", text="我住")
    assert provider.partials == [] and provider.observed == []


async def test_empty_text_is_ignored():
    provider = FakeProvider(context="记忆")
    bridge = MemoryBridge(provider)
    assert (await bridge.on_final(item_id="i1", text="   ")).inject is False
    await bridge.on_partial(item_id="i1", text="")
    assert provider.finals == [] and provider.partials == []


async def test_close_flushes_and_closes():
    provider = FakeProvider(context="记忆")
    bridge = MemoryBridge(provider)
    await bridge.close()
    assert provider.flushes == 1 and provider.closed is True
