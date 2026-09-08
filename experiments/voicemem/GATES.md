# The seven Phase 5 gates: status and evidence

Gate list source: `docs/kb-memory-integration-proposal.md` §10 (v4.9). Status as
of 2026-09-08. "Done in code" means the adapter/tests in this directory implement
the rule; "blocked" means it cannot be verified without an install or a key.

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Dedicated venv, no torch/STT/audio-device conflict | **Verified** | `check_env.py` on the repo `.venv`: 22 installs, 18 new, 5 in-place replacements including `transformers 5.14.1 -> 4.52.3`, `tokenizers 0.23.0rc0 -> 0.21.4`, `protobuf 7.36.0rc2 -> 6.33.6`, `torch 2.11.0 -> 2.14.0` — a dedicated venv is mandatory. The venv exists (1.3 GB, voicemem main@a450911 + `httpx<1`) and the sidecar now runs voicemem in its own process, so the voice process never imports it |
| 2 | Adapter isolates the API behind three interfaces | **Done in code** | `adapter.py` exposes `ingest_final_turn` / `recall` / `delete_all`; voicemem's real surface is `VoiceMem.ingest/search/Classify/Flush`, so the adapter also absorbs the API drift the PoC found. `sidecar.py` exposes the same capability over JSONL (`health`/`set_permission`/`recall`/`observe`/`flush`/`close`) with 9 process-boundary tests. Deletion has no facade in voicemem, so `delete_all()` removes the app-private root |
| 3 | Final transcriptions only, dedup by `(turn_id, turn_revision)` | **Done in code, one gap** | The repo already carries `turn_id`/`turn_revision` on `PartialTranscriptionEvent` and `TranscriptionCompletedEvent` (`src/speech_to_speech/pipeline/events.py`); the adapter rejects empty/negative revisions and ignores repeated or older ones. Failed writes do not consume the revision. **Gap:** the dedup set is in-memory, so a restart re-ingests — qwen-audio-agent persists it (`observed-messages.json`, see `PRIOR_ART.md`) |
| 4 | No memory read/write while voiceprint is off or the session is locked | **Done in code** | `set_permission(...)` gates all three interfaces and defaults to locked; the real signal exists as `SecurityGateHandler.is_locked` plus `security.locked`/`security.unlocked` events |
| 5 | Separate chat/embedding endpoints + full Chinese ingest/search | **PASS on main@a450911** | Endpoint separation is confirmed from source: `embedding.provider=local` (E5, no network) and `llm.provider=openai` (`OPENAI_BASE_URL`/`OPENAI_MODEL`, or the role-based `VOICEMEM_CHAT_MODEL`) are independent. Smoke on 2026-09-08 (dedicated venv, DeepSeek chat, `mode=leftbrain_only`, `memory_language=zh`): 3 facts stored, 3 queries top-1 correct, recall 41–92 ms |
| 6 | Write policy, expiry/correction/single-delete, provenance, timestamp, confidence, cloud notice | **Open** | Timestamp (`observed_at`) and score exist on hits and are normalized into `MemoryHit`. Single-item delete/expiry/correction have no supported API in 0.2.3, so the policy below is a proposal, not an implementation. qwen-audio-agent solves the edit/delete half with an adapter-owned snapshot plus exact-match edits — see `PRIOR_ART.md` §2 |
| 7 | Cloud extraction off by default or explicitly consented | **Done in code** | The adapter requires `allow_cloud_extraction=True`; without it every call raises `CloudExtractionNotConsentedError`. `MEM0_TELEMETRY` is forced off and a truthy value aborts backend construction |

## Gate 5: the Chinese smoke (run on 2026-09-08)

```bash
VENV="$HOME/.cache/speech-to-speech/voicemem-venv"
uv venv "$VENV" --python 3.11
uv pip install --python "$VENV/bin/python" voicemem
uv pip install --python "$VENV/bin/python" "httpx<1"   # see finding 2 below

set -a; . ~/.config/speech-to-speech/voicemem-smoke.env; set +a
"$VENV/bin/python" experiments/voicemem/zh_smoke.py --memory-root /tmp/voicemem-smoke
```

Pass criteria: three Chinese facts ingest successfully, and each of the three
Chinese queries returns a top-1 hit containing the expected keyword. The script
reports counts, ids, timings and booleans only.

### Gate 5 run log

Two runs, both on 2026-09-08, same adapter, same key, same Chinese facts.

**PyPI 0.2.3 (`mode=text_mode`, `enable_emotion=False` forced):**

```text
turn=t1 stored=True ms=25184     # 用户对坚果过敏，尤其对花生过敏。
turn=t2 stored=True ms=18466     # 用户每周三晚上去健身房锻炼。
turn=t3 stored=True ms=23784     # 用户住在台北。/ 用户在内湖工作。
query='我对什么食物过敏'      hits=4 top1_match=True ms=322
query='我什么时候去健身房'    hits=4 top1_match=True ms=272
query='我住哪里'              hits=4 top1_match=True ms=450
result: PASS
[GraphEntity] 左脑图层写入失败: Error code: 404   # every ingest
```

**main@a450911 (`mode=leftbrain_only`, `memory_language=zh`, `HF_HUB_OFFLINE=1`):**

```text
turn=t1 stored=True ms=31924     # 用户对坚果过敏，尤其是花生
turn=t2 stored=True ms=11595     # 用户每周三晚上去健身房锻炼
turn=t3 stored=True ms=23055     # 用户住在台北。/ 用户的工作地点在台北内湖。
query='我对什么食物过敏'      hits=4 top1_match=True ms=92
query='我什么时候去健身房'    hits=4 top1_match=True ms=53
query='我住哪里'              hits=4 top1_match=True ms=41
result: PASS
```

Retrieval is 3–5× faster on main (41–92 ms vs 272–450 ms), the `GraphEntity` 404
noise is gone under `leftbrain_only`, and extraction latency stays 12–32 s per
utterance — background ingestion remains mandatory.

### Findings from the runs

1. **`hf-mirror.com` did not resolve on this machine** (DNS failure, 30 s), while
   `huggingface.co` was reachable. The E5 model download only succeeded after
   pointing `HF_ENDPOINT` at `https://huggingface.co`.
2. **`uv` resolved a prerelease `httpx==1.0.dev6`**, which broke `mem0`'s import
   (`module 'httpx' has no attribute 'AsyncClient'`). Pinning `httpx<1` (0.28.1)
   fixed it. The experiment venv needs that pin.
3. **main defaults stored memory text to English.** With the 0.2.3-era config the
   facts came back as `User has a standing`, `User lives in Taipei`,
   `User works in Neihu` and two of three queries missed at top-1. Setting
   `memory_language="zh"` (or `VOICEMEM_MEMORY_LANGUAGE=zh`) restored Chinese
   extraction and made the run PASS. This is exactly why qwen-audio-agent pins
   `VOICEMEM_MEMORY_LANGUAGE=zh`.
4. **`HF_HUB_OFFLINE=1` matters once E5 is cached.** With a flaky HF endpoint the
   loader retried HEAD requests (10 s timeout each) before falling back to the
   cache; the offline flag removed that latency from every start.
5. **The graph-embedding 404 is avoided by mode, not by config.** On 0.2.3,
   `text_mode` ran the slot→entity link, which calls
   `Orchestrator._embed_uncached` — an OpenAI **embeddings** call against the chat
   `base_url` (DeepSeek has no `/embeddings`), producing a non-fatal 404 per
   ingest. `leftbrain_only` does not run that path, so the noise disappears. On
   main the function still posts to the chat base_url, but now resolves the model
   through `VOICEMEM_EMBEDDING_MODEL` and validates the returned dimension
   against `VOICEMEM_EMBED_DIM` (default 1536), so a mismatch fails loudly.

## Gate 6: proposed policy (needs product decisions, not code)

| Question | Proposal |
|---|---|
| What gets written | Only facts extracted from **final** transcriptions of an unlocked session; never partial text, never other speakers |
| Provenance | Store `turn_id`, `turn_revision`, `observed_at`, speaker and the source collection/session id with each memory |
| Confidence | Keep the retriever score and expose it to the caller; do not silently drop low-score memories at write time |
| Expiry | No automatic expiry in v1 of the experiment; provide explicit "forget this" and "forget everything" instead |
| Correction | Overwrite by writing a corrected fact with the same `turn_id` at a higher revision; the adapter already ignores older revisions |
| Single-item delete | Needs an upstream API (only `delete_memory(id)` exists internally). Until then, deletion is all-or-nothing per app-private root |
| Cloud notice | Before the first ingest, state plainly that utterance text is sent to the configured endpoint for fact extraction; "no persistence" is not the same as "no network" |

## Sequencing note

The baseline gates Phase 5 behind the Task 8 release checks. The maintainer
decided on 2026-09-08 that no formal release is being pursued yet, so this
pre-research proceeds **without** touching the v1 runtime, tool list or
completion definition. Formal Phase 5 implementation still requires all seven
gates plus an explicit decision on the four adoption switches in
`INTEGRATION_NOTES.md` §7.
