"""Optional long-term memory backend behind a process boundary.

VoiceMem is never imported into the voice process: it drags torch, transformers,
funasr and mem0, and mem0's local Qdrant store allows one process per memory
root. `MemoryProvider` talks to a JSONL sidecar instead (see
`experiments/voicemem/sidecar.py` for the reference implementation and
`docs/kb-memory-integration-proposal.md` §10 for the product gates).

Disabled by default: nothing constructs a provider unless
``--memory-backend voicemem`` is requested and the sidecar paths are configured.
"""

from .config import MemoryConfig
from .factory import build_memory_provider
from .injection import InjectionDecision, build_injection, inject_into_messages
from .provider import MemoryProvider, MemoryProviderError
from .sidecar_client import SidecarClient, SidecarError, SidecarTimeout

__all__ = [
    "InjectionDecision",
    "MemoryConfig",
    "MemoryProvider",
    "MemoryProviderError",
    "SidecarClient",
    "SidecarError",
    "SidecarTimeout",
    "build_injection",
    "build_memory_provider",
    "inject_into_messages",
]
