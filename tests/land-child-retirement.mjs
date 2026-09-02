#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_HANDLE } from "../src/agent-handle.mjs";
import { armChildSettlement } from "../src/child-settlement.mjs";
import { createDelegationStore } from "../src/delegation-store.mjs";
import { runCommand } from "../src/git.mjs";
import { createLand } from "../src/land.mjs";
import { createQaVerdict } from "../src/qa-verdict.mjs";

const PARENT = "session-91000000-0000-4000-8000-000000000001";
const IMPLEMENTATION = "session-91000000-0000-4000-8000-000000000002";
const QA_PASS = "session-91000000-0000-4000-8000-000000000003";
const QA_FAIL = "session-91000000-0000-4000-8000-000000000004";
const PASS_DELEGATION = "92000000-0000-4000-8000-000000000001";
const FAIL_DELEGATION = "92000000-0000-4000-8000-000000000002";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function toolHarness() {
  const definitions = new Map([["bash", {
    name: "bash",
    description: "fixture bash",
    parameters: { type: "object", properties: { command: { type: "string" } } },
    async execute() { return { output: "" }; },
  }]]);
  return {
    definitions,
    tools: {
      get(name) { return definitions.get(name); },
      schemas() { return [...definitions.values()].map(({ name }) => ({ name })); },
      register(definition) {
        const prior = definitions.get(definition.name);
        definitions.set(definition.name, definition);
        return () => prior ? definitions.set(definition.name, prior) : definitions.delete(definition.name);
      },
    },
  };
}

function qaChild({ id, delegationId, cwd, epoch = 2 }) {
  const { definitions, tools } = toolHarness();
  const listeners = [];
  let disposeCount = 0;
  let cancelCount = 0;
  const agent = {
    id,
    status: "running",
    inbox: { nextTurn: [], nextStep: [] },
    session: {
      id,
      events: [],
      header: {
        cwd,
        parentSession: PARENT,
        origin: "subagent",
        delegationRole: "qa",
        delegationPhaseRole: "qa",
        delegationId,
        delegationPhaseEpoch: epoch,
        kind: "mini-qa",
        agentPreset: "mini-qa",
      },
      append(type, data) { this.events.push({ type, data }); },
    },
    followup(message) { this.inbox.nextTurn.push(message); },
    steer(message) { this.inbox.nextStep.push(message); },
    cancel() { cancelCount++; },
  };
  const systemPrompt = { section() { return () => {}; }, suppressRuntimeContext() {} };
  agent.ctx = {
    agent,
    tools,
    systemPrompt,
    get(name) {
      if (name === "tools") return tools;
      if (name === "systemPrompt") return systemPrompt;
      if (name === "qq-core") return { surface: { allow() {} } };
      if (name === "sandboxPolicy") return { resolve() { return { mode: "read-only", workspaceRoot: cwd }; } };
      if (name === "shell") return { sandboxMode: "read-only" };
      if (name === "sandbox") return { confine() { return { enforcement: "full" }; } };
      return null;
    },
    on(type, listener) {
      const record = { type, listener };
      listeners.push(record);
      return () => {
        const index = listeners.indexOf(record);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    async emit(type, ...args) {
      for (const record of [...listeners]) {
        if (record.type === type) await record.listener(...args);
      }
    },
  };
  const handle = {
    agent,
    // Production AgentHandle semantics: disposal drains ownership but does not
    // detach the Agent from the live Agents registry.
    async dispose() { disposeCount++; },
  };
  Object.defineProperty(agent, AGENT_HANDLE, { value: handle, configurable: true });
  return {
    agent,
    definitions,
    handle,
    disposeCount: () => disposeCount,
    cancelCount: () => cancelCount,
  };
}

function registryWith(fixture) {
  const id = fixture.agent.session.id;
  const live = new Map([[id, fixture.agent]]);
  const entry = { id, agent: fixture.agent, announced: true };
  const entries = new Map([[id, entry]]);
  let detachCount = 0;
  return {
    store: entries,
    get(candidateId) { return live.get(candidateId) ?? null; },
    list() { return [...live.values()]; },
    detachEntered(candidate) {
      if (entries.get(candidate.id) !== candidate) return;
      entries.delete(candidate.id);
      live.delete(candidate.id);
      detachCount++;
    },
    detachCount: () => detachCount,
  };
}

function context(sent) {
  return {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === "qq-relay") return {
        async send(message) { sent.push(message); return { status: "sent" }; },
      };
      return null;
    },
  };
}

function reviewingState(store, {
  delegationId,
  qaSession,
  mainRoot,
  worktree,
  baseRef,
  ref,
  branch,
  look,
}) {
  return store.create({
    delegationId,
    parentSessionUuid: PARENT,
    architectSession: PARENT,
    status: "reviewing",
    look,
    implementationSession: IMPLEMENTATION,
    originalImplementationSession: IMPLEMENTATION,
    qaSession,
    phaseEpoch: 2,
    current: { sessionUuid: qaSession, role: "qa", phaseEpoch: 2 },
    brief: "retire the completed QA child",
    packet: {
      schema: "qq.delegation-packet/v1",
      fileCount: 1,
      omittedFiles: 0,
      files: [{ path: "change.txt", added: 1, deleted: 0 }],
      pointers: [],
      pointersOmitted: false,
      mark: "review",
    },
    worktree,
    workspace: worktree,
    mainRoot,
    branch,
    baseBranch: "main",
    baseRef,
    ref,
  });
}

async function commitToolResult(fixture, callId, { isError = false } = {}) {
  const message = {
    role: "user",
    source: { kind: "tool", callId },
    content: [{ type: "tool-result", toolCallId: callId, isError, content: [] }],
  };
  const event = { type: "tool/result", data: { message } };
  fixture.agent.session.events.push(event);
  await fixture.agent.ctx.emit("session/event", fixture.agent.session, event);
}

async function setIdle(fixture) {
  fixture.agent.status = "idle";
  await fixture.agent.ctx.emit("agent/status", { agent: fixture.agent, status: "idle" });
}

function assertLive(registry, fixture, message) {
  const id = fixture.agent.session.id;
  assert.equal(registry.get(id), fixture.agent, message);
  assert.equal(registry.list().includes(fixture.agent), true, message);
  assert.equal(registry.store.get(id)?.agent, fixture.agent, message);
}

const root = mkdtempSync(join(tmpdir(), "qq-land-child-retirement."));
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "lifecycle-test",
  GIT_AUTHOR_EMAIL: "lifecycle@test.invalid",
  GIT_COMMITTER_NAME: "lifecycle-test",
  GIT_COMMITTER_EMAIL: "lifecycle@test.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};
for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"]) {
  delete gitEnv[name];
}
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { env: gitEnv, encoding: "utf8" }).trim();

try {
  // Final QA pass: its exact durable tool result arrives before idle. Use real
  // Git publication/landing so this follows the operator-observed terminal path.
  const origin = join(root, "origin.git");
  const mainRoot = join(root, "main");
  const worktree = join(root, "proposal");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", origin], { env: gitEnv, stdio: "ignore" });
  execFileSync("git", ["clone", origin, mainRoot], { env: gitEnv, stdio: "ignore" });
  git(mainRoot, "config", "user.name", "lifecycle-test");
  git(mainRoot, "config", "user.email", "lifecycle@test.invalid");
  writeFileSync(join(mainRoot, "README.md"), "base\n");
  git(mainRoot, "add", "README.md");
  git(mainRoot, "commit", "-m", "base");
  git(mainRoot, "push", "-u", "origin", "main");
  const baseRef = git(mainRoot, "rev-parse", "HEAD");

  execFileSync("git", ["clone", origin, worktree], { env: gitEnv, stdio: "ignore" });
  git(worktree, "config", "user.name", "lifecycle-test");
  git(worktree, "config", "user.email", "lifecycle@test.invalid");
  const branch = "feat/retire-final-qa";
  git(worktree, "checkout", "-b", branch);
  writeFileSync(join(worktree, "change.txt"), "completed\n");
  git(worktree, "add", "change.txt");
  git(worktree, "commit", "-m", "complete lifecycle fix");
  const candidate = git(worktree, "rev-parse", "HEAD");

  const passStore = createDelegationStore(join(root, "pass-store"));
  reviewingState(passStore, {
    delegationId: PASS_DELEGATION,
    qaSession: QA_PASS,
    mainRoot,
    worktree,
    baseRef,
    ref: candidate,
    branch,
    look: 1,
  });
  const passFixture = qaChild({ id: QA_PASS, delegationId: PASS_DELEGATION, cwd: worktree });
  const passRegistry = registryWith(passFixture);
  const sent = [];
  const run = (command, args, options = {}) => runCommand(command, args, {
    ...options,
    env: { ...gitEnv, ...(options.env ?? {}) },
  });
  const github = {
    async openPullRequest() { return "https://github.invalid/example/repo/pull/1"; },
    async mergePullRequest() {
      git(mainRoot, "fetch", "origin", branch);
      git(mainRoot, "merge", "--no-ff", `origin/${branch}`, "-m", "merge proposal");
      git(mainRoot, "push", "origin", "main");
    },
  };
  const passLand = createLand({
    ctx: context(sent),
    store: passStore,
    agents: passRegistry,
    run,
    github,
    env: gitEnv,
  });
  assert.equal(passLand.resumeChild(passFixture.agent), true);
  const submit = passFixture.definitions.get("submit_review");
  assert.ok(submit, "resumed QA installs its completion tool");
  const passCallId = "final-qa-pass-call";
  const passResult = await submit.execute({ findings: [] }, {
    agent: passFixture.agent,
    callId: passCallId,
    concludeTurn() {},
  });
  assert.equal(passResult.status, "ok", passResult.reason);
  assert.equal(passResult.verdict, "pass");
  assert.equal(passStore.load(PASS_DELEGATION).settlementCallId, passCallId);
  assertLive(passRegistry, passFixture, "durable verdict alone must remain recoverable until its result commits and the child is idle");
  assert.equal(passFixture.disposeCount(), 0);

  await commitToolResult(passFixture, "unrelated-final-qa-call");
  await Promise.resolve();
  assertLive(passRegistry, passFixture, "an unrelated durable result cannot retire final QA");
  assert.equal(passFixture.disposeCount(), 0);

  await commitToolResult(passFixture, passCallId);
  await Promise.resolve();
  assertLive(passRegistry, passFixture, "the matching result cannot retire a still-running final QA child");
  assert.equal(passFixture.disposeCount(), 0);

  await setIdle(passFixture);
  assert.equal(await passLand.whenSettled(QA_PASS), true);
  const landed = passStore.load(PASS_DELEGATION);
  assert.equal(landed.status, "landed");
  assert.equal(landed.current, null);
  assert.equal(landed.settlementSession, "");
  assert.equal(passRegistry.get(QA_PASS), null, "completed final QA is absent from agents.get");
  assert.equal(passRegistry.list().includes(passFixture.agent), false, "completed final QA is absent from agents.list");
  assert.equal(passRegistry.store.has(QA_PASS), false, "completed final QA is detached from the concrete registry");
  assert.equal(passRegistry.detachCount(), 1);
  assert.equal(passFixture.disposeCount(), 1);
  assert.equal(passFixture.cancelCount(), 0, "idle completion teardown does not use force cancellation");
  assert.deepEqual(passLand.ownedChildren(), []);
  assert.equal(sent.length, 1, "terminal landing reports exactly once");
  await passLand.dispose();

  // HMR/restart cleanup also retires a historical idle child leaked by an older
  // controller after its delegation was already durably landed. It must never
  // re-adopt or reactivate that terminal session.
  const staleFixture = qaChild({ id: QA_PASS, delegationId: PASS_DELEGATION, cwd: worktree });
  staleFixture.agent.status = "idle";
  const staleRegistry = registryWith(staleFixture);
  const staleLand = createLand({
    ctx: context([]),
    store: passStore,
    agents: staleRegistry,
    run,
    github,
    env: gitEnv,
  });
  assert.equal(staleLand.resumeChild(staleFixture.agent), true);
  assert.equal(staleRegistry.get(QA_PASS), null, "HMR cleanup detaches a stale durably landed child");
  assert.equal(staleRegistry.list().includes(staleFixture.agent), false);
  assert.equal(staleRegistry.store.has(QA_PASS), false);
  assert.equal(staleFixture.cancelCount(), 1, "stale terminal recovery uses immediate force retirement");
  await Promise.resolve();
  assert.equal(staleFixture.disposeCount(), 1);
  assert.equal(passStore.load(PASS_DELEGATION).status, "landed");
  assert.deepEqual(staleLand.ownedChildren(), []);
  await staleLand.dispose();

  // Final QA look 2 rejection: idle arrives first. This uses the same terminal
  // disposal transition while isolating the ordering and exact-call gates.
  const blockedMain = join(root, "blocked-main");
  const blockedWorktree = join(root, "blocked-worktree");
  mkdirSync(blockedMain);
  mkdirSync(blockedWorktree);
  const failStore = createDelegationStore(join(root, "fail-store"));
  reviewingState(failStore, {
    delegationId: FAIL_DELEGATION,
    qaSession: QA_FAIL,
    mainRoot: blockedMain,
    worktree: blockedWorktree,
    baseRef: BASE,
    ref: HEAD,
    branch: "feat/blocked-final-qa",
    look: 2,
  });
  const failFixture = qaChild({ id: QA_FAIL, delegationId: FAIL_DELEGATION, cwd: blockedWorktree });
  const failRegistry = registryWith(failFixture);
  const failRun = async (_command, args) => {
    if (args[0] === "status") return { code: 0, stdout: "", stderr: "" };
    if (args[0] === "rev-parse") return { code: 0, stdout: `${HEAD}\n`, stderr: "" };
    throw new Error(`unexpected final-QA command: ${args.join(" ")}`);
  };
  const failLand = createLand({
    ctx: context([]),
    store: failStore,
    agents: failRegistry,
    run: failRun,
    env: gitEnv,
  });
  assert.equal(failLand.resumeChild(failFixture.agent), true);
  const failResult = await failLand.submitVerdict({
    agent: failFixture.agent,
    delegationId: FAIL_DELEGATION,
    postTool: true,
    verdict: createQaVerdict({
      verdict: "fail",
      summary: "final QA rejected the proposal",
      feedback: "a blocking finding remains",
      tests_modified: false,
    }),
  });
  const failCallId = "final-qa-fail-call";
  assert.equal(armChildSettlement(failResult, { callId: failCallId }), true);
  assert.equal(failStore.load(FAIL_DELEGATION).status, "blocked");
  assertLive(failRegistry, failFixture, "terminal durable state alone does not bypass the result and idle gates");

  await setIdle(failFixture);
  await Promise.resolve();
  assertLive(failRegistry, failFixture, "idle before the exact result remains recoverable");
  assert.equal(failFixture.disposeCount(), 0);

  await commitToolResult(failFixture, "wrong-final-qa-call");
  await Promise.resolve();
  assertLive(failRegistry, failFixture, "idle plus an unrelated result cannot settle final QA");
  assert.equal(failFixture.disposeCount(), 0);

  await commitToolResult(failFixture, failCallId);
  assert.equal(await failLand.whenSettled(QA_FAIL), true);
  const blocked = failStore.load(FAIL_DELEGATION);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.current, null);
  assert.equal(blocked.settlementSession, "");
  assert.equal(failRegistry.get(QA_FAIL), null);
  assert.equal(failRegistry.list().includes(failFixture.agent), false);
  assert.equal(failRegistry.store.has(QA_FAIL), false);
  assert.equal(failRegistry.detachCount(), 1);
  assert.equal(failFixture.disposeCount(), 1);
  assert.equal(failFixture.cancelCount(), 0);
  assert.deepEqual(failLand.ownedChildren(), []);

  // A replacement controller sees neither a live session to adopt nor a current
  // durable child to resume after terminal settlement.
  const replacement = createLand({
    ctx: context([]),
    store: failStore,
    agents: failRegistry,
    run: failRun,
    env: gitEnv,
  });
  for (const child of failRegistry.list()) replacement.resumeChild(child);
  assert.deepEqual(replacement.ownedChildren(), []);
  const resume = await replacement.workflowResume({ delegationId: FAIL_DELEGATION, parentSessionUuid: PARENT });
  assert.equal(resume.status, "refused");
  assert.match(resume.reason, /terminal|no current workflow child/);
  await replacement.dispose();
  await failLand.dispose();

  console.log("land child retirement: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
