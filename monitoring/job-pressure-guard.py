#!/usr/bin/env python3
"""Narrow emergency guard for positively identified disposable Node test workers.

This is a fallback for jobs that missed launch-time cgroup limits. It never
signals a process group, ancestor, model runtime, compiler or generic Node job.
"""
import argparse
import fcntl
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import tempfile
import time
import uuid


GIB = 1024 ** 3
DEFAULT_POLICY = {
    "poll_seconds": 1, "sustained_samples": 2, "worker_rss_limit_bytes": 4 * GIB,
    "rss_limits_by_cwd": {}, "pressure_reserve_bytes": 2 * GIB,
    "pressure_reserve_ratio": .08, "minimum_pressure_worker_rss_bytes": GIB // 2,
    "memory_psi_some_threshold": 5, "memory_psi_full_threshold": 1,
    "term_grace_seconds": 3, "progress_reduction_ratio": .1,
    "action_cooldown_seconds": 5, "incident_quiet_seconds": 600,
    "scan_budget_seconds": .75, "max_processes": 4096,
    "managed_memory_ceiling_bytes": 12 * GIB, "managed_swap_ceiling_bytes": GIB,
    "state_directory": str(Path.home() / ".local/state/qq-host-monitor"),
}
NODE_NAMES = {"node", "nodejs"}
TEST_FILE = re.compile(r"\.(?:test|spec)\.(?:[cm]?[jt]sx?)$")
WATCH_FLAGS = {"--watch", "--watchAll", "--watch-all", "--inspect", "--inspect-brk"}
PROTECTED_ARGS = {"app-server", "serve", "server", "dev", "--listen", "--daemon"}
NODE_VALUE_OPTIONS = {"--import", "--require", "-r", "--loader", "--experimental-loader", "--conditions", "-C",
                      "--test-name-pattern", "--test-skip-pattern", "--test-reporter", "--test-reporter-destination",
                      "--title", "--redirect-warnings", "--icu-data-dir", "--cpu-prof-dir", "--cpu-prof-name",
                      "--cpu-prof-interval", "--diagnostic-dir", "--disable-proto", "--disable-warning",
                      "--dns-result-order", "--env-file", "--env-file-if-exists", "--heap-prof-dir", "--heap-prof-name",
                      "--heap-prof-interval", "--heapsnapshot-near-heap-limit", "--heapsnapshot-signal", "--input-type",
                      "--localstorage-file", "--max-http-header-size", "--openssl-config", "--report-directory",
                      "--report-dir", "--report-filename", "--report-signal", "--secure-heap", "--secure-heap-min",
                      "--snapshot-blob", "--test-concurrency", "--test-timeout", "--test-shard", "--test-isolation",
                      "--max-old-space-size", "--max-semi-space-size", "--stack-size", "--stack_size"}
NODE_BOOLEAN_OPTIONS = {"--test", "--enable-source-maps", "--no-warnings", "--trace-warnings", "--trace-deprecation",
                        "--experimental-addon-modules", "--node-snapshot",
                        "--no-deprecation", "--pending-deprecation", "--experimental-strip-types", "--no-strip-types",
                        "--experimental-vm-modules", "--experimental-test-module-mocks", "--experimental-test-coverage",
                        "--experimental-default-config-file", "--no-addons", "--preserve-symlinks", "--preserve-symlinks-main",
                        "--expose-gc", "--jitless", "--use-strict", "--trace-gc", "--trace-gc-nvp", "--trace-opt",
                        "--trace-deopt", "--predictable", "--cpu-prof", "--heap-prof", "--prof",
                        "--abort-on-uncaught-exception", "--disable-sigusr1", "--disable-wasm-trap-handler",
                        "--disallow-code-generation-from-strings", "--force-context-aware", "--force-fips", "--enable-fips",
                        "--openssl-legacy-provider", "--openssl-shared-config", "--report-on-fatalerror",
                        "--report-on-signal", "--report-uncaught-exception", "--report-compact", "--report-exclude-env",
                        "--report-exclude-network", "--force-node-api-uncaught-exceptions-policy", "--frozen-intrinsics"}
NODE_OTHER_EXECUTION_OPTIONS = {"-e", "--eval", "-p", "--print", "-c", "--check", "-i", "--interactive",
                                "--run", "--build-sea", "--build-snapshot", "--prof-process", "--entry-url"}


def policy_from_file(path):
    policy = dict(DEFAULT_POLICY)
    policy["rss_limits_by_cwd"] = {}
    if path:
        incoming = json.loads(Path(path).read_text())
        if not isinstance(incoming, dict) or set(incoming) - set(policy):
            raise ValueError("Unknown pressure guard policy setting")
        policy.update(incoming)
    for key, value in policy.items():
        if key in ("rss_limits_by_cwd", "state_directory"):
            continue
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise ValueError(key + " must be positive and finite")
        if isinstance(DEFAULT_POLICY[key], int) and type(value) is not int:
            raise ValueError(key + " must be an integer")
    if not 0 < policy["pressure_reserve_ratio"] < 1 or not 0 < policy["progress_reduction_ratio"] < 1:
        raise ValueError("Reserve/progress ratios must be between zero and one")
    if not .25 <= policy["poll_seconds"] <= 10 or policy["sustained_samples"] < 2:
        raise ValueError("Polling must be bounded and at least two samples are required")
    limits = policy["rss_limits_by_cwd"]
    if not isinstance(limits, dict) or len(limits) > 64:
        raise ValueError("RSS exceptions must be an object of at most 64 directory budgets")
    for cwd, limit in limits.items():
        if not isinstance(cwd, str) or not Path(cwd).is_absolute() or os.path.normpath(cwd) != cwd or type(limit) is not int or limit <= 0:
            raise ValueError("RSS exceptions require absolute normalized directories and positive byte limits")
    if not isinstance(policy["state_directory"], str) or not Path(policy["state_directory"]).is_absolute():
        raise ValueError("State directory must be absolute")
    return policy


def atomic_json(path, data):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            json.dump(data, stream, separators=(",", ":"), allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def bounded_read(path, maximum=16384):
    try:
        with open(path, "rb") as stream:
            content = stream.read(maximum + 1)
        if len(content) > maximum:
            return None
        return content
    except OSError:
        return None


def process_info(proc, pid, uid):
    base = Path(proc) / str(pid)
    stat, status = bounded_read(base / "stat", 4096), bounded_read(base / "status")
    if stat is None or status is None:
        return None
    try:
        stat = stat.decode("utf-8", "replace")
        fields = stat[stat.rfind(")") + 2:].split()
        status = status.decode("utf-8", "replace")
        uids = re.search(r"^Uid:\s+(\d+)\s+(\d+)", status, re.M)
        owner = int(uids.group(1)) if uids else -1
        effective_owner = int(uids.group(2)) if uids else -1
        rss = re.search(r"^VmRSS:\s+(\d+)\s+kB", status, re.M)
        process = {"pid": int(pid), "ppid": int(fields[1]), "start_ticks": int(fields[19]),
                   "comm": stat[stat.find("(") + 1:stat.rfind(")")][:128],
                   "uid": owner, "effective_uid": effective_owner,
                   "rss_bytes": int(rss.group(1)) * 1024 if rss else 0,
                   "executable": None, "argv": [], "cgroup": None, "cwd": None}
    except (ValueError, IndexError):
        return None
    if owner != uid or effective_owner != uid:
        return process
    try:
        process["executable"] = os.readlink(base / "exe")[:1024]
    except OSError:
        return process
    name = Path(process["executable"]).name
    if name in NODE_NAMES or name == "codex":
        argv = bounded_read(base / "cmdline")
        if argv is not None:
            process["argv"] = [word.decode("utf-8", "replace") for word in argv.split(b"\0") if word]
        cgroup = bounded_read(base / "cgroup", 4096)
        if cgroup is not None:
            process["cgroup"] = cgroup.decode("utf-8", "replace").strip()
        try:
            process["cwd"] = os.readlink(base / "cwd")[:1024]
        except OSError:
            pass
    return process


def read_host(proc):
    memory = bounded_read(Path(proc) / "meminfo")
    pressure = bounded_read(Path(proc) / "pressure/memory", 4096)
    if memory is None or pressure is None:
        return None
    values = {key: int(value) * 1024 for key, value in re.findall(r"^(\w+):\s+(\d+)", memory.decode(), re.M)}
    result = {"memory_total_bytes": values.get("MemTotal"), "memory_available_bytes": values.get("MemAvailable"),
              "swap_total_bytes": values.get("SwapTotal"), "swap_free_bytes": values.get("SwapFree")}
    for kind in ("some", "full"):
        match = re.search(r"^" + kind + r"\s+avg10=([\d.]+).*\btotal=(\d+)", pressure.decode(), re.M)
        result["memory_psi_" + kind] = float(match.group(1)) if match else None
        result["memory_stall_" + kind + "_microseconds"] = int(match.group(2)) if match else None
    if any(result[key] is None for key in ("memory_total_bytes", "memory_available_bytes", "memory_psi_some", "memory_psi_full")):
        return None
    return result


def scan(proc, policy, uid=None, monotonic=time.monotonic):
    uid = os.getuid() if uid is None else uid
    started, processes, complete, count = monotonic(), {}, True, 0
    try:
        with os.scandir(proc) as entries:
            for entry in entries:
                if not entry.name.isdecimal():
                    continue
                if count >= policy["max_processes"] or monotonic() - started >= policy["scan_budget_seconds"]:
                    complete = False
                    break
                count += 1
                process = process_info(proc, int(entry.name), uid)
                if process:
                    processes[process["pid"]] = process
                elif Path(entry.path).exists():
                    complete = False
    except OSError:
        complete = False
    pid1 = bounded_read(Path(proc) / "1/comm", 128)
    namespace_ok = pid1 is not None and pid1.strip() in (b"systemd", b"init")
    return {"processes": processes, "host": read_host(proc), "complete": complete and namespace_ok,
            "scan_processes": count, "scan_seconds": monotonic() - started}


def target_snapshot(proc, pid, policy, uid, monotonic=time.monotonic):
    """Fresh target/ancestry/leaf checks without another whole-host CPU burst."""
    started, rows, complete = monotonic(), {}, True
    current = pid
    for _ in range(64):
        if not current or current in rows:
            break
        if monotonic() - started >= policy["scan_budget_seconds"]:
            complete = False
            break
        row = process_info(proc, current, uid)
        if row is None:
            if current != pid or (Path(proc) / str(current)).exists():
                complete = False
            break
        rows[current] = row
        if appserver(row):
            break
        current = row["ppid"]
    else:
        complete = False
    if pid in rows:
        try:
            with os.scandir(Path(proc) / str(pid) / "task") as threads:
                for count, thread in enumerate(threads):
                    if count >= 256 or monotonic() - started >= policy["scan_budget_seconds"]:
                        complete = False
                        break
                    children = bounded_read(Path(thread.path) / "children", 4096)
                    if children is None:
                        if Path(thread.path).exists():
                            complete = False
                        continue
                    if children.strip():
                        # Eligibility's leaf check requires only one child marker.
                        try:
                            child = int(children.split()[0])
                            rows[child] = {"pid": child, "ppid": pid}
                        except ValueError:
                            complete = False
                        break
        except OSError:
            complete = False
    pid1 = bounded_read(Path(proc) / "1/comm", 128)
    complete = complete and pid1 is not None and pid1.strip() in (b"systemd", b"init")
    return {"processes": rows, "host": read_host(proc), "complete": complete,
            "scan_processes": len(rows), "scan_seconds": monotonic() - started}


def node(process):
    return Path(process.get("executable") or "").name in NODE_NAMES


def appserver(process):
    return Path(process.get("executable") or "").name == "codex" and "app-server" in process.get("argv", [])[1:4]


def ancestors(process, processes):
    seen, rows = {process["pid"]}, []
    parent = process.get("ppid")
    for _ in range(64):
        if parent not in processes or parent in seen:
            break
        row = processes[parent]
        rows.append(row)
        seen.add(parent)
        parent = row.get("ppid")
    return rows


def is_watch_or_server(process):
    argv = process.get("argv", [])[1:]
    return any(word in PROTECTED_ARGS or word in WATCH_FLAGS or word.startswith(("--watch=", "--inspect=", "--inspect-brk=", "--listen=")) for word in argv)


def node_test_runner(process):
    if not node(process) or is_watch_or_server(process):
        return False
    parsed = parse_node_entry(process)
    return parsed is not None and parsed["native_test"]


def parse_node_entry(process):
    """Conservative option parser; unknown bare flags never imply a script.

    Equals-form options consume one token and cannot steal the next script token.
    Unknown bare options may consume a value, so ambiguity excludes eligibility.
    """
    argv = process.get("argv", [])[1:]
    native_test, index = False, 0
    while index < len(argv):
        word = argv[index]
        if word == "--":
            index += 1
            return {"native_test": native_test, "script": argv[index] if index < len(argv) else None,
                    "trailing": argv[index + 1:]}
        option = word.split("=", 1)[0]
        if option in NODE_OTHER_EXECUTION_OPTIONS:
            return None
        if word in NODE_VALUE_OPTIONS:
            if index + 1 >= len(argv):
                return None
            index += 2
            continue
        if word in NODE_BOOLEAN_OPTIONS:
            native_test = native_test or word == "--test"
            index += 1
            continue
        if word.startswith("--") and "=" in word:
            index += 1
            continue
        if not word.startswith("-"):
            return {"native_test": native_test, "script": word, "trailing": argv[index + 1:]}
        return None
    return {"native_test": native_test, "script": None, "trailing": []}


def node_script(process):
    parsed = parse_node_entry(process)
    return parsed["script"] if parsed else None


def named_runner(process, kind):
    if not node(process) or is_watch_or_server(process):
        return False
    argv = process.get("argv", [])[1:]
    script = node_script(process) or ""
    if kind == "jest":
        return bool(re.search(r"/node_modules/jest(?:-cli)?/(?:bin/jest\.js|build/index\.js)$", script))
    return "run" in argv and bool(re.search(r"/node_modules/vitest/vitest\.mjs$", script))


def eligibility(process, processes, uid):
    if not node(process) or process.get("uid") != uid or process.get("effective_uid") != uid:
        return None
    if not process.get("cgroup") or not process.get("cwd") or not process.get("argv") or is_watch_or_server(process):
        return None
    # Initially target leaf workers only; never kill a runner containing another
    # worker, studio, service, emulator or independent command stream.
    if any(row.get("ppid") == process["pid"] for row in processes.values()):
        return None
    lineage = ancestors(process, processes)
    owner = next((row for row in lineage if appserver(row)), None)
    if owner is None:
        return None
    command_lineage = lineage[:lineage.index(owner)]
    if any(is_watch_or_server(row) for row in command_lineage):
        return None
    entry = parse_node_entry(process)
    if entry is None:
        return None
    script = entry["script"] or ""
    if node_test_runner(process) and TEST_FILE.search(script) and not entry["trailing"]:
        return {"classification": "node-native-test", "appserver_pid": owner["pid"], "appserver_start_ticks": owner["start_ticks"]}
    if TEST_FILE.search(script) and not entry["trailing"] and any(node_test_runner(row) for row in command_lineage):
        return {"classification": "node-test-file-worker", "appserver_pid": owner["pid"], "appserver_start_ticks": owner["start_ticks"]}
    if re.search(r"/node_modules/jest-worker/build/workers/processChild\.js$", script) and any(named_runner(row, "jest") for row in command_lineage):
        return {"classification": "jest-worker", "appserver_pid": owner["pid"], "appserver_start_ticks": owner["start_ticks"]}
    if re.search(r"/node_modules/tinypool/dist/entry/process\.js$", script) and any(named_runner(row, "vitest") for row in command_lineage):
        return {"classification": "vitest-worker", "appserver_pid": owner["pid"], "appserver_start_ticks": owner["start_ticks"]}
    return None


def identity(process):
    return str(process["pid"]) + ":" + str(process["start_ticks"])


def managed_budget(process, policy, root="/sys/fs/cgroup"):
    """Trust finite kernel limits, never just a managed-looking unit name."""
    prefix = "/user.slice/user-" + str(process["uid"]) + ".slice/user@" + str(process["uid"]) + ".service/qqjobs.slice/"
    identifier = r"(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})"
    match = re.fullmatch(r"0::(" + re.escape(prefix) + r"qq-job-" + identifier + r"\.scope)", process.get("cgroup") or "")
    if not match:
        return None
    path = match.group(1)
    if os.path.normpath(path) != path:
        return None
    try:
        root = Path(root).resolve(strict=True)
        leaf = (root / path.lstrip("/")).resolve(strict=True)
        if not leaf.is_relative_to(root) or str(leaf.relative_to(root)) != path.lstrip("/"):
            return None
        limits = {}
        for scope, directory in (("job", leaf), ("aggregate", leaf.parent)):
            for name, ceiling in (("memory", policy["managed_memory_ceiling_bytes"]), ("swap", policy["managed_swap_ceiling_bytes"])):
                raw = bounded_read(directory / ("memory.max" if name == "memory" else "memory.swap.max"), 64)
                value = int(raw.strip()) if raw is not None else None
                if value is None or value < (1 if name == "memory" else 0) or value > ceiling:
                    return None
                limits[scope + "_" + name + "_max_bytes"] = value
        return {"source": "verified kernel job and aggregate cgroup limits", "cgroup": path, **limits}
    except (OSError, ValueError):
        return None


def rss_budget(process, policy):
    if process.get("managed_budget"):
        return None
    budget, specificity = policy["worker_rss_limit_bytes"], -1
    cwd = process.get("cwd")
    if cwd:
        for directory, limit in policy["rss_limits_by_cwd"].items():
            if (cwd == directory or cwd.startswith(directory.rstrip("/") + "/")) and len(directory) > specificity:
                budget, specificity = limit, len(directory)
    return budget


def host_pressure(host, policy, previous=None, elapsed=1):
    if not host:
        return False
    reserve = max(policy["pressure_reserve_bytes"], host["memory_total_bytes"] * policy["pressure_reserve_ratio"])
    pressure = host["memory_psi_some"] >= policy["memory_psi_some_threshold"] or host["memory_psi_full"] >= policy["memory_psi_full_threshold"]
    if previous and elapsed > 0:
        for kind, threshold in (("some", policy["memory_psi_some_threshold"]), ("full", policy["memory_psi_full_threshold"])):
            key = "memory_stall_" + kind + "_microseconds"
            if host.get(key) is not None and previous.get(key) is not None:
                percentage = 100 * max(0, host[key] - previous[key]) / (elapsed * 1000000)
                pressure = pressure or percentage >= threshold
    return host["memory_available_bytes"] < reserve and pressure


def safe_evidence(process, classification, budget, host, reason):
    evidence = {key: process.get(key) for key in ("pid", "ppid", "start_ticks", "comm", "uid", "rss_bytes", "executable", "cwd", "cgroup")}
    evidence.update(classification=classification, rss_limit_bytes=budget, host=host, intervention_reason=reason,
                    source_service=(process.get("cgroup") or "").rsplit("/", 1)[-1], action="SIGTERM",
                    managed_budget=process.get("managed_budget"))
    return evidence


class Guard:
    def __init__(self, policy, proc="/proc", uid=None, scanner=None, pidfd_open=None, sender=None, cgroup_root="/sys/fs/cgroup", monotonic=time.monotonic):
        self.policy, self.proc = policy, Path(proc)
        self.uid = os.getuid() if uid is None else uid
        self.scanner = scanner or (lambda: scan(self.proc, self.policy, self.uid))
        self.custom_scanner = scanner is not None
        self.pidfd_open = pidfd_open or os.pidfd_open
        self.sender = sender or signal.pidfd_send_signal
        self.cgroup_root = cgroup_root
        self.monotonic = monotonic
        self.directory = Path(policy["state_directory"])
        self.streaks, self.pressure_streak, self.previous_host, self.previous_sample = {}, 0, None, None
        self.pending = None
        self.cooldown_until = 0
        self.state = load_json(self.directory / "pressure-guard-state.json", {"schema": 1, "incidents": {}})
        self.state.setdefault("incidents", {})

    def _persist(self):
        atomic_json(self.directory / "pressure-guard-state.json", self.state)

    def _write_incident(self, incident):
        atomic_json(self.directory / "incidents" / (incident["id"] + ".json"), incident)

    def _incident(self, process, classification, budget, host, reason, now):
        boot = bounded_read(self.proc / "sys/kernel/random/boot_id", 128)
        boot = boot.decode().strip() if boot else "unknown"
        identifier = str(uuid.uuid5(uuid.NAMESPACE_URL, socket.gethostname() + ":job-pressure:" + boot + ":" + identity(process) + ":" + str(now)))
        incident = {"id": identifier, "host": socket.gethostname(), "type": "job_pressure_intervention", "severity": "critical",
                    "status": "open", "first_seen": now, "last_seen": now,
                    "summary": "Disposable agent test worker exceeded its safety policy",
                    "evidence": safe_evidence(process, classification, budget, host, reason), "delivery": {}}
        self._write_incident(incident)
        self.state["incidents"][identifier] = now
        self._persist()
        return incident

    def revalidate(self, expected, classification):
        snapshot = self.scanner() if self.custom_scanner else target_snapshot(self.proc, expected["pid"], self.policy, self.uid)
        if not snapshot["complete"]:
            return None, snapshot
        current = snapshot["processes"].get(expected["pid"])
        if current is None or any(current.get(key) != expected.get(key) for key in ("pid", "start_ticks", "executable", "cgroup", "uid", "effective_uid")):
            return None, snapshot
        current_class = eligibility(current, snapshot["processes"], self.uid)
        if current_class != classification:
            return None, snapshot
        current["managed_budget"] = managed_budget(current, self.policy, self.cgroup_root)
        return current, snapshot

    def _signal(self, process, classification, signum, fd=None, reason=None, initial_rss=None):
        owned = fd is None
        if owned:
            try:
                fd = self.pidfd_open(process["pid"], 0)
            except OSError:
                return False
        try:
            current, snapshot = self.revalidate(process, classification)
            if current is None:
                return False
            if reason == "rss_budget":
                budget = rss_budget(current, self.policy)
                if budget is None or current["rss_bytes"] <= budget:
                    return False
            if reason == "host_pressure" and not (host_pressure(snapshot["host"], self.policy) and current["rss_bytes"] >= self.policy["minimum_pressure_worker_rss_bytes"]):
                return False
            if signum == signal.SIGKILL and initial_rss is not None and current["rss_bytes"] <= initial_rss * (1 - self.policy["progress_reduction_ratio"]):
                return False
            try:
                self.sender(fd, signum, None, 0)
                return True
            except OSError:
                return False
        finally:
            if owned:
                os.close(fd)

    def _finish_pending(self, outcome, now, clock):
        pending = self.pending
        incident = pending["incident"]
        incident["last_seen"] = now
        incident["evidence"].update(outcome=outcome)
        self._write_incident(incident)
        self.state["incidents"][incident["id"]] = now
        self._persist()
        os.close(pending["pidfd"])
        self.pending = None
        self.cooldown_until = clock + self.policy["action_cooldown_seconds"]

    def _advance_pending(self, now, clock):
        pending = self.pending
        current, snapshot = self.revalidate(pending["process"], pending["classification"])
        if not snapshot["complete"]:
            # Missing evidence does not prove a previously signalled worker exited.
            # Keep its pidfd and retry a complete scan before any further signal.
            if not pending.get("scan_incomplete"):
                pending["scan_incomplete"] = True
                pending["incident"]["evidence"]["outcome"] = "Further signal deferred: process scan incomplete"
                self._write_incident(pending["incident"])
            return
        pending["scan_incomplete"] = False
        if current is None:
            self._finish_pending("Worker exited or identity/eligibility changed; no further signal", now, clock)
            return
        if clock - pending["started"] < self.policy["term_grace_seconds"]:
            return
        reduced = current["rss_bytes"] <= pending["process"]["rss_bytes"] * (1 - self.policy["progress_reduction_ratio"])
        budget = rss_budget(current, self.policy)
        still_exceeded = budget is not None and current["rss_bytes"] > budget
        continued_pressure = host_pressure(snapshot["host"], self.policy) and current["rss_bytes"] >= self.policy["minimum_pressure_worker_rss_bytes"]
        justified = still_exceeded if pending["reason"] == "rss_budget" else continued_pressure
        if not justified or reduced:
            self._finish_pending("No SIGKILL: pressure/budget recovered or RSS meaningfully decreased", now, clock)
            return
        sent = self._signal(current, pending["classification"], signal.SIGKILL, pending["pidfd"], pending["reason"], pending["process"]["rss_bytes"])
        pending["incident"]["evidence"].update(action="SIGTERM then SIGKILL" if sent else "SIGTERM; SIGKILL skipped after revalidation", final_rss_bytes=current["rss_bytes"])
        self._finish_pending("Same disposable worker still exceeded safety policy after the grace period" if sent else "Final identity/eligibility check failed; no further signal", now, clock)

    def _resolve_old(self, now):
        for identifier, last_seen in list(self.state["incidents"].items()):
            if self.pending and self.pending["incident"]["id"] == identifier:
                continue
            if now - last_seen < self.policy["incident_quiet_seconds"]:
                continue
            incident = load_json(self.directory / "incidents" / (identifier + ".json"), {})
            if incident:
                incident.update(status="resolved", resolved_at=now, resolution="Intervention record completed; quiet period elapsed")
                self._write_incident(incident)
            del self.state["incidents"][identifier]
            self._persist()

    def tick(self, now=None, dry_run=False, monotonic_now=None):
        now = time.time() if now is None else now
        clock = self.monotonic() if monotonic_now is None else monotonic_now
        self._resolve_old(now)
        if self.pending:
            self._advance_pending(now, clock)
            return {"pending": bool(self.pending)}
        snapshot = self.scanner()
        if self.previous_sample is not None and clock <= self.previous_sample:
            return {"sample_fresh": False}
        host = snapshot["host"]
        elapsed = clock - self.previous_sample if self.previous_sample is not None else self.policy["poll_seconds"]
        pressured = snapshot["complete"] and host_pressure(host, self.policy, self.previous_host, elapsed)
        self.pressure_streak = self.pressure_streak + 1 if pressured else 0
        self.previous_host, self.previous_sample = host, clock
        candidates, current_streaks = [], {}
        if snapshot["complete"]:
            for process in snapshot["processes"].values():
                classification = eligibility(process, snapshot["processes"], self.uid)
                if classification is None:
                    continue
                process["managed_budget"] = managed_budget(process, self.policy, self.cgroup_root)
                key, budget = identity(process), rss_budget(process, self.policy)
                streak = self.streaks.get(key, 0) + 1 if budget is not None and process["rss_bytes"] > budget else 0
                current_streaks[key] = streak
                reason = "rss_budget" if streak >= self.policy["sustained_samples"] else "host_pressure" if self.pressure_streak >= self.policy["sustained_samples"] and process["rss_bytes"] >= self.policy["minimum_pressure_worker_rss_bytes"] else None
                if reason:
                    candidates.append((reason == "rss_budget", process["rss_bytes"], process, classification, budget, reason))
        self.streaks = current_streaks
        result = {"scan_processes": snapshot["scan_processes"], "scan_seconds": snapshot["scan_seconds"],
                  "scan_complete": snapshot["complete"], "eligible_triggers": len(candidates), "host_pressure": bool(pressured),
                  "managed_workers": [{"pid": process["pid"], "budget": process["managed_budget"]} for process in snapshot["processes"].values() if process.get("managed_budget")]}
        if not candidates or dry_run or clock < self.cooldown_until:
            return result
        _, _, process, classification, budget, reason = max(candidates, key=lambda candidate: candidate[:2])
        try:
            fd = self.pidfd_open(process["pid"], 0)
        except OSError:
            return result
        # Save the action intent before signalling. Revalidation happens after
        # pidfd_open so PID reuse cannot redirect a signal to a different process.
        incident = self._incident(process, classification, budget, host, reason, now)
        self.pending = {"process": process, "classification": classification, "pidfd": fd,
                        "reason": reason, "started": clock, "incident": incident}
        sent = self._signal(process, classification, signal.SIGTERM, fd, reason)
        if not sent:
            self._finish_pending("SIGTERM skipped: identity/eligibility changed, evidence incomplete, or signal permission denied", now, clock)
        else:
            # Start grace after TERM reaches the worker, before post-send fsync.
            # Throttled scans and durable intent writes cannot shorten its grace.
            self.pending["started"] = self.monotonic()
            incident["evidence"]["term_sent"] = True
            self._write_incident(incident)
        return result

    def close(self):
        if self.pending:
            os.close(self.pending["pidfd"])
            self.pending = None


class HealthReporter:
    """Small journal heartbeat; no additional sampling or private data."""
    def __init__(self):
        self.status = {"scan_complete": None, "scan_processes": None, "scan_seconds": None, "pending": False}
        self.last_complete = None
        self.last_report = None

    def update(self, result, pending, clock):
        previous = (self.status["scan_complete"], self.status["pending"])
        for key in ("scan_complete", "scan_processes", "scan_seconds"):
            if key in result:
                self.status[key] = result[key]
        self.status["pending"] = bool(pending)
        if result.get("scan_complete"):
            self.last_complete = clock
        changed = previous != (self.status["scan_complete"], self.status["pending"])
        if self.last_report is not None and not changed and clock - self.last_report < 30:
            return None
        self.last_report = clock
        age = round(max(0, clock - self.last_complete), 3) if self.last_complete is not None else None
        return {"event": "guard-health", **self.status, "last_complete_age_seconds": age}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        parser.exit(1, "Linux pidfd support is required; numeric PID signalling is disabled\n")
    os.umask(0o077)
    policy = policy_from_file(args.config)
    directory = Path(policy["state_directory"])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    with (directory / "pressure-guard.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "A pressure guard already owns this state directory\n")
        guard = Guard(policy)
        health = HealthReporter()
        stopped = False

        def stop(_signum, _frame):
            nonlocal stopped
            stopped = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        try:
            while not stopped:
                started = time.monotonic()
                result = guard.tick(dry_run=args.dry_run)
                if args.once:
                    print(json.dumps(result))
                    break
                report = health.update(result, guard.pending is not None, time.monotonic())
                if report:
                    print(json.dumps(report, separators=(",", ":")), flush=True)
                while not stopped and time.monotonic() - started < policy["poll_seconds"]:
                    time.sleep(max(0, min(.2, policy["poll_seconds"] - (time.monotonic() - started))))
        finally:
            guard.close()


if __name__ == "__main__":
    main()
