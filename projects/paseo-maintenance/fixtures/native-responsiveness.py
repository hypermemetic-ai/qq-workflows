#!/usr/bin/python3
"""Bounded synthetic Android QA. Always pass --serial and a private --output.

Requires Pillow (this host: /usr/bin/python3). Prepare fresh reference/control
captures before timed actions; hierarchy dumps are deliberately outside the
immediate-tap interval. Timings include ADB/raw screenshot observation overhead;
PNG encoding occurs only after the outcome has been observed.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import struct
import time
import xml.etree.ElementTree as ET

from PIL import Image, ImageChops, ImageStat


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--adb", default="/home/qqp/.local/bin/adb")
    parser.add_argument("--package", default="sh.paseo.debug")
    parser.add_argument("--fixture", type=Path)
    parser.add_argument("--workload", default="idle")
    commands = parser.add_subparsers(dest="command", required=True)
    capture = commands.add_parser("capture")
    capture.add_argument("name")
    capture.add_argument("--image-only", action="store_true", help="Capture the current frame without Android's hierarchy idle wait")
    tap = commands.add_parser("tap")
    tap.add_argument("identity", help="Exact resource ID, text or content description")
    tap.add_argument("--text")
    tap.add_argument("--replace", action="store_true")
    point = commands.add_parser("tap-point", help="Tap audited screenshot coordinates when native hierarchy cannot settle")
    point.add_argument("x", type=int)
    point.add_argument("y", type=int)
    point.add_argument("--reason", required=True)
    point.add_argument("--text", help="Type synthetic text into the audited input")
    shell_input = commands.add_parser("input")
    shell_input.add_argument("kind", choices=["back", "home", "swipe-up", "swipe-down", "open-left", "open-right"])
    controls = commands.add_parser("controls")
    controls.add_argument("--row-one", default="Workspace 01")
    controls.add_argument("--row-two", default="Workspace 02")
    launch = commands.add_parser("launch")
    launch.add_argument("--index", type=int, default=0)
    trials = commands.add_parser("trials")
    trials.add_argument("action", choices=["close", "selection"])
    trials.add_argument("--repetitions", type=int, default=10)
    trials.add_argument("--delay-ms", type=int, default=0)
    trials.add_argument("--row-one", default="Workspace 01")
    trials.add_argument("--row-two", default="Workspace 02")
    fixture = commands.add_parser("fixture")
    fixture.add_argument("json_command")
    cpu = commands.add_parser("cpu")
    cpu.add_argument("--surface", required=True)
    cpu.add_argument("--windows", type=int, default=3)
    cpu.add_argument("--seconds", type=float, default=8)
    trace = commands.add_parser("trace")
    trace.add_argument("name")
    trace.add_argument("--seconds", type=int, default=60)
    pull = commands.add_parser("pull-trace")
    pull.add_argument("name")
    args = parser.parse_args()
    if args.package != "sh.paseo.debug":
        parser.error("This driver only operates the synthetic QA package sh.paseo.debug")
    if not args.output.is_absolute():
        parser.error("Use a private absolute output directory")
    args.output.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(args.output, 0o700)
    target = [args.adb, "-s", args.serial]

    def adb(*parts, timeout=20):
        return subprocess.run(target + list(parts), capture_output=True, check=True, timeout=timeout).stdout

    # Never infer the target from an attached phone or the shared ADB default.
    if adb("shell", "getprop", "ro.kernel.qemu").strip() != b"1":
        parser.error("The explicit serial is not an emulator")
    for setting in ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"]:
        if float(adb("shell", "settings", "get", "global", setting).strip()) != 0:
            parser.error("All emulator animation settings must already be zero")

    def record(value):
        value = {"hostMonotonicMs": round(time.monotonic() * 1000, 3), "workload": args.workload, "serial": args.serial, **value}
        with (args.output / "actions.jsonl").open("a") as handle:
            handle.write(json.dumps(value) + "\n")
        print(json.dumps(value), flush=True)

    def safe_name(name):
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
            parser.error("Artifact names must be simple filenames")
        return name

    def shot():
        started = time.monotonic() * 1000
        data = adb("exec-out", "screencap")
        returned = time.monotonic() * 1000
        if len(data) < 16:
            raise RuntimeError("Incomplete raw Android screencap")
        width, height, pixel_format, color_space = struct.unpack("<4I", data[:16])
        if (width, height, pixel_format) != (720, 1616, 1) or len(data) != 16 + width * height * 4:
            raise RuntimeError("This audited raw capture profile requires 720×1616 RGBA paseo_qa")
        frame = Image.frombytes("RGBA", (width, height), data[16:]).convert("RGB")
        decoded = time.monotonic() * 1000
        return frame, decoded - started, {"startedMs": started, "returnedMs": returned, "decodedMs": decoded, "transportBytes": len(data), "pixelFormat": pixel_format, "colorSpace": color_space}

    def hierarchy():
        adb("shell", "rm", "-f", "/data/local/tmp/paseo-responsiveness.xml")
        result = adb("shell", "uiautomator", "dump", "/data/local/tmp/paseo-responsiveness.xml")
        if b"dumped to" not in result:
            raise RuntimeError(f"Native hierarchy did not settle; no stale XML was reused: {result.decode().strip()[:250]}")
        data = adb("shell", "cat", "/data/local/tmp/paseo-responsiveness.xml")
        return ET.fromstring(data), data

    def find_control(root, identity):
        exact = [node for node in root.iter("node") if node.get("resource-id") == identity]
        if not exact:
            exact = [node for node in root.iter("node") if node.get("resource-id", "").endswith("/" + identity)]
        if not exact:
            exact = [node for node in root.iter("node") if identity in [node.get("text"), node.get("content-desc")]]
            parents = {child: parent for parent in root.iter() for child in parent}
            rows = []
            for node in exact:
                ancestor = node
                while ancestor is not None:
                    if ancestor.get("resource-id", "").startswith("sidebar-workspace-row-"):
                        rows.append(ancestor)
                        break
                    ancestor = parents.get(ancestor)
            rows = list(dict.fromkeys(rows))
            clickable = [node for node in exact if node.get("clickable") == "true"]
            exact = rows or clickable or exact
        if len(exact) != 1:
            raise RuntimeError(f"Expected one visible control {identity!r}; found {len(exact)}")
        bounds = list(map(int, re.findall(r"\d+", exact[0].get("bounds", ""))))
        if len(bounds) != 4 or bounds[0] >= bounds[2] or bounds[1] >= bounds[3]:
            raise RuntimeError(f"Control has invalid bounds: {identity}")
        return bounds

    def tap_bounds(bounds):
        adb("shell", "input", "tap", str((bounds[0] + bounds[2]) // 2), str((bounds[1] + bounds[3]) // 2))

    def pressure():
        return {name: Path(f"/proc/pressure/{name}").read_text().strip() for name in ["cpu", "memory", "io"]}

    def marker():
        started = time.monotonic() * 1000
        uptime = float(adb("shell", "cat", "/proc/uptime").split()[0])
        return {"hostBeforeMs": started, "hostAfterMs": time.monotonic() * 1000, "deviceUptimeSeconds": uptime, "hostPressure": pressure()}

    roi = (20, 63, 685, 140)

    def reference(name):
        return Image.open(args.output / f"{name}.png").convert("RGB").crop(roi)

    def observe(names, timeout=8):
        refs = {name: reference(name) for name in names if (args.output / f"{name}.png").exists()}
        started = time.monotonic()
        polls, overhead, captures = 0, [], []
        while time.monotonic() - started < timeout:
            frame, elapsed, capture = shot()
            overhead.append(round(elapsed, 3))
            captures.append(capture)
            polls += 1
            for name, ref in refs.items():
                difference = sum(ImageStat.Stat(ImageChops.difference(frame.crop(roi), ref)).mean) / 3
                if difference < 0.1:
                    return name, frame, {"observedMs": time.monotonic() * 1000, "polls": polls, "meanRGBdiff": difference, "screenshotMs": overhead, "captures": captures}
            time.sleep(0.04)
        return "unresolved", frame, {"observedMs": time.monotonic() * 1000, "polls": polls, "screenshotMs": overhead, "captures": captures}

    def open_drawer():
        started = time.monotonic() * 1000
        adb("shell", "input", "swipe", "10", "700", "660", "700", "300")
        returned = time.monotonic() * 1000
        name, frame, observation = observe(["drawer"])
        if name != "drawer":
            frame.save(args.output / "failed-drawer.png")
            raise RuntimeError("The full settled drawer header was not observed")
        return frame, {"swipeStartedMs": started, "swipeReturnedMs": returned, **observation}

    if args.command == "capture":
        name = safe_name(args.name)
        frame, overhead, capture = shot()
        frame.save(args.output / f"{name}.png")
        if args.image_only:
            record({"op": "capture", "name": name, "screenshotMs": overhead, "rawCapture": capture, "hierarchy": "omitted", "marker": marker()})
            return
        try:
            root, data = hierarchy()
        except (RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            record({"op": "capture", "name": name, "screenshotMs": overhead, "rawCapture": capture, "hierarchyError": str(error)[:350], "marker": marker()})
            raise
        (args.output / f"{name}.xml").write_bytes(data)
        record({"op": "capture", "name": name, "screenshotMs": overhead, "rawCapture": capture, "marker": marker()})
    elif args.command == "controls":
        root, data = hierarchy()
        controls = {"close": find_control(root, "sidebar-close"), "rows": {name: find_control(root, name) for name in [args.row_one, args.row_two]}}
        (args.output / "controls.json").write_text(json.dumps(controls, indent=2))
        (args.output / "controls.xml").write_bytes(data)
        record({"op": "controls", **controls})
    elif args.command == "tap":
        root, _ = hierarchy()
        bounds = find_control(root, args.identity)
        started = time.monotonic() * 1000
        tap_bounds(bounds)
        if args.text is not None:
            if args.replace:
                matches = [node for node in root.iter("node") if node.get("bounds") == f"[{bounds[0]},{bounds[1]}][{bounds[2]},{bounds[3]}]"]
                length = max((len(node.get("text", "")) for node in matches), default=0)
                if length > 1000:
                    raise RuntimeError("Synthetic input is too long for bounded replacement")
                adb("shell", "input", "keyevent", "123", *(["67"] * length))
            adb("shell", "input", "text", args.text.replace(" ", "%s"))
        record({"op": "tap", "identity": args.identity, "bounds": bounds, "startedMs": started, "returnedMs": time.monotonic() * 1000})
    elif args.command == "tap-point":
        if not 0 <= args.x < 720 or not 0 <= args.y < 1616:
            parser.error("Use coordinates within the audited 720×1616 emulator")
        started = time.monotonic() * 1000
        adb("shell", "input", "tap", str(args.x), str(args.y))
        if args.text is not None:
            adb("shell", "input", "text", args.text.replace(" ", "%s"))
        record({"op": "tap-point", "point": [args.x, args.y], "reason": args.reason, "startedMs": started, "returnedMs": time.monotonic() * 1000})
    elif args.command == "input":
        actions = {"back": ["keyevent", "4"], "home": ["keyevent", "3"], "swipe-up": ["swipe", "350", "1300", "350", "500", "400"], "swipe-down": ["swipe", "350", "500", "350", "1300", "400"], "open-left": ["swipe", "10", "700", "660", "700", "300"], "open-right": ["swipe", "690", "700", "30", "700", "300"]}
        started = time.monotonic() * 1000
        adb("shell", "input", *actions[args.kind])
        record({"op": args.kind, "startedMs": started, "returnedMs": time.monotonic() * 1000, "marker": marker()})
    elif args.command == "fixture":
        if args.fixture is None:
            parser.error("fixture requires --fixture pointing at the owned output/FIFO directory")
        command = json.loads(args.json_command)
        command.setdefault("requestId", f"native-{time.monotonic_ns()}")
        fd = os.open(args.fixture / "control.fifo", os.O_WRONLY | os.O_NONBLOCK)
        try:
            os.write(fd, (json.dumps(command) + "\n").encode())
        finally:
            os.close(fd)
        record({"op": "fixture-command", "command": command, "marker": marker()})
    elif args.command == "launch":
        if args.fixture is None:
            parser.error("launch requires the owned --fixture directory")
        manifest = json.loads((args.fixture / "fixture-ready-private.json").read_text())
        if manifest.get("ready") is not True:
            parser.error("The owned synthetic fixture is not ready")
        if not 0 <= args.index < len(manifest["agents"]):
            parser.error("Invalid synthetic agent index")
        uri = f"paseo://h/{manifest['serverId']}/agent/{manifest['agents'][args.index]['id']}"
        started = time.monotonic() * 1000
        adb("shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", uri, args.package)
        returned = time.monotonic() * 1000
        # Deep-link delivery is asynchronous. Verify the selected session before
        # preparing references; this hierarchy wait is outside timed trials.
        title = manifest["agents"][args.index]["title"]
        deadline = time.monotonic() + 15
        while True:
            root, _ = hierarchy()
            if any(node.get("text") == title and node.get("bounds") for node in root.iter("node")):
                break
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Deep link did not select synthetic session {title!r}")
            time.sleep(0.1)
        record({"op": "launch", "syntheticIndex": args.index, "selectedTitle": title, "startedMs": started, "returnedMs": returned, "verifiedMs": time.monotonic() * 1000, "preparationOnly": True})
    elif args.command == "trials":
        if not 1 <= args.repetitions <= 50 or not 0 <= args.delay_ms <= 2000:
            parser.error("Use 1–50 repetitions and 0–2000 ms delay")
        controls = json.loads((args.output / "controls.json").read_text())
        required = ["drawer", "explorer", "chat"] if args.action == "close" else ["drawer", "explorer", "workspace-one", "workspace-two"]
        for name in required:
            if not (args.output / f"{name}.png").exists():
                parser.error(f"Prepare the fresh {name} reference before trials")
        if args.action == "selection":
            difference = sum(ImageStat.Stat(ImageChops.difference(reference("workspace-one"), reference("workspace-two"))).mean) / 3
            if difference < 0.1:
                parser.error("Workspace references must have different native headers")
        # Fresh controls/reference preparation is mandatory; no hierarchy dump in the timed interval.
        for trial in range(args.repetitions):
            origin = "chat" if args.action == "close" else ("workspace-one" if trial % 2 == 0 else "workspace-two")
            origin_result, origin_frame, origin_observation = observe([origin])
            if origin_result != origin:
                origin_frame.save(args.output / f"{args.action}-{args.delay_ms}-{trial + 1}-wrong-origin.png")
                raise RuntimeError(f"Trial must start on {origin}; selected destination would not prove different-workspace navigation")
            anchor = marker()
            before_frame, opened = open_drawer()
            if args.delay_ms:
                time.sleep(args.delay_ms / 1000)
            expected = "chat" if args.action == "close" else ("workspace-two" if trial % 2 == 0 else "workspace-one")
            row = args.row_two if trial % 2 == 0 else args.row_one
            bounds = controls["close"] if args.action == "close" else controls["rows"][row]
            started = time.monotonic() * 1000
            matched_capture = opened["captures"][-1]
            capture_to_tap_ms = [started - matched_capture["returnedMs"], started - matched_capture["startedMs"]]
            tap_bounds(bounds)
            returned = time.monotonic() * 1000
            # Preserve the first observed destination before any artifact encoding.
            result, frame, observed = observe([expected, "explorer"])
            if result == "unresolved":
                difference = sum(ImageStat.Stat(ImageChops.difference(frame.crop(roi), reference("drawer"))).mean) / 3
                if difference < 0.1:
                    result = "drawer-timeout"
                elif args.action == "selection":
                    difference = sum(ImageStat.Stat(ImageChops.difference(frame.crop(roi), reference(origin))).mean) / 3
                    if difference < 0.1:
                        result = "origin-timeout"
            encoding_started = time.monotonic() * 1000
            before_frame.save(args.output / f"{args.action}-{args.delay_ms}-{trial + 1}-before.png")
            before_encoding_ms = time.monotonic() * 1000 - encoding_started
            encoding_started = time.monotonic() * 1000
            frame.save(args.output / f"{args.action}-{args.delay_ms}-{trial + 1}-result.png")
            result_encoding_ms = time.monotonic() * 1000 - encoding_started
            record({"op": args.action, "trial": trial + 1, "extraDelayMs": args.delay_ms, "visualObservationToTapMs": started - opened["observedMs"], "captureIntervalToTapMs": capture_to_tap_ms, "origin": origin, "originObserver": origin_observation, "expected": expected, "result": result, "success": result == expected, "tapBounds": bounds, "tapStartedMs": started, "tapReturnedMs": returned, "responseUpperBoundMs": observed["observedMs"] - started, "open": opened, "resultObserver": observed, "pngEncodingMs": {"before": before_encoding_ms, "result": result_encoding_ms}, "marker": anchor})
            if result != expected:
                # Leave the failure intact for native inspection; never hide it with retries.
                break
            time.sleep(0.3)
    elif args.command == "cpu":
        if not 1 <= args.windows <= 10 or not 2 <= args.seconds <= 30:
            parser.error("Use 1–10 CPU windows of 2–30 seconds")
        def ticks():
            pid = adb("shell", "pidof", args.package).decode().strip().split()[0]
            fields = adb("shell", "cat", f"/proc/{pid}/stat").decode().split(") ", 1)[1].split()
            return pid, int(fields[11]) + int(fields[12])
        try:
            clock_ticks = int(adb("shell", "getconf", "CLK_TCK").strip())
            clock_source = "guest getconf CLK_TCK"
        except (subprocess.CalledProcessError, ValueError):
            clock_ticks, clock_source = 100, "Linux/Android USER_HZ=100; guest getconf unavailable"
        for window in range(args.windows):
            start_marker = marker()
            pid, before = ticks()
            started = time.monotonic()
            time.sleep(args.seconds)
            end_pid, after = ticks()
            elapsed = time.monotonic() - started
            if pid != end_pid:
                raise RuntimeError("App process changed during CPU window")
            record({"op": "cpu", "surface": args.surface, "window": window + 1, "seconds": elapsed, "cpuTicks": after - before, "guestClockTicksPerSecond": clock_ticks, "clockSource": clock_source, "oneCoreCPUPercent": 100 * (after - before) / clock_ticks / elapsed, "startMarker": start_marker, "endMarker": marker()})
    elif args.command == "trace":
        name = safe_name(args.name)
        if not 5 <= args.seconds <= 180:
            parser.error("Trace duration must be 5–180 seconds")
        configuration = f'''buffers {{ size_kb: 32768 fill_policy: RING_BUFFER }}
duration_ms: {args.seconds * 1000}
data_sources {{ config {{ name: "linux.ftrace" ftrace_config {{
 ftrace_events: "sched/sched_switch" ftrace_events: "sched/sched_waking"
 ftrace_events: "power/cpu_frequency" ftrace_events: "power/cpu_idle"
 atrace_categories: "gfx" atrace_categories: "view" atrace_categories: "input"
 atrace_categories: "wm" atrace_categories: "am" atrace_categories: "binder_driver"
 atrace_apps: "{args.package}"
}} }} }}
data_sources {{ config {{ name: "linux.process_stats" process_stats_config {{ scan_all_processes_on_start: true }} }} }}
'''
        config = args.output / f"{name}.pbtxt"
        config.write_text(configuration)
        device = f"/data/misc/perfetto-traces/paseo-{name}.pftrace"
        device_config = f"/data/misc/perfetto-configs/paseo-{name}.pbtxt"
        adb("push", str(config), device_config)
        adb("shell", "chmod", "644", device_config)
        result = adb("shell", "perfetto", "--txt", "--background", "-c", device_config, "-o", device)
        record({"op": "trace-start", "name": name, "seconds": args.seconds, "perfetto": result.decode().strip(), "marker": marker()})
    elif args.command == "pull-trace":
        name = safe_name(args.name)
        adb("pull", f"/data/misc/perfetto-traces/paseo-{name}.pftrace", str(args.output / f"{name}.pftrace"), timeout=60)
        adb("shell", "rm", f"/data/misc/perfetto-traces/paseo-{name}.pftrace", f"/data/misc/perfetto-configs/paseo-{name}.pbtxt")
        record({"op": "trace-pull", "name": name})


if __name__ == "__main__":
    main()
