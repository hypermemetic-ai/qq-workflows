#!/usr/bin/env python3
"""Bounded Linux host sampling and durable incident state; Python stdlib only."""

import argparse
import copy
import heapq
import json
import math
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET


DEFAULT_POLICY = {
    "interval_seconds": 10, "watcher_interval_seconds": 30,
    "watcher_budget_seconds": 2, "watcher_max_processes": 4096,
    "watcher_max_fds_per_process": 4096, "watcher_max_bytes": 64 * 1024 * 1024,
    "top_watchers": 12, "disk_path": "/home", "gpu_interval_seconds": 30,
    "gpu_timeout_seconds": 3, "service_interval_seconds": 60,
    "process_memory_interval_seconds": 10, "process_memory_budget_seconds": .25,
    "process_memory_max_processes": 4096, "top_memory_processes": 12,
    "process_activity_budget_seconds": .25, "top_activity_processes": 12,
    "disk_scan_interval_seconds": 300, "disk_scan_budget_seconds": .05,
    "disk_scan_max_entries_per_sample": 3000, "disk_scan_max_inodes": 250000,
    "disk_scan_roots": [str(Path.home()), "/var/log", "/var/lib"],
    "history_max_bytes": 8 * 1024 * 1024, "history_files": 3,
    "important_user_units": [], "important_system_units": [],
    "journal_max_events": 200, "journal_max_bytes": 1024 * 1024,
    "journal_timeout_seconds": 3, "sustained_samples": 3, "recovery_samples": 3,
    "event_quiet_seconds": 600, "resolved_retention_days": 14,
    "max_resolved_incidents": 500,
    "thresholds": {
        "inotify_watches": {"warning": .7, "critical": .9, "clear": .6},
        "inotify_instances": {"warning": .7, "critical": .9, "clear": .6},
        "memory": {"warning": .1, "critical": .05, "clear": .15, "minimum_psi": 1},
        "io_pressure": {"warning": 20, "critical": 50, "clear": 10},
        "disk": {"warning": .85, "critical": .95, "clear": .8},
        "disk_inodes": {"warning": .9, "critical": .97, "clear": .85},
        "temperature": {"warning": 85, "critical": 95, "clear": 80},
        "gpu_bar1": {"warning": .85, "critical": .95, "clear": .75},
        "process_memory": {"warning": .2, "critical": .3, "clear": .15},
    },
}


def load_policy(path=None):
    policy = copy.deepcopy(DEFAULT_POLICY)
    if path:
        supplied = json.loads(Path(path).read_text())
        for key, value in supplied.items():
            if key not in policy:
                raise ValueError("Unknown policy setting: " + key)
            if key == "thresholds":
                for name, threshold in value.items():
                    if name not in policy[key]:
                        raise ValueError("Unknown threshold: " + name)
                    policy[key][name].update(threshold)
            else:
                policy[key] = value
    for key, value in policy.items():
        if isinstance(DEFAULT_POLICY[key], (int, float)):
            if not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
                raise ValueError(key + " must be positive and finite")
            if isinstance(DEFAULT_POLICY[key], int) and not isinstance(value, int):
                raise ValueError(key + " must be an integer")
    for name, limits in policy["thresholds"].items():
        expected = set(DEFAULT_POLICY["thresholds"][name])
        if set(limits) != expected or any(not isinstance(value, (int, float)) or not math.isfinite(value)
                                          for value in limits.values()):
            raise ValueError("Invalid threshold values: " + name)
        if name == "memory":
            valid = 0 <= limits["critical"] < limits["warning"] < limits["clear"] <= 1 and limits["minimum_psi"] >= 0
        else:
            valid = 0 <= limits["clear"] < limits["warning"] < limits["critical"]
        if not valid:
            raise ValueError("Invalid threshold order: " + name)
    for key in ("important_user_units", "important_system_units"):
        if not isinstance(policy[key], list) or len(policy[key]) > 32:
            raise ValueError(key + " must be a list of at most 32 units")
        if any(not isinstance(unit, str) or not re.fullmatch(r"[A-Za-z0-9_.@:-]+", unit)
               or unit.startswith("-") for unit in policy[key]):
            raise ValueError("Invalid unit name in " + key)
    roots = policy["disk_scan_roots"]
    if not isinstance(roots, list) or len(roots) > 16 or any(
            not isinstance(root, str) or not os.path.isabs(root) for root in roots):
        raise ValueError("disk_scan_roots must contain at most 16 absolute paths")
    return policy


def atomic_json(path, data):
    """Replace private JSON files without exposing half-written documents."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, separators=(",", ":"), allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_json(path, fallback):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return copy.deepcopy(fallback)


_PENDING_COMMANDS = {}


def bounded_command(argv, timeout=3, max_bytes=1024 * 1024):
    """Bound time/output, including an unkillable driver-blocked subprocess.

    Retain at most one outstanding process per executable. A process in Linux D
    state may not reap after SIGKILL; never wait for it or pile up more probes.
    """
    command_key = argv[0]
    pending = _PENDING_COMMANDS.get(command_key)
    if pending is not None:
        if pending.poll() is None:
            return {"ok": False, "error": "previous_probe_pending", "stdout": b""}
        del _PENDING_COMMANDS[command_key]
    try:
        process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   stdin=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        return {"ok": False, "error": "unavailable", "stdout": b""}
    output = bytearray()
    total = 0
    error = None
    deadline = time.monotonic() + timeout
    with selectors.DefaultSelector() as selector:
        selector.register(process.stdout, selectors.EVENT_READ, "stdout")
        selector.register(process.stderr, selectors.EVENT_READ, "stderr")
        try:
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    error = "timeout"
                    break
                for key, _ in selector.select(min(remaining, .2)):
                    chunk = os.read(key.fileobj.fileno(), 8192)
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    room = max_bytes - total
                    if key.data == "stdout":
                        output.extend(chunk[:max(0, room)])
                    total += len(chunk)
                    if total > max_bytes:
                        error = "output_budget"
                        break
                if error:
                    break
            code = process.poll()
            while not error and code is None:
                if time.monotonic() >= deadline:
                    error = "timeout"
                    break
                time.sleep(.01)
                code = process.poll()
            if error:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                code = process.poll()
                if code is None:
                    _PENDING_COMMANDS[command_key] = process
        finally:
            process.stdout.close()
            process.stderr.close()
    return {"ok": error is None and code == 0, "error": error or ("exit_" + str(code) if code else None),
            "stdout": bytes(output)}


def small_read(path, maximum=16384):
    try:
        with open(path, "r", errors="replace") as stream:
            return stream.read(maximum)
    except OSError:
        return None


def number(text):
    try:
        value = float(str(text).split()[0])
        return value if math.isfinite(value) else None
    except (ValueError, IndexError, TypeError):
        return None


def psi_value(path, kind):
    content = small_read(path)
    if content:
        for line in content.splitlines():
            if line.startswith(kind + " "):
                match = re.search(r"\bavg10=([\d.]+)", line)
                return number(match.group(1)) if match else None
    return None


def collect_watchers(proc_root, policy, uid=None, monotonic=time.monotonic):
    """Per-UID visible FD sums, with explicit partial and duplicate coverage."""
    uid = os.getuid() if uid is None else uid
    start = monotonic()
    counts = {"inotify_watches": 0, "inotify_instances": 0}
    coverage = {"watchers_complete": True, "watcher_uid": uid, "watchers_denied": 0,
                "watchers_scanned_processes": 0, "watchers_scanned_fds": 0,
                "watcher_bytes_read": 0, "watcher_budget_exceeded": False,
                "watcher_measurement": "visible per-UID process FD sum; shared/inherited FDs may be counted repeatedly"}
    rows = []

    def budget():
        exceeded = (monotonic() - start >= policy["watcher_budget_seconds"]
                    or coverage["watcher_bytes_read"] >= policy["watcher_max_bytes"])
        if exceeded:
            coverage["watchers_complete"] = False
            coverage["watcher_budget_exceeded"] = True
        return exceeded

    try:
        with os.scandir(proc_root) as entries:
            processes = []
            for entry in entries:
                if entry.name.isdecimal():
                    processes.append(entry.name)
                if len(processes) > policy["watcher_max_processes"] or budget():
                    coverage["watchers_complete"] = False
                    coverage["watcher_budget_exceeded"] = True
                    break
    except OSError:
        coverage["watchers_complete"] = False
        coverage["watchers_denied"] += 1
        return counts, [], coverage
    for pid in sorted(processes[:policy["watcher_max_processes"]], key=int):
        if budget():
            break
        base = Path(proc_root) / pid
        status = small_read(base / "status")
        if status is None:
            if base.exists():
                coverage["watchers_complete"] = False
                coverage["watchers_denied"] += 1
            continue
        owner = re.search(r"^Uid:\s+(\d+)", status, re.M)
        if not owner or int(owner.group(1)) != uid:
            continue
        coverage["watchers_scanned_processes"] += 1
        watches, instances = 0, 0
        try:
            with os.scandir(base / "fd") as descriptors:
                for index, descriptor in enumerate(descriptors):
                    if index >= policy["watcher_max_fds_per_process"] or budget():
                        coverage["watchers_complete"] = False
                        coverage["watcher_budget_exceeded"] = True
                        break
                    coverage["watchers_scanned_fds"] += 1
                    try:
                        if "inotify" not in os.readlink(descriptor.path):
                            continue
                        instances += 1
                        with open(base / "fdinfo" / descriptor.name, "rb") as stream:
                            while True:
                                if budget():
                                    break
                                line = stream.readline(4096)
                                coverage["watcher_bytes_read"] += len(line)
                                if not line:
                                    break
                                if line.startswith(b"inotify "):
                                    watches += 1
                    except FileNotFoundError:
                        continue  # Process/FD exits are normal races.
                    except OSError:
                        coverage["watchers_complete"] = False
                        coverage["watchers_denied"] += 1
        except FileNotFoundError:
            continue
        except OSError:
            coverage["watchers_complete"] = False
            coverage["watchers_denied"] += 1
        counts["inotify_watches"] += watches
        counts["inotify_instances"] += instances
        if instances:
            parent = re.search(r"^PPid:\s+(\d+)", status, re.M)
            try:
                cwd = os.readlink(base / "cwd")[:512]
            except OSError:
                cwd = None
            rows.append({"pid": int(pid), "ppid": int(parent.group(1)) if parent else 0,
                         "comm": (small_read(base / "comm", 128) or "unknown").strip(),
                         "watches": watches, "instances": instances, "cwd": cwd,
                         "cgroup": (small_read(base / "cgroup", 512) or "").strip()})
    coverage["watcher_duration_seconds"] = round(monotonic() - start, 4)
    rows.sort(key=lambda row: (row["watches"], row["instances"]), reverse=True)
    return counts, rows[:policy["top_watchers"]], coverage


def collect_temperature(sys_root):
    """Only named CPU/GPU sensors; ignore unrelated board/disk readings."""
    sensors = []
    supported = {"coretemp", "k10temp", "zenpower", "nvidia", "amdgpu", "cpu_thermal"}
    for hwmon in sorted((Path(sys_root) / "class/hwmon").glob("hwmon*"))[:64]:
        name = (small_read(hwmon / "name", 128) or "").strip()
        if name not in supported:
            continue
        for path in sorted(hwmon.glob("temp*_input"))[:32]:
            raw = number(small_read(path, 64))
            value = raw / 1000 if raw is not None else None
            if value is not None and -20 <= value <= 150:
                sensors.append({"name": name, "label": (small_read(path.with_name(path.name.replace("_input", "_label")), 128)
                                                         or path.stem).strip(), "temperature_c": value})
    return max((s["temperature_c"] for s in sensors), default=None), sensors


def collect_process_memory(proc_root, policy, total_memory_bytes, monotonic=time.monotonic):
    """Bounded RSS attribution across visible host processes, without argv."""
    started = monotonic()
    coverage = {"process_memory_complete": True, "process_memory_denied": 0,
                "process_memory_scanned": 0, "process_memory_budget_exceeded": False}
    rows = []
    try:
        with os.scandir(proc_root) as entries:
            for entry in entries:
                if not entry.name.isdecimal():
                    continue
                if coverage["process_memory_scanned"] >= policy["process_memory_max_processes"] or monotonic() - started >= policy["process_memory_budget_seconds"]:
                    coverage.update(process_memory_complete=False, process_memory_budget_exceeded=True)
                    break
                coverage["process_memory_scanned"] += 1
                base = Path(proc_root) / entry.name
                status = small_read(base / "status")
                if status is None:
                    if base.exists():
                        coverage["process_memory_complete"] = False
                        coverage["process_memory_denied"] += 1
                    continue
                rss = re.search(r"^VmRSS:\s+(\d+)\s+kB", status, re.M)
                if not rss:
                    continue  # Kernel threads have no userspace RSS.
                parent = re.search(r"^PPid:\s+(\d+)", status, re.M)
                comm = re.search(r"^Name:\s+(.+)", status, re.M)
                rows.append({"pid": int(entry.name), "ppid": int(parent.group(1)) if parent else 0,
                             "comm": comm.group(1)[:128] if comm else "unknown", "rss_bytes": int(rss.group(1)) * 1024})
    except OSError:
        coverage["process_memory_complete"] = False
        coverage["process_memory_denied"] += 1
    rows.sort(key=lambda row: row["rss_bytes"], reverse=True)
    rows = rows[:policy["top_memory_processes"]]
    for row in rows:
        base = Path(proc_root) / str(row["pid"])
        row["cgroup"] = (small_read(base / "cgroup", 512) or "").strip()
        for key, filename in (("cwd", "cwd"), ("executable", "exe")):
            try:
                row[key] = os.readlink(base / filename)[:512]
            except OSError:
                row[key] = None
    coverage["process_memory_duration_seconds"] = round(monotonic() - started, 4)
    ratio = rows[0]["rss_bytes"] / total_memory_bytes if rows and total_memory_bytes else None
    return ratio, rows, coverage


def append_history(state_dir, snapshot, policy):
    """Keep three bounded private JSONL segments, including across restarts."""
    directory = Path(state_dir)
    path = directory / "samples.jsonl"
    line = (json.dumps(snapshot, separators=(",", ":"), allow_nan=False) + "\n").encode()
    if len(line) > policy["history_max_bytes"]:
        return  # A configured segment budget cannot be exceeded by one sample.
    try:
        size = path.stat().st_size
    except FileNotFoundError:
        size = 0
    if size + len(line) > policy["history_max_bytes"]:
        for index in range(policy["history_files"] - 1, 0, -1):
            old = path if index == 1 else directory / ("samples." + str(index - 1) + ".jsonl")
            new = directory / ("samples." + str(index) + ".jsonl")
            if old.exists():
                os.replace(old, new)
        if policy["history_files"] == 1:
            path.unlink(missing_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        remaining = memoryview(line)
        while remaining:
            remaining = remaining[os.write(descriptor, remaining):]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def collect_gpu(policy, runner=bounded_command):
    metrics = {"gpu_bar1_used_ratio": None, "gpu_vram_used_ratio": None,
               "gpu_temperature_c": None, "gpu_query_ok": None}
    if not shutil.which("nvidia-smi"):
        return metrics, {"gpu_available": False, "gpu_query_error": None}, []
    result = runner(["nvidia-smi", "-q", "-x"], timeout=policy["gpu_timeout_seconds"], max_bytes=512 * 1024)
    metrics["gpu_query_ok"] = bool(result["ok"])
    if not result["ok"]:
        return metrics, {"gpu_available": True, "gpu_query_error": result["error"]}, []
    try:
        root = ET.fromstring(result["stdout"])
        ratios, vram, temperatures, processes = [], [], [], []
        for gpu in root.findall("gpu")[:16]:
            for section, dest in (("bar1_memory_usage", ratios), ("fb_memory_usage", vram)):
                used, total = number(gpu.findtext(section + "/used")), number(gpu.findtext(section + "/total"))
                if used is not None and total is not None and total > 0:
                    dest.append(min(1.0, max(0.0, used / total)))
            temperature = number(gpu.findtext("temperature/gpu_temp"))
            if temperature is not None:
                temperatures.append(temperature)
            for row in gpu.findall("processes/process_info")[:128]:
                pid = number(row.findtext("pid"))
                if pid is not None:
                    processes.append({"pid": int(pid), "gpu_memory_mib": number(row.findtext("used_memory")),
                                      "type": (row.findtext("type") or "unknown")[:16]})
        metrics.update(gpu_bar1_used_ratio=max(ratios, default=None), gpu_vram_used_ratio=max(vram, default=None),
                       gpu_temperature_c=max(temperatures, default=None))
        return metrics, {"gpu_available": True, "gpu_query_error": None}, processes[:32]
    except (ET.ParseError, ValueError):
        metrics["gpu_query_ok"] = False
        return metrics, {"gpu_available": True, "gpu_query_error": "invalid_xml"}, []


def collect_services(policy, runner=bounded_command):
    rows, errors = [], []
    for scope, key in (("user", "important_user_units"), ("system", "important_system_units")):
        units = policy[key]
        if not units:
            continue
        argv = ["systemctl"] + (["--user"] if scope == "user" else []) + [
            "show", "--no-pager", "--property=Id,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus", *units]
        result = runner(argv, timeout=3, max_bytes=256 * 1024)
        if not result["ok"]:
            errors.append({"scope": scope, "error": result["error"]})
            continue
        for block in result["stdout"].decode("utf-8", "replace").strip().split("\n\n"):
            properties = dict(line.split("=", 1) for line in block.splitlines() if "=" in line)
            if properties.get("Id"):
                rows.append({"scope": scope, "unit": properties["Id"], "active_state": properties.get("ActiveState"),
                             "sub_state": properties.get("SubState"), "result": properties.get("Result"),
                             "exit_code": properties.get("ExecMainCode"), "exit_status": properties.get("ExecMainStatus")})
    return rows, errors


class ProcessActivity:
    """Interval CPU and storage-byte deltas, keyed by PID AND start time."""
    def __init__(self):
        self.previous = {}
        self.clock = None

    def sample(self, proc_root, policy, clock, monotonic=time.monotonic):
        started = monotonic()
        current, rows = {}, []
        coverage = {"process_activity_complete": True, "process_activity_denied": 0,
                    "process_activity_scanned": 0, "process_activity_baseline": self.clock is None}
        elapsed = clock - self.clock if self.clock is not None else 0
        ticks = os.sysconf("SC_CLK_TCK")
        try:
            with os.scandir(proc_root) as entries:
                for entry in entries:
                    if not entry.name.isdecimal():
                        continue
                    if len(current) >= policy["process_memory_max_processes"] or monotonic() - started >= policy["process_activity_budget_seconds"]:
                        coverage["process_activity_complete"] = False
                        break
                    coverage["process_activity_scanned"] += 1
                    base = Path(proc_root) / entry.name
                    stat = small_read(base / "stat")
                    if not stat:
                        if base.exists():
                            coverage["process_activity_denied"] += 1
                            coverage["process_activity_complete"] = False
                        continue
                    try:
                        fields = stat[stat.rindex(")") + 2:].split()
                        key = (int(entry.name), int(fields[19]))
                        cpu = int(fields[11]) + int(fields[12])
                        io = dict(re.findall(r"^(read_bytes|write_bytes):\s+(\d+)", small_read(base / "io") or "", re.M))
                        values = (cpu, number(io.get("read_bytes")), number(io.get("write_bytes")))
                        current[key] = values
                        prior = self.previous.get(key)
                        if prior is None or elapsed <= 0:
                            continue
                        rates = [(max(0, value - old) / elapsed if value is not None and old is not None else None)
                                 for value, old in zip(values, prior)]
                        rows.append({"pid": key[0], "start_ticks": key[1], "ppid": int(fields[1]),
                                     "comm": stat[stat.index("(") + 1:stat.rindex(")")][:128],
                                     "cpu_percent": round(rates[0] / ticks * 100, 2),
                                     "read_bytes_per_second": rates[1], "write_bytes_per_second": rates[2]})
                    except (ValueError, IndexError):
                        coverage["process_activity_complete"] = False
        except OSError:
            coverage["process_activity_complete"] = False
        cpu_rows = sorted(rows, key=lambda row: row["cpu_percent"], reverse=True)[:policy["top_activity_processes"]]
        io_rows = sorted((row for row in rows if (row["read_bytes_per_second"] or 0) + (row["write_bytes_per_second"] or 0) > 0),
                         key=lambda row: (row["read_bytes_per_second"] or 0) + (row["write_bytes_per_second"] or 0), reverse=True)[:policy["top_activity_processes"]]
        for row in {row["pid"]: row for row in cpu_rows + io_rows}.values():
            base = Path(proc_root) / str(row["pid"])
            row["cgroup"] = (small_read(base / "cgroup", 512) or "").strip()
            for key, filename in (("cwd", "cwd"), ("executable", "exe")):
                try:
                    row[key] = os.readlink(base / filename)[:512]
                except OSError:
                    row[key] = None
        coverage.update(process_activity_interval_seconds=elapsed,
                        process_activity_io_unavailable=sum(values[1] is None for values in current.values()),
                        process_activity_duration_seconds=round(monotonic() - started, 4),
                        process_activity_note="CPU percent per core; I/O is storage bytes, not net filesystem growth; unreadable or short-lived processes may be absent")
        self.previous, self.clock = current, clock
        return cpu_rows, io_rows, coverage


class DiskScanner:
    """Incremental same-filesystem allocation scan; no du storm on each alert."""
    def __init__(self, policy, monotonic=time.monotonic):
        self.policy, self.monotonic = policy, monotonic
        self.stack, self.result = [], {}
        self.last_finished = float("-inf")
        self.previous_sizes = {}
        self.previous_finished = None

    def _enter(self, path, root):
        try:
            if len(self.stack) >= 64:
                self.denied += 1
                self.incomplete_roots.add(root)
                return
            self.stack.append((os.scandir(path), root))
        except OSError:
            self.denied += 1
            self.incomplete_roots.add(root)

    def sample(self, now, clock):
        if not self.stack and clock - self.last_finished >= self.policy["disk_scan_interval_seconds"]:
            self.started, self.sizes, self.files, self.seen, self.denied, self.count = now, {}, [], set(), 0, 0
            self.incomplete_roots, self.bucket_roots = set(), {}
            self.device = os.stat(self.policy["disk_path"]).st_dev
            for root in self.policy["disk_scan_roots"]:
                try:
                    if os.stat(root).st_dev == self.device:
                        self._enter(root, root)
                except OSError:
                    self.denied += 1
                    self.incomplete_roots.add(root)
        start = self.monotonic()
        processed = 0
        while self.stack and processed < self.policy["disk_scan_max_entries_per_sample"] and self.monotonic() - start < self.policy["disk_scan_budget_seconds"]:
            iterator, root = self.stack[-1]
            try:
                entry = next(iterator)
            except StopIteration:
                iterator.close()
                self.stack.pop()
                continue
            except OSError:
                self.denied += 1
                self.incomplete_roots.add(root)
                iterator.close()
                self.stack.pop()
                continue
            processed += 1
            self.count += 1
            try:
                stat = entry.stat(follow_symlinks=False)
                if stat.st_dev != self.device or entry.is_symlink():
                    continue
                key = (stat.st_dev, stat.st_ino)
                if key in self.seen:
                    continue
                if entry.is_dir(follow_symlinks=False) or stat.st_nlink > 1:
                    self.seen.add(key)
                relative = Path(entry.path).relative_to(root)
                parts = relative.parts if entry.is_dir(follow_symlinks=False) else relative.parts[:-1]
                bucket = str(Path(root).joinpath(*parts[:2]))
                self.bucket_roots[bucket] = root
                allocated = stat.st_blocks * 512
                self.sizes[bucket] = self.sizes.get(bucket, 0) + allocated
                if entry.is_dir(follow_symlinks=False):
                    self._enter(entry.path, root)
                elif entry.is_file(follow_symlinks=False):
                    heapq.heappush(self.files, (allocated, entry.path))
                    if len(self.files) > 12:
                        heapq.heappop(self.files)
                if len(self.seen) >= self.policy["disk_scan_max_inodes"]:
                    for opened, _ in self.stack:
                        opened.close()
                    self.stack = []
                    self.denied += 1
                    self.incomplete_roots.update(self.policy["disk_scan_roots"])
            except OSError:
                self.denied += 1
                self.incomplete_roots.add(root)
        if not self.stack and hasattr(self, "started") and clock != self.last_finished and clock - self.last_finished >= self.policy["disk_scan_interval_seconds"]:
            rows = [{"path": path, "allocated_bytes": size,
                     "growth_bytes": size - self.previous_sizes[path] if path in self.previous_sizes and self.bucket_roots[path] not in self.incomplete_roots else None}
                    for path, size in self.sizes.items()]
            self.result = {"started_at": self.started, "finished_at": now, "entries_scanned": self.count,
                           "complete": self.denied == 0, "errors_or_limit_hits": self.denied,
                           "comparison_finished_at": self.previous_finished,
                           "largest_directories": sorted(rows, key=lambda row: row["allocated_bytes"], reverse=True)[:12],
                           "growing_directories": sorted((row for row in rows if (row["growth_bytes"] or 0) > 0), key=lambda row: row["growth_bytes"], reverse=True)[:12],
                           "largest_files": [{"path": path, "allocated_bytes": size} for size, path in sorted(self.files, reverse=True)],
                           "note": "Allocated bytes in configured roots, same filesystem only; rolling scan, not an atomic snapshot; partial scans do not establish growth"}
            self.previous_sizes = {path: size for path, size in self.sizes.items() if self.bucket_roots[path] not in self.incomplete_roots}
            self.previous_finished = now
            self.last_finished = clock
        return {**self.result, "in_progress": bool(self.stack),
                "age_seconds": max(0, now - self.result["finished_at"]) if self.result else None}


def diagnostic_context(snapshot):
    context = copy.deepcopy({key: snapshot.get(key) for key in ("timestamp", "metrics", "top_cpu_processes", "top_io_processes",
            "top_memory_processes", "temperature_sensors", "disk_attribution", "services", "coverage")})
    # Keep retained event history below the investigator's bounded read limit.
    lists = [context.get(key) for key in ("top_memory_processes", "top_io_processes", "top_cpu_processes")]
    disk = context.get("disk_attribution") or {}
    lists += [disk.get(key) for key in ("largest_files", "largest_directories", "growing_directories")]
    while len(json.dumps(context).encode()) > 20 * 1024:
        candidate = next((rows for rows in lists if isinstance(rows, list) and rows), None)
        if candidate is None:
            context = {"timestamp": snapshot.get("timestamp"), "metrics": snapshot.get("metrics"),
                       "context_truncated": True}
            break
        candidate.pop()
        context["context_truncated"] = True
    return context


class Sampler:
    def __init__(self, policy, proc_root="/proc", sys_root="/sys", runner=bounded_command, monotonic=time.monotonic):
        self.policy, self.proc_root, self.sys_root = policy, Path(proc_root), Path(sys_root)
        self.runner, self.monotonic = runner, monotonic
        self.watchers, self.gpu, self.services = None, None, None
        self.last_watchers = self.last_gpu = self.last_services = float("-inf")
        self.process_memory = None
        self.last_process_memory = float("-inf")
        self.activity = ProcessActivity()
        self.disk_scanner = DiskScanner(policy, monotonic)

    def sample(self, now=None):
        now = time.time() if now is None else now
        clock = self.monotonic()
        metrics, coverage = {}, {}
        meminfo = small_read(self.proc_root / "meminfo")
        memory = dict(re.findall(r"^(\w+):\s+(\d+)", meminfo or "", re.M))
        total, available = number(memory.get("MemTotal")), number(memory.get("MemAvailable"))
        metrics["memory_available_ratio"] = min(1.0, max(0.0, available / total)) if total and available is not None else None
        for metric, source, kind in (("memory_psi_some", "memory", "some"), ("memory_psi_full", "memory", "full"),
                                     ("cpu_psi_some", "cpu", "some"), ("io_psi_full", "io", "full")):
            metrics[metric] = psi_value(self.proc_root / "pressure" / source, kind)
        coverage["memory_available"] = metrics["memory_available_ratio"] is not None
        metrics["memory_total_bytes"] = int(total * 1024) if total is not None else None
        cpu_processes, io_processes, activity_coverage = self.activity.sample(self.proc_root, self.policy, clock, self.monotonic)
        coverage.update(activity_coverage)
        if self.process_memory is None or clock - self.last_process_memory >= self.policy["process_memory_interval_seconds"]:
            self.process_memory = collect_process_memory(self.proc_root, self.policy, metrics["memory_total_bytes"], self.monotonic)
            self.last_process_memory = clock
            self.process_memory_sample_wall = now
        metrics["largest_process_memory_ratio"], memory_processes, memory_coverage = self.process_memory
        coverage.update(memory_coverage)
        coverage["process_memory_sample_timestamp"] = self.process_memory_sample_wall
        coverage["process_memory_sample_age_seconds"] = max(0.0, clock - self.last_process_memory)
        coverage["psi_available"] = all(metrics[key] is not None for key in ("memory_psi_some", "memory_psi_full", "cpu_psi_some", "io_psi_full"))
        try:
            disk = os.statvfs(self.policy["disk_path"])
            metrics["disk_used_ratio"] = (disk.f_blocks - disk.f_bfree) / (disk.f_blocks - disk.f_bfree + disk.f_bavail) if disk.f_blocks - disk.f_bfree + disk.f_bavail else None
            metrics["disk_inode_used_ratio"] = (disk.f_files - disk.f_ffree) / disk.f_files if disk.f_files else None
            metrics["disk_available_bytes"] = disk.f_bavail * disk.f_frsize
            metrics["disk_used_bytes"] = (disk.f_blocks - disk.f_bfree) * disk.f_frsize
            coverage["disk_available"] = True
        except OSError:
            metrics["disk_used_ratio"] = metrics["disk_inode_used_ratio"] = None
            coverage["disk_available"] = False
        coverage["disk_path"] = self.policy["disk_path"]
        if self.watchers is None or clock - self.last_watchers >= self.policy["watcher_interval_seconds"]:
            self.watchers = collect_watchers(self.proc_root, self.policy, monotonic=self.monotonic)
            self.last_watchers = clock
            self.watchers_sample_wall = now
        watcher_metrics, watchers, watcher_coverage = self.watchers
        metrics.update(watcher_metrics)
        coverage.update(watcher_coverage)
        coverage["pid1_comm"] = (small_read(self.proc_root / "1/comm", 128) or "unknown").strip()
        coverage["process_namespace_host_confirmed"] = coverage["pid1_comm"] in ("systemd", "init")
        if not coverage["process_namespace_host_confirmed"]:
            coverage["watchers_complete"] = False
            coverage["process_memory_complete"] = False
            coverage["process_activity_complete"] = False
        coverage["watcher_sample_age_seconds"] = max(0.0, clock - self.last_watchers)
        coverage["watcher_sample_timestamp"] = self.watchers_sample_wall
        for key, filename in (("inotify_watch_limit", "max_user_watches"), ("inotify_instance_limit", "max_user_instances")):
            value = number(small_read(self.proc_root / "sys/fs/inotify" / filename, 64))
            metrics[key] = int(value) if value is not None else None
        metrics["temperature_c"], sensors = collect_temperature(self.sys_root)
        coverage["temperature_available"] = metrics["temperature_c"] is not None
        if self.gpu is None or clock - self.last_gpu >= self.policy["gpu_interval_seconds"]:
            self.gpu = collect_gpu(self.policy, self.runner)
            self.last_gpu = clock
            self.gpu_sample_wall = now
        gpu_metrics, gpu_coverage, gpu_processes = self.gpu
        metrics.update(gpu_metrics)
        coverage.update(gpu_coverage)
        coverage["gpu_sample_age_seconds"] = max(0.0, clock - self.last_gpu)
        coverage["gpu_sample_timestamp"] = self.gpu_sample_wall
        if self.services is None or clock - self.last_services >= self.policy["service_interval_seconds"]:
            self.services = collect_services(self.policy, self.runner)
            self.last_services = clock
            self.services_sample_wall = now
        services, service_errors = self.services
        coverage["services_available"] = not service_errors
        coverage["service_errors"] = service_errors
        coverage["service_sample_age_seconds"] = max(0.0, clock - self.last_services)
        coverage["service_sample_timestamp"] = self.services_sample_wall
        return {"schema": 1, "timestamp": now, "boot_id": (small_read(self.proc_root / "sys/kernel/random/boot_id", 128) or "unknown").strip(),
                "host": socket.gethostname(), "metrics": metrics, "top_watchers": watchers,
                "top_memory_processes": memory_processes, "top_gpu_processes": gpu_processes,
                "top_cpu_processes": cpu_processes, "top_io_processes": io_processes,
                "disk_attribution": self.disk_scanner.sample(now, clock) if coverage["disk_available"] else {},
                "temperature_sensors": sensors, "services": services, "coverage": coverage}


KERNEL_RULES = (
    ("kernel_oom", "critical", r"out of memory:|oom-kill:|killed process \d+|memory cgroup out of memory"),
    ("nvidia_xid", "critical", r"NVRM:.*Xid\b"),
    ("nvidia_mapping", "critical", r"NVRM:.*(?:mapping|allocation|alloc).*fail|nvAssertFailed|nvCheckFailed|NVRM:.*GPU.*fallen off"),
    ("kernel_lockup", "critical", r"(?:soft|hard) lockup|watchdog:.*lockup|rcu:.*stall|blocked for more than \d+ seconds"),
    ("storage_error", "critical", r"(?:nvme|ata\d|scsi|blk_update_request|I/O error).*(?:error|timeout|timed out|reset|failed)|buffer I/O error"),
    ("filesystem_error", "critical", r"EXT4-fs error|BTRFS.*(?:error|corrupt)|XFS.*(?:corrupt|error)|remount.*read-only"),
    ("thermal_critical", "critical", r"(?:thermal|temperature).*(?:critical|above threshold|shutdown|overheat)"),
)


def classify_journal(record, policy):
    message = record.get("MESSAGE", "")
    if not isinstance(message, str):
        return None
    evidence = {"journal_cursor": record.get("__CURSOR"), "boot_id": record.get("_BOOT_ID"),
                "journal_timestamp": record.get("__REALTIME_TIMESTAMP")}
    if record.get("_TRANSPORT") == "kernel":
        for event_type, severity, pattern in KERNEL_RULES:
            match = re.search(pattern, message, re.I)
            if match:
                # Bounded diagnostic text, untrusted and private; never execute it.
                evidence["matched_error"] = match.group(0)[:180]
                evidence["message"] = message[:1024]
                evidence["source"] = "kernel"
                return {"type": event_type, "severity": severity, "summary": event_type.replace("_", " ").capitalize(), "evidence": evidence}
    if record.get("SYSLOG_IDENTIFIER") == "systemd" and re.search(r"failed|failure|main process exited", message, re.I):
        for scope, key in (("user", "important_user_units"), ("system", "important_system_units")):
            for unit in policy[key]:
                if unit == record.get("USER_UNIT" if scope == "user" else "UNIT") or re.search(r"(?<![\w.@-])" + re.escape(unit) + r"(?![\w.@-])", message):
                    evidence.update(unit=unit, scope=scope, result=record.get("RESULT"), exit_status=record.get("EXIT_STATUS"))
                    evidence["message"] = message[:1024]
                    return {"type": "service_failed:" + scope + ":" + unit, "severity": "critical",
                            "summary": "Important service failed: " + unit, "evidence": evidence}
    return None


class JournalReader:
    def __init__(self, state_dir, policy, runner=bounded_command):
        self.path = Path(state_dir) / "journal-cursor.json"
        self.policy, self.runner = policy, runner
        self.state = read_json(self.path, {})
        self.kernel_context = []

    def poll(self, boot_id, now):
        """Return an uncommitted cursor; persist only AFTER incident writes."""
        baseline = self.state.get("boot_id") != boot_id or not self.state.get("initialized")
        state = {"boot_id": boot_id, "initialized": True, "since": now, "cursor": None} if baseline else dict(self.state)
        argv = ["journalctl", "--no-pager", "--quiet", "--output=json", "--boot=" + boot_id.replace("-", ""),
                "--output-fields=__CURSOR,__REALTIME_TIMESTAMP,_BOOT_ID,_TRANSPORT,SYSLOG_IDENTIFIER,MESSAGE,UNIT,USER_UNIT,RESULT,EXIT_STATUS"]
        if baseline:
            argv += ["--lines=1"]
        else:
            argv += ["--lines=+" + str(self.policy["journal_max_events"])]
            if state.get("cursor"):
                argv += ["--after-cursor=" + state["cursor"]]
            else:
                argv += ["--since=@" + str(state["since"])]
        argv += ["_TRANSPORT=kernel", "+", "SYSLOG_IDENTIFIER=systemd"]
        result = self.runner(argv, timeout=self.policy["journal_timeout_seconds"], max_bytes=self.policy["journal_max_bytes"])
        if not result["ok"]:
            # Cursor may have rotated out; reset once, avoiding old-journal replay.
            if result["error"] and result["error"].startswith("exit_") and state.get("cursor"):
                state.update(cursor=None, since=now)
            return [], {"journal_available": False, "journal_error": result["error"], "journal_backlog": False}, state
        records, malformed = [], False
        for line in result["stdout"].splitlines()[:self.policy["journal_max_events"]]:
            try:
                record = json.loads(line)
                if isinstance(record, dict):
                    records.append(record)
                else:
                    malformed = True
            except ValueError:
                malformed = True
        if records and records[-1].get("__CURSOR"):
            state["cursor"] = records[-1]["__CURSOR"]
        if not state.get("cursor"):
            state["since"] = now
        events = []
        if baseline:
            self.kernel_context = []
        kernel_rows = [{"timestamp": record.get("__REALTIME_TIMESTAMP"), "message": record["MESSAGE"][:1024]}
                       for record in records if record.get("_TRANSPORT") == "kernel" and isinstance(record.get("MESSAGE"), str)]
        context = self.kernel_context + kernel_rows
        if not baseline:
            for record in records:
                event = classify_journal(record, self.policy)
                if event:
                    if record.get("_TRANSPORT") == "kernel":
                        target = number(record.get("__REALTIME_TIMESTAMP"))
                        nearby = [row for row in context if target is not None and
                            (stamp := number(row["timestamp"])) is not None and abs(stamp - target) <= 30_000_000]
                        nearest = sorted(nearby, key=lambda row: abs(number(row["timestamp"]) - target))[:16]
                        event["evidence"]["kernel_context"] = sorted(nearest, key=lambda row: number(row["timestamp"]))
                    events.append(event)
        self.kernel_context = context[-16:]
        return events, {"journal_available": not malformed, "journal_error": "invalid_json" if malformed else None,
                        "journal_baseline": baseline, "journal_events_read": len(records),
                        "journal_backlog": len(records) >= self.policy["journal_max_events"]}, state

    def commit(self, state):
        atomic_json(self.path, state)
        self.state = state


class IncidentEngine:
    def __init__(self, state_dir, policy):
        self.directory = Path(state_dir)
        self.policy = policy
        self.state = read_json(self.directory / "rule-state.json", {"schema": 1, "rules": {}, "boot_id": None})
        self.state.setdefault("rules", {})
        self.last_prune = float("-inf")

    def _incident(self, rule):
        if rule.get("incident_id"):
            incident = read_json(self.directory / "incidents" / (rule["incident_id"] + ".json"), None)
            if isinstance(incident, dict) and incident.get("status") == "open":
                return incident
        return None

    def _write(self, incident):
        atomic_json(self.directory / "incidents" / (incident["id"] + ".json"), incident)

    def open(self, event_type, severity, summary, evidence, now, host, boot_id, event=False):
        rule = self.state["rules"].setdefault(event_type, {})
        incident = self._incident(rule)
        if incident is None:
            event_key = str(evidence.get("journal_cursor") or (boot_id + ":" + str(rule.setdefault("pending_since", now))))
            incident_id = str(uuid.uuid5(uuid.NAMESPACE_URL, host + ":" + event_type + ":" + event_key))
            # Replayed event after a crash updates the same ID rather than duplicating it.
            incident = read_json(self.directory / "incidents" / (incident_id + ".json"), None)
            if not isinstance(incident, dict):
                incident = {"id": incident_id, "host": host, "type": event_type, "severity": severity,
                            "status": "open", "first_seen": now, "last_seen": now, "summary": summary,
                            "evidence": evidence, "delivery": {}}
            rule["incident_id"] = incident_id
        if severity == "critical" or incident["severity"] != "critical":
            incident["severity"] = severity
        previous_event_cursor = incident.get("evidence", {}).get("journal_cursor")
        if "initial_evidence" not in incident:
            incident["initial_evidence"] = copy.deepcopy(evidence)
        value = evidence.get("value")
        if isinstance(value, (int, float)) and value > incident.get("peak_value", float("-inf")):
            incident.update(peak_value=value, peak_evidence=copy.deepcopy(evidence))
        if event:
            incident["event_evidence"] = (incident.get("event_evidence", []) + [copy.deepcopy(evidence)])[-4:]
        incident.update(status="open", last_seen=now, summary=summary, evidence=evidence)
        if event:
            if not incident.get("occurrences") or previous_event_cursor != evidence.get("journal_cursor") or not evidence.get("journal_cursor"):
                incident["occurrences"] = incident.get("occurrences", 0) + 1
            rule.update(last_event_cursor=evidence.get("journal_cursor"), event=True, last_event=now)
        self._write(incident)
        return incident

    def resolve(self, event_type, now, reason, evidence=None):
        rule = self.state["rules"].get(event_type, {})
        incident = self._incident(rule)
        if incident:
            incident.update(status="resolved", resolved_at=now, resolution=reason)
            if evidence is not None:
                incident["resolution_evidence"] = evidence
            self._write(incident)
        for key in ("incident_id", "pending_since", "event", "last_event", "last_event_cursor"):
            rule.pop(key, None)
        rule.update(streak=0, clear_streak=0, level=None)

    def threshold(self, event_type, level, clear, evidence, now, host, boot_id, summary, sample_token=None):
        rule = self.state["rules"].setdefault(event_type, {})
        if sample_token is not None:
            if rule.get("last_sample_token") == sample_token:
                return
            rule["last_sample_token"] = sample_token
        if level:
            rule["clear_streak"] = 0
            if rule.get("level") != level:
                rule.update(level=level, streak=0)
            rule.setdefault("pending_since", now)
            rule["streak"] = rule.get("streak", 0) + 1
            incident = self._incident(rule)
            if rule["streak"] >= self.policy["sustained_samples"] or (incident and incident["severity"] == level):
                self.open(event_type, level, summary, evidence, now, host, boot_id)
        else:
            rule.update(streak=0, level=None)
            if clear:
                rule["clear_streak"] = rule.get("clear_streak", 0) + 1
                if rule["clear_streak"] >= self.policy["recovery_samples"]:
                    self.resolve(event_type, now, "Metric recovered below the configured clear threshold", evidence)
            else:
                rule["clear_streak"] = 0

    def evaluate(self, snapshot, events=()):
        now, host, boot_id = snapshot["timestamp"], snapshot["host"], snapshot["boot_id"]
        old_boot = self.state.get("boot_id")
        if old_boot and old_boot != boot_id:
            for event_type in list(self.state["rules"]):
                self.resolve(event_type, now, "Host restarted; continuing with samples from the new boot")
                self.state["rules"][event_type].pop("last_sample_token", None)
            self.open("host_restarted", "warning", "Host restarted since the previous sample",
                      {"previous_boot_id": old_boot, "boot_id": boot_id}, now, host, boot_id, event=True)
        self.state["boot_id"] = boot_id
        metrics = snapshot["metrics"]
        temps = [metrics.get("temperature_c"), metrics.get("gpu_temperature_c")]
        rules = {"inotify_watches": (metrics.get("inotify_watches"), metrics.get("inotify_watch_limit")),
                 "inotify_instances": (metrics.get("inotify_instances"), metrics.get("inotify_instance_limit")),
                 "io_pressure": metrics.get("io_psi_full"), "disk": metrics.get("disk_used_ratio"),
                 "disk_inodes": metrics.get("disk_inode_used_ratio"),
                 "temperature": max((v for v in temps if v is not None), default=None),
                 "gpu_bar1": metrics.get("gpu_bar1_used_ratio"),
                 "process_memory": metrics.get("largest_process_memory_ratio")}
        for name, value in rules.items():
            if isinstance(value, tuple):
                value = value[0] / value[1] if value[0] is not None and value[1] else None
            if (name.startswith("inotify") or name == "process_memory") and snapshot["coverage"].get("process_namespace_host_confirmed") is False:
                value = None
            limits = self.policy["thresholds"][name]
            level = "critical" if value is not None and value >= limits["critical"] else "warning" if value is not None and value >= limits["warning"] else None
            evidence = {"value": value, "thresholds": limits}
            if name in ("temperature", "io_pressure", "disk", "disk_inodes"):
                evidence["context"] = diagnostic_context(snapshot)
            if name.startswith("inotify"):
                evidence.update(top_watchers=snapshot["top_watchers"], coverage={key: val for key, val in snapshot["coverage"].items() if "watch" in key},
                                note="Visible process FD sums can count shared watches repeatedly; inspect attribution before changing limits")
            if name == "process_memory":
                evidence.update(top_memory_processes=snapshot.get("top_memory_processes", []),
                                coverage={key: val for key, val in snapshot["coverage"].items() if key.startswith("process_memory")},
                                note="Per-process resident bytes include shared pages; alert-only attribution, no automatic termination")
            sample_token = snapshot["coverage"].get("watcher_sample_timestamp") if name.startswith("inotify") else snapshot["coverage"].get("gpu_sample_timestamp") if name == "gpu_bar1" else None
            if name == "process_memory":
                sample_token = snapshot["coverage"].get("process_memory_sample_timestamp")
            clear = value is not None and value < limits["clear"]
            if name.startswith("inotify") and not snapshot["coverage"].get("watchers_complete", False):
                clear = False
            if name == "process_memory" and not snapshot["coverage"].get("process_memory_complete", False):
                clear = False
            self.threshold(name, level, clear, evidence,
                           now, host, boot_id, name.replace("_", " ").capitalize() + " sustained above threshold", sample_token)
        limits = self.policy["thresholds"]["memory"]
        available, pressure = metrics.get("memory_available_ratio"), metrics.get("memory_psi_some")
        pressured = pressure is not None and pressure >= limits["minimum_psi"]
        level = "critical" if available is not None and available < limits["critical"] and pressured else "warning" if available is not None and available < limits["warning"] and pressured else None
        self.threshold("memory", level, available is not None and available >= limits["clear"],
                       {"available_ratio": available, "psi_some_avg10": pressure, "psi_full_avg10": metrics.get("memory_psi_full"), "thresholds": limits},
                       now, host, boot_id, "Low available memory with sustained memory pressure")
        for name, present in (("monitor_journal", snapshot["coverage"].get("journal_available")),
                              ("monitor_service_queries", snapshot["coverage"].get("services_available")),
                              ("monitor_process_namespace", snapshot["coverage"].get("process_namespace_host_confirmed"))):
            if present is not None:
                prefix = "journal" if name == "monitor_journal" else "service" if name == "monitor_service_queries" else "process_namespace"
                self.threshold(name, "warning" if not present else None, bool(present),
                               {"coverage": {key: val for key, val in snapshot["coverage"].items() if key.startswith(prefix)},
                                **({"pid1_comm": snapshot["coverage"].get("pid1_comm")} if name == "monitor_process_namespace" else {})},
                               now, host, boot_id, "Monitoring source unavailable: " + name)
        if snapshot["coverage"].get("gpu_available"):
            ok = metrics.get("gpu_query_ok")
            self.threshold("monitor_gpu_query", "warning" if ok is False else None, ok is True,
                           {"error": snapshot["coverage"].get("gpu_query_error")}, now, host, boot_id, "NVIDIA health query repeatedly failed",
                           snapshot["coverage"].get("gpu_sample_timestamp"))
        for service in snapshot.get("services", []):
            name = "service_failed:" + service["scope"] + ":" + service["unit"]
            active = service.get("active_state")
            if active == "failed":
                self.open(name, "critical", "Important service failed: " + service["unit"], service, now, host, boot_id)
            else:
                self.threshold(name, "warning" if active not in ("active", "activating", "reloading") else None,
                               active == "active", service, now, host, boot_id, "Important service is not active: " + service["unit"],
                               snapshot["coverage"].get("service_sample_timestamp"))
        for event in events:
            self.open(event["type"], event["severity"], event["summary"],
                      {**event["evidence"], "context": diagnostic_context(snapshot)}, now, host, boot_id, event=True)
        for event_type, rule in list(self.state["rules"].items()):
            if rule.get("event") and now - rule.get("last_event", now) >= self.policy["event_quiet_seconds"]:
                self.resolve(event_type, now, "No further matching journal events during the configured quiet period")
        atomic_json(self.directory / "rule-state.json", self.state)
        if now - self.last_prune >= 3600:
            self.prune(now)
            self.last_prune = now

    def prune(self, now):
        resolved = []
        for index, path in enumerate((self.directory / "incidents").glob("*.json")):
            if index >= 4096:
                break
            incident = read_json(path, {})
            if incident.get("status") == "resolved":
                resolved.append((incident.get("resolved_at", incident.get("last_seen", now)), path))
        resolved.sort(reverse=True)
        cutoff = now - self.policy["resolved_retention_days"] * 86400
        for index, (resolved_at, path) in enumerate(resolved):
            if resolved_at < cutoff or index >= self.policy["max_resolved_incidents"]:
                path.unlink(missing_ok=True)


def collect_once(sampler, journal, engine, state_dir, now=None):
    snapshot = sampler.sample(now)
    events, coverage, cursor_state = journal.poll(snapshot["boot_id"], snapshot["timestamp"])
    snapshot["coverage"].update(coverage)
    engine.evaluate(snapshot, events)
    journal.commit(cursor_state)
    atomic_json(Path(state_dir) / "metrics.json", snapshot)
    append_history(state_dir, snapshot, sampler.policy)
    return snapshot


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--policy")
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    os.umask(0o077)
    policy = load_policy(args.policy)
    directory = Path(args.state_dir)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Avoid two writers corrupting dedup state after accidental double activation.
    import fcntl
    with open(directory / "collector.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.exit(1, "A host-health collector already owns this state directory\n")
        sampler, journal, engine = Sampler(policy), JournalReader(directory, policy), IncidentEngine(directory, policy)
        stopped = False

        def stop(_signum, _frame):
            nonlocal stopped
            stopped = True

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        while not stopped:
            started = time.monotonic()
            collect_once(sampler, journal, engine, directory)
            if args.once:
                break
            delay = max(0.0, policy["interval_seconds"] - (time.monotonic() - started))
            # Interruptible short sleeps; no child command survives collector exit.
            while not stopped and delay > 0:
                duration = min(delay, .5)
                time.sleep(duration)
                delay -= duration


if __name__ == "__main__":
    main()
