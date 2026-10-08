#!/usr/bin/env python3
"""Reconcile explicitly admitted local indexes; never create or widen an index."""
import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

DEFERRED = 75


def log(event, **fields):
    print(json.dumps({"time": datetime.now(timezone.utc).isoformat(),
                      "event": event, **fields}), flush=True)


def save_handoff(path, value):
    temporary = path.with_suffix(".tmp")
    with temporary.open("w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


def canonical(path):
    path = Path(path)
    if not path.is_absolute() or str(path) != os.path.normpath(str(path)):
        raise ValueError("path must be normalized and absolute")
    if path.resolve(strict=True) != path:
        raise ValueError("symlink aliases are not admitted")
    return path


def validate_project(base, name, policy):
    if not isinstance(name, str) or name in ("", ".", "..") or "/" in name or name.startswith("."):
        raise ValueError("project must be a direct, visible child name")
    project = canonical(base / name)
    if not project.is_dir():
        raise ValueError("project is not a directory")
    manifest = project / ".zvec-grep" / "manifest.json"
    if not manifest.exists():
        return None
    canonical(manifest)
    data = json.loads(manifest.read_text())
    if data.get("path") != str(project / ".zvec-grep"):
        raise ValueError("manifest storage path must match the project-local index")
    roots = data.get("rootPaths")
    if not isinstance(roots, list) or len(roots) != 1 or not isinstance(roots[0], dict):
        raise ValueError("exactly one project root is required; parent and multi-root indexes are not admitted")
    root = roots[0]
    if root.get("absolutePath") != str(project) or canonical(root["absolutePath"]) != project:
        raise ValueError("manifest rootPaths must exactly match this project")
    if root.get("follow"):
        raise ValueError("scheduled roots must not follow symlinks outside the project")
    if data.get("indexPolicy") != "enabled":
        raise ValueError("index policy is not enabled")
    if data.get("embedding", {}).get("provider") != "local":
        raise ValueError("scheduled CPU reconciliation requires the existing local embedding provider")
    cap = root.get("maxFileSizeBytes")
    if type(cap) is not int or not 0 < cap <= policy["maxFileSizeBytes"]:
        raise ValueError("stored per-file cap is missing or exceeds configured policy; configure it explicitly")
    globs = root.get("globs", [])
    if not isinstance(globs, list) or not all(isinstance(g, str) for g in globs):
        raise ValueError("invalid stored globs")
    required = policy.get("requiredGlobs", {}).get(name, [])
    if any(g not in globs for g in required):
        raise ValueError("required exclusions are missing; configure selection explicitly before scheduling")
    if required and any(not g.startswith("!") for g in globs[min(globs.index(g) for g in required) + 1:]):
        raise ValueError("positive globs after required exclusions may re-include excluded data")
    # Retain the old scheduler's dangling-link protection without silently rewriting selection.
    for entry in project.iterdir():
        if entry.is_symlink() and not entry.exists():
            if not any(g in globs for g in ("!" + entry.name, "!" + entry.name + "/**")):
                raise ValueError("unexcluded dangling top-level symlink: " + entry.name)
    return project


def read_pressure(proc, sample_seconds=0.2):
    memory = {}
    for line in (proc / "meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        memory[key] = int(value.split()[0]) * 1024
    result = {"memoryAvailableBytes": memory["MemAvailable"],
              "swapUsedBytes": memory["SwapTotal"] - memory["SwapFree"],
              "loadPerCpu": float((proc / "loadavg").read_text().split()[0]) / (os.cpu_count() or 1)}
    for resource in ("cpu", "io", "memory"):
        line = next(l for l in (proc / "pressure" / resource).read_text().splitlines() if l.startswith("some "))
        result[resource + "SomeAvg10"] = float(re.search(r"avg10=([0-9.]+)", line)[1])

    def cpu_times():
        values = [int(v) for v in (proc / "stat").read_text().splitlines()[0].split()[1:9]]
        return sum(values), values[3] + values[4]

    start, idle_start = cpu_times()
    time.sleep(sample_seconds)
    end, idle_end = cpu_times()
    if end <= start:
        raise ValueError("CPU pressure sample did not advance")
    result["cpuBusyPercent"] = 100 * (1 - (idle_end - idle_start) / (end - start))
    return result


def pressure_reasons(sample, gates):
    reasons = []
    for name, limit in gates.items():
        value = sample.get(name)
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            reasons.append("missing/invalid pressure metric: " + name)
        elif (name == "memoryAvailableBytes" and value < limit) or (name != "memoryAvailableBytes" and value > limit):
            reasons.append(name + "=" + str(value))
    return reasons


def load_policy(path):
    policy = json.loads(path.read_text())
    policy["projectsDirectory"] = canonical(policy["projectsDirectory"])
    projects = policy["projects"]
    if not isinstance(projects, list) or not projects or len(set(projects)) != len(projects):
        raise ValueError("configure a nonempty unique project list")
    if type(policy["maxFileSizeBytes"]) is not int or policy["maxFileSizeBytes"] <= 0:
        raise ValueError("maxFileSizeBytes must be a positive integer")
    if not isinstance(policy["jobTimeoutSeconds"], (int, float)) or not 0 < policy["jobTimeoutSeconds"] <= 3600:
        raise ValueError("jobTimeoutSeconds must be between 0 and 3600")
    metrics = {"memoryAvailableBytes", "swapUsedBytes", "loadPerCpu", "cpuBusyPercent",
               "cpuSomeAvg10", "ioSomeAvg10", "memorySomeAvg10"}
    if set(policy["pressureGates"]) != metrics:
        raise ValueError("all CPU, I/O, memory and swap admission gates are required")
    if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in policy["pressureGates"].values()):
        raise ValueError("pressure thresholds must be finite nonnegative numbers")
    return policy


def client_limits():
    os.nice(15)
    # This restricts the client only; the shared daemon's work is separately admitted.
    if hasattr(os, "sched_getaffinity"):
        os.sched_setaffinity(0, {min(os.sched_getaffinity(0))})


def reconcile(project, binary, timeout, output_path):
    env = os.environ.copy()
    for key in ("VK_DRIVER_FILES", "VK_ICD_FILENAMES", "ZVEC_GREP_EMBEDDING"):
        env.pop(key, None)
    command = [binary, "index", str(project), "--mode", "server", "--device", "cpu",
               "--runtime-ephemeral", "--embedding-concurrency", "1"]
    with output_path.open("w") as output:
        process = subprocess.Popen(command, cwd=project, env=env, stdout=output,
                                   stderr=subprocess.STDOUT, start_new_session=True,
                                   preexec_fn=client_limits)
        try:
            code = process.wait(timeout=timeout)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
            return False, True, "client timeout/interruption; daemon job may still be running"
    # CLI terminal state is required: exit 0 alone is not proof of completed work.
    with output_path.open(errors="replace") as output:
        states = [l.strip() for l in output if l.startswith("Workspace index: ")]
    state = states[-1] if states else ""
    if code == 0 and state == "Workspace index: succeeded":
        return True, False, "succeeded"
    if state == "Workspace index: failed":
        return False, False, "daemon reported failed; client exit " + str(code)
    return False, True, "no terminal daemon result; client exit " + str(code)


def sweep(policy, state, binary, sample, dry_run=False):
    handoff = state / "uncertain-job.json"
    if handoff.exists():
        log("deferred", reason="unresolved daemon handoff", handoff=str(handoff))
        return DEFERRED
    counts = {"configured": len(policy["projects"]), "succeeded": 0, "skipped": 0, "failed": 0}
    for name in policy["projects"]:
        try:
            project = validate_project(policy["projectsDirectory"], name, policy)
        except (ValueError, OSError, KeyError, TypeError) as error:
            counts["failed"] += 1
            log("rejected", project=name, reason=str(error))
            continue
        if project is None:
            counts["skipped"] += 1
            log("skipped", project=name, reason="no project-local manifest; explicitly initialize and review this root separately")
            continue
        try:
            reasons = pressure_reasons(sample(), policy["pressureGates"])
        except (ValueError, OSError, KeyError, StopIteration) as error:
            reasons = ["cannot establish resource admission: " + str(error)]
        if reasons:
            log("deferred", reasons=reasons, nextProject=name, **counts)
            return DEFERRED
        if dry_run:
            log("would-reconcile", project=str(project), device="cpu", embeddingConcurrency=1,
                selections="preserve stored manifest")
            continue
        # Recheck after admission, immediately before handing a root to the daemon.
        try:
            if validate_project(policy["projectsDirectory"], name, policy) != project:
                raise ValueError("manifest disappeared before submission")
        except (ValueError, OSError, KeyError, TypeError) as error:
            counts["failed"] += 1
            log("rejected", project=name, reason=str(error))
            continue
        output_path = state / "last-client.log"
        # Persist before submission: a killed scheduler cannot forget a daemon job.
        save_handoff(handoff, {"root": str(project), "reason": "submission in progress or scheduler interrupted",
                               "clientLog": str(output_path)})
        try:
            succeeded, uncertain, reason = reconcile(project, binary, policy["jobTimeoutSeconds"], output_path)
        except (OSError, subprocess.SubprocessError) as error:
            handoff.unlink()
            log("failed", project=name, reason="client did not start: " + str(error))
            return 1
        if not succeeded:
            counts["failed"] += 1
            if uncertain:
                save_handoff(handoff, {"root": str(project), "reason": reason,
                                       "clientLog": str(output_path)})
                log("handoff-required", project=name, reason=reason, handoff=str(handoff))
            else:
                handoff.unlink()
                log("failed", project=name, reason=reason)
            # Never queue more work after failure or uncertain client cancellation.
            return 1
        handoff.unlink()
        counts["succeeded"] += 1
        log("reconciled", project=name, device="cpu")
    log("finished", dryRun=dry_run, **counts)
    return 1 if counts["failed"] else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path.home() / ".config/zg-index-projects.json")
    parser.add_argument("--state-dir", type=Path, default=Path.home() / ".local/state/zg-index-projects")
    parser.add_argument("--zg-bin", default=os.environ.get("ZG_BIN", "zg"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    def interrupted(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, interrupted)
    try:
        policy = load_policy(args.config)
        args.state_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        state = canonical(args.state_dir.absolute())
        with (state / "sweep.lock").open("a") as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                log("deferred", reason="another scheduled sweep owns the lock")
                return DEFERRED
            return sweep(policy, state, args.zg_bin, lambda: read_pressure(Path("/proc")), args.dry_run)
    except KeyboardInterrupt:
        log("deferred", reason="scheduler interrupted; inspect any existing daemon handoff")
        return DEFERRED
    except (ValueError, OSError, KeyError, TypeError) as error:
        log("configuration-error", reason=str(error))
        return 2


if __name__ == "__main__":
    sys.exit(main())
