#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PLUGIN_ROOT,
  ARCHITECT_ROLES,
  ARCHITECT_PROVIDER_ID,
  ARCHITECT_MODEL_ID,
  AGY_ROLE_ENTRY,
  ensureAgentsAndMcpInstalled,
  daemonConfigPatch,
} from "../paseo-plugin/host/config.mjs";
import {
  teacherCreateOptions,
  implementerCreateOptions,
  researcherCreateOptions,
  reviewerCreateOptions,
  AGY_PROVIDER_MODEL,
  AGY_THINKING,
} from "../paseo-plugin/host/workflow/children.mjs";
import { roleTools } from "../paseo-plugin/host/workflow/tools.mjs";

// 1. Check all 5 agent.md files exist and parse frontmatter
for (const role of ARCHITECT_ROLES) {
  const agentPath = join(PLUGIN_ROOT, "agents", role, "agent.md");
  assert.ok(existsSync(agentPath), `agent.md must exist for ${role}`);
  const content = readFileSync(agentPath, "utf8");
  assert.match(content, /^---\n/, `frontmatter start in ${role}`);
  assert.match(content, /\ninheritMcp:\s*true/, `inheritMcp true in ${role}`);
  assert.match(content, new RegExp(`name:\\s*${role}`), `name in ${role}`);
}

// 2. Check tool allowlists per role
const architectContent = readFileSync(join(PLUGIN_ROOT, "agents", "architect", "agent.md"), "utf8");
assert.doesNotMatch(architectContent, /write_to_file/);
assert.doesNotMatch(architectContent, /replace_file_content/);
assert.doesNotMatch(architectContent, /run_command/);
assert.doesNotMatch(architectContent, /invoke_subagent/);
assert.match(architectContent, /view_file/);
assert.match(architectContent, /grep_search/);
assert.doesNotMatch(architectContent, /Take notes and reasoning on the ticket/);

const teacherContent = readFileSync(join(PLUGIN_ROOT, "agents", "teacher", "agent.md"), "utf8");
assert.doesNotMatch(teacherContent, /write_to_file/);
assert.doesNotMatch(teacherContent, /replace_file_content/);
assert.doesNotMatch(teacherContent, /run_command/);

const implementerContent = readFileSync(join(PLUGIN_ROOT, "agents", "implementer", "agent.md"), "utf8");
assert.match(implementerContent, /write_to_file/);
assert.match(implementerContent, /replace_file_content/);
assert.match(implementerContent, /run_command/);

const researcherContent = readFileSync(join(PLUGIN_ROOT, "agents", "researcher", "agent.md"), "utf8");
assert.match(researcherContent, /run_command/);
assert.doesNotMatch(researcherContent, /write_to_file/);
assert.doesNotMatch(researcherContent, /replace_file_content/);

const reviewerContent = readFileSync(join(PLUGIN_ROOT, "agents", "reviewer", "agent.md"), "utf8");
assert.match(reviewerContent, /run_command/);
assert.doesNotMatch(reviewerContent, /write_to_file/);
assert.doesNotMatch(reviewerContent, /replace_file_content/);
assert.match(reviewerContent, /Follow its testing plan/);
assert.match(reviewerContent, /Call done with findings/);

// 3. MCP role isolation in roleTools
assert.deepEqual(roleTools(undefined), []);
assert.deepEqual(roleTools("unknown"), []);
assert.deepEqual(roleTools("implementer").map(t => t.name), ["done"]);
assert.deepEqual(roleTools("reviewer").map(t => t.name), ["done"]);
assert.ok(roleTools("architect").some(t => t.name === "ticket_write"));
assert.ok(roleTools("architect").some(t => t.name === "delegate"));
assert.ok(roleTools("teacher").some(t => t.name === "ticket_read"));
assert.ok(roleTools("researcher").some(t => t.name === "run_command"));

// 4. Children createOptions check
const tOpts = teacherCreateOptions({ jobId: "j1", hostUrl: "http://127.0.0.1", workspace: "/tmp", args: { parked_question: "q", direction: "d", informed_enough: "i" }, parent: "p1" });
assert.equal(tOpts.config.provider, AGY_PROVIDER_MODEL);
assert.equal(tOpts.config.thinkingOptionId, AGY_THINKING);

const iOpts = implementerCreateOptions({ jobId: "j2", hostUrl: "http://127.0.0.1", workspace: "/tmp", task: "t", kind: "bounded", parent: "p1" });
assert.equal(iOpts.config.provider, AGY_PROVIDER_MODEL);
assert.equal(iOpts.config.thinkingOptionId, AGY_THINKING);

const resOpts = researcherCreateOptions({ jobId: "j3", hostUrl: "http://127.0.0.1", workspace: "/tmp", question: "how to x", parent: "p1" });
assert.equal(resOpts.config.provider, AGY_PROVIDER_MODEL);
assert.equal(resOpts.config.thinkingOptionId, AGY_THINKING);
assert.equal(resOpts.title, "researcher");
assert.equal(resOpts.prompt, "how to x");

const revOpts = reviewerCreateOptions({ jobId: "j4", hostUrl: "http://127.0.0.1", workspace: "/tmp", parent: "p1" });
assert.equal(revOpts.config.provider, AGY_PROVIDER_MODEL);
assert.equal(revOpts.config.thinkingOptionId, AGY_THINKING);
assert.equal(revOpts.title, "reviewer");
assert.match(revOpts.prompt, /testing plan/);

console.log("agy-roles tests passed successfully.");
