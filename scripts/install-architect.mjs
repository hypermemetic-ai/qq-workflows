#!/usr/bin/env node
// Installer for the Paseo-selectable qq-workflows Architect.
//
// Scope discipline:
//   - It removes exactly the two confirmed dangling pi extension entries
//     (`qq`, `subagent`) and only while they are dangling symlinks. Targets,
//     unrelated extensions, unrelated config, and credentials are never touched.
//   - It adds/updates one provider entry and one agent profile in the Paseo
//     daemon config, preserving every other key, and keeps a backup for
//     rollback.
//   - It installs the Paseo plugin through the supported `paseo plugin install`
//     path, enables it explicitly, verifies the resulting plugin status, and
//     reports truthfully when that CLI is unavailable or the plugin cannot run;
//   - it turns the daemon-wide plugin switch on (`pluginsEnabled: true`) because
//     that switch is required for any plugin to start. The pre-install backup
//     restores the previous value on rollback.
//   - Worker provider/model/harness/effort pins are never written or changed.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ARCHITECT_PROVIDER_ID,
  applyArchitectPaseoConfig,
  removeArchitectPaseoConfig,
} from "../workflow/architect-profile.mjs";

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DANGLING_EXTENSION_LINKS = ["qq", "subagent"];
export const INSTALL_MANIFEST_ENV = "QQ_ARCHITECT_INSTALL_MANIFEST";
export const CONFIG_BACKUP_SUFFIX = ".qq-architect.bak";

// The daemon parses paseo-plugin.json with a STRICT schema
// (@getpaseo/server .../plugins/manifest.js):
//   { id: /^[a-z][a-z0-9-]*$/, requirements?: { paseo?: string } (strict), build?: string[][] }
// An unrecognized key (for example a friendly `description`) makes
// `paseo plugin install` fail before anything else runs, so the shape is
// validated here first and the strict allowed-key set is mirrored exactly.
export const PLUGIN_MANIFEST_KEYS = ["id", "requirements", "build"];
export const PLUGIN_REQUIREMENT_KEYS = ["paseo"];
export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function validatePluginManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: ["manifest must be a JSON object"] };
  }
  for (const key of Object.keys(manifest)) {
    if (!PLUGIN_MANIFEST_KEYS.includes(key)) errors.push(`unrecognized key '${key}' (strict schema allows: ${PLUGIN_MANIFEST_KEYS.join(", ")})`);
  }
  if (typeof manifest.id !== "string" || !PLUGIN_ID_PATTERN.test(manifest.id)) {
    errors.push(`'id' must match ${String(PLUGIN_ID_PATTERN)}`);
  }
  if (manifest.requirements !== undefined) {
    if (!manifest.requirements || typeof manifest.requirements !== "object" || Array.isArray(manifest.requirements)) {
      errors.push("'requirements' must be an object");
    } else {
      for (const key of Object.keys(manifest.requirements)) {
        if (!PLUGIN_REQUIREMENT_KEYS.includes(key)) errors.push(`unrecognized key 'requirements.${key}' (strict schema allows: ${PLUGIN_REQUIREMENT_KEYS.join(", ")})`);
      }
      if (manifest.requirements.paseo !== undefined && typeof manifest.requirements.paseo !== "string") {
        errors.push("'requirements.paseo' must be a string");
      }
    }
  }
  if (manifest.build !== undefined) {
    const commands = Array.isArray(manifest.build) ? manifest.build : null;
    if (!commands || commands.length === 0) errors.push("'build' must be a non-empty array of argument arrays");
    else if (!commands.every((command) => Array.isArray(command) && command.length > 0 && command.every((arg) => typeof arg === "string" && arg.trim().length > 0))) {
      errors.push("'build' entries must be non-empty arrays of non-empty strings");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function readPluginManifest({ paths } = {}) {
  const path = join(paths.pluginDir, "paseo-plugin.json");
  if (!existsSync(path)) return { status: "missing", path, errors: ["paseo-plugin.json is missing"] };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { status: "invalid", path, errors: [`paseo-plugin.json is not valid JSON: ${err.message}`] };
  }
  const validation = validatePluginManifest(parsed);
  if (!validation.ok) return { status: "invalid", path, errors: validation.errors, manifest: parsed };
  return { status: "present", path, errors: [], manifest: parsed };
}

export function installPaths({ home = homedir(), repoRoot = REPO_ROOT, env = process.env } = {}) {
  const extensionsDir = join(home, ".pi", "agent", "extensions");
  const paseoConfig = join(home, ".paseo", "config.json");
  return {
    home,
    repoRoot,
    extensionsDir,
    paseoConfig,
    backupPath: `${paseoConfig}${CONFIG_BACKUP_SUFFIX}`,
    manifestPath: env?.[INSTALL_MANIFEST_ENV] || join(home, ".config", "qq-workflows", "architect-install.json"),
    pluginDir: join(repoRoot, "paseo-plugin"),
    extensionFile: join(repoRoot, "pi-extension", "qq-architect.mjs"),
  };
}

function readJson(path, { fallback = null } = {}) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return fallback;
    throw new Error(`${path} is not valid JSON: ${err.message}`);
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

// ---------------------------------------------------------------------------
// Step 1: remove ONLY the two confirmed dangling pi extension entries.
// ---------------------------------------------------------------------------
export function removeDanglingExtensionLinks({ extensionsDir, names = DANGLING_EXTENSION_LINKS } = {}) {
  const results = [];
  for (const name of names) {
    const linkPath = join(extensionsDir, name);
    let stat;
    try {
      stat = lstatSync(linkPath);
    } catch (err) {
      results.push({ name, path: linkPath, status: err?.code === "ENOENT" ? "absent" : "unreadable", error: err?.message });
      continue;
    }
    if (!stat.isSymbolicLink()) {
      results.push({ name, path: linkPath, status: "skipped-not-symlink" });
      continue;
    }
    const target = readlinkSync(linkPath);
    const resolvedTarget = resolve(dirname(linkPath), target);
    if (existsSync(resolvedTarget)) {
      results.push({ name, path: linkPath, status: "skipped-target-exists", target: resolvedTarget });
      continue;
    }
    try {
      rmSync(linkPath, { force: true });
      results.push({ name, path: linkPath, status: "removed", target: resolvedTarget });
    } catch (err) {
      results.push({ name, path: linkPath, status: "remove-failed", error: err?.message });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Step 2: provider entry + agent profile in the Paseo daemon config.
// ---------------------------------------------------------------------------
export function installPaseoConfig({ paths, dryRun = false, enablePlugins = false, now = () => new Date().toISOString() } = {}) {
  const current = readJson(paths.paseoConfig, { fallback: null });
  if (current === null && !existsSync(paths.paseoConfig)) {
    // A missing config is not ours to invent silently: report it and stop.
    return { status: "skipped-no-config", path: paths.paseoConfig, changes: [] };
  }
  const applied = applyArchitectPaseoConfig(current, { enablePlugins });
  if (applied.changes.length === 0) {
    return { status: "already-installed", path: paths.paseoConfig, changes: [], backupPath: existsSync(paths.backupPath) ? paths.backupPath : null };
  }
  if (dryRun) {
    return { status: "dry-run", path: paths.paseoConfig, changes: applied.changes, config: applied.config };
  }
  let backupPath = null;
  if (!existsSync(paths.backupPath)) {
    // Pristine pre-install copy: the basis for a faithful rollback.
    writeFileSync(paths.backupPath, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    backupPath = paths.backupPath;
  } else {
    backupPath = paths.backupPath;
    const stamped = `${paths.paseoConfig}.qq-architect.${now().replace(/[:.]/g, "-")}.bak`;
    writeFileSync(stamped, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  }
  writeJsonAtomic(paths.paseoConfig, applied.config);
  return { status: "installed", path: paths.paseoConfig, changes: applied.changes, backupPath };
}

// ---------------------------------------------------------------------------
// Step 3: the Paseo plugin, through the supported CLI.
//
// Install → enable → verify. Verification is not a formality: a plugin only
// reaches `running` when the daemon-wide `pluginsEnabled` switch is on
// (resolvePluginStatus/canPublish). When the plugin is configured but the daemon
// has not picked the switch up yet, this asks the daemon to reload config.json
// (no restart of the running host) and re-reads the status. The report always
// states what was actually observed.
// ---------------------------------------------------------------------------
export function readPluginState({ paseoBin = process.env.QQ_PASEO_BIN || "paseo", run = spawnSync, pluginId = ARCHITECT_PROVIDER_ID } = {}) {
  const command = [paseoBin, "plugin", "ls", pluginId, "--json"];
  const result = run(command[0], command.slice(1), { encoding: "utf8" });
  if (result?.error || result?.status !== 0) {
    return { ok: false, command, reason: result?.error?.message || (result?.stderr ?? "").toString().trim().slice(0, 300) || `exit ${result?.status}` };
  }
  let parsed;
  try {
    parsed = JSON.parse((result.stdout ?? "").toString());
  } catch (err) {
    return { ok: false, command, reason: `unreadable 'plugin ls --json' output: ${err.message}` };
  }
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!item || typeof item !== "object") return { ok: false, command, reason: "plugin is not configured" };
  return {
    ok: true,
    command,
    id: item.id ?? pluginId,
    status: typeof item.status === "string" ? item.status : null,
    enabled: item.enabled !== false,
    path: item.path ?? null,
    error: item.error ?? null,
  };
}

export function installPaseoPlugin({
  paths,
  dryRun = false,
  paseoBin = process.env.QQ_PASEO_BIN || "paseo",
  run = spawnSync,
  manifest = null,
} = {}) {
  const command = [paseoBin, "plugin", "install", paths.pluginDir, "--id", ARCHITECT_PROVIDER_ID];
  const enableCommand = [paseoBin, "plugin", "enable", ARCHITECT_PROVIDER_ID];
  const verifyCommand = [paseoBin, "plugin", "ls", ARCHITECT_PROVIDER_ID, "--json"];
  const reloadCommand = [paseoBin, "daemon", "reload", "--json"];
  if (dryRun) return { status: "dry-run", command, enableCommand, verifyCommand };
  const checked = manifest ?? readPluginManifest({ paths });
  if (checked.status !== "present") {
    // Nothing is half-installed: the strict manifest is validated before the CLI
    // is asked to trust the directory.
    return { status: "invalid-manifest", command, manifestPath: checked.path, reason: (checked.errors ?? []).join("; ") };
  }
  const probe = run(paseoBin, ["--version"], { encoding: "utf8" });
  if (probe?.error || probe?.status !== 0) {
    return {
      status: "skipped-no-cli",
      command,
      reason: probe?.error?.message || `'${paseoBin} --version' exited ${probe?.status}`,
    };
  }
  const installed = run(command[0], command.slice(1), { encoding: "utf8" });
  if (installed?.error || installed?.status !== 0) {
    return {
      status: "failed",
      command,
      reason: installed?.error?.message || (installed?.stderr || `exit ${installed?.status}`).toString().trim().slice(0, 400),
    };
  }

  // Explicit enable (idempotent) so the plugin source is not left disabled by a
  // previous `plugin disable`.
  const enabled = run(enableCommand[0], enableCommand.slice(1), { encoding: "utf8" });
  const enable = {
    command: enableCommand,
    ok: !enabled?.error && enabled?.status === 0,
    reason: !enabled?.error && enabled?.status === 0 ? null : enabled?.error?.message || (enabled?.stderr ?? "").toString().trim().slice(0, 300) || `exit ${enabled?.status}`,
  };

  let state = readPluginState({ paseoBin, run });
  let activation = { status: "not-needed", command: reloadCommand };
  if (state.ok && state.status !== "running") {
    // `pluginsEnabled` is independently reloadable; a reload activates the switch
    // (and the provider/profile entries written above) without restarting the host.
    const reloaded = run(reloadCommand[0], reloadCommand.slice(1), { encoding: "utf8" });
    let payload = null;
    try {
      payload = JSON.parse((reloaded?.stdout ?? "").toString());
    } catch {
      payload = null;
    }
    activation = {
      status: reloaded?.status === 0 && !reloaded?.error ? "reloaded" : "reload-failed",
      command: reloadCommand,
      appliedPaths: Array.isArray(payload?.appliedPaths) ? payload.appliedPaths : null,
      restartRequiredPaths: Array.isArray(payload?.restartRequiredPaths) ? payload.restartRequiredPaths : null,
      reason: reloaded?.status === 0 && !reloaded?.error ? null : reloaded?.error?.message || (reloaded?.stderr ?? "").toString().trim().slice(0, 300) || `exit ${reloaded?.status}`,
    };
    state = readPluginState({ paseoBin, run });
  }

  const verified = state.ok && state.status === "running";
  const requiredAction = verified
    ? null
    : state.ok
      ? "the plugin is configured but not running: check 'paseo plugin logs qq-architect' (a plugin source change may need a daemon restart)"
      : "the daemon could not report the plugin status; run 'paseo plugin ls qq-architect' and reload or restart the daemon if needed";
  return {
    status: verified ? "installed" : "installed-not-running",
    command,
    enable,
    activation,
    verified,
    pluginStatus: state.status ?? null,
    pluginError: state.error ?? state.reason ?? null,
    requiredAction,
    verifiedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Step 4: the pi extension file referenced by the provider entry.
// ---------------------------------------------------------------------------
export function verifyExtensionFile({ paths } = {}) {
  try {
    const stat = statSync(paths.extensionFile);
    return { status: "present", path: paths.extensionFile, bytes: stat.size };
  } catch (err) {
    return { status: "missing", path: paths.extensionFile, error: err?.message };
  }
}

export function writeManifest({ paths, report, now = () => new Date().toISOString() } = {}) {
  const manifest = {
    schema: 1,
    installedAt: now(),
    repoRoot: paths.repoRoot,
    providerId: ARCHITECT_PROVIDER_ID,
    paseoConfig: paths.paseoConfig,
    backupPath: report?.paseoConfig?.backupPath ?? (existsSync(paths.backupPath) ? paths.backupPath : null),
    removedExtensionLinks: (report?.extensionLinks ?? []).filter((entry) => entry.status === "removed").map((entry) => entry.path),
    plugin: report?.plugin ?? null,
    pluginsEnabled: (report?.paseoConfig?.changes ?? []).includes("plugins-enabled"),
    requiredAction: report?.plugin?.requiredAction ?? null,
  };
  writeJsonAtomic(paths.manifestPath, manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Orchestration + rollback.
// ---------------------------------------------------------------------------
export function install({
  home = homedir(),
  repoRoot = REPO_ROOT,
  env = process.env,
  dryRun = false,
  skipPlugin = false,
  paseoBin = process.env.QQ_PASEO_BIN || "paseo",
  run = spawnSync,
  now = () => new Date().toISOString(),
} = {}) {
  const paths = installPaths({ home, repoRoot, env });
  const pluginManifest = readPluginManifest({ paths });
  const installPlugin = !skipPlugin && pluginManifest.status === "present";
  const report = {
    dryRun,
    home,
    repoRoot,
    paths,
    extensionLinks: dryRun
      ? DANGLING_EXTENSION_LINKS.map((name) => ({ name, path: join(paths.extensionsDir, name), status: "dry-run" }))
      : removeDanglingExtensionLinks({ extensionsDir: paths.extensionsDir }),
    extensionFile: verifyExtensionFile({ paths }),
    pluginManifest: { status: pluginManifest.status, path: pluginManifest.path, errors: pluginManifest.errors, id: pluginManifest.manifest?.id ?? null },
    // The daemon-wide plugin switch is written before the plugin is installed: the
    // plugin cannot run without it, and the pre-install backup restores the value.
    paseoConfig: installPaseoConfig({ paths, dryRun, enablePlugins: installPlugin, now }),
    plugin: skipPlugin ? { status: "skipped-by-flag" } : installPaseoPlugin({ paths, dryRun, paseoBin, run, manifest: pluginManifest }),
  };
  report.manifest = dryRun ? null : existsSync(paths.manifestPath) && report.paseoConfig.status === "already-installed"
    ? readJson(paths.manifestPath)
    : writeManifest({ paths, report, now });
  return report;
}

export function rollback({
  home = homedir(),
  repoRoot = REPO_ROOT,
  env = process.env,
  paseoBin = process.env.QQ_PASEO_BIN || "paseo",
  run = spawnSync,
  dryRun = false,
  now = () => new Date().toISOString(),
} = {}) {
  const paths = installPaths({ home, repoRoot, env });
  const report = { home, repoRoot, paths, dryRun, config: null, plugin: null, manifest: null };

  const backupPath = existsSync(paths.backupPath) ? paths.backupPath : null;
  if (backupPath) {
    const backup = readJson(backupPath);
    if (!dryRun) writeJsonAtomic(paths.paseoConfig, backup);
    report.config = { status: dryRun ? "dry-run" : "restored", from: backupPath };
  } else if (existsSync(paths.paseoConfig)) {
    const current = readJson(paths.paseoConfig);
    const removed = removeArchitectPaseoConfig(current);
    if (!dryRun) writeJsonAtomic(paths.paseoConfig, removed.config);
    report.config = { status: dryRun ? "dry-run" : "entries-removed", removed: removed.removed };
  } else {
    report.config = { status: "nothing-to-do" };
  }

  const command = [paseoBin, "plugin", "remove", ARCHITECT_PROVIDER_ID];
  if (dryRun) {
    report.plugin = { status: "dry-run", command };
  } else {
    const probe = run(paseoBin, ["--version"], { encoding: "utf8" });
    if (probe?.error || probe?.status !== 0) {
      report.plugin = { status: "skipped-no-cli", command, reason: probe?.error?.message || `exit ${probe?.status}` };
    } else {
      const result = run(command[0], command.slice(1), { encoding: "utf8" });
      report.plugin = {
        status: result?.status === 0 ? "removed" : "not-installed-or-failed",
        command,
        reason: result?.status === 0 ? null : (result?.stderr ?? "").toString().trim().slice(0, 300),
      };
    }
  }

  if (existsSync(paths.manifestPath) && !dryRun) {
    rmSync(paths.manifestPath, { force: true });
    report.manifest = { status: "removed", path: paths.manifestPath };
  } else {
    report.manifest = { status: existsSync(paths.manifestPath) ? "dry-run" : "absent" };
  }
  const rollbackConfig = existsSync(paths.paseoConfig) ? readJson(paths.paseoConfig, { fallback: {} }) : {};
  report.pluginsEnabled = backupPath
    ? "restored from the pre-install backup with the rest of the config"
    : rollbackConfig?.pluginsEnabled === true
      ? "left enabled: the pre-install value is unknown without the backup, so clear pluginsEnabled by hand to restore the previous switch"
      : "not enabled by this installer";
  report.note =
    "rollback restores the pre-install Paseo config (including pluginsEnabled) and removes the plugin; the two obsolete dangling pi extension links are deliberately NOT recreated (their targets are absent)";
  report.at = now();
  return report;
}

function parseArgs(argv) {
  const options = { dryRun: false, rollback: false, json: false, skipPlugin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--rollback" || arg === "--uninstall") options.rollback = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--skip-plugin") options.skipPlugin = true;
    else if (arg === "--home" && argv[index + 1]) options.home = argv[++index];
    else if (arg === "--repo" && argv[index + 1]) options.repoRoot = argv[++index];
    else if (arg === "--paseo-bin" && argv[index + 1]) options.paseoBin = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
  }
  return options;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(`qq-workflows Architect installer

Usage: node scripts/install-architect.mjs [options]

  --home <dir>        Home directory to install into (default: $HOME)
  --repo <path>       Repository root holding pi-extension/ and paseo-plugin/ (default: this checkout)
  --paseo-bin <path>  Paseo CLI to use for plugin install/remove (default: paseo)
  --skip-plugin       Do not touch Paseo plugins (config + extension links only)
  --dry-run           Report the plan without changing anything
  --rollback          Restore the pre-install Paseo config and remove the plugin
  --json              Machine-readable report

Installs the plugin through 'paseo plugin install' + 'paseo plugin enable',
turns the daemon-wide plugin switch on (pluginsEnabled: true) because a plugin
cannot run without it, and asks the daemon to reload config.json (no restart)
before verifying the plugin reaches 'running'.

Removes only the confirmed dangling pi extensions (qq, subagent), preserves
unrelated extensions/config/credentials, and never writes worker pins.`);
    process.exit(0);
  }
  const report = options.rollback
    ? rollback({ home: options.home ?? homedir(), repoRoot: options.repoRoot ?? REPO_ROOT, paseoBin: options.paseoBin, dryRun: options.dryRun })
    : install({
        home: options.home ?? homedir(),
        repoRoot: options.repoRoot ?? REPO_ROOT,
        paseoBin: options.paseoBin,
        dryRun: options.dryRun,
        skipPlugin: options.skipPlugin,
      });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const lines = [];
    lines.push(`qq-workflows Architect ${options.rollback ? "rollback" : "install"}${options.dryRun ? " (dry run)" : ""} — home ${report.home}`);
    if (report.extensionLinks) {
      for (const link of report.extensionLinks) lines.push(`  pi extension ${link.name}: ${link.status}`);
    }
    if (report.extensionFile) lines.push(`  pi extension file: ${report.extensionFile.status} (${report.extensionFile.path})`);
    if (report.paseoConfig) lines.push(`  paseo config: ${report.paseoConfig.status}${report.paseoConfig.changes?.length ? ` [${report.paseoConfig.changes.join(", ")}]` : ""}`);
    if (report.plugin) lines.push(`  paseo plugin: ${report.plugin.status}${report.plugin.reason ? ` (${report.plugin.reason})` : ""}`);
    if (report.config) lines.push(`  paseo config: ${report.config.status}`);
    if (report.manifest) lines.push(`  install manifest: ${report.manifest.status ?? "written"}`);
    if (report.note) lines.push(`  note: ${report.note}`);
    console.log(lines.join("\n"));
  }
}
