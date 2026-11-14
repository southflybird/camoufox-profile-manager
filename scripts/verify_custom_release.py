"""Check that a custom tag and all package versions identify the same build."""

import argparse
import json
import re
from pathlib import Path

import tomllib

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag")
    args = parser.parse_args()
    version = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"][
        "version"
    ]
    match = re.fullmatch(r"(\d+\.\d+\.\d+)\+southflybird\.([1-9]\d*)", version)
    if match is None:
        raise SystemExit("Expected a version such as 0.7.0+southflybird.1")
    expected = f"custom-v{match[1]}-r{match[2]}"
    package = json.loads((ROOT / "web/package.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "web/package-lock.json").read_text(encoding="utf-8"))
    uv_lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
    python_lock = next(
        item["version"] for item in uv_lock["package"] if item["name"] == "camoufox-profile-manager"
    )
    if {package["version"], lock["version"], lock["packages"][""]["version"], python_lock} != {
        version
    }:
        raise SystemExit("Python/npm/lockfile versions do not match")
    if args.tag and args.tag != expected:
        raise SystemExit(f"Tag must be {expected}")
    print(f"Custom release verified: {expected} ({version})")


if __name__ == "__main__":
    main()
