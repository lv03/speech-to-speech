# Task 8 Report: Package Verification

## Status

Implemented the package-verification slice of the v4.5 QMD plan. The verifier now uses a fixed two-stage protocol: the Electron/Node verifier accepts explicit package, fixture, data-root, and smoke-model arguments, then starts the packaged Electron executable with `--package-verify --fixture --data-root --smoke-model`. The packaged main dispatch dynamically loads the built `packageVerify.js` entry.

## TDD Evidence

Focused behavior tests were added before the implementation. The initial focused run failed because the verifier entry points and package resource helpers were not implemented. After implementation and the final parser/configuration fixes:

```text
npx vitest run tests/verify-package.test.mjs
Result: PASS (1 file, 6 tests)

npm test
Result: PASS (Vitest: 15 files, 95 tests; Node: 9 tests)

npm run typecheck
Result: PASS

npm run build
Result: PASS; out/main/index.js and out/main/packageVerify.js emitted

PYTHONPATH=.:src ./.venv/bin/python -m pytest -q
Result: PASS (1507 passed, 1 skipped, 4 warnings)
```

The built main was also started by the Electron executable with a temporary app directory and the complete package-verification arguments. It reached the verifier resource phase and returned exactly `PACKAGE_VERIFY_FAILED:resources` with exit code 1, because this checkout has no real packaged runtime resources. This is direct evidence that `index.js -> packageVerify.js` dispatch is reachable; it is not a claim of package acceptance.

## Implementation

- `desktop/scripts/verify-package.mjs` requires explicit `--app`, `--fixture`, `--data-root`, and `--smoke-model` inputs, resolves only package resources, loads a native `.node` addon, and launches only the packaged Electron executable. It does not require `KB_FIXTURE_ROOT`, `KB_MODEL_ASSET_PATH`, or `PACKAGE_RESOURCES_ROOT`.
- `desktop/src/main/package-verify.ts` validates the relative-path HTTPS manifest, packaged QMD/Python/wheelhouse/native contracts, private QMD environment paths, temporary model installation/reuse, Chinese fixture presence, the QMD collection/index/embed/status/vector-query/get flow, QmdProxy, and packaged Python search/get tools. Success and failure output are fixed and contain no paths, commands, tokens, or docids.
- `desktop/src/main/index.ts` dispatches `--package-verify` to the bundled sibling entry before normal application initialization. `packageVerify.js` is included by `desktop/electron.vite.config.ts`; the verifier script and resources are included by `desktop/electron-builder.yml`.
- `.github/workflows/ci.yml` defines a manually triggered macOS arm64 smoke job requiring HTTPS runtime and model assets with SHA-256 checks. It rejects GGUF in the runtime bundle, uses the downloaded QMD resource bundle, pre-places the smoke model in temporary app-private userData, copies the fixture outside the repository, starts the verifier through the packaged executable with empty `PATH`, and never executes `verify-package.mjs` through system Node.
- `desktop/package.json` supports the external QMD bundle in the package smoke build. `desktop/README.md` documents that production packages contain no GGUF and that model download occurs only after user consent from the manifest URL.
- `desktop/tests/fixtures/kb-zh/*` contains the required exact Chinese allergy, project-notes, and malicious-instructions fixtures. `desktop/tests/verify-package.test.mjs` covers resource-root isolation, actual native addon loading, launch arguments, fixed output, fixture text, legacy-input rejection, and built-entry wiring contracts.

## Self-review

- `app.setPath('userData', dataRoot)` is executed before `app.whenReady()` and before package verification initializes paths. The verifier's model and all QMD HOME/XDG/config/cache/index/model paths are under the supplied temporary data root.
- Resource paths are resolved from `process.resourcesPath`; normal packaged startup reads the manifest from that same resources root. Development mode accepts only explicit `RUNTIME_MANIFEST_PATH` for the broader application runtime.
- The child launch preserves all required verifier arguments and removes legacy runtime-manifest/PATH discovery inputs. The outer verifier suppresses child output and emits only its fixed result line.
- The package smoke build uses the real downloaded QMD bundle and keeps GGUF outside package resources. No real runtime asset or GGUF was available locally, so no local command claims successful macOS package acceptance.

## Concerns

Real macOS arm64 package acceptance remains pending the manually supplied, version-matched runtime bundle and embedding GGUF smoke asset. The local tests verify the contracts and the actual Electron dispatch/resource failure boundary, but cannot replace the CI smoke with real QMD native resources, standalone Python, wheelhouse, and model data.
