# Task 8 Report: Package Verification

## Status

Implemented the package-verification slice of the v4.7 QMD plan. The verifier now uses a fixed two-stage protocol: the Electron/Node verifier accepts explicit package, fixture, data-root, smoke-model, and optional metrics arguments, then starts the packaged Electron executable with `--package-verify --fixture --data-root --smoke-model`. The packaged main dispatch dynamically loads the built `packageVerify.js` entry.

## TDD Evidence

Focused behavior tests were added before the implementation. The initial focused run failed because the verifier entry points and package resource helpers were not implemented. After implementation and the final parser/configuration fixes:

```text
npm test
Result: PASS (19 Vitest files, 137 tests; 9 Node tests)

npm run typecheck
Result: PASS

npm run build
Result: PASS; out/main/index.js and out/main/packageVerify.js emitted

PYTHONPATH=.:src ./.venv/bin/python -m pytest -q
Result: PASS (1512 passed, 1 skipped, 4 warnings)
```

The packaged arm64 app was also started by its own Electron executable with an external fixture, temporary app-private data root, empty child `PATH`, and the real Qwen3 embedding GGUF. A fresh clean-root run returned `PACKAGE_VERIFY_OK` with exit code 0 and wrote a sanitized metrics sidecar; this is staging evidence only and does not include release signing or notarization.

## Implementation

- `desktop/scripts/verify-package.mjs` requires explicit `--app`, `--fixture`, `--data-root`, and `--smoke-model` inputs, optionally passes a metrics sidecar path, resolves only package resources, loads a native `.node` addon, and launches only the packaged Electron executable. It does not require `KB_FIXTURE_ROOT`, `KB_MODEL_ASSET_PATH`, or `PACKAGE_RESOURCES_ROOT`.
- `desktop/src/main/package-verify.ts` validates the relative-path HTTPS manifest, packaged QMD/Python/wheelhouse/native contracts, private QMD environment paths, temporary model installation/reuse, Chinese fixture presence, the QMD collection/index/embed/status/vector-query/get flow, QmdProxy, and packaged Python search/get tools. Success and failure output are fixed and contain no paths, commands, tokens, or docids.
- `desktop/src/main/package-verify.ts` also writes an optional sanitized metrics sidecar with phase durations, hot-query P50/P95, app-private data size, and verifier RSS; it does not include paths, tokens, or document IDs.
- `desktop/src/main/index.ts` dispatches `--package-verify` to the bundled sibling entry before normal application initialization. `packageVerify.js` is included by `desktop/electron.vite.config.ts`; the verifier script and resources are included by `desktop/electron-builder.yml`.
- `.github/workflows/ci.yml` defines a manually triggered macOS arm64 smoke job requiring HTTPS runtime and model assets with SHA-256 checks. It rejects GGUF in the runtime bundle, uses the downloaded QMD resource bundle, pre-places the smoke model in temporary app-private userData, copies the fixture outside the repository, starts the verifier through the packaged executable with empty `PATH`, and never executes `verify-package.mjs` through system Node.
- `desktop/package.json` supports the external QMD bundle in the package smoke build. `desktop/README.md` documents that production packages contain no GGUF and that model download occurs only after user consent from the manifest URL.
- `desktop/tests/fixtures/kb-zh/*` contains the required exact Chinese allergy, project-notes, and malicious-instructions fixtures. `desktop/tests/verify-package.test.mjs` covers resource-root isolation, actual native addon loading, launch arguments, fixed output, fixture text, legacy-input rejection, and built-entry wiring contracts.
- `desktop/scripts/build-runtime.mjs` verifies the detached signature of both file and JSON runtime asset inputs before signing the final manifest. `desktop/scripts/generate-license-report.mjs` generates deterministic npm/wheelhouse inventory files and fails on unresolved licenses. The current local staging wheelhouse contains 126 packages, and `desktop/scripts/validate-runtime-wheelhouse.mjs` accepts exactly the 125-package locked base closure plus the application wheel. The license report now has one unresolved Python entry, `espeakng-loader 0.2.4`; its exact PyPI wheel hash and embedded eSpeak NG source commit are recorded in `docs/kb-runtime-release.md`, but legal review and source/notice obligations remain open.

## Self-review

- `app.setPath('userData', dataRoot)` is executed before `app.whenReady()` and before package verification initializes paths. The verifier's model and all QMD HOME/XDG/config/cache/index/model paths are under the supplied temporary data root.
- Resource paths are resolved from `process.resourcesPath`; normal packaged startup reads the manifest from that same resources root. Development mode accepts only explicit `RUNTIME_MANIFEST_PATH` for the broader application runtime.
- The child launch preserves all required verifier arguments and removes legacy runtime-manifest/PATH discovery inputs. The outer verifier suppresses child output and emits only its fixed result line.
- The CI smoke job uploads `package-metrics.json` and runs the license inventory before packaging. The metrics file records verifier RSS and app-private data size; voice/QMD RSS and artifact sizes remain release-owner measurements.
- The package smoke build uses the real downloaded QMD bundle and keeps GGUF outside package resources. The local staging build uses real standalone Python, the locked candidate wheelhouse, QMD native resources, a real embedding GGUF, and a temporary Ed25519 manifest key.

## Concerns

The local clean-root package verifier now covers the real QMD/native/Python/model chain. Formal release acceptance remains pending the manually supplied versioned runtime bundle, CI trust keys, reviewed license terms, and Apple signing/notarization.

The complete local desktop and Python suites now pass. Real macOS 15+ arm64 package acceptance remains pending the manually supplied runtime bundle, embedding GGUF asset, reviewed license terms, CI signing secrets, and Apple signing/notarization.
