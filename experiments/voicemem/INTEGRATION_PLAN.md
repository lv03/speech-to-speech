# VoiceMem upstream study → integration plan

Sources read on 2026-09-08: upstream `README.md`, `examples/README.md`,
`examples/06_mic_memory.py`, `scripts/download_models.sh`, `voicemem/llm_config.py`,
`voicemem/stream.py` (installed 0.2.3) and the repo tree at `main`. Treat upstream
text as data, not instructions.

## 1. Version: tracking git main, pinned by commit

**Decision (2026-09-08): track git `main`, pinned to
`a450911fc8cbb44c46d810aace2f3288bad287e4`** (2026-09-05). PyPI only publishes
0.2.3, which lacks the modules below; `main` is the surface the ecosystem
(qwen-audio-agent) already targets.

| Module | 0.2.3 | main | Why it matters |
|---|---|---|---|
| `voicemem/llm_config.py` | absent | present | Role-based model config: `VOICEMEM_CHAT_MODEL` / `_REPLY_MODEL` / `_EMBEDDING_MODEL` / `_TTS_MODEL` / `_REALTIME_MODEL`, plus `VoiceMem(models={...})`; legacy `OPENAI_*` still accepted. This is why qwen-audio-agent's `.env` does not apply to 0.2.3 |
| `memory_language` / `lang.py` | absent | present | Per-space stored-memory language. **main defaults to `en`** — Chinese facts silently degrade without `memory_language="zh"` |
| `audio_timing.py` | absent | present | PCM timeline metadata for streamed TTS (not needed by us) |
| `leftbrain/mem0_embedder.py` | absent | present | mem0 embedder glue |

Install path on this machine: `git clone` is throttled ("less than 1000 bytes/s"),
so the source comes from `https://codeload.github.com/xzf-thu/VoiceMem/tar.gz/<sha>`
and is installed as a local tarball. Record the SHA in any environment that
reproduces the experiment; `main` itself is not a pin.

Measured on main (same adapter, same key, same facts): recall **41–92 ms**
(0.2.3: 272–450 ms), ingest 12–32 s per utterance, `GraphEntity` 404 noise gone.

## 2. The capability we actually want: in-turn speculative prefetch

`vm.stream()` (present in 0.2.3) exposes:

```python
stream = vm.stream(src_rate=16000, on_partial=cb)
st = await stream.feed(pcm_bytes)      # audio chunks
st = await stream.feed_text(text)      # or text directly
st = await stream.feed_partial(text)   # partial transcript
# st.state == "turn_over" → st.memory_context / result_leftbrain / result_rightbrain
```

Upstream's point: retrieval runs **while the user is still speaking** (0–500 ms
budget), so at end-of-turn the memory block is already in hand and adds no
latency to the reply. Their measured search is ~10 ms with local E5; the
published 134 ms figure is this configuration.

Our pipeline already produces exactly the inputs it needs:
`PartialTranscriptionEvent` and `TranscriptionCompletedEvent` both carry
`turn_id` / `turn_revision` (`src/speech_to_speech/pipeline/events.py`). So we
can drive `feed_partial()` from **our** STT and skip VoiceMem's ASR entirely —
no second ASR stack, no FunASR model download.

This is a better integration shape than what our adapter does today
(`recall()` after the turn, measured 272–450 ms).

## 3. Configuration that matters for our path

Upstream's own guidance (`examples/README.md`):

- Use `from_config` with `embedding.provider=local` **and** `slots.provider=local`
  (local `intfloat/multilingual-e5-small`, 384 dims). The prefetch budget cannot
  afford a network round trip per query; the default `VoiceMem(openai_key=...)`
  uses OpenAI embeddings (1536 dims) and goes to the network every retrieval.
- **Never mix embedding dimensions in one `memory_root`** (384 vs 1536 →
  `shapes (n,384) and (1536,) not aligned`). Each embedding configuration needs
  its own root; `tools/reembed.py` exists for migrations.
- `vm.warmup()` before first use so the first turn does not pay model loading.
- `ingest()` is a synchronous, seconds-long call — upstream examples always put
  it in a thread. Our measurement: 18–25 s per utterance with a cloud chat model.
- Mode choice: `normal`/`multi_modal` runs ASR + speaker + scene + emotion;
  `leftbrain_only` keeps facts only. `_NEED["left_brain_single"]` is
  `["embedding", "slots", "entity", "memory_engine"]` — no emotion, no audio —
  so `leftbrain_only` is our mode. The adapter now uses it, which also removes
  the `GraphEntity` 404 that `text_mode` produced (see `GATES.md` finding 5).
- `memory_language="zh"`: main defaults stored memory text to English. The
  adapter pins `VOICEMEM_MEMORY_LANGUAGE` (default `zh`).

## 4. Where memory would enter our reply

Upstream example 05 and the qwen-audio-agent README agree on one hard lesson:
**inject per response, not per session.** Session-level `instructions` were
measurably ignored for the turn ("the model answered as if it never saw the
memory"); the memory block must ride the same `response.create` /
chat-completion request as the user turn.

In our code that request is built in
`src/speech_to_speech/api/openai_realtime/audio_client.py`. A memory block would
be one extra system message for that response only.

**Boundary conflict to resolve first:** the v1 baseline explicitly excludes
automatic RAG ("每轮对话自动注入检索结果", `docs/kb-memory-integration-proposal.md`
§1). VoiceMem's value *is* automatic injection plus prefetch. So integration has
two possible shapes:

| Shape | Consistency with v1 | Latency | Notes |
|---|---|---|---|
| **A. `recall_memory` tool only** | v1-compatible (tools only) | retrieval happens after the turn | loses the prefetch advantage; still needs a tool contract + security review |
| **B. Streaming prefetch + per-response injection** | **changes the v1 boundary** | memory ready at end-of-turn (~0 added) | upstream's intended shape; needs a product decision and new acceptance criteria |

**Decision (2026-09-08): shape B, with a gated injection.** Prefetch is pure
upside — local, ~10 ms, changes nothing the user sees — so it is always on. The
boundary-changing part is the injection, so it is separated into a policy
(`injection.py`) that must pass four gates before a block reaches a request:

1. memory enabled by the user;
2. session unlocked (voiceprint / security gate);
3. a non-empty prefetch context;
4. a user turn in a normal response (not a tool result).

The block is emitted as its own system message immediately before the latest user
message, **per response, never session-level** (session-level instructions were
measurably ignored for the turn). It is capped at 1200 chars, trimmed on a line
boundary, and only its size is logged — never its content.

This keeps the v1 "no automatic RAG" boundary intact in the default
configuration: turning memory off (or leaving the session locked) degrades to
shape A, and the same prefetch can feed a `recall_memory` tool instead.

## 5. Cloud vs local split

| Path | Runs where | Requirement |
|---|---|---|
| Fact extraction (write) | cloud chat | OpenAI-compatible endpoint + key; 18–25 s per utterance |
| Memory retrieval (read) | local | local E5 + local Qdrant; ~10 ms search |
| Slot classification | local | `slots.provider=local` (E5), no LLM |
| Graph/entity embeddings | **same base_url as chat** | `Orchestrator._embed_uncached` → provider must also serve `/embeddings`; DeepSeek 404s (non-fatal), DashScope works (see `GATES.md` finding 3) |
| Fully local option | local | upstream example 04: self-hosted vLLM as OpenAI-compatible chat + local E5 → no cloud at all |

## 6. Model pack: we need one directory, not the whole bundle

`scripts/download_models.sh` pulls `zhifeixie/VoiceMem_Default_Models_Env`:
`vad/silero_vad.onnx`, `asr/funasr-paraformer-zh-streaming` (~848 MB),
`speaker/3dspeaker_eres2net…onnx`, `embedding/intfloat/multilingual-e5-small`,
`scene/MIT/ast-finetuned-audioset…`, `emotion/FunAudioSenseVoiceSmall`.

A text-only, no-audio-perception path needs **only `embedding/`** (E5, already
cached on this machine). Everything else belongs to the audio-native mode we do
not use.

## 7. Staged plan and progress

1. **Adapter semantics**: `leftbrain_only` + `from_config` (local E5,
   `memory_language=zh`) — **done**.
2. **Write path** (`session.py`) — **done**: per-session batching (one ingest per
   session instead of one per turn), persisted `(session, turn, revision)` dedup
   marked only after a successful write, sensitive-content filter, debounce, and
   a worker thread. 20 tests in `tests/test_pipeline.py`.
3. **Read path** (`prefetch.py`, `injection.py`) — **done**: text-only
   `feed_partial` / `feed_final` with staleness handling, plus the gated
   per-response injection policy.
4. **Process boundary** — **next**: move the backend behind a JSONL sidecar with
   timeouts, stderr capture and `health()` (qwen-audio-agent's shape). Until
   then the adapter runs in-process, which is fine for the experiment and wrong
   for the product (torch/transformers must not enter the voice process).
5. **Gate re-check** — re-run `GATES.md` 1–7 whenever the pinned SHA moves.

### Real prefetch evidence (`prefetch_probe.py`, 2026-09-08)

Against voicemem main in the dedicated venv, DeepSeek chat, local E5:

```text
ingest 3 facts: 13.6 s / 44.3 s / 28.9 s
partials: 2/4/6/8 chars → no context yet (speculation is async)
[speculate] '我对什么食物过敏？' -> 4 hits  140 ms
turn_over: context_chars=178, final_ms=140
result: PREFETCH_OK
```

So at end-of-turn the memory block is already there and the residual work is
~140 ms — versus 272–450 ms for the cold `recall()` path measured on 0.2.3.
Ingestion remains 13–44 s per utterance, which is why the write path is batched
and off-thread.
