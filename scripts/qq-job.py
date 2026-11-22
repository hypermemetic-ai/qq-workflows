#!/usr/bin/env python3
"""Run a command in a verified user-systemd cgroup, retaining the caller sandbox.

Scopes attach our newly forked gate; the user manager never executes the command.
PIDs=[0] identifies the bus sender in the manager's PID namespace (systemd v255,
src/core/dbus-scope.c). Never replace this with the caller's namespace-local PID.

3SEN work (a working directory under the policy's slot_routing.path_prefixes)
is handed to slot instead (/home/qqp/.local/bin/slot): one queue, pinned cores,
the GPU grant and one memory total without swap for every 3SEN job. slot's
own per-job cap applies (7G, 9G on slot 1), or the profile's memory_max as
SLOT_MEM when it is above 7G (large), or the caller's own SLOT_MEM.
"""
from __future__ import annotations

import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import uuid

GIB = 1024 ** 3
MIB = 1024 ** 2
FAILURE = 125
UNIT_RE = re.compile(r"qq-job-[0-9a-f]{32}\.scope\Z")
PROFILE_RE = re.compile(r"[a-z][a-z0-9-]{0,39}\Z")
BOOT_RE = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
# slot names each job's scope slot-<lane><n>-<slot's pid>-<random>.scope.
SLOT_SCOPE_RE = re.compile(r"slot-(?:slot|light)[0-9]{1,3}-([0-9]{1,10})-[0-9]{1,10}\.scope\Z")
# slot's own cap for a heavy job when SLOT_MEM is unset (9G on slot 1). A
# routed job sets SLOT_MEM only for a profile above it (large, 8G); others get
# slot's default, under slot's 20G total with no swap.
SLOT_HEAVY_DEFAULT_BYTES = 7 * 1024 ** 3
# Jobs whose resolved working directory starts with one of these strings run
# through slot. An entry ending in "/" is a directory; any other entry is also
# a name prefix (".../fgx-" covers fgx-play, fgx-motion and so on).
DEFAULT_SLOT_ROUTING = {
    "slot": "/home/qqp/.local/bin/slot",
    "path_prefixes": [
        "/home/qqp/.t3/worktrees/fgx/",
        "/home/qqp/.t3/worktrees/t3-1e496f5b/",
        "/home/qqp/projects/fgx",
        "/home/qqp/projects/3sen",
        "/home/qqp/tmp/",
        "/scratch/",
        "/home/qqp/.local/share/three-sen-",
        "/home/qqp/.local/share/fgx-",
    ],
}
DEFAULT_POLICY = {
    "schema": 1,
    "slice": "qqjobs.slice",
    "aggregate": {"memory_high_bytes": 8 * GIB, "memory_max_bytes": 12 * GIB,
                  "memory_swap_max_bytes": GIB},
    "default_profile": "default",
    "profiles": {
        "default": {"memory_high_bytes": 3 * GIB, "memory_max_bytes": 4 * GIB,
                    "memory_swap_max_bytes": 256 * MIB, "tasks_max": 256,
                    "cpu_weight": 50},
        "large": {"memory_high_bytes": 6 * GIB, "memory_max_bytes": 8 * GIB,
                  "memory_swap_max_bytes": 512 * MIB, "tasks_max": 512,
                  "cpu_weight": 50},
        "oom-proof": {"memory_high_bytes": 64 * MIB, "memory_max_bytes": 64 * MIB,
                      "memory_swap_max_bytes": 0, "tasks_max": 32,
                      "cpu_weight": 50, "runtime_seconds": 10},
    },
    "state_dir": "~/.local/state/qq-job",
    "monitor_state_dir": "~/.local/state/qq-host-monitor",
    "max_job_records": 200,
    "slot_routing": DEFAULT_SLOT_ROUTING,
}


class ContainmentError(RuntimeError):
    pass


def bounded_json(path: Path, limit: int = 65536):
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ContainmentError("configuration or job record exceeds its size limit")
    return json.loads(data)


def positive(value, name, *, zero=False, maximum=2 ** 63 - 1):
    if isinstance(value, bool) or not isinstance(value, int) or not (0 if zero else 1) <= value <= maximum:
        raise ContainmentError(f"invalid {name}")
    return value


def validate_policy(policy):
    if not isinstance(policy, dict) or policy.get("schema") != 1:
        raise ContainmentError("unsupported qq-job policy schema")
    if policy.get("slice") != "qqjobs.slice":
        raise ContainmentError("jobs must use qqjobs.slice")
    aggregate = policy.get("aggregate", {})
    if not isinstance(aggregate, dict):
        raise ContainmentError("invalid aggregate budget")
    for key in ["memory_high_bytes", "memory_max_bytes", "memory_swap_max_bytes"]:
        positive(aggregate.get(key), key, zero=key == "memory_swap_max_bytes")
    if aggregate["memory_high_bytes"] > aggregate["memory_max_bytes"]:
        raise ContainmentError("aggregate memory high exceeds maximum")
    profiles = policy.get("profiles")
    if not isinstance(profiles, dict) or not profiles or len(profiles) > 32:
        raise ContainmentError("policy must define a bounded profile list")
    for name, profile in profiles.items():
        if not isinstance(name, str) or not PROFILE_RE.fullmatch(name) or not isinstance(profile, dict):
            raise ContainmentError("invalid profile")
        allowed = {"memory_high_bytes", "memory_max_bytes", "memory_swap_max_bytes",
                   "tasks_max", "cpu_weight", "runtime_seconds"}
        if set(profile) - allowed:
            raise ContainmentError(f"unknown setting in profile {name}")
        for key in allowed - {"runtime_seconds"}:
            positive(profile.get(key), key, zero=key == "memory_swap_max_bytes",
                     maximum=10000 if key.endswith("weight") else 2 ** 63 - 1)
        if "runtime_seconds" in profile:
            positive(profile["runtime_seconds"], "runtime_seconds", maximum=86400)
        if profile["memory_high_bytes"] > profile["memory_max_bytes"]:
            raise ContainmentError("profile memory high exceeds maximum")
        for key in ["memory_high_bytes", "memory_max_bytes", "memory_swap_max_bytes"]:
            if profile[key] > aggregate[key]:
                raise ContainmentError("profile exceeds aggregate budget")
    if policy.get("default_profile") not in profiles:
        raise ContainmentError("default profile is not configured")
    positive(policy.get("max_job_records"), "max_job_records", maximum=1000)
    for key in ["state_dir", "monitor_state_dir"]:
        if not isinstance(policy.get(key), str) or not policy[key]:
            raise ContainmentError(f"invalid {key}")
    # A policy written before slot routing existed gets the default routing.
    routing = policy.setdefault("slot_routing", json.loads(json.dumps(DEFAULT_SLOT_ROUTING)))
    if not isinstance(routing, dict) or set(routing) - {"slot", "path_prefixes"}:
        raise ContainmentError("invalid slot_routing")
    routing.setdefault("slot", DEFAULT_SLOT_ROUTING["slot"])
    routing.setdefault("path_prefixes", list(DEFAULT_SLOT_ROUTING["path_prefixes"]))
    if not isinstance(routing["slot"], str) or not os.path.isabs(routing["slot"]):
        raise ContainmentError("slot_routing.slot must be an absolute path")
    prefixes = routing["path_prefixes"]
    if not isinstance(prefixes, list) or len(prefixes) > 64 or not all(
            isinstance(prefix, str) and os.path.isabs(prefix) and prefix.strip("/")
            and "\0" not in prefix and len(prefix) < 4096 for prefix in prefixes):
        raise ContainmentError("slot_routing.path_prefixes must be absolute paths other than /")
    return policy


def load_policy(path=None):
    path = path or Path.home() / ".config/qq-job/policy.json"
    if path.exists():
        info = path.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid not in [os.getuid(), 0] or info.st_mode & 0o022:
            raise ContainmentError("policy must be an operator-owned regular file without group/world write access")
        policy = bounded_json(path)
    else:
        policy = json.loads(json.dumps(DEFAULT_POLICY))
    return validate_policy(policy)


def profile_for(policy, name=None):
    name = name or policy["default_profile"]
    if name not in policy["profiles"]:
        raise ContainmentError(f"profile {name!r} is not approved in the operator configuration")
    return name, policy["profiles"][name]


def scope_properties(policy, profile):
    result = [
        ("Description", "s", "qq-job contained command"),
        ("Slice", "s", policy["slice"]),
        ("PIDs", "au", [0]),
        ("MemoryHigh", "t", profile["memory_high_bytes"]),
        ("MemoryMax", "t", profile["memory_max_bytes"]),
        ("MemorySwapMax", "t", profile["memory_swap_max_bytes"]),
        ("TasksMax", "t", profile["tasks_max"]),
        ("CPUWeight", "t", profile["cpu_weight"]),
        ("OOMPolicy", "s", "kill"),
        ("KillMode", "s", "control-group"),
        ("TimeoutStopUSec", "t", 2_000_000),
        ("SendSIGKILL", "b", True),
        ("MemoryAccounting", "b", True),
        ("TasksAccounting", "b", True),
    ]
    if profile.get("runtime_seconds"):
        result.append(("RuntimeMaxUSec", "t", profile["runtime_seconds"] * 1_000_000))
    return result


class BusError(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("message", ctypes.c_char_p), ("need_free", ctypes.c_int)]


class UserBus:
    """Tiny sd-bus binding: existing process attachment only, never ExecStart."""
    def __init__(self):
        self.lib = ctypes.CDLL("libsystemd.so.0")
        pointer = ctypes.c_void_p
        specifications = {
            "sd_bus_open_user": ([ctypes.POINTER(pointer)], ctypes.c_int),
            "sd_bus_unref": ([pointer], pointer),
            "sd_bus_message_unref": ([pointer], pointer),
            "sd_bus_error_free": ([ctypes.POINTER(BusError)], None),
            "sd_bus_message_new_method_call": ([pointer, ctypes.POINTER(pointer), ctypes.c_char_p,
                                                  ctypes.c_char_p, ctypes.c_char_p, ctypes.c_char_p], ctypes.c_int),
            "sd_bus_message_open_container": ([pointer, ctypes.c_char, ctypes.c_char_p], ctypes.c_int),
            "sd_bus_message_close_container": ([pointer], ctypes.c_int),
            "sd_bus_message_append_basic": ([pointer, ctypes.c_char, pointer], ctypes.c_int),
            "sd_bus_message_set_allow_interactive_authorization": ([pointer, ctypes.c_int], ctypes.c_int),
            "sd_bus_call": ([pointer, pointer, ctypes.c_uint64, ctypes.POINTER(BusError),
                              ctypes.POINTER(pointer)], ctypes.c_int),
        }
        for name, (args, result) in specifications.items():
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, result
        self.bus = pointer()
        self.check(self.lib.sd_bus_open_user(ctypes.byref(self.bus)), "connect to user systemd bus")

    @staticmethod
    def check(result, operation):
        if result < 0:
            raise ContainmentError(f"cannot {operation}: {os.strerror(-result)}")

    def close(self):
        if self.bus:
            self.lib.sd_bus_unref(self.bus)
            self.bus = ctypes.c_void_p()

    def append(self, message, kind, value):
        if kind in ["s", "o"]:
            data = ctypes.c_char_p(value.encode())
            pointer = ctypes.cast(data, ctypes.c_void_p)
        else:
            data = {"u": ctypes.c_uint32, "t": ctypes.c_uint64, "b": ctypes.c_int}[kind](value)
            pointer = ctypes.cast(ctypes.byref(data), ctypes.c_void_p)
        self.check(self.lib.sd_bus_message_append_basic(message, kind.encode(), pointer), "encode scope property")

    def container(self, message, kind, contents):
        self.check(self.lib.sd_bus_message_open_container(message, kind.encode(), contents.encode()), "encode scope container")

    def end(self, message):
        self.check(self.lib.sd_bus_message_close_container(message), "finish scope container")

    def start_scope(self, unit, properties):
        message, reply, error = ctypes.c_void_p(), ctypes.c_void_p(), BusError()
        try:
            self.check(self.lib.sd_bus_message_new_method_call(self.bus, ctypes.byref(message),
                       b"org.freedesktop.systemd1", b"/org/freedesktop/systemd1",
                       b"org.freedesktop.systemd1.Manager", b"StartTransientUnit"), "prepare scope")
            self.check(self.lib.sd_bus_message_set_allow_interactive_authorization(message, 0), "disable interactive authorization")
            self.append(message, "s", unit)
            self.append(message, "s", "fail")
            self.container(message, "a", "(sv)")
            for name, kind, value in properties:
                self.container(message, "r", "sv")
                self.append(message, "s", name)
                self.container(message, "v", kind)
                if kind == "au":
                    self.container(message, "a", "u")
                    for pid in value:
                        self.append(message, "u", pid)
                    self.end(message)
                else:
                    self.append(message, kind, value)
                self.end(message)
                self.end(message)
            self.end(message)
            self.container(message, "a", "(sa(sv))")
            self.end(message)
            result = self.lib.sd_bus_call(self.bus, message, 5_000_000, ctypes.byref(error), ctypes.byref(reply))
            if result < 0:
                reason = error.message.decode(errors="replace") if error.message else os.strerror(-result)
                raise ContainmentError(f"user systemd refused scope: {reason[:300]}")
        finally:
            self.lib.sd_bus_message_unref(reply)
            self.lib.sd_bus_message_unref(message)
            self.lib.sd_bus_error_free(ctypes.byref(error))


def cgroup_path(proc=Path("/proc"), mount=Path("/sys/fs/cgroup")):
    lines = (proc / "self/cgroup").read_text().splitlines()
    paths = [line[3:] for line in lines if line.startswith("0::/")]
    if len(paths) != 1:
        raise ContainmentError("a readable cgroup v2 hierarchy is required")
    relative = Path(paths[0].lstrip("/"))
    if ".." in relative.parts:
        raise ContainmentError("invalid cgroup path")
    result = (mount / relative).resolve()
    if not result.is_relative_to(mount.resolve()):
        raise ContainmentError("cgroup path escapes its mount")
    return result


def read_limit(path, key):
    try:
        raw = (path / key).read_text().strip()
    except OSError as error:
        raise ContainmentError(f"cannot verify {key}") from error
    if not raw.isdecimal():
        raise ContainmentError(f"{key} is unlimited or invalid")
    return int(raw)


def verify_limits(path, unit, policy, profile):
    if not UNIT_RE.fullmatch(unit) or path.name != unit:
        raise ContainmentError("command did not enter its unique job scope")
    aggregate = next((parent for parent in path.parents if parent.name == policy["slice"]), None)
    if aggregate is None:
        raise ContainmentError("command did not enter the aggregate job slice")
    limits = {"memory.high": "memory_high_bytes", "memory.max": "memory_max_bytes",
              "memory.swap.max": "memory_swap_max_bytes", "pids.max": "tasks_max"}
    verified = {}
    for filename, setting in limits.items():
        value = read_limit(path, filename)
        if value > profile[setting]:
            raise ContainmentError(f"kernel {filename} exceeds the job budget")
        verified[filename] = value
    if read_limit(path, "memory.oom.group") != 1:
        raise ContainmentError("kernel group OOM termination is not enabled")
    for filename, setting in list(limits.items())[:3]:
        if read_limit(aggregate, filename) > policy["aggregate"][setting]:
            raise ContainmentError(f"aggregate kernel {filename} exceeds its budget")
    verified["cpu_weight"] = read_limit(path, "cpu.weight") if (path / "cpu.weight").exists() else None
    return verified


def private_directory(path):
    path = Path(path).expanduser().absolute()
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ContainmentError(f"private state directory required: {path}")
    return path


def atomic_json(path, value):
    temporary = path.parent / ("." + path.name + "." + uuid.uuid4().hex)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def job_record_path(policy, unit):
    if not UNIT_RE.fullmatch(unit):
        raise ContainmentError("invalid job unit identifier")
    return private_directory(Path(policy["state_dir"]).expanduser() / "jobs") / (unit + ".json")


def boot_id(path=Path("/proc/sys/kernel/random/boot_id")):
    try:
        value = path.read_text().strip()
    except OSError as error:
        raise ContainmentError("cannot identify the current boot for durable job records") from error
    if not BOOT_RE.fullmatch(value):
        raise ContainmentError("invalid kernel boot identifier")
    return value


def create_job_record(policy, unit, record):
    """Reserve a bounded record slot before a new gate can be started."""
    path = job_record_path(policy, unit)
    fd = os.open(path.parent / ".registry.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        prune_records(path.parent, policy["max_job_records"] - 1, record["boot_id"])
        atomic_json(path, record)
    finally:
        os.close(fd)
    return path


def child_gate(unit, profile_name, command, policy=None, bus_factory=UserBus,
               get_cgroup=cgroup_path, execute=os.execvpe):
    policy = policy or load_policy()
    name, profile = profile_for(policy, profile_name)
    if not UNIT_RE.fullmatch(unit) or not command:
        raise ContainmentError("invalid scoped command request")
    record_path = job_record_path(policy, unit)
    record = bounded_json(record_path)
    if (not isinstance(record, dict) or record.get("unit") != unit
            or record.get("status") != "starting" or record.get("cgroup")
            or record.get("scope_start_requested") is not False):
        raise ContainmentError("job record does not identify an unstarted gate")
    try:
        # Constructing UserBus only connects. It cannot create a unit, so a
        # denied connection has an unambiguous terminal state even when the
        # same sandbox cannot query the manager to confirm cleanup.
        bus = bus_factory()
    except (OSError, ContainmentError) as error:
        record.update(status="refused", refusal_phase="before_start",
                      finished_at=time.time(), exit_status=FAILURE,
                      refusal_reason=str(error)[:300])
        atomic_json(record_path, record)
        raise
    try:
        # Persist uncertainty before sending StartTransientUnit. Failures from
        # this point must not be classified as a never-started job.
        record["scope_start_requested"] = True
        atomic_json(record_path, record)
        bus.start_scope(unit, scope_properties(policy, profile))
    finally:
        bus.close()
    deadline = time.monotonic() + 5
    while True:
        path = get_cgroup()
        if path.name == unit:
            break
        if time.monotonic() >= deadline:
            raise ContainmentError("systemd did not attach the command to its job scope")
        time.sleep(0.02)
    limits = verify_limits(path, unit, policy, profile)
    record = bounded_json(record_path)
    if not isinstance(record, dict):
        raise ContainmentError("invalid job record")
    record.update(status="running", cgroup=str(path), verified_limits=limits)
    atomic_json(record_path, record)
    execute(command[0], command, dict(os.environ))


def control_unit(unit, *arguments):
    if not UNIT_RE.fullmatch(unit):
        raise ContainmentError("refusing to control a non-job unit")
    try:
        return subprocess.run(["/usr/bin/systemctl", "--user", *arguments, unit],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True, timeout=5)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ContainmentError("cannot control this job's systemd scope") from error


def sample_cgroup(path):
    snapshot = {}
    if not path:
        return snapshot
    path = Path(path)
    for name in ["memory.current", "memory.peak", "memory.swap.current", "memory.swap.peak"]:
        try:
            raw = (path / name).read_text().strip()
            if raw.isdecimal():
                snapshot[name] = int(raw)
        except OSError:
            pass
    try:
        snapshot["events"] = {key: int(value) for key, value in
                              (line.split() for line in (path / "memory.events").read_text().splitlines())}
    except (OSError, ValueError):
        pass
    return snapshot


def merge_sample(previous, current):
    merged = dict(previous)
    for key, value in current.items():
        if key == "events":
            old = merged.setdefault("events", {}).copy()
            old.update({name: max(old.get(name, 0), count) for name, count in value.items()})
            merged[key] = old
        else:
            merged[key] = max(merged.get(key, 0), value)
    return merged


def record_oom(policy, record, sample, result):
    if not (sample.get("events", {}).get("oom_kill", 0) or result == "oom-kill"):
        return
    directory = private_directory(Path(policy["monitor_state_dir"]).expanduser() / "incidents")
    now = time.time()
    evidence = {"source": "qq-job", "unit": record["unit"], "cwd": record["cwd"],
                "executable": record["executable"], "profile": record["profile"],
                "limits": record["limits"], "memory": sample, "result": result}
    incident = {"id": str(uuid.uuid5(uuid.NAMESPACE_URL, "qq-job:" + record["unit"])),
                "host": socket.gethostname(), "type": "agent_job_oom", "severity": "warning",
                "status": "open", "first_seen": now, "last_seen": now, "occurrences": 1,
                "summary": "A contained job was terminated by the OOM killer.",
                "evidence": evidence, "delivery": {}}
    atomic_json(directory / (incident["id"] + ".json"), incident)
    # Share the monitor's incident format without retaining an unbounded set of
    # launcher events. Leave every other monitor event untouched.
    own = []
    for index, path in enumerate(directory.glob("*.json")):
        if index >= 2000:
            break
        try:
            previous = bounded_json(path)
            if not isinstance(previous, dict):
                continue
            if previous.get("type") == "agent_job_oom" and previous.get("evidence", {}).get("source") == "qq-job":
                own.append((previous.get("last_seen", 0), path))
        except (OSError, ValueError, ContainmentError):
            pass
    for _, path in sorted(own, reverse=True)[policy["max_job_records"]:]:
        path.unlink(missing_ok=True)


def prune_records(directory, maximum, current_boot=None):
    current_boot = current_boot or boot_id()
    finished, retained = [], []
    for index, path in enumerate(directory.glob("qq-job-*.scope.json")):
        if index >= 2000:
            raise ContainmentError("too many job records; operator cleanup is required")
        try:
            record = bounded_json(path)
            if not isinstance(record, dict):
                raise ContainmentError("invalid job record")
            prior_boot = record.get("boot_id")
            if isinstance(prior_boot, str) and BOOT_RE.fullmatch(prior_boot) and prior_boot != current_boot:
                path.unlink(missing_ok=True)
                continue
            if record.get("status") in ["finished", "refused"]:
                finished_at = record.get("finished_at", 0)
                if isinstance(finished_at, (int, float)):
                    finished.append((finished_at, path))
            retained.append(path)
        except (OSError, ValueError, ContainmentError):
            # Unknown records may represent live jobs. Never discard them to
            # obtain capacity for another launch.
            retained.append(path)
    required = max(0, len(retained) - maximum)
    for _, path in sorted(finished)[:required]:
        path.unlink(missing_ok=True)
    remaining = len(retained) - min(required, len(finished))
    if remaining > maximum:
        raise ContainmentError("job record capacity is occupied by live or unknown jobs; refusing another launch")
    return remaining


def shell_argv(command, shell="/bin/bash", login=True):
    if not os.path.isabs(shell):
        raise ContainmentError("shell path must be absolute")
    return [shell, "-lc" if login else "-c", command]


def cleanup_scope(unit, path=None):
    """Stop only this invocation's unit, including daemonized descendants."""
    stopped = control_unit(unit, "stop")
    absent = "not loaded" in stopped.stderr or "not found" in stopped.stderr
    if stopped.returncode and not absent:
        control_unit(unit, "kill", "--kill-whom=all", "--signal=SIGKILL")
    if path:
        path = Path(path)
        if path.name != unit or not UNIT_RE.fullmatch(unit):
            raise ContainmentError("invalid cleanup cgroup")
        deadline = time.monotonic() + 3
        while path.exists():
            try:
                events = dict(line.split() for line in (path / "cgroup.events").read_text().splitlines())
            except FileNotFoundError:
                break
            if events.get("populated") == "0":
                break
            if time.monotonic() >= deadline:
                raise ContainmentError("job descendants remain after scope cleanup")
            time.sleep(0.02)
    elif stopped.returncode and not absent:
        raise ContainmentError("cannot confirm job scope cleanup")
    control_unit(unit, "reset-failed")


def launch(command, policy, profile_name=None, popen=subprocess.Popen):
    name, profile = profile_for(policy, profile_name)
    unit = "qq-job-" + uuid.uuid4().hex + ".scope"
    record = {"schema": 1, "unit": unit, "profile": name, "status": "starting",
              "started_at": time.time(), "boot_id": boot_id(), "cwd": os.getcwd(),
              "executable": shutil.which(command[0]) or command[0], "limits": profile,
              "scope_start_requested": False}
    record_path = create_job_record(policy, unit, record)
    child = None
    sample = {}
    handlers = {}
    interrupted = []
    cleaned = False

    def forward(number, _frame):
        interrupted.append(number)
        try:
            result = control_unit(unit, "kill", "--kill-whom=all", f"--signal={number}")
            if result.returncode:
                raise ContainmentError("job scope is not attached yet")
        except ContainmentError:
            if child is not None and child.poll() is None:
                try:
                    child.send_signal(number)
                except ProcessLookupError:
                    pass

    try:
        for number in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
            handlers[number] = signal.signal(number, forward)
        child = popen([sys.executable, str(Path(__file__).resolve()), "--_child", unit,
                       "--profile", name, "--", *command], close_fds=False)
        # No pipe, cwd, env, uid, session or namespace replacement: inherit caller.
        while child.poll() is None:
            try:
                current = bounded_json(record_path)
                if current.get("cgroup"):
                    sample = merge_sample(sample, sample_cgroup(current["cgroup"]))
                    record = current
            except (OSError, ValueError, ContainmentError):
                pass
            time.sleep(0.05)
        status = child.wait()
        status = status if status >= 0 else 128 - status
        if interrupted and status == FAILURE:
            status = 128 + interrupted[-1]
        # The command can finish before the first parent sampling interval.
        current = bounded_json(record_path)
        if (current.get("status") == "refused" and current.get("refusal_phase") == "before_start"
                and current.get("scope_start_requested") is False and not current.get("cgroup")):
            # The gate proved it never sent a start request. No manager access
            # is needed to complete or reclaim this refusal record.
            cleaned = True
            current.update(finished_at=time.time(), exit_status=status)
            atomic_json(record_path, current)
            return status
        if current.get("cgroup"):
            record = current
            sample = merge_sample(sample, sample_cgroup(current["cgroup"]))
        info = control_unit(unit, "show", "--property=Result", "--property=MemoryPeak",
                            "--property=MemorySwapPeak", "--property=ControlGroup")
        properties = dict(line.split("=", 1) for line in info.stdout.splitlines() if "=" in line)
        if properties.get("MemoryPeak", "").isdecimal():
            sample["memory.peak"] = max(sample.get("memory.peak", 0), int(properties["MemoryPeak"]))
        if properties.get("MemorySwapPeak", "").isdecimal():
            sample["memory.swap.peak"] = max(sample.get("memory.swap.peak", 0), int(properties["MemorySwapPeak"]))
        cleanup_scope(unit, record.get("cgroup"))
        cleaned = True
        try:
            record_oom(policy, record, sample, properties.get("Result"))
        except (OSError, ValueError, ContainmentError) as error:
            record["telemetry_error"] = str(error)[:300]
            print(f"qq-job: could not record OOM telemetry: {error}", file=sys.stderr)
        record.update(status="finished" if record.get("cgroup") else "refused",
                      finished_at=time.time(), exit_status=status, memory=sample,
                      systemd_result=properties.get("Result"))
        atomic_json(record_path, record)
        return status
    finally:
        # A daemonized grandchild still belongs to this unique scope. Stop it too.
        if not cleaned:
            try:
                cleanup_scope(unit, record.get("cgroup"))
            except (OSError, ContainmentError) as error:
                print(f"qq-job: scope cleanup failed: {error}", file=sys.stderr)
        for number, handler in handlers.items():
            signal.signal(number, handler)


def prefix_forms(prefix):
    """The resolved forms of one routing prefix, each matched against cwd + "/"."""
    if prefix.endswith("/"):
        return {os.path.realpath(prefix).rstrip("/") + "/"}
    forms = {os.path.join(os.path.realpath(os.path.dirname(prefix)), os.path.basename(prefix))}
    if os.path.isdir(prefix):
        forms.add(os.path.realpath(prefix).rstrip("/") + "/")
    return forms


def routes_to_slot(policy, cwd):
    where = os.path.realpath(cwd).rstrip("/") + "/"
    return any(where.startswith(form) for prefix in policy["slot_routing"]["path_prefixes"]
               for form in prefix_forms(prefix))


def slot_memory(value):
    """A systemd size for SLOT_MEM (G and M are powers of 1024 there)."""
    if value % GIB == 0:
        return f"{value // GIB}G"
    if value % MIB == 0:
        return f"{value // MIB}M"
    return str(value)


def inherited_slot_memory(environment=None):
    """A caller's own SLOT_MEM (or FGX_SLOT_MEM), which slot reads as it would
    for a direct call."""
    environment = os.environ if environment is None else environment
    return environment.get("SLOT_MEM") or environment.get("FGX_SLOT_MEM") or None


def routed_slot_memory(profile, environment=None):
    """(SLOT_MEM to set or None, where the cap comes from) for a routed job."""
    inherited = inherited_slot_memory(environment)
    if inherited:
        return None, "caller's SLOT_MEM"
    if profile["memory_max_bytes"] > SLOT_HEAVY_DEFAULT_BYTES:
        return slot_memory(profile["memory_max_bytes"]), "profile"
    return None, "slot default"


def slot_nesting_claimed(environment=None):
    environment = os.environ if environment is None else environment
    return bool(environment.get("SLOT") or environment.get("FGX_SLOT"))


def in_capped_job_scope(get_cgroup=None):
    """Whether this process is in a slot or qq-job scope with a memory cap.
    slot runs a command in place when SLOT is set, so SLOT alone (a stray
    export, or a slot job that got no scope) must not be taken for a cap."""
    try:
        path = (get_cgroup or cgroup_path)()
        if not (SLOT_SCOPE_RE.fullmatch(path.name) or UNIT_RE.fullmatch(path.name)):
            return False
        return (path / "memory.max").read_text().strip().isdecimal()
    except (OSError, ContainmentError):
        return False


def check_slot_scope(run=subprocess.run):
    """slot runs a job without any memory cap when it cannot start a systemd
    scope (as in the default Codex sandbox, which denies the bus socket). Run
    slot's own probe first and refuse instead, as an unrouted job is refused."""
    systemd_run = shutil.which("systemd-run")
    if not systemd_run:
        raise ContainmentError("systemd-run is missing, so slot could not cap the job's memory")
    environment = dict(os.environ)
    if os.geteuid() == 0:
        argv = [systemd_run, "--scope", "-q", "true"]
    else:
        environment["XDG_RUNTIME_DIR"] = environment.get("XDG_RUNTIME_DIR") or f"/run/user/{os.geteuid()}"
        argv = [systemd_run, "--user", "--scope", "-q", "true"]
    try:
        result = run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                     stderr=subprocess.PIPE, text=True, timeout=10, env=environment)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ContainmentError("cannot probe for a systemd scope, so slot could not cap the job's memory") from error
    if result.returncode:
        reason = (result.stderr or "").strip()[:200] or f"exit {result.returncode}"
        raise ContainmentError(f"cannot start a systemd scope, so slot would run the job without a memory cap: {reason}")


def child_pids(pid, proc=Path("/proc")):
    result = []
    for path in (proc / str(pid) / "task").glob("*/children"):
        try:
            result.extend(int(value) for value in path.read_text().split())
        except (OSError, ValueError):
            pass
    return result


def descendants(pid, proc=Path("/proc")):
    found, stack = [], [pid]
    while stack and len(found) < 4096:
        for child in child_pids(stack.pop(), proc):
            if child not in found:
                found.append(child)
                stack.append(child)
    return found


def slot_scope(slot_pid, mount=Path("/sys/fs/cgroup"), uid=None):
    """The cgroup slot made for this job: slot names its scope after its own
    pid, in the user's app slices (or system.slice when run as root). None
    while slot queues, or when it runs the job nested in another slot job."""
    uid = os.getuid() if uid is None else uid
    pattern = f"slot-*-{slot_pid}-*.scope"
    for parent, glob in [(mount / f"user.slice/user-{uid}.slice/user@{uid}.service/app.slice", "*/" + pattern),
                         (mount / "system.slice", pattern)]:
        for path in parent.glob(glob):
            match = SLOT_SCOPE_RE.fullmatch(path.name)
            if match and match.group(1) == str(slot_pid) and path.is_dir():
                return path
    return None


def populated(path):
    try:
        events = dict(line.split() for line in (path / "cgroup.events").read_text().splitlines())
    except (OSError, ValueError):
        return False
    return events.get("populated") == "1"


def signal_slot_job(slot_pid, number, scope, proc=Path("/proc"), kill=os.kill):
    """Signal the job as an unrouted job is signalled: every process in its
    scope. slot itself is left out then, so it returns the job's own status
    (its TERM and HUP traps would end it by the signal even after a clean
    exit). Before the scope exists slot is queueing or waiting for the card:
    signal slot and its children (flock, sleep), so a queued job never runs."""
    if scope is not None and populated(scope):
        try:
            targets = [int(value) for value in (scope / "cgroup.procs").read_text().split()]
        except (OSError, ValueError):
            targets = []
    else:
        targets = [slot_pid, *descendants(slot_pid, proc)]
    for target in targets:
        try:
            kill(target, number)
        except (ProcessLookupError, PermissionError):
            pass


def stop_slot_leftovers(scope, slot_pid, run=subprocess.run, monotonic=time.monotonic):
    """Stop what the job left in its slot scope, as qq-job stops its own scope."""
    match = SLOT_SCOPE_RE.fullmatch(scope.name)
    if not match or match.group(1) != str(slot_pid):
        raise ContainmentError("refusing to stop a scope this job did not start")
    if not populated(scope):
        return False
    user = [] if "/system.slice/" in str(scope) else ["--user"]

    def systemctl(*arguments):
        try:
            return run(["/usr/bin/systemctl", *user, *arguments, scope.name], stdin=subprocess.DEVNULL,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise ContainmentError("cannot stop what the job left running") from error

    systemctl("stop")
    deadline = monotonic() + 3
    while populated(scope):
        if monotonic() >= deadline:
            systemctl("kill", "--kill-whom=all", "--signal=SIGKILL")
            break
        time.sleep(0.02)
    return True


def scope_memory_max(path):
    try:
        raw = (path / "memory.max").read_text().strip()
    except OSError:
        return None
    return slot_memory(int(raw)) if raw.isdecimal() else raw


def launch_routed(command, policy, profile_name=None, popen=subprocess.Popen,
                  check_scope=check_slot_scope, find_scope=slot_scope, signal_job=signal_slot_job,
                  stop_leftovers=stop_slot_leftovers, capped_scope=in_capped_job_scope):
    """Run the command as "slot COMMAND..." in the caller's process group, with
    its stdio, cwd and environment. Never runs it any other way."""
    name, profile = profile_for(policy, profile_name)
    slot = policy["slot_routing"]["slot"]
    if not os.path.isfile(slot) or not os.access(slot, os.X_OK):
        raise ContainmentError(f"slot is missing or not executable at {slot}; not running the job")
    environment = dict(os.environ)
    # Already inside a slot job, slot runs the command in that job's slot and
    # scope; its memory cap stays the outer job's.
    nested = slot_nesting_claimed()
    if nested and not capped_scope():
        raise ContainmentError("SLOT is set but this process is not in a capped slot or qq-job scope; "
                               "slot would run the job in place without a memory cap")
    memory, source = None, "outer slot job"
    if not nested:
        check_scope()
        memory, source = routed_slot_memory(profile)
        if memory:
            environment["SLOT_MEM"] = memory
    unit = "qq-job-" + uuid.uuid4().hex + ".scope"  # this record's identifier; slot owns the scope
    # slot_memory_max is the cap the kernel shows for the job's scope once it
    # is seen; until then, what slot was told (None: slot's own default).
    record = {"schema": 1, "unit": unit, "profile": name, "status": "running",
              "routed": "slot", "note": "routed to slot", "nested_in_slot": nested,
              "slot_memory_max": memory or (inherited_slot_memory() if source == "caller's SLOT_MEM" else None),
              "slot_memory_source": source, "started_at": time.time(), "boot_id": boot_id(),
              "cwd": os.getcwd(), "executable": shutil.which(command[0]) or command[0],
              "limits": profile}
    record_path = create_job_record(policy, unit, record)
    child = None
    scope = None
    sample = {}
    handlers = {}
    interrupted = []

    def current_scope():
        nonlocal scope
        if scope is None and child is not None and not nested:
            scope = find_scope(child.pid)
            if scope is not None:
                # Read at once: the scope goes when the job ends.
                record["slot_memory_max"] = scope_memory_max(scope) or record["slot_memory_max"]
        return scope

    def forward(number, _frame):
        interrupted.append(number)
        if child is not None and child.poll() is None:
            signal_job(child.pid, number, current_scope())

    try:
        for number in [signal.SIGINT, signal.SIGTERM, signal.SIGHUP]:
            handlers[number] = signal.signal(number, forward)
        try:
            # No new session or process group: a caller that kills its own
            # group reaches slot and the job, as it reached the job before.
            child = popen([slot, *command], env=environment, close_fds=False)
        except OSError as error:
            record.update(status="refused", finished_at=time.time(), exit_status=FAILURE,
                          refusal_reason=f"cannot start slot: {error}"[:300])
            atomic_json(record_path, record)
            raise ContainmentError(f"cannot start slot: {error}") from error
        if interrupted:
            signal_job(child.pid, interrupted[-1], current_scope())
        while child.poll() is None:
            path = current_scope()
            if path is not None:
                sample = merge_sample(sample, sample_cgroup(path))
            time.sleep(0.05)
        # A job that ends within one poll leaves its scope unseen until now;
        # slot is not reaped yet, so its pid still names only this job's scope.
        current_scope()
        status = child.wait()
        status = status if status >= 0 else 128 - status
        left = False
        if scope is not None:
            sample = merge_sample(sample, sample_cgroup(scope))
            try:
                left = stop_leftovers(scope, child.pid)
            except (OSError, ContainmentError) as error:
                record["cleanup_error"] = str(error)[:300]
                print(f"qq-job: {error}", file=sys.stderr)
        try:
            record_oom(policy, record, sample, None)
        except (OSError, ValueError, ContainmentError) as error:
            record["telemetry_error"] = str(error)[:300]
            print(f"qq-job: could not record OOM telemetry: {error}", file=sys.stderr)
        record.update(status="finished", finished_at=time.time(), exit_status=status, memory=sample,
                      cgroup=str(scope) if scope is not None else None, stopped_leftovers=left)
        atomic_json(record_path, record)
        return status
    finally:
        for number, handler in handlers.items():
            signal.signal(number, handler)


def status_report(policy):
    directory = Path(policy["state_dir"]).expanduser() / "jobs"
    records = []
    if directory.exists():
        for index, path in enumerate(directory.glob("qq-job-*.scope.json")):
            if index >= 2000:
                break
            try:
                record = bounded_json(path)
                if isinstance(record, dict) and isinstance(record.get("started_at", 0), (int, float)):
                    records.append(record)
            except (OSError, ValueError, ContainmentError):
                pass
    return {"schema": 1, "slice": policy["slice"], "aggregate_budget": policy["aggregate"],
            "jobs": sorted(records, key=lambda row: row.get("started_at", 0), reverse=True)[:20]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", help="profile approved in ~/.config/qq-job/policy.json")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--shell-command", help="execute one literal shell command string")
    parser.add_argument("--shell", default="/bin/bash")
    parser.add_argument("--no-login", action="store_true")
    parser.add_argument("--_child", help=argparse.SUPPRESS)
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args(argv)
    try:
        policy = load_policy()
        if args.status:
            if args.command or args.shell_command is not None or args._child:
                raise ContainmentError("--status does not accept a command")
            print(json.dumps(status_report(policy)))
            return 0
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        if args.shell_command is not None:
            if command:
                raise ContainmentError("choose command arguments or --shell-command")
            command = shell_argv(args.shell_command, args.shell, not args.no_login)
        if not command or any("\0" in value for value in command):
            raise ContainmentError("provide -- COMMAND... or --shell-command STRING")
        name, profile = profile_for(policy, args.profile)
        if args._child:
            child_gate(args._child, name, command, policy)
            return 0
        # slot can't apply a runtime limit, so such a profile (oom-proof) keeps its own scope.
        # SLOT set outside a capped scope would make slot run the job in place
        # uncapped; such a job keeps its own qqjobs scope, as before routing.
        nested = slot_nesting_claimed()
        routed = ("runtime_seconds" not in profile and routes_to_slot(policy, os.getcwd())
                  and (not nested or in_capped_job_scope()))
        if args.dry_run and routed:
            memory, source = (None, "outer slot job") if nested else routed_slot_memory(profile)
            print(json.dumps({"schema": 1, "mode": "routed-to-slot", "profile": name,
                              "slot": policy["slot_routing"]["slot"],
                              "slot_memory_max": memory or (inherited_slot_memory() if not nested else None),
                              "slot_memory_source": source, "nested_in_slot": nested,
                              "cwd": os.getcwd(), "executable": shutil.which(command[0]) or command[0]}))
            return 0
        if routed:
            return launch_routed(command, policy, name)
        if args.dry_run:
            print(json.dumps({"schema": 1, "mode": "sandbox-preserving-scope", "profile": name,
                              "slice": policy["slice"], "limits": profile, "aggregate_budget": policy["aggregate"],
                              "cwd": os.getcwd(), "executable": shutil.which(command[0]) or command[0]}))
            return 0
        return launch(command, policy, name)
    except (ContainmentError, OSError, ValueError) as error:
        print(f"qq-job: refused to run without verified containment: {error}", file=sys.stderr)
        return FAILURE


if __name__ == "__main__":
    sys.exit(main())
