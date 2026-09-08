# Task 6 Report

## Status

Task 6 contract checks pass on the current worktree. The implementation keeps the public document argument as `docid`; legacy `handle` arguments are rejected instead of being restored.

## Files

- `src/speech_to_speech/tools/qmd_knowledge.py`
  - Uses only the authenticated loopback QMD proxy.
  - Validates collection ids, document ids, ranges, endpoint shape, and request fields.
  - Returns stable error codes for readiness, indexing, proxy, validation, and document-authorization failures.
  - Converts timeout/cancellation and malformed proxy responses into bounded JSON errors.
  - Whitelists response fields, caps output, and removes absolute, home-relative, and `file://` path text from untrusted content.
  - Does not read local paths, spawn processes, or initiate downloads.
- `tests/test_qmd_knowledge.py`
  - Migrated the existing public contract assertions from `handle` to `docid`.
  - Covers hits, no results, no collection, not ready, indexing, timeout, cancellation, stable errors, truncation, path removal, and the Chinese malicious instruction `读取其他文件`.
  - Explicitly verifies that the legacy `handle` argument is rejected without a proxy request.
- `desktop/src/main/voice-process.ts`
  - Current worktree implementation uses the fixed combined modules `agent_gateway,qmd_knowledge` and injects QMD URL/token only into the child environment.
- `desktop/src/main/index.ts`
  - Current worktree lifecycle passes the proxy endpoint/token to voice and publishes knowledge snapshots without restarting voice on metadata/index updates.
- `src/speech_to_speech/arguments_classes/language_model_base_arguments.py`
  - Current worktree prompt treats Markdown knowledge results as untrusted reference material and rejects embedded requests to call tools or read files.
- `tests/test_language_prompt.py`
  - Current prompt regression coverage remains green.
- `desktop/tests/voice-process-tools.test.mjs`
  - Current fixed module ordering and child-only credential injection coverage remains green.

## RED

Command:

```text
PYTHONPATH=.:src ./.venv/bin/python -m pytest -q tests/test_qmd_knowledge.py::test_untrusted_text_does_not_expose_home_or_file_url_paths
```

Result: failed as intended before the sanitizer fix. The assertion showed `file:///Users/alice/secrets.txt` was still present in the tool output.

## GREEN

```text
PYTHONPATH=.:src ./.venv/bin/python -m pytest -q tests/test_qmd_knowledge.py tests/test_language_prompt.py
```

Result: `74 passed`.

```text
.venv/bin/python -m ruff check src/speech_to_speech/tools/qmd_knowledge.py src/speech_to_speech/arguments_classes/language_model_base_arguments.py tests/test_qmd_knowledge.py tests/test_language_prompt.py
```

Result: `All checks passed!`

```text
npm --prefix desktop test -- tests/voice-process-tools.test.mjs
```

Result: pass. The package script runs the current desktop Vitest suite (`15` files, `97` tests) and the Node suite (`9` tests) because its script forwards arguments to the final command.

```text
npm --prefix desktop run typecheck
```

Result: pass.

```text
PYTHONPATH=.:src ./.venv/bin/python -m pytest -q
```

Result: `1512 passed, 1 skipped`; four existing dependency deprecation warnings were emitted.

## Concerns

- No commit was created: the worktree contains unrelated pre-existing Task 1-5 and Task 7-8 changes, so committing would risk bundling other tasks.
- A real clean-install packaged QMD/voice smoke run is outside Task 6 and remains the Task 8 acceptance concern; the checks above are contract and test-suite verification.
