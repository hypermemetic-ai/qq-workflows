#!/usr/bin/env python3
"""Stock qq Mini QA launcher over the pinned DSH headless runtime."""
from __future__ import annotations
import json
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
PLUGIN = HERE / "qq-arm-plugin"
PROFILE_NAME = "benchmark-mini-qa"
CORE_PACKAGE = "@hypermemetic-ai/qq-core"
REQUIRED = (
    "BENCH_REPOSITORY", "BENCH_HEAD", "BENCH_TASK_PATH", "BENCH_OUTPUT_DIR",
    "BENCH_QQ_CORE_SOURCE", "BENCH_QQ_MODELS_SOURCE", "BENCH_QQ_DSH_HOME",
)


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"qq launcher requires {name}")
    return value


def link(target: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.symlink_to(target, target_is_directory=True)


def validate_core_source(core: Path) -> Path:
    """Return the production host overlay after checking its package identity."""
    manifest_path = core / "package.json"
    host_patch = core / "host.patch.yml"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("pinned qq-core package metadata is unavailable") from error
    if manifest.get("name") != CORE_PACKAGE or not host_patch.is_file():
        raise RuntimeError("pinned qq-core package or host patch is incomplete")
    return host_patch


def materialize_profile(profile: Path, core: Path, models: Path) -> Path:
    """Build the private profile and return its post-core headless overlay."""
    profile.mkdir(parents=True, mode=0o700)
    manifest = {
        "name": "dsh-profile-benchmark-mini-qa",
        "private": True,
        "dependencies": {
            CORE_PACKAGE: f"link:{core}",
            "@hypermemetic-ai/qq-models": f"link:{models}",
            "@hypermemetic-ai/qq-benchmark-mini-qa": f"link:{PLUGIN}",
        },
        "dsh": {"profile": {"bundles": [
            "@deepseek-ai/dsh-base",
            "@deepseek-ai/dsh-headless",
            "@hypermemetic-ai/qq-models",
            "@hypermemetic-ai/qq-benchmark-mini-qa",
        ]}},
    }
    (profile / "package.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    link(core, profile / "node_modules" / "@hypermemetic-ai" / "qq-core")
    link(models, profile / "node_modules" / "@hypermemetic-ai" / "qq-models")
    link(PLUGIN, profile / "node_modules" / "@hypermemetic-ai" / "qq-benchmark-mini-qa")
    (profile / "cordis.patch.yml").write_text(
        "- id: agent-default-model\n"
        "  config:\n"
        "    provider: xai-auth\n"
        "    model: grok-4.6\n",
        encoding="utf-8",
    )
    # qq-core's production patch is applied after the profile, exactly as bin/qq
    # applies it. Restore one-shot headless policy after that overlay: the core
    # service remains live, while no daily-host web port or HMR watcher is opened.
    headless_patch = profile / "after-qq-core.patch.yml"
    headless_patch.write_text(
        "- id: hmr\n"
        "  disabled: true\n"
        "- id: qq-webserver\n"
        "  disabled: true\n",
        encoding="utf-8",
    )
    return headless_patch


def dsh_command(
    dsh: Path, compat: Path, host_patch: Path, headless_patch: Path, task: str,
) -> list[str]:
    """Keep every DSH launcher flag before the first inner task argument."""
    return [
        "node", "--import", str(compat), str(dsh), "--profile", PROFILE_NAME,
        "--patch", str(host_patch), "--patch", str(headless_patch), task,
    ]


def main() -> int:
    for name in REQUIRED:
        required(name)
    repository = Path(required("BENCH_REPOSITORY")).resolve()
    output = Path(required("BENCH_OUTPUT_DIR")).resolve()
    core = Path(required("BENCH_QQ_CORE_SOURCE")).resolve()
    models = Path(required("BENCH_QQ_MODELS_SOURCE")).resolve()
    dsh = core / "dsh" / "node_modules" / ".bin" / "dsh"
    compat = core / "dsh" / "qq-dsh-model-compat.mjs"
    host_patch = validate_core_source(core)
    if not dsh.is_file() or not compat.is_file():
        raise RuntimeError("pinned qq-core DSH runtime is incomplete")

    workspace = output / "workspace"
    subprocess.run(["git", "clone", "--quiet", "--shared", "--no-checkout", str(repository), str(workspace)], check=True)
    subprocess.run(["git", "-C", str(workspace), "checkout", "--quiet", "--detach", required("BENCH_HEAD")], check=True)
    if subprocess.check_output(["git", "-C", str(workspace), "status", "--porcelain"], text=True).strip():
        raise RuntimeError("qq review workspace is not clean")

    dsh_home = output / "dsh-home"
    profile = dsh_home / "profiles" / PROFILE_NAME
    headless_patch = materialize_profile(profile, core, models)
    rendered_task = output / "rendered-mini-qa-task.txt"
    render_environment = os.environ.copy()
    render_environment.update({
        "BENCH_REPOSITORY": str(workspace),
        "BENCH_QQ_RENDERED_TASK_PATH": str(rendered_task),
    })
    rendered = subprocess.run(
        ["node", str(HERE / "render_qq_task.mjs")],
        cwd=workspace, env=render_environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if rendered.returncode != 0 or not rendered_task.is_file():
        raise RuntimeError(f"production Mini QA task rendering failed: {rendered.stderr.strip()}")
    task = rendered_task.read_text(encoding="utf-8")
    environment = os.environ.copy()
    environment.update({
        "DSH_HOME": str(dsh_home),
        # Auth remains host-owned. Mini QA bash runs in a clear-env/no-network
        # bwrap and does not inherit this path.
        "QQ_DSH_HOME": required("BENCH_QQ_DSH_HOME"),
        "QQ_DSH_PROVIDER": "xai-auth",
        "QQ_DSH_MODEL": "grok-4.6",
        "QQ_DSH_REASONING_EFFORT": "high",
        "QQ_DSH_CWD": str(workspace),
        "QQ_DSH_HMR_ROOTS": str(core),
        "QQ_DSH_HAVE_UI": "0",
        "QQ_DSH_HAVE_RELAY": "0",
        "QQ_DSH_HAVE_INDEX": "0",
        "QQ_DSH_HAVE_DASHBOARD": "0",
        "QQ_DSH_HAVE_WORKFLOWS": "0",
        "BENCH_REPOSITORY": str(workspace),
        "NO_COLOR": "1",
    })
    command = dsh_command(dsh, compat, host_patch, headless_patch, task)
    completed = subprocess.run(command, cwd=workspace, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    (output / "native.stdout").write_text(completed.stdout, encoding="utf-8")
    (output / "native.stderr").write_text(completed.stderr, encoding="utf-8")
    if completed.returncode != 0:
        print(completed.stderr, file=sys.stderr, end="")
    return completed.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"qq launcher: {error}", file=sys.stderr)
        raise SystemExit(2)
