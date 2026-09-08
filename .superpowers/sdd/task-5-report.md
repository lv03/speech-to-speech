# Task 5 Report: SecretStore, IPC, and Knowledge Settings

## Status

Implemented and committed as a focused Task 5 change. Task 7 remains the owner of runtime download, daemon lifecycle, and progress wiring; Task 5 exposes the validated UI and IPC boundary it will consume.

## TDD Evidence

### RED

Before production code, the focused tests were added and run:

```text
npm --prefix desktop run test:vitest -- tests/settings-secrets.test.mjs tests/knowledge-ipc.test.mjs
```

The run failed as expected:

- `settings-secrets.test.mjs` could not import the missing `secret-store` module.
- `knowledge-ipc.test.mjs` reported `createKnowledgeIpcHandlers is not a function` after Electron startup was isolated with a test stub.

The IPC test then exposed the explicit first-download confirmation guard. The test was updated to assert rejection without confirmation and success after confirmation.

### GREEN

After implementation:

```text
npm --prefix desktop run test:vitest -- tests/settings-secrets.test.mjs tests/knowledge-ipc.test.mjs
Result: PASS (2 files, 3 tests)

npm --prefix desktop run typecheck
Result: PASS

npm --prefix desktop run test:vitest -- tests/settings-secrets.test.mjs tests/knowledge-ipc.test.mjs tests/qmd-service.test.mjs tests/qmd-proxy-contract.test.mjs tests/qmd-indexer.test.mjs tests/model-store.test.mjs
Result: PASS (6 files, 21 tests)

npm --prefix desktop run test:node
Result: PASS (6 tests)

npm --prefix desktop test -- tests/settings-secrets.test.mjs tests/knowledge-ipc.test.mjs
Result: PASS (Vitest: 11 files, 35 tests; Node test: 6 tests)
```

## Changed Files

- `desktop/src/main/secret-store.ts`: Electron `safeStorage` encrypted secret persistence with atomic file replacement.
- `desktop/src/main/settings.ts`: removes `llmApiKey` from public persisted settings, excludes renderer key fields, and migrates a legacy plaintext value only after encrypted persistence succeeds.
- `desktop/src/main/index.ts`: initializes and uses SecretStore; returns only `llmApiKeyPresent`; registers the fixed settings and knowledge IPC contract; opens the directory picker only in main; validates opaque collection IDs; returns sanitized collection summaries.
- `desktop/src/preload/index.ts`, `desktop/src/renderer/env.d.ts`: expose the narrow secret and knowledge APIs.
- `desktop/src/renderer/settings.html`, `desktop/src/renderer/settings.ts`, `desktop/src/renderer/settings.css`: replace key repopulation with presence/clear behavior and add the knowledge tab, collection controls, explicit first-download confirmation, retry, and non-destructive delete-index wording.
- `desktop/tests/settings-secrets.test.mjs`: legacy migration, ciphertext-only secret file, and public-settings separation tests.
- `desktop/tests/knowledge-ipc.test.mjs`: main-owned directory selection, opaque-ID validation, public snapshot filtering, and consent tests.

## Self-Review

- Public settings never contain `llmApiKey`; the renderer gets only `llmApiKeyPresent` and never receives a saved key value.
- Legacy plaintext values move to safeStorage-backed ciphertext before the settings JSON is atomically rewritten. Migration failures do not return or log the key.
- Knowledge IPC does not accept collection names or directories from the renderer. `knowledge:add-collection` invokes Electron's directory dialog in main, while mutation calls accept only a validated generated collection ID.
- Snapshot sanitization omits QMD state reasons, internal collection masks, tokens, docids, and QMD paths. The settings page renders only collection display name, canonical directory, state, and model download/disk state.
- Delete-index UI text explicitly states that source files are not deleted.

## Concerns

- Task 7 must replace Task 5's provisional model-status and cancel providers with RuntimeManager's real manifest size, disk usage, download progress, and cancellation hook. Task 5 deliberately does not start downloads or QMD daemons.
- If Electron safeStorage is unavailable, legacy plaintext is retained rather than discarded so the credential is not lost; remote voice startup is rejected until secure storage is available.
