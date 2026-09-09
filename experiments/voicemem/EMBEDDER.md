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

## Results

| | E5-small in-process (baseline) | Qwen3-Embedding-0.6B over HTTP |
|---|---|---|
| Model source | new download, 470 MB | **reuses the QMD GGUF, 0 MB** |
| Process | inside the sidecar | extra `llama-server`, RSS 286 MiB (weights mmap-shared with QMD's copy) |
| Dims | 384 | 1024 |
| Chinese Top-1 (3 queries) | 3/3 | 3/3 |
| Retrieval, warm | **41–92 ms** | 112–149 ms (`adapter.recall`) |
| Retrieval via the stream path | ~140 ms | **1050–1290 ms** |
| First retrieval after start | ~200 ms | 2.8–4.8 s (slot matrix + warmup) |
| Embedding calls per turn | 11 (in-process, ~5–15 ms each) | **11 (HTTP, 38–239 ms each)** |
| Memory dir for 4 facts | ~1.1 MB | ~760 KB |

The per-call decomposition of one `feed_final` (11 calls, 1079 ms total):

```text
batch=1  93 ms   batch=1  94 ms     # dimension probes (one per embedder instance)
batch=7 167 ms   batch=7 239 ms     # slot matrix, built twice (two classifier instances)
batch=1  38 / 175 / 204 / 205 / 210 / 45 / 36 ms   # per-query embeddings
```

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
| **A. llama.cpp in-process** (`llama-cpp-python` 0.3.35 in the sidecar, same GGUF) | yes (file) | second loader, ~300–600 MiB; new dependency (Metal build) | est. 11 × 15–30 ms ≈ 150–330 ms | small-medium |
| **B. Keep HTTP, cut calls** (one classifier instance, cached dims, precomputed slot matrix) | yes | 286 MiB server | ~350–700 ms | small |
| **C. Use QMD itself as the memory store** (facts → markdown collection, recall → `qmd query`) | yes, **no second loader at all** | none | 30–110 ms (hot vec query) | large: own the extraction prompt + write path |
| **D. Keep E5 in-process** (today) | no (470 MB once) | none | **41–92 ms** | none |

## Recommendation

- If the goal is "no extra model download and no extra process", option **C** is
  the only one that truly satisfies it, but it means reimplementing fact
  extraction and dropping voicemem's retrieval.
- If the goal is "reuse the existing model file", option **A** is the only
  variant that stays inside the prefetch budget; option **B** does not.
- Option **D** remains the tested baseline and is what the product currently
  ships behind the off-by-default flag.

The remote-embedder knob (`S2S_MEMORY_EMBEDDER=openai-compat`) stays in the
adapter as the harness for A/B/C experiments; it is not wired into the desktop.
