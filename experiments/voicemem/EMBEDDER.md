# Reusing an existing embedding model (Qwen3-Embedding-0.6B)

Question: the project already runs `Qwen/Qwen3-Embedding-0.6B-Q8_0.gguf` for QMD
(1024 dims, loaded in-process by node-llama-cpp). Can the memory backend reuse
that model instead of downloading `intfloat/multilingual-e5-small` (470 MB)?

Verified 2026-09-09 on this machine.

## What was tested

1. Started `llama-server` (Homebrew, llama.cpp 10330) on the **existing** GGUF
   `~/.cache/qmd/models/hf_Qwen_Qwen3-Embedding-0.6B-Q8_0.gguf`:
   `llama-server -m <gguf> --embedding --pooling last -c 2048 --host 127.0.0.1 --port 8099`.
   Result: OpenAI-compatible `/v1/embeddings`, **1024 dims**, RSS **286 MiB**.
2. Added `RemoteOpenAIEmbedder` to `adapter.py` (env `S2S_MEMORY_EMBEDDER=openai-compat`
   + `S2S_MEMORY_EMBEDDER_BASE_URL`): documents go in raw, queries get the Qwen3
   instruct prefix (`Instruct: Retrieve relevant documents for the given query\nQuery: `),
   and an `encode()` shim so voicemem's slot classifier shares the same model.
3. Ran the Chinese smoke and the per-turn prefetch path against it.

4. **Option A measured (2026-09-09):** installed `llama-cpp-python 0.3.35`
   built with Metal (`CMAKE_ARGS=-DGGML_METAL=on`, ~47 s) into the sidecar venv and
   added `LlamaCppEmbedder`, which loads the same QMD GGUF **in-process** and
   serializes calls with a lock.

## Results

| | E5-small in-process (baseline) | Qwen3 over HTTP | Qwen3 in-process (llama.cpp) |
|---|---|---|
| Model source | new download, 470 MB | **reuses the QMD GGUF, 0 MB** | **reuses the QMD GGUF, 0 MB** |
| Process | inside the sidecar | extra `llama-server`, 286 MiB (weights mmap-shared) | none |
| Sidecar RSS (loaded) | 803 MiB | 24 MiB (+286 MiB server) | **595 MiB** |
| Dims | 384 | 1024 | 1024 |
| Chinese Top-1 (3 queries) | 3/3 | 3/3 | 3/3 |
| Retrieval, warm (`recall`) | **41–92 ms** | 112–149 ms | 102–125 ms |
| Retrieval via the stream path | ~140 ms | **1050–1290 ms** | **201 ms** |
| First retrieval after start | ~200 ms | 2.8–4.8 s | 0.99–1.12 s (model load + slot matrix) |
| Embedding calls per turn | 11 (5–15 ms each) | 11 (38–239 ms each) | 8–11 (24–97 ms each) |
| Memory dir for 4 facts | ~1.1 MB | ~760 KB | ~760 KB |
| Extra install | wheels only | `llama-server` binary | **`llama-cpp-python` Metal build (toolchain needed)** |

The per-call decomposition of one `feed_final` (11 calls, 1079 ms total):

```text
batch=1  93 ms   batch=1  94 ms     # dimension probes (one per embedder instance)
batch=7 167 ms   batch=7 239 ms     # slot matrix, built twice (two classifier instances)
batch=1  38 / 175 / 204 / 205 / 210 / 45 / 36 ms   # per-query embeddings
```

### Embedding cache (wired after the first measurement)

voicemem ships an in-process `(model, text)` embedding cache
(`utils/common/embed_cache.py`, its own note: one ingest issues 15 calls, dedup
leaves ~4) but only wires it into its **built-in** OpenAI embedders. Our injected
embedders bypassed it, which is why a turn showed 8–11 calls. After routing both
custom embedders through `embed_cache.resolve`:

```text
first  feed_final: 323 ms, 4 calls  [1×35, 1×68, 7×155, 7×236]
repeat feed_final:  12 ms, 0 calls
```

A repeated turn is now free. The two `batch=7` calls are the slot matrix built
concurrently by two classifier instances, which the cache cannot dedupe (both
start before either finishes) — an in-flight dedup would remove one of them.

### Option A details

- **Thread safety is mandatory.** Without a lock around `create_embedding`, the
  speculation worker thread and the caller corrupt the llama.cpp context and it
  raises `ValueError: NULL pointer access`. With a lock the calls serialize and
  the numbers above hold.
- torch MPS and llama.cpp Metal coexist in one process (verified: an MPS tensor
  allocation before and after llama.cpp embeddings).
- Per-call latency inside a turn drifts upward (24 → 97 ms across 8 calls), so a
  turn's embedding work is ~200 ms even though a single call is ~25 ms.
- The model must be warmed at startup; the first retrieval pays ~1 s.

## Why the remote path is ~10× slower

The cost is **round trips, not the model**: voicemem issues ~11 embedding calls
per turn end (slot classification, query embedding, graph/entity lookups), and
each HTTP call pays tokenize + forward + transport on a 0.6B Q8 model. In-process
E5 absorbs the same 11 calls at ~5–15 ms each. A single llama-server call is fast
(13 ms warm, ~8 ms/text batched), but voicemem does not batch them.

Three of the 11 calls are avoidable (two dimension probes, one duplicate slot
matrix) by sharing a single classifier instance and caching dims — that still
leaves ~7 calls ≈ 350–700 ms, above the 0–300 ms prefetch budget.

## Two defects found while verifying

1. **The slot classifier silently kept loading E5.** `build_kwargs` in voicemem
   main emits the canonical key `slots`, while the adapter overrode the alias
   `schema`; `_canon()` uses `setdefault`, so the default factory won. Fixed by
   overriding both keys.
2. **torch 2.14 MPS segfaults** when `SentenceTransformer.encode()` runs on the
   speculation worker thread (`EXC_BAD_ACCESS` in
   `at::native::mps::MetalShaderLibrary::exec_unary_kernel`, and once a hang
   instead). It reproduced with E5 loaded in the sidecar venv; the E5-in-repo-venv
   path had been lucky. Worth its own look before shipping the E5 path on macOS.

## Options, with costs

| Option | Reuses existing model | Extra process/RAM | Retrieval latency | Effort |
|---|---|---|---|---|
| **A. llama.cpp in-process** — **measured** | yes (same GGUF) | none; sidecar 595 MiB | **102–125 ms warm, 201 ms stream** | done in the experiment; packaging needs a Metal build |
| **B. Keep HTTP, cut calls** | yes | 286 MiB server | ~350–700 ms (estimated) | small, but still over budget |
| **C. Use QMD itself as the memory store** (facts → markdown collection, recall → `qmd query`) | yes, **no second loader at all** | none | 30–110 ms (hot vec query) | large: own the extraction prompt + write path |
| **D. Keep E5 in-process** (today) | no (470 MB once) | none | 41–92 ms | none |

## Recommendation

**Option A is viable and is now the preferred way to reuse the existing model:**
it needs no extra process, no extra download, stays inside the 300 ms budget
(102–125 ms warm recall, 201 ms stream path), and uses *less* memory than the E5
baseline (595 MiB vs 803 MiB). Chinese Top-1 was 3/3 in both.

The one real cost is packaging: `llama-cpp-python` had to be **built with Metal**
from source (no wheel for this platform/version), so provisioning a user machine
needs a compiler/CMake. E5 (option D) installs as a pure wheel. That tradeoff —
"reuse the model file, but build a native extension" vs "download a second model,
but install cleanly" — is the decision to make before wiring this into the
desktop. `provision.py --embedder llama-cpp` now emits that plan.

Option C remains the cleanest end state if we are willing to own fact extraction
and drop voicemem's retrieval entirely.

Knobs stay experiment-only: `S2S_MEMORY_EMBEDDER=llama-cpp|openai-compat|local`
(`local` = E5) with `S2S_MEMORY_EMBEDDER_GGUF`; none of them are wired into the
desktop yet.
