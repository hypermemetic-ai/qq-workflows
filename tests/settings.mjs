#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createHostSettings, HOST_ROLES, WORKFLOW_SETTINGS_SCHEMA } from "../src/settings.mjs";
import { completeWorkflowsInput, SETTINGS_ROLES } from "../src/command.mjs";

const root = mkdtempSync(join(tmpdir(), "qq-workflow-settings."));
try {
  const file = join(root, "settings.json");
  writeFileSync(file, `${JSON.stringify({
    schema: "qq.workflows-architect-settings/v1",
    roles: {
      talking: { provider: "old", model: "architect" },
      hands: { provider: "old", model: "worker" },
    },
    land: {
      roles: {
        router: { provider: "must", model: "be-ignored" },
        qa: { provider: "old", model: "reviewer" },
        implementer: { provider: "fallback", model: "worker" },
      },
    },
    iterate: { roles: { desk: { provider: "dead", model: "dead" } } },
    pluginDocs: { cadence: 60 },
  }, null, 2)}\n`);

  const settings = createHostSettings({ settingsFile: file });
  assert.deepEqual(HOST_ROLES, ["architecture", "implementation", "qa"]);
  assert.deepEqual(settings.get("architecture"), { provider: "old", model: "architect" });
  assert.deepEqual(settings.get("implementation"), { provider: "old", model: "worker" });
  assert.deepEqual(settings.get("qa"), { provider: "old", model: "reviewer" });
  assert.equal(settings.get("router"), null, "the accidentally armed router is ignored");
  assert.throws(() => settings.write("router", { provider: "x", model: "y" }), /unknown host binding/);

  settings.write("qa", { provider: "new", model: "mini-qa", effort: "high" });
  const persisted = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(persisted.schema, WORKFLOW_SETTINGS_SCHEMA);
  assert.deepEqual(Object.keys(persisted.roles), HOST_ROLES);
  assert.deepEqual(persisted.roles.qa, { provider: "new", model: "mini-qa", effort: "high" });
  assert.equal(persisted.land, undefined);
  assert.equal(persisted.iterate, undefined);
  assert.equal(persisted.base, undefined);
  assert.deepEqual(persisted.pluginDocs, { cadence: 60 }, "adopted-plugin settings survive host writes");

  assert.deepEqual(Object.keys(SETTINGS_ROLES), ["architect", "base"]);
  assert.deepEqual(
    completeWorkflowsInput("settings architect ", { names: ["architect", "find", "base"] }).candidates,
    HOST_ROLES,
  );

  console.log("host settings: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
