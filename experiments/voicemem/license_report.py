#!/usr/bin/env python3
"""Inventory the memory sidecar's dependencies and flag unresolved licenses.

The app's wheelhouse license report does not cover the sidecar's own venv, so
this script is the second inventory. Run it with the sidecar interpreter:

    "$HOME/.cache/speech-to-speech/voicemem-venv/bin/python" \
        experiments/voicemem/license_report.py --json /tmp/voicemem-licenses.json

It prints a deterministic summary (counts + the entries that need review) and
exits 1 when anything is unresolved, so it can gate a release checklist.
"""

from __future__ import annotations

import argparse
import importlib.metadata as metadata
import json
import re
import sys
from pathlib import Path

#: Classifiers or license strings that name a real license.
KNOWN = re.compile(
    r"(MIT|BSD|Apache|ISC|MPL|PSF|Python-2\.0|LGPL|GPL|Unlicense|Zlib|CC0|"
    r"Artistic|EPL|0BSD|PostgreSQL|Boost)",
    re.IGNORECASE,
)


def _field(meta: metadata.PackageMetadata, *names: str) -> str:
    for name in names:
        value = meta.get(name)
        if value:
            return str(value).strip()
    return ""


def _license_of(distribution: metadata.Distribution) -> tuple[str, str]:
    meta = distribution.metadata
    expression = _field(meta, "License-Expression")
    if expression:
        return expression, "License-Expression"
    declared = _field(meta, "License")
    if declared and len(declared) < 200:
        return declared, "License"
    classifiers = [value for value in meta.get_all("Classifier") or [] if value.startswith("License ::")]
    if classifiers:
        return "; ".join(classifiers), "Classifier"
    if declared:
        return "(long license text; no short name)", "License(long)"
    return "", ""


def collect() -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for distribution in metadata.distributions():
        name = distribution.metadata["Name"] or ""
        if not name:
            continue
        license_text, source = _license_of(distribution)
        rows.append(
            {
                "name": name,
                "version": distribution.version or "",
                "license": license_text,
                "source": source,
                "resolved": "yes" if KNOWN.search(license_text) else "no",
            }
        )
    return sorted(rows, key=lambda row: row["name"].lower())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", type=Path, default=None, help="write the full inventory here")
    args = parser.parse_args()

    rows = collect()
    unresolved = [row for row in rows if row["resolved"] == "no"]
    counts: dict[str, int] = {}
    for row in rows:
        key = row["license"] or "(none)"
        counts[key] = counts.get(key, 0) + 1

    print(f"packages: {len(rows)}")
    print(f"unresolved: {len(unresolved)}")
    for license_name, count in sorted(counts.items(), key=lambda item: (-item[1], item[0])):
        print(f"  {count:>4}  {license_name[:80]}")
    if unresolved:
        print("\nneeds review:")
        for row in unresolved:
            print(f"  {row['name']}=={row['version']} source={row['source'] or 'none'}")

    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(
            json.dumps({"packages": rows, "unresolved": unresolved}, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"\nwritten: {args.json}")
    return 1 if unresolved else 0


if __name__ == "__main__":
    sys.exit(main())
