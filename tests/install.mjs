#!/usr/bin/env node
// One-Architect/one-workflow installer contract.
//
// The legacy Architect entrypoints (Muse/Codex/Antigravity launchers and their
// installer) are gone: exactly one Architect runs as Pi on Paseo through
// scripts/install-architect.mjs, and the installed MCP server still provides
// the shared worker endpoints. This test proves the absence of the retired
// paths AND that the surviving install surface is coherent.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

// 1. Retired Architect launch/install/control paths are absent, not merely
//    unregistered: no file exists to be launched by anything.
const RETIRED_PATHS = [
  "bin/architect.mjs",
  "bin/codex-architect.sh",
  "bin/muse-architect.sh",
  "scripts/install-agents.mjs",
];
for (const path of RETIRED_PATHS) {
  assert.equal(existsSync(join(repoRoot, path)), false, `retired Architect path '${path}' must not exist`);
}

// 2. No package entry point or script resurrects them.
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
assert.equal(pkg.bin, undefined, "the package exposes no launcher binary: the Architect is the Pi on Paseo profile");
assert.deepEqual(
  Object.keys(pkg.scripts).sort(),
  ["install:architect", "test"],
  "only the Pi/Paseo installer, the migration installer, and the test suite are published",
);
assert.equal(pkg.scripts["install:architect"], "node scripts/install-architect.mjs");

// 3. The one installer exists and installs the Pi/Paseo provider entry.
const installer = readFileSync(join(repoRoot, "scripts", "install-architect.mjs"), "utf8");
assert.match(installer, /pi-extension/, "the installer wires the Pi extension");
assert.doesNotMatch(installer, /muse-architect/, "the installer never references the retired Muse launcher");
assert.doesNotMatch(installer, /codex-architect/, "the installer never references the retired Codex launcher");

// 4. Worker selection is configuration, not installation: no installer writes a
//    provider/model/harness pin.
assert.doesNotMatch(installer, /worker-config\.json/, "installation never writes worker provider/model selection");
assert.doesNotMatch(installer, /deepseek-flash/, "installation never pins a worker model");
assert.doesNotMatch(installer, /muse-spark|gpt-6-astra|gemini-/, "installation never pins a provider model id");

// 5. The retired wait tools are absent from every executable surface and from
//    the installer output (no --disabled-tools hiding for a tool that no longer
//    exists).
const SURFACES = [
  "bin/mcp-server.mjs",
  "workflow/operations.mjs",
  "workflow/architect-profile.mjs",
  "pi-extension/qq-architect.mjs",
  "bin/worker-exec.mjs",
  "agents/architect/agent.md",
];
for (const path of SURFACES) {
  const text = readFileSync(join(repoRoot, path), "utf8");
  assert.doesNotMatch(text, /await_runner/, `${path} must not reference await_runner`);
  assert.doesNotMatch(text, /await_execution/, `${path} must not reference await_execution`);
}

// Documentation is allowed to name the removed tools - it must simply be the
// documentation of their removal, not an instruction to call them.
const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
assert.match(readme, /There is no second Architect launcher and no blocking wait tool/);
assert.match(readme, /there is no `await_runner` \/ `await_execution`/);
assert.doesNotMatch(readme, /call `await_execution\(/, "the README must not instruct a wait call");
assert.doesNotMatch(readme, /npm run install:agents/, "the retired installer is not documented as a step");

// 6. The shared MCP surface a worker still needs survives: the runner's
//    authoritative completion transport and the read-only ticket tools.
const mcpServer = readFileSync(join(repoRoot, "bin", "mcp-server.mjs"), "utf8");
assert.match(mcpServer, /name: "complete_task"/, "complete_task stays the runner result transport");
assert.match(mcpServer, /name: "read_ticket"/, "the ticket tools stay available to the Architect");
assert.match(mcpServer, /name: "dispatch_execution"/, "the managed execution tool stays available");

console.log("install surface tests passed: one Architect (Pi on Paseo), no retired launchers");
