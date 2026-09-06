#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as children from "../../paseo-plugin/host/children.mjs";
import { createRuntime as createHostRuntime, parseCreatedAgentJson, waitForHandleCwd } from "../../paseo-plugin/host/runtime.mjs";
import { SPAWN_ENTRY } from "../../paseo-plugin/host/config.mjs";
import { ticketWrite } from "../../paseo-plugin/host/ticket.mjs";
import { execFileWithInput, extractResearcherAnswer, formatResearcherFailure, researcherUserMessage, resolveMiniResearcher, runMiniResearcher } from "../../paseo-plugin/host/researcher.mjs";

// Routing assertions await host-owned work after checking the acknowledgement.
function createRuntime(options = {}) {
  const host = createHostRuntime(options);
  const handleTool = host.handleTool;
  host.handleTool = async (name, args, context) => {
    const result = await handleTool(name, args, name === "done" ? { ...context, jobId: args.jobId ?? context?.jobId, agentId: args.agentId ?? context?.agentId } : context);
    if (name !== "done") return result;
    assert.equal(result.accepted, true);
    await host.flush();
    return host.jobs.get(result.jobId).result;
  };
  const take = host.takeWakes;
  host.takeWakes = id => {
    const wakes = take(id);
    host.store.ack(id, wakes.map(wake => wake.id));
    return wakes.map(wake => wake.text);
  };
  return host;
}

assert.equal(Object.hasOwn(children, "researcherCreateOptions"), false);
assert.equal(Object.hasOwn(children, "reviewerCreateOptions"), false);
assert.equal(typeof children.implementerCreateOptions, "function");
assert.equal(typeof children.teacherCreateOptions, "function");
const miniPrompt = children.implementerCreateOptions({
  jobId: "00000000-0000-0000-0000-000000000001",
  hostUrl: "http://127.0.0.1:9",
  workspace: "/tmp",
  task: "do the thing",
  kind: "bounded",
}).prompt;
assert.equal(miniPrompt, "do the thing");
assert.equal(
  children.implementerCreateOptions({
    jobId: "00000000-0000-0000-0000-000000000001",
    hostUrl: "http://127.0.0.1:9",
    workspace: "/tmp",
    task: "do the thing",
    kind: "bounded",
  }).config.featureValues.auto_accept,
  true,
);
assert.equal(
  children.implementerCreateOptions({
    jobId: "00000000-0000-0000-0000-000000000001",
    hostUrl: "http://127.0.0.1:9",
    workspace: "/tmp",
    task: "do the thing",
    kind: "bounded",
  }).env.GROK_REASONING_EFFORT,
  "high",
);
assert.equal(
  Object.hasOwn(
    children.implementerCreateOptions({
      jobId: "00000000-0000-0000-0000-000000000001",
      hostUrl: "http://127.0.0.1:9",
      workspace: "/tmp",
      task: "do the thing",
      kind: "bounded",
    }).config,
    "toolPolicy",
  ),
  false,
);

assert.deepEqual(parseCreatedAgentJson('noise\n{"agentId":"a1","workspaceId":"w1","cwd":"/tmp/x"}'), {
  id: "a1",
  workspaceId: "w1",
  cwd: "/tmp/x",
});

const resolved = resolveMiniResearcher(join(dirname(fileURLToPath(import.meta.url)), "../../mini-researcher"));
assert.ok(resolved.command.includes("mini-researcher") || resolved.args.includes("mini_researcher"));
assert.equal(researcherUserMessage("What is ACP?"), "What is ACP?");
assert.match(researcherUserMessage("What is ACP?", "/ws"), /What is ACP\?/);
assert.match(researcherUserMessage("What is ACP?", "/ws"), /Workspace root: \/ws/);
const captured = [];
const researched = await runMiniResearcher("What is ACP?", {
  cwd: "/ws",
  execFileFn: async (command, args, opts) => {
    captured.push({ command, args, opts });
    return { stdout: JSON.stringify({ version: 1, kind: "research_completion", ok: true, answer: "ACP is a protocol.\n- https://example" }) };
  },
});
assert.equal(researched, "ACP is a protocol.\n- https://example");
assert.equal(captured[0].args.some((arg) => String(arg).includes("What is ACP")), false);
assert.match(captured[0].opts.input, /What is ACP\?/);
assert.match(captured[0].opts.input, /Workspace root: \/ws/);
assert.equal(Object.hasOwn(captured[0].opts ?? {}, "timeout"), false);
const spawnFail = new Error("Command failed: /venv/bin/mini-researcher One permitted retry of the narrow provider-selection investigation");
spawnFail.stderr = "litellm.llms.xai.common_utils.XaiException: Internal error during token generation";
assert.equal(
  formatResearcherFailure(spawnFail),
  "litellm.llms.xai.common_utils.XaiException: Internal error during token generation",
);
assert.equal(
  formatResearcherFailure(new Error("Command failed: /venv/bin/mini-researcher One permitted retry")),
  "mini-researcher exited without output",
);
assert.equal(
  formatResearcherFailure(new Error("Command failed: /venv/bin/mini-researcher One permitted retry\nhttpx.ReadTimeout")),
  "httpx.ReadTimeout",
);
const clipped = formatResearcherFailure({ stderr: `${"a".repeat(5000)}TIMEOUT_TAIL` });
assert.equal(clipped.endsWith("TIMEOUT_TAIL"), true);
assert.equal(clipped.includes("a".repeat(5000)), false);
const failedSpawn = await runMiniResearcher("What is ACP?", {
  cwd: "/ws",
  execFileFn: async () => {
    throw spawnFail;
  },
}).then(
  () => {
    throw new Error("expected researcher spawn failure");
  },
  (error) => error,
);
assert.match(failedSpawn.message, /Internal error during token generation/);
assert.doesNotMatch(failedSpawn.message, /Command failed/);
assert.doesNotMatch(failedSpawn.message, /What is ACP/);
assert.doesNotMatch(failedSpawn.message, /permitted retry/);
const echoed = await execFileWithInput("python3", ["-c", "import sys; sys.stdout.write(sys.stdin.read())"], {
  input: "prompt-on-stdin",
  encoding: "utf8",
});
assert.equal(echoed.stdout, "prompt-on-stdin");
const failedPipe = await execFileWithInput("python3", ["-c", "import sys; sys.stderr.write('httpx.ReadTimeout\\n'); sys.exit(1)"], {
  input: "ignored",
  encoding: "utf8",
}).then(
  () => {
    throw new Error("expected non-zero stdin spawn");
  },
  (error) => error,
);
assert.match(failedPipe.stderr, /httpx.ReadTimeout/);
assert.doesNotMatch(failedPipe.message, /ignored/);
assert.throws(() => extractResearcherAnswer("Final answer: unstructured"), /not JSON/);
const stderrOnly = await runMiniResearcher("What is ACP?", {
  cwd: "/ws",
  execFileFn: async () => ({ stdout: "", stderr: "warning: ignored" }),
}).then(
  () => {
    throw new Error("expected empty stdout to fail");
  },
  (error) => error,
);
assert.match(stderrOnly.message, /produced no output/);
assert.equal(stderrOnly.failureClass, "invalid_output");

const dir = mkdtempSync(join(tmpdir(), "architect-runtime-"));
const created = [];
const indexed = [];

function fakeHandle({ id, cwd, workspaceId = "ws" }) {
  return {
    id,
    workspaceId,
    cwd,
    async refresh() {
      return { agent: this, project: null };
    },
    subscribe(handler) {
      handler({});
      return () => {};
    },
  };
}

try {
  await ticketWrite(dir, { text: "# Ticket\n\n## Kind\n\nopen\n" });

  const ocrCalls = [];
  let ocrFindings = [];
  const prCalls = [];
  const runtime = createRuntime({
    paseo: {
      agents: {
        create: async (options) => {
          created.push(options);
          return fakeHandle({
            id: `agent-${created.length}`,
            cwd: options.worktree ? "/tmp/architect-wt" : options.cwd,
            workspaceId: "ws",
          });
        },
      },
    },
    runResearch: async (question) => `${question}\n- src/acp.mjs\n- https://example`,
    ocrReview: async (cwd, args) => {
      ocrCalls.push({ cwd, ...args });
      return ocrFindings;
    },
    createWorktree: async ({ branch }) => {
      assert.match(branch, /^architect\/(open|bounded)\//);
      return { cwd: "/tmp/architect-wt", workspaceId: "ws-wt" };
    },
    indexWorkspace: async (root, args) => {
      indexed.push({ root, ...args });
    },
    isGitRepo: async () => true,
    commitIfDirty: async () => ({ committed: true }),
    hasRemote: async () => true,
    createAndMergePr: async (...args) => {
      prCalls.push(args);
      return { pr: "https://example/pr/1", merged: true };
    },
    buildReviewPacket: async () => ({
      baseSha: "base",
      headSha: "head",
      files: [{ path: "src/a.ts", sha: "abc", hunks: [{ header: "@@ -1,1 +1,1 @@", newStart: 1 }] }],
    }),
  });

  const research = await runtime.handleTool("delegate", { to: "researcher", question: "What is ACP?" }, {
    cwd: dir,
    agentId: "arch-1",
  });
  assert.equal(research.to, "researcher");
  assert.equal(Object.hasOwn(research, "done"), false);
  await runtime.flush();
  const researchWakes = runtime.takeWakes("arch-1");
  assert.equal(researchWakes.length, 1);
  assert.match(researchWakes[0], /What is ACP\?/);
  assert.match(researchWakes[0], /src\/acp\.mjs/);
  assert.equal(created.some((item) => item.title === "researcher"), false);
  assert.equal(created.some((item) => item.labels?.role === "researcher"), false);

  const open = await runtime.handleTool("delegate", { to: "implementer", kind: "open" }, {
    cwd: dir,
    agentId: "arch-1",
  });
  assert.equal(open.to, "implementer");
  assert.equal(created.at(-1).worktree, undefined);
  assert.equal(created.at(-1).cwd, "/tmp/architect-wt");
  assert.equal(indexed[0]?.root, "/tmp/architect-wt");
  assert.equal(indexed[0]?.wait, true);
  const implementer = [...runtime.jobs.values()].find((job) => job.agentId === open.agentId);
  assert.equal(implementer.worktreeCwd, "/tmp/architect-wt");

  ocrFindings = [];
  const passed = await runtime.handleTool("done", {}, { agentId: open.agentId });
  assert.equal(passed.action, "pr_merge");
  assert.equal(ocrCalls.at(-1).from, "base");
  assert.equal(ocrCalls.at(-1).to, "head");
  assert.equal(ocrCalls.at(-1).cwd, "/tmp/architect-wt");
  assert.equal(prCalls.length, 1);
  assert.match(runtime.takeWakes("arch-1")[0], /Implementation landed/);

  const open2 = await runtime.handleTool("delegate", { to: "implementer", kind: "open" }, {
    cwd: dir,
    agentId: "arch-1",
  });
  ocrFindings = [{ path: "src/a.ts", line: 3, body: "off-by-one" }];
  const firstFail = await runtime.handleTool("done", {}, { agentId: open2.agentId });
  assert.equal(firstFail.action, "spawn_implementer_same_worktree");
  const fixOptions = created.at(-1);
  assert.equal(fixOptions.worktree, undefined);
  assert.equal(fixOptions.cwd, "/tmp/architect-wt");
  const fixJob = [...runtime.jobs.values()].find((job) => job.agentId === firstFail.implementerId);
  assert.equal(fixJob.worktreeCwd, "/tmp/architect-wt");
  assert.equal(fixJob.reviewerAttempt, 1);
  assert.deepEqual(runtime.takeWakes("arch-1"), []);

  const secondFail = await runtime.handleTool("done", {}, { agentId: firstFail.implementerId });
  assert.equal(secondFail.action, "wake_architect");
  const secondWakes = runtime.takeWakes("arch-1");
  assert.equal(secondWakes.length, 1);
  assert.match(secondWakes[0], /src\/a.ts:3 off-by-one/);
  assert.match(secondWakes[0], /src\/a.ts @ abc/);

  await ticketWrite(dir, { text: "# Ticket\n\n## Kind\n\nbounded\n" });
  const boundedRuntime = createRuntime({
    paseo: {
      agents: {
        create: async (options) => fakeHandle({ id: "bounded-1", cwd: options.cwd }),
      },
    },
    createWorktree: async () => ({ cwd: "/tmp/bounded-wt", workspaceId: "bws" }),
    indexWorkspace: async () => {},
    isGitRepo: async () => true,
    commitIfDirty: async () => ({ committed: true }),
    hasRemote: async () => true,
    createAndMergePr: async () => ({ pr: "https://example/pr/2", merged: true }),
  });
  const bounded = await boundedRuntime.handleTool("delegate", { to: "implementer", kind: "bounded" }, {
    cwd: dir,
    agentId: "arch-2",
  });
  const boundedDone = await boundedRuntime.handleTool("done", {}, { agentId: bounded.agentId });
  assert.equal(boundedDone.action, "commit_pr_merge");
  assert.match(boundedRuntime.takeWakes("arch-2")[0], /Implementation landed/);

  const failRuntime = createRuntime({
    isGitRepo: async () => true,
    commitIfDirty: async () => ({ committed: true }),
    hasRemote: async () => true,
    createAndMergePr: async () => {
      throw new Error("gh merge denied");
    },
  });
  const failJob = {
    id: "fail-1",
    role: "implementer",
    kind: "bounded",
    cwd: dir,
    parent: "arch-3",
    worktreeCwd: dir,
    reviewerAttempt: 0,
    status: "running",
    agentId: "fail-agent",
  };
  failRuntime.jobs.set(failJob.id, failJob);
  const failDone = await failRuntime.handleTool("done", {}, { agentId: "fail-agent" });
  assert.equal(failDone.action, "wake_architect");
  assert.match(failDone.error, /gh merge denied/);
  const failWakes = failRuntime.takeWakes("arch-3");
  assert.equal(failWakes.length, 1);
  assert.match(failWakes[0], /PR merge failed: gh merge denied/);

  const ffCalls = [];
  const localPrCalls = [];
  const localRuntime = createRuntime({
    isGitRepo: async () => true,
    commitIfDirty: async () => ({ committed: true }),
    hasRemote: async () => false,
    fastForwardMain: async (...args) => {
      ffCalls.push(args);
      return { merged: true, method: "ff" };
    },
    createAndMergePr: async (...args) => {
      localPrCalls.push(args);
      return { pr: "https://example/pr/3", merged: true };
    },
  });
  const localJob = {
    id: "local-1",
    role: "implementer",
    kind: "bounded",
    cwd: dir,
    parent: "arch-local",
    worktreeCwd: dir,
    reviewerAttempt: 0,
    status: "running",
    agentId: "local-agent",
  };
  localRuntime.jobs.set(localJob.id, localJob);
  const localDone = await localRuntime.handleTool("done", {}, { agentId: "local-agent" });
  assert.equal(localDone.action, "commit_pr_merge");
  assert.equal(ffCalls.length, 1);
  assert.equal(localPrCalls.length, 0);
  assert.match(localRuntime.takeWakes("arch-local")[0], /Implementation landed/);

  const leftover = createRuntime({});
  leftover.jobs.set("rev-1", {
    id: "rev-1",
    role: "reviewer",
    cwd: dir,
    parent: "arch-4",
    reviewerAttempt: 1,
    status: "running",
    agentId: "rev-agent",
  });
  await assert.rejects(
    () => leftover.handleTool("done", {}, { agentId: "rev-agent" }),
    /findings/,
  );

  const missingCwd = await waitForHandleCwd({
    cwd: null,
    async refresh() {
      return null;
    },
    subscribe() {
      return () => {};
    },
  }, { timeoutMs: 80, intervalMs: 10 }).then(
    () => "ok",
    (error) => error.message,
  );
  assert.match(missingCwd, /worktree cwd did not appear/);

  const queued = createRuntime({});
  const waiting = queued.waitForWakes("arch-5", { timeoutMs: 1000 });
  queued.queueWake("arch-5", "Teacher returned.");
  assert.deepEqual((await waiting).map(wake => wake.text), ["Teacher returned."]);

  const parentRuntime = createRuntime({
    paseo: {
      agents: {
        create: async (options) => {
          created.push(options);
          return fakeHandle({ id: "teacher-1", cwd: dir });
        },
      },
    },
  });
  await parentRuntime.handleTool("teacher", {
    parked_question: "bounded or open?",
    direction: "kind",
    informed_enough: "can pick one",
  }, { cwd: dir, agentId: "acp-session", paseoAgentId: "paseo-agent" });
  const teacherOpts = created.at(-1);
  assert.equal(teacherOpts.parent, "paseo-agent");

  const failResearch = createRuntime({
    runResearch: async () => {
      throw new Error("set BRAVE_API_KEY");
    },
  });
  const failed = await failResearch.handleTool("delegate", { to: "researcher", question: "x" }, {
    cwd: dir,
    agentId: "arch-6",
  });
  assert.equal(failed.to, "researcher");
  await failResearch.flush();
  assert.match(failResearch.takeWakes("arch-6")[0], /set BRAVE_API_KEY/);

  const argvDump = createRuntime({
    runResearch: async () => {
      const error = new Error("Command failed: /venv/bin/mini-researcher One permitted retry of the narrow provider-selection investigation");
      error.stderr = "httpx.ReadTimeout\nlitellm.llms.xai.common_utils.XaiException: timeout after 600.0 seconds";
      throw error;
    },
  });
  await argvDump.handleTool("delegate", { to: "researcher", question: "x" }, {
    cwd: dir,
    agentId: "arch-6b",
  });
  await argvDump.flush();
  const failedWake = argvDump.takeWakes("arch-6b")[0];
  assert.match(failedWake, /Research could not complete after \d+ provider attempts?/);
  assert.match(failedWake, /600\.0-second timeout|ReadTimeout|timeout after 600/);
  assert.match(failedWake, /Automatic recovery is exhausted/);
  assert.doesNotMatch(failedWake, /Command failed/);
  assert.doesNotMatch(failedWake, /permitted retry/);
  assert.doesNotMatch(failedWake, /^Researcher failed:/);

  const ocrFailRuntime = createRuntime({
    sleep: async () => {},
    random: () => 0,
    paseo: {
      agents: {
        create: async (options) => fakeHandle({ id: "ocr-fail-1", cwd: options.cwd }),
      },
    },
    createWorktree: async () => ({ cwd: "/tmp/review-fail-wt", workspaceId: "ows" }),
    indexWorkspace: async () => {},
    isGitRepo: async () => true,
    commitIfDirty: async () => ({ committed: true }),
    ocrReview: async () => {
      const error = new Error("HTTP 500 Internal error during token generation");
      error.stderr = "HTTP 500 Internal error during token generation";
      throw error;
    },
    buildReviewPacket: async () => ({
      baseSha: "base",
      headSha: "head",
      files: [],
    }),
  });
  await ticketWrite(dir, { text: "# Ticket\n\n## Kind\n\nopen\n" });
  const ocrFail = await ocrFailRuntime.handleTool("delegate", { to: "implementer", kind: "open" }, {
    cwd: dir,
    agentId: "arch-ocr",
  });
  const ocrDone = await ocrFailRuntime.handleTool("done", {}, { agentId: ocrFail.agentId });
  assert.equal(ocrDone.ok, true);
  assert.equal(ocrDone.action, "wake_architect");
  const ocrWake = ocrFailRuntime.takeWakes("arch-ocr")[0];
  assert.match(ocrWake, /Review could not complete after 3 provider attempts/);
  assert.match(ocrWake, /correction allowance was not consumed/);
  assert.doesNotMatch(ocrWake, /Mini|OCR|ocr/);

  const dupRuntime = createRuntime({
    isGitRepo: async () => true,
    commitIfDirty: async () => ({ committed: true }),
    hasRemote: async () => false,
    fastForwardMain: async () => ({ merged: true, method: "ff" }),
  });
  const dupJob = {
    id: "dup-1",
    role: "implementer",
    kind: "bounded",
    cwd: dir,
    parent: "arch-dup",
    worktreeCwd: dir,
    reviewerAttempt: 0,
    status: "running",
    agentId: "dup-agent",
  };
  dupRuntime.jobs.set(dupJob.id, dupJob);
  const firstDup = await dupRuntime.handleTool("done", {}, { agentId: "dup-agent" });
  const secondDup = await dupRuntime.handleTool("done", {}, { agentId: "dup-agent" });
  assert.equal(firstDup.action, secondDup.action);
  assert.equal(firstDup.action, "commit_pr_merge");

  const commitFailRuntime = createRuntime({
    isGitRepo: async () => true,
    commitIfDirty: async () => {
      throw new Error("index.lock");
    },
  });
  const commitJob = {
    id: "commit-1",
    role: "implementer",
    kind: "bounded",
    cwd: dir,
    parent: "arch-commit",
    worktreeCwd: dir,
    reviewerAttempt: 0,
    status: "running",
    agentId: "commit-agent",
  };
  commitFailRuntime.jobs.set(commitJob.id, commitJob);
  const commitDone = await commitFailRuntime.handleTool("done", {}, { agentId: "commit-agent" });
  assert.equal(commitDone.action, "wake_architect");
  assert.match(commitFailRuntime.takeWakes("arch-commit")[0], /Commit failed: index.lock/);

  const exhausted = createRuntime({
    runResearch: async () => {
      const error = new Error("HTTP 500");
      error.failureClass = "transient";
      error.attempts = ["HTTP 500", "ReadTimeout at the provider's 600.0-second timeout", "HTTP 500"];
      error.exhausted = true;
      throw error;
    },
  });
  await exhausted.handleTool("delegate", { to: "researcher", question: "same-q" }, {
    cwd: dir,
    agentId: "arch-ex",
  });
  await exhausted.flush();
  exhausted.takeWakes("arch-ex");
  const again = await exhausted.handleTool("delegate", { to: "researcher", question: "same-q" }, {
    cwd: dir,
    agentId: "arch-ex",
  });
  assert.equal(again.exhausted, true);
  assert.equal(again.started, false);
  assert.match(exhausted.takeWakes("arch-ex")[0], /Automatic recovery is exhausted/);

  const helperCalls = [];
  await ticketWrite(dir, { text: "# Ticket\n\n## Kind\n\nbounded\n" });
  const helperRuntime = createRuntime({
    spawnExec: async (command, args, opts) => {
      helperCalls.push({ command, args, opts });
      return { stdout: JSON.stringify({ id: "helper-1", workspaceId: "ws", cwd: "/tmp/helper-wt" }) };
    },
    createWorktree: async () => ({ cwd: "/tmp/helper-wt", workspaceId: "ws" }),
    indexWorkspace: async () => {},
  });
  const helper = await helperRuntime.handleTool("delegate", { to: "implementer", kind: "bounded" }, {
    cwd: dir,
    agentId: "arch-h",
  });
  assert.equal(helper.agentId, "helper-1");
  assert.equal(helperCalls[0].args.at(-1), SPAWN_ENTRY);
  const helperPayload = JSON.parse(helperCalls[0].opts.input);
  assert.equal(helperPayload.config.featureValues.auto_accept, true);
  assert.equal(helperPayload.config.thinkingOptionId, "high");
  assert.equal(helperPayload.config.mcpServers.zvec_grep, undefined);
  assert.ok(helperPayload.config.mcpServers.architect);
  assert.equal(Object.hasOwn(helperPayload.config, "toolPolicy"), false);
  assert.match(helperPayload.config.provider, /^architect-mini\//);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
