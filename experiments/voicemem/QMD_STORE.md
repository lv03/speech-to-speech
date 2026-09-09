# Feasibility: replacing mem0 + Qdrant with QMD as the memory store (route 2)

Status 2026-09-09. Prototype only — nothing in `src/` uses it.

## What was built

- `qmd_store.py`: `QmdMemoryStore`, a QMD-backed implementation of the
  vector-store interface `LeftBrainMemoryRepository` uses. Facts become one
  Markdown file per memory (`<root>/<user_id>/<id>.md` with a small frontmatter
  block); retrieval goes through the QMD daemon's REST `POST /query`.
  Implemented: `add_records_with_ids`, `search`, `list_ids`, `update_memory`,
  `delete_memory`, `_path`. Deliberately `NotImplementedError`:
  `list_entries`, `existing_for_extractor`, `memory_ids_with_time_expr`,
  `archive_memory`, `unarchive_memory`.
- `qmd_store_probe.py`: A/B harness — 12 Chinese facts, 6 queries, same facts and
  same embedding model (QMD's Qwen3) written to both stores, so only storage and
  retrieval differ.

## Results (12 facts, 6 queries)

| | mem0 + Qdrant (current) | QMD store, vec-only | QMD store, hybrid + rerank |
|---|---|---|---|
| Top-1 correct | 5/6 | 5/6 | 5/6 |
| Query latency | 22–27 ms | 23–80 ms | **797–2486 ms** |
| Storage on disk | 164 KB (5 files) | 48 KB (12 markdown files) | 48 KB (12 markdown files) |
| Human-readable | no | **yes** | **yes** |

Write path cost (incremental, 12 docs): `qmd update` 167 ms + `qmd embed -c memfacts`
114 ms ≈ **280 ms per write batch**. Our session writer already batches, so this
lands on the background write path.

The single miss is identical in all three configurations ("我一般什么时候运动？"
returns the badminton fact instead of the Wednesday-gym fact), so it is a
retrieval-semantics issue, not a store difference.

## Findings

1. **The store interface is small enough to implement.** Five methods plus
   `_path` cover the write and search paths; the prototype is ~200 lines.
2. **Hybrid rerank is unusable for memory recall.** The reranker costs ~800 ms
   per query (30–100× the current path) and did not improve Top-1 on this set.
   A QMD-backed memory store must use **vec-only** (or lex+vec without rerank).
3. **Vec-only is at parity**: same Top-1, latency 23–80 ms vs 22–27 ms.
4. **Memories become auditable files.** 12 Markdown files instead of opaque
   SQLite blobs; deleting a memory is deleting a file.
5. **mem0 + Qdrant would disappear entirely** — including mem0's telemetry
   surface and the `httpx<1` pin its 1.0-prerelease incompatibility forced.

## What is still missing before adoption

| Gap | Why it matters | Rough size |
|---|---|---|
| `list_entries` / `existing_for_extractor` | voicemem's extractor uses them to dedupe and to give the LLM the existing facts | small: read the directory + frontmatter |
| `memory_ids_with_time_expr` | temporal queries ("上周说的那件事") select ids by date | small-medium: parse frontmatter dates |
| `archive_memory` / `unarchive_memory` | archived facts must stop surfacing | small: flip the frontmatter flag |
| Slot/entity narrowing | `search(memory_id_filter=...)` currently filters after QMD returns; the candidate set may be too small | medium: widen the QMD limit or map slots to metadata filters |
| Reindex strategy | one `qmd update` + `qmd embed` per write batch (~280 ms) is fine for batches, wasteful per single fact | small: debounce |
| Migration | existing users' `vectors/` + mem0 history must be exported to Markdown once | medium |
| Scoring semantics | QMD's REST rounds scores to 2 decimals; voicemem's lexical/time bonuses would need reimplementation on top | small |

## Recommendation

Route 2 is **feasible and worth doing** if the goal is "one store, no mem0, no
Qdrant, auditable memories": the store layer is small, vec-only retrieval is at
parity, and the dependency reduction is real. It is not a quick swap — the five
unimplemented methods plus slot/entity narrowing and a migration path are the
actual work, and it changes retrieval semantics (voicemem's lexical/time bonuses
would need porting).

Do **not** adopt QMD's hybrid rerank for memory recall: it costs ~0.8 s per query
with no measured gain on this set.

Suggested next step if adopted: implement the five methods, run the same A/B
probe against a larger fact set (50–100 facts, including temporal and
assistant-attributed items), and only then migrate the product store.
