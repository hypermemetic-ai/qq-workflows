#!/usr/bin/env python3
"""Installer behavior tests use private fixtures and never touch live homes."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest import mock


SPEC = importlib.util.spec_from_file_location(
    "installer", Path(__file__).resolve().parent.parent / "scripts/install-t3-openspec.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="t3-openspec-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / "home"
        (self.home / ".claude").mkdir(parents=True)
        (self.home / ".claude/.credentials.json").write_text('{"fixture":"credential-never-read"}\n')
        environment = mock.patch.dict(os.environ, {"HOME": str(self.home)})
        environment.start()
        self.addCleanup(environment.stop)
        self.checkout = self.root / "checkout with spaces"
        self.t3 = self.root / "t3"
        self.profile = self.t3 / "claude-architect"
        self.binary = self.root / "claude"
        self.binary.write_text("#!/bin/sh\nexit 0\n")
        self.binary.chmod(0o700)
        for skill in installer.SKILLS:
            directory = self.checkout / "vendor/openspec/skills" / skill
            directory.mkdir(parents=True)
            (directory / "SKILL.md").write_text(f"# {skill}\nfixture\n")
        custom = self.checkout / "skills" / installer.CUSTOM_SKILL
        custom.mkdir(parents=True)
        (custom / "SKILL.md").write_text("# Architect\n")
        (self.checkout / "docs").mkdir()
        (self.checkout / "docs/t3-architect-instructions.md").write_text("# T3\nParent plans; assigned workers implement.\n")

    def argv(self):
        return ["--source-checkout", str(self.checkout), "--t3-home", str(self.t3),
                "--claude-binary", str(self.binary)]

    def invoke(self, *extra):
        with contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()) as errors:
            code = installer.main(self.argv() + list(extra))
        return code, output.getvalue(), errors.getvalue()

    def snapshot(self, root):
        if not root.exists():
            return {}
        return {str(path.relative_to(root)): ("link", os.readlink(path)) if path.is_symlink()
                else ("file", path.read_bytes()) if path.is_file() else ("directory", None)
                for path in root.rglob("*")}

    def settings_path(self):
        return self.t3 / "userdata/settings.json"

    def settings(self):
        return json.loads(self.settings_path().read_text())

    def write_settings(self, value):
        self.settings_path().parent.mkdir(parents=True, exist_ok=True)
        self.settings_path().write_text(json.dumps(value))

    def owned_args(self):
        return f"--add-dir {self.profile} --append-system-prompt-file {self.profile / 'instructions.md'}"

    def install_legacy_codex(self):
        """Reproduce the state left by the retired Codex profile installer."""
        codex = self.t3 / "codex"
        (codex / "skills").mkdir(parents=True)
        (codex / "AGENTS.md").write_text("# kept Codex history\n")
        (codex / ".t3-openspec-architect.json").write_text(json.dumps(
            {"owner": installer.OWNER, "version": 1, "codexHome": str(codex)}))
        owned = {"homePath": str(codex), "setupMode": "existing", "binaryPath": "/bin/codex"}
        self.write_settings({
            "defaultThreadEnvMode": "worktree",
            "providers": {"codex": dict(owned)},
            "providerInstances": {"codex": {"driver": "codex", "displayName": "OpenSpec Architect",
                                            "enabled": True, "config": dict(owned)}}})
        return codex

    def test_fresh_install_configures_opus_profile_and_disables_codex(self):
        home_before = self.snapshot(self.home)
        checkout_before = self.snapshot(self.checkout)
        code, output, error = self.invoke()
        self.assertEqual((code, error), (0, ""))
        self.assertNotIn("credential-never-read", output)
        self.assertEqual(self.snapshot(self.home), home_before)
        self.assertEqual(self.snapshot(self.checkout), checkout_before)
        for skill in installer.SKILLS:
            self.assertEqual((self.profile / ".claude/skills" / skill).resolve(),
                             (self.checkout / "vendor/openspec/skills" / skill).resolve())
        self.assertEqual((self.profile / ".claude/skills" / installer.CUSTOM_SKILL).resolve(),
                         (self.checkout / "skills" / installer.CUSTOM_SKILL).resolve())
        self.assertEqual(os.readlink(self.profile / "instructions.md"),
                         str(self.checkout / "docs/t3-architect-instructions.md"))
        self.assertIn("Parent plans; assigned workers implement.", (self.profile / "instructions.md").read_text())
        self.assertFalse((self.t3 / "codex").exists())
        settings = self.settings()
        self.assertEqual(settings["defaultRuntimeMode"], "full-access")
        self.assertEqual(settings["defaultThreadEnvMode"], "worktree")
        self.assertEqual(settings["defaultModelSelection"], {"instanceId": "claudeAgent", "model": "claude-opus-5-5"})
        self.assertEqual(settings["textGenerationModelSelection"],
                         {"instanceId": "claudeAgent", "model": "claude-haiku-5-5",
                          "options": [{"id": "effort", "value": "low"}]})
        claude = settings["providerInstances"]["claudeAgent"]
        self.assertEqual((claude["driver"], claude["enabled"], claude["displayName"]),
                         ("claudeAgent", True, "OpenSpec Architect"))
        self.assertEqual(claude["config"], {"binaryPath": str(self.binary), "autoCompactWindow": "300000",
                                            "launchArgs": self.owned_args()})
        self.assertNotIn("homePath", claude["config"])
        self.assertEqual(settings["providerInstances"]["codex"], {"driver": "codex", "enabled": False})
        self.assertNotIn("providers", settings)
        self.assertEqual(settings["storageCleanup"], {"worktreeOnMerge": True})

    def test_migrates_codex_install_removing_only_owned_codex_settings(self):
        codex = self.install_legacy_codex()
        settings = self.settings()
        settings["providerInstances"]["codex"]["config"]["launchArgs"] = "--keep-me"
        settings["providers"]["codex"]["env"] = {"KEEP": "yes"}
        self.write_settings(settings)
        legacy_before = self.snapshot(codex)
        self.assertEqual(self.invoke()[0], 0)
        after = self.settings()
        self.assertEqual(after["providerInstances"]["codex"],
                         {"driver": "codex", "enabled": False, "config": {"launchArgs": "--keep-me"}})
        self.assertEqual(after["providers"], {"codex": {"env": {"KEEP": "yes"}}})
        self.assertEqual(after["providerInstances"]["claudeAgent"]["displayName"], "OpenSpec Architect")
        # Old Codex conversations stay on disk; only T3's use of them ends.
        self.assertEqual(self.snapshot(codex), legacy_before)

    def test_migration_drops_empty_legacy_codex_settings(self):
        self.install_legacy_codex()
        self.assertEqual(self.invoke()[0], 0)
        after = self.settings()
        self.assertNotIn("providers", after)
        self.assertEqual(after["providerInstances"]["codex"], {"driver": "codex", "enabled": False})

    def test_preserves_unrelated_settings_and_codex_configuration_outside_the_legacy_home(self):
        existing = {"theme": "dark", "projects": [{"path": "/keep/project"}],
                    "providers": {"codex": {"homePath": "/user/codex"}, "cursor": {"x": 1}},
                    "providerInstances": {"codex": {"driver": "codex", "config": {"homePath": "/user/codex"}},
                                          "other": {"driver": "cursor", "enabled": True, "config": {"custom": 2}}}}
        self.write_settings(existing)
        self.assertEqual(self.invoke()[0], 0)
        after = self.settings()
        self.assertEqual(after["projects"], existing["projects"])
        self.assertEqual(after["theme"], "dark")
        self.assertEqual(after["providers"], existing["providers"])
        self.assertEqual(after["providerInstances"]["other"], existing["providerInstances"]["other"])
        self.assertEqual(after["providerInstances"]["codex"],
                         {"driver": "codex", "enabled": False, "config": {"homePath": "/user/codex"}})
        manifests = list((self.t3 / "backups").glob("*/manifest.json"))
        self.assertEqual(len(manifests), 1)
        mapping = json.loads(manifests[0].read_text())
        backup_name = next(name for name, original in mapping.items() if original == str(self.settings_path()))
        self.assertEqual(json.loads((manifests[0].parent / backup_name).read_text()), existing)
        self.assertEqual(stat.S_IMODE(manifests[0].parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((manifests[0].parent / backup_name).stat().st_mode), 0o600)

    def test_launch_arguments_keep_unrelated_flags_and_refuse_conflicts(self):
        self.write_settings({"providerInstances": {"claudeAgent": {"driver": "claudeAgent", "config": {
            "launchArgs": "--chrome --autocompact 300000", "homePath": "/custom/claude"}}}})
        self.assertEqual(self.invoke()[0], 0)
        config = self.settings()["providerInstances"]["claudeAgent"]["config"]
        self.assertEqual(config["launchArgs"], "--chrome --autocompact 300000 " + self.owned_args())
        self.assertEqual(config["homePath"], "/custom/claude")
        self.assertEqual(self.invoke("--check")[0], 0)

        settings = self.settings()
        settings["providerInstances"]["claudeAgent"]["config"]["launchArgs"] = "--add-dir /elsewhere"
        self.write_settings(settings)
        before = self.snapshot(self.root)
        code, _, errors = self.invoke()
        self.assertEqual(code, 2)
        self.assertIn("conflicting Claude launch argument --add-dir", errors)
        self.assertEqual(self.snapshot(self.root), before)

    def test_idempotent_install_and_read_only_check(self):
        before = self.snapshot(self.root)
        self.assertEqual(self.invoke("--check")[0], 1)
        self.assertEqual(self.snapshot(self.root), before)
        self.assertEqual(self.invoke()[0], 0)
        installed = self.snapshot(self.root)
        times = {str(path): path.lstat().st_mtime_ns for path in self.t3.rglob("*")}
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(self.invoke("--check")[0], 0)
        self.assertEqual(self.snapshot(self.root), installed)
        self.assertEqual({str(path): path.lstat().st_mtime_ns for path in self.t3.rglob("*")}, times)

    def test_linked_instructions_follow_source_edits_without_reinstalling(self):
        self.assertEqual(self.invoke()[0], 0)
        (self.checkout / "docs/t3-architect-instructions.md").write_text("# T3\nRevised routing.\n")
        self.assertEqual(self.invoke("--check")[0], 0)
        self.assertIn("Revised routing.", (self.profile / "instructions.md").read_text())

    def test_replaces_owned_copied_instructions_with_link_and_backs_up_copy(self):
        self.assertEqual(self.invoke()[0], 0)
        instructions = self.profile / "instructions.md"
        instructions.unlink()
        instructions.write_text("# copied by an earlier install\n")
        self.assertEqual(self.invoke("--check")[0], 1)
        self.assertEqual(self.invoke()[0], 0)
        self.assertTrue(instructions.is_symlink())
        manifest = next((self.t3 / "backups").glob("*/manifest.json"))
        mapping = json.loads(manifest.read_text())
        filename = next(key for key, value in mapping.items() if value == str(instructions))
        self.assertEqual((manifest.parent / filename).read_text(), "# copied by an earlier install\n")
        self.assertEqual(self.invoke("--check")[0], 0)

    def test_refuses_conflicting_instructions_link_without_mutation(self):
        self.assertEqual(self.invoke()[0], 0)
        instructions = self.profile / "instructions.md"
        instructions.unlink()
        instructions.symlink_to(self.root / "elsewhere.md")
        before = self.snapshot(self.root)
        code, _, errors = self.invoke()
        self.assertEqual(code, 2)
        self.assertIn("refusing conflicting link", errors)
        self.assertEqual(self.snapshot(self.root), before)

    def test_server_normalized_runtime_default_and_formatting_remain_idempotent(self):
        self.assertEqual(self.invoke()[0], 0)
        normalized = self.settings()
        normalized.pop("defaultRuntimeMode")
        # Mimic T3's omission of defaults and its independent JSON formatting.
        self.settings_path().write_text(json.dumps(normalized, sort_keys=True, separators=(",", ":")))
        before = self.snapshot(self.root)
        mtime = self.settings_path().stat().st_mtime_ns
        self.assertEqual(self.invoke("--check")[0], 0)
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(self.snapshot(self.root), before)
        self.assertEqual(self.settings_path().stat().st_mtime_ns, mtime)

        normalized["textGenerationModelSelection"]["instanceId"] = "codex"
        self.settings_path().write_text(json.dumps(normalized))
        reverted = self.settings_path().read_bytes()
        self.assertEqual(self.invoke("--check")[0], 1)
        self.assertEqual(self.settings_path().read_bytes(), reverted)
        self.assertEqual(self.invoke()[0], 0)
        self.assertEqual(self.settings()["textGenerationModelSelection"]["instanceId"], "claudeAgent")
        self.assertEqual(self.invoke("--check")[0], 0)

    def test_refuses_conflicting_links_and_skill_directories_without_mutation(self):
        for kind in ("symlink", "directory", "file"):
            with self.subTest(kind=kind):
                destination = self.profile / ".claude/skills" / installer.SKILLS[0]
                destination.parent.mkdir(parents=True, exist_ok=True)
                if kind == "symlink":
                    destination.symlink_to(self.root / "missing")
                elif kind == "directory":
                    destination.mkdir()
                else:
                    destination.write_text("unknown")
                before = self.snapshot(self.root)
                self.assertEqual(self.invoke()[0], 2)
                self.assertEqual(self.snapshot(self.root), before)
                if destination.is_dir() and not destination.is_symlink():
                    destination.rmdir()
                else:
                    destination.unlink()

    def test_refuses_settings_symlink_and_bad_json_without_mutation(self):
        userdata = self.t3 / "userdata"
        userdata.mkdir(parents=True)
        settings = userdata / "settings.json"
        settings.symlink_to(self.root / "outside")
        before = self.snapshot(self.root)
        self.assertEqual(self.invoke()[0], 2)
        self.assertEqual(self.snapshot(self.root), before)
        settings.unlink()
        settings.write_text('["not an object"]')
        before = self.snapshot(self.root)
        self.assertEqual(self.invoke()[0], 2)
        self.assertEqual(self.snapshot(self.root), before)

    def test_refuses_unsafe_profile_locations(self):
        before = self.snapshot(self.root)
        self.assertEqual(self.invoke("--t3-home", str(self.checkout / "state"))[0], 2)
        self.assertEqual(self.invoke("--profile", str(self.checkout / "profile"))[0], 2)
        self.assertEqual(self.invoke("--profile", str(self.home / ".claude/architect"))[0], 2)
        self.assertEqual(self.invoke("--profile", str(self.root / "profile with space"))[0], 2)
        self.assertEqual(self.snapshot(self.root), before)

    def test_refuses_unowned_profile_files_and_markers_without_mutation(self):
        self.profile.mkdir(parents=True)
        (self.profile / "instructions.md").write_text("unknown user-owned file\n")
        before = self.snapshot(self.root)
        code, _, errors = self.invoke()
        self.assertEqual(code, 2)
        self.assertIn("refusing unowned profile file", errors)
        self.assertEqual(self.snapshot(self.root), before)
        (self.profile / ".t3-openspec-architect.json").write_text('{"owner": "someone-else"}')
        before = self.snapshot(self.root)
        code, _, errors = self.invoke()
        self.assertEqual(code, 2)
        self.assertIn("refusing unknown ownership marker", errors)
        self.assertEqual(self.snapshot(self.root), before)

    def test_missing_claude_binary_fails_without_writing(self):
        self.binary.unlink()
        before = self.snapshot(self.root)
        code, _, errors = self.invoke()
        self.assertEqual(code, 2)
        self.assertIn("Claude Code executable missing", errors)
        self.assertEqual(self.snapshot(self.root), before)


class LaunchArgsTests(unittest.TestCase):
    owned = {"add-dir": "/p", "append-system-prompt-file": "/p/instructions.md"}
    result = "--add-dir /p --append-system-prompt-file /p/instructions.md"

    def test_appends_owned_flags_and_accepts_existing_owned_values(self):
        for existing in ("", self.result, "--add-dir=/p", "--append-system-prompt-file /p/instructions.md --add-dir /p"):
            with self.subTest(existing=existing):
                self.assertEqual(installer.launch_args(existing, self.owned), self.result)

    def test_preserves_quoted_unrelated_arguments(self):
        self.assertEqual(installer.launch_args("--name 'two words' --chrome", self.owned),
                         "--name 'two words' --chrome " + self.result)

    def test_refuses_conflicting_or_valueless_owned_flags(self):
        for existing in ("--add-dir /other", "--append-system-prompt-file=/x.md", "--add-dir --chrome"):
            with self.subTest(existing=existing):
                with self.assertRaises(installer.InstallError):
                    installer.launch_args(existing, self.owned)


if __name__ == "__main__":
    unittest.main()
