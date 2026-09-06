#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACP_ENTRY,
  applyDaemonPatch,
  ARCHITECT_MODEL_ID,
  architectProfile,
  ASTRA_MODEL,
  CHILD_MCP_ENTRY,
  findPluginRoot,
  PLUGIN_ROOT,
  SPAWN_ENTRY,
} from "../../paseo-plugin/host/config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "../../paseo-plugin");
const configSrc = readFileSync(join(pluginRoot, "host", "config.mjs"), "utf8");

assert.equal(resolve(PLUGIN_ROOT), pluginRoot);
assert.equal(ACP_ENTRY, join(PLUGIN_ROOT, "host", "acp.mjs"));
assert.equal(CHILD_MCP_ENTRY, join(PLUGIN_ROOT, "host", "child-mcp.mjs"));
assert.equal(SPAWN_ENTRY, join(PLUGIN_ROOT, "host", "spawn-agent.mjs"));
assert.doesNotMatch(configSrc, /\/home\/qqp\/projects\/qq-workflows\/paseo-plugin/);
assert.equal(findPluginRoot({ metaUrl: import.meta.url, env: {} }), pluginRoot);
assert.equal(findPluginRoot({ metaUrl: undefined, cwd: pluginRoot, env: {} }), pluginRoot);
const fakeConfig = join(pluginRoot, "..", "tests", "paseo-architect", "paseo-config.fake.json");
writeFileSync(fakeConfig, `${JSON.stringify({ plugins: { architect: { source: "directory", path: pluginRoot } } }, null, 2)}\n`);
try {
  assert.equal(
    findPluginRoot({ metaUrl: undefined, cwd: "/tmp", env: {}, paseoConfigPath: fakeConfig }),
    pluginRoot,
  );
} finally {
  rmSync(fakeConfig, { force: true });
}
assert.throws(() => findPluginRoot({ startDir: "/tmp", env: {} }), /plugin root not found/);

const patched = applyDaemonPatch({
  agents: {
    providers: {
      grok: { extends: "acp", label: "Grok" },
    },
  },
  daemon: {
    agentProfiles: [{ id: "antigravity", name: "Antigravity", provider: "agy" }],
  },
});

assert.equal(patched.agents.providers.architect.extends, "acp");
assert.ok(patched.agents.providers.architect.command[1].endsWith("host/acp.mjs"));
assert.equal(patched.agents.providers.codex.additionalModels[0].id, ARCHITECT_MODEL_ID);
assert.equal(patched.agents.providers.codex.additionalModels[0].description, "GPT-6 Astra");
assert.doesNotMatch(patched.agents.providers.codex.additionalModels[0].description, /architect/i);
assert.equal(ASTRA_MODEL.description, "GPT-6 Astra");
assert.equal(ASTRA_MODEL.thinkingOptions.find((item) => item.isDefault)?.id, "high");
assert.equal(ASTRA_MODEL.defaultThinkingOptionId, "high");
assert.equal(patched.agents.providers.architect.models[0].defaultThinkingOptionId, "high");
assert.equal(patched.agents.providers.codex.additionalModels[0].defaultThinkingOptionId, "high");
assert.equal(patched.daemon.agentProfiles[0].id, "architect");
assert.equal(patched.daemon.agentProfiles[1].id, "antigravity");
assert.equal(architectProfile().thinkingOptionId, "high");
assert.match(architectProfile().notes, /two operator\/architect pairs/);
assert.match(patched.agents.providers.architect.description, /architect/i);
