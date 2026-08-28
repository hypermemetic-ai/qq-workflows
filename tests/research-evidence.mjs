#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkAnswerCitations,
  createResearchWorkspace,
  materializeEvidence,
  readManifest,
  sha256,
} from "../src/research-evidence.mjs";

const scratch = mkdtempSync(join(tmpdir(), "qq-research-evidence."));
const repo = join(scratch, "project");
mkdirSync(repo);
writeFileSync(join(repo, "fact.txt"), "repository fact\n");
const workspace = await createResearchWorkspace({ parentDir: join(scratch, "runs"), repoRoot: repo, question: "What is true?" });
assert.equal(statSync(workspace.root).mode & 0o077, 0);
assert.equal(readFileSync(workspace.question, "utf8"), "What is true?\n");
assert.deepEqual(await readManifest(workspace), []);

const body = "# Evidence\n\nA direct observation.\n";
const acquired = await materializeEvidence(workspace, {
  ref: "W001", surface: "web", source: "https://example.test/fact", markdown: body,
  fetchedAt: "2026-01-01T00:00:00.000Z",
});
assert.equal(acquired.sha256, sha256(body));
assert.equal((await readManifest(workspace)).length, 1);
const repeated = await materializeEvidence(workspace, {
  ref: "W001", surface: "web", source: "https://example.test/fact", markdown: body,
  fetchedAt: "2027-01-01T00:00:00.000Z",
});
assert.equal(repeated.existing, true);
assert.equal((await readManifest(workspace)).length, 1);

assert.equal((await checkAnswerCitations(workspace)).ok, false);
writeFileSync(workspace.answer, "Answer from an unfetched lead [W999].\n");
const unknown = await checkAnswerCitations(workspace);
assert.equal(unknown.ok, false);
assert.match(unknown.reason, /W999/);
writeFileSync(workspace.answer, "Direct evidence says this [W001]. Repository context: `repo/fact.txt`.\n");
const valid = await checkAnswerCitations(workspace);
assert.equal(valid.ok, true, valid.reason);
assert.deepEqual(valid.refs, ["W001"]);
console.log("research evidence: ok");
