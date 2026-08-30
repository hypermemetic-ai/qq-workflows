#!/usr/bin/env python3
"""Create the disclosed qq-ui smoke fixture as an exact deterministic Git object.

The source repository must already contain the landed task commit and its parent.
Only the overview-sentinel condition is removed; fixed commit-tree metadata makes
both the tree and commit IDs reproducible.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path
import subprocess
import tempfile

BASE = "75ec8941d813e1d83038149682b1aa953e8e36c5"
LANDED = "e9ed42ee05c2de6fcbed80575e029cca3949da0c"
PATH = "assets/browser-v9.js"
OLD = b"if (!projectsScope && project && liveTrackerProjectFilter !== LIVE_TRACKER_OVERVIEW) {"
NEW = b"if (!projectsScope && project) {"
EXPECTED_BLOB = "a0587f6b1a14b8e4bc77aa15e8ead321975ee8e9"
EXPECTED_TREE = "bf1ea815e420721f331692b506c0f768780bf2f5"
EXPECTED_COMMIT = "2904675f2025d0c8bf8a597d055ea4ddd927f645"
MESSAGE = b"benchmark fixture: remove overview sentinel guard\n"
IDENTITY_ENV = {
    "GIT_AUTHOR_NAME": "qq benchmark fixture",
    "GIT_AUTHOR_EMAIL": "benchmark@invalid",
    "GIT_AUTHOR_DATE": "2000-01-01T00:00:00+0000",
    "GIT_COMMITTER_NAME": "qq benchmark fixture",
    "GIT_COMMITTER_EMAIL": "benchmark@invalid",
    "GIT_COMMITTER_DATE": "2000-01-01T00:00:00+0000",
}


def git_env(**extra: str) -> dict[str, str]:
    value = {key: item for key, item in os.environ.items() if not key.startswith("GIT_")}
    value.update({
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_TERMINAL_PROMPT": "0",
        **extra,
    })
    return value


def git(repository: Path, *args: str, data: bytes | None = None,
        env: dict[str, str] | None = None) -> bytes:
    result = subprocess.run(
        ["git", "-C", str(repository), *args], input=data,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=env or git_env(), check=False,
    )
    if result.returncode:
        raise RuntimeError(
            f"git {' '.join(args)} failed ({result.returncode}): "
            f"{result.stderr.decode('utf-8', 'replace').strip()}"
        )
    return result.stdout


def provision(repository: Path) -> dict[str, str]:
    repository = repository.resolve()
    for oid in (BASE, LANDED):
        actual = git(repository, "rev-parse", f"{oid}^{{commit}}").decode().strip()
        if actual != oid:
            raise RuntimeError(f"required source commit unavailable: {oid}")
    original = git(repository, "show", f"{LANDED}:{PATH}")
    if original.count(OLD) != 1:
        raise RuntimeError("landed source does not contain exactly the expected sentinel guard")
    mutated = original.replace(OLD, NEW)
    blob = git(repository, "hash-object", "-w", "--stdin", data=mutated).decode().strip()
    if blob != EXPECTED_BLOB:
        raise RuntimeError(f"synthetic blob mismatch: {blob}")

    with tempfile.TemporaryDirectory(prefix="qq-ui-benchmark-index-") as directory:
        index = str(Path(directory) / "index")
        environment = git_env(GIT_INDEX_FILE=index)
        git(repository, "read-tree", LANDED, env=environment)
        git(repository, "update-index", "--cacheinfo", f"100644,{blob},{PATH}", env=environment)
        tree = git(repository, "write-tree", env=environment).decode().strip()
    if tree != EXPECTED_TREE:
        raise RuntimeError(f"synthetic tree mismatch: {tree}")
    commit = git(
        repository, "commit-tree", tree, "-p", BASE, data=MESSAGE,
        env=git_env(**IDENTITY_ENV),
    ).decode().strip()
    if commit != EXPECTED_COMMIT:
        raise RuntimeError(f"synthetic commit mismatch: {commit}")
    return {"base": BASE, "landed": LANDED, "blob": blob, "tree": tree, "commit": commit}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, required=True)
    args = parser.parse_args()
    state = provision(args.repository)
    for key, value in state.items():
        print(f"{key}={value}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
