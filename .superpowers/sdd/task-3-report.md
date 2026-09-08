# Task 3 Report: QMD Resources, Indexing, and Model Assets

## Status

Completed on branch `feature/desktop-gateway` in commit `1661c88`.

## TDD Evidence

### RED

The focused Task 3 acceptance command was run before the missing implementation was added.

```text
npm --prefix desktop test -- tests/prepare-qmd-resources.test.mjs \
  tests/model-store.test.mjs tests/qmd-runtime.test.mjs tests/qmd-indexer.test.mjs
```

It failed as expected:

- `tests/qmd-indexer.test.mjs` could not import the absent `qmd-indexer` module.
- Model-store assertions showed the old generic `.asset` output rather than `<userData>/qmd/cache/qmd/models/*.gguf`.
- The runtime spawn assertion showed that `--host ::1` was missing.

The added lockfile fixture was also run before its implementation. It showed the installed-manifest traversal incorrectly selected `dev-only` and did not traverse a nested production dependency present only in the lockfile.

### GREEN

After implementing the missing plain `embed` command and the one-import correction caught by typecheck, the required focused command passed:

```text
4 Task 3 Vitest files passed
10 Task 3 tests passed
6 existing Node tests passed in the full desktop test command
```

The npm command runs the existing complete Vitest suite because its fixed runner does not accept a file filter. The task-specific files are included in that green suite.

## Changed Files

- `desktop/scripts/prepare-qmd-resources.mjs`
  - Resolves `@tobilu/qmd@2.8.3` from `package-lock.json`.
  - Traverses only `dependencies` and `optionalDependencies`, excludes `dev` package records and incompatible platform/CPU packages, and preserves each package's nested source-relative location.
- `desktop/src/main/qmd-runtime.ts`
  - Launches `node_modules/@tobilu/qmd/bin/qmd` with Electron's `process.execPath`, `ELECTRON_RUN_AS_NODE=1`, a random IPv6 loopback port, and `--host ::1`.
  - Uses private HOME/XDG/index paths.
- `desktop/src/main/model-store.ts`
  - Downloads HTTPS model assets to `.part`, resumes with Range, preserves cancelled partial downloads, verifies size and SHA-256, atomically renames verified GGUFs, and writes their absolute path to private `index.yml`.
  - The emitted QMD model config points `embed`, `rerank`, and `generate` at the verified local asset rather than allowing any role to fall back to an `hf:` URI. v1 only invokes the vec-only path.
- `desktop/src/main/qmd-indexer.ts`
  - Adds the closed QMD write-command adapter. It permits only collection add/remove, update, embed, and embed force with a canonical root, generated collection name, and fixed Markdown mask.
  - Exposes the plain `embed` operation used by the runtime's initial embedding step; `reindex` remains the fixed `update` followed by `embed --force` sequence.
  - It discards child output and fixes all QMD state environment paths under app-private data.
- `desktop/tests/prepare-qmd-resources.test.mjs`
- `desktop/tests/model-store.test.mjs`
- `desktop/tests/qmd-runtime.test.mjs`
- `desktop/tests/qmd-indexer.test.mjs`
- `desktop/package.json`, `desktop/package-lock.json`, `desktop/electron-builder.yml`
  - Pins the production dependency to `@tobilu/qmd` `2.8.3`, adds `prepare:qmd`, runs it before distributable builds, and packages its output as an Electron extra resource.

## Verification

```text
npm --prefix desktop test -- tests/prepare-qmd-resources.test.mjs \
  tests/model-store.test.mjs tests/qmd-runtime.test.mjs tests/qmd-indexer.test.mjs
Result: PASS (10 Task 3 Vitest tests, 6 Node tests)

npm --prefix desktop run typecheck
Result: PASS

npm --prefix desktop run prepare:qmd
Result: PASS; prepared 128 production packages
```

The generated resource closure was inspected after preparation:

- `node_modules/@tobilu/qmd/bin/qmd` is present.
- Electron and Vitest are absent.
- `sqlite-vec-darwin-arm64` and `@node-llama-cpp/mac-arm64-metal` are present.
- Their x64 alternatives are absent.

`desktop/build/qmd-resources` remains ignored and is not staged as a build artifact.

The post-review fix aligns QMD runtime/indexer `dataRoot` with the ModelStore userData layout and sets `QMD_CONFIG_DIR` to the same app-private directory. The fix is covered by the updated runtime, indexer, and model-store tests.

## Self-Review

No outstanding requirement or security concern was found. The command surface is fixed in main-process code, collection names and masks are validated before spawn, canonical roots are resolved with `realpath`, model/config/index state remains app-private, and child stdout/stderr is ignored. The test suite uses fake QMD processes and download streams; a live daemon/model smoke test is deliberately outside this task's stated acceptance commands because it would require downloading and loading the large embedding model.
