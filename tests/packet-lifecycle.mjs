#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDelegationStore } from "../src/delegation-store.mjs";
import { runCommand, slugFor } from "../src/git.mjs";
import {
  DELEGATION_OUTCOME_MAX_CHARS,
  PHASE_DELTA_MAX_CHARS,
  createLand,
  formatOutcome,
  renderDelegationPhaseTask,
} from "../src/land.mjs";
import { renderMiniSweTask } from "../src/mini-swe-v2.mjs";
import {
  PACKET_FILE_PREVIEW_LIMIT,
  PACKET_FORMAT_MAX_CHARS,
  PACKET_LINE_MAX_CHARS,
  boundFormattedText,
  formatPacket,
} from "../src/proposal-packet.mjs";
import { materializeTaskArtifact, taskDigest } from "../src/task-artifact.mjs";

const taskMarker = "MAXIMUM_TASK_UNIQUE_MARKER";
const task = `# Lifecycle redesign\n\n${taskMarker}\n${"T".repeat(24_000 - taskMarker.length - 23)}`;
assert.equal(task.length, 24_000);
const firstPrompt = renderMiniSweTask(task, { system: "Test", release: "1", version: "1", machine: "x" });
assert.equal(firstPrompt.split(taskMarker).length - 1, 1, "the first implementation prompt contains the exact task once");
assert.doesNotMatch(firstPrompt, /Delegation ID \(authoritative\)|Authoritative parent session UUID|auto-return/i);
assert.ok(slugFor(task, "session-12345678").startsWith("lifecycle-redesign-"), "slug derives from the semantic title");
assert.ok(!slugFor(task, "session-12345678").startsWith("delegation-id-"));

const manyFiles = Array.from({ length: 1_000 }, (_, index) => ({
  path: `${"very-long-directory/".repeat(20)}file-${index}-${"x".repeat(300)}.mjs`,
  added: index,
  deleted: index + 1,
}));
const packet = {
  schema: "qq.delegation-packet/v1",
  fileCount: manyFiles.length,
  omittedFiles: manyFiles.length - PACKET_FILE_PREVIEW_LIMIT,
  files: manyFiles,
  pointers: manyFiles.slice(0, 100).map((file, index) => `${file.path}:${index + 1} ${"context".repeat(100)}`),
  pointersOmitted: true,
  mark: "review",
};
const proposal = formatPacket(packet);
assert.ok(proposal.length <= PACKET_FORMAT_MAX_CHARS);
assert.match(proposal, /Changed files: 1000 total; 24 shown; 976 omitted/);
assert.match(proposal, /\[976 changed files omitted from preview\]/);
assert.match(proposal, /additional hunk pointers omitted/);
for (const line of proposal.split("\n")) {
  if (line.includes("file-") || line.includes("context")) assert.ok(line.length <= PACKET_LINE_MAX_CHARS + 30);
}
assert.doesNotMatch(proposal, new RegExp(taskMarker));

const feedback = `QA_FEEDBACK_MARKER ${"F".repeat(8_000)}`;
const delta = boundFormattedText(feedback, PHASE_DELTA_MAX_CHARS, "phase delta");
assert.equal(delta.length, PHASE_DELTA_MAX_CHARS);
assert.match(delta, /phase delta omitted [0-9]+ chars/);
const phaseInput = {
  schema: "qq.delegation-phase-input/v1",
  taskArtifact: ".git/qq-workflows/task.md",
  taskSha256: taskDigest(task),
  proposal,
  delta,
};
const phasePrompts = new Map();
for (const role of ["qa", "implementation"]) {
  const prompt = renderDelegationPhaseTask({ role, input: phaseInput, message: "" });
  phasePrompts.set(role, prompt);
  assert.match(prompt, /Exact task artifact: \.git\/qq-workflows\/task\.md/);
  assert.match(prompt, new RegExp(taskDigest(task)));
  assert.match(prompt, /QA_FEEDBACK_MARKER/);
  assert.doesNotMatch(prompt, new RegExp(taskMarker));
  assert.doesNotMatch(prompt, /Delegation ID \(authoritative\)|parent session|child session/i);
}
const legacyMessage = `legacy pending bytes\n${taskMarker}\nunchanged`;
assert.equal(renderDelegationPhaseTask({ role: "qa", message: legacyMessage }), legacyMessage);

const outcome = formatOutcome({
  delegationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  ref: "a".repeat(40),
  baseBranch: "main",
  brief: task,
  packet: { ...packet, brief: undefined },
  qaVerdict: { verdict: "pass", summary: "checked", feedback, tests_modified: false },
}, "landed");
assert.ok(outcome.length <= DELEGATION_OUTCOME_MAX_CHARS);
assert.match(outcome, /Implementation delegation .*: landed/);
assert.match(outcome, /Ref: a{40}/);
assert.match(outcome, /QA verdict: pass/);
assert.doesNotMatch(outcome, new RegExp(taskMarker));
assert.doesNotMatch(outcome, /Parent session|Workflow child session|Phase epoch|authoritative/i);
const passingTraffic = firstPrompt.length + phasePrompts.get("qa").length + outcome.length;
const revisionTraffic = passingTraffic + phasePrompts.get("implementation").length + phasePrompts.get("qa").length;
assert.ok(passingTraffic < 78_230 * 0.8, `passing traffic should materially beat baseline, got ${passingTraffic}`);
assert.ok(revisionTraffic < 148_171 * 0.8, `revision traffic should materially beat baseline, got ${revisionTraffic}`);
assert.equal([phasePrompts.get("qa"), phasePrompts.get("implementation"), outcome].join("\n").includes(taskMarker), false);

const root = mkdtempSync(join(tmpdir(), "qq-packet-lifecycle."));
const repo = join(root, "repo");
const storeDir = join(root, "store");
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "packet-test",
  GIT_AUTHOR_EMAIL: "packet@test.invalid",
  GIT_COMMITTER_NAME: "packet-test",
  GIT_COMMITTER_EMAIL: "packet@test.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
try {
  execFileSync("git", ["init", "-b", "main", repo], { env, stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repo, "add", "README.md"], { env });
  execFileSync("git", ["-C", repo, "commit", "-m", "fixture"], { env, stdio: "ignore" });
  const run = (command, args, options = {}) => runCommand(command, args, { ...options, env });
  let artifact = await materializeTaskArtifact(run, { worktree: repo, task });
  assert.equal(readFileSync(artifact.path, "utf8"), task);
  assert.equal(artifact.sha256, taskDigest(task));
  assert.equal(execFileSync("git", ["-C", repo, "status", "--porcelain"], { env, encoding: "utf8" }), "");
  writeFileSync(artifact.path, "child tampering");
  artifact = await materializeTaskArtifact(run, { worktree: repo, task, expectedDigest: artifact.sha256 });
  assert.equal(readFileSync(artifact.path, "utf8"), task, "host rematerializes exact task after child tampering");
  const outside = join(root, "outside");
  mkdirSync(outside);
  rmSync(join(repo, ".git", "qq-workflows"), { recursive: true, force: true });
  symlinkSync(outside, join(repo, ".git", "qq-workflows"), "dir");
  artifact = await materializeTaskArtifact(run, { worktree: repo, task, expectedDigest: artifact.sha256 });
  assert.equal(readFileSync(artifact.path, "utf8"), task, "host replaces a child-created metadata symlink");
  assert.equal(existsSync(join(outside, "task.md")), false, "artifact writer never follows metadata symlinks");

  const adoptionStore = createDelegationStore(join(root, "adoption-store"));
  const adoptedId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const adoptedChildId = "session-55555555-5555-4555-8555-555555555555";
  const adoptedParentId = "session-66666666-6666-4666-8666-666666666666";
  const land = createLand({
    ctx: { get() { return null; }, logger: { info() {}, warn() {} } },
    store: adoptionStore,
    run,
    agents: { get() { return null; }, list() { return []; } },
  });
  const adopted = await land.adoptImplementation({
    session: { id: adoptedChildId, header: { cwd: repo } },
    ctx: {},
  }, {
    cwd: repo,
    brief: task,
    delegationId: adoptedId,
    parentSession: adoptedParentId,
  });
  assert.equal(adopted.status, "ok", adopted.reason);
  const adoptedRecord = adoptionStore.load(adoptedId);
  assert.equal(adoptedRecord.brief, task, "adoption persists only semantic task bytes");
  assert.equal(readFileSync(adoptedRecord.taskArtifact.path, "utf8"), task, "adoption creates exact task artifact before first prompt");
  assert.equal(adoptedRecord.taskArtifact.sha256, taskDigest(task));
  const structuredPending = {
    sessionUuid: "session-77777777-7777-4777-8777-777777777777",
    role: "qa",
    phaseEpoch: 2,
    messageId: "88888888-8888-4888-8888-888888888888",
    message: "",
    input: phaseInput,
    messageDelivered: false,
  };
  adoptionStore.save({ ...adoptedRecord, transitioning: true, pendingPhase: structuredPending });
  assert.deepEqual(adoptionStore.load(adoptedId).pendingPhase.input, phaseInput, "structured phase input survives a durable round trip");
  assert.equal(adoptionStore.load(adoptedId).pendingPhase.message, "");
  await land.dispose();

  const store = createDelegationStore(storeDir);
  const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const parent = "session-11111111-1111-4111-8111-111111111111";
  const current = "session-22222222-2222-4222-8222-222222222222";
  const pending = "session-33333333-3333-4333-8333-333333333333";
  store.create({
    id,
    delegationId: id,
    parentSessionUuid: parent,
    implementationSession: current,
    brief: task,
    worktree: repo,
    taskArtifact: artifact,
    transitioning: true,
    pendingPhase: {
      sessionUuid: pending,
      role: "qa",
      phaseEpoch: 2,
      messageId: "44444444-4444-4444-8444-444444444444",
      message: legacyMessage,
      messageDelivered: false,
    },
  });
  assert.equal(store.load(id).pendingPhase.message, legacyMessage, "legacy pre-rendered pending bytes survive normalization");
  const unrelated = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  writeFileSync(store.fileFor(unrelated), "not json\n");
  assert.equal(store.byDelegation(id).id, id, "canonical lookup does not scan malformed historical records");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("packet lifecycle: ok");
