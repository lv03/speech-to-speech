Task 3: complete (commits 1661c88..6693ea2, review clean)
Task 4: complete (commit 320ddd2; review fix 9eaaa78; focused tests and typecheck pass)
Task 5: complete (commit bd233b8; review fix 6e72e57; focused tests and typecheck pass)
Task 6: complete (Python knowledge tools and security boundaries)
Task 7: complete (RuntimeManager, QMD lifecycle, IPC and renderer state)
Task 8 implementation: complete (packaged verifier, runtime manifest, wheelhouse and license gates)
Post-plan increment: complete (dfa4be4 hybrid profile approval, fa278bd three-tier retrieval vec-only/hybrid/full, 6d251fe embedding mirror fallback to hf-mirror; dev-only hybrid manifest, packaged path still requires a signed manifest)
VoiceMem pre-research: started 2026-09-08 in `experiments/voicemem/` (adapter + 15 mock tests, gate-1 env check, gate-5 Chinese smoke, INTEGRATION_NOTES/GATES). No dependency, model, network or storage is introduced; v1 runtime and tool list untouched. Maintainer deferred a formal release, so gate pre-research no longer waits on Task 8.
Plan: docs/kb-memory-integration-proposal.md v4.9 is the final implementation baseline (5.4 records the hybrid/full modes, budgets and the four remaining release gates).
Current release blockers: legal review/source obligations for `espeakng-loader` 0.2.4, real HTTPS runtime/model inputs, CI manifest keys, and Apple signing/notarization. The local locked wheelhouse closure and all desktop/Python test suites pass (2026-09-08: `npm test` PASS; `pytest -q` 1511 passed, 2 skipped).
