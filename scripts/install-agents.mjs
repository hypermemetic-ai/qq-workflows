#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function installSymlink(targetPath, sourcePath, label, log) {
  const stat = lstatSync(targetPath, { throwIfNoEntry: false });
  if (stat) {
    rmSync(targetPath, { force: true });
  }
  symlinkSync(sourcePath, targetPath);
  log(`Installed ${label} symlink: ${targetPath} -> ${sourcePath}`);
}

export async function installAgents({ home = homedir(), xdgConfigHome = process.env.XDG_CONFIG_HOME, repoRoot = null, log = console.log } = {}) {
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

  // 6. Install muse-architect launcher symlink into ~/.local/bin/muse-architect
  try {
    installSymlink(join(localBin, "muse-architect"), join(root, "bin", "muse-architect.sh"), "muse-architect launcher", log);
  } catch (err) {
    warn("Failed to symlink bin/muse-architect.sh", err);
  }

  // 7. Remove the stale opencode alias, but only when it is our symlink to
  // the muse-architect launcher; anything else named opencode is left alone.
  try {
    const opencodeLink = join(localBin, "opencode");
    const stat = lstatSync(opencodeLink, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) {
      const target = readlinkSync(opencodeLink);
      if (target.includes("muse-architect")) {
        rmSync(opencodeLink);
        log(`Removed stale opencode alias: ${opencodeLink} -> ${target}`);
      }
    }
  } catch {
    /* best-effort alias cleanup */
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

  log("Installation complete!");
  return { home, museDir, museSettingsPath, codexDir, codexConfigPath, repoRoot: root };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  await installAgents();
}
