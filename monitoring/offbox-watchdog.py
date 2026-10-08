#!/usr/bin/env python3
"""Authenticated, bounded heartbeat archive and independent outage watchdog.

The host sends metrics only. This receiver cannot execute remediation commands.
It records incidents; delivery to an external user notification channel is separate.
"""

import argparse
import collections
import datetime
import hmac
import http.server
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import signal
import socket
import ssl
import stat
import sys
import tempfile
import threading
import time
import uuid

BODY_LIMIT = 64 * 1024
STATE_LIMIT = 2 * BODY_LIMIT
PRIVATE_MODE = 0o600
FORBIDDEN_KEYS = {"command", "commands", "cmd", "cmdline", "argv", "args",
                  "transcript", "prompt", "environment", "env", "token", "secret"}


class InvalidHeartbeat(ValueError):
    pass


def json_bytes(value):
    return (json.dumps(value, allow_nan=False, separators=(",", ":"),
                       sort_keys=True) + "\n").encode("utf-8")


def finite_number(value):
    try:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    except OverflowError:
        return False


def private_file(path):
    info = Path(path).lstat()
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) & 0o077:
        raise ValueError(f"{path} must be a regular private file (mode 0600)")


def read_private_json(path):
    path = Path(path)
    if not path.exists():
        return None
    private_file(path)
    if path.stat().st_size > STATE_LIMIT:
        raise ValueError(f"Oversized state file: {path}")
    with path.open("rb") as handle:
        return json.loads(handle.read(STATE_LIMIT + 1))


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_private_json(path, value):
    path = Path(path)
    encoded = json_bytes(value)
    if len(encoded) > STATE_LIMIT:
        raise ValueError("State exceeds its size bound")
    fd, name = tempfile.mkstemp(prefix=".watchdog-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), PRIVATE_MODE)
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        fsync_directory(path.parent)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def observer_boot_id():
    try:
        return Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return "process-" + uuid.uuid4().hex


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise InvalidHeartbeat("Duplicate JSON key")
        result[key] = value
    return result


def decode_heartbeat(body, host, now, max_skew=120):
    if len(body) > BODY_LIMIT:
        raise InvalidHeartbeat("Heartbeat exceeds 64 KiB")
    try:
        payload = json.loads(body.decode("utf-8"), object_pairs_hook=_pairs,
                             parse_constant=lambda _: (_ for _ in ()).throw(InvalidHeartbeat("Nonfinite JSON")))
    except (UnicodeError, ValueError, RecursionError) as error:
        raise InvalidHeartbeat("Invalid JSON heartbeat") from error
    if not isinstance(payload, dict) or set(payload) != {"host", "boot_id", "timestamp", "metrics"}:
        raise InvalidHeartbeat("Expected host, boot_id, timestamp and metrics only")
    if payload["host"] != host:
        raise InvalidHeartbeat("Host is not allowed")
    boot = payload["boot_id"]
    if not isinstance(boot, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,128}", boot):
        raise InvalidHeartbeat("Invalid boot_id")
    timestamp = payload["timestamp"]
    if not finite_number(timestamp) or abs(now - timestamp) > max_skew:
        raise InvalidHeartbeat("Heartbeat timestamp is stale or outside clock tolerance")
    if not isinstance(payload["metrics"], dict):
        raise InvalidHeartbeat("metrics must be an object")

    def check(value, depth=0):
        if depth > 12:
            raise InvalidHeartbeat("Metrics nesting exceeds its limit")
        if isinstance(value, dict):
            for key, child in value.items():
                if len(key) > 128 or key.lower() in FORBIDDEN_KEYS:
                    raise InvalidHeartbeat("Unsupported metric key")
                check(child, depth + 1)
        elif isinstance(value, list):
            for child in value:
                check(child, depth + 1)
        elif isinstance(value, str):
            if len(value) > 512:
                raise InvalidHeartbeat("Metric string exceeds its limit")
        elif isinstance(value, (int, float)) and not isinstance(value, bool):
            if not finite_number(value):
                raise InvalidHeartbeat("Nonfinite metric value")
        elif value is not None and not isinstance(value, bool):
            raise InvalidHeartbeat("Unsupported metric value")

    check(payload["metrics"])
    return payload


class JSONLArchive:
    """Rotating append-only records, limited by size and maximum age."""

    def __init__(self, path, max_total, max_file, days=7):
        self.path = Path(path)
        self.max_total = max_total
        self.max_file = max_file
        self.max_age = days * 86400
        if max_file > max_total or min(max_file, max_total, days) <= 0:
            raise ValueError("Invalid archive limits")
        self.day = None
        if self.path.exists():
            private_file(self.path)
            with self.path.open("rb") as handle:
                line = handle.readline(STATE_LIMIT + 1)
            if line:
                try:
                    self.day = self._day(json.loads(line)["recorded_at"])
                except (ValueError, KeyError):
                    self.day = self._day(self.path.stat().st_mtime)

    @staticmethod
    def _day(now):
        return datetime.datetime.fromtimestamp(now, datetime.timezone.utc).strftime("%Y%m%d")

    def files(self):
        return sorted(self.path.parent.glob(self.path.stem + ".*.jsonl")) + ([self.path] if self.path.exists() else [])

    def prune(self, now):
        files = self.files()
        changed = False
        for path in files:
            if path.stat().st_mtime < now - self.max_age:
                path.unlink()
                changed = True
        files = sorted(self.files(), key=lambda path: (path.stat().st_mtime, path.name))
        total = sum(path.stat().st_size for path in files)
        for path in files:
            if total <= self.max_total:
                break
            if path == self.path:
                continue
            total -= path.stat().st_size
            path.unlink()
            changed = True
        if changed:
            fsync_directory(self.path.parent)

    def append(self, record, now):
        encoded = json_bytes({**record, "recorded_at": now})
        if len(encoded) > self.max_file:
            raise ValueError("Archive record exceeds its size bound")
        day = self._day(now)
        if self.path.exists() and (self.day != day or self.path.stat().st_size + len(encoded) > self.max_file):
            self.path.rename(self.path.with_name(f"{self.path.stem}.{day}.{uuid.uuid4().hex[:12]}.jsonl"))
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(self.path, flags, PRIVATE_MODE)
        with os.fdopen(fd, "ab") as handle:
            os.fchmod(handle.fileno(), PRIVATE_MODE)
            handle.write(encoded)
            handle.flush()
            os.utime(self.path, (now, now))
            os.fsync(handle.fileno())
        # Persist creation and rotation entries as well as the record contents.
        fsync_directory(self.path.parent)
        self.day = day
        self.prune(now)


class Watchdog:
    def __init__(self, state_dir, host="qq-box", warning=90, critical=120,
                 startup_grace=120, snapshot_every=30, max_skew=120,
                 wall=time.time, monotonic=time.monotonic, boot_id=None):
        if (not 0 < warning < critical or
                any(not finite_number(value) or value <= 0 for value in
                    (warning, critical, startup_grace, snapshot_every, max_skew))):
            raise ValueError("Invalid watchdog intervals")
        self.directory = Path(state_dir)
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.directory.is_symlink() or not self.directory.is_dir():
            raise ValueError("State directory must be an ordinary directory")
        os.chmod(self.directory, 0o700)
        self.host, self.warning, self.critical = host, warning, critical
        self.startup_grace, self.snapshot_every, self.max_skew = startup_grace, snapshot_every, max_skew
        self.wall, self.monotonic = wall, monotonic
        self.boot_id = boot_id or observer_boot_id()
        self.fallback_ages = {}
        self.lock = threading.RLock()
        self.storage_error = None
        self.incidents = JSONLArchive(self.directory / "incidents.jsonl", 8 * 1024**2, 1024**2)
        self.snapshots = JSONLArchive(self.directory / "snapshots.jsonl", 56 * 1024**2, 4 * 1024**2)
        self.event_ids = collections.OrderedDict()
        self.incidents.prune(self.wall())
        for path in self.incidents.files():
            with path.open("rb") as handle:
                for line in handle:
                    record = json.loads(line)
                    if "event_id" in record:
                        self._remember_event(record["event_id"])
        saved = read_private_json(self.directory / "watchdog-state.json")
        if saved is not None and (not isinstance(saved, dict) or saved.get("version") != 1 or saved.get("host") != host):
            raise ValueError("Saved watchdog state belongs to another schema or host")
        self.state = saved or {"version": 1, "host": host, "status": "unknown", "latest_outage": None,
                               "started_at": self._anchor(), "snapshot_at": None}
        self.heartbeat = read_private_json(self.directory / "heartbeat.json")
        if self.heartbeat:
            decode_heartbeat(json_bytes(self.heartbeat["payload"]), host,
                             self.heartbeat["payload"]["timestamp"], self.max_skew)
            self._age(self.heartbeat["received_at"])
        self._age(self.state["started_at"])
        if self.state["snapshot_at"]:
            self._age(self.state["snapshot_at"])
        self._finish_pending()
        outage = self.state["latest_outage"]
        if (outage and outage.get("recovered_at") is None and self.heartbeat
                and outage.get("last_anchor") != self.heartbeat["received_at"]):
            outage["recovered_at"] = self.heartbeat["received_at"]["wall"]
            if outage.get("last_anchor"):
                outage["gap_seconds"] = max(0, self._age(outage["last_anchor"]) - self._age(self.heartbeat["received_at"]))
            self.state["status"] = "healthy"
            self._event("recovery", outage)
        self._save()

    def _anchor(self):
        return {"wall": self.wall(), "monotonic": self.monotonic(), "observer_boot_id": self.boot_id}

    def _age(self, anchor):
        now_mono = self.monotonic()
        if anchor.get("observer_boot_id") == self.boot_id and 0 <= anchor["monotonic"] <= now_mono:
            return now_mono - anchor["monotonic"]
        # Wall time bootstraps age after observer reboot, then monotonic time
        # advances it even if NTP changes the wall clock or its old value was future.
        key = (anchor["observer_boot_id"], anchor["wall"], anchor["monotonic"])
        started, initial_age = self.fallback_ages.setdefault(key, (now_mono, max(0, self.wall() - anchor["wall"])))
        return initial_age + max(0, now_mono - started)

    def _save(self):
        atomic_private_json(self.directory / "watchdog-state.json", self.state)
        self.storage_error = None

    def _remember_event(self, event_id):
        self.event_ids[event_id] = None
        if len(self.event_ids) > 10000:
            self.event_ids.popitem(last=False)

    def _finish_pending(self):
        pending = self.state.get("pending_event")
        if pending:
            event_id = pending["outage"]["id"] + ":" + pending["event"]
            if event_id not in self.event_ids:
                self.incidents.append({**pending, "event_id": event_id, "host": self.host}, self.wall())
                self._remember_event(event_id)
            self.state["pending_event"] = None
            self._save()

    def _event(self, kind, outage):
        # Save an outbox before the append. Replay on restart uses a stable event
        # identity so interruption between archive append and checkpoint is safe.
        self.state["pending_event"] = {"event": kind, "outage": dict(outage)}
        self._save()
        self._finish_pending()

    def _tick(self):
        self._finish_pending()
        now = self.wall()
        self.incidents.prune(now)
        self.snapshots.prune(now)
        if not self.heartbeat and self._age(self.state["started_at"]) < self.startup_grace:
            return
        anchor = self.heartbeat["received_at"] if self.heartbeat else self.state["started_at"]
        age = self._age(anchor)
        severity = "critical" if age >= self.critical else "warning" if age >= self.warning else "healthy"
        previous = self.state["status"]
        outage = self.state["latest_outage"]
        active = outage and outage.get("recovered_at") is None
        if severity in ("warning", "critical") and not active:
            outage = {"id": uuid.uuid4().hex, "opened_at": now, "last_seen": anchor["wall"] if self.heartbeat else None,
                      "peak_level": severity, "recovered_at": None, "reason": "heartbeat_missing",
                      "last_anchor": dict(anchor) if self.heartbeat else None}
            self.state["latest_outage"] = outage
            self.state["status"] = severity
            self._event("outage", outage)
        elif active and severity == "critical" and outage["peak_level"] != "critical":
            outage["peak_level"] = "critical"
            self._event("escalation", outage)
        # A clock correction cannot recover an incident. Only an accepted heartbeat can.
        self.state["status"] = severity if not active or severity != "healthy" else previous
        self._save()

    def tick(self):
        with self.lock:
            self._tick()

    def receive(self, payload):
        with self.lock:
            payload = decode_heartbeat(json_bytes(payload), self.host, self.wall(), self.max_skew)
            if (self.heartbeat and payload["timestamp"] <= self.heartbeat["payload"]["timestamp"]
                    and self.wall() >= self.heartbeat["received_at"]["wall"]):
                raise InvalidHeartbeat("Heartbeat timestamp must advance")
            self._tick()
            gap = self._age(self.heartbeat["received_at"]) if self.heartbeat else None
            anchor = self._anchor()
            heartbeat = {"payload": payload, "received_at": anchor}
            atomic_private_json(self.directory / "heartbeat.json", heartbeat)
            self.heartbeat = heartbeat
            outage = self.state["latest_outage"]
            if outage and outage.get("recovered_at") is None:
                outage["recovered_at"] = anchor["wall"]
                outage["gap_seconds"] = gap if gap is not None else max(0, anchor["wall"] - outage["opened_at"])
                self._event("recovery", outage)
            self.state["status"] = "healthy"
            sample_anchor = self.state["snapshot_at"]
            if sample_anchor is None or self._age(sample_anchor) >= self.snapshot_every:
                self.snapshots.append({"host": self.host, "boot_id": payload["boot_id"], "timestamp": payload["timestamp"],
                                       "metrics": payload["metrics"], "received_at": anchor["wall"]}, anchor["wall"])
                self.state["snapshot_at"] = anchor
            self._save()

    def status(self):
        with self.lock:
            return {"host": self.host, "status": self.state["status"],
                    "last_seen": self.heartbeat["received_at"]["wall"] if self.heartbeat else None,
                    "age_seconds": self._age(self.heartbeat["received_at"]) if self.heartbeat else None,
                    "boot_id": self.heartbeat["payload"]["boot_id"] if self.heartbeat else None,
                    "latest_outage": dict(self.state["latest_outage"]) if self.state["latest_outage"] else None,
                    "storage_error": self.storage_error}


class HeartbeatServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, watchdog, token):
        self.watchdog, self.token = watchdog, token.encode("utf-8")
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, HeartbeatHandler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.settimeout(1)
            try:
                request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class HeartbeatHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "QQWatchdog/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_):
        pass

    def reply(self, code, payload):
        encoded = json_bytes(payload)
        self.close_connection = True
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)

    def authenticated(self):
        supplied = self.headers.get("Authorization", "").encode("utf-8")
        if not hmac.compare_digest(supplied, b"Bearer " + self.server.token):
            self.reply(401, {"error": "Authentication required"})
            return False
        return True

    def do_GET(self):
        if not self.authenticated():
            return
        if self.path != "/status":
            self.reply(404, {"error": "Unknown endpoint"})
            return
        self.reply(200, self.server.watchdog.status())

    def do_POST(self):
        if not self.authenticated():
            return
        if self.path != "/heartbeat":
            self.reply(404, {"error": "Unknown endpoint"})
            return
        lengths = self.headers.get_all("Content-Length", [])
        if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not re.fullmatch(r"[0-9]{1,10}", lengths[0]):
            self.reply(400, {"error": "One bounded Content-Length is required"})
            return
        size = int(lengths[0])
        if size > BODY_LIMIT:
            self.reply(413, {"error": "Heartbeat exceeds 64 KiB"})
            return
        try:
            body = self.rfile.read(size)
            if len(body) != size:
                raise InvalidHeartbeat("Incomplete body")
            watchdog = self.server.watchdog
            payload = decode_heartbeat(body, watchdog.host, watchdog.wall(), watchdog.max_skew)
            watchdog.receive(payload)
        except (InvalidHeartbeat, TimeoutError, socket.timeout) as error:
            self.reply(400, {"error": str(error)})
        except (OSError, ValueError):
            self.server.watchdog.storage_error = "State persistence failed"
            self.reply(503, {"error": "State persistence failed"})
        else:
            self.reply(200, {"accepted": True, "host": watchdog.host})


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen", required=True, help="Explicit private or loopback IP; wildcard listeners are rejected")
    parser.add_argument("--port", type=int, default=19997)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--state-dir", required=True)
    parser.add_argument("--host", default="qq-box")
    parser.add_argument("--tls-cert")
    parser.add_argument("--tls-key")
    parser.add_argument("--warning-after", type=float, default=90)
    parser.add_argument("--critical-after", type=float, default=120)
    parser.add_argument("--startup-grace", type=float, default=120)
    parser.add_argument("--check-every", type=float, default=10)
    parser.add_argument("--snapshot-every", type=float, default=30)
    parser.add_argument("--max-clock-skew", type=float, default=120)
    args = parser.parse_args(argv)
    try:
        address = ipaddress.ip_address(args.listen)
        if address.is_unspecified or not (address.is_private or address.is_loopback):
            raise ValueError("Listener must use an explicit private or loopback IP")
        if bool(args.tls_cert) != bool(args.tls_key):
            raise ValueError("--tls-cert and --tls-key must be supplied together")
        if not 0 < args.warning_after < args.critical_after or not 0 < args.port <= 65535:
            raise ValueError("Invalid port or outage thresholds")
        if any(not finite_number(value) or value <= 0 for value in
               (args.warning_after, args.critical_after, args.startup_grace,
                args.check_every, args.snapshot_every, args.max_clock_skew)):
            raise ValueError("Intervals must be finite and positive")
        private_file(args.token_file)
        token = Path(args.token_file).read_text().strip()
        if not 16 <= len(token) <= 4096 or any(char.isspace() for char in token):
            raise ValueError("Token must contain 16 to 4096 non-whitespace characters")
        if args.tls_key:
            private_file(args.tls_key)
        args.token = token
    except (OSError, ValueError) as error:
        parser.error(str(error))
    return args


def main(argv=None):
    args = arguments(argv)
    watchdog = Watchdog(args.state_dir, args.host, args.warning_after, args.critical_after,
                        args.startup_grace, args.snapshot_every, args.max_clock_skew)
    if ":" in args.listen:
        HeartbeatServer.address_family = socket.AF_INET6
    server = HeartbeatServer((args.listen, args.port), watchdog, args.token)
    if args.tls_cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.tls_cert, args.tls_key)
        # Defer the handshake to bounded request threads, whose sockets time out.
        server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    stopped = threading.Event()

    def check():
        while not stopped.wait(args.check_every):
            try:
                watchdog.tick()
            except (OSError, ValueError):
                watchdog.storage_error = "State persistence failed"
                print("Watchdog state persistence failed", file=sys.stderr, flush=True)

    thread = threading.Thread(target=check, daemon=True, name="outage-watchdog")
    thread.start()

    def stop(*_):
        stopped.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        stopped.set()
        server.server_close()
        thread.join(timeout=2)


if __name__ == "__main__":
    main()
