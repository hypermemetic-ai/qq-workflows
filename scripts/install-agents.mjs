#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const home = homedir();

const ROLES = ["architect", "implementer", "reviewer"];
const RETIRED_ROLES = ["teacher", "researcher"];

// 1. Install agent symlinks in ~/.gemini/config/agents/
const agentsDir = join(home, ".gemini", "config", "agents");
mkdirSync(agentsDir, { recursive: true });

for (const role of RETIRED_ROLES) {
  const targetDir = join(agentsDir, role);
  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
    console.log(`Cleaned up retired agent: ${role}`);
  }
}

for (const role of ROLES) {
  const sourceFile = join(repoRoot, "agents", role, "agent.md");
  if (!existsSync(sourceFile)) continue;
  const targetRoleDir = join(agentsDir, role);
  mkdirSync(targetRoleDir, { recursive: true });
  const targetFile = join(targetRoleDir, "agent.md");

  const stat = lstatSync(targetFile, { throwIfNoEntry: false });
  if (stat) {
    rmSync(targetFile, { force: true });
  }
  symlinkSync(sourceFile, targetFile);
  console.log(`Installed agent symlink: ${role} -> ${sourceFile}`);
}

// 2. Register qq-workflows MCP server in ~/.gemini/config/mcp_config.json
const mcpConfigPath = join(home, ".gemini", "config", "mcp_config.json");
const mcpServerBin = join(repoRoot, "bin", "mcp-server.mjs");
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
  console.log(`Registered qq-workflows MCP server in mcp_config.json -> ${mcpServerBin}`);
} catch (err) {
  console.error("Failed to update mcp_config.json", err);
}

// 3. Register PreInvocation hook in ~/.gemini/config/hooks.json
const hooksConfigPath = join(home, ".gemini", "config", "hooks.json");
const nodeBin = process.execPath;
const hookScript = join(repoRoot, "hooks", "pre-invocation.mjs");
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
console.log("Registered architect-ticket PreInvocation hook in hooks.json");

// 4. Install bin/architect CLI symlink into ~/.local/bin/architect
const localBin = join(home, ".local", "bin");
mkdirSync(localBin, { recursive: true });
const targetBin = join(localBin, "architect");
const sourceBin = join(repoRoot, "bin", "architect.mjs");
try {
  const stat = lstatSync(targetBin, { throwIfNoEntry: false });
  if (stat) {
    rmSync(targetBin, { force: true });
  }
  symlinkSync(sourceBin, targetBin);
  console.log(`Installed CLI launcher symlink: ${targetBin} -> ${sourceBin}`);
} catch (err) {
  console.error("Failed to symlink bin/architect", err);
}

console.log("Installation complete!");
