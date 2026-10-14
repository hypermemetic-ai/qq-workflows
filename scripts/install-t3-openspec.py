#!/usr/bin/env python3
"""Install the OpenSpec Architect profile for T3 Code's Claude provider on Opus.

T3's Claude instance keeps the user's normal Claude login and configuration.
The installer adds a private profile directory whose `.claude/skills` holds
links to the unchanged OpenSpec core skills plus the adapter, and whose linked
instructions are appended to T3's system prompt through launch arguments. The
Codex provider is disabled and no longer receives installer-owned settings.
T3 removes a thread's worktree once its pull request is merged.

Source checkouts, Claude homes and project repositories are never written. Run
--check to verify without changing files. Replaced files are backed up under
the private T3 home, outside the source checkout.
"""
from __future__ import annotations

import argparse
import copy
import datetime
import json
import os
from pathlib import Path
import shlex
import shutil
import sys
import tempfile
import uuid


SKILLS = (
    "openspec-explore", "openspec-propose", "openspec-update-change",
    "openspec-apply-change", "openspec-sync-specs", "openspec-archive-change",
)
CUSTOM_SKILL = "t3-openspec-architect"
OWNER = "t3-openspec-architect"
MARKER_VERSION = 2
INSTANCE = "claudeAgent"
DISPLAY_NAME = "OpenSpec Architect"
MODEL = "claude-opus-5-5"
# Commit messages, branch names and titles are short one-shot writes.
TEXT_GENERATION_MODEL = "claude-haiku-5-5"
# Compact well before Opus's 1M-token window to keep long sessions focused.
AUTO_COMPACT_WINDOW = "300000"
TEXT_GENERATION_OPTIONS = [{"id": "effort", "value": "low"}]
# Flags T3 forwards to the Claude Agent SDK as extraArgs, one value per flag.
OWNED_FLAGS = ("add-dir", "append-system-prompt-file")
# Codex settings written by the retired Codex profile installer.
LEGACY_CODEX_KEYS = ("homePath", "setupMode", "binaryPath")


class InstallError(Exception):
    pass


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
        raise InstallError(f"refusing existing skill path: {path}")


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


def launch_args(existing, owned):
    """Replace owned flags in T3's launch argument string, keeping the rest.

    T3 parses the string into a flag map, so a second value for an owned flag
    would silently replace the profile. Values pointing elsewhere are refused.
    """
    if not isinstance(existing, str):
        raise InstallError("Claude launchArgs must be a string")
    tokens = shlex.split(existing)
    kept = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        name, _, inline = token[2:].partition("=") if token.startswith("--") else ("", "", "")
        if name in OWNED_FLAGS:
            if inline:
                value = inline
            elif index + 1 < len(tokens) and not tokens[index + 1].startswith("--"):
                value = tokens[index + 1]
                index += 1
            else:
                value = ""
            if value != owned[name]:
                raise InstallError(f"refusing conflicting Claude launch argument --{name}: {value}")
        else:
            kept.append(token)
        index += 1
    for name in OWNED_FLAGS:
        kept += [f"--{name}", owned[name]]
    return shlex.join(kept)


def retire_codex(settings, legacy_home):
    """Disable Codex and remove only the settings the Codex profile installer owned."""
    def drop_owned(config):
        if legacy_home is not None and config.get("homePath") == str(legacy_home):
            for key in LEGACY_CODEX_KEYS:
                config.pop(key, None)

    providers = settings.get("providers")
    if isinstance(providers, dict) and isinstance(providers.get("codex"), dict):
        drop_owned(providers["codex"])
        if not providers["codex"]:
            del providers["codex"]
        if not providers:
            del settings["providers"]
    instance = object_field(object_field(settings, "providerInstances"), "codex")
    config = instance.get("config")
    if isinstance(config, dict):
        drop_owned(config)
        if not config:
            del instance["config"]
    if instance.get("displayName") == DISPLAY_NAME:
        del instance["displayName"]
    # An unconfigured default instance is enabled, so Codex stays disabled explicitly.
    instance.update(driver="codex", enabled=False)


def install(args):
    checkout = absolute(args.source_checkout)
    t3_home = absolute(args.t3_home)
    profile = absolute(args.profile or t3_home / "claude-architect")
    if t3_home.resolve().is_relative_to(checkout.resolve()) or profile.resolve().is_relative_to(checkout.resolve()):
        raise InstallError("T3 state and private backups must live outside the source checkout")
    claude_home = Path.home() / ".claude"
    if profile.resolve().is_relative_to(claude_home.resolve()):
        raise InstallError("the architect profile must live outside the Claude home")
    if any(char.isspace() or char in "\"'\\" for char in str(profile)):
        raise InstallError("the architect profile path must not contain whitespace, quotes or backslashes")
    binary = absolute(args.claude_binary or Path.home() / ".local/bin/claude")
    if not binary.is_file() or not os.access(binary, os.X_OK):
        found = shutil.which("claude") if not args.claude_binary else None
        if not found:
            raise InstallError("Claude Code executable missing; supply --claude-binary")
        binary = absolute(found)

    source_instructions = checkout / "docs/t3-architect-instructions.md"
    if not source_instructions.is_file():
        raise InstallError(f"missing T3 instructions: {source_instructions}")

    skills = profile / ".claude/skills"
    links = {skills / skill: checkout / "vendor/openspec/skills" / skill for skill in SKILLS}
    links[skills / CUSTOM_SKILL] = checkout / "skills" / CUSTOM_SKILL
    for path, target in links.items():
        if not (target / "SKILL.md").is_file():
            raise InstallError(f"missing source skill: {target}")
        require_link(path, target)

    settings_path = t3_home / "userdata/settings.json"
    instructions_path = profile / "instructions.md"
    marker_path = profile / ".t3-openspec-architect.json"
    for directory in (t3_home, t3_home / "userdata", t3_home / "backups", profile, profile / ".claude", skills):
        require_directory(directory)
    for path in (settings_path, marker_path):
        require_regular(path)
    if marker_path.exists():
        existing_marker = json_object(marker_path)
        if existing_marker.get("owner") != OWNER or existing_marker.get("profile") != str(profile):
            raise InstallError(f"refusing unknown ownership marker: {marker_path}")
    elif instructions_path.exists() or instructions_path.is_symlink():
        raise InstallError(f"refusing unowned profile file: {instructions_path}")
    # Earlier installs copied the instructions; that owned copy becomes a link.
    copied_instructions = instructions_path.is_file() and not instructions_path.is_symlink()
    if not copied_instructions:
        require_link(instructions_path, source_instructions)
    links[instructions_path] = source_instructions

    # The retired Codex installer recorded its dedicated home in this marker.
    legacy_home = None
    legacy_marker = t3_home / "codex/.t3-openspec-architect.json"
    if legacy_marker.is_file() and not legacy_marker.is_symlink():
        recorded = json_object(legacy_marker)
        if recorded.get("owner") == OWNER and isinstance(recorded.get("codexHome"), str):
            legacy_home = recorded["codexHome"]

    settings = json_object(settings_path)
    current_settings = copy.deepcopy(settings)
    # T3 omits values equal to server defaults when persisting settings. Its
    # runtime default is full-access, so the omitted key is already configured.
    current_settings.setdefault("defaultRuntimeMode", "full-access")
    settings.update(
        defaultRuntimeMode="full-access", defaultThreadEnvMode="worktree",
        defaultModelSelection={"instanceId": INSTANCE, "model": MODEL},
        textGenerationModelSelection={"instanceId": INSTANCE, "model": TEXT_GENERATION_MODEL,
                                      "options": copy.deepcopy(TEXT_GENERATION_OPTIONS)})
    retire_codex(settings, legacy_home)
    # Delivery ends with a merged pull request; T3 then removes the clean worktree.
    object_field(settings, "storageCleanup")["worktreeOnMerge"] = True
    instance = object_field(object_field(settings, "providerInstances"), INSTANCE)
    instance.update(driver=INSTANCE, enabled=True, displayName=DISPLAY_NAME)
    config = object_field(instance, "config")
    owned = {"add-dir": str(profile), "append-system-prompt-file": str(instructions_path)}
    config.update(binaryPath=str(binary), autoCompactWindow=AUTO_COMPACT_WINDOW,
                  launchArgs=launch_args(config.get("launchArgs", ""), owned))
    marker = {"owner": OWNER, "version": MARKER_VERSION, "sourceCheckout": str(checkout),
              "profile": str(profile), "instance": INSTANCE, "model": MODEL,
              "textGenerationModel": TEXT_GENERATION_MODEL}
    settings_bytes = (settings_path.read_bytes()
                      if settings_path.exists() and current_settings == settings
                      else (json.dumps(settings, indent=2, ensure_ascii=False) + "\n").encode())
    writes = {
        settings_path: settings_bytes,
        marker_path: (json.dumps(marker, indent=2) + "\n").encode(),
    }
    changed = {path: data for path, data in writes.items() if not path.exists() or path.read_bytes() != data}
    missing_links = {path: target for path, target in links.items() if not path.is_symlink()}
    if args.check:
        if changed or missing_links:
            print(f"Installation needs updating: {len(changed)} files, {len(missing_links)} links.")
            return 1
        print(f"Verified T3 OpenSpec Architect profile: {profile}")
        return 0

    backup = None
    replaced = [path for path in changed if path.exists() and path != marker_path]
    if copied_instructions:
        replaced.append(instructions_path)
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
    for directory in (t3_home, t3_home / "userdata", profile, profile / ".claude", skills):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    for path, data in changed.items():
        atomic_write(path, data)
    if copied_instructions:
        instructions_path.unlink()
    for path, target in missing_links.items():
        path.symlink_to(target, target_is_directory=target.is_dir())
    print(f"Configured T3 OpenSpec Architect on {MODEL}: {profile}")
    print(f"Updated {len(changed)} files and linked {len(missing_links)} skills and instructions.")
    if backup:
        print(f"Private backups: {backup}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-checkout", default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--t3-home", default=Path.home() / ".t3")
    parser.add_argument("--profile", help="default: <t3-home>/claude-architect")
    parser.add_argument("--claude-binary", help="Claude Code CLI path; default: ~/.local/bin/claude")
    parser.add_argument("--check", action="store_true", help="verify without writing")
    args = parser.parse_args(argv)
    try:
        return install(args)
    except (InstallError, OSError, ValueError) as error:
        print(f"T3 OpenSpec installation failed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
