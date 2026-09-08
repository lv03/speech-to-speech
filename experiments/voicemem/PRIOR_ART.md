# Prior art: how qwen-audio-agent integrates VoiceMem

Reference: `examples/voicemem/` in
[QwenAudio/qwen-audio-agent](https://github.com/QwenAudio/qwen-audio-agent)
(`README_ZH.md`, `sidecar/server.py`, `server/src/conversation/memory/providers/voicemem/provider.mjs`),
read on 2026-09-08.

## 1. Their shape

```text
Gateway (Node)                      sidecar (Python, long-lived)        VoiceMem
  VoiceMemProvider  ── JSONL/stdio ──> server.py  ── public API ──>  VoiceMem per owner
    recall / observe / flush / close     recall / observe / flush / close
    profiles/<owner-hash>.json           memory-spaces/<owner-hash>/
    observed-messages.json               (SQLite + local Qdrant)
    audio-staging/*.wav  (audio mode)
```

The Python side is a **separate process behind a versioned `MemoryProvider`
interface**, so voicemem and its 112 packages never enter the npm package. That
is the same boundary our plan calls "独立进程" (gate 1), taken one step further
than our current in-process adapter.

## 2. Decisions worth copying

| Decision | Why it matters to us |
|---|---|
| **Session-level batching in text mode**: the whole session's user turns are joined (`- turn`) and ingested as **one** observation unit | Our per-turn ingest measured 18–25 s per utterance. One session = one extraction call, and later turns in the session can correct earlier ones |
| **Persisted, bounded dedup** (`observed-messages.json`, sha256 of `owner\0id-or-content`, last 20 000, tmp+rename) | Our `_seen` dict is in-memory, so a process restart re-ingests everything |
| **Sensitive-content filter** before ingest (`SENSITIVE` regex: api keys/secrets/tokens/passwords, 密码/密钥/验证码/证件号/病史/病历/诊断/用药, 11–19 digit numbers) | We have no such filter; memory is exactly where a leaked key would persist |
| **Synchronous preference snapshot** (`profiles/<hash>.json`, `# USER` / `# MEMORY` markdown) with exact-match edits (`old_text` must occur exactly once, else `ambiguous_edit`/`edit_not_found`), atomic tmp+rename, cached | Solves gate 6's missing single-item edit/delete **without** upstream API changes, and keeps `list()` synchronous |
| **Hybrid retrieval result**: `query()` returns both the snapshot documents and VoiceMem's semantic context | Deterministic "known preferences" plus fuzzy recall, without depending on the model |
| **Never queue interactive recall behind consolidation**: a per-owner background counter makes `query()` return the snapshot with empty context while a session consolidation is running | Their comment: "VoiceMem's local Qdrant store permits one process per memory root". Avoids a 2-minute stall on a tool call |
| **Owner isolation by sha256 hash** for directory and file names; no raw owner id on disk | Cheap privacy win we do not have |
| **Bounded `clean()` truncation** (240/2000/4000/8000 chars per field) and single-learning-path rule (framework extractor disabled once VoiceMem owns observation) | Prevents unbounded prompt/storage growth and double-learning |
| **Sidecar failure contract**: stderr tail (500 chars), pending-request rejection on exit, per-method timeouts (interactive 30 s, background 120 s), `health()` exposing `lastError` | We have none of this; our adapter raises straight into the caller |
| **Audio mode is opt-in and reuses `turn_id`** with 1 s pre-roll, 45 s/turn and 24 MB/session caps, temp WAV `0600`, deleted after processing, `turn_invalid` discarded | Not needed by us (we reuse our own STT), but the caps and deletion discipline are the right pattern if we ever do it |

## 3. Where their config does not apply to voicemem 0.2.3

Their recommended `.env` sets variables that **do not exist in the only
installable PyPI release**:

| Their variable | In voicemem 0.2.3 (PyPI max) | Equivalent |
|---|---|---|
| `VOICEMEM_CHAT_MODEL` | absent | `OPENAI_MODEL` |
| `VOICEMEM_EMBEDDING_MODEL` | absent | `OPENAI_EMBEDDING_MODEL` |
| `VOICEMEM_MEMORY_LANGUAGE` | absent | — (no equivalent) |
| `VOICEMEM_EMBED_DIM` | present | same |
| `VOICEMEM_ASR`, `VOICEMEM_SPEAKER_MODEL` | present | same |
| `VOICEMEM_INPUT_MODE` | absent (their own connector variable) | — |

`uv` confirms `voicemem<=0.2.3` is all PyPI has, so their example either tracks
voicemem's GitHub main or is written against a release we cannot install today.
Copying their `.env` verbatim on 0.2.3 would silently leave the chat/embedding
model at the defaults.

## 4. Their answer to our gate-5 `404`

They recommend **DashScope**, whose OpenAI-compatible endpoint serves **both**
chat (`qwen3.8-flash`) and embeddings (`text-embedding-v4`, dim 1024) at one
`base_url`. That is exactly what fixes our finding 3: voicemem's
`Orchestrator._embed_uncached` sends embeddings to the chat base_url, so the
provider must serve both routes. On DeepSeek (chat only) the left-brain graph
link 404s; on DashScope it works.

Note the divergence: they let **all** embeddings go to the cloud (their default
has no `embedding.provider=local`), whereas our adapter pins embeddings to local
E5. With a chat-only provider our local-E5 choice still leaves the orchestrator
graph path broken, so the options are:

1. point `base_url` at a provider that serves chat **and** embeddings (their way),
2. keep DeepSeek chat + accept the non-fatal graph degradation (today),
3. patch/fork `_embed_uncached` to use the injected local embedder (the fork the
   plan already anticipates in §10).

## 5. Divergences we should keep

| Their choice | Ours | Why keep ours |
|---|---|---|
| `mode="text"` with emotion layer left on (text_mode enables it) | `enable_emotion=False` forced | v1 explicitly excludes the emotion graph |
| Audio mode with VoiceMem's own ASR | text-only, our STT | avoids a second ASR stack and model downloads |
| Voiceprint off because their speaker model is not shipped | our own voiceprint gate controls access | we already have a security gate with `is_locked` |
| Cloud embeddings for everything | local E5 for memory vectors | privacy and cost; revisit per option 1–3 above |

## 6. Prioritized adoptions for this experiment

| Priority | Item | Gate affected |
|---|---|---|
| P0 | Persist the dedup set with atomic write (restart-safe) | 3 |
| P0 | Session-level batching instead of per-turn ingest | 5 (latency) |
| P0 | Sensitive-content filter before ingest | 7 (privacy) |
| P1 | Snapshot + exact-edit API for single-item correction/deletion | 6 |
| P1 | Background-consolidation counter so recall never queues behind it | 5 |
| P1 | Owner-hash isolation and bounded field truncation | 6 |
| P2 | Move the backend into a JSONL sidecar process with timeouts, stderr capture and `health()` | 1, 2 |
| P2 | Provider-style versioned interface (`describe()`/`health()`) so a replacement memory system is pluggable | 2 |
