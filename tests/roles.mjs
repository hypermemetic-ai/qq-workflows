#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const anchors = {
  architect: ["Own scope and consequential tradeoffs", "After explicit operator approval", "recover missed deliveries"],
  runner: ["Own the assigned investigation", "Distinguish observations from recommendations"],
  implementer: ["using the supplied ticket path", "Leave changes uncommitted", "Do not claim verification"],
  reviewer: ["independent reviewer", "Own verification through completion", "Return PASS or FAIL"],
};
for (const role of ["architect", "runner", "implementer", "reviewer"]) {
  const file = join(root, "agents", role, "agent.md");
  const text = readFileSync(file, "utf8");
  const [frontmatter, body] = text.split("\n---\n\n");
  assert.match(frontmatter, new RegExp(`^---\\nname: ${role}\\n`));
  assert.match(frontmatter, /inheritMcp: true/);
  for (const anchor of anchors[role]) assert.ok(body.includes(anchor), `${role}: ${anchor}`);
  assert.doesNotMatch(body, /## Teaching|milestone|mcp__/, `no old policy in ${role}`);
}
for (const retired of ["teacher", "researcher"]) assert.equal(existsSync(join(root, "agents", retired)), false);
console.log("roles tests passed successfully.");
