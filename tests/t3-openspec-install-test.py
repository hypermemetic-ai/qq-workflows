#!/usr/bin/env python3
"""Installer behavior tests use private fixtures and never touch live homes."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import tomllib
import unittest


SPEC = importlib.util.spec_from_file_location(
    "installer", Path(__file__).resolve().parent.parent / "scripts/install-t3-openspec.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="t3-openspec-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.checkout = self.root / "checkout with spaces"
        self.source = self.root / "source-codex"
        self.t3 = self.root / "t3"
        self.profile = self.t3 / "codex"
        self.binary = self.root / "codex"
        self.binary.write_text("#!/bin/sh\nexit 0\n")
        self.binary.chmod(0o700)
        self.source.mkdir()
        (self.source / "auth.json").write_text('{"fixture":"credential-never-printed"}\n')
        (self.source / "AGENTS.md").write_text("# User instructions\nKeep local agreements.\n")
        (self.source / "worker.toml").write_text('model = "existing-worker-model"\n')
        (self.source / "skills/.system").mkdir(parents=True)
        (self.source / "sessions").mkdir()
        (self.source / "sessions/untouched").write_text("session")
        for skill in installer.SKILLS:
            directory = self.checkout / "vendor/openspec/skills" / skill
            directory.mkdir(parents=True)
            (directory / "SKILL.md").write_text(f"# {skill}\nfixture\n")
        custom = self.checkout / "skills" / installer.CUSTOM_SKILL
        custom.mkdir(parents=True)
        (custom / "SKILL.md").write_text("# Architect\n")
        (self.checkout / "docs").mkdir()
        (self.checkout / "docs/t3-codex-instructions.md").write_text("# T3\nParent plans; assigned workers implement.\n")
        self.config = '''# Preserve this top-level comment.
model = "existing-model"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
model_reasoning_effort = "high"
note = """a multiline value
[not-a-table]
approval_policy = 'keep inside string'"""

[features]
multi_agent = false
other_feature = true

[mcp_servers.existing]
command = "keep-me"
args = [
  "one", # keep this comment too
  "two",
]
env = { KEEP = "unchanged" }

[agents]
enabled = false
max_concurrent_threads_per_session = 2
other = "preserved"
[agents.worker]
description = "keep this worker"
config_file = "./worker.toml"
'''
        (self.source / "config.toml").write_text(self.config)

    def argv(self):
        return ["--source-checkout", str(self.checkout), "--source-codex-home", str(self.source),
                "--t3-home", str(self.t3), "--codex-binary", str(self.binary)]

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

    def settings(self):
        return json.loads((self.t3 / "userdata/settings.json").read_text())

    def test_isolated_profile_preserves_sources_and_unrelated_configuration(self):
        source_before = self.snapshot(self.source)
        checkout_before = self.snapshot(self.checkout)
        code, output, error = self.invoke()
        self.assertEqual((code, error), (0, ""))
        self.assertNotIn("credential-never-printed", output)
        desired = tomllib.loads(self.config)
        desired.update(approval_policy="never", sandbox_mode="danger-full-access")
        desired["features"]["multi_agent"] = True
        desired["agents"].update(enabled=True, max_concurrent_threads_per_session=5)
        desired["agents"]["worker"]["config_file"] = str(self.source / "worker.toml")
        self.assertEqual(tomllib.loads((self.profile / "config.toml").read_text()), desired)
        self.assertIn("# Preserve this top-level comment.", (self.profile / "config.toml").read_text())
        self.assertIn('"two",', (self.profile / "config.toml").read_text())
        self.assertEqual(self.snapshot(self.source), source_before)
        self.assertEqual(self.snapshot(self.checkout), checkout_before)
        self.assertFalse((self.profile / "sessions").exists())
        self.assertEqual(os.readlink(self.profile / "auth.json"), str(self.source / "auth.json"))
        for skill in installer.SKILLS:
            self.assertEqual((self.profile / "skills" / skill).resolve(),
                             (self.checkout / "vendor/openspec/skills" / skill).resolve())
        self.assertTrue((self.profile / "skills/.system").is_symlink())
        agents = (self.profile / "AGENTS.md").read_text()
        self.assertIn("Keep local agreements.", agents)
        self.assertIn("Parent plans; assigned workers implement.", agents)
        settings = self.settings()
        self.assertEqual(settings["defaultRuntimeMode"], "full-access")
        self.assertEqual(settings["defaultThreadEnvMode"], "worktree")
        self.assertEqual(settings["providers"]["codex"]["homePath"], str(self.profile))
        self.assertEqual(settings["providerInstances"]["codex"]["config"]["homePath"], str(self.profile))
        self.assertEqual(settings["providerInstances"]["codex"]["displayName"], "OpenSpec Architect")

    def test_preserves_settings_providers_projects_environment_and_existing_config(self):
        (self.t3 / "userdata").mkdir(parents=True)
        existing = {"theme": "dark", "projects": [{"path": "/keep/project"}],
                    "providers": {"codex": {"launchArgs": ["--existing-flag"], "env": {"KEY": "keep"}},
                                  "claude": {"homePath": "/claude"}},
                    "providerInstances": {"codex": {"config": {"launchArgs": ["--also-keep"], "env": {"KEEP": "yes"}}},
                                          "other": {"driver": "claude", "enabled": True, "config": {"custom": 2}}}}
        path = self.t3 / "userdata/settings.json"
        path.write_text(json.dumps(existing))
        self.assertEqual(self.invoke()[0], 0)
        after = self.settings()
        self.assertEqual(after["projects"], existing["projects"])
        self.assertEqual(after["theme"], "dark")
        self.assertEqual(after["providers"]["claude"], existing["providers"]["claude"])
        self.assertEqual(after["providerInstances"]["other"], existing["providerInstances"]["other"])
        self.assertEqual(after["providers"]["codex"]["launchArgs"], ["--existing-flag"])
        self.assertEqual(after["providerInstances"]["codex"]["config"]["env"], {"KEEP": "yes"})
        manifests = list((self.t3 / "backups").glob("*/manifest.json"))
        self.assertEqual(len(manifests), 1)
        mapping = json.loads(manifests[0].read_text())
        backup_name = next(name for name, original in mapping.items() if original == str(path))
        self.assertEqual(json.loads((manifests[0].parent / backup_name).read_text()), existing)
        self.assertEqual(stat.S_IMODE(manifests[0].parent.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((manifests[0].parent / backup_name).stat().st_mode), 0o600)

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

    def test_updates_owned_profile_and_backs_up_old_files(self):
        self.assertEqual(self.invoke()[0], 0)
        old = (self.profile / "config.toml").read_bytes()
        (self.source / "config.toml").write_text(self.config.replace('"existing-model"', '"updated-model"'))
        self.assertEqual(self.invoke("--check")[0], 1)
        self.assertEqual(self.invoke()[0], 0)
        manifest = next((self.t3 / "backups").glob("*/manifest.json"))
        mapping = json.loads(manifest.read_text())
        filename = next(key for key, value in mapping.items() if value == str(self.profile / "config.toml"))
        self.assertEqual((manifest.parent / filename).read_bytes(), old)
        self.assertEqual(tomllib.loads((self.profile / "config.toml").read_text())["model"], "updated-model")

    def test_refuses_conflicting_links_and_skill_directories_without_mutation(self):
        for kind in ("symlink", "directory", "file"):
            with self.subTest(kind=kind):
                destination = self.profile / "skills" / installer.SKILLS[0]
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

    def test_refuses_source_home_overlap_and_checkout_backups(self):
        before = self.snapshot(self.root)
        self.assertEqual(self.invoke("--codex-home", str(self.source))[0], 2)
        self.assertEqual(self.invoke("--codex-home", str(self.source / "child"))[0], 2)
        self.assertEqual(self.invoke("--t3-home", str(self.checkout / "state"))[0], 2)
        self.assertEqual(self.invoke("--codex-home", str(self.checkout / "profile"))[0], 2)
        self.assertEqual(self.invoke("--t3-home", str(self.source), "--codex-home", str(self.root / "profile"))[0], 2)
        self.assertEqual(self.snapshot(self.root), before)

    def test_handles_absent_config_agents_and_system_skills(self):
        (self.source / "config.toml").unlink()
        (self.source / "AGENTS.md").unlink()
        (self.source / "skills/.system").rmdir()
        self.assertEqual(self.invoke()[0], 0)
        self.assertFalse((self.profile / "skills/.system").exists())
        self.assertEqual(tomllib.loads((self.profile / "config.toml").read_text())["agents"]["enabled"], True)

    def test_missing_auth_fails_without_disclosing_credentials_or_writing(self):
        (self.source / "auth.json").unlink()
        before = self.snapshot(self.root)
        code, output, errors = self.invoke()
        self.assertEqual(code, 2)
        self.assertIn("sign in", errors)
        self.assertEqual(self.snapshot(self.root), before)

    def test_custom_agent_role_uses_original_resolved_configuration(self):
        before = self.snapshot(self.source)
        self.assertEqual(self.invoke()[0], 0)
        copied = tomllib.loads((self.profile / "config.toml").read_text())
        dependency = Path(copied["agents"]["worker"]["config_file"])
        self.assertTrue(dependency.is_absolute())
        self.assertEqual(dependency.resolve(), (self.source / "worker.toml").resolve())
        self.assertEqual(tomllib.loads(dependency.read_text())["model"], "existing-worker-model")
        self.assertFalse((self.profile / "worker.toml").exists())
        self.assertEqual(self.snapshot(self.source), before)
        (self.source / "worker.toml").unlink()
        installed = self.snapshot(self.root)
        code, _, errors = self.invoke()
        self.assertEqual(code, 2)
        self.assertIn("missing agent configuration dependency", errors)
        self.assertEqual(self.snapshot(self.root), installed)

    def test_refuses_unowned_existing_profile_files_without_mutation(self):
        self.profile.mkdir(parents=True)
        for filename in ("config.toml", "AGENTS.md"):
            with self.subTest(filename=filename):
                path = self.profile / filename
                path.write_text("unknown user-owned file\n")
                before = self.snapshot(self.root)
                code, _, errors = self.invoke()
                self.assertEqual(code, 2)
                self.assertIn("refusing unowned profile file", errors)
                self.assertEqual(self.snapshot(self.root), before)
                path.unlink()


class TomlUpdateTests(unittest.TestCase):
    def test_inline_dotted_quoted_nested_arrays_and_multiline_values(self):
        temporary = tempfile.TemporaryDirectory(prefix="t3-openspec-role-")
        self.addCleanup(temporary.cleanup)
        source_home = Path(temporary.name)
        (source_home / "worker.toml").write_text('model = "existing"\n')
        examples = [
            '''"features" = { multi_agent = false, custom = { nested = [1, 2] } }
agents = { enabled = false, worker = { config_file = "worker.toml" } }
[model_providers.test]
name = "keep"
''',
            '''features.multi_agent = false
features.other = true
agents.enabled = false
agents.max_concurrent_threads_per_session = 7
model = "keep"
''',
            '''[features.nested]
value = ["a", "b"]
[[agents.roles]]
name = "one"
[[agents.roles]]
name = "two"
[other]
date = 1979-05-27T07:32:00Z
''',
            '''approval_policy = ''' + "'''on-request'''" + '''
sandbox_mode = """workspace-write"""
note = """kept quote: """"
["features"]
"multi_agent" = false
other = ''' + "'''multi\nline'''" + '''
[agents]
enabled = false
''',
        ]
        for source in examples:
            with self.subTest(source=source[:60]):
                original = tomllib.loads(source)
                expected = copy.deepcopy(original)
                expected.update(approval_policy="never", sandbox_mode="danger-full-access")
                expected.setdefault("features", {})["multi_agent"] = True
                expected.setdefault("agents", {}).update(enabled=True,
                    max_concurrent_threads_per_session=max(5, original.get("agents", {}).get("max_concurrent_threads_per_session", 5)))
                if "worker" in expected["agents"]:
                    expected["agents"]["worker"]["config_file"] = str(source_home / "worker.toml")
                self.assertEqual(tomllib.loads(installer.profile_config(source, source_home)), expected)

    def test_rejects_invalid_source_toml_and_non_table_features(self):
        for source in ('model = "one"\nmodel = "two"\n', 'features = false\n', 'agents = "bad"\n'):
            with self.subTest(source=source):
                with self.assertRaises((ValueError, installer.InstallError)):
                    installer.profile_config(source)


if __name__ == "__main__":
    unittest.main()
