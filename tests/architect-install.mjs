#!/usr/bin/env node
// Paseo plugin contract, installer idempotence/rollback, and configuration
// scoping, using isolated fixture homes. Never touches the operator's real
// home, Paseo config, pi extensions, or worker configuration.

import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { architectCreateRequest, architectSessionOpenRequest, isArchitectProvider } from "../paseo-plugin/server/architect.ts";
import {
  ARCHITECT_EXTENSION_FILE,
  ARCHITECT_OWNER_ENV,
  ARCHITECT_PROFILE_ENV,
  ARCHITECT_PROVIDER_ID,
  ARCHITECT_PROVIDER_LABEL,
  applyArchitectPaseoConfig,
  architectProviderEntry,
  removeArchitectPaseoConfig,
} from "../workflow/architect-profile.mjs";
import {
  CONFIG_BACKUP_SUFFIX,
  DANGLING_EXTENSION_LINKS,
  INSTALL_MANIFEST_ENV,
  PLUGIN_MANIFEST_KEYS,
  install,
  installPaths,
  readPluginManifest,
  rollback,
  validatePluginManifest,
} from "../scripts/install-architect.mjs";
import { resolveWorkerLaunchPlan } from "../workflow/worker-launch.mjs";
import { tempDir } from "./support/architect-fixtures.mjs";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

// Fake `paseo` CLI with the real daemon's plugin semantics: a plugin is only
// `running` when it is installed, enabled, AND the daemon-wide `pluginsEnabled`
// switch is on, and the switch is read from the config file the installer wrote
// (the daemon reloads config.json without restarting). Scenario state lives in
// `<home>/fake-paseo-state.json`; `stuck: true` models a daemon that will not pick
// the switch up (a restart is then required).
function installFakePaseo({ home, log, stuck = false }) {
  const script = join(home, "fake-paseo.mjs");
  writeFileSync(join(home, "fake-paseo-state.json"), JSON.stringify({ installed: false, enabled: false, switchLive: false, stuck }, null, 2), "utf8");
  writeFileSync(
    script,
    `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.QQ_TEST_PASEO_HOME;
const args = process.argv.slice(2);
if (process.env.QQ_TEST_PASEO_LOG) appendFileSync(process.env.QQ_TEST_PASEO_LOG, args.join(" ") + "\\n", "utf8");
const statePath = join(home, "fake-paseo-state.json");
const read = () => JSON.parse(readFileSync(statePath, "utf8"));
const write = (value) => writeFileSync(statePath, JSON.stringify(value, null, 2), "utf8");
const configSwitchOn = () => {
  try { return JSON.parse(readFileSync(join(home, ".paseo", "config.json"), "utf8")).pluginsEnabled === true; }
  catch { return false; }
};
if (args[0] === "--version") { process.stdout.write("0.8.0\\n"); process.exit(0); }
if (args[0] === "plugin" && (args[1] === "install" || args[1] === "enable")) { const s = read(); s.installed = true; s.enabled = true; write(s); process.exit(0); }
if (args[0] === "plugin" && args[1] === "remove") { const s = read(); s.installed = false; s.enabled = false; write(s); process.exit(0); }
if (args[0] === "plugin" && args[1] === "ls") {
  const s = read();
  if (!s.installed) { process.stderr.write("Error: Plugin is not configured: " + (args[2] ?? "") + "\\n"); process.exit(1); }
  const status = s.enabled && s.switchLive === true ? "running" : "disabled";
  process.stdout.write(JSON.stringify([{ id: args[2] ?? "qq-architect", path: "/fake/paseo-plugin", enabled: s.enabled !== false, status }], null, 2) + "\\n");
  process.exit(0);
}
if (args[0] === "daemon" && args[1] === "reload") {
  const s = read();
  // A reload applies the switch from config.json — unless this scenario models a
  // daemon that will not pick it up without a restart.
  s.switchLive = !s.stuck && configSwitchOn();
  write(s);
  process.stdout.write(JSON.stringify({ appliedPaths: ["pluginsEnabled", "agents.providers.qq-architect"], restartRequiredPaths: [], overrideControlledPaths: [] }, null, 2) + "\\n");
  process.exit(0);
}
process.exit(0);
`,
    "utf8",
  );
  chmodSync(script, 0o755);
  process.env.QQ_TEST_PASEO_HOME = home;
  process.env.QQ_TEST_PASEO_LOG = log;
  return script;
}

// ---------------------------------------------------------------------------
// I1. The plugin binds identity only for the Architect provider.
// ---------------------------------------------------------------------------
assert.equal(isArchitectProvider(ARCHITECT_PROVIDER_ID), true);
assert.equal(isArchitectProvider("codex"), false);

const codexCreate = architectCreateRequest({
  config: { provider: "codex", systemPrompt: "user prompt", mcpServers: { search: { type: "http", url: "x" } }, model: "gpt-5.6-sol" },
  env: { KEEP: "1" },
});
assert.equal(codexCreate.config.systemPrompt, "user prompt", "an ordinary Codex agent keeps its configuration");
assert.deepEqual(codexCreate.config.mcpServers, { search: { type: "http", url: "x" } });
assert.deepEqual(codexCreate.env, { KEEP: "1" });

const architectCreate = architectCreateRequest({
  config: { provider: ARCHITECT_PROVIDER_ID, systemPrompt: "leaked layer", mcpServers: { search: { type: "http" } }, model: "gpt-5.6-sol", thinkingOptionId: "max" },
});
assert.equal(architectCreate.config.systemPrompt, "", "the Architect owns its prompt at runtime, so Paseo must not append one");
assert.deepEqual(architectCreate.config.mcpServers, {}, "no MCP server is a prerequisite for the Architect workflow tools");
assert.equal(architectCreate.config.model, "gpt-5.6-sol", "the operator's model selection is preserved");
assert.equal(architectCreate.config.thinkingOptionId, "max");

const sessionOpen = architectSessionOpenRequest({ agentId: "abc-123", provider: ARCHITECT_PROVIDER_ID, cwd: "/repo", reason: "create", env: { EXISTING: "yes" } });
assert.deepEqual(sessionOpen.env, {
  EXISTING: "yes",
  [ARCHITECT_PROFILE_ENV]: "1",
  QQ_WORKFLOW_SESSION_ID: "abc-123",
  [ARCHITECT_OWNER_ENV]: "abc-123",
  QQ_WORKFLOW_ROOT: "/repo",
});
const resume = architectSessionOpenRequest({ agentId: "abc-123", provider: ARCHITECT_PROVIDER_ID, cwd: "/repo", reason: "resume", env: {} });
assert.equal(resume.env.QQ_WORKFLOW_SESSION_ID, sessionOpen.env.QQ_WORKFLOW_SESSION_ID, "reopen/resume keeps the same workflow identity");
const otherOpen = architectSessionOpenRequest({ agentId: "codex-agent", provider: "codex", cwd: "/repo", env: {} });
assert.deepEqual(otherOpen.env, {}, "an ordinary Codex session is never bound to a workflow identity");
assert.throws(() => architectSessionOpenRequest({ agentId: "", provider: ARCHITECT_PROVIDER_ID, cwd: "/repo" }), /stable across reopen/);

// The plugin constants must match the profile module: a rename cannot split them.
const pluginSource = readFileSync(join(repoRoot, "paseo-plugin", "server", "architect.ts"), "utf8");
for (const constant of [ARCHITECT_PROVIDER_ID, ARCHITECT_PROFILE_ENV, ARCHITECT_OWNER_ENV]) {
  assert.ok(pluginSource.includes(`"${constant}"`), `plugin and profile agree on ${constant}`);
}
const manifest = JSON.parse(readFileSync(join(repoRoot, "paseo-plugin", "paseo-plugin.json"), "utf8"));
assert.equal(manifest.id, "qq-architect");
assert.equal(manifest.requirements.paseo, ">=0.8.0");
assert.ok(existsSync(join(repoRoot, "paseo-plugin", "index.server.ts")), "the plugin has a server entry for the daemon");

// I1b. The daemon parses this manifest with a STRICT schema: id + strict
// requirements + optional build, and nothing else. An extra friendly key (a
// `description`, say) makes `paseo plugin install` fail before anything runs, so
// the shape the daemon accepts is asserted here rather than discovered at install
// time. This mirrors @getpaseo/server plugins/manifest.js exactly.
const manifestCheck = readPluginManifest({ paths: { pluginDir: join(repoRoot, "paseo-plugin") } });
assert.equal(manifestCheck.status, "present", manifestCheck.errors.join("; "));
assert.deepEqual(Object.keys(manifest).sort(), [...PLUGIN_MANIFEST_KEYS].filter((key) => key in manifest).sort());
assert.equal(validatePluginManifest(manifest).ok, true, "the shipped manifest is accepted by the strict schema");
const described = validatePluginManifest({ ...manifest, description: "friendly text the strict schema rejects" });
assert.equal(described.ok, false, "an unrecognized key is rejected");
assert.match(described.errors.join(" "), /unrecognized key 'description'/);
assert.equal(validatePluginManifest({ id: "QQ Architect" }).ok, false, "the plugin id must match the daemon's id pattern");
assert.equal(validatePluginManifest({ id: "qq-architect", requirements: { paseo: ">=0.8.0", node: "20" } }).ok, false, "requirements are strict too");
assert.equal(validatePluginManifest({ id: "qq-architect", build: [["node", "-e", "1"]] }).ok, true);

// ---------------------------------------------------------------------------
// I2. Config merge/removal is surgical.
// ---------------------------------------------------------------------------
const baselineConfig = {
  version: 1,
  daemon: { listen: "0.0.0.0:6769", appendSystemPrompt: "operator text" },
  app: { baseUrl: "https://app.paseo.sh" },
  agents: { providers: { deepseek: { extends: "pi", label: "DeepSeek", models: [{ id: "deepseek/deepseek-flash", label: "Flash" }] }, codex: { enabled: true } } },
};
const merged = applyArchitectPaseoConfig(baselineConfig);
assert.deepEqual(merged.changes, ["provider-added", "profile-added"]);
assert.equal(merged.config.agents.providers.deepseek.label, "DeepSeek", "the worker provider entry is untouched");
assert.equal(merged.config.agents.providers[ARCHITECT_PROVIDER_ID].extends, "pi", "the Architect provider extends pi to keep model selection and pi auth");
assert.equal(merged.config.agents.providers[ARCHITECT_PROVIDER_ID].label, ARCHITECT_PROVIDER_LABEL);
assert.deepEqual(merged.config.agents.providers[ARCHITECT_PROVIDER_ID].command, architectProviderEntry().command);
assert.equal(merged.config.daemon.listen, "0.0.0.0:6769");
assert.equal(merged.config.daemon.appendSystemPrompt, "operator text");
assert.equal(merged.config.app.baseUrl, "https://app.paseo.sh");
const profile = merged.config.daemon.agentProfiles.find((entry) => entry.id === ARCHITECT_PROVIDER_ID);
assert.ok(profile, "the app shows an Architect profile");
assert.equal(profile.provider, ARCHITECT_PROVIDER_ID);
assert.equal(profile.model, undefined, "the app profile leaves model selection to the operator");
assert.match(profile.notes, /architecture/);
const mergedAgain = applyArchitectPaseoConfig(merged.config);
assert.deepEqual(mergedAgain.changes, [], "config application is idempotent");
const removed = removeArchitectPaseoConfig(merged.config);
assert.deepEqual(removed.removed, { provider: true, profile: true });
assert.equal(removed.config.agents.providers[ARCHITECT_PROVIDER_ID], undefined);
assert.deepEqual(removed.config.agents.providers.deepseek, baselineConfig.agents.providers.deepseek);
assert.equal(removed.config.daemon.appendSystemPrompt, "operator text");

// ---------------------------------------------------------------------------
// I3. Installer on an isolated fixture home: only the confirmed dangling links
//     are removed, unrelated configuration is preserved, and reruns are no-ops.
// ---------------------------------------------------------------------------
const home = tempDir("qq-architect-home-");
const fixtureExtensions = join(home, ".pi", "agent", "extensions");
mkdirSync(fixtureExtensions, { recursive: true });
mkdirSync(join(home, ".paseo"), { recursive: true });

// Two dangling links (the confirmed obsolete entries) and two links that must survive.
const danglingTargets = { qq: "/home/qqp/projects/qq", subagent: "/home/qqp/projects/pi-subagents" };
for (const [name, target] of Object.entries(danglingTargets)) {
  execFileSync("ln", ["-s", target, join(fixtureExtensions, name)]);
}
const liveTarget = join(home, "live-extension");
mkdirSync(liveTarget, { recursive: true });
execFileSync("ln", ["-s", liveTarget, join(fixtureExtensions, "orca-agent-status.ts")]);
const plainFile = join(fixtureExtensions, "manual-extension.mjs");
writeFileSync(plainFile, "// operator-managed extension\n", "utf8");
const credentials = join(home, ".pi", "agent", "auth.json");
writeFileSync(credentials, '{"secret":"operator-credential"}\n', "utf8");

// A missing link is not an error either.
const configPath = join(home, ".paseo", "config.json");
writeFileSync(configPath, `${JSON.stringify(baselineConfig, null, 2)}\n`, "utf8");

const manifestEnv = { [INSTALL_MANIFEST_ENV]: join(home, "install-manifest.json") };
const fakePaseoLog = join(home, "paseo-calls.log");
const fakePaseo = installFakePaseo({ home, log: fakePaseoLog });

const report = install({ home, repoRoot, env: manifestEnv, paseoBin: fakePaseo });
const statuses = Object.fromEntries(report.extensionLinks.map((entry) => [entry.name, entry.status]));
assert.equal(statuses.qq, "removed");
assert.equal(statuses.subagent, "removed");
assert.deepEqual(report.extensionLinks.map((entry) => entry.name), DANGLING_EXTENSION_LINKS, "only the confirmed entries are considered");
assert.equal(existsSync(join(fixtureExtensions, "qq")), false);
assert.equal(existsSync(join(fixtureExtensions, "subagent")), false);
assert.equal(lstatSync(join(fixtureExtensions, "orca-agent-status.ts")).isSymbolicLink(), true, "a live extension link is preserved");
assert.equal(readlinkSync(join(fixtureExtensions, "orca-agent-status.ts")), liveTarget);
assert.ok(existsSync(plainFile), "an operator extension file is preserved");
assert.equal(readFileSync(credentials, "utf8"), '{"secret":"operator-credential"}\n', "credentials are never touched");
assert.equal(report.extensionFile.status, "present");
assert.equal(report.paseoConfig.status, "installed");
assert.deepEqual(report.paseoConfig.changes, ["provider-added", "profile-added", "plugins-enabled"]);
assert.ok(existsSync(`${configPath}${CONFIG_BACKUP_SUFFIX}`), "a pre-install config backup exists for rollback");
const installedConfig = JSON.parse(readFileSync(configPath, "utf8"));
assert.equal(installedConfig.agents.providers[ARCHITECT_PROVIDER_ID].extends, "pi");
assert.deepEqual(installedConfig.agents.providers.deepseek, baselineConfig.agents.providers.deepseek);
assert.equal(installedConfig.daemon.appendSystemPrompt, "operator text");
assert.equal(installedConfig.pluginsEnabled, true, "a plugin cannot run while the daemon-wide switch is off, so the installer sets it");
assert.equal(report.plugin.status, "installed", "the plugin is verified as running, not merely installed");
assert.equal(report.plugin.pluginStatus, "running");
assert.equal(report.plugin.verified, true);
assert.equal(report.plugin.enable.ok, true);
assert.equal(report.plugin.activation.status, "reloaded", "the daemon is asked to reload config.json (no restart) so the plugin can start");
assert.deepEqual(report.plugin.activation.appliedPaths, ["pluginsEnabled", "agents.providers.qq-architect"]);
const pluginCalls = readFileSync(fakePaseoLog, "utf8").trim().split("\n");
assert.ok(pluginCalls.some((line) => line === `plugin install ${join(repoRoot, "paseo-plugin")} --id ${ARCHITECT_PROVIDER_ID}`), "the plugin is installed through the supported CLI path");
assert.ok(pluginCalls.some((line) => line === `plugin enable ${ARCHITECT_PROVIDER_ID}`), "the plugin is explicitly enabled");
assert.ok(pluginCalls.some((line) => line === `plugin ls ${ARCHITECT_PROVIDER_ID} --json`), "the install is verified");
assert.ok(pluginCalls.some((line) => line === "daemon reload --json"), "the daemon reload is what activates the global switch without a restart");
assert.ok(existsSync(join(home, "install-manifest.json")), "the install writes a manifest for rollback");
const manifestJson = JSON.parse(readFileSync(join(home, "install-manifest.json"), "utf8"));
assert.deepEqual(manifestJson.removedExtensionLinks, DANGLING_EXTENSION_LINKS.map((name) => join(fixtureExtensions, name)));
assert.equal(manifestJson.providerId, ARCHITECT_PROVIDER_ID);
assert.equal(manifestJson.pluginsEnabled, true);
assert.equal(manifestJson.requiredAction, null);

// Idempotence: a second install changes nothing and removes nothing else.
const configAfterFirst = readFileSync(configPath, "utf8");
const secondReport = install({ home, repoRoot, env: manifestEnv, paseoBin: fakePaseo });
assert.deepEqual(secondReport.extensionLinks.map((entry) => entry.status), ["absent", "absent"]);
assert.equal(secondReport.paseoConfig.status, "already-installed");
assert.deepEqual(secondReport.paseoConfig.changes, []);
assert.equal(readFileSync(configPath, "utf8"), configAfterFirst, "a rerun does not rewrite the config");
assert.equal(secondReport.plugin.status, "installed", "a rerun re-verifies the running plugin");
assert.equal(secondReport.plugin.activation.status, "not-needed", "an already-running plugin needs no reload");
const callsAfterFirst = pluginCalls.length;
const secondCalls = readFileSync(fakePaseoLog, "utf8").trim().split("\n").slice(callsAfterFirst);
assert.ok(secondCalls.some((line) => line === `plugin install ${join(repoRoot, "paseo-plugin")} --id ${ARCHITECT_PROVIDER_ID}`), "the plugin install stays idempotent");
assert.equal(secondCalls.includes("daemon reload --json"), false, "a rerun does not reload the daemon for nothing");
assert.ok(existsSync(join(fixtureExtensions, "orca-agent-status.ts")));
assert.ok(existsSync(plainFile));

// Dry run reports without changing anything (fresh fixture home).
const dryHome = tempDir("qq-architect-dry-");
mkdirSync(join(dryHome, ".paseo"), { recursive: true });
writeFileSync(join(dryHome, ".paseo", "config.json"), `${JSON.stringify(baselineConfig, null, 2)}\n`, "utf8");
const dryRun = install({ home: dryHome, repoRoot, env: { [INSTALL_MANIFEST_ENV]: join(dryHome, "manifest.json") }, dryRun: true, paseoBin: fakePaseo });
assert.equal(dryRun.paseoConfig.status, "dry-run");
assert.deepEqual(dryRun.extensionLinks.map((entry) => entry.status), ["dry-run", "dry-run"]);
assert.equal(dryRun.plugin.status, "dry-run");
assert.deepEqual(JSON.parse(readFileSync(join(dryHome, ".paseo", "config.json"), "utf8")), baselineConfig, "a dry run changes nothing");
assert.equal(existsSync(join(dryHome, "manifest.json")), false);
assert.equal(install({ home, repoRoot, env: manifestEnv, dryRun: true, paseoBin: fakePaseo }).paseoConfig.status, "already-installed");

// Worker pins are never written by the installer.
const workerConfigPath = join(home, ".config", "qq-workflows", "worker-config.json");
const pins = { provider: "deepseek", model: "deepseek-flash", base_url: "https://api.deepseek.com", wire_api: "responses", reasoning_effort: "max", harness: "deepseek-minimal" };
mkdirSync(join(home, ".config", "qq-workflows"), { recursive: true });
writeFileSync(workerConfigPath, JSON.stringify(pins, null, 2), "utf8");
const pinsBefore = readFileSync(workerConfigPath, "utf8");
install({ home, repoRoot, env: manifestEnv, paseoBin: fakePaseo });
assert.equal(readFileSync(workerConfigPath, "utf8"), pinsBefore, "the installer never writes worker pins");
const planThroughInstalls = resolveWorkerLaunchPlan({ role: "runner", env: { QQ_WORKER_CONFIG_FILE: workerConfigPath } });
assert.equal(planThroughInstalls.provider, "deepseek");
assert.equal(planThroughInstalls.model, "deepseek-flash");
assert.equal(planThroughInstalls.reasoning_effort, "max");
assert.equal(planThroughInstalls.harness, "deepseek-minimal");

// Rollback restores the pre-install config and removes the plugin.
const rollbackReport = rollback({ home, repoRoot, env: manifestEnv, paseoBin: fakePaseo });
assert.equal(rollbackReport.config.status, "restored");
assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), baselineConfig, "rollback restores the operator's config exactly");
assert.match(rollbackReport.pluginsEnabled, /restored from the pre-install backup/);
assert.equal(rollbackReport.plugin.status, "removed");
assert.equal(rollbackReport.manifest.status, "removed");
assert.match(rollbackReport.note, /NOT recreated/);
assert.ok(!existsSync(join(home, "install-manifest.json")));
const rollbackCalls = readFileSync(fakePaseoLog, "utf8").trim().split("\n");
assert.ok(rollbackCalls.some((line) => line === `plugin remove ${ARCHITECT_PROVIDER_ID}`));

// ---------------------------------------------------------------------------
// I4. Truthful reporting when the Paseo CLI is unavailable or absent.
// ---------------------------------------------------------------------------
const noCliHome = tempDir("qq-architect-nocli-");
mkdirSync(join(noCliHome, ".paseo"), { recursive: true });
writeFileSync(join(noCliHome, ".paseo", "config.json"), `${JSON.stringify(baselineConfig, null, 2)}\n`, "utf8");
const noCli = install({ home: noCliHome, repoRoot, env: { [INSTALL_MANIFEST_ENV]: join(noCliHome, "manifest.json") }, paseoBin: join(noCliHome, "missing-paseo") });
assert.equal(noCli.plugin.status, "skipped-no-cli");
assert.match(noCli.plugin.reason, /missing-paseo|ENOENT/);
assert.equal(noCli.plugin.command[0], join(noCliHome, "missing-paseo"));
assert.equal(noCli.paseoConfig.status, "installed", "the rest of the install still proceeds");
assert.equal(existsSync(join(noCliHome, ".paseo", "config.json")), true);

// ---------------------------------------------------------------------------
// I4b. A plugin that cannot reach `running` is reported, not assumed: the failing
//      prerequisite (the daemon did not apply the global switch) is named and the
//      operator action is stated instead of claiming a working install.
// ---------------------------------------------------------------------------
const stuckHome = tempDir("qq-architect-stuck-");
const stuckExtensions = join(stuckHome, ".pi", "agent", "extensions");
mkdirSync(stuckExtensions, { recursive: true });
mkdirSync(join(stuckHome, ".paseo"), { recursive: true });
writeFileSync(join(stuckHome, ".paseo", "config.json"), `${JSON.stringify(baselineConfig, null, 2)}\n`, "utf8");
const stuckLog = join(stuckHome, "paseo-calls.log");
const stuckPaseo = installFakePaseo({ home: stuckHome, log: stuckLog, stuck: true });
const stuckReport = install({ home: stuckHome, repoRoot, env: { [INSTALL_MANIFEST_ENV]: join(stuckHome, "manifest.json") }, paseoBin: stuckPaseo });
assert.equal(stuckReport.paseoConfig.status, "installed");
assert.equal(JSON.parse(readFileSync(join(stuckHome, ".paseo", "config.json"), "utf8")).pluginsEnabled, true, "the switch is still written deliberately");
assert.equal(stuckReport.plugin.status, "installed-not-running");
assert.equal(stuckReport.plugin.verified, false);
assert.equal(stuckReport.plugin.pluginStatus, "disabled");
assert.equal(stuckReport.plugin.activation.status, "reloaded", "the non-restarting activation is attempted first");
assert.match(stuckReport.plugin.requiredAction, /logs qq-architect|daemon restart/);
assert.equal(stuckReport.manifest.requiredAction, stuckReport.plugin.requiredAction, "the manifest carries the operator action");
assert.ok(readFileSync(stuckLog, "utf8").includes("plugin enable qq-architect"));

// ---------------------------------------------------------------------------
// I5. The plugin manifest is validated before the CLI trusts the directory, so a
//     strict-schema rejection surfaces as a clear installer report and never as a
//     half-done install.
// ---------------------------------------------------------------------------
const badRepo = tempDir("qq-architect-badmanifest-");
cpSync(join(repoRoot, "paseo-plugin"), join(badRepo, "paseo-plugin"), { recursive: true });
cpSync(join(repoRoot, "pi-extension"), join(badRepo, "pi-extension"), { recursive: true });
const badManifest = JSON.parse(readFileSync(join(badRepo, "paseo-plugin", "paseo-plugin.json"), "utf8"));
badManifest.description = "friendly text the strict daemon schema rejects";
writeFileSync(join(badRepo, "paseo-plugin", "paseo-plugin.json"), `${JSON.stringify(badManifest, null, 2)}\n`, "utf8");
assert.equal(readPluginManifest({ paths: { pluginDir: join(badRepo, "paseo-plugin") } }).status, "invalid");

const badHome = tempDir("qq-architect-badhome-");
mkdirSync(join(badHome, ".paseo"), { recursive: true });
writeFileSync(join(badHome, ".paseo", "config.json"), `${JSON.stringify(baselineConfig, null, 2)}\n`, "utf8");
const badLog = join(badHome, "paseo-calls.log");
const badPaseo = installFakePaseo({ home: badHome, log: badLog });
const badReport = install({ home: badHome, repoRoot: badRepo, env: { [INSTALL_MANIFEST_ENV]: join(badHome, "manifest.json") }, paseoBin: badPaseo });
assert.equal(badReport.pluginManifest.status, "invalid");
assert.match(badReport.pluginManifest.errors.join(" "), /unrecognized key 'description'/);
assert.equal(badReport.plugin.status, "invalid-manifest");
assert.match(badReport.plugin.reason, /unrecognized key 'description'/);
assert.equal(existsSync(badLog) ? readFileSync(badLog, "utf8").includes("plugin install") : false, false, "an invalid manifest never reaches 'paseo plugin install'");
assert.equal(JSON.parse(readFileSync(join(badHome, ".paseo", "config.json"), "utf8")).pluginsEnabled, undefined, "the global switch is not turned on for a plugin that cannot be installed");
assert.equal(badReport.paseoConfig.changes.includes("provider-added"), true, "the provider entry is still installed");

// `--skip-plugin` installs only the provider/profile: the daemon-wide plugin
// switch is not touched when no plugin is being installed for it.
const skipHome = tempDir("qq-architect-skipplugin-");
mkdirSync(join(skipHome, ".paseo"), { recursive: true });
writeFileSync(join(skipHome, ".paseo", "config.json"), `${JSON.stringify(baselineConfig, null, 2)}\n`, "utf8");
const skipped = install({ home: skipHome, repoRoot, env: { [INSTALL_MANIFEST_ENV]: join(skipHome, "manifest.json") }, skipPlugin: true });
assert.equal(skipped.plugin.status, "skipped-by-flag");
assert.deepEqual(skipped.paseoConfig.changes, ["provider-added", "profile-added"]);
assert.equal(JSON.parse(readFileSync(join(skipHome, ".paseo", "config.json"), "utf8")).pluginsEnabled, undefined, "no plugin installed means no global switch change");

// A home with no Paseo config is left alone rather than invented.
const bareHome = tempDir("qq-architect-bare-");
const bare = install({ home: bareHome, repoRoot, env: { [INSTALL_MANIFEST_ENV]: join(bareHome, "manifest.json") }, skipPlugin: true });
assert.equal(bare.paseoConfig.status, "skipped-no-config");
assert.equal(existsSync(join(bareHome, ".paseo", "config.json")), false, "a missing Paseo config is never fabricated");
assert.equal(installPaths({ home: bareHome }).repoRoot, bareHome === home ? repoRoot : installPaths({ home: bareHome }).repoRoot);
assert.equal(installPaths({ home }).pluginDir, join(repoRoot, "paseo-plugin"));
assert.equal(installPaths({ home }).extensionFile, ARCHITECT_EXTENSION_FILE);
assert.equal(readdirSync(fixtureExtensions).includes("qq"), false);
assert.ok(existsSync(join(repoRoot, "scripts", "install-architect.mjs")), "the installer is a supported entry point");

console.log("architect paseo plugin and installer tests passed");
