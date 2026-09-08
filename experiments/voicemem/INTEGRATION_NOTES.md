# What VoiceMem would introduce

Measured against `voicemem==0.2.3` on 2026-09-08 (macOS 15.1 arm64, repo `.venv`
CPython 3.11.13, `torch 2.11.0`). Sources: `uv pip install --dry-run` output and
the installed wheel's source (`voicemem/`, `mem0/`). Reproduce the dependency
numbers with `check_env.py`.

## 1. Capability (what it adds)

| Dimension | Content | Relationship to what exists |
|---|---|---|
| Long-term memory | Fact extraction (left brain) plus persona/emotion profile (right brain), cross-session `recall`, injected into the prompt | Does **not** replace QMD: QMD retrieves documents, VoiceMem remembers what the user said |
| Input | `ingest(text=...)` accepts text directly | Feeding text means reusing our own STT; its ASR is not needed |
| Chinese | Default embedding `intfloat/multilingual-e5-small` | A second embedding stack alongside QMD's Qwen3-Embedding |
| Emotion graph | `EmotionLayer` (right brain) | v1 excludes it; `audio_native=False` keeps it off |

## 2. Dependencies: 112 packages

`uv pip install --dry-run --python <fresh venv> voicemem` resolves 112 packages.
Against this repo's `.venv` the change set is 22 installs, 18 of them new, plus 5
in-place replacements:

| Package | Repo now | voicemem wants | Nature |
|---|---|---|---|
| `torch` | 2.11.0 | 2.14.0 | upgrade; cannot coexist in one env |
| `transformers` | 5.14.1 | 4.52.3 | **downgrade** |
| `tokenizers` | 0.23.0rc0 | 0.21.4 | downgrade |
| `protobuf` | 7.36.0rc2 | 6.33.6 | downgrade |
| `pydantic` | 2.14.0b1 | 2.13.5 | downgrade |
| `openai` | 2.28.0 | 3.8.0 | major jump |
| `sherpa-onnx-core` | 1.13.5 | 1.13.6 | patch bump |

Brand-new packages include `mem0ai`, `qdrant-client`, `sentence-transformers`,
`huggingface-hub`, `accelerate`, `sqlalchemy`, `grpcio`, `h2`/`hpack`/`hyperframe`,
`httpcore2`/`httpx2`, `pywebrtc-audio`, `portalocker`, `psutil`, `truststore`,
`torchvision`, `sherpa-onnx` (the Python wrapper; the repo only has
`sherpa-onnx-core`) and `posthog`.

**Consequence:** gate 1 is not a formality. Installing into the repo `.venv`
would downgrade `transformers`/`tokenizers`/`protobuf`/`pydantic`, so VoiceMem
must live in a dedicated venv and process.

## 3. Models (downloaded on first use, not shipped)

- `intfloat/multilingual-e5-small` via Hugging Face, overridable with
  `VOICEMEM_MODELS_DIR` (offline pack) and mirror-able with `HF_ENDPOINT`
- silero VAD model
- Only with `audio_native=True`: speaker-print `eres2net` ONNX, AST environment
  detector, emotion models
- The wheel's `assets/` directory contains 4 demo WAV files and no models

## 4. Network egress

- Fact extraction calls an OpenAI-compatible **chat** endpoint; default model
  `gpt-4o-mini`, key required (`ValueError` without `OPENAI_API_KEY`). There is
  **no local extraction path in 0.2.3**, so "memory enabled" implies "user
  utterances leave the machine".
- The embedding leg can stay local (`embedding.provider=local`), and chat and
  embeddings are configured independently — the endpoint-separation question in
  gate 5 is therefore an architecture/config question, not a code change.
- `mem0` telemetry defaults to **on** and posts to `https://us.i.posthog.com`
  (`mem0/memory/telemetry.py`, `MEM0_TELEMETRY`). The adapter refuses to build a
  backend while it is truthy and otherwise forces `MEM0_TELEMETRY=false`.

## 5. Local storage

- Default roots are `<cwd>/voicemem_memoryspace/<space>/` and `<cwd>/voicemem_memory`
  (`VOICEMEM_MEMORY_ROOT` / `VOICEMEM_MEMORYSPACE_ROOT` override). Unredirected,
  that writes into the checkout or the app directory.
- Backend stack: mem0 + local qdrant + sqlite/sqlalchemy.
- Deletion surface in 0.2.3: internal `delete_memory(memory_id)` and
  `delete_user(user_id)` only — no facade method, hence gate 6 stays open and
  `adapter.delete_all()` removes the app-private root instead.

## 6. Resource and compliance

- Same-process use would pull torch 2.14 + funasr + transformers into the voice
  process; memory and startup cost must be measured before any integration.
- A dependency-license report would grow by ~25 entries (including the posthog
  telemetry SDK). voicemem itself is Apache-2.0.

## 7. What this experiment does not introduce

Installing nothing means the repository gains only this directory: no
dependencies, no model downloads, no network calls, no memory directory, no
change to `src/`, and no change to the v1 tool list or completion definition.

The four switches that need an explicit decision before real adoption:

1. Dedicated venv/process (~3–5 GB disk, 112 packages)
2. Cloud extraction consent (otherwise memory stays disabled)
3. App-private memory directory, with mem0 telemetry off
4. Whether `audio_native` is ever enabled (off by default; it pulls the
   speaker-print/emotion models)
