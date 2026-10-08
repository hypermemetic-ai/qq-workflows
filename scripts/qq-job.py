#!/usr/bin/env python3
"""Run a command in a verified user-systemd cgroup, retaining the caller sandbox.

Scopes attach our newly forked gate; the user manager never executes the command.
PIDs=[0] identifies the bus sender in the manager's PID namespace (systemd v255,
src/core/dbus-scope.c). Never replace this with the caller's namespace-local PID.
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
