# KB v1 Runtime Release Runbook

This runbook is the operational companion to `docs/kb-memory-integration-proposal.md`. It applies only to the macOS 15+ arm64 `vec-only` release. A local staging build with smoke assets is not a release candidate until every gate below has evidence.

## Required Inputs

The release runner must receive all of these inputs before building:

```text
RUNTIME_ASSETS_FILE
RUNTIME_ASSETS_SIGNATURE_FILE
RUNTIME_ASSETS_ROOT
QMD_BUNDLE_DIR
SMOKE_MODEL_PATH
```

`RUNTIME_ASSETS_FILE` describes the same standalone Python, locked wheelhouse, QMD resources and embedding model version that are being tested. Its detached Ed25519 signature must verify with the public key used to build the application. The model remains outside the installation package and is copied into temporary app-private user data only for the clean-machine verifier.

The manifest must contain real HTTPS URLs, positive sizes, lowercase SHA-256 digests, `platform: darwin-arm64`, and `approvedProfiles: ["vec-only"]`. Placeholder, loopback, reserved `.invalid`/`.test`/`.localhost`/`.local`/`example.com` endpoints, or unsigned inputs stop the build.

## Build And Inventory

From the repository root, after CI has populated the inputs and signing-key files:

```bash
npm ci --prefix desktop --no-audit --no-fund
QMD_BUNDLE_DIR="$QMD_BUNDLE_DIR" \
  RUNTIME_ASSETS_FILE="$RUNTIME_ASSETS_FILE" \
  RUNTIME_ASSETS_SIGNATURE_FILE="$RUNTIME_ASSETS_SIGNATURE_FILE" \
  RUNTIME_ASSETS_ROOT="$RUNTIME_ASSETS_ROOT" \
  RUNTIME_MANIFEST_PUBLIC_KEY_FILE="$RUNTIME_MANIFEST_PUBLIC_KEY_FILE" \
  RUNTIME_MANIFEST_PRIVATE_KEY_FILE="$RUNTIME_MANIFEST_PRIVATE_KEY_FILE" \
  npm --prefix desktop run dist:mac

npm --prefix desktop run license-report \
  -- --node-modules build/qmd-resources/node_modules \
  --wheelhouse build/runtime/wheelhouse
```

The license command writes `desktop/build/licenses.json` and `desktop/build/THIRD-PARTY-NOTICES.md`. It fails if any packaged npm package or Python wheel has no usable license declaration. The release owner must additionally review model and standalone-runtime license terms and ship the full license texts/notices required by those terms; the generated inventory is not a substitute for them.

An old local staging wheelhouse may contain optional voice/development extras and must not be used as a release input. The current local `desktop/build/runtime/wheelhouse` has been synchronized to the CPython 3.11 macOS arm64 candidate: 126 wheels, consisting of the 125-package locked base closure plus the application wheel. `validate-runtime-wheelhouse.mjs` passes for this directory, and it contains no `funasr`, `kaldiio`, `aiortc`, `google-crc32c`, or duplicate `soxr` wheel. This is reproducible local staging, not yet the signed runtime bundle consumed by the release job.

The candidate license report has one unresolved Python package: `espeakng-loader 0.2.4`. Its PyPI wheel has no license metadata or bundled license file. The release owner must verify the exact source provenance, identify the license for the packaged eSpeak NG library/data, and ship the required license text/notices before clearing this gate. The upstream repository's declared license alone is not sufficient evidence for this exact wheel, and the report must remain failing until that review is recorded.

The current provenance evidence is:

```text
PyPI package: espeakng-loader 0.2.4
macOS arm64 wheel SHA-256: d27cdca31112226e7299d8562e889d3e38a1e48055c9ee381b45d669072ee59f
wrapper source commit: thewh1teagle/espeakng-loader@146599e29be31bf17d99f0bcb7dbb2f92aef3d95
embedded espeak-ng submodule: espeak-ng/espeak-ng@4870adfa25b1a32b4361592f1be8a40337c58d6c (tag 1.52.0)
embedded espeak-ng license: GPL-3.0-or-later (COPYING at the submodule commit)
```

The wrapper source commit does not contain a license file, and its package build workflow fetches separate release archives for the native library and data. Before release, the owner must verify that those archives correspond to the wheel above, include the GPL source offer or corresponding source required by the GPL terms, and include a notice for the wrapper and all bundled eSpeak NG content. Do not add a permissive license override to the generated inventory without that review.

The source-by-source evidence is recorded in [`docs/research/espeakng-loader-license-evidence.md`](research/espeakng-loader-license-evidence.md). That record is intentionally not a legal approval; the generated license report must remain failing until the release decision is recorded.

The latest local clean-root smoke on 2026-09-07 returned `PACKAGE_VERIFY_OK` with 20 hot-query samples: P50 `27.1 ms`, P95 `27.9 ms`, cold start `4.95 s`, verifier RSS `240 MiB`, and app-private data-root size about `2.25 GB`. The generated local DMG and ZIP were approximately `657.5 MB` and `659.7 MB`; they are staging artifacts without Developer ID signing or notarization and are not release candidates.

The v1 Python wheelhouse must be generated from the locked base dependency set only. Use `uv export --frozen --no-dev --no-editable --no-emit-project` without `--extra`, `--all-extras`, or optional dependency groups, then build the application wheel separately and resolve its base dependencies for CPython 3.11 on macOS 15 arm64. Run the wheel downloader with that target standalone CPython 3.11 as well; a Python 3.9 downloader with `--python-version 3.11` can still evaluate environment markers using 3.9 and silently select the wrong lock branches. Do not copy all wheels from a developer environment. `funasr`/`kaldiio` belong to the optional `paraformer` path, and `aiortc`/`google-crc32c` belong to the optional `webrtc` path; neither is part of the v1 default runtime.

The smoke job also runs `pip install --dry-run --ignore-installed --pre --no-index --find-links` against that exported requirements file and writes a resolver report. `--ignore-installed` is required because the standalone interpreter's bundled `pip`/`packaging` packages must not hide requirements from the report. `desktop/scripts/validate-runtime-wheelhouse.mjs` compares every wheel's METADATA against the report, allowing only the resolved base closure plus the application wheel. Missing wheels, extra optional/development wheels, duplicate package names, and version mismatches fail before packaging. This check is stronger than a denylist and also catches duplicate platform wheels such as two `soxr` distributions.

The packaged Python venv fingerprint includes the contents of every wheel in the wheelhouse. Adding, removing, or replacing a dependency wheel therefore forces a fresh offline install instead of reusing an incompatible private venv.


## Manifest Key Rotation

The application embeds exactly one Ed25519 public key at build time. The private key is never committed, placed in the runtime bundle, or included in the app resources. CI stores it only in a protected secret and writes it to a runner-temporary file with mode `0600`.

Rotate keys as an application release operation:

1. Generate a new Ed25519 key pair offline and record the SHA-256 fingerprint of the public SPKI DER bytes in the release record.
2. Configure the new private/public pair in CI and build the application so the new public key is embedded.
3. Sign the runtime input manifest and final packaged manifest with the new private key.
4. Run the clean macOS 15+ arm64 verifier, then publish the new signed app before using manifests signed by the new key for that app version.
5. Retire the old private key. Older app versions continue to trust only the public key they embedded; there is no remote key fallback or silent trust migration.

Do not accept a public key supplied by a remote manifest. If a future release needs a dual-key transition, it must be an explicit versioned application change with tests for both the old and new trust paths.

## Apple Signing And Notarization

The shared electron-builder configuration must not disable signing or notarization. Without signing credentials, a local build may remain unsigned; the release job must provide the protected Developer ID identity through electron-builder's code-signing environment and Apple notarization credentials through the documented `APPLE_*` environment variables. CI must verify both the artifact and the installed app:

```bash
codesign --verify --deep --strict --verbose=2 "speech-to-speech.app"
spctl --assess --type execute --verbose=4 "speech-to-speech.app"
xcrun stapler validate "speech-to-speech.dmg"
```

The exact identity, Team ID, certificate storage and notarization credentials are release-environment inputs. They must not be added to the repository or simulated with a self-signed certificate.

## Final Gate

The manually triggered `desktop-package-smoke` workflow must pass on macOS 15 arm64 with real URLs and SHA-256 inputs. Its verifier must run with an empty `PATH`, temporary `HOME`, no repository `.venv`, no system Node/Python, and a fixture copied outside the checkout. It must complete:

```text
collection add -> update -> embed -> status -> vec query -> get
QmdProxy search/get -> packaged Python search/get
```

The release record must attach the verifier result, the generated `package-metrics.json`, application signature/notarization evidence, license inventory and these measurements: DMG/ZIP size, model download size, model disk size, cold start, verifier RSS, voice RSS, QMD RSS, and hot-query P50/P95. The v1 hot-query P95 target is `<=300ms`; voice/QMD RSS and artifact sizes remain release-owner measurements because the verifier sidecar only records process RSS and app-private data size.

Until this gate passes, the release remains an implementation-complete staging build rather than a publishable v1 candidate.
