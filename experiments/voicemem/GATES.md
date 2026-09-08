# The seven Phase 5 gates: status and evidence

Gate list source: `docs/kb-memory-integration-proposal.md` §10 (v4.9). Status as
of 2026-09-08. "Done in code" means the adapter/tests in this directory implement
the rule; "blocked" means it cannot be verified without an install or a key.

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Dedicated venv, no torch/STT/audio-device conflict | **Partially verified** | `check_env.py` on the repo `.venv`: 22 installs, 18 new, 5 in-place replacements including `transformers 5.14.1 -> 4.52.3`, `tokenizers 0.23.0rc0 -> 0.21.4`, `protobuf 7.36.0rc2 -> 6.33.6`, `torch 2.11.0 -> 2.14.0`. A dedicated venv is mandatory; real install + import/audio smoke still pending |
| 2 | Adapter isolates the API behind three interfaces | **Done in code** | `adapter.py` exposes `ingest_final_turn` / `recall` / `delete_all`; voicemem's real surface is `VoiceMem.ingest/search/Classify/Flush`, so the adapter also absorbs the API drift the PoC found. Deletion has no facade in 0.2.3, so `delete_all()` removes the app-private root |
| 3 | Final transcriptions only, dedup by `(turn_id, turn_revision)` | **Done in code** | The repo already carries `turn_id`/`turn_revision` on `PartialTranscriptionEvent` and `TranscriptionCompletedEvent` (`src/speech_to_speech/pipeline/events.py`); the adapter rejects empty/negative revisions and ignores repeated or older ones. Failed writes do not consume the revision |
| 4 | No memory read/write while voiceprint is off or the session is locked | **Done in code** | `set_permission(...)` gates all three interfaces and defaults to locked; the real signal exists as `SecurityGateHandler.is_locked` plus `security.locked`/`security.unlocked` events |
| 5 | Separate chat/embedding endpoints + full Chinese ingest/search | **PASS with one documented degradation** | Endpoint separation is confirmed from source: `embedding.provider=local` (E5, no network) and `llm.provider=openai` (`OPENAI_BASE_URL`/`OPENAI_MODEL`) are independent. The Chinese smoke ran on 2026-09-08 (dedicated venv, DeepSeek chat): 3 facts stored, 3 queries all top-1 correct, recall 272–450 ms. The left-brain graph layer still fails with `404` because `Orchestrator._embed_uncached` sends embeddings to the **chat** base_url — see the run log below |
| 6 | Write policy, expiry/correction/single-delete, provenance, timestamp, confidence, cloud notice | **Open** | Timestamp (`observed_at`) and score exist on hits and are normalized into `MemoryHit`. Single-item delete/expiry/correction have no supported API in 0.2.3, so the policy below is a proposal, not an implementation |
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

### Gate 5 run log (2026-09-08)

```text
ingest: 3 Chinese facts
  turn=t1 stored=True ms=25184     # 用户对坚果过敏，尤其对花生过敏。
  turn=t2 stored=True ms=18466     # 用户每周三晚上去健身房锻炼。
  turn=t3 stored=True ms=23784     # 用户住在台北。/ 用户在内湖工作。
query='我对什么食物过敏'      hits=4 top1_match=True topk_match=True ms=322
query='我什么时候去健身房'    hits=4 top1_match=True topk_match=True ms=272
query='我住哪里'              hits=4 top1_match=True topk_match=True ms=450
result: PASS
```

Verdict: gate 5's functional half is **satisfied** — Chinese extraction, storage
and retrieval all work through the adapter, and recall stays inside the
300 ms hot-query budget. Extraction latency (18–25 s per utterance) is a cloud
chat call and is far above any conversational budget; `remember`-style
background ingestion is therefore mandatory for any real use.

### Three findings from the run

1. **`hf-mirror.com` did not resolve on this machine** (DNS failure, 30 s), while
   `huggingface.co` was reachable. The E5 model download only succeeded after
   pointing `HF_ENDPOINT` at `https://huggingface.co`. A mirror default is not
   safe without a reachability check.
2. **`uv` resolved a prerelease `httpx==1.0.dev6`**, which broke `mem0`'s import
   (`module 'httpx' has no attribute 'AsyncClient'`). Pinning `httpx<1` (0.28.1)
   fixed it. The experiment venv needs that pin.
3. **The left-brain graph layer degrades against a chat-only endpoint.** With
   DeepSeek as `OPENAI_BASE_URL`, every ingest printed
   `[GraphEntity] 左脑图层写入失败: Error code: 404`, because
   `Orchestrator._embed_uncached` (`orchestrator.py:561`) calls the OpenAI
   **embeddings** API (`OPENAI_EMBEDDING_MODEL`, default `text-embedding-3-small`)
   against the same `base_url` used for chat. DeepSeek exposes no `/embeddings`
   route, so slot→entity semantic linking silently fails. Facts and retrieval are
   unaffected (the call is wrapped in `try/except`), so this is a degradation, not
   a blocker. Fixing it requires either an embeddings-capable endpoint reachable
   at that base_url or the fork the plan already anticipates
   (`docs/kb-memory-integration-proposal.md` §10).

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
