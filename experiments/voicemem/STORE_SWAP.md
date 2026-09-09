# Swapping mem0's vector store: Qdrant → SQLite / sqlite-vec

Status 2026-09-09. Prototype only — nothing under `src/`, `desktop/` or
`gateway/` uses it.

## Scope

The ask: keep mem0 as the memory engine, but store its vectors in SQLite through
the `sqlite-vec` extension (the same extension family QMD's own index uses)
instead of mem0's local Qdrant. This is **not** "store memory in QMD" — QMD owns
its schema, index and maintenance, so its index cannot host mem0's rows. Only the
`sqlite-vec` *engine* is reused, inside a SQLite file this store owns
(`QMD_STORE.md` documents the separate, rejected memory-in-QMD route).

## What "one fewer service" actually means here

Qdrant in this stack is **embedded**, not a service: mem0 is constructed with
`QdrantConfig(path=...)`, which runs Qdrant's local file mode in-process. No
server process, no port, no daemon, nothing in `startProcessesInOrder` to remove.
So the swap does **not** stop any service. What it does remove is measured below.

## What was built

| File | Purpose |
|---|---|
| `mem0_sqlite_vec.py` | `SqliteVecStore` (mem0 `VectorStoreBase` implementation) + `register()` |
| `mem0_store_probe.py` | mem0-level A/B: same embedder, facts, queries, mem0 version; only the store changes |
| `store_swap_smoke.py` | End-to-end through `VoiceMemAdapter`, with VoiceMem's hardcoded provider rewritten |
| `tests/test_mem0_sqlite_vec.py` | 12 contract tests (skipped unless mem0 + sqlite-vec are importable) |

## Teaching mem0 the provider — two dict hooks, no fork

mem0 2.0.20 has no sqlite-vec provider (25 providers, none SQLite-backed). It
does not need a fork:

1. `VectorStoreFactory.provider_to_class["sqlite_vec"] = "mem0_sqlite_vec.SqliteVecStore"`
   — the factory is a plain dict lookup + `importlib`.
2. `VectorStoreConfig` validates the provider against a private
   `_provider_configs` table and imports `mem0.configs.vector_stores.<provider>`
   for a matching pydantic config model. `register()` inserts a synthetic module
   under that name and points the table at it.

Interface details that had to match mem0's real code (verified by reading
`mem0/memory/main.py`, not by analogy):

- `insert(vectors=[embedding], ...)` receives a **list of vectors** while
  `search(query, vectors, ...)` receives a **flat** vector.
- `_search_vector_store` reads results as attributes (`mem.id` / `.payload` /
  `.score`) with a `.get` fallback, so results are `SqliteVecHit` objects, not
  dicts.
- `keyword_search` is deliberately **not** overridden: the inherited base method
  returns `None`, and mem0 logs "this store does not support keyword search" and
  disables BM25. Overriding it with an identical `return None` would hide that
  warning.
- `col_info()` must survive a deleted collection (mem0 and our own tooling call
  it to describe state).

## Results

### mem0-level A/B — 12 Chinese facts, 6 queries, QMD embeddings (1024-d)

| | mem0 + Qdrant | mem0 + sqlite-vec |
|---|---|---|
| Top-1 correct | 5/6 | 5/6 (identical rows) |
| Search latency (warm embed cache, median of 5) | 0.4–0.6 ms | 0.9–1.2 ms |
| Populate 12 facts | 359 ms | 23 ms |
| On disk | 4 files, 152 KB | 2 files, 4180 KB |
| Cold embed + search (uncached query) | 25.5 ms | 24.4 ms |

The single miss is the same fact in both stores ("我一般什么时候运动？" returns the
weekend-badminton fact instead of the Wednesday-gym fact), so it is a retrieval
semantics issue, not a store difference. Ranking is byte-identical.

sqlite-vec is ~2× slower per search in absolute terms and that is irrelevant
here: both are far below the ~25 ms QMD embedding round trip that precedes every
memory search.

### End-to-end through VoiceMem's real path — 3 turns, 3 queries, cloud extraction

`store_swap_smoke.py --store {qdrant,sqlite_vec}`, fresh memory root each run:

| | Qdrant | sqlite-vec |
|---|---|---|
| Result | PASS 3/3 | PASS 3/3 |
| Recall latency | 87–127 ms | 91–133 ms |
| `vectors/` on disk | `collection/voicemem/storage.sqlite` 52 KB + `.lock` + `meta.json` | `voicemem.sqlite` 4152 KB |
| `vector_store` actually constructed | `mem0.vector_stores.qdrant.Qdrant` | `mem0_sqlite_vec.SqliteVecStore` |

Ingest cost (11–24 s/turn) is cloud fact extraction and is unaffected by the
store, so it is omitted from the comparison.

### Dependency and memory delta

| | with Qdrant | with sqlite-vec |
|---|---|---|
| Runtime packages | `qdrant-client` 5.0 MB, `grpcio` 39 MB, `protobuf`, `portalocker`, `urllib3`, `httpx[http2]` (→ `h2`) | `sqlite-vec` 168 KB, zero runtime deps |
| Import RSS over bare Python | +70.7 MB | +12.9 MB |
| Import time | 291 ms | 25 ms |

The app already depends on SQLite for the mem0 history DB and on `sqlite-vec`
(via QMD) for the document index, so this makes the sidecar's storage engine
family uniform.

### The lock failure mode disappears

Qdrant's local mode allows exactly one client per storage directory. Verified
here, not just quoted:

```
RuntimeError: Storage folder /tmp/qdrant-double-open is already accessed by
another instance of Qdrant client. If you require concurrent access, use Qdrant
server instead.
```

VoiceMem's own comment records the consequence: in a 152-question LoCoMo
evaluation with 16 worker threads, **137 questions failed** with that error, and
`Mem0BackendStore` now caches one `Memory` client per `memory_root` to work
around it. SQLite permits concurrent connections, so a second store on the same
path reads the first one's writes (`test_second_store_on_same_path_sees_writes`).
That workaround — and the `_close_on_exit` hack that closes the Qdrant client
before interpreter shutdown — exist only because of the embedded Qdrant client.

## Costs and caveats

1. **VoiceMem hardcodes `provider="qdrant"`** in
   `voicemem/leftbrain/mem0_backend_store.py`. Adopting this needs either a
   one-line upstream change (provider from config/env) or the runtime patch used
   in `store_swap_smoke.py`. Nothing else in VoiceMem touches Qdrant except
   `_close_on_exit`'s `vector_store.client.close()`, which is already inside a
   `try/except`.
2. **No BM25 / hybrid scoring.** In *this* environment BM25 is already disabled
   for the Qdrant path too (fastembed is not installed, so mem0 logs and falls
   back to semantic-only), so today's parity is not evidence that sqlite-vec is
   sufficient if hybrid search is ever wanted. mem0's own error message suggests
   qdrant/elasticsearch/pgvector for that.
3. **`vec0` preallocates `chunk_size` rows up front**: the default 1024 rows ×
   1024 dims × 4 B = 4.2 MB even for an empty collection. Measured: 4144 KB at
   `chunk_size=1024`, 100 KB at 16. Exposed as `SqliteVecStore(chunk_size=...)`.
4. **`k` is capped at 4096** by vec0, and there is no filtered-KNN pushdown.
   VoiceMem asks mem0 for 10 000 candidates when it narrows by memory id and
   mem0 multiplies by 4, so the store clamps (this was a real crash:
   `k value in knn query too large, provided 160000`). Above ~4096 memories with
   a metadata filter, a filtered search can truncate the candidate set; a larger
   store should pre-filter ids or use two-stage retrieval.
5. **No `search_batch`** and no remote-only features — mem0 2.0.20 does not call
   them on the add/search paths exercised here.

## Recommendation

Swap it, as a **dependency-and-robustness** change rather than a service-count
change: ~45 MB fewer installed bytes, ~58 MB less RSS in the sidecar, one fewer
storage layout, and removal of a lock failure mode that already caused a
documented 90 % eval failure. Retrieval quality and latency are at parity.

Prerequisites before this becomes product code:

1. an upstream VoiceMem change (or a maintained patch) to make the provider
   configurable — a monkeypatch of mem0's pydantic config is fine for a probe,
   not for shipping;
2. a decision on hybrid search: if BM25 is ever wanted, either install fastembed
   for the Qdrant path or add an FTS5-backed `keyword_search` to this store;
3. a migration story for existing `vectors/` directories (export/re-embed), since
   the two layouts are not interchangeable.

## Reproduce

```bash
VENV="$HOME/.cache/speech-to-speech/voicemem-venv"
set -a; . ~/.config/speech-to-speech/voicemem-smoke.env; set +a
export S2S_MEMORY_EMBEDDER=qmd S2S_MEMORY_EMBEDDER_BASE_URL=http://127.0.0.1:8130

# 1. mem0-level A/B (needs the QMD daemon's patched /embed)
"$VENV/bin/python" experiments/voicemem/mem0_store_probe.py --embedder-url http://127.0.0.1:8130

# 2. end-to-end through VoiceMem, both stores
"$VENV/bin/python" experiments/voicemem/store_swap_smoke.py --store qdrant     --memory-root /tmp/swap-qdrant
"$VENV/bin/python" experiments/voicemem/store_swap_smoke.py --store sqlite_vec --memory-root /tmp/swap-sqlite

# 3. store contract tests (skipped in the project venv: mem0 lives in the sidecar venv)
uv pip install --python "$VENV/bin/python" pytest
"$VENV/bin/python" -m pytest experiments/voicemem/tests/test_mem0_sqlite_vec.py -q
```
