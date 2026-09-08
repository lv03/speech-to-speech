Task 3: complete (commits 1661c88..6693ea2, review clean)
Task 4: complete (commit 320ddd2; review fix 9eaaa78; focused tests and typecheck pass)
Task 5: complete (commit bd233b8; review fix 6e72e57; focused tests and typecheck pass)
Task 6: complete (Python knowledge tools and security boundaries)
Task 7: complete (RuntimeManager, QMD lifecycle, IPC and renderer state)
Task 8 implementation: complete (packaged verifier, runtime manifest, wheelhouse and license gates)
Post-plan increment: complete (dfa4be4 hybrid profile approval, fa278bd three-tier retrieval vec-only/hybrid/full, 6d251fe embedding mirror fallback to hf-mirror; dev-only hybrid manifest, packaged path still requires a signed manifest)
Plan: docs/kb-memory-integration-proposal.md v4.9 is the final implementation baseline (5.4 records the hybrid/full modes, budgets and the four remaining release gates).
Current release blockers: legal review/source obligations for `espeakng-loader` 0.2.4, real HTTPS runtime/model inputs, CI manifest keys, and Apple signing/notarization. The local locked wheelhouse closure and all desktop/Python test suites pass (2026-09-08: `npm test` PASS; `pytest -q` 1511 passed, 2 skipped).
