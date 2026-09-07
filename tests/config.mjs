#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACP_ENTRY,
  AGY_ROLE_ENTRY,
  daemonConfigPatch,
  ARCHITECT_MODEL_ID,
  architectProfile,
  ASTRA_MODEL,
  GEMINI_FLASH_MODEL,
  CHILD_MCP_ENTRY,
  findPluginRoot,
  PLUGIN_ROOT,
  SPAWN_ENTRY,
} from "../paseo-plugin/host/config.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(here, "../paseo-plugin");
const configSrc = readFileSync(join(pluginRoot, "host", "config.mjs"), "utf8");

assert.equal(resolve(PLUGIN_ROOT), pluginRoot);
assert.equal(ACP_ENTRY, join(PLUGIN_ROOT, "host", "acp.mjs"));
assert.equal(CHILD_MCP_ENTRY, join(PLUGIN_ROOT, "host", "child-mcp.mjs"));
assert.equal(SPAWN_ENTRY, join(PLUGIN_ROOT, "host", "spawn-agent.mjs"));
assert.equal(AGY_ROLE_ENTRY, join(PLUGIN_ROOT, "host", "agy-role.mjs"));
assert.doesNotMatch(configSrc, /\/home\/qqp\/projects\/qq-workflows\/paseo-plugin/);
assert.equal(findPluginRoot({ metaUrl: import.meta.url, env: {} }), pluginRoot);
assert.equal(findPluginRoot({ metaUrl: undefined, cwd: pluginRoot, env: {} }), pluginRoot);
const fakeConfig = join(pluginRoot, "..", "tests", "paseo-config.fake.json");
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

const patched = daemonConfigPatch({
  providers: { grok: { extends: "acp", label: "Grok" } },
  agentProfiles: [{ id: "antigravity", name: "Antigravity", provider: "agy" }],
});
assert.equal(patched.providers.grok.label, "Grok");
assert.deepEqual(daemonConfigPatch(patched), patched, "configuration is idempotent");

assert.equal(patched.providers.architect.extends, "acp");
assert.equal(patched.providers.architect.command[0], "npx");
assert.equal(patched.providers.architect.command[2], "agy-acp@0.5.2");
assert.equal(patched.providers.architect.env.AGY_BIN, AGY_ROLE_ENTRY);
assert.equal(patched.providers.architect.env.ARCHITECT_ROLE, "architect");
assert.equal(patched.providers.codex.additionalModels[0].id, ASTRA_MODEL.id);
assert.equal(patched.providers.codex.additionalModels[0].description, "GPT-6 Astra");
assert.doesNotMatch(patched.providers.codex.additionalModels[0].description, /architect/i);
assert.equal(ASTRA_MODEL.description, "GPT-6 Astra");
assert.equal(ASTRA_MODEL.thinkingOptions.find((item) => item.isDefault)?.id, "high");
assert.equal(ASTRA_MODEL.defaultThinkingOptionId, "high");
assert.equal(patched.providers.architect.models[0].id, ARCHITECT_MODEL_ID);
assert.equal(patched.providers.architect.models[0].defaultThinkingOptionId, "High");
assert.equal(patched.providers.codex.additionalModels[0].defaultThinkingOptionId, "high");
assert.equal(patched.agentProfiles[0].id, "architect");
assert.equal(patched.agentProfiles[1].id, "antigravity");
assert.equal(architectProfile().model, "Gemini 3.8 Flash");
assert.equal(architectProfile().thinkingOptionId, "High");
assert.match(architectProfile().notes, /Antigravity Gemini 3.8 Flash/);
assert.match(patched.providers.architect.description, /architect/i);
