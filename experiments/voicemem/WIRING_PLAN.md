# Product wiring plan (executable)

Status 2026-09-08. The experiment loop is complete and the product-side provider
exists but is **not wired**: nothing constructs it yet. This file is the
step-by-step wiring plan, ordered so each step is independently testable and the
default behaviour stays unchanged until the last step flips a flag.

Decision recap (`INTEGRATION_PLAN.md` §4): shape B — prefetch during the turn,
inject per response — with the four-gate policy in
`src/speech_to_speech/memory/injection.py`.

## What already exists

| Piece | Where | State |
|---|---|---|
| Adapter (three interfaces, fail-closed) | `experiments/voicemem/adapter.py` | done, tested |
| Batched writes, persisted dedup, sensitive filter | `experiments/voicemem/session.py` | done, tested |
| Text-only prefetch | `experiments/voicemem/prefetch.py` | done, measured 140 ms |
| Injection policy | `experiments/voicemem/injection.py` + product copy | done, tested |
| Sidecar (JSONL, own lock state) | `experiments/voicemem/sidecar.py` | done, real E2E |
| Sidecar client (product) | `src/speech_to_speech/memory/sidecar_client.py` | done, tested |
| Provider (fail-closed, disabled by default) | `src/speech_to_speech/memory/provider.py` | done, tested |
| Bridge (per-turn state, async offload) | `src/speech_to_speech/memory/bridge.py` | done, tested |
| CLI flags + provider construction | `src/speech_to_speech/cli.py` | done, tested (talk path) |
| Voice-loop event mapping + per-response injection | `audio_client.py` | done, tested |
| Local-pipeline gate mirroring | `s2s_pipeline.py`, `memory/factory.py` | done, tested |
| Desktop settings, IPC, lifecycle | — | **next** |

## Step 1 — CLI and config plumbing (done for `talk`)

Implemented: `--memory-backend {off,voicemem}`, `--memory-sidecar-python`,
`--memory-sidecar-script`, `--memory-root`, `--memory-max-chars`, all defaulting
off. `talk` has no wake-word gate, so its explicit CLI opt-in is the permission
and the provider starts unlocked; callers that own a gate must leave it locked
and unlock from the gate callback (`_build_memory_provider(..., unlocked=False)`).

Original scope:

Files: `src/speech_to_speech/cli.py`,
`src/speech_to_speech/arguments_classes/local_audio_arguments.py`,
`src/speech_to_speech/api/openai_realtime/runtime_config.py`.

Flags (all default off, so v1 behaviour is unchanged):

```text
--memory_backend {off,voicemem}      # default off
--memory_sidecar_script PATH         # experiments/voicemem/sidecar.py in dev
--memory_sidecar_python PATH         # interpreter that has voicemem installed
--memory_root PATH                   # app-private directory
--memory_max_chars 1200
```

Tests: `tests/test_cli_defaults.py` (defaults are off; enabling without paths
fails fast with `MemoryConfigError`), `tests/openai_realtime/test_pipeline_builder.py`
(the client receives a provider only when enabled).

## Step 2 — Voice-loop event mapping (done)

Implemented in `audio_client.py` via `_MemoryTurnHandler`: transcription deltas
warm `prefetch_partial`, completion resolves `prefetch_final` + queues one
`observe`, and the handler closes the bridge on session end. `RealtimeAudioClientConfig`
gained `memory_provider`, and `MemoryBridge` offloads every provider call with
`asyncio.to_thread`. Six tests cover injection, locked, disabled, active-response
and empty-text paths.

Gate mirroring is done: `build_local_pipeline` finds the handler exposing
`set_state_change_callback`, mirrors `is_locked` into `provider.set_unlocked(...)`
alongside the existing stdout emitter, and unlocks immediately only when no gate
exists (explicit CLI opt-in). Three pipeline-builder tests cover the locked,
unlock-on-gate and no-gate paths.

Original scope:

File: `src/speech_to_speech/api/openai_realtime/audio_client.py`.

- On `conversation.item.input_audio_transcription.delta` → `prefetch_partial`.
- On `conversation.item.input_audio_transcription.completed` → `prefetch_final`,
  keep the returned context for the next response, then `observe` the final turn.
- On session close → `flush` + `close`.
- Mirror the security gate: when the wake-word gate locks/unlocks, call
  `provider.set_unlocked(...)`. The gate already emits `security.locked` /
  `security.unlocked` events.

Tests: unit tests with a fake provider recording calls; no sidecar process.

## Step 3 — Per-response injection (done)

Implemented: when the provider is enabled, `build_session_update` sets
`turn_detection.create_response = false` and the handler creates every response
locally, attaching `response.instructions = <memory block>` only when the
four-gate policy injects. Server VAD still handles barge-in
(`interrupt_response: true`), and a create is skipped with a warning while
another response is active. Default (memory off) is byte-identical to before.

Original scope:

File: `audio_client.py` (`_ToolCallCoordinator` and the response path).

Upstream's hard lesson: memory must ride the **per-response** request. The
realtime session therefore needs to create the response itself
(`turn_detection.create_response = false`) so it can attach
`instructions=<memory block>` to `response.create`; server VAD stays on only for
barge-in (`interrupt_response = true`), exactly as voicemem example 05 and
qwen-audio-agent do. This is the one behaviour change in the voice loop and the
reason this step is last.

Tests: assert the injected `response.create` carries the memory block, that a
locked/disabled provider produces no injection, and that tool follow-up
responses are unaffected.

## Step 4 — Desktop settings, IPC and lifecycle

Files: `desktop/src/main/index.ts`, `desktop/src/main/voice-process.ts`,
`desktop/src/preload/index.ts`, `desktop/src/renderer/settings.html/.ts`.

- Settings: enable memory, cloud-extraction consent (with the plain-language
  notice that utterance text leaves the machine), memory directory display.
- Main process: validate the sidecar paths, pass them to the voice child through
  env only (never argv, so no path leaks into logs), surface sidecar `health()`
  in the knowledge tab, and stop the sidecar on `will-quit`.
- The voice child owns `set_permission` (it owns the security gate), so the
  desktop only needs to pass the unlock state at startup.

Tests: `desktop/tests/voice-process-tools.test.mjs` (env passthrough, no argv
leak), `desktop/tests/knowledge-ipc.test.mjs` (settings round-trip).

## Step 5 — Promotion and gates

- Move `experiments/voicemem/` to a packaged location and add it to the license
  report (≈25 new dependencies).
- Re-run `GATES.md` 1–7 against the pinned SHA; the release gates in
  `docs/kb-memory-integration-proposal.md` §10 still apply before any packaged
  build ships with memory enabled.
- Model provisioning: the sidecar needs its own venv (~1.3 GB) plus the E5 model
  (and, for audio mode, several GB more). The desktop must download it only
  after explicit consent, or the feature ships off.

## Product-side end-to-end evidence (2026-09-08)

`cli._build_memory_provider(...)` pointed at the real voicemem venv:

```text
enabled: True unlocked: True
flush batches: 1 ms: 36257          # one batched extraction
recall context chars: 116 has_fact: True
inject: True reason: injected message_role: system
health: {'ok': True, 'backend': 'real', 'unlocked': True, 'pendingTurns': 0}
result: PRODUCT_WIRING_OK
```

This run also caught a real bug: the sidecar called `feed_text()` on the
adapter's turn-aware `PrefetchStream` (which exposes `feed_final`), so prefetch
failed with an `AttributeError` that the provider correctly degraded to an empty
context. The sidecar now normalises both stream shapes.

## Open product questions

1. Should injected memory be visible to the user (e.g. a "remembered" badge), or
   stay silent like a system prompt?
2. Is cloud fact extraction acceptable at all, or must this wait for a local
   extraction path (self-hosted vLLM, as voicemem example 04 does)?
3. Should `recall_memory` also be exposed as an explicit tool for auditing,
   alongside the automatic injection?
