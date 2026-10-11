#!/usr/bin/env python3
"""Install an isolated, authenticated Codex OpenSpec profile for T3 Code.

Source homes and project repositories are never written. Run --check to verify
the installation without changing files. Existing replaced files are backed up
under the private T3 home, outside the source checkout.
"""
from __future__ import annotations

import argparse
import copy
import datetime
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import tomllib
import uuid


SKILLS = (
    "openspec-explore", "openspec-propose", "openspec-update-change",
    "openspec-apply-change", "openspec-sync-specs", "openspec-archive-change",
)
CUSTOM_SKILL = "t3-openspec-architect"
OWNER = "t3-openspec-architect"


class InstallError(Exception):
    pass


def toml_value(value):
    """Serialize values in the two owned tables, preserving TOML semantics."""
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{ " + ", ".join(json.dumps(key) + " = " + toml_value(item)
                                 for key, item in value.items()) + " }"
    raise InstallError("unsupported TOML value in features or agents")


def toml_statements(text):
    """Split only at newlines outside strings, arrays and inline tables."""
    start = index = depth = 0
    quote = None
    comment = False
    while index < len(text):
        char = text[index]
        if comment:
            if char == "\n":
                comment = False
        elif quote:
            if quote[0] == '"' and char == "\\":
                index += 2
                continue
            if text.startswith(quote, index):
                length = len(quote)
                if length == 3:
                    while index + length < len(text) and text[index + length] == quote[0]:
                        length += 1
                index += length
                quote = None
                continue
        elif char in "\"'":
            quote = char * (3 if text.startswith(char * 3, index) else 1)
            index += len(quote)
            continue
        elif char == "#":
            comment = True
        elif char in "[{":
            depth += 1
        elif char in "]}":
            depth -= 1
        if char == "\n" and not quote and not depth:
            yield text[start:index + 1]
            start = index + 1
        index += 1
    if start < len(text):
        yield text[start:]


def first_key(sample):
    return next(iter(tomllib.loads(sample)))


def profile_config(source, source_home=None):
    original = tomllib.loads(source)
    desired = copy.deepcopy(original)
    desired.update(approval_policy="never", sandbox_mode="danger-full-access")
    for name in ("features", "agents"):
        if name in desired and not isinstance(desired[name], dict):
            raise InstallError(f"source {name} must be a TOML table")
        desired.setdefault(name, {})
    desired["features"]["multi_agent"] = True
    desired["agents"]["enabled"] = True
    maximum = desired["agents"].get("max_concurrent_threads_per_session", 5)
    if isinstance(maximum, bool) or not isinstance(maximum, int):
        raise InstallError("agent concurrency must be an integer")
    desired["agents"]["max_concurrent_threads_per_session"] = max(5, maximum)
    # Codex resolves custom role config files relative to CODEX_HOME. Keep each
    # role bound to its original file when relocating the main configuration;
    # the role file can retain its own relative dependencies in the source home.
    for role_name, role in desired["agents"].items():
        if not isinstance(role, dict) or "config_file" not in role:
            continue
        reference = role["config_file"]
        if not isinstance(reference, str) or not reference:
            raise InstallError(f"agent {role_name} config_file must be a nonempty path")
        dependency = Path(reference).expanduser()
        if not dependency.is_absolute():
            if source_home is None:
                raise InstallError(f"relative agent config_file needs its source home: {role_name}")
            dependency = Path(source_home) / dependency
            role["config_file"] = str(dependency.absolute())
        if not dependency.is_file():
            raise InstallError(f"missing agent configuration dependency: {dependency}")

    kept = []
    section = None
    root_insert = None
    for statement in toml_statements(source):
        stripped = statement.lstrip()
        if stripped.startswith("["):
            section = first_key(statement + "\n__t3_install_probe__ = 0\n")
            if section not in ("features", "agents") and root_insert is None:
                root_insert = len(kept)
        if section in ("features", "agents"):
            continue
        if section is None and stripped.strip() and not stripped.startswith("#"):
            key = first_key(statement)
            if key in ("approval_policy", "sandbox_mode", "features", "agents"):
                continue
        kept.append(statement)
    if root_insert is None:
        root_insert = len(kept)
    kept.insert(root_insert, '\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n\n')
    result = "".join(kept).rstrip() + "\n"
    for name in ("features", "agents"):
        result += f"\n[{name}]\n"
        for key, value in desired[name].items():
            result += json.dumps(key) + " = " + toml_value(value) + "\n"
    if tomllib.loads(result) != desired:
        raise InstallError("scoped TOML update would change unrelated configuration")
    return result


def require_directory(path):
    if path.is_symlink():
        raise InstallError(f"refusing conflicting directory symlink: {path}")
    if path.exists() and not path.is_dir():
        raise InstallError(f"expected directory: {path}")


def require_regular(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise InstallError(f"refusing conflicting file: {path}")


def require_link(path, target):
    if path.is_symlink():
        actual = Path(os.path.abspath(path.parent / os.readlink(path)))
        if actual != target:
            raise InstallError(f"refusing conflicting link: {path}")
    elif path.exists():
        raise InstallError(f"refusing existing skill or authentication path: {path}")


def json_object(path):
    value = json.loads(path.read_text()) if path.exists() else {}
    if not isinstance(value, dict):
        raise InstallError(f"expected JSON object: {path}")
    return value


def object_field(value, name):
    child = value.setdefault(name, {})
    if not isinstance(child, dict):
        raise InstallError(f"expected settings object: {name}")
    return child


def absolute(path):
    return Path(os.path.abspath(Path(path).expanduser()))


def atomic_write(path, data):
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(args):
    checkout = absolute(args.source_checkout)
    t3_home = absolute(args.t3_home)
    source_home = absolute(args.source_codex_home)
    home = absolute(args.codex_home or t3_home / "codex")
    real_home, real_source = home.resolve(), source_home.resolve()
    if real_home == real_source or real_home.is_relative_to(real_source) or real_source.is_relative_to(real_home):
        raise InstallError("the dedicated Codex home must be separate from the source home")
    if t3_home.resolve().is_relative_to(real_source):
        raise InstallError("T3 state must live outside the source Codex home")
    if t3_home.resolve().is_relative_to(checkout.resolve()) or real_home.is_relative_to(checkout.resolve()):
        raise InstallError("T3 state and private backups must live outside the source checkout")
    binary = absolute(args.codex_binary or Path.home() / ".local/bin/codex")
    if not binary.is_file() or not os.access(binary, os.X_OK):
        found = shutil.which("codex") if not args.codex_binary else None
        if not found:
            raise InstallError("stock Codex executable missing; supply --codex-binary")
        binary = absolute(found)

    source_config = source_home / "config.toml"
    config = profile_config(source_config.read_text() if source_config.exists() else "", source_home).encode()
    source_agents = source_home / "AGENTS.md"
    instructions = checkout / "docs/t3-codex-instructions.md"
    if not instructions.is_file():
        raise InstallError(f"missing T3 instructions: {instructions}")
    agents = ((source_agents.read_text() if source_agents.exists() else "").rstrip()
              + "\n\n<!-- T3 OpenSpec Architect profile -->\n\n"
              + instructions.read_text().rstrip() + "\n").encode()
    auth = source_home / "auth.json"
    if not auth.is_file():
        raise InstallError("source Codex home has no auth.json; sign in with stock Codex first")

    links = {home / "auth.json": auth}
    for skill in SKILLS:
        links[home / "skills" / skill] = checkout / "vendor/openspec/skills" / skill
    links[home / "skills" / CUSTOM_SKILL] = checkout / "skills" / CUSTOM_SKILL
    system = source_home / "skills/.system"
    if system.is_dir():
        links[home / "skills/.system"] = system
    for path, target in links.items():
        if path.name != "auth.json" and not (target / "SKILL.md").is_file() and path.name != ".system":
            raise InstallError(f"missing source skill: {target}")
        require_link(path, target)

    settings_path = t3_home / "userdata/settings.json"
    for directory in (t3_home, t3_home / "userdata", home, home / "skills", t3_home / "backups"):
        require_directory(directory)
    for path in (settings_path, home / "config.toml", home / "AGENTS.md", home / ".t3-openspec-architect.json"):
        require_regular(path)
    marker_path = home / ".t3-openspec-architect.json"
    if marker_path.exists():
        existing_marker = json_object(marker_path)
        if (existing_marker.get("owner") != OWNER or existing_marker.get("version") != 1
                or existing_marker.get("codexHome") != str(home)):
            raise InstallError(f"refusing unknown ownership marker: {marker_path}")
    else:
        for existing in (home / "config.toml", home / "AGENTS.md"):
            if existing.exists():
                raise InstallError(f"refusing unowned profile file: {existing}")
    settings = json_object(settings_path)
    current_settings = copy.deepcopy(settings)
    # T3 omits values equal to server defaults when persisting settings. Its
    # runtime default is full-access, so the omitted key is already configured.
    current_settings.setdefault("defaultRuntimeMode", "full-access")
    settings.update(defaultRuntimeMode="full-access", defaultThreadEnvMode="worktree")
    overrides = {"homePath": str(home), "setupMode": "existing", "binaryPath": str(binary)}
    object_field(object_field(settings, "providers"), "codex").update(overrides)
    instance = object_field(object_field(settings, "providerInstances"), "codex")
    instance.update(driver="codex", enabled=True, displayName="OpenSpec Architect")
    object_field(instance, "config").update(overrides)
    marker = {"owner": OWNER, "version": 1, "sourceCheckout": str(checkout),
              "sourceCodexHome": str(source_home), "codexHome": str(home)}
    settings_bytes = (settings_path.read_bytes()
                      if settings_path.exists() and current_settings == settings
                      else (json.dumps(settings, indent=2, ensure_ascii=False) + "\n").encode())
    writes = {
        home / "config.toml": config,
        home / "AGENTS.md": agents,
        settings_path: settings_bytes,
        marker_path: (json.dumps(marker, indent=2) + "\n").encode(),
    }
    changed = {path: data for path, data in writes.items() if not path.exists() or path.read_bytes() != data}
    missing_links = {path: target for path, target in links.items() if not path.is_symlink()}
    if args.check:
        if changed or missing_links:
            print(f"Installation needs updating: {len(changed)} files, {len(missing_links)} links.")
            return 1
        print(f"Verified T3 OpenSpec Architect profile: {home}")
        return 0

    backup = None
    replaced = [path for path in changed if path.exists() and path != marker_path]
    if replaced:
        backup = t3_home / "backups" / (OWNER + "-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
        backup.mkdir(mode=0o700, parents=True)
        backup.chmod(0o700)
        manifest = {}
        for number, path in enumerate(replaced):
            filename = f"{number}-{path.name}"
            atomic_write(backup / filename, path.read_bytes())
            manifest[filename] = str(path)
        atomic_write(backup / "manifest.json", (json.dumps(manifest, indent=2) + "\n").encode())
    for directory in (t3_home, t3_home / "userdata", home, home / "skills"):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for path, data in changed.items():
        atomic_write(path, data)
    for path, target in missing_links.items():
        path.symlink_to(target, target_is_directory=path.name != "auth.json")
    print(f"Configured T3 OpenSpec Architect: {home}")
    print(f"Updated {len(changed)} files and linked {len(missing_links)} skills/auth paths.")
    if backup:
        print(f"Private backups: {backup}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-checkout", default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--t3-home", default=Path.home() / ".t3")
    parser.add_argument("--source-codex-home", default=Path.home() / ".codex")
    parser.add_argument("--codex-home", help="default: <t3-home>/codex")
    parser.add_argument("--codex-binary", help="stock CLI path; default: ~/.local/bin/codex")
    parser.add_argument("--check", action="store_true", help="verify without writing")
    args = parser.parse_args(argv)
    try:
        return install(args)
    except (InstallError, OSError, ValueError) as error:
        print(f"T3 OpenSpec installation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
