# SPDX-License-Identifier: AGPL-3.0-or-later
"""Fail CI if ScanCode detected a license in our source that is neither ours
(AGPL-3.0) nor plainly permissive — a heuristic flag for code that may have been
copied from a differently-licensed open-source project.

Usage: python3 check_scancode_licenses.py scancode.json

The allowlist is intentionally explicit. The first runs may surface license
keys to triage; add genuinely-acceptable ones here (see docs/PLAN.md § Licensing).
"""
import json
import re
import sys

# ScanCode license keys we accept in our own source: our project license (AGPL)
# plus common permissive licenses. Anything else (GPL/LGPL/MPL/EPL/CDDL/SSPL/
# CC-BY-SA/proprietary/unknown, etc.) is treated as a provenance red flag.
ALLOWED = {
    "agpl-3.0", "agpl-3.0-plus", "agpl-3.0-only", "agpl-3.0-or-later",
    "mit", "mit-0", "isc", "0bsd", "bsd-zero-clause",
    "bsd-new", "bsd-simplified", "bsd-2-clause", "bsd-3-clause",
    "apache-2.0", "cc0-1.0", "unlicense", "blueoak-1.0.0",
    "python", "python-2.0", "zlib", "wtfpl-2.0", "cc-by-4.0",
    # ScanCode "clue" keys that are not actual third-party licenses:
    "unknown-spdx", "unknown-license-reference", "warranty-disclaimer",
    "other-permissive", "free-unknown", "public-domain", "public-domain-disclaimer",
    "spdx-license-identifier",
}

SPLIT = re.compile(r"\s+(?:and|or|with)\s+|[()]", re.IGNORECASE)


def keys_from_expression(expr):
    if not expr:
        return []
    return [t.strip().lower() for t in SPLIT.split(str(expr)) if t.strip()]


def collect(file_obj):
    """Pull every license key we can find from a ScanCode file record, across
    schema variants (v32 license_detections / detected_license_expression, and
    the older licenses[].key)."""
    keys = set()
    keys.update(keys_from_expression(file_obj.get("detected_license_expression")))
    keys.update(keys_from_expression(file_obj.get("detected_license_expression_spdx")))
    for det in file_obj.get("license_detections", []) or []:
        keys.update(keys_from_expression(det.get("license_expression")))
    for lic in file_obj.get("licenses", []) or []:  # older schema
        if lic.get("key"):
            keys.add(str(lic["key"]).lower())
    return keys


def main(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)

    findings = []
    for f in data.get("files", []):
        if f.get("type") != "file":
            continue
        for key in collect(f):
            if key and key not in ALLOWED:
                findings.append((f.get("path", "?"), key))

    if findings:
        print("✗ License/provenance gate: detected non-permitted license clues in source:")
        for path_, key in sorted(set(findings)):
            print(f"    {path_}: {key}")
        print(
            "\nIf a finding is a genuine, compatible license (or a false positive), add its "
            "ScanCode key to ALLOWED in this script. If it's copied third-party code, remove it."
        )
        return 1

    print("✓ License/provenance gate: no non-permitted license clues found in source.")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "scancode.json"))
