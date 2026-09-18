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
  assert.match(content, /inheritMcp:\s*true/, `inheritMcp must be in ${role}`);
}

// 3. Architect checks
const architectContent = readFileSync(join(repoRoot, "agents", "architect", "agent.md"), "utf8");
assert.match(architectContent, /mainAgent:\s*true/);
assert.match(architectContent, /inheritMcp:\s*true/);
assert.match(architectContent, /write_to_file/);
assert.doesNotMatch(architectContent, /replace_file_content/);
assert.doesNotMatch(architectContent, /ticket_read/);
assert.doesNotMatch(architectContent, /ticket_write/);
assert.match(architectContent, /run_command/);
assert.match(architectContent, /invoke_subagent/);
assert.match(architectContent, /send_message/);
assert.match(architectContent, /view_file/);
assert.match(architectContent, /grep_search/);
assert.match(architectContent, /find_by_name/);
assert.match(architectContent, /list_dir/);
assert.match(architectContent, /read_url_content/);
assert.match(architectContent, /search_web/);

const frontmatterMatch = architectContent.match(/^---\n([\s\S]*?)\n---/);
const frontmatter = frontmatterMatch ? frontmatterMatch[1] : "";
const toolsMatch = frontmatter.match(/tools:\n([\s\S]*?)(?:\n[a-zA-Z0-9_-]+:|$)/);
const toolsList = toolsMatch
  ? toolsMatch[1]
      .split("\n")
      .filter((l) => l.trim().startsWith("- "))
      .map((l) => l.trim().replace(/^-\s*/, ""))
  : [];
assert.deepEqual(toolsList, [
  "view_file",
  "write_to_file",
  "run_command",
  "grep_search",
  "find_by_name",
  "list_dir",
  "read_url_content",
  "search_web",
  "invoke_subagent",
  "send_message",
]);

assert.match(architectContent, /The ticket is `\.architect\/tickets\/<sessionId>\.md`/);
assert.match(architectContent, /## Teaching/);
assert.match(architectContent, /teach until the user is informed enough to decide/);
assert.match(architectContent, /call `dispatch_execution\(kind\)`/);
assert.match(architectContent, /await_execution/);
assert.match(architectContent, /dispatch_runner/);
assert.match(architectContent, /Ask questions one at a time with recommendations\./);
assert.match(architectContent, /Populate ticket and testing plan collaboratively with the operator\./);
assert.doesNotMatch(architectContent, /RequestFeedback: false/);
assert.match(
  architectContent,
  /Do not call `dispatch_execution` until the operator explicitly approves\./,
);
assert.match(architectContent, /When the operator approves the ticket, call `dispatch_execution\(kind\)`\./);
assert.doesNotMatch(architectContent, /prepare_worktree/);
assert.doesNotMatch(architectContent, /call `land`/);

// 4. Implementer checks
const implementerContent = readFileSync(join(repoRoot, "agents", "implementer", "agent.md"), "utf8");
assert.match(implementerContent, /write_to_file/);
assert.match(implementerContent, /replace_file_content/);
assert.match(implementerContent, /run_command/);
assert.match(implementerContent, /Implement \.architect\/ticket\.md\./);
assert.match(implementerContent, /Leave changes uncommitted\. Do not commit, push, review, or land\./);
assert.match(implementerContent, /report your answer/);
assert.doesNotMatch(implementerContent, /call done/);

// 5. Reviewer checks
const reviewerContent = readFileSync(join(repoRoot, "agents", "reviewer", "agent.md"), "utf8");
assert.match(reviewerContent, /run_command/);
assert.doesNotMatch(reviewerContent, /write_to_file/);
assert.doesNotMatch(reviewerContent, /replace_file_content/);
assert.match(reviewerContent, /Do not commit, push, or land\./);
assert.doesNotMatch(reviewerContent, /Empty findings means it passed/);
assert.match(reviewerContent, /Execute the testing plan to completion/);
assert.match(reviewerContent, /Actively await background verification tasks/);
assert.match(reviewerContent, /Incomplete tests are not code defects/);
assert.match(reviewerContent, /Verdict: PASS or FAIL/);
assert.doesNotMatch(reviewerContent, /call done/);

console.log("roles tests passed successfully.");
