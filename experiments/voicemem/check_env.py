#!/usr/bin/env python3
"""Gate 1 check: what would voicemem change in this environment?

Zero-install: it only runs ``uv pip install --dry-run`` (metadata resolution) and
compares the result against the distributions already installed in the target
interpreter. Nothing is downloaded or installed.

    ./.venv/bin/python experiments/voicemem/check_env.py
    ./.venv/bin/python experiments/voicemem/check_env.py --python .venv/bin/python --spec voicemem

Exit code is 0 for a report. Pass ``--strict`` to exit 1 when conflicts or new
packages are found (useful in a future gate script).
"""

from __future__ import annotations

import argparse
import importlib.metadata as metadata
import shutil
import subprocess
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class Resolution:
    installs: dict[str, str]
    removals: dict[str, str]


@dataclass(frozen=True)
class Report:
    required: dict[str, str]
    removals: dict[str, str]
    same: list[str]
    conflicting: list[tuple[str, str, str]]
    new: list[str]

    @property
    def verdict(self) -> str:
        if self.conflicting:
            return "in-place install is not safe: conflicting versions"
        if self.new:
            return "in-place install would add packages; a dedicated venv is still recommended"
        return "no change"


def resolve(spec: str, python: str | None = None) -> Resolution:
    """Return what uv would install and remove for *spec*."""
    uv = shutil.which("uv")
    if uv is None:
        raise SystemExit("uv is required for this check (it performs the dry-run resolution)")

    cmd = [uv, "pip", "install", "--dry-run"]
    if python:
        cmd += ["--python", python]
    cmd.append(spec)
    completed = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        sys.stderr.write(completed.stderr)
        raise SystemExit(f"resolution failed for {spec!r}")

    installs: dict[str, str] = {}
    removals: dict[str, str] = {}
    # uv writes the resolved package list to stderr (progress-style output), so
    # both streams are parsed.
    for line in (completed.stdout + completed.stderr).splitlines():
        line = line.strip()
        if line.startswith("+"):
            target = installs
        elif line.startswith("-"):
            target = removals
        else:
            continue
        entry = line.lstrip("+- ").strip()
        name, _, version = entry.partition("==")
        if name and version:
            target[name.lower()] = version
    return Resolution(installs=installs, removals=removals)


def installed() -> dict[str, str]:
    found: dict[str, str] = {}
    for distribution in metadata.distributions():
        name = (distribution.metadata["Name"] or "").lower()
        if name:
            found[name] = distribution.version
    return found


def compare(resolution: Resolution, have: dict[str, str]) -> Report:
    required = resolution.installs
    same = sorted(name for name in required if have.get(name) == required[name])
    conflicting = sorted(
        (name, have[name], required[name]) for name in required if name in have and have[name] != required[name]
    )
    new = sorted(name for name in required if name not in have)
    return Report(
        required=required,
        removals=resolution.removals,
        same=same,
        conflicting=conflicting,
        new=new,
    )


def render(report: Report, spec: str) -> str:
    lines = [
        f"spec: {spec}",
        "note: uv prints only the change set for the target interpreter; point --python at a",
        "      fresh venv to see the full dependency closure (112 packages for voicemem 0.2.3).",
        f"would install: {len(report.required)} packages",
        f"  already present, same version: {len(report.same)}",
        f"  already present, different version: {len(report.conflicting)}",
        f"  not present (new): {len(report.new)}",
        f"  would be replaced or removed: {len(report.removals)}",
        "",
        "version conflicts (repo -> spec):",
    ]
    lines += [f"  {name}: {have} -> {want}" for name, have, want in report.conflicting] or ["  (none)"]
    lines += ["", "new packages:"]
    lines += [f"  {name}=={report.required[name]}" for name in report.new] or ["  (none)"]
    if report.removals:
        lines += ["", "replaced/removed in place:"]
        lines += [f"  {name}=={version}" for name, version in sorted(report.removals.items())]
    lines += ["", f"verdict: {report.verdict}"]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spec", default="voicemem", help="package spec to resolve (default: voicemem)")
    parser.add_argument("--python", default=None, help="interpreter uv should resolve for")
    parser.add_argument("--strict", action="store_true", help="exit 1 on conflicts or new packages")
    args = parser.parse_args()

    report = compare(resolve(args.spec, args.python), installed())
    print(render(report, args.spec))
    if args.strict and (report.conflicting or report.new):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
