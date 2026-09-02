#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createResearchWorkspace, materializeEvidence } from "../src/research-evidence.mjs";
import {
  createResearchOracle,
  RESEARCH_ORACLE_ENUMERATION_LIMIT,
} from "../src/research-oracle.mjs";
import { MINI_QA_TOOL_NAMES } from "../src/mini-qa.mjs";

function flood(dir, count, contents = "flood") {
  mkdirSync(dir, { recursive: true });
  for (let index = 0; index < count; index++) writeFileSync(join(dir, `f${index}.txt`), contents);
}

const scratch = mkdtempSync(join(tmpdir(), "qq-research-oracle."));
const repo = join(scratch, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(repo, "src", "fact.mjs"), "export const fact = 'repository truth';\n");
const workspace = await createResearchWorkspace({ parentDir: join(scratch, "runs"), repoRoot: repo, question: "What is the truth?" });
writeFileSync(workspace.answer, "The answer claims a truth [W001].\n");
await materializeEvidence(workspace, {
  ref: "W001", surface: "web", source: "https://example.test", markdown: "# Source\n\nmaterialized truth\n",
});
const oracle = createResearchOracle(workspace.root);
assert.equal(typeof oracle.webSearch, "undefined");
assert.equal(typeof oracle.sessionSearch, "undefined");
assert.deepEqual(MINI_QA_TOOL_NAMES, ["bash", "submit_review", "session_history"]);
assert.match(await oracle.glob({ pattern: "**/*.md" }), /answer\.md/);
assert.match(await oracle.glob({ pattern: "answer.md" }), /^MATCHES 1\nanswer\.md$/);
assert.match(await oracle.grep({ query: "materialized truth", path: "evidence" }), /evidence\/web\/W001\.md/);
assert.match(await oracle.grep({ query: "repository truth", path: "repo" }), /repo\/src\/fact\.mjs/);
assert.match(await oracle.view({ path: "question.md", start_line: 1, end_line: 10 }), /What is the truth/);
assert.rejects(() => oracle.view({ path: "../secret", start_line: 1, end_line: 1 }), /must not contain/);
assert.deepEqual(await oracle.validateFindings([]), []);
assert.deepEqual(await oracle.validateFindings([{ path: "answer.md", line: 1, body: "citation does not entail claim" }]), [
  { path: "answer.md", line: 1, body: "citation does not entail claim" },
]);

flood(join(repo, "node_modules", "pkg"), RESEARCH_ORACLE_ENUMERATION_LIMIT + 1, "vendor secret");
const afterVendorGlob = await oracle.glob({ pattern: "answer.md" });
assert.equal(afterVendorGlob, "MATCHES 1\nanswer.md");
const afterVendorBroad = await oracle.glob({ pattern: "**/*.txt" });
assert.match(afterVendorBroad, /^MATCHES 0$/);
assert.doesNotMatch(afterVendorBroad, /node_modules/);
const afterVendorGrep = await oracle.grep({ query: "materialized truth" });
assert.match(afterVendorGrep, /evidence\/web\/W001\.md/);
assert.doesNotMatch(afterVendorGrep, /enumeration limit/);
assert.equal(await oracle.grep({ query: "vendor secret" }), "MATCHES 0");

flood(join(repo, "flood"), RESEARCH_ORACLE_ENUMERATION_LIMIT + 1, "flood marker");
const literal = await oracle.glob({ pattern: "answer.md" });
assert.equal(literal, "MATCHES 1\nanswer.md");
const unscoped = await oracle.grep({ query: "materialized truth" });
assert.match(unscoped, /evidence\/web\/W001\.md/);
assert.doesNotMatch(unscoped, /enumeration limit/);
const truncatedGlob = await oracle.glob({ pattern: "repo/flood/*.txt" });
assert.match(truncatedGlob, /TRUNCATED/);
assert.doesNotMatch(truncatedGlob, /enumeration limit/);
const truncatedGrep = await oracle.grep({ query: "flood marker" });
assert.match(truncatedGrep, /TRUNCATED/);
assert.doesNotMatch(truncatedGrep, /enumeration limit/);

console.log("research oracle: ok");
