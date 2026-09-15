#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mainRepoRoot } from "../workflow/git.mjs";

export const ROLES = ["architect", "implementer", "reviewer", "runner"];
export const RETIRED_ROLES = ["teacher", "researcher"];
export const MUSE_PRESET_NAMES = ["architect", "implementer", "reviewer", "researcher"];

export async function resolveRepoRoot(startDir) {
  try {
    return await mainRepoRoot(startDir);
  } catch {
    return startDir;
  }
}

export function defaultStartDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

// Muse config dir: $XDG_CONFIG_HOME/muse when set, else ~/.config/muse.
export function museConfigDir(home, xdgConfigHome = process.env.XDG_CONFIG_HOME) {
  const base = String(xdgConfigHome ?? "").trim();
  if (base) return join(base, "muse");
  return join(home, ".config", "muse");
}

// Pure merge for muse settings.json. Preset names are created as {} only
// when absent; pre-existing preset content and all other keys are preserved.
// The qq-workflows MCP server is (re)registered; other servers are preserved.
export function mergeMuseSettings(existing, mcpServerBin) {
  const base = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const config = { ...base };
  const presets =
    base.presets && typeof base.presets === "object" && !Array.isArray(base.presets) ? { ...base.presets } : {};
  for (const name of MUSE_PRESET_NAMES) {
    if (!Object.hasOwn(presets, name)) presets[name] = {};
  }
  config.presets = presets;
  const servers =
    base.mcpServers && typeof base.mcpServers === "object" && !Array.isArray(base.mcpServers)
      ? { ...base.mcpServers }
      : {};
  servers["qq-workflows"] = {
    command: "node",
    args: [mcpServerBin],
  };
  config.mcpServers = servers;
  return config;
}

export function cleanMuseAuth(authJsonText) {
  if (!authJsonText) return authJsonText;
  try {
    const data = JSON.parse(authJsonText);
    if (data && typeof data === "object" && data.providers && typeof data.providers === "object") {
      let changed = false;
      for (const provider of Object.values(data.providers)) {
        if (provider && typeof provider === "object" && "api_key" in provider) {
          delete provider.api_key;
          changed = true;
        }
      }
      if (changed) {
        return `${JSON.stringify(data, null, 2)}\n`;
      }
    }
    return authJsonText;
  } catch {
    return authJsonText;
  }
}

export function configureOrcaSettings(existingOrcaDataText, { codexCommand = "codex-architect" } = {}) {
  let data = {};
  if (existingOrcaDataText && typeof existingOrcaDataText === "string") {
    try {
      data = JSON.parse(existingOrcaDataText);
    } catch {
      data = {};
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    data = {};
  }
  data.settings = data.settings && typeof data.settings === "object" && !Array.isArray(data.settings)
    ? { ...data.settings }
    : {};
  data.settings.agentCmdOverrides = data.settings.agentCmdOverrides && typeof data.settings.agentCmdOverrides === "object" && !Array.isArray(data.settings.agentCmdOverrides)
    ? { ...data.settings.agentCmdOverrides }
    : {};
  data.settings.agentCmdOverrides.codex = codexCommand;
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function mergeCodexConfig(existingTomlText, { mcpServerBin, zgBin = "zg", promptFile } = {}) {
  let content = String(existingTomlText || "").trim();

  if (promptFile) {
    if (/^model_instructions_file\s*=/m.test(content)) {
      content = content.replace(/^model_instructions_file\s*=.*$/m, `model_instructions_file = "${promptFile}"`);
    } else {
      content = `model_instructions_file = "${promptFile}"\n${content}`.trim();
    }
  }

  if (/^\[features\]/m.test(content)) {
    if (/^shell_tool\s*=/m.test(content)) {
      content = content.replace(/^shell_tool\s*=.*$/m, "shell_tool = false");
    } else {
      content = content.replace(/^\[features\]/m, "[features]\nshell_tool = false");
    }
    if (/^unified_exec\s*=/m.test(content)) {
      content = content.replace(/^unified_exec\s*=.*$/m, "unified_exec = false");
    } else {
      content = content.replace(/^\[features\]/m, "[features]\nunified_exec = false");
    }
  } else {
    content += `\n\n[features]\nshell_tool = false\nunified_exec = false`;
  }

  function removeSection(toml, sectionHeader) {
    const pattern = new RegExp(`\\[${sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\][\\s\\S]*?(?=\\n\\[|$)`);
    return toml.replace(pattern, "").trim();
  }

  if (mcpServerBin) {
    content = removeSection(content, 'mcp_servers."qq-workflows"');
    content = removeSection(content, "mcp_servers.qq-workflows");
    content += `\n\n[mcp_servers.qq-workflows]\ncommand = "node"\nargs = ["${mcpServerBin}"]`;
  }

  if (zgBin) {
    content = removeSection(content, 'mcp_servers."zvec_grep"');
    content = removeSection(content, "mcp_servers.zvec_grep");
    content += `\n\n[mcp_servers.zvec_grep]\ncommand = "${zgBin}"\nargs = ["server", "--stdio", "--mcp-toolset", "agent"]`;
  }

  return `${content.trim()}\n`;
}

// Orca ships its built-in opencode integration slot under the display name
// "OpenCode" in several bundles (tui-agent-display-names.js,
// commit-message-agent-specs-primary.js, and minified main chunks). We reuse
// that slot for Muse Spark: ~/.local/bin/opencode points at
// bin/muse-architect.sh, so Orca detects the slot as installed
// (detectCmd: 'opencode'). This pure transform renames only the slot's
// display labels to "Muse Spark". Agent ids, detectCmd/binary values, model
// labels, hook identifiers, and comments are deliberately left untouched.
export function patchOrcaMuseSparkDisplayName(content) {
  let out = String(content ?? "");
  // Status labels first: each contains the bare label as a prefix.
  out = out.split("'OpenCode - action required'").join("'Muse Spark - action required'");
  out = out.split("'OpenCode ready'").join("'Muse Spark ready'");
  out = out.split("`OpenCode - action required`").join("`Muse Spark - action required`");
  out = out.split("`OpenCode ready`").join("`Muse Spark ready`");
  // Bare display labels in shared registries and minified chunks.
  out = out.split("'OpenCode'").join("'Muse Spark'");
  out = out.split("`OpenCode`").join("`Muse Spark`");
  // Localized agent-catalog label for the opencode slot.
  out = out.split('"e7a4ca5103":"OpenCode"').join('"e7a4ca5103":"Muse Spark"');
  // Reverse display-name -> agent-id maps: add the new display name as an
  // alias so both old ("OpenCode") and new ("Muse Spark") titles resolve.
  // Guarded so reruns never duplicate the alias.
  if (out.includes("OpenCode: 'opencode'") && !out.includes("'Muse Spark': 'opencode'")) {
    out = out.split("OpenCode: 'opencode'").join("OpenCode: 'opencode', 'Muse Spark': 'opencode'");
  }
  if (out.includes("OpenCode:`opencode`") && !out.includes('"Muse Spark":`opencode`')) {
    out = out.split("OpenCode:`opencode`").join("OpenCode:`opencode`,\"Muse Spark\":`opencode`");
  }
  return out;
}

// Locate Orca's unpacked JS tree from a home dir: ~/.local/bin/orca[-ide]
// resolves (through symlinks) to <resources>/bin/orca-ide, and the shipped
// bundles live in <resources>/app.asar.unpacked/out. Home-scoped on purpose:
// temp-home installer runs must never touch the real Orca install.
export function resolveOrcaOutDir(home) {
  for (const name of ["orca", "orca-ide"]) {
    try {
      const candidate = join(home, ".local", "bin", name);
      if (!lstatSync(candidate, { throwIfNoEntry: false })) continue;
      const outDir = join(dirname(dirname(realpathSync(candidate))), "app.asar.unpacked", "out");
      if (existsSync(outDir)) return outDir;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

// Patch every shipped Orca bundle under outDir so the opencode slot shows
// as "Muse Spark". Idempotent: reruns rewrite nothing. Best-effort per file.
export function ensureOrcaMuseSparkDisplay(outDir, { log = () => {} } = {}) {
  const patched = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
      scanned += 1;
      let raw;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const updated = patchOrcaMuseSparkDisplayName(raw);
      if (updated !== raw) {
        try {
          writeFileSync(full, updated, "utf8");
          patched.push(full);
          log(`Patched Orca Muse Spark display name in ${full}`);
        } catch {
          /* best-effort per file */
        }
      }
    }
  };
  try {
    walk(outDir);
  } catch {
    /* missing/unreadable tree: nothing to patch */
  }
  return { scanned, patched };
}

function installSymlink(targetPath, sourcePath, label, log) {
  const stat = lstatSync(targetPath, { throwIfNoEntry: false });
  if (stat) {
    rmSync(targetPath, { force: true });
  }
  symlinkSync(sourcePath, targetPath);
  log(`Installed ${label} symlink: ${targetPath} -> ${sourcePath}`);
}

export async function installAgents({ home = homedir(), xdgConfigHome = process.env.XDG_CONFIG_HOME, repoRoot = null, orcaOutDir = null, log = console.log } = {}) {
  const root = repoRoot ?? (await resolveRepoRoot(defaultStartDir()));
  const warn = (message, error) => {
    if (error !== undefined) console.error(message, error);
    else console.error(message);
  };

  // 1. Install agent symlinks in ~/.gemini/config/agents/
  const agentsDir = join(home, ".gemini", "config", "agents");
  mkdirSync(agentsDir, { recursive: true });

  for (const role of RETIRED_ROLES) {
    const targetDir = join(agentsDir, role);
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true });
      log(`Cleaned up retired agent: ${role}`);
    }
  }

  for (const role of ROLES) {
    const sourceFile = join(root, "agents", role, "agent.md");
    if (!existsSync(sourceFile)) continue;
    const targetRoleDir = join(agentsDir, role);
    mkdirSync(targetRoleDir, { recursive: true });
    const targetFile = join(targetRoleDir, "agent.md");

    const stat = lstatSync(targetFile, { throwIfNoEntry: false });
    if (stat) {
      rmSync(targetFile, { force: true });
    }
    symlinkSync(sourceFile, targetFile);
    log(`Installed agent symlink: ${role} -> ${sourceFile}`);
  }

  // 2. Register qq-workflows MCP server in ~/.gemini/config/mcp_config.json
  const mcpConfigPath = join(home, ".gemini", "config", "mcp_config.json");
  const mcpServerBin = join(root, "bin", "mcp-server.mjs");
  try {
    mkdirSync(dirname(mcpConfigPath), { recursive: true });
    let config = { mcpServers: {} };
    if (existsSync(mcpConfigPath)) {
      try {
        config = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
      } catch {
        config = { mcpServers: {} };
      }
    }
    config.mcpServers = config.mcpServers || {};
    if (config.mcpServers.architect) {
      delete config.mcpServers.architect;
    }
    config.mcpServers["qq-workflows"] = {
      command: "node",
      args: [mcpServerBin],
    };
    writeFileSync(mcpConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    log(`Registered qq-workflows MCP server in mcp_config.json -> ${mcpServerBin}`);
  } catch (err) {
    warn("Failed to update mcp_config.json", err);
  }

  // 3. Register PreInvocation hook in ~/.gemini/config/hooks.json
  const hooksConfigPath = join(home, ".gemini", "config", "hooks.json");
  const nodeBin = process.execPath;
  const hookScript = join(root, "hooks", "pre-invocation.mjs");
  const hookCommand = `${nodeBin} ${hookScript}`;

  let hooks = {};
  if (existsSync(hooksConfigPath)) {
    try {
      hooks = JSON.parse(readFileSync(hooksConfigPath, "utf8"));
    } catch {
      hooks = {};
    }
  }

  hooks["architect-ticket"] = {
    PreInvocation: [
      {
        type: "command",
        command: hookCommand,
        timeout: 10,
      },
    ],
  };

  writeFileSync(hooksConfigPath, `${JSON.stringify(hooks, null, 2)}\n`, "utf8");
  log("Registered architect-ticket PreInvocation hook in hooks.json");

  // 4. Install bin/architect CLI symlink into ~/.local/bin/architect
  const localBin = join(home, ".local", "bin");
  mkdirSync(localBin, { recursive: true });
  try {
    installSymlink(join(localBin, "architect"), join(root, "bin", "architect.mjs"), "CLI launcher", log);
  } catch (err) {
    warn("Failed to symlink bin/architect", err);
  }

  // 5. Muse settings: preset names + MCP server (XDG-aware)
  const museDir = museConfigDir(home, xdgConfigHome);
  const museSettingsPath = join(museDir, "settings.json");
  try {
    mkdirSync(museDir, { recursive: true });
    let existing;
    if (existsSync(museSettingsPath)) {
      try {
        existing = JSON.parse(readFileSync(museSettingsPath, "utf8"));
      } catch {
        existing = undefined;
      }
    }
    const merged = mergeMuseSettings(existing, mcpServerBin);
    writeFileSync(museSettingsPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    log(`Ensured muse presets + MCP server in ${museSettingsPath}`);
  } catch (err) {
    warn("Failed to update muse settings.json", err);
  }

  // 5b. Sanitize muse auth.json (strip contributor api_key so subscription token is used)
  for (const dir of new Set([museDir, join(home, ".config", "muse")])) {
    const authPath = join(dir, "auth.json");
    if (existsSync(authPath)) {
      try {
        const raw = readFileSync(authPath, "utf8");
        const cleaned = cleanMuseAuth(raw);
        if (cleaned !== raw) {
          writeFileSync(authPath, cleaned, "utf8");
          log(`Sanitized muse auth in ${authPath}`);
        }
      } catch (err) {
        warn(`Failed to clean muse auth in ${authPath}`, err);
      }
    }
  }

  // 6. Install muse-architect launcher symlink into ~/.local/bin/muse-architect
  try {
    installSymlink(join(localBin, "muse-architect"), join(root, "bin", "muse-architect.sh"), "muse-architect launcher", log);
  } catch (err) {
    warn("Failed to symlink bin/muse-architect.sh", err);
  }

  // 7. Ensure the opencode alias points at the muse-architect launcher so
  // Orca detects its opencode slot (detectCmd: 'opencode') as installed.
  // A foreign opencode entry (the real OpenCode CLI, not our symlink) is
  // always left alone.
  try {
    const opencodeLink = join(localBin, "opencode");
    const museArchitectShim = join(root, "bin", "muse-architect.sh");
    const stat = lstatSync(opencodeLink, { throwIfNoEntry: false });
    if (!stat) {
      symlinkSync(museArchitectShim, opencodeLink);
      log(`Installed opencode alias symlink: ${opencodeLink} -> ${museArchitectShim}`);
    } else if (stat.isSymbolicLink()) {
      const target = readlinkSync(opencodeLink);
      if (target.includes("muse-architect")) {
        if (target !== museArchitectShim) {
          rmSync(opencodeLink);
          symlinkSync(museArchitectShim, opencodeLink);
          log(`Repointed opencode alias: ${opencodeLink} -> ${museArchitectShim}`);
        } else {
          log(`opencode alias already installed: ${opencodeLink} -> ${target}`);
        }
      } else {
        log(`Leaving foreign opencode symlink alone: ${opencodeLink} -> ${target}`);
      }
    } else {
      log(`Leaving foreign opencode entry alone: ${opencodeLink}`);
    }
  } catch (err) {
    warn("Failed to ensure opencode alias", err);
  }

  // 8. Remove the stale hardcoded architect prompt (the launcher now renders
  // from agents/architect/agent.md). Check both the resolved muse config dir
  // and the historical ~/.config/muse default.
  for (const dir of new Set([museDir, join(home, ".config", "muse")])) {
    try {
      const stale = join(dir, "architect", "AGENTS.md");
      const stat = lstatSync(stale, { throwIfNoEntry: false });
      if (stat && !stat.isDirectory()) {
        rmSync(stale);
        log(`Removed stale ${stale} (architect prompt now renders from agents/architect/agent.md)`);
      }
    } catch {
      /* best-effort stale cleanup */
    }
  }

  // 9. Codex configuration: ~/.codex/config.toml
  const codexDir = join(home, ".codex");
  const codexConfigPath = join(codexDir, "config.toml");
  const promptFile = join(codexDir, "architect-instructions.md");
  try {
    mkdirSync(codexDir, { recursive: true });
    let existing;
    if (existsSync(codexConfigPath)) {
      try {
        existing = readFileSync(codexConfigPath, "utf8");
      } catch {
        existing = undefined;
      }
    }
    const merged = mergeCodexConfig(existing, {
      mcpServerBin,
      zgBin: "zg",
      promptFile,
    });
    writeFileSync(codexConfigPath, merged, "utf8");
    log(`Configured codex in ${codexConfigPath}`);
  } catch (err) {
    warn("Failed to update codex config.toml", err);
  }

  // 10. Install codex-architect launcher symlink into ~/.local/bin/codex-architect
  try {
    installSymlink(join(localBin, "codex-architect"), join(root, "bin", "codex-architect.sh"), "codex-architect launcher", log);
  } catch (err) {
    warn("Failed to symlink bin/codex-architect.sh", err);
  }

  // 11. Configure Orca: agentCmdOverrides for codex and managed account config.toml
  const orcaBaseDir = join(home, ".config", "orca");
  if (existsSync(orcaBaseDir)) {
    const profileCandidates = [join(orcaBaseDir, "orca-data.json")];
    const profilesDir = join(orcaBaseDir, "profiles");
    if (existsSync(profilesDir)) {
      try {
        for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            profileCandidates.push(join(profilesDir, entry.name, "orca-data.json"));
          }
        }
      } catch {}
    }
    for (const dataPath of profileCandidates) {
      if (existsSync(dataPath)) {
        try {
          const raw = readFileSync(dataPath, "utf8");
          const updated = configureOrcaSettings(raw);
          if (updated !== raw) {
            writeFileSync(dataPath, updated, "utf8");
            log(`Configured Orca codex override in ${dataPath}`);
          }
        } catch (err) {
          warn(`Failed to update Orca settings in ${dataPath}`, err);
        }
      }
    }

    const codexConfigCandidates = [join(orcaBaseDir, "codex-runtime-home", "home", "config.toml")];
    const codexAccountsDir = join(orcaBaseDir, "codex-accounts");
    if (existsSync(codexAccountsDir)) {
      try {
        for (const entry of readdirSync(codexAccountsDir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            codexConfigCandidates.push(join(codexAccountsDir, entry.name, "home", "config.toml"));
          }
        }
      } catch {}
    }
    for (const configPath of codexConfigCandidates) {
      if (existsSync(configPath)) {
        try {
          const raw = readFileSync(configPath, "utf8");
          const merged = mergeCodexConfig(raw, {
            mcpServerBin,
            zgBin: "zg",
            promptFile,
          });
          if (merged !== raw) {
            writeFileSync(configPath, merged, "utf8");
            log(`Configured Orca managed codex in ${configPath}`);
          }
        } catch (err) {
          warn(`Failed to update Orca codex config in ${configPath}`, err);
        }
      }
    }
  }

  // 12. Rename Orca's built-in opencode slot display labels to "Muse Spark"
  // so the provider/agent lists show Muse Spark. Detection still uses the
  // opencode command from step 7. Home-scoped: without an Orca install
  // under this home root there is nothing to patch.
  let orcaDisplayOutDir = null;
  try {
    orcaDisplayOutDir = orcaOutDir ?? resolveOrcaOutDir(home);
    if (orcaDisplayOutDir) {
      const { scanned, patched } = ensureOrcaMuseSparkDisplay(orcaDisplayOutDir, { log });
      if (patched.length === 0) {
        log(`Orca Muse Spark display names already current (${scanned} bundles scanned)`);
      }
    }
  } catch (err) {
    warn("Failed to patch Orca display names", err);
  }

  log("Installation complete!");
  return { home, museDir, museSettingsPath, codexDir, codexConfigPath, repoRoot: root, orcaOutDir: orcaDisplayOutDir };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  await installAgents();
}
