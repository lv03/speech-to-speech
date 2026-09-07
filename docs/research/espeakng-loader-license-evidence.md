# espeakng-loader 0.2.4 License Evidence

Checked: 2026-09-07

This note records provenance evidence for the exact macOS arm64 wheel currently
selected by the v1 runtime closure. It is an evidence record, not legal advice
and not an approval to redistribute the wheel.

## Exact Artifact

- PyPI project metadata: <https://pypi.org/pypi/espeakng-loader/0.2.4/json>
- Wheel: `espeakng_loader-0.2.4-py3-none-macosx_11_0_arm64.whl`
- Wheel URL: <https://files.pythonhosted.org/packages/a8/26/258c0cd43b9bc1043301c5f61767d6a6c3b679df82790c9cb43a3277b865/espeakng_loader-0.2.4-py3-none-macosx_11_0_arm64.whl>
- Size: `9,892,565` bytes
- SHA-256: `d27cdca31112226e7299d8562e889d3e38a1e48055c9ee381b45d669072ee59f`

The wheel METADATA contains the package name, version, description, author
email, Python requirement, and README text, but no `License` or
`License-Expression` field. The wheel also contains no `LICENSE`, `COPYING`, or
`NOTICE` file. The absence of a metadata declaration does not establish a
permissive license.

## Wrapper Source

- Exact source commit: [`146599e29be31bf17d99f0bcb7dbb2f92aef3d95`](https://github.com/thewh1teagle/espeakng-loader/commit/146599e29be31bf17d99f0bcb7dbb2f92aef3d95)
- Source tree at that commit: <https://api.github.com/repos/thewh1teagle/espeakng-loader/git/trees/146599e29be31bf17d99f0bcb7dbb2f92aef3d95?recursive=1>
- Build metadata: <https://raw.githubusercontent.com/thewh1teagle/espeakng-loader/146599e29be31bf17d99f0bcb7dbb2f92aef3d95/pyproject.toml>
- Build workflow: <https://raw.githubusercontent.com/thewh1teagle/espeakng-loader/146599e29be31bf17d99f0bcb7dbb2f92aef3d95/.github/workflows/build.yml>

The wrapper source describes itself as a shared-library loader and does not
declare a license in `pyproject.toml`. Its build workflow checks out eSpeak NG
tag `1.52.0`, builds the native library, builds the data archive, and places
those artifacts into platform wheels. The wrapper repository source and the
PyPI wheel therefore need separate review: the upstream eSpeak license does
not automatically determine the wrapper's license.

## Embedded eSpeak NG

- Upstream release commit: [`4870adfa25b1a32b4361592f1be8a40337c58d6c`](https://github.com/espeak-ng/espeak-ng/commit/4870adfa25b1a32b4361592f1be8a40337c58d6c)
- Upstream README license section: <https://raw.githubusercontent.com/espeak-ng/espeak-ng/4870adfa25b1a32b4361592f1be8a40337c58d6c/README.md>
- GPL text at the commit: <https://raw.githubusercontent.com/espeak-ng/espeak-ng/4870adfa25b1a32b4361592f1be8a40337c58d6c/COPYING>

The upstream README states that eSpeak NG is released under GPL version 3 or
later and separately identifies the NetBSD-derived Windows `getopt` code as
2-clause BSD. The exact wheel contains the eSpeak NG shared library and
`espeak-ng-data`; the release package must therefore carry the applicable
copyright notices and license texts for the embedded components.

## Release Decision Still Required

The license gate must remain failing until the release owner or counsel has
recorded all of the following:

1. The license or permission governing the wrapper source at the exact commit.
2. Confirmation that the wheel's native library and data correspond to the
   cited eSpeak NG source and release artifacts.
3. The required eSpeak NG source or corresponding-source offer for the chosen
   distribution form, plus all required notices and license texts.
4. Whether the wrapper and embedded data introduce additional copyright or
   redistribution terms.

Do not replace the empty license field with `MIT`, `Apache-2.0`, or a guessed
GPL expression in the generated inventory. Once the review is complete, the
reviewed decision should be represented in the release record and the shipped
notices, with the generated inventory still retaining the exact wheel hash.
