"""Per-turn memory bridge between the realtime event stream and the provider.

The audio client feeds transcription events here and gets back the instructions
to attach to the response it is about to create. All provider calls are offloaded
to a thread because the sidecar speaks stdio; the event loop must never block.

Turn identity comes from the Realtime item id (stable across deltas of the same
utterance) with revision 0. Our own pipeline's `turn_id`/`turn_revision` map onto
the same shape when the local pipeline drives this.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass, field

from .injection import InjectionDecision
from .provider import MemoryProvider

logger = logging.getLogger(__name__)


@dataclass
class MemoryBridge:
    """Tracks one connection's memory state."""

    provider: MemoryProvider
    session_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    _contexts: dict[str, str] = field(default_factory=dict)
    _observed: set[str] = field(default_factory=set)

    @property
    def enabled(self) -> bool:
        return self.provider.enabled

    def on_lock_changed(self, locked: bool) -> None:
        """Mirror the security gate; locked means no reads and no writes."""
        self.provider.set_unlocked(not locked)

    async def on_partial(self, *, item_id: str, text: str) -> None:
        """Warm the retrieval while the user is still speaking."""
        if not (self.enabled and item_id and text.strip()):
            return
        await asyncio.to_thread(
            self.provider.prefetch_partial,
            session_id=self.session_id,
            turn_id=item_id,
            revision=0,
            text=text,
        )

    async def on_final(self, *, item_id: str, text: str) -> InjectionDecision:
        """Resolve the memory block for this turn and queue the write."""
        if not (self.enabled and item_id and text.strip()):
            return InjectionDecision(False, "disabled")
        context = await asyncio.to_thread(
            self.provider.prefetch_final,
            session_id=self.session_id,
            turn_id=item_id,
            revision=0,
            text=text,
        )
        if context:
            self._contexts[item_id] = context
        if item_id not in self._observed:
            self._observed.add(item_id)
            await asyncio.to_thread(
                self.provider.observe,
                session_id=self.session_id,
                turns=[{"turn_id": item_id, "turn_revision": 0, "text": text}],
            )
        return self.provider.build_injection(context)

    def take_context(self, item_id: str) -> str:
        """Read and clear the block stored for an item (used by tests and tools)."""
        return self._contexts.pop(item_id, "")

    async def close(self) -> None:
        await asyncio.to_thread(self.provider.flush, session_id=self.session_id)
        await asyncio.to_thread(self.provider.close)


__all__ = ["MemoryBridge"]
