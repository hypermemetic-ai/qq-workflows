#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const ACTIVE_ROLES = ["architect", "implementer", "reviewer"];
const RETIRED_ROLES = ["teacher", "researcher"];

// 1. Verify retired roles do not exist
for (const role of RETIRED_ROLES) {
  assert.ok(!existsSync(join(repoRoot, "agents", role)), `Retired role ${role} must not exist`);
}

// 2. Verify all active roles exist and validate frontmatter & tools
for (const role of ACTIVE_ROLES) {
  const agentPath = join(repoRoot, "agents", role, "agent.md");
  assert.ok(existsSync(agentPath), `agent.md must exist for ${role}`);
  const content = readFileSync(agentPath, "utf8");
  assert.match(content, /^---\n/, `frontmatter start in ${role}`);
  assert.match(content, new RegExp(`name:\\s*${role}`), `name in ${role}`);
  assert.doesNotMatch(content, /inheritMcp/, `inheritMcp must be removed from ${role}`);
}

// 3. Architect checks
const architectContent = readFileSync(join(repoRoot, "agents", "architect", "agent.md"), "utf8");
assert.match(architectContent, /write_to_file/);
assert.match(architectContent, /replace_file_content/);
assert.match(architectContent, /run_command/);
assert.match(architectContent, /invoke_subagent/);
assert.match(architectContent, /send_message/);
assert.match(architectContent, /view_file/);
assert.match(architectContent, /grep_search/);
assert.match(architectContent, /prepare_worktree/);
assert.match(architectContent, /land/);
assert.match(architectContent, /The ticket is `\.architect\/tickets\/<sessionId>\.md`/);
assert.match(architectContent, /## Teaching/);
assert.match(architectContent, /teach until the user is informed enough to decide/);
assert.match(architectContent, /call `prepare_worktree`/);
assert.match(architectContent, /call `land`/);

// 4. Implementer checks
const implementerContent = readFileSync(join(repoRoot, "agents", "implementer", "agent.md"), "utf8");
assert.match(implementerContent, /write_to_file/);
assert.match(implementerContent, /replace_file_content/);
assert.match(implementerContent, /run_command/);
assert.match(implementerContent, /report your answer/);
assert.doesNotMatch(implementerContent, /call done/);

// 5. Reviewer checks
const reviewerContent = readFileSync(join(repoRoot, "agents", "reviewer", "agent.md"), "utf8");
assert.match(reviewerContent, /run_command/);
assert.doesNotMatch(reviewerContent, /write_to_file/);
assert.doesNotMatch(reviewerContent, /replace_file_content/);
assert.match(reviewerContent, /Report findings\. Empty findings means it passed\./);
assert.doesNotMatch(reviewerContent, /call done/);

console.log("agy-roles tests passed successfully.");
