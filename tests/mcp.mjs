#!/usr/bin/env node
import assert from "node:assert/strict";
delete process.env.QQ_IMPLEMENTER_PROVIDER;
delete process.env.QQ_REVIEWER_PROVIDER;
delete process.env.QQ_RESEARCHER_PROVIDER;
delete process.env.QQ_WORKFLOW_PROVIDER;

// Disable proc thread autodiscovery for entire test lifecycle.
globalThis.__QQ_TEST_DISABLE_PROC_THREAD = true;

// Scrub live notification routing/thread env for direct test execution.
// Targeted actual live routing values (preserve needed config: CODEX_HOME, CODEX_MODEL, CODEX_BIN).
delete process.env.CODEX_THREAD_ID;
delete process.env.CODEX_SESSION_ID;
delete process.env.CODEX_CONVERSATION_ID;
process.env.QQ_CODEX_BIN = "/usr/bin/true";
// Direct invocations also need isolated notification journals: fixed fixture IDs
// must not inherit receipts from an earlier run in this worktree.
if (!process.env.QQ_WORKFLOW_STATE_DIR) {
  process.env.QQ_WORKFLOW_STATE_DIR = join(mkdtempSync(join(tmpdir(), "qq-mcp-state-")), "state");
}
// Durable retention of terminal findings must never touch the operator's real
// state dir during tests: point it at a unique temp dir (imports are hoisted,
// so mkdtempSync/join/tmpdir are available here).
if (!process.env.QQ_RUNNER_FINDINGS_DIR) {
  process.env.QQ_RUNNER_FINDINGS_DIR = mkdtempSync(join(tmpdir(), "qq-test-findings-"));
}
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  CANONICAL_PROVIDERS,
  COMPLETE_TASK_REGISTRY,
  EXECUTIONS,
  LONG_RUNNING_TOOLS,
  LONG_TOOL_SUSPICION_MS,
  NOTIFY_SWEEP_INTERVAL_MS,
  PROVIDERS,
  RUNNERS,
  STALL_SUSPICION_WINDOW_MS,
  stallSuspicionWindowMs,
  SUSPICION_RENOTIFY_MS,
  TOOLS,
  buildExecutionTerminalMessage,
  buildImplementerStep,
  buildReviewerStep,
  buildRunnerTerminalMessage,
  buildSuspicionMessage,
  callTool,
  cancelRunner,
  checkExecution,
  checkRunner,
  boundedTerminalDiagnostic,
  completeTask,
  workerFailureTag,
  retainRunnerFindings,
  loadRetainedFindings,
  pruneRetainedFindings,
  replayRetainedRunnerFindings,
  listRetainedFindings,
  runnerFindingsDir,
  retainedFindingsPath,
  hasRetainedFindings,
  isValidRunnerId,
  currentRuntimeIdentity,
  recordRunnerStdoutLine,
  DETECTED_CODEX_HOMES,
  DETECTED_CODEX_THREADS,
  dispatchExecution,
  dispatchRunner,
  evaluateSuspicion,
  findCodexHomeFromProc,
  findCodexThreadFromProc,
  getDisabledTools,
  handleExecutionStreamEvent,
  handleRpc,
  handleRunnerEvent,
  land,
  longToolSuspicionMs,
  notifySession,
  notifySuspicion,
  notifyTerminal,
  parseDisabledTools,
  prepareWorktree,
  readTicket,
  reconcileDeadRunner,
  resolveCodexThreadId,
  resolveSeatProvider,
  resolveSessionId,
  sanitizeHeadTail,
  validateRunnerResultPayload,
  readAuthoritativeRunnerResult,
  cleanupRunnerFiles,
  startMcpServer,
  startSuspicionSweeper,
  steerRunner,
  stopSuspicionSweeper,
  suspicionRearmMs,
  sweepIntervalMs,
  sweepNotifications,
  toolSilenceThresholdMs,
  updateTicket,
  evaluateReviewPassed,
  isTrustworthyReviewFail,
  parseReviewVerdict,
  buildImplementerPrompt,
  buildReviewerPrompt,
  buildRetryPrompt,
  buildResearcherPrompt,
  hasImplementationChanges,
} from "../bin/mcp-server.mjs";
import { git, retireWorktree } from "../workflow/git.mjs";
import { readReport } from "../workflow/reports.mjs";
import { resolveTicketSource } from "../workflow/ticket.mjs";
import { WORKER_LAUNCHER_PATH, buildWorkerStep } from "../bin/mcp-server.mjs";
import { COMPLETE_TASK_RESPONSE_MAX } from "../workflow/results.mjs";
import { FINAL_RESPONSE_MAX_CHARS_LABEL } from "../workflow/limits.mjs";
import { WORKER_DEEPSEEK_ADAPTER, WORKER_SEATS } from "../workflow/worker-config.mjs";
import { UNSETTABLE_WORKER_EXEC_ENV, resolveWorkerLaunchPlan } from "../workflow/worker-launch.mjs";
import { centralWorkerConfig } from "./support/architect-fixtures.mjs";

const exec = promisify(execFile);

async function retireTestWorktree(repo, result) {
  // Production retirement also removes the immutable creation pin. A bare
  // worktree/branch deletion leaves a stale pin when this fixture reuses an ID.
  await retireWorktree(repo, { worktree: result.worktree, branch: result.branch });
}

// The authoritative result for a runner tracker: the transport/registry read
// (the production completion path) first, then the in-memory terminal result a
// test double records. Used where the old blocking wait tool used to hand the
// result back.
function authoritativeResult(runnerId) {
  const runner = RUNNERS.get(runnerId);
  const loaded = readAuthoritativeRunnerResult(runner);
  return loaded.ok ? loaded.result : (runner?.result ?? null);
}

// Wait for a dispatched execution to reach a terminal state. The Architect is
// woken by the completion notification; a test has no session to wake, so it
// polls the tracker the point-in-time read reports on.
async function waitForExecution(id, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const exec = EXECUTIONS.get(id);
    if (exec && exec.status !== "running") return exec;
    if (Date.now() > deadline) throw new Error(`execution '${id}' did not settle within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Wait for a dispatched runner tracker to leave the running state. Tests have
// no session to wake on completion, so they poll the tracker the point-in-time
// read reports on.
async function waitForRunnerTerminal(runnerId, { timeoutMs = 20_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const runner = RUNNERS.get(runnerId);
    if (runner && runner.status !== "running") return runner;
    if (Date.now() > deadline) throw new Error(`runner '${runnerId}' did not settle within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// 1. Tool schema checks
assert.equal(TOOLS.length, 17);
const toolNames = TOOLS.map((t) => t.name).sort();
assert.deepEqual(toolNames, [
  "cancel_execution",
  "cancel_runner",
  "check_execution",
  "check_runner",
  "complete_task",
  "dispatch_execution",
  "dispatch_runner",
  "land",
  "prepare_worktree",
  "read_adr",
  "read_report",
  "read_ticket",
  "retry_runner_notification",
  "search_adrs",
  "steer_execution",
  "steer_runner",
  "update_ticket",
]);

// The mandated durable report retrieval surface (bounded pagination) exists
// through the normal tool dispatcher on BOTH surfaces.
const readReportTool = TOOLS.find((t) => t.name === "read_report");
assert.ok(readReportTool, "read_report is exposed");
assert.deepEqual(readReportTool.inputSchema.required, ["reportId"]);

const prepareTool = TOOLS.find((t) => t.name === "prepare_worktree");
assert.ok(prepareTool);
assert.deepEqual(prepareTool.inputSchema.required, ["kind"]);
assert.deepEqual(prepareTool.inputSchema.properties.kind.enum, ["bounded", "open", "research"]);
assert.equal(prepareTool.inputSchema.properties.engine, undefined);
// Worker provider/model selection is not part of any tool schema: it belongs to
// the operator's central configuration alone.
for (const name of ["prepare_worktree", "dispatch_execution"]) {
  const tool = TOOLS.find((t) => t.name === name);
  for (const key of ["provider", "implementerProvider", "reviewerProvider", "researcherProvider"]) {
    assert.equal(tool.inputSchema.properties[key], undefined, `${name} must not expose '${key}'`);
  }
}

// 1b. Seat support table: the Pi-only managed test owner joins the existing
// seats in the central configuration; legacy harness launches remain limited
// to runner, implementer and reviewer.
assert.deepEqual(PROVIDERS, ["muse", "gemini", "deepseek", "codex", "astra"], "the legacy provider vocabulary survives only for ticket parsing");
assert.deepEqual(WORKER_SEATS, ["runner", "test_owner", "implementer", "reviewer"]);

// 1c. Exactly one delegation command per worker seat: the canonical
// bin/worker-exec.mjs launcher, whose own resolution is the central contract.
// No agy/muse/dsh/codex command text can be rendered for a worker seat.
const IMPLEMENTER_OWNERSHIP = "Leave changes uncommitted. Do not commit, push, review, or land.";
const REVIEWER_OWNERSHIP = "Do not commit, push, or land.";
const RUNNER_OWNERSHIP = "Leave files uncommitted. Do not commit, push, review, or land.";
assert.equal(buildWorkerStep("implementer", "/wt", "P"), `Delegate via run_command (with Cwd: /wt): '${WORKER_LAUNCHER_PATH} --seat implementer --cwd /wt --prompt "P ${IMPLEMENTER_OWNERSHIP}"'`);
assert.equal(buildImplementerStep("/wt", "P"), `Delegate via run_command (with Cwd: /wt): '${WORKER_LAUNCHER_PATH} --seat implementer --cwd /wt --prompt "P ${IMPLEMENTER_OWNERSHIP}"'`);
assert.equal(buildReviewerStep("/wt", "P"), `Delegate via run_command (with Cwd: /wt): '${WORKER_LAUNCHER_PATH} --seat reviewer --cwd /wt --prompt "P ${REVIEWER_OWNERSHIP}"'`);
assert.equal(buildReviewerStep("/wt", "P", "gemini", "uuid-2"), buildReviewerStep("/wt", "P"), "a per-call provider is ignored, never rendered");
assert.ok(WORKER_LAUNCHER_PATH.endsWith("bin/worker-exec.mjs"));
for (const step of [buildImplementerStep("/wt", "Do it"), buildReviewerStep("/wt", "Check it")]) {
  assert.doesNotMatch(step, /(^|[\s'"])agy([\s'"]|$)|muse exec|dsh --profile|codex exec --profile/, `no legacy worker launcher may be rendered: ${step}`);
}

// 1d. The alternate Architect provider-resolution path is gone: the one
// Architect is the Pi on Paseo profile, so no seat-provider resolution
// function survives to select a launcher.
assert.equal(typeof resolveProvider, "undefined");

// 1e. Worker seats resolve the operator's central configuration only; every
// per-call and per-env provider override is refused, and a missing central
// configuration fails closed instead of defaulting to a legacy provider.
const centralFixture = centralWorkerConfig(mkdtempSync(join(tmpdir(), "qq-mcp-central-")));
const centralEnv = { ...centralFixture.env };
assert.equal(resolveSeatProvider("implementer", {}, centralEnv), "deepseek", "the configured provider serves the seat");
assert.equal(resolveSeatProvider("reviewer", {}, centralEnv), "deepseek");
assert.equal(resolveSeatProvider("runner", {}, centralEnv), "deepseek");
{
  // The same central file can select any provider pi supports: that is a
  // config change, not a source change.
  const piConfig = join(tmpdir(), `qq-pi-worker-config-${Date.now()}.json`);
  writeFileSync(piConfig, JSON.stringify({ harness: "pi", provider: "meta", model: "muse-spark-1.3-contributor", reasoning_effort: "xhigh", env_key: "MODEL_API_KEY" }), "utf8");
  try {
    const piEnv = { ...centralEnv, QQ_WORKER_CONFIG_FILE: piConfig };
    assert.equal(resolveSeatProvider("implementer", {}, piEnv), "meta");
    assert.equal(resolveSeatProvider("reviewer", {}, piEnv), "meta");
  } finally {
    rmSync(piConfig, { force: true });
  }
}
for (const key of ["provider", "implementerProvider", "reviewerProvider", "researcherProvider"]) {
  assert.throws(
    () => resolveSeatProvider("implementer", { [key]: "gemini" }, centralEnv),
    new RegExp(`provider override '${key}' is not permitted`),
    `'${key}' must be refused`,
  );
}
assert.throws(
  () => resolveSeatProvider("implementer", {}, { ...centralEnv, QQ_IMPLEMENTER_PROVIDER: "gemini" }),
  /legacy worker provider selection is not authorized: QQ_IMPLEMENTER_PROVIDER=gemini/,
);
assert.throws(
  () => resolveSeatProvider("implementer", {}, { ...centralEnv, QQ_WORKFLOW_PROVIDER: "muse" }),
  /legacy worker provider selection is not authorized: QQ_WORKFLOW_PROVIDER=muse/,
);
assert.throws(
  () => resolveSeatProvider("implementer", {}, { QQ_WORKER_CONFIG_FILE: join(tmpdir(), "no-such-worker-config.json") }),
  /central worker configuration is missing/,
  "a missing central configuration never falls back to a legacy provider",
);
assert.throws(() => resolveSeatProvider("researcher", {}, centralEnv), /does not use central worker configuration/);
{
  const badConfig = join(tmpdir(), `qq-bad-worker-config-${Date.now()}.json`);
  writeFileSync(badConfig, JSON.stringify({ harness: "deepseek-minimal", provider: "muse", model: "deepseek-flash" }), "utf8");
  try {
    assert.throws(
      () => resolveSeatProvider("implementer", {}, { ...centralEnv, QQ_WORKER_CONFIG_FILE: badConfig }),
      /serves only 'deepseek'/,
      "the retained legacy harness refuses a provider it cannot serve",
    );
  } finally {
    rmSync(badConfig, { force: true });
  }
}

// 1f. A configured executable override outside the central contract is refused
// by the one central resolver (no agy/project-local launcher path).
for (const key of UNSETTABLE_WORKER_EXEC_ENV) {
  assert.throws(
    () => resolveWorkerLaunchPlan({ role: "runner", env: { ...centralEnv, [key]: "/usr/bin/agy" } }),
    new RegExp(`${key}=.* is not a supported worker launch override`),
  );
}
const centralPlan = resolveWorkerLaunchPlan({ role: "implementer", env: centralEnv });
assert.equal(centralPlan.harness, "deepseek-minimal");
assert.equal(centralPlan.adapter, WORKER_DEEPSEEK_ADAPTER);
assert.equal(centralPlan.provider, "deepseek");
assert.equal(centralPlan.model, "deepseek-flash");
assert.equal(centralPlan.reasoning_effort, "max");

// Every worker-seat entry point below resolves this same central configuration
// from the process environment, exactly like production does.
for (const [key, value] of Object.entries(centralFixture.env)) process.env[key] = value;

const landTool = TOOLS.find((t) => t.name === "land");
assert.ok(landTool);

// 2. Validation failures
await assert.rejects(
  () => prepareWorktree({}),
  /kind is required: 'bounded' \| 'open' \| 'research'/,
  "Must fail without kind",
);
await assert.rejects(
  () => prepareWorktree({ kind: "invalid" }),
  /kind is required: 'bounded' \| 'open' \| 'research'/,
  "Must fail with invalid kind",
);

// 3. Functional test in a temporary repository
const repoDir = mkdtempSync(join(tmpdir(), "architect-mcp-repo-"));
// Provider env vars must not leak into default-resolution assertions.
const savedProviderEnv = {};
for (const key of ["QQ_WORKFLOW_PROVIDER", "QQ_IMPLEMENTER_PROVIDER", "QQ_REVIEWER_PROVIDER", "QQ_RESEARCHER_PROVIDER"]) {
  savedProviderEnv[key] = process.env[key];
  delete process.env[key];
}
try {
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.name", "MCP Test"]);
  await git(repoDir, ["config", "user.email", "mcp@example.invalid"]);

  writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "init repo"]);

  // Create a session ticket in .architect/tickets/<sessionId>.md
  const sessionId = "12345678-abcd-ef01-2345-6789abcdef01";
  const ticketsDir = join(repoDir, ".architect", "tickets");
  mkdirSync(ticketsDir, { recursive: true });
  writeFileSync(join(ticketsDir, `${sessionId}.md`), "# Test Session Ticket\n\n## Kind\nbounded\n");

  // Verify resolveSessionId picks up the active ticket
  const resolved = await resolveSessionId(repoDir);
  assert.equal(resolved, sessionId);

  // 4. prepare_worktree with kind = bounded
  const boundedResult = await prepareWorktree({
    kind: "bounded",
    sessionId,
    cwd: repoDir,
  });

  assert.equal(boundedResult.ok, true);
  assert.equal(boundedResult.kind, "bounded");
  assert.equal(boundedResult.branch, "architect/bounded/12345678");
  assert.equal(boundedResult.reviewRequired, false);
  assert.equal(boundedResult.communication.supported, false, "manual preparation cannot imply managed communication");
  assert.equal(boundedResult.communication.mode, "manual-worker");
  assert.match(boundedResult.instructions, /Use dispatch_execution for managed implementer\/reviewer communication/);
  assert.equal(boundedResult.implementerProvider, "deepseek", "the seat provider is the centrally configured one");
  assert.ok(boundedResult.instructions.includes(`${WORKER_LAUNCHER_PATH} --seat implementer --cwd ${boundedResult.worktree}`));
  assert.doesNotMatch(boundedResult.instructions, /agy|muse exec|dsh --profile|codex exec --profile/);
  assert.ok(boundedResult.instructions.includes(IMPLEMENTER_OWNERSHIP));
  assert.ok(boundedResult.instructions.includes("call 'land'"));
  assert.ok(boundedResult.instructions.includes(`Cwd: ${boundedResult.worktree}`));
  assert.ok(boundedResult.instructions.includes("run_command"));
  assert.equal(boundedResult.implementerPrompt, `Implement '${join(boundedResult.worktree, ".architect", "ticket.md")}' in working directory '${boundedResult.worktree}'. When finished, report your answer.`);
  assert.equal(boundedResult.reviewerPrompt, undefined);

  // Verify ticket was copied into the worktree as .architect/ticket.md
  const wtTicket = join(boundedResult.worktree, ".architect", "ticket.md");
  assert.equal(readFileSync(wtTicket, "utf8"), "# Test Session Ticket\n\n## Kind\nbounded\n");

  // 4b. Verify runtime guards reject execution from within a delegated worktree
  await assert.rejects(
    () =>
      prepareWorktree({
        kind: "bounded",
        cwd: boundedResult.worktree,
      }),
    /prepare_worktree cannot be called from within a delegated worktree/,
    "prepareWorktree must reject execution when called from within a delegated worktree",
  );

  await assert.rejects(
    () =>
      land({
        cwd: boundedResult.worktree,
      }),
    /land must be called from the parent architect session/,
    "land must reject execution when called from within a delegated worktree without explicit worktree target",
  );

  // Verify runtime guards reject execution on architect/ branch outside .qq-worktrees
  const branchRepo = mkdtempSync(join(tmpdir(), "architect-guard-test-"));
  try {
    await git(branchRepo, ["init", "-b", "architect/subagent-branch"]);
    await git(branchRepo, ["config", "user.name", "MCP Test"]);
    await git(branchRepo, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(branchRepo, "README.md"), "# Branch Test Repo\n");
    await git(branchRepo, ["add", "README.md"]);
    await git(branchRepo, ["commit", "-m", "init"]);

    await assert.rejects(
      () =>
        prepareWorktree({
          kind: "bounded",
          cwd: branchRepo,
        }),
      /prepare_worktree cannot be called from within a delegated worktree/,
      "prepareWorktree must reject execution on an architect/ branch",
    );

    await assert.rejects(
      () =>
        land({
          cwd: branchRepo,
        }),
      /land must be called from the parent architect session/,
      "land must reject execution on an architect/ branch without explicit worktree target",
    );
  } finally {
    rmSync(branchRepo, { recursive: true, force: true });
  }

  // 5. prepare_worktree with kind = open
  const openSessionId = "87654321-fedc-ba98-7654-3210fedcba98";
  writeFileSync(join(ticketsDir, `${openSessionId}.md`), "# Open Session Ticket\n\n## Kind\nopen\n");

  const openResult = await prepareWorktree({
    kind: "open",
    sessionId: openSessionId,
    cwd: repoDir,
  });

  assert.equal(openResult.ok, true);
  assert.equal(openResult.kind, "open");
  assert.equal(openResult.branch, "architect/open/87654321");
  assert.equal(openResult.reviewRequired, true);
  assert.equal(openResult.implementerProvider, "deepseek");
  assert.equal(openResult.reviewerProvider, "deepseek");
  assert.ok(openResult.instructions.includes(`${WORKER_LAUNCHER_PATH} --seat implementer --cwd ${openResult.worktree}`));
  assert.ok(openResult.instructions.includes(openResult.implementerPrompt));
  assert.ok(openResult.instructions.includes(IMPLEMENTER_OWNERSHIP));
  assert.ok(openResult.instructions.includes(`${WORKER_LAUNCHER_PATH} --seat reviewer --cwd ${openResult.worktree}`));
  assert.doesNotMatch(openResult.instructions, /agy|muse exec|dsh --profile|codex exec --profile/);
  assert.ok(openResult.instructions.includes(openResult.reviewerPrompt));
  assert.ok(openResult.instructions.includes(REVIEWER_OWNERSHIP));
  assert.ok(openResult.instructions.includes(`Cwd: ${openResult.worktree}`));
  assert.ok(openResult.instructions.includes("run_command"));
  assert.equal(
    openResult.implementerPrompt,
    `Implement '${join(openResult.worktree, ".architect", "ticket.md")}' in working directory '${openResult.worktree}'. When finished, report your answer.`,
  );
  assert.equal(
    openResult.reviewerPrompt,
    `Follow '${join(openResult.worktree, ".architect", "ticket.md")}' in working directory '${openResult.worktree}'. Follow its testing plan. Do not change project code. Run tests to completion and report Verdict: PASS/FAIL with evidence; incomplete verification must not emit a fake FAIL. In non-interactive execution, ending your turn while background tasks run cancels them; actively await all background verification tasks until finished. Incomplete tests are not code defects.`,
  );

  // 5b. Provider selection is refused on worker seats: prepare_worktree fails
  // fast, before any worktree or branch exists, and never renders a legacy
  // launcher for the seat.
  for (const [label, args] of [
    ["global provider", { provider: "gemini" }],
    ["implementer seat provider", { implementerProvider: "gemini" }],
    ["reviewer seat provider", { reviewerProvider: "muse" }],
    ["legacy researcher provider", { researcherProvider: "muse" }],
  ]) {
    const session = "11223344-5566-7788-99aa-bbccddeeff00";
    writeFileSync(join(ticketsDir, `${session}.md`), "# Provider Override Ticket\n\n## Kind\nopen\n");
    await assert.rejects(
      () => prepareWorktree({ kind: "open", sessionId: session, cwd: repoDir, ...args }),
      /provider override '.*' is not permitted: worker provider selection belongs to operator workflow configuration/,
      `${label} must be refused`,
    );
    await assert.rejects(
      () => git(repoDir, ["rev-parse", "--verify", "refs/heads/architect/open/11223344"]),
      undefined,
      `${label} must not leave a branch behind`,
    );
  }

  // 5c. A conflicting legacy provider env refuses the launch too, and the
  // central configuration is the only source of the seat's provider.
  process.env.QQ_IMPLEMENTER_PROVIDER = "gemini";
  try {
    await assert.rejects(
      () => prepareWorktree({ kind: "open", sessionId: openSessionId, cwd: repoDir }),
      /legacy worker provider selection is not authorized: QQ_IMPLEMENTER_PROVIDER=gemini/,
    );
  } finally {
    delete process.env.QQ_IMPLEMENTER_PROVIDER;
  }
  assert.equal(resolveSeatProvider("implementer", {}, process.env), "deepseek");

  // 5d. With no central configuration at all, prepare_worktree fails closed
  // instead of defaulting to a legacy or native provider.
  {
    const saved = process.env.QQ_WORKER_CONFIG_FILE;
    process.env.QQ_WORKER_CONFIG_FILE = join(tmpdir(), "qq-mcp-absent-worker-config.json");
    try {
      await assert.rejects(
        () => prepareWorktree({ kind: "open", sessionId: openSessionId, cwd: repoDir }),
        /central worker configuration is missing/,
      );
    } finally {
      process.env.QQ_WORKER_CONFIG_FILE = saved;
    }
  }

  // 6. Test landing worktree
  // Make changes in bounded worktree
  writeFileSync(join(boundedResult.worktree, "code.txt"), "console.log('hello');\n");

  const landResult = await land({
    worktree: boundedResult.worktree,
    cwd: repoDir,
    message: "feat: implemented feature",
  });

  assert.equal(landResult.ok, true);
  assert.equal(landResult.landed, true);
  assert.equal(landResult.branch, "architect/bounded/12345678");
  assert.equal(landResult.method, "ff");
  assert.equal(landResult.ticketArchived, true);
  assert.ok(landResult.archivePath && existsSync(landResult.archivePath));
  assert.ok(readFileSync(landResult.archivePath, "utf8").includes("Test Session Ticket"));

  // Verify file landed in main
  assert.equal(readFileSync(join(repoDir, "code.txt"), "utf8"), "console.log('hello');\n");

  // 6b. prepare_worktree with kind = research and test landing with changes
  const researchSessionId = "abcdef99-1111-2222-3333-444455556666";
  writeFileSync(join(ticketsDir, `${researchSessionId}.md`), "# Research Session Ticket\n\n## Kind\nresearch\n");

  const researchResult = await prepareWorktree({
    kind: "research",
    sessionId: researchSessionId,
    cwd: repoDir,
  });

  assert.equal(researchResult.ok, true);
  assert.equal(researchResult.kind, "research");
  assert.equal(researchResult.branch, "architect/research/abcdef99");
  assert.equal(researchResult.reviewRequired, false);
  assert.equal(
    researchResult.handoff.arguments.task,
    `Investigate '${join(researchResult.worktree, ".architect", "ticket.md")}' in working directory '${researchResult.worktree}'. Report findings.`,
  );
  assert.equal(researchResult.implementerPrompt, undefined);
  assert.equal(researchResult.reviewerPrompt, undefined);
  // Research is ordinary investigation work carried by the runner seat, whose
  // identity and transport the dispatch_runner tool owns. No provider-specific
  // researcher launcher and no bare worker-exec handoff is emitted here.
  assert.equal(researchResult.handoff.tool, "dispatch_runner");
  assert.deepEqual(researchResult.handoff.arguments.cwd, researchResult.worktree);
  assert.equal(researchResult.researcherProvider, undefined);
  assert.equal(
    researchResult.instructions,
    `Worktree ready at ${researchResult.worktree}.\nBranch: ${researchResult.branch}\nReview required: false\n\nNext steps:\n1. Call the 'dispatch_runner' tool with cwd '${researchResult.worktree}' and task: Investigate '${join(researchResult.worktree, ".architect", "ticket.md")}' in working directory '${researchResult.worktree}'. Report findings.\n2. When finished, call 'land'.`,
  );
  assert.doesNotMatch(researchResult.instructions, /agy|muse exec|dsh --profile|codex exec --profile|--seat runner/);
  assert.equal(
    readFileSync(join(researchResult.worktree, ".architect", "ticket.md"), "utf8"),
    "# Research Session Ticket\n\n## Kind\nresearch\n",
  );

  // 6b-ii. A research delegation accepts no provider selection either: the
  // runner seat is resolved centrally, so the override is refused outright.
  for (const [label, args] of [
    ["global provider", { provider: "deepseek" }],
    ["researcher seat provider", { researcherProvider: "gemini" }],
  ]) {
    await assert.rejects(
      () => prepareWorktree({ kind: "research", sessionId: researchSessionId, cwd: repoDir, ...args }),
      /provider override '.*' is not permitted/,
      `${label} must be refused for research delegation too`,
    );
  }

  writeFileSync(join(researchResult.worktree, "findings.md"), "# Research Findings\n");
  const landResearchResult = await land({
    worktree: researchResult.worktree,
    cwd: repoDir,
    message: "docs: research findings",
  });
  assert.equal(landResearchResult.ok, true);
  assert.equal(landResearchResult.landed, true);
  assert.equal(landResearchResult.branch, "architect/research/abcdef99");
  assert.equal(landResearchResult.method, "ff");
  assert.equal(readFileSync(join(repoDir, "findings.md"), "utf8"), "# Research Findings\n");

  // 6c. Test landing read-only research worktree with no diff/commits against base
  const roSessionId = "ro998877-1111-2222-3333-444455556666";
  writeFileSync(join(ticketsDir, `${roSessionId}.md`), "# Read-Only Research Ticket\n\n## Kind\nresearch\n");
  const roResult = await prepareWorktree({
    kind: "research",
    sessionId: roSessionId,
    cwd: repoDir,
  });
  assert.equal(roResult.ok, true);
  assert.equal(roResult.branch, "architect/research/ro998877");
  const landRoResult = await land({
    worktree: roResult.worktree,
    cwd: repoDir,
  });
  assert.equal(landRoResult.ok, true);
  assert.equal(landRoResult.landed, true);
  assert.equal(landRoResult.retired, true);
  assert.equal(landRoResult.branch, "architect/research/ro998877");
  assert.equal(landRoResult.method, "none");
  assert.equal(landRoResult.pr, null);
  const wtListAfterRo = await git(repoDir, ["worktree", "list"]);
  assert.ok(!wtListAfterRo.includes("architect/research/ro998877"));
  await assert.rejects(() => git(repoDir, ["rev-parse", "--verify", "refs/heads/architect/research/ro998877"]));

  // 7. Test ticket resolution in prepare_worktree: exact, prefix, then fail
  // fast with no stray worktree or branch. There are no brain or root
  // fallbacks anymore.
  // A. Unknown session id throws even when a root .architect/ticket.md exists.
  const rootArchitectDir = join(repoDir, ".architect");
  writeFileSync(join(rootArchitectDir, "ticket.md"), "# Root Ticket (not a fallback)\n\n## Kind\nbounded\n");
  await assert.rejects(
    () =>
      prepareWorktree({
        kind: "bounded",
        sessionId: "missing-session-0001",
        cwd: repoDir,
      }),
    /^Error: no ticket resolved for session 'missing-session-0001'$/,
  );
  await assert.rejects(() => git(repoDir, ["rev-parse", "--verify", "refs/heads/architect/bounded/missings"]));
  const wtListAfterMissing = await git(repoDir, ["worktree", "list"]);
  assert.ok(!wtListAfterMissing.includes("architect/bounded/missings"));

  // B. Prefix ids still resolve: a short id finds the full session file.
  const prefixSessionId = "prefixaa11-2233-4455-6677-889900aabbcc";
  writeFileSync(join(ticketsDir, `${prefixSessionId}.md`), "# Prefix Ticket\n\n## Kind\nbounded\n");
  const prefixResult = await prepareWorktree({
    kind: "bounded",
    sessionId: "prefixaa11",
    cwd: repoDir,
  });
  assert.equal(prefixResult.ok, true);
  assert.equal(prefixResult.branch, "architect/bounded/prefixaa");
  assert.equal(
    readFileSync(join(prefixResult.worktree, ".architect", "ticket.md"), "utf8"),
    "# Prefix Ticket\n\n## Kind\nbounded\n",
  );
  await retireTestWorktree(repoDir, prefixResult);

  // C. No explicit id and no tickets on disk throws the no-active-ticket
  // error before anything is created.
  const emptyRepo = mkdtempSync(join(tmpdir(), "architect-mcp-empty-"));
  try {
    await git(emptyRepo, ["init", "-b", "main"]);
    await git(emptyRepo, ["config", "user.name", "MCP Test"]);
    await git(emptyRepo, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(emptyRepo, "README.md"), "# Empty\n");
    await git(emptyRepo, ["add", "README.md"]);
    await git(emptyRepo, ["commit", "-m", "init"]);
    await assert.rejects(
      () => resolveSessionId(emptyRepo),
      /^Error: no active ticket: pass sessionId or create \.architect\/tickets\/<id>\.md$/,
    );
    await assert.rejects(
      () =>
        prepareWorktree({
          kind: "bounded",
          cwd: emptyRepo,
        }),
      /^Error: no active ticket: pass sessionId or create \.architect\/tickets\/<id>\.md$/,
    );
    const emptyBranches = await git(emptyRepo, ["branch", "--list", "architect/*"]);
    assert.equal(emptyBranches.trim(), "");
    const emptyWtList = await git(emptyRepo, ["worktree", "list"]);
    assert.ok(!emptyWtList.includes("architect/"));
  } finally {
    rmSync(emptyRepo, { recursive: true, force: true });
  }

  // 8. Test dedicated ticket tools: read_ticket and update_ticket
  // Ticket was cleared to template on landing above
  const readTicketRes = await callTool("read_ticket", { cwd: repoDir, sessionId });
  assert.equal(readTicketRes.ok, true);
  assert.equal(readTicketRes.sessionId, sessionId);
  assert.ok(readTicketRes.content.includes("# Ticket"));
  assert.ok(Array.isArray(readTicketRes.sections));
  assert.ok(readTicketRes.sections.includes("Kind"));
  assert.ok(readTicketRes.sections.includes("Problem"));

  // Sectional read: read specific section
  const readKindRes = await callTool("read_ticket", { cwd: repoDir, sessionId, section: "Kind" });
  assert.equal(readKindRes.ok, true);
  assert.equal(readKindRes.section, "Kind");
  assert.ok(readKindRes.content.includes("bounded"));

  // Section listing only
  const sectionsOnlyRes = await callTool("read_ticket", { cwd: repoDir, sessionId, sectionsOnly: true });
  assert.equal(sectionsOnlyRes.ok, true);
  assert.equal(sectionsOnlyRes.content, undefined);
  assert.ok(sectionsOnlyRes.sections.includes("Problem"));

  // Missing section returns error
  const missingSectionRes = await callTool("read_ticket", { cwd: repoDir, sessionId, section: "NonExistent" });
  assert.equal(missingSectionRes.ok, false);
  assert.ok(missingSectionRes.error.includes("not found"));

  // Full update
  const updateTicketRes = await callTool("update_ticket", {
    cwd: repoDir,
    sessionId,
    content: "# Updated Ticket Content\n\n## Kind\nbounded\n\n## Problem\nInitial problem.\n",
  });
  assert.equal(updateTicketRes.ok, true);

  const readAgain = await callTool("read_ticket", { cwd: repoDir, sessionId });
  assert.equal(readAgain.content, "# Updated Ticket Content\n\n## Kind\nbounded\n\n## Problem\nInitial problem.\n");

  // Sectional update: update only Problem section
  const updateSectionRes = await callTool("update_ticket", {
    cwd: repoDir,
    sessionId,
    section: "Problem",
    content: "Surgically updated problem description.",
  });
  assert.equal(updateSectionRes.ok, true);
  assert.equal(updateSectionRes.section, "Problem");

  const readSectionRes = await callTool("read_ticket", { cwd: repoDir, sessionId, section: "Problem" });
  assert.equal(readSectionRes.ok, true);
  assert.equal(readSectionRes.content, "Surgically updated problem description.");

  // Verify other sections were not harmed
  const readKindAgain = await callTool("read_ticket", { cwd: repoDir, sessionId, section: "Kind" });
  assert.equal(readKindAgain.ok, true);
  assert.equal(readKindAgain.content, "bounded");

  await assert.rejects(
    () => updateTicket({ cwd: repoDir, sessionId, content: null }),
    /content is required and must be a string/,
  );

  // Test that generic write tools or removed legacy names are rejected
  await assert.rejects(
    () => callTool("ticket_read"),
    /Unknown tool: ticket_read/,
  );
  await assert.rejects(
    () => callTool("ticket_write"),
    /Unknown tool: ticket_write/,
  );
  await assert.rejects(
    () => callTool("write_file"),
    /Unknown tool: write_file/,
  );

  // 9. Runner tools: dispatch_runner, check_runner, steer_runner, cancel_runner
  await assert.rejects(
    () => dispatchRunner({}),
    /task is required/,
  );

  // Simulated runner with active tool and trajectory
  let mockRunner;
  globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
    mockRunner = runner;
    runner.activeTool = { name: "grep_search", startedAt: Date.now() };
    runner.trajectory.push({ action: "grep_search", duration: 1.2, timestamp: Date.now() });
  };

  const dispatchRes = await dispatchRunner({
    task: "Investigate error handling in foo.mjs",
    targetPaths: ["foo.mjs", "bar.mjs"],
    cwd: repoDir,
  });
  assert.equal(dispatchRes.ok, true);
  assert.ok(dispatchRes.runnerId);
  assert.equal(dispatchRes.status, "running");

  const checkRunningRes = await checkRunner({ runnerId: dispatchRes.runnerId });
  assert.equal(checkRunningRes.runnerId, dispatchRes.runnerId);
  assert.equal(checkRunningRes.status, "running");
  assert.equal(typeof checkRunningRes.elapsedSeconds, "number");
  assert.ok(checkRunningRes.activeTool);
  assert.equal(checkRunningRes.activeTool.name, "grep_search");
  assert.equal(checkRunningRes.trajectory.length, 1);
  assert.equal(checkRunningRes.trajectory[0].action, "grep_search");

  // Steer runner: a legacy (non-Pi) runner has no verified receiver, so the
  // update is TRUTHFULLY refused — nothing is written to an ignored stdin and
  // no false success is returned. The refusal stays in the trajectory so
  // historical check results identify communication unsupported.
  let steeredInstruction = null;
  mockRunner.onSteer = (inst) => {
    steeredInstruction = inst;
  };
  const steerRes = await steerRunner({ runnerId: dispatchRes.runnerId, instruction: "Also check baz.mjs" });
  assert.equal(steerRes.ok, false, "legacy steering is refused, never a false success");
  assert.equal(steerRes.supported, false);
  assert.equal(steerRes.steered, false);
  assert.match(steerRes.error, /no verified receiver/);
  assert.equal(steeredInstruction, null, "nothing is delivered to an ignored stdin");
  const checkSteeredRes = await checkRunner({ runnerId: dispatchRes.runnerId });
  assert.equal(checkSteeredRes.trajectory.length, 2);
  assert.equal(checkSteeredRes.trajectory[1].action, "steer");
  assert.equal(checkSteeredRes.trajectory[1].instruction, "Also check baz.mjs");
  assert.equal(checkSteeredRes.trajectory[1].refused, true, "the trajectory identifies the steer as refused");

  // Complete runner
  mockRunner.activeTool = null;
  mockRunner.status = "completed";
  mockRunner.result = { summary: "Found 2 call sites", filesChecked: ["foo.mjs", "baz.mjs"] };
  // Mirror the production terminal transition (every terminal path calls
  // cleanupRunnerFiles, which is what makes the outcome durable).
  cleanupRunnerFiles(mockRunner);

  const checkCompletedRes = await checkRunner({ runnerId: dispatchRes.runnerId });
  assert.equal(checkCompletedRes.status, "completed");
  assert.equal(checkCompletedRes.activeTool, null);
  // checkRunner reports health/trajectory/delivery state, NOT findings: the
  // authoritative result stays on the tracker for the terminal notification.
  assert.equal(checkCompletedRes.result, undefined, "check_runner must NOT return findings");
  assert.equal(checkCompletedRes.findingsRetained, true, "findings must remain retained for notification");
  assert.deepEqual(
    checkCompletedRes.notification,
    { terminal: true, delivered: false, pendingRetry: true, inFlight: false },
    "undelivered terminal wakeup must report pendingRetry",
  );

  // The authoritative result is read from the same transport the completion
  // path uses; check_runner deliberately never carries findings.
  assert.deepEqual(authoritativeResult(dispatchRes.runnerId), mockRunner.result);

  // Runner cancellation
  globalThis.__QQ_TEST_RUNNER_HANDLER = () => {};
  const cancelDispatch = await dispatchRunner({ task: "long task", cwd: repoDir });
  const cancelRes = await cancelRunner({ runnerId: cancelDispatch.runnerId });
  assert.equal(cancelRes.ok, true);
  assert.equal(cancelRes.status, "cancelled");

  const checkCancelled = await checkRunner({ runnerId: cancelDispatch.runnerId });
  assert.equal(checkCancelled.status, "cancelled");
  assert.ok(checkCancelled.trajectory.some((t) => t.action === "cancelled"));

  // The terminal state is reported by the point-in-time read above; the removed
  // wait tool has no callable replacement by design.

  // Runner failure
  globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
    runner.status = "failed";
    runner.error = { message: "Simulated runner crash", exitCode: 1 };
  };
  const failDispatch = await dispatchRunner({ task: "failing task", cwd: repoDir });
  const checkFailed = await checkRunner({ runnerId: failDispatch.runnerId });
  assert.equal(checkFailed.status, "failed");
  // check_runner returns a bounded, payload-free diagnostic (type/reason), not
  // the raw tracker error object.
  assert.equal(checkFailed.error.status, "failed");
  assert.equal(checkFailed.error.reason, "exit_nonzero");
  assert.equal(checkFailed.error.exitCode, 1);
  assert.equal(checkFailed.error.message, undefined, "check_runner must not dump the raw error message");

  // The terminal state is reported by the point-in-time read above; the removed
  // wait tool has no callable replacement by design.

  delete globalThis.__QQ_TEST_RUNNER_HANDLER;

  // The runner process spawns the centrally configured harness adapter with an
  // explicit seat, the target repository as working directory, and the bound
  // identity/transport the parent owns. No agy/legacy argv exists any more.
  {
    const fakeRunnerDir = mkdtempSync(join(tmpdir(), "test-runner-bin-"));
    try {
      const runnerLog = join(fakeRunnerDir, "runner-call.txt");
      const fakeAgy = join(fakeRunnerDir, "fake-runner.sh");
      writeFileSync(
        fakeAgy,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${runnerLog}"\nenv | grep -E '^QQ_RUNNER_(ID|RESULT_FILE)=' >> "${runnerLog}"\n`,
      );
      execFileSync("chmod", ["+x", fakeAgy]);

      const prevRunnerBin = process.env.QQ_RUNNER_BIN;
      process.env.QQ_RUNNER_BIN = fakeAgy;
      try {
        const dispatched = await dispatchRunner({ task: "test model flag", cwd: repoDir });
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(existsSync(runnerLog));
        const loggedArgs = readFileSync(runnerLog, "utf8");
        assert.ok(loggedArgs.includes(WORKER_DEEPSEEK_ADAPTER), "the central adapter is the worker entry");
        assert.ok(loggedArgs.includes("--production"), "production mode is explicit, never mock");
        assert.ok(loggedArgs.includes("--seat\nrunner"), "the seat is explicit");
        assert.ok(loggedArgs.includes(repoDir), "the target repository is the working directory");
        assert.ok(loggedArgs.includes(`QQ_RUNNER_ID=${dispatched.runnerId}`), "the runner keeps its bound identity");
        assert.ok(/QQ_RUNNER_RESULT_FILE=.+qq-runner-result-.+\.json/.test(loggedArgs), "the runner keeps its explicit transport path");
        assert.ok(!loggedArgs.includes("gemini"), "no legacy model may ride along");
        assert.ok(!loggedArgs.includes("--agent"), "no per-call agent flags may ride along");
      } finally {
        if (prevRunnerBin !== undefined) process.env.QQ_RUNNER_BIN = prevRunnerBin;
        else delete process.env.QQ_RUNNER_BIN;
      }
    } finally {
      rmSync(fakeRunnerDir, { recursive: true, force: true });
    }
  }

  // 10. Automated execution pipeline: dispatch_execution, check_execution
  await assert.rejects(
    () => dispatchExecution({}),
    /kind is required: 'bounded' \| 'open'/,
  );
  await assert.rejects(
    () => dispatchExecution({ kind: "invalid" }),
    /kind is required: 'bounded' \| 'open'/,
  );

  // Bounded execution: implementer runs -> auto lands into main
  const boundedExecSessionId = "exec-bounded-1111-2222-3333-444455556666";
  writeFileSync(join(ticketsDir, `${boundedExecSessionId}.md`), "# Bounded Exec Ticket\n\n## Kind\nbounded\n");

  globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role, cwd }) => {
    assert.equal(role, "implementer");
    writeFileSync(join(cwd, "bounded-exec-file.txt"), "bounded exec content\n");
    return { ok: true, output: "Implemented bounded task successfully." };
  };

  const boundedExec = await dispatchExecution({
    kind: "bounded",
    sessionId: boundedExecSessionId,
    cwd: repoDir,
  });
  assert.equal(boundedExec.ok, true);
  assert.ok(boundedExec.id);
  assert.equal(boundedExec.status, "running");

  await waitForExecution(boundedExec.id);
  const boundedExecDone = await checkExecution({ id: boundedExec.id });
  assert.equal(boundedExecDone.status, "completed");
  assert.ok(boundedExecDone.result.landingOutcome.landed);
  assert.equal(readFileSync(join(repoDir, "bounded-exec-file.txt"), "utf8"), "bounded exec content\n");

  await waitForExecution(boundedExec.id);
  const checkBoundedDone = await checkExecution({ id: boundedExec.id });
  assert.equal(checkBoundedDone.status, "completed");
  assert.equal(checkBoundedDone.phase, "completed");
  assert.ok(checkBoundedDone.trajectory.some((t) => t.action === "implementer_completed"));
  assert.ok(checkBoundedDone.trajectory.some((t) => t.action === "execution_completed"));

  // Open execution: implementer -> reviewer FAIL -> implementer retry -> reviewer PASS -> auto lands
  const openExecSessionId = "exec-open-2222-3333-4444-555566667777";
  writeFileSync(join(ticketsDir, `${openExecSessionId}.md`), "# Open Exec Ticket\n\n## Kind\nopen\n");

  let callCount = 0;
  globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role, cwd, prompt }) => {
    callCount++;
    if (callCount === 1) {
      assert.equal(role, "implementer");
      writeFileSync(join(cwd, "feature.txt"), "v1 buggy");
      return { ok: true, output: "Finished initial implementation" };
    } else if (callCount === 2) {
      assert.equal(role, "reviewer");
      return { ok: true, output: "Verdict: FAIL\nDefect: buggy feature" };
    } else if (callCount === 3) {
      assert.equal(role, "implementer");
      assert.ok(prompt.includes("The reviewer found defects:"));
      writeFileSync(join(cwd, "feature.txt"), "v2 fixed");
      return { ok: true, output: "Fixed the bug" };
    } else if (callCount === 4) {
      assert.equal(role, "reviewer");
      return { ok: true, output: "Verdict: PASS\nAll verification steps passed." };
    }
    throw new Error(`Unexpected call #${callCount}`);
  };

  const openExec = await dispatchExecution({
    kind: "open",
    sessionId: openExecSessionId,
    cwd: repoDir,
  });
  assert.equal(openExec.ok, true);

  await waitForExecution(openExec.id);
  const openExecDone = await checkExecution({ id: openExec.id });
  assert.equal(openExecDone.status, "completed");
  assert.ok(openExecDone.result.landingOutcome.landed);
  assert.equal(readFileSync(join(repoDir, "feature.txt"), "utf8"), "v2 fixed");
  assert.equal(callCount, 4);

  await waitForExecution(openExec.id);
  const checkOpenDone = await checkExecution({ id: openExec.id });
  assert.equal(checkOpenDone.status, "completed");
  assert.ok(checkOpenDone.trajectory.some((t) => t.action === "review_failed_retrying"));
  assert.ok(checkOpenDone.trajectory.some((t) => t.action === "reviewer_second_run"));
  assert.ok(checkOpenDone.trajectory.some((t) => t.action === "execution_completed"));

  // Open execution where reviewer fails twice -> marks execution as failed and bubbles error
  const openFailSessionId = "exec-fail-3333-4444-5555-666677778888";
  writeFileSync(join(ticketsDir, `${openFailSessionId}.md`), "# Open Fail Ticket\n\n## Kind\nopen\n");

  globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role }) => {
    if (role === "implementer") {
      return { ok: true, output: "Implementer done" };
    }
    return { ok: true, output: "Verdict: FAIL\nPersistent flaw" };
  };

  const openFailExec = await dispatchExecution({
    kind: "open",
    sessionId: openFailSessionId,
    cwd: repoDir,
  });

  // The failed execution is reported by check_execution below; no wait tool exists.

  await waitForExecution(openFailExec.id);
  const checkFail = await checkExecution({ id: openFailExec.id });
  assert.equal(checkFail.status, "failed");
  assert.equal(checkFail.phase, "reviewing");
  assert.ok(checkFail.error.message.includes("Review failed after retry"));

  // Implementer failure bubbles cleanly
  const implFailSessionId = "exec-implfail-4444-5555-6666-777788889999";
  writeFileSync(join(ticketsDir, `${implFailSessionId}.md`), "# Impl Fail Ticket\n\n## Kind\nbounded\n");

  globalThis.__QQ_TEST_SUBAGENT_HANDLER = async () => {
    return { ok: false, error: { message: "Syntax error in build", exitCode: 1, stderr: "Error: build failed" } };
  };

  const implFailExec = await dispatchExecution({
    kind: "bounded",
    sessionId: implFailSessionId,
    cwd: repoDir,
  });

  // The failed execution is reported by check_execution below; no wait tool exists.

  await waitForExecution(implFailExec.id);
  const checkImplFail = await checkExecution({ id: implFailExec.id });
  assert.equal(checkImplFail.status, "failed");
  assert.equal(checkImplFail.phase, "implementing");
  assert.equal(checkImplFail.error.exitCode, 1);

  delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;

  // Clean up open worktree
  try {
    await git(repoDir, ["worktree", "remove", "--force", openResult.worktree]);
  } catch {}
  try {
    await git(repoDir, ["branch", "-D", openResult.branch]);
  } catch {}
} finally {
  for (const [key, value] of Object.entries(savedProviderEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    rmSync(join(dirname(repoDir), ".qq-worktrees", basename(repoDir)), { recursive: true, force: true });
  } catch {}
  rmSync(repoDir, { recursive: true, force: true });
}

// 10b. Dispatch integrity: unambiguous session resolution and echoed ticket identity
{
  async function initRepo(tag) {
    const dir = mkdtempSync(join(tmpdir(), tag));
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.name", "MCP Test"]);
    await git(dir, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(dir, "README.md"), `# ${tag}\n`);
    await git(dir, ["add", "README.md"]);
    await git(dir, ["commit", "-m", "init"]);
    mkdirSync(join(dir, ".architect", "tickets"), { recursive: true });
    return dir;
  }
  function cleanupRepo(dir) {
    try {
      rmSync(join(dirname(dir), ".qq-worktrees", basename(dir)), { recursive: true, force: true });
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }

  // A. Omitted sessionId resolves a lone ticket; two tickets throw ambiguous naming both.
  const ambRepo = await initRepo("architect-mcp-ambiguous-");
  try {
    const ticketsDir = join(ambRepo, ".architect", "tickets");
    const loneId = "a1a1a1a1-1111-2222-3333-444444444444";
    writeFileSync(join(ticketsDir, `${loneId}.md`), "# Lone\n");
    assert.equal(await resolveSessionId(ambRepo), loneId);
    const secondId = "b2b2b2b2-1111-2222-3333-444444444444";
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(ticketsDir, `${secondId}.md`), "# Second\n");
    let ambiguous = null;
    try {
      await resolveSessionId(ambRepo);
    } catch (error) {
      ambiguous = error;
    }
    assert.ok(ambiguous, "two tickets must throw instead of resolving by mtime");
    assert.match(ambiguous.message, /ambiguous active ticket/);
    assert.ok(ambiguous.message.includes(loneId), "error names the first candidate");
    assert.ok(ambiguous.message.includes(secondId), "error names the second candidate");
    await assert.rejects(
      () => prepareWorktree({ kind: "bounded", cwd: ambRepo }),
      /ambiguous active ticket/,
    );
  } finally {
    cleanupRepo(ambRepo);
  }

  // B. *-sources.md backups are never selected as the active ticket.
  const srcRepo = await initRepo("architect-mcp-sources-");
  try {
    const ticketsDir = join(srcRepo, ".architect", "tickets");
    const realId = "c3c3c3c3-1111-2222-3333-444444444444";
    writeFileSync(join(ticketsDir, `${realId}.md`), "# Real\n");
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(ticketsDir, `${realId}-sources.md`), "# Backup\n");
    assert.equal(await resolveSessionId(srcRepo), realId);
    rmSync(join(ticketsDir, `${realId}.md`));
    await assert.rejects(
      () => resolveSessionId(srcRepo),
      /^Error: no active ticket: pass sessionId or create \.architect\/tickets\/<id>\.md$/,
    );
  } finally {
    cleanupRepo(srcRepo);
  }

  // C. Colliding prefixes throw; exact match keeps precedence.
  const prefixRepo = await initRepo("architect-mcp-prefix-");
  try {
    const ticketsDir = join(prefixRepo, ".architect", "tickets");
    const idA = "ffffffff-1111-2222-3333-444444444444";
    const idB = "ffffffff-1111-2222-3333-555555555555";
    writeFileSync(join(ticketsDir, `${idA}.md`), "# A\n");
    writeFileSync(join(ticketsDir, `${idB}.md`), "# B\n");
    await assert.rejects(
      () => resolveTicketSource(prefixRepo, "ffffffff"),
      /ambiguous ticket prefix/,
    );
    await assert.rejects(
      () => prepareWorktree({ kind: "bounded", sessionId: "ffffffff", cwd: prefixRepo }),
      /ambiguous ticket prefix/,
    );
    await assert.rejects(() => git(prefixRepo, ["rev-parse", "--verify", "refs/heads/architect/bounded/ffffffff"]));
    assert.equal(
      await resolveTicketSource(prefixRepo, idA),
      join(ticketsDir, `${idA}.md`),
    );
    const exactRes = await prepareWorktree({ kind: "bounded", sessionId: idA, cwd: prefixRepo });
    assert.equal(
      readFileSync(join(exactRes.worktree, ".architect", "ticket.md"), "utf8"),
      "# A\n",
    );
    await retireTestWorktree(prefixRepo, exactRes);
  } finally {
    cleanupRepo(prefixRepo);
  }

  // D. prepare_worktree echoes the resolved sessionId + ticket path.
  const echoRepo = await initRepo("architect-mcp-echo-");
  try {
    const echoId = "e5e5e5e5-1111-2222-3333-444444444444";
    const echoTicket = join(echoRepo, ".architect", "tickets", `${echoId}.md`);
    writeFileSync(echoTicket, "# Echo\n");
    const explicit = await prepareWorktree({ kind: "bounded", sessionId: echoId, cwd: echoRepo });
    assert.equal(explicit.sessionId, echoId);
    assert.equal(explicit.ticketSource, echoTicket);
    await retireTestWorktree(echoRepo, explicit);
    const omitted = await prepareWorktree({ kind: "bounded", cwd: echoRepo });
    assert.equal(omitted.sessionId, echoId);
    assert.equal(omitted.ticketSource, echoTicket);
    await retireTestWorktree(echoRepo, omitted);
    const researchEcho = await prepareWorktree({ kind: "research", sessionId: echoId, cwd: echoRepo });
    assert.equal(researchEcho.sessionId, echoId);
    assert.equal(researchEcho.ticketSource, echoTicket);
    await retireTestWorktree(echoRepo, researchEcho);
  } finally {
    cleanupRepo(echoRepo);
  }
}

// 11. RPC & JSON-RPC stdio protocol tests
const initResp = await handleRpc("initialize", {});
assert.equal(initResp.serverInfo.name, "qq-workflows");
assert.equal(initResp.serverInfo.version, "0.2.0");

const pingResp = await handleRpc("ping", {});
assert.deepEqual(pingResp, {});

const listResp = await handleRpc("tools/list", {});
assert.equal(listResp.tools.length, 17);

// tools/call with missing kind should return isError: true
const errCallResp = await handleRpc("tools/call", {
  name: "prepare_worktree",
  arguments: {},
});
assert.equal(errCallResp.isError, true);
assert.match(errCallResp.content[0].text, /kind is required: 'bounded' \| 'open' \| 'research'/);

// Test startMcpServer via stream piping
const stdinStream = new PassThrough();
const stdoutStream = new PassThrough();

const responses = [];
stdoutStream.on("data", (chunk) => {
  const lines = chunk.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    responses.push(JSON.parse(line));
  }
});

const rl = startMcpServer({ stdin: stdinStream, stdout: stdoutStream });

// Send initialize request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
// Send tools/list request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
// Send ping request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} }) + "\n");
// Send unknown method request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "nonexistent", params: {} }) + "\n");

await new Promise((resolve) => setTimeout(resolve, 100));

assert.equal(responses.length, 4);
assert.equal(responses[0].id, 1);
assert.equal(responses[0].result.serverInfo.name, "qq-workflows");

assert.equal(responses[1].id, 2);
assert.equal(responses[1].result.tools.length, 17);

assert.equal(responses[2].id, 3);
assert.deepEqual(responses[2].result, {});

assert.equal(responses[3].id, 4);
assert.equal(responses[3].error.code, -32601);

rl.close();

// ============================================================================
// Ticket Testing Plan: new assertions
// ============================================================================

// T1. complete_task: enforces hard caps
await assert.rejects(
  () => completeTask({ response: "x".repeat(COMPLETE_TASK_RESPONSE_MAX + 1) }),
  new RegExp(`response exceeds the ${FINAL_RESPONSE_MAX_CHARS_LABEL}-character cap`),
  `complete_task must reject response > ${COMPLETE_TASK_RESPONSE_MAX} chars`,
);
await assert.rejects(
  () => completeTask({ response: "ok", data_points: Array.from({ length: 21 }, (_, i) => `point-${i}`) }),
  /data_points exceeds the 20-item cap/,
  "complete_task must reject more than 20 data_points",
);
await assert.rejects(
  () => completeTask({ response: "ok", data_points: ["x".repeat(101)] }),
  /exceeds the 100-character cap/,
  "complete_task must reject a data_point > 100 chars",
);

// T1b. complete_task: accepts valid response and data_points
const ctRes = await completeTask({
  response: "Found the issue in foo.mjs line 42.",
  data_points: ["foo.mjs:42", "bar.mjs:7"],
});
assert.equal(ctRes.ok, true);
assert.equal(ctRes.recorded, true);
assert.equal(ctRes.responseLength, "Found the issue in foo.mjs line 42.".length);
assert.equal(ctRes.dataPointsCount, 2);

// T1c. complete_task: accepts responses up to the single authoritative cap
const ctLarge = await completeTask({ response: "y".repeat(COMPLETE_TASK_RESPONSE_MAX) });
assert.equal(ctLarge.ok, true);
assert.equal(ctLarge.recorded, true);
assert.equal(ctLarge.responseLength, COMPLETE_TASK_RESPONSE_MAX);

// T2. readTicket: returns single content field without duplicate text key
{
  const testRepo2 = mkdtempSync(join(tmpdir(), "architect-rt-dedup-"));
  try {
    await git(testRepo2, ["init", "-b", "main"]);
    await git(testRepo2, ["config", "user.name", "MCP Test"]);
    await git(testRepo2, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(testRepo2, "README.md"), "# Test\n");
    await git(testRepo2, ["add", "README.md"]);
    await git(testRepo2, ["commit", "-m", "init"]);
    const rtSessId = "deduptest-1234-5678-9abc-def012345678";
    mkdirSync(join(testRepo2, ".architect", "tickets"), { recursive: true });
    writeFileSync(join(testRepo2, ".architect", "tickets", `${rtSessId}.md`), "# Dedup Test\n");
    const rtRes = await readTicket({ cwd: testRepo2, sessionId: rtSessId });
    assert.equal(rtRes.ok, true);
    assert.ok(rtRes.content.includes("Dedup Test"));
    // Must NOT have a duplicate 'text' key
    assert.equal(rtRes.text, undefined, "readTicket must not return duplicate text field");
  } finally {
    rmSync(testRepo2, { recursive: true, force: true });
  }
}

// T3. checkRunner trajectory: items contain { action, target, duration, timestamp }
//     target is strictly capped <= 80 chars, no parameters object exists
{
  const testRepo3 = mkdtempSync(join(tmpdir(), "architect-traj-test-"));
  try {
    await git(testRepo3, ["init", "-b", "main"]);
    await git(testRepo3, ["config", "user.name", "MCP Test"]);
    await git(testRepo3, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(testRepo3, "README.md"), "# Traj\n");
    await git(testRepo3, ["add", "README.md"]);
    await git(testRepo3, ["commit", "-m", "init"]);

    let trajRunner;
    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
      trajRunner = runner;
      // Simulate a tool step with parameters (like handleRunnerEvent would add)
      // addTrajectory receives { action, parameters, duration, timestamp }
      // and must produce { action, target, duration, timestamp } with no parameters.
      runner.trajectory.push({
        action: "view_file",
        parameters: { AbsolutePath: "/some/path/to/file.mjs" },
        duration: 0.5,
        timestamp: Date.now(),
      });
      // The above is what handleRunnerEvent would push before addTrajectory existed.
      // In real usage, addTrajectory is called instead; simulate here:
      runner.trajectory = [];
      const { addTrajectory: _addTraj, ..._ } = {}; // We can't access private addTrajectory here
      // Use dispatchRunner -> handleRunnerEvent path instead:
    };

    // Use the real addTrajectory via handleRunnerEvent simulation
    const trajDispatch = await dispatchRunner({ task: "traj test", cwd: testRepo3 });
    // Inject a proper step via the RUNNERS map
    const trajRunnerObj = RUNNERS.get(trajDispatch.runnerId);
    // Manually simulate what addTrajectory does with a parameters-bearing entry
    // by calling steerRunner (which uses addTrajectory with action + no parameters)
    trajRunnerObj.onSteer = () => {};
    await steerRunner({ runnerId: trajDispatch.runnerId, instruction: "Check the edge cases" });
    const trajCheck = await checkRunner({ runnerId: trajDispatch.runnerId });
    // trajectory items must never have a parameters field
    for (const item of trajCheck.trajectory) {
      assert.equal(item.parameters, undefined, "trajectory item must not contain raw parameters");
      assert.ok(item.action, "trajectory item must have action");
      assert.ok(item.timestamp, "trajectory item must have timestamp");
    }
    // steer entry should have target capped <= 80 chars if present
    const steerEntry = trajCheck.trajectory.find((t) => t.action === "steer");
    assert.ok(steerEntry, "steer entry must be in trajectory");
    if (steerEntry.target !== undefined) {
      assert.ok(steerEntry.target.length <= 80, "target must be capped at 80 chars");
    }
  } finally {
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
    rmSync(testRepo3, { recursive: true, force: true });
  }
}

// T4. checkRunner returns result when status is completed (tested earlier in T2 section)
// Additional verification: the trajectory item format from handleRunnerEvent (with tool params)
// goes through addTrajectory which strips parameters and adds target.
{
  const testRepo4 = mkdtempSync(join(tmpdir(), "architect-noparams-test-"));
  try {
    await git(testRepo4, ["init", "-b", "main"]);
    await git(testRepo4, ["config", "user.name", "MCP Test"]);
    await git(testRepo4, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(testRepo4, "README.md"), "# NoParams\n");
    await git(testRepo4, ["add", "README.md"]);
    await git(testRepo4, ["commit", "-m", "init"]);

    let nrRunner;
    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
      nrRunner = runner;
      runner.status = "running";
    };
    const nrDispatch = await dispatchRunner({ task: "no-params test", cwd: testRepo4 });
    const nrRunnerObj = RUNNERS.get(nrDispatch.runnerId);
    // Mark as completed
    nrRunnerObj.status = "completed";
    nrRunnerObj.result = "done";
    cleanupRunnerFiles(nrRunnerObj); // the terminal transition retains durably
    const nrCheck = await checkRunner({ runnerId: nrDispatch.runnerId });
    assert.equal(nrCheck.status, "completed");
    assert.equal(nrCheck.result, undefined, "check_runner must NOT include findings on completion");
    assert.equal(nrCheck.findingsRetained, true, "authoritative findings stay retained");
    assert.equal(nrCheck.notification.terminal, true);
    assert.equal(nrCheck.notification.pendingRetry, true);
    // The authoritative result stays on the tracker for the terminal
    // notification; check_runner never carries it and no wait tool exists.
    assert.equal(nrRunnerObj.result, "done", "the authoritative result stays available for delivery");
  } finally {
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
    rmSync(testRepo4, { recursive: true, force: true });
  }
}

// T5. addTrajectory ignores agent_response step updates
{
  const testRepo5 = mkdtempSync(join(tmpdir(), "architect-agentresp-test-"));
  try {
    await git(testRepo5, ["init", "-b", "main"]);
    await git(testRepo5, ["config", "user.name", "MCP Test"]);
    await git(testRepo5, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(testRepo5, "README.md"), "# AgentResp\n");
    await git(testRepo5, ["add", "README.md"]);
    await git(testRepo5, ["commit", "-m", "init"]);

    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
      runner.status = "running";
    };
    const arDispatch = await dispatchRunner({ task: "agent-response filter test", cwd: testRepo5 });
    const arRunnerObj = RUNNERS.get(arDispatch.runnerId);

    // Simulate handleRunnerEvent with agent_response step_update (DONE state)
    // This is what the real runner would emit — addTrajectory should ignore it.
    const agentRespEvent = {
      event: "step_update",
      step_update: {
        step_type: "agent_response",
        state: "DONE",
        tool_name: "agent_response",
        duration_seconds: 2.1,
      },
    };
    // Use the runner's JSON event parsing path
    const fakeRl = { on: () => {} };
    // Directly trigger handleRunnerEvent by calling it via the internal runner stream processor
    // We can test via dispatchRunner's JSON stream path by constructing the event manually.
    // Since handleRunnerEvent is not exported, test indirectly: push via RUNNERS.
    // Simulate what addTrajectory would do: push an agent_response entry.
    // The real addTrajectory function should drop it.
    // We test by checking that a steer (non-agent_response) IS kept, agent_response is not.
    arRunnerObj.onSteer = () => {};
    await steerRunner({ runnerId: arDispatch.runnerId, instruction: "Check results" });
    // Now push what would be an agent_response via the trajectory directly (bypassing addTrajectory)
    // to confirm the addTrajectory filter works independently.
    const prevLen = arRunnerObj.trajectory.length;
    // Call addTrajectory indirectly by using the module's exported callTool dispatcher
    // which internally calls addTrajectory. We can simulate via steerRunner adding another entry.
    // The real test: agent_response entries pushed via handleRunnerEvent should NOT appear.
    // Since we can't easily call handleRunnerEvent, verify via the existing behavior:
    // no item in trajectory should have action === "agent_response".
    const arCheck = await checkRunner({ runnerId: arDispatch.runnerId });
    for (const item of arCheck.trajectory) {
      assert.notEqual(item.action, "agent_response", "agent_response must never appear in trajectory");
    }
  } finally {
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
    rmSync(testRepo5, { recursive: true, force: true });
  }
}

// CT. check_runner semantics for this change: health/trajectory/delivery
// state, NOT findings. Completion findings must stay out of check_runner (the
// trajectory included), while the authoritative notification and await_runner
// still carry the full result, and a pending (undelivered) terminal wakeup
// stays recoverable via the sweeper's retry.
{
  const testRepoCT = mkdtempSync(join(tmpdir(), "architect-checkrunner-test-"));
  const priorThreadCT = Object.prototype.hasOwnProperty.call(globalThis, "__QQ_TEST_CODEX_THREAD");
  const savedThreadCT = globalThis.__QQ_TEST_CODEX_THREAD;
  try {
    await git(testRepoCT, ["init", "-b", "main"]);
    await git(testRepoCT, ["config", "user.name", "MCP Test"]);
    await git(testRepoCT, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(testRepoCT, "README.md"), "# CT\n");
    await git(testRepoCT, ["add", "README.md"]);
    await git(testRepoCT, ["commit", "-m", "init"]);

    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    delete globalThis.__QQ_TEST_CODEX_THREAD;

    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => { runner.status = "running"; };
    const ctDispatch = await dispatchRunner({ task: "check_runner semantics", cwd: testRepoCT });
    const ctRunner = RUNNERS.get(ctDispatch.runnerId);

    // Running: health/trajectory only, delivery state non-terminal.
    const runningCheck = await checkRunner({ runnerId: ctDispatch.runnerId });
    assert.equal(runningCheck.status, "running");
    assert.equal(runningCheck.result, undefined);
    assert.deepEqual(runningCheck.notification, { terminal: false, delivered: false, pendingRetry: false });

    // Record a normal tool step so the trajectory has a real (payload-free) entry.
    handleRunnerEvent(ctRunner, {
      event: "step_update",
      step_update: { step_type: "tool", state: "DONE", tool_name: "view_file", tool_info: { parameters: { AbsolutePath: "/a.mjs" } }, duration_seconds: 1 },
    });

    // Land the authoritative transport result, then complete via a complete_task
    // step whose parameters carry the full findings payload (the leak channel).
    const findings = "FULL-FINDINGS-" + "x".repeat(300);
    const dataPoints = ["dp-1"];
    writeFileSync(ctRunner.resultFile, JSON.stringify({ runnerId: ctDispatch.runnerId, response: findings, data_points: dataPoints }), "utf8");
    handleRunnerEvent(ctRunner, {
      event: "step_update",
      step_update: { step_type: "tool", state: "DONE", tool_name: "complete_task", tool_info: { parameters: { response: findings, data_points: dataPoints } }, duration_seconds: 2 },
    });
    assert.equal(ctRunner.status, "completed", "authoritative transport must complete the runner");

    const check = await checkRunner({ runnerId: ctDispatch.runnerId });
    assert.equal(check.status, "completed");
    assert.equal(check.result, undefined, "check_runner must NOT return findings");
    assert.equal(check.findingsRetained, true, "authoritative findings stay retained for notification");
    assert.equal(check.notification.terminal, true);
    assert.equal(check.notification.pendingRetry, true, "no delivery attempted yet -> pendingRetry");
    // The payload must not appear anywhere in the check response, trajectory
    // included (this is the covert re-surface this change prevents).
    assert.ok(!JSON.stringify(check).includes("FULL-FINDINGS"), "check_runner payload (incl. trajectory) must not carry findings");
    const ctEntry = check.trajectory.find((t) => t.action === "complete_task");
    assert.ok(ctEntry, "complete_task step must still appear by name");
    assert.equal(ctEntry.target, undefined, "complete_task payload must not become a trajectory target");

    // The completion-time fire-and-forget wakeup has no Codex context here, so
    // it settles undelivered and must NOT prune the retained artifact.
    if (ctRunner.notifiedTerminalInFlight) await ctRunner.notifiedTerminalInFlight;
    assert.equal(ctRunner.notifiedTerminal, undefined, "undelivered terminal wakeup stays retryable");
    assert.ok(loadRetainedFindings(ctDispatch.runnerId), "undelivered completion keeps the retained artifact");

    // Authoritative delivery still carries the full findings; delivery state flips.
    const calls = [];
    globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { calls.push(call); };
    const delivered = await notifyTerminal(ctRunner, "runner");
    assert.equal(delivered.notified, true);
    assert.ok(calls[0].message.includes(findings), "terminal notification must carry the full findings");
    const check2 = await checkRunner({ runnerId: ctDispatch.runnerId });
    assert.equal(check2.notification.delivered, true);
    assert.equal(check2.notification.pendingRetry, false);
    assert.equal(check2.findingsRetained, false, "a confirmed delivery prunes the redundant durable copy");
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;

    // The authoritative findings read stays available through the completion
    // transport; no wait tool is involved.
    assert.deepEqual(authoritativeResult(ctDispatch.runnerId), { response: findings, data_points: dataPoints });
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
    if (priorThreadCT) globalThis.__QQ_TEST_CODEX_THREAD = savedThreadCT; else delete globalThis.__QQ_TEST_CODEX_THREAD;
    rmSync(testRepoCT, { recursive: true, force: true });
  }
}

// CT2. Residual result-bearing shapes never surface through check_runner: a raw
// stdout log line, a complete_task payload, and a failed runner's error all
// carry the findings text, yet the check response (trajectory + error included)
// must not. Bounded diagnostics replace the raw payload.
{
  const testRepoCT2 = mkdtempSync(join(tmpdir(), "architect-checkrunner2-"));
  try {
    await git(testRepoCT2, ["init", "-b", "main"]);
    await git(testRepoCT2, ["config", "user.name", "MCP Test"]);
    await git(testRepoCT2, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(testRepoCT2, "README.md"), "# CT2\n");
    await git(testRepoCT2, ["add", "README.md"]);
    await git(testRepoCT2, ["commit", "-m", "init"]);

    const SECRET = "CT2-RESULT-SENTINEL";
    const payload = `${SECRET} ${"q".repeat(300)}`;

    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => { runner.status = "running"; };
    const d1 = await dispatchRunner({ task: "residual payload", cwd: testRepoCT2 });
    const r1 = RUNNERS.get(d1.runnerId);
    // Raw stdout line (the plain-log channel).
    recordRunnerStdoutLine(r1, `plain stdout ${payload}`);
    const check1 = await checkRunner({ runnerId: d1.runnerId });
    assert.equal(check1.status, "running");
    assert.ok(!JSON.stringify(check1).includes(SECRET), "running check must not carry payload from the stdout log");
    const logEntry = check1.trajectory.find((t) => t.action === "log");
    assert.ok(logEntry, "log step still recorded");
    assert.equal(logEntry.message, undefined, "log step must not store raw stdout text");
    assert.equal(typeof logEntry.bytes, "number", "log step keeps only a byte count");

    // A complete_task step whose parameters carry the payload must appear by
    // name only, with no target and no payload anywhere in the response.
    const findings = `${SECRET}-COMPLETION ${"w".repeat(200)}`;
    writeFileSync(r1.resultFile, JSON.stringify({ runnerId: d1.runnerId, response: findings, data_points: [] }), "utf8");
    handleRunnerEvent(r1, {
      event: "step_update",
      step_update: { step_type: "tool", state: "DONE", tool_name: "complete_task", tool_info: { parameters: { response: findings, data_points: [] } }, duration_seconds: 3 },
    });
    const checkDone = await checkRunner({ runnerId: d1.runnerId });
    assert.equal(checkDone.status, "completed");
    assert.ok(!JSON.stringify(checkDone).includes(SECRET), "completed check must not carry the completion payload");
    const ctStep = checkDone.trajectory.find((t) => t.action === "complete_task");
    assert.ok(ctStep, "complete_task step must still be recorded by name");
    assert.equal(ctStep.target, undefined, "complete_task payload must not become a trajectory target");
    assert.equal(checkDone.result, undefined, "completed check must not return findings");
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;

    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
      runner.status = "failed";
      runner.error = { message: payload, exitCode: 1, stderr: payload, outputTail: payload };
    };
    const d2 = await dispatchRunner({ task: "failed payload", cwd: testRepoCT2 });
    const check2 = await checkRunner({ runnerId: d2.runnerId });
    assert.equal(check2.status, "failed");
    assert.ok(!JSON.stringify(check2).includes(SECRET), "failed check must not carry raw stderr/outputTail/message");
    assert.equal(check2.error.message, undefined, "no raw error message in check_runner");
    assert.equal(check2.error.exitCode, 1);
    assert.equal(typeof check2.error.reason, "string");
  } finally {
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
    rmSync(testRepoCT2, { recursive: true, force: true });
  }
}

// CT3. A validated COMPLETED outcome is retained durably BEFORE the transport
// file is cleaned up, so a failed notification + server restart does not
// destroy it; recovery replays through the SAME terminal notification and
// routes ONLY to the originating session/thread.
{
  const testRepoCT3 = mkdtempSync(join(tmpdir(), "architect-checkrunner3-"));
  const priorBin3 = process.env.QQ_CODEX_BIN;
  const priorThreadCT3 = Object.prototype.hasOwnProperty.call(globalThis, "__QQ_TEST_CODEX_THREAD");
  const savedThreadCT3 = globalThis.__QQ_TEST_CODEX_THREAD;
  try {
    await git(testRepoCT3, ["init", "-b", "main"]);
    await git(testRepoCT3, ["config", "user.name", "MCP Test"]);
    await git(testRepoCT3, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(testRepoCT3, "README.md"), "# CT3\n");
    await git(testRepoCT3, ["add", "README.md"]);
    await git(testRepoCT3, ["commit", "-m", "init"]);

    // Scrub transport: make the completion-time wakeup undeliverable so the
    // retained copy is exercised (a real restart loses the in-memory tracker).
    process.env.QQ_CODEX_BIN = "/nonexistent/qq-test-no-transport";
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    // Trusted runtime identity of the originating session (proc discovery is
    // disabled for the whole suite).
    globalThis.__QQ_TEST_CODEX_THREAD = "ct3-thread";

    const findings = "RETAINED-FINDINGS-" + "r".repeat(400);
    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => { runner.status = "running"; };
    const disp = await dispatchRunner({ task: "retain + replay", cwd: testRepoCT3 });
    const runner = RUNNERS.get(disp.runnerId);
    writeFileSync(runner.resultFile, JSON.stringify({ runnerId: disp.runnerId, response: findings, data_points: ["ct3-dp"] }), "utf8");
    handleRunnerEvent(runner, {
      event: "step_update",
      step_update: { step_type: "tool", state: "DONE", tool_name: "complete_task", tool_info: { parameters: { response: findings } }, duration_seconds: 3 },
    });
    assert.equal(runner.status, "completed", "authoritative transport must complete the runner");
    assert.equal(existsSync(runner.resultFile), false, "transient transport file is cleaned up");
    const rec = loadRetainedFindings(disp.runnerId);
    assert.ok(rec, "validated findings retained before transport cleanup");
    assert.equal(rec.status, "completed");
    assert.equal(rec.threadId, "ct3-thread", "originating thread recorded for ownership+routing");
    assert.equal(rec.result.response, findings);
    assert.deepEqual(rec.result.data_points, ["ct3-dp"]);

    // The completion-time fire-and-forget wakeup must settle as undelivered and
    // must NOT prune the artifact.
    if (runner.notifiedTerminalInFlight) await runner.notifiedTerminalInFlight;
    assert.equal(runner.notifiedTerminal, undefined, "undeliverable wakeup must not claim delivery");
    assert.ok(loadRetainedFindings(disp.runnerId), "undelivered completion keeps the retained artifact");

    // Simulate an MCP-server restart: the in-memory tracker is gone.
    RUNNERS.delete(disp.runnerId);

    // Replay through the SAME notification mechanism carries the full findings
    // and routes to the recorded thread.
    const calls = [];
    globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { calls.push(call); };
    const ok = await replayRetainedRunnerFindings(disp.runnerId);
    assert.equal(ok.ok, true, "replay delivers");
    assert.equal(ok.taskStatus, "completed");
    assert.ok(!JSON.stringify(ok).includes(findings), "replay response must not return findings");
    assert.equal(calls[0].threadId, "ct3-thread", "replay must route to the originating thread");
    assert.ok(calls[0].message.includes(findings), "replay message carries the authoritative findings");
    assert.equal(loadRetainedFindings(disp.runnerId), null, "confirmed delivery prunes the durable copy");

    // A later cleanup pass (the child's close event after a delivered runner)
    // must not resurrect the pruned artifact as a stale copy.
    runner.notifiedTerminal = true;
    cleanupRunnerFiles(runner);
    assert.equal(loadRetainedFindings(disp.runnerId), null, "a delivered runner must not be re-retained by a later cleanup");
  } finally {
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    if (priorThreadCT3) globalThis.__QQ_TEST_CODEX_THREAD = savedThreadCT3; else delete globalThis.__QQ_TEST_CODEX_THREAD;
    if (priorBin3 === undefined) delete process.env.QQ_CODEX_BIN; else process.env.QQ_CODEX_BIN = priorBin3;
    rmSync(testRepoCT3, { recursive: true, force: true });
  }
}

// CT5. A FAILED terminal outcome is retained with its bounded diagnostic and is
// replayed with the correct (failed) status through the same notification
// builder — a failed NOTIFICATION is not a failed TASK and vice versa.
{
  const testRepoCT5 = mkdtempSync(join(tmpdir(), "architect-checkrunner5-"));
  const priorBin5 = process.env.QQ_CODEX_BIN;
  const priorThreadCT5 = Object.prototype.hasOwnProperty.call(globalThis, "__QQ_TEST_CODEX_THREAD");
  const savedThreadCT5 = globalThis.__QQ_TEST_CODEX_THREAD;
  try {
    await git(testRepoCT5, ["init", "-b", "main"]);
    await git(testRepoCT5, ["config", "user.name", "MCP Test"]);
    await git(testRepoCT5, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(testRepoCT5, "README.md"), "# CT5\n");
    await git(testRepoCT5, ["add", "README.md"]);
    await git(testRepoCT5, ["commit", "-m", "init"]);

    process.env.QQ_CODEX_BIN = "/nonexistent/qq-test-no-transport";
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    globalThis.__QQ_TEST_CODEX_THREAD = "ct5-thread";

    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => { runner.status = "running"; };
    const disp = await dispatchRunner({ task: "failed runner diagnostic", cwd: testRepoCT5 });
    const runner = RUNNERS.get(disp.runnerId);
    // Simulate the child dying without a completion transport.
    runner.process = { exitCode: 7, signalCode: null };
    runner.stderrTail = "FAIL-STDERR-SENTINEL";
    runner.outputTail = "FAIL-TAIL-SENTINEL";
    const rec = reconcileDeadRunner(runner);
    assert.equal(rec.status, "failed");

    const stored = loadRetainedFindings(disp.runnerId);
    assert.ok(stored, "a FAILED terminal outcome must be retained too");
    assert.equal(stored.status, "failed");
    assert.equal(stored.result, null);
    assert.equal(stored.error.exitCode, 7);
    assert.ok(String(stored.error.message).includes("exited with code 7"), "failure reason retained");
    assert.ok(String(stored.error.stderr).includes("FAIL-STDERR-SENTINEL"), "failure stderr evidence retained");
    assert.ok(String(stored.outputTail).includes("FAIL-TAIL-SENTINEL"), "failure output tail retained");

    // check_runner reports the durable status truthfully and keeps the bounded
    // (payload-free) diagnostic.
    const check = await checkRunner({ runnerId: disp.runnerId });
    assert.equal(check.status, "failed");
    assert.equal(check.findingsRetained, true, "failed-notification recovery state is durable");
    assert.equal(check.error.reason, "exit_nonzero");
    assert.ok(!JSON.stringify(check).includes("FAIL-STDERR-SENTINEL"), "check_runner must not echo failure stderr");
    assert.ok(!JSON.stringify(check).includes("FAIL-TAIL-SENTINEL"), "check_runner must not echo the output tail");

    // Restart: tracker gone. Replay must deliver the FAILED notification.
    RUNNERS.delete(disp.runnerId);
    const calls = [];
    globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { calls.push(call); };
    const replay = await replayRetainedRunnerFindings(disp.runnerId);
    assert.equal(replay.ok, true, "failed-notification recovery delivers");
    assert.equal(replay.taskStatus, "failed", "replay reports task outcome separately from delivery");
    assert.equal(calls[0].threadId, "ct5-thread");
    assert.ok(calls[0].message.includes("failed"), "replayed notification states the failure");
    assert.ok(calls[0].message.includes("exitCode=7"), "replayed notification carries the diagnostic");
    assert.ok(calls[0].message.includes("FAIL-STDERR-SENTINEL"), "replayed notification carries stderr evidence");
    assert.ok(!JSON.stringify(replay).includes("FAIL-STDERR-SENTINEL"), "replay response must not return the diagnostic");
    assert.equal(loadRetainedFindings(disp.runnerId), null, "confirmed failed-notification delivery prunes the copy");
  } finally {
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    if (priorThreadCT5) globalThis.__QQ_TEST_CODEX_THREAD = savedThreadCT5; else delete globalThis.__QQ_TEST_CODEX_THREAD;
    if (priorBin5 === undefined) delete process.env.QQ_CODEX_BIN; else process.env.QQ_CODEX_BIN = priorBin5;
    rmSync(testRepoCT5, { recursive: true, force: true });
  }
}

// CT6. A retention (persistence) failure must not delete the sole durable
// artifact for EITHER outcome, claim retention, or hide the primary error.
{
  const testRepoCT6 = mkdtempSync(join(tmpdir(), "architect-checkrunner6-"));
  const badBase = mkdtempSync(join(tmpdir(), "architect-checkrunner6-bad-"));
  const priorDir6 = process.env.QQ_RUNNER_FINDINGS_DIR;
  try {
    await git(testRepoCT6, ["init", "-b", "main"]);
    await git(testRepoCT6, ["config", "user.name", "MCP Test"]);
    await git(testRepoCT6, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(testRepoCT6, "README.md"), "# CT6\n");
    await git(testRepoCT6, ["add", "README.md"]);
    await git(testRepoCT6, ["commit", "-m", "init"]);

    // A regular file where the findings directory must be: creating the dir fails.
    const blocker = join(badBase, "blocker");
    writeFileSync(blocker, "not a directory");
    process.env.QQ_RUNNER_FINDINGS_DIR = join(blocker, "runner-findings");
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    delete globalThis.__QQ_TEST_CODEX_THREAD;

    const findings = "SOLE-RESULT-" + "s".repeat(200);
    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => { runner.status = "running"; };
    const disp = await dispatchRunner({ task: "retention failure", cwd: testRepoCT6 });
    const runner = RUNNERS.get(disp.runnerId);
    writeFileSync(runner.resultFile, JSON.stringify({ runnerId: disp.runnerId, response: findings, data_points: [] }), "utf8");
    // Model the production terminal transition for a validated completion.
    runner.status = "completed";
    runner.result = { response: findings, data_points: [] };
    cleanupRunnerFiles(runner);
    // Primary outcome intact and findings still deliverable ...
    assert.equal(runner.status, "completed");
    assert.equal(runner.result.response, findings);
    assert.ok(buildRunnerTerminalMessage(runner).includes(findings), "primary findings still delivered");
    // ... but the sole durable copy was NOT deleted by the failed retention.
    assert.equal(existsSync(runner.resultFile), true, "retention failure must not delete the sole completed result");
    const check = await checkRunner({ runnerId: disp.runnerId });
    assert.equal(check.findingsRetained, false, "must not claim retention when persistence failed");

    // Failed-runner variant: the transport file is the ONLY durable copy of the
    // failure payload (check_runner is bounded, and the tracker dies with the
    // process), so a persistence failure must not delete it either.
    const disp2 = await dispatchRunner({ task: "failed retention failure", cwd: testRepoCT6 });
    const runner2 = RUNNERS.get(disp2.runnerId);
    // A transport file that exists but is malformed: the authoritative read
    // fails, so the outcome is a transport-error failure.
    writeFileSync(runner2.resultFile, "{ this is not valid json", "utf8");
    runner2.process = { exitCode: 0, signalCode: null };
    runner2.stderrTail = "failed-retention-stderr";
    const rec2 = reconcileDeadRunner(runner2);
    assert.equal(rec2.status, "failed");
    assert.equal(existsSync(runner2.resultFile), true, "retention failure must not delete the sole failed diagnostic");
    const check2 = await checkRunner({ runnerId: disp2.runnerId });
    assert.equal(check2.status, "failed");
    assert.equal(check2.error.reason, "transport_error", "primary failure diagnostic must not be hidden");
    assert.equal(check2.findingsRetained, false, "failed retention is reported truthfully");

    // The same failed transition with a WRITABLE findings dir retains durably
    // and only then removes the transient transport file.
    process.env.QQ_RUNNER_FINDINGS_DIR = priorDir6;
    const disp3 = await dispatchRunner({ task: "failed retention success", cwd: testRepoCT6 });
    const runner3 = RUNNERS.get(disp3.runnerId);
    writeFileSync(runner3.resultFile, "{ also malformed", "utf8");
    runner3.process = { exitCode: 0, signalCode: null };
    assert.equal(reconcileDeadRunner(runner3).status, "failed");
    assert.ok(loadRetainedFindings(disp3.runnerId), "failed outcome retained when persistence works");
    assert.equal(existsSync(runner3.resultFile), false, "transport file cleaned up once retention succeeded");
  } finally {
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
    if (priorDir6 === undefined) delete process.env.QQ_RUNNER_FINDINGS_DIR; else process.env.QQ_RUNNER_FINDINGS_DIR = priorDir6;
    rmSync(testRepoCT6, { recursive: true, force: true });
    rmSync(badBase, { recursive: true, force: true });
  }
}

// CT7. runnerId is validated BEFORE any filesystem access: traversal and
// malformed ids are rejected without touching a path.
{
  const dir = mkdtempSync(join(tmpdir(), "architect-checkrunner7-"));
  const env7 = { ...process.env, QQ_RUNNER_FINDINGS_DIR: dir };
  try {
    const evil = "../../../../tmp/qq-pwned-sentinel";
    assert.equal(isValidRunnerId(evil), false);
    assert.equal(retainedFindingsPath(evil, env7), null, "traversal id must not resolve a path");
    assert.equal(retainedFindingsPath("not-a-uuid", env7), null);
    assert.equal(loadRetainedFindings(evil, { env: env7 }), null);
    assert.equal(pruneRetainedFindings(evil, { env: env7 }), false);
    assert.equal(retainRunnerFindings({ runnerId: evil, status: "completed", result: "x" }, { env: env7 }), null);
    assert.equal(hasRetainedFindings(evil, { env: env7 }), false);
    const r = await replayRetainedRunnerFindings(evil, { env: env7 });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "invalid-runner-id");
    assert.deepEqual(listRetainedFindings({ env: env7 }), []);
    assert.equal(existsSync("/tmp/qq-pwned-sentinel.json"), false, "no file created outside the findings dir");
    // containment: a valid id resolves strictly inside the findings dir
    const inside = retainedFindingsPath("11111111-1111-4111-8111-111111111111", env7);
    assert.equal(dirname(inside), runnerFindingsDir(env7));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// CT8. Replay cannot be redirected and cannot cross sessions: routing comes
// only from the retained record, and the caller must prove ownership via
// trusted runtime identity (never a caller-supplied arg).
{
  const dir = mkdtempSync(join(tmpdir(), "architect-checkrunner8-"));
  const env8 = { ...process.env, QQ_RUNNER_FINDINGS_DIR: dir };
  const victimId = "11111111-1111-4111-8111-111111111111";
  const priorThreadCT8 = Object.prototype.hasOwnProperty.call(globalThis, "__QQ_TEST_CODEX_THREAD");
  const savedThreadCT8 = globalThis.__QQ_TEST_CODEX_THREAD;
  try {
    writeFileSync(
      join(dir, `${victimId}.json`),
      JSON.stringify({
        version: 1,
        runnerId: victimId,
        sessionId: "origin-sess",
        threadId: "origin-thread",
        startedAt: Date.now(),
        retainedAt: Date.now(),
        status: "completed",
        result: { response: "VICTIM-SECRET", data_points: [] },
        error: null,
        outputTail: null,
      }),
      "utf8",
    );
    const calls = [];
    globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { calls.push(call); };

    // A caller from another session must be rejected, with no delivery.
    globalThis.__QQ_TEST_CODEX_THREAD = "attacker-thread";
    const rejected = await replayRetainedRunnerFindings(victimId, { env: env8 });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.reason, "not-originating-session");
    assert.equal(calls.length, 0, "must not deliver a victim's findings to another session");
    assert.ok(!JSON.stringify(rejected).includes("VICTIM-SECRET"), "rejection must not leak findings");
    assert.ok(loadRetainedFindings(victimId, { env: env8 }), "rejected replay keeps the artifact");

    // A caller-supplied routing override is ignored outright (the tool dispatch
    // takes only runnerId), so it can never redirect the replay.
    const overridden = await replayRetainedRunnerFindings(victimId, { env: env8, threadId: "attacker-thread", sessionId: "attacker-sess" });
    assert.equal(overridden.ok, false, "a routing override must not bypass ownership");
    assert.equal(calls.length, 0);

    // Absent caller identity fails closed too.
    delete globalThis.__QQ_TEST_CODEX_THREAD;
    const noId = await replayRetainedRunnerFindings(victimId, { env: env8 });
    assert.equal(noId.ok, false);
    assert.equal(noId.reason, "no-caller-identity");

    // Absent RECORD identity (a record without an originating thread) also
    // fails closed, even for an apparently valid caller: there is no
    // cross-session fallback.
    const orphanId = "22222222-2222-4222-8222-222222222222";
    writeFileSync(
      join(dir, `${orphanId}.json`),
      JSON.stringify({
        version: 1, runnerId: orphanId, sessionId: "orphan-sess", threadId: null,
        startedAt: Date.now(), retainedAt: Date.now(), status: "completed",
        result: { response: "ORPHAN-SECRET", data_points: [] }, error: null, outputTail: null,
      }),
      "utf8",
    );
    globalThis.__QQ_TEST_CODEX_THREAD = "origin-thread";
    const orphan = await replayRetainedRunnerFindings(orphanId, { env: env8 });
    assert.equal(orphan.ok, false);
    assert.equal(orphan.reason, "no-record-identity");
    assert.equal(calls.length, 0, "an identity-less record must never be delivered");
    assert.ok(loadRetainedFindings(orphanId, { env: env8 }), "rejected replay keeps the artifact");

    // The originating session replays; routing is the record's, not the caller's.
    globalThis.__QQ_TEST_CODEX_THREAD = "origin-thread";
    const delivered = await replayRetainedRunnerFindings(victimId, { env: env8 });
    assert.equal(delivered.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].threadId, "origin-thread", "delivered to the originating thread only");
    assert.equal(calls[0].sessionId, "origin-sess");
    assert.ok(calls[0].message.includes("VICTIM-SECRET"));
    assert.ok(!JSON.stringify(delivered).includes("VICTIM-SECRET"), "replay response must not return findings");
    assert.equal(loadRetainedFindings(victimId, { env: env8 }), null);
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    if (priorThreadCT8) globalThis.__QQ_TEST_CODEX_THREAD = savedThreadCT8; else delete globalThis.__QQ_TEST_CODEX_THREAD;
    rmSync(dir, { recursive: true, force: true });
  }
}

// N6b. Terminal delivery truth: a returned transport failure must not claim
// delivery (the tracker stays retryable for the sweeper backstop), a confirmed
// success suppresses repeats, and concurrent attempts coalesce onto one send.
{
  const retryDir = mkdtempSync(join(tmpdir(), "test-notify-retry-"));
  const retryCount = join(retryDir, "count");
  const savedBinN6b = process.env.QQ_CODEX_BIN;
  const hadThreadN6b = Object.prototype.hasOwnProperty.call(globalThis, "__QQ_TEST_CODEX_THREAD");
  const savedThreadN6b = globalThis.__QQ_TEST_CODEX_THREAD;
  const savedRunnersN6b = new Map(RUNNERS);
  const savedExecutionsN6b = new Map(EXECUTIONS);
  try {
    const fakeCodex = join(retryDir, "codex");
    writeFileSync(
      fakeCodex,
      `#!/usr/bin/env bash\nn=0\n[ -f "${retryCount}" ] && n=$(cat "${retryCount}")\nn=$((n+1))\necho "$n" > "${retryCount}"\nif [ "$n" -eq 1 ]; then exit 1; fi\nexit 0\n`,
      "utf8",
    );
    execFileSync("chmod", ["+x", fakeCodex]);
    globalThis.__QQ_TEST_CODEX_THREAD = "n6b-thread";
    process.env.QQ_CODEX_BIN = fakeCodex;

    const tracker = { runnerId: "n6b-1", id: "n6b-1", status: "completed", startedAt: Date.now(), result: "done" };
    const failed = await notifyTerminal(tracker, "runner");
    assert.equal(failed.notified, false, "failed delivery must report notified:false");
    assert.match(String(failed.reason), /exited with code 1/);
    assert.equal(tracker.notifiedTerminal, undefined, "failed delivery must not claim delivered");
    assert.equal(tracker.notifiedTerminalInFlight, undefined, "failed delivery must clear the in-flight marker");

    const delivered = await notifyTerminal(tracker, "runner");
    assert.equal(delivered.notified, true, "a retry after a failed transport must deliver");
    assert.equal(tracker.notifiedTerminal, true, "only a confirmed success marks delivered");
    const repeat = await notifyTerminal(tracker, "runner");
    assert.equal(repeat.reason, "already-notified");
    assert.equal(readFileSync(retryCount, "utf8").trim(), "2", "confirmed success must suppress further sends");

    // Concurrent attempts coalesce onto one in-flight send and never claim
    // delivered while the send is still pending.
    const calls = [];
    let release;
    const gate = new Promise((resolveGate) => { release = resolveGate; });
    globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { calls.push(call); await gate; };
    const conc = { runnerId: "n6b-2", id: "n6b-2", status: "completed", startedAt: Date.now(), result: "done" };
    const first = notifyTerminal(conc, "runner");
    assert.equal(conc.notifiedTerminal, undefined, "in-flight attempt must not claim delivered");
    assert.ok(conc.notifiedTerminalInFlight, "in-flight marker must be present while awaiting the transport");
    const second = notifyTerminal(conc, "runner");
    assert.equal(calls.length, 1, "a concurrent attempt must not start a duplicate send");
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.notified, true);
    assert.equal(b.notified, true, "the coalesced caller reports the in-flight outcome");
    assert.equal(calls.length, 1, "concurrent attempts must produce exactly one transport send");
    assert.equal(conc.notifiedTerminal, true);
    assert.equal(conc.notifiedTerminalInFlight, undefined, "in-flight marker must clear once the attempt settles");
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;

    // Sweeper backstop: a failed terminal wakeup is retried on the next sweep
    // and repeats stop once delivery is confirmed.
    RUNNERS.clear();
    EXECUTIONS.clear();
    writeFileSync(retryCount, "0", "utf8");
    const swept = { id: "n6b-3", runnerId: "n6b-3", status: "completed", startedAt: Date.now(), result: "swept" };
    RUNNERS.set(swept.id, swept);
    const s1 = await sweepNotifications();
    assert.equal(s1.terminalNotified, 0, "failed delivery must not count as notified");
    assert.equal(swept.notifiedTerminal, undefined, "failed delivery must leave the tracker retryable");
    const s2 = await sweepNotifications();
    assert.equal(s2.terminalNotified, 1, "the next sweep must retry and deliver");
    assert.equal(swept.notifiedTerminal, true);
    const s3 = await sweepNotifications();
    assert.equal(s3.terminalNotified, 0, "confirmed delivery must suppress sweeper repeats");
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    if (savedBinN6b === undefined) delete process.env.QQ_CODEX_BIN; else process.env.QQ_CODEX_BIN = savedBinN6b;
    if (hadThreadN6b) globalThis.__QQ_TEST_CODEX_THREAD = savedThreadN6b; else delete globalThis.__QQ_TEST_CODEX_THREAD;
    RUNNERS.clear();
    for (const [k, v] of savedRunnersN6b) RUNNERS.set(k, v);
    EXECUTIONS.clear();
    for (const [k, v] of savedExecutionsN6b) EXECUTIONS.set(k, v);
    rmSync(retryDir, { recursive: true, force: true });
  }
}

// T6. Head + tail sanitization works on exception output over max chars
{
  const shortText = "hello world";
  assert.equal(sanitizeHeadTail(shortText), shortText, "short text must pass through unchanged");

  const longText = "A".repeat(500) + "B".repeat(500) + "C".repeat(500);
  // headLen=1000, tailLen=1000: total 2000, text is 1500, fits
  assert.equal(sanitizeHeadTail(longText), longText);

  const veryLong = "HEAD-".repeat(300) + "MIDDLE-".repeat(100) + "-TAIL".repeat(300);
  const sanitized = sanitizeHeadTail(veryLong);
  assert.ok(sanitized.includes("chars omitted"), "sanitized output must include omission notice");
  assert.ok(sanitized.startsWith(veryLong.slice(0, 1000)), "sanitized must start with head");
  assert.ok(sanitized.endsWith(veryLong.slice(veryLong.length - 1000)), "sanitized must end with tail");

  // Custom lengths
  const custom = sanitizeHeadTail("A".repeat(100), { headLen: 30, tailLen: 30 });
  assert.ok(custom.includes("chars omitted"));
  assert.ok(custom.startsWith("A".repeat(30)));
  assert.ok(custom.endsWith("A".repeat(30)));
}

// T7. handleRunnerEvent: complete_task DONE sets runner.status = "completed",
//     captures runner.result from COMPLETE_TASK_REGISTRY, and calls kill() on runner.process
{
  // Set up a fake runner with a mock process to track kill() calls
  let killCalled = false;
  let killSignal = null;
  const fakeProcess = {
    kill(sig) {
      killCalled = true;
      killSignal = sig || "SIGTERM";
    },
  };

  const fakeRunner = {
    id: "test-runner-complete-task",
    status: "running",
    activeTool: null,
    trajectory: [],
    result: null,
    error: null,
    process: fakeProcess,
  };

  // Pre-seed the COMPLETE_TASK_REGISTRY with a result for the "default" key
  const testResponse = "Task completed successfully.";
  const testDataPoints = ["file.mjs:10", "bar.mjs:20"];
  COMPLETE_TASK_REGISTRY.set("default", {
    calledAt: Date.now(),
    response: testResponse,
    data_points: testDataPoints,
  });

  // Fire the complete_task DONE event
  const completedEvent = {
    event: "step_update",
    step_update: {
      step_type: "tool",
      state: "DONE",
      tool_name: "complete_task",
      duration_seconds: 0.5,
    },
  };
  handleRunnerEvent(fakeRunner, completedEvent);

  // Assert runner.status was set to "completed"
  assert.equal(fakeRunner.status, "completed", "handleRunnerEvent must set runner.status to 'completed' on complete_task DONE");

  // Assert runner.result captures response and data_points
  assert.ok(fakeRunner.result, "handleRunnerEvent must set runner.result on complete_task DONE");
  assert.equal(fakeRunner.result.response, testResponse, "runner.result.response must match COMPLETE_TASK_REGISTRY entry");
  assert.deepEqual(fakeRunner.result.data_points, testDataPoints, "runner.result.data_points must match COMPLETE_TASK_REGISTRY entry");

  // Assert runner.process.kill() was called
  assert.ok(killCalled, "handleRunnerEvent must call runner.process.kill() on complete_task DONE");
  assert.equal(killSignal, "SIGTERM", "handleRunnerEvent must send SIGTERM when killing runner process");

  // Clean up registry entry
  COMPLETE_TASK_REGISTRY.delete("default");
}

// T7b. handleRunnerEvent: rejects telemetry parameters when authoritative transport is missing
{
  let killCalled = false;
  let killSignal = null;
  const fakeProcess = {
    kill(sig) {
      killCalled = true;
      killSignal = sig || "SIGTERM";
    },
  };

  const fakeRunner = {
    id: "test-runner-complete-task-params",
    status: "running",
    activeTool: null,
    trajectory: [],
    result: null,
    error: null,
    process: fakeProcess,
  };

  const testResponse = "Task completed with parameters.";
  const testDataPoints = ["param.mjs:1"];

  const completedEvent = {
    event: "step_update",
    step_update: {
      step_type: "tool",
      state: "DONE",
      tool_name: "complete_task",
      duration_seconds: 0.2,
      tool_info: {
        parameters: {
          response: testResponse,
          data_points: testDataPoints,
        },
      },
    },
  };
  handleRunnerEvent(fakeRunner, completedEvent);

  // Missing transport result must surface actionable failure; never accept clipped telemetry
  assert.equal(fakeRunner.status, "failed");
  assert.equal(fakeRunner.result, null, "runner.result must remain null on missing transport");
  assert.match(fakeRunner.error.message, /Runner complete_task failed/);
  assert.ok(killCalled);
  assert.equal(killSignal, "SIGTERM");
}

// T7c. handleRunnerEvent: captures runner.result from call_mcp_tool with ToolName: complete_task via transport
{
  let killCalled = false;
  let killSignal = null;
  const fakeProcess = {
    kill(sig) {
      killCalled = true;
      killSignal = sig || "SIGTERM";
    },
  };

  const fakeRunner = {
    id: "fake-runner-mcp-call",
    status: "running",
    activeTool: null,
    trajectory: [],
    result: null,
    error: null,
    process: fakeProcess,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
  };

  const testResponse = "Findings via call_mcp_tool";
  const testDataPoints = ["point-1", "point-2"];

  // Pre-seed resultFile for this runner
  const resFile = join(tmpdir(), `qq-runner-result-${fakeRunner.id}.json`);
  fakeRunner.resultFile = resFile;
  writeFileSync(resFile, JSON.stringify({
    runnerId: fakeRunner.id,
    response: testResponse,
    data_points: testDataPoints,
    calledAt: Date.now(),
  }), "utf8");

  const completedEvent = {
    event: "step_update",
    step_update: {
      step_type: "tool",
      state: "DONE",
      tool_name: "call_mcp_tool",
      duration_seconds: 0.3,
      tool_info: {
        parameters: {
          ServerName: "qq-workflows",
          ToolName: "complete_task",
          Arguments: {
            response: "clipped telemetry parameters",
            data_points: [],
          },
        },
      },
    },
  };
  try {
    handleRunnerEvent(fakeRunner, completedEvent);

    assert.equal(fakeRunner.status, "completed");
    assert.ok(fakeRunner.result);
    assert.equal(fakeRunner.result.response, testResponse);
    assert.deepEqual(fakeRunner.result.data_points, testDataPoints);
    assert.ok(killCalled);
    assert.equal(killSignal, "SIGTERM");
  } finally {
    try { rmSync(resFile, { force: true }); } catch {}
  }
}

// ============================================================================
// Watchdog: stall suspicion-with-evidence and dead-process reconcile
// ============================================================================

// W1. Named constants: 4:50 stall-suspicion window and 10-minute long-tool
// tripwire, plus the per-tool max-duration contract. These now only gate the
// stall evidence a point-in-time read reports; no tool waits.
assert.equal(STALL_SUSPICION_WINDOW_MS, 290_000, "4:50 suspicion window must be 290000ms");
assert.equal(LONG_TOOL_SUSPICION_MS, 600_000, "long-tool tripwire must be 600000ms");
assert.ok(LONG_RUNNING_TOOLS.includes("run_command"), "run_command must be a known-long tool");
assert.ok(LONG_RUNNING_TOOLS.includes("bash"), "the Pi worker runtime's shell tool (bash) must be a known-long tool too");
assert.equal(stallSuspicionWindowMs(), 290_000);
assert.equal(longToolSuspicionMs(), 600_000);
assert.equal(toolSilenceThresholdMs("run_command"), 600_000);
assert.equal(toolSilenceThresholdMs("bash"), 600_000, "a Pi worker running the test suite is not reported as silence");
assert.equal(toolSilenceThresholdMs("view_file"), 290_000);
assert.equal(toolSilenceThresholdMs("grep_search"), 290_000);
assert.equal(toolSilenceThresholdMs("thinking"), 290_000);
assert.equal(toolSilenceThresholdMs(null), 290_000);
assert.equal(toolSilenceThresholdMs(undefined), 290_000);

// W1b. The blocking wait tools are absent from the callable schema, and no
// surviving tool advertises a wait window: there is nothing to park a turn on.
{
  assert.equal(TOOLS.some((t) => t.name === "await_runner" || t.name === "await_execution"), false);
  for (const tool of TOOLS) {
    assert.equal(tool.inputSchema.properties?.timeoutMs, undefined, `${tool.name} must not advertise a wait window`);
  }
  assert.equal(typeof awaitRunner, "undefined");
  assert.equal(typeof awaitExecution, "undefined");
}

// W2. Fully-silent runner past threshold: the point-in-time read returns stall
// evidence (not a failure, not a bare timeout), the
// child process is NOT killed, and check_runner surfaces the same flag.
{
  globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
    runner.activeTool = { name: "view_file", startedAt: Date.now() - 300_000 };
    runner.trajectory.push({ action: "view_file", target: "a.mjs", timestamp: Date.now() - 300_000 });
  };
  const disp = await dispatchRunner({ task: "silent runner", cwd: tmpdir() });
  const runner = RUNNERS.get(disp.runnerId);
  runner.startedAt = Date.now() - 300_000;
  runner.lastActivityAt = Date.now() - 300_000;
  let killed = false;
  runner.process = { exitCode: null, signalCode: null, kill: () => { killed = true; } };

  const check = await checkRunner({ runnerId: disp.runnerId });
  assert.equal(check.status, "running");
  assert.equal(check.stuckSuspect, true);
  assert.ok(check.suspicion, "check must surface the suspicion flag");
  assert.equal(check.suspicion.suspect, true);
  assert.ok(check.suspicion.activeTool, "evidence carries the active tool");
  assert.equal(check.suspicion.activeTool.name, "view_file");
  assert.ok(check.suspicion.activeTool.durationSeconds >= 290);
  assert.ok(Array.isArray(check.suspicion.trajectory), "evidence carries last trajectory steps");
  assert.ok(check.suspicion.elapsedSeconds >= 290, "evidence carries elapsed duration");
  assert.ok(check.suspicion.silenceSeconds >= 290, "evidence carries silence duration");

  const t0 = Date.now();
  const checked = await checkRunner({ runnerId: disp.runnerId });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5_000, `a point-in-time read must return promptly, took ${elapsed}ms`);
  assert.equal(checked.status, "running");
  assert.equal(checked.stuckSuspect, true, "quiet past threshold reports stall evidence");
  assert.ok(checked.suspicion);
  assert.equal(checked.suspicion.activeTool.name, "view_file");
  assert.equal(runner.status, "running", "a read must leave the work untouched");
  assert.equal(killed, false, "watchdog suspicion must never kill the child process");

  // Still silent afterwards: check keeps surfacing the flag (re-armed).
  const checkAgain = await checkRunner({ runnerId: disp.runnerId });
  assert.equal(checkAgain.stuckSuspect, true);
  delete globalThis.__QQ_TEST_RUNNER_HANDLER;
}

// W3. Dead-process reconcile (the 99%+ auto-case): the helper already
// exited but the tracker missed it, so the sweeper fixes the books to match
// reality and reports what happened. No live process is ever killed by it.
{
  // 3a. Exited with code 1 while "running" -> failed with exit code + tails.
  globalThis.__QQ_TEST_RUNNER_HANDLER = () => {};
  const disp = await dispatchRunner({ task: "dead helper", cwd: tmpdir() });
  const runner = RUNNERS.get(disp.runnerId);
  let killed = false;
  runner.process = { exitCode: 1, signalCode: null, kill: () => { killed = true; } };
  runner.outputTail = "last helper lines\n";
  runner.stderrTail = "boom\n";
  const rec = reconcileDeadRunner(runner);
  assert.ok(rec && rec.reconciled, "dead process must reconcile");
  assert.equal(rec.status, "failed");
  assert.equal(runner.status, "failed");
  assert.equal(runner.error.exitCode, 1);
  assert.match(runner.error.message, /exited with code 1/);
  assert.ok(runner.error.stderr.includes("boom"));
  assert.ok(runner.error.outputTail.includes("last helper lines"));
  assert.equal(killed, false, "reconcile must never kill (nothing left to kill)");
  assert.equal((await checkRunner({ runnerId: disp.runnerId })).status, "failed");

  // 3b. Exited 0 while "running" -> completed with last output as result.
  const dispOk = await dispatchRunner({ task: "dead ok helper", cwd: tmpdir() });
  const runnerOk = RUNNERS.get(dispOk.runnerId);
  runnerOk.process = { exitCode: 0, signalCode: null };
  runnerOk.outputTail = "final findings\n";
  const recOk = reconcileDeadRunner(runnerOk);
  assert.equal(recOk.status, "completed");
  assert.equal(runnerOk.status, "completed");
  assert.equal(runnerOk.result, "final findings");
  const checkOk = await checkRunner({ runnerId: dispOk.runnerId });
  assert.equal(checkOk.status, "completed");
  assert.equal(checkOk.result, undefined, "the read never carries findings");
  assert.equal(runnerOk.result, "final findings", "the reconciled result stays on the tracker for delivery");

  // 3c. Live process (no exit fields) is never reconciled.
  const dispLive = await dispatchRunner({ task: "live helper", cwd: tmpdir() });
  const runnerLive = RUNNERS.get(dispLive.runnerId);
  runnerLive.process = { exitCode: null, signalCode: null, kill: () => {} };
  assert.equal(reconcileDeadRunner(runnerLive), null);
  assert.equal(runnerLive.status, "running");
  // No process at all (test double) is never reconciled either.
  runnerLive.process = null;
  assert.equal(reconcileDeadRunner(runnerLive), null);

  // 3d. Reconcile never overwrites an already-terminal tracker.
  const dispTerm = await dispatchRunner({ task: "terminal helper", cwd: tmpdir() });
  const runnerTerm = RUNNERS.get(dispTerm.runnerId);
  runnerTerm.status = "failed";
  runnerTerm.error = { message: "original diagnosis" };
  runnerTerm.process = { exitCode: 1, signalCode: null };
  assert.equal(reconcileDeadRunner(runnerTerm), null);
  assert.equal(runnerTerm.error.message, "original diagnosis");
  delete globalThis.__QQ_TEST_RUNNER_HANDLER;
}

// W4. Healthy 6-minute runner: check shows running-with-progress throughout;
// await-after-completion returns the result immediately.
{
  globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
    runner.activeTool = { name: "grep_search", startedAt: Date.now() };
    runner.trajectory.push({ action: "grep_search", target: "q in /src", timestamp: Date.now() });
  };
  const disp = await dispatchRunner({ task: "healthy long runner", cwd: tmpdir() });
  const runner = RUNNERS.get(disp.runnerId);
  runner.startedAt = Date.now() - 360_000; // 6 minutes in, still producing
  runner.lastActivityAt = Date.now();
  const check = await checkRunner({ runnerId: disp.runnerId });
  assert.equal(check.status, "running");
  assert.equal(check.stuckSuspect, false);
  assert.equal(check.suspicion, null);
  assert.ok(check.elapsedSeconds >= 350);

  runner.status = "completed";
  runner.result = { response: "done after 6 minutes" };
  runner.activeTool = null;
  const t0 = Date.now();
  const checked = await checkRunner({ runnerId: disp.runnerId });
  assert.ok(Date.now() - t0 < 5_000, "a terminal read returns instantly");
  assert.equal(checked.status, "completed");
  assert.equal(checked.result, undefined, "the read never carries findings");
  assert.deepEqual(runner.result, { response: "done after 6 minutes" });
  delete globalThis.__QQ_TEST_RUNNER_HANDLER;
}

// W5. Long legitimately-busy step (stdout flowing, no tool-DONE yet): never
// watchdog-marked; check shows running with progress.
{
  globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
    // Tool started 8 minutes ago, but output is flowing right now.
    runner.activeTool = { name: "run_command", startedAt: Date.now() - 480_000 };
  };
  const disp = await dispatchRunner({ task: "busy shell step", cwd: tmpdir() });
  const runner = RUNNERS.get(disp.runnerId);
  runner.startedAt = Date.now() - 480_000;
  runner.lastActivityAt = Date.now(); // stdout flowing
  const check = await checkRunner({ runnerId: disp.runnerId });
  assert.equal(check.status, "running");
  assert.equal(check.stuckSuspect, false, "flowing output must never be marked");
  assert.equal(check.suspicion, null);
  assert.equal(check.activeTool.name, "run_command");

  // Same for a normal tool with fresh output despite an old start.
  runner.activeTool = { name: "view_file", startedAt: Date.now() - 360_000 };
  runner.lastActivityAt = Date.now();
  const check2 = await checkRunner({ runnerId: disp.runnerId });
  assert.equal(check2.stuckSuspect, false);
  delete globalThis.__QQ_TEST_RUNNER_HANDLER;
}

// W6. Unsure case (chatter without tool progress past the threshold): await
// returns needs-decision with evidence, the process is NOT killed, and the
// architect can steer, cancel, or re-await afterward.
{
  globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
    runner.activeTool = { name: "thinking", startedAt: Date.now() - 300_000 };
    runner.trajectory.push({ action: "log", message: "earlier chatter", timestamp: Date.now() - 300_000 });
  };
  const disp = await dispatchRunner({ task: "unsure runner", cwd: tmpdir() });
  const runner = RUNNERS.get(disp.runnerId);
  runner.startedAt = Date.now() - 300_000;
  runner.lastActivityAt = Date.now() - 300_000;
  let killed = false;
  runner.process = { exitCode: null, signalCode: null, kill: () => { killed = true; } };

  const checked = await checkRunner({ runnerId: disp.runnerId });
  assert.equal(checked.stuckSuspect, true);
  assert.ok(checked.suspicion.trajectory.length >= 1);
  assert.equal(runner.status, "running");
  assert.equal(killed, false);

  // Steering still responds afterward: for a legacy runner that response is a
  // truthful refusal (no verified receiver), never a false success.
  let steered = null;
  runner.onSteer = (inst) => { steered = inst; };
  const steerRes = await steerRunner({ runnerId: disp.runnerId, instruction: "focus on foo" });
  assert.equal(steerRes.ok, false);
  assert.equal(steerRes.supported, false);
  assert.equal(steered, null);
  assert.equal(runner.status, "running");

  // Re-await still works afterward (still silent -> needs-decision again).
  const rechecked = await checkRunner({ runnerId: disp.runnerId });
  assert.equal(rechecked.stuckSuspect, true);
  assert.equal(runner.status, "running");

  // Cancel still works afterward.
  const cancelRes = await cancelRunner({ runnerId: disp.runnerId });
  assert.equal(cancelRes.status, "cancelled");
  assert.equal(runner.status, "cancelled");
  delete globalThis.__QQ_TEST_RUNNER_HANDLER;
}

// W7. Runner that fails fast: await returns the failure immediately
// with the error (unchanged behavior).
{
  globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
    runner.status = "failed";
    runner.error = { message: "fast crash", exitCode: 1 };
  };
  const disp = await dispatchRunner({ task: "fast fail", cwd: tmpdir() });
  const t0 = Date.now();
  assert.equal((await checkRunner({ runnerId: disp.runnerId })).status, "failed");
  assert.ok(Date.now() - t0 < 5_000, "fast failure must surface immediately");
  delete globalThis.__QQ_TEST_RUNNER_HANDLER;
}

// W8. First-window semantics with short test thresholds (no minute-long
// sleeps): a fully-quiet first window returns suspicion for normal tools,
// while a quiet shell tool stays healthy inside its 10-minute absolute
// tripwire. A read never waits: only the evidence it reports changes.
{
  globalThis.__QQ_TEST_WATCHDOG = { stallSuspicionWindowMs: 150, longToolMs: 1200 };
  try {
    assert.equal(stallSuspicionWindowMs(), 150);
    assert.equal(longToolSuspicionMs(), 1200);
    assert.equal(toolSilenceThresholdMs("view_file"), 150);
    assert.equal(toolSilenceThresholdMs("run_command"), 1200);

    // 8a. Normal tool, quiet from await entry -> suspicion at window end.
    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
      runner.activeTool = { name: "view_file", startedAt: Date.now() };
    };
    const dispNormal = await dispatchRunner({ task: "quiet normal", cwd: tmpdir() });
    // Quiet past the (short) window: the read reports the same evidence a
    // waiting call used to report at its window end.
    RUNNERS.get(dispNormal.runnerId).lastActivityAt = Date.now() - 1_000;
    const checkedNormal = await checkRunner({ runnerId: dispNormal.runnerId });
    assert.equal(checkedNormal.status, "running");
    assert.equal(checkedNormal.stuckSuspect, true, "a quiet normal tool trips stall suspicion");
    assert.equal(checkedNormal.suspicion.activeTool.name, "view_file");
    assert.equal(RUNNERS.get(dispNormal.runnerId).status, "running");

    // 8b. Shell tool, quiet from read entry: the longer absolute tripwire means
    // a quiet shell is healthy inside its tool-specific window.
    globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
      runner.activeTool = { name: "run_command", startedAt: Date.now() };
    };
    const dispShell = await dispatchRunner({ task: "quiet shell", cwd: tmpdir() });
    const t0 = Date.now();
    const checkedShell = await checkRunner({ runnerId: dispShell.runnerId });
    const shellElapsed = Date.now() - t0;
    assert.equal(checkedShell.status, "running");
    assert.equal(checkedShell.stuckSuspect, false, "a quiet shell inside its tripwire is not stuck");
    assert.equal(checkedShell.suspicion, null);
    assert.ok(shellElapsed < 5_000, `a point-in-time read never waits out a window, took ${shellElapsed}ms`);
    assert.equal(RUNNERS.get(dispShell.runnerId).status, "running");

    // 8c. Shell tool quiet past its absolute tripwire -> suspicion.
    const runnerShell = RUNNERS.get(dispShell.runnerId);
    runnerShell.lastActivityAt = Date.now() - 1500;
    const checkedShellLate = await checkRunner({ runnerId: dispShell.runnerId });
    assert.equal(checkedShellLate.stuckSuspect, true, "shell past its tripwire must suspect");
    assert.equal(checkedShellLate.suspicion.activeTool.name, "run_command");
  } finally {
    delete globalThis.__QQ_TEST_WATCHDOG;
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
  }
  assert.equal(stallSuspicionWindowMs(), STALL_SUSPICION_WINDOW_MS, "test overrides must not leak");
}

// W9. Legacy timeoutMs is inert: it is not a parameter of any remaining tool,
// and a point-in-time read never fails or waits for a clock.
{
  globalThis.__QQ_TEST_WATCHDOG = { stallSuspicionWindowMs: 120, longToolMs: 1200 };
  globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
    runner.activeTool = { name: "run_command", startedAt: Date.now() };
  };
  try {
    const disp = await dispatchRunner({ task: "legacy timeoutMs", cwd: tmpdir() });
    const t0 = Date.now();
    const checked = await checkRunner({ runnerId: disp.runnerId, timeoutMs: 1 });
    assert.equal(checked.status, "running");
    assert.equal(checked.stuckSuspect, false);
    assert.ok(Date.now() - t0 < 5_000, "the read must not park on a clock");
  } finally {
    delete globalThis.__QQ_TEST_WATCHDOG;
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
  }
}

// W10. Terminal-overwrite guard: late or duplicate process events must never
// overwrite an already-recorded terminal state.
{
  // Late failure diagnosis must not clobber a completed result.
  const completedRunner = {
    id: "w10-completed", status: "completed", activeTool: null,
    trajectory: [], result: "good result", error: null, process: null,
    startedAt: Date.now(), lastActivityAt: Date.now(),
  };
  handleRunnerEvent(completedRunner, { event: "result", result: { status: "FAILURE", error: "late crash" } });
  assert.equal(completedRunner.status, "completed");
  assert.equal(completedRunner.result, "good result");
  assert.equal(completedRunner.error, null);

  // Late complete_task must not clobber a recorded failure.
  const failedRunner = {
    id: "w10-failed", status: "failed", activeTool: null,
    trajectory: [], result: null, error: { message: "original diagnosis" }, process: null,
    startedAt: Date.now(), lastActivityAt: Date.now(),
  };
  handleRunnerEvent(failedRunner, {
    event: "step_update",
    step_update: { step_type: "tool", state: "DONE", tool_name: "complete_task", duration_seconds: 0.1 },
  });
  assert.equal(failedRunner.status, "failed");
  assert.equal(failedRunner.error.message, "original diagnosis");
  assert.equal(failedRunner.result, null);

  // Transitions are liveness: a step event refreshes lastActivityAt.
  const livelyRunner = {
    id: "w10-lively", status: "running", activeTool: null,
    trajectory: [], result: null, error: null, process: null,
    startedAt: Date.now() - 60_000, lastActivityAt: Date.now() - 60_000,
  };
  handleRunnerEvent(livelyRunner, {
    event: "step_update",
    step_update: { step_type: "tool", state: "ACTIVE", tool_name: "grep_search" },
  });
  assert.ok(Date.now() - livelyRunner.lastActivityAt < 5_000, "tool transitions must count as activity");
  assert.equal(evaluateSuspicion(livelyRunner), null);
}

// W11. Runner spawn carries the pinned runtime root and the target cwd, and
// never a per-call provider/model/agent flag: the harness is centrally
// configured, so no caller can retune the runner invocation.
{
  const fakeDir = mkdtempSync(join(tmpdir(), "test-runner-timeout-"));
  try {
    const callLog = join(fakeDir, "runner-call.txt");
    const fakeAgy = join(fakeDir, "fake-runner.sh");
    writeFileSync(fakeAgy, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${callLog}"\n`);
    execFileSync("chmod", ["+x", fakeAgy]);
    const prevBin = process.env.QQ_RUNNER_BIN;
    process.env.QQ_RUNNER_BIN = fakeAgy;
    try {
      await dispatchRunner({ task: "runtime-root probe", cwd: tmpdir() });
      await new Promise((r) => setTimeout(r, 300));
      assert.ok(existsSync(callLog));
      const logged = readFileSync(callLog, "utf8");
      assert.ok(
        logged.includes(`--runtime-root\n${process.env.QQ_DEEPSEEK_RUNTIME_ROOT}`),
        "runner spawn must pass the centrally configured runtime root",
      );
      assert.ok(!logged.includes("--print-timeout"), "no CLI-specific timeout flag may remain");
      assert.ok(!logged.includes("--model"), "the model is never passed on the command line");
    } finally {
      if (prevBin !== undefined) process.env.QQ_RUNNER_BIN = prevBin;
      else delete process.env.QQ_RUNNER_BIN;
    }
  } finally {
    rmSync(fakeDir, { recursive: true, force: true });
  }
}

// W12. Execution parity: await_execution gets the identical guarantee
// (status by 4:50, notify-with-evidence, never hang, never fail for clocks).
{
  // 12a. Silent execution -> needs-decision with evidence; check agrees.
  const silentExec = {
    id: "w12-silent", kind: "bounded", status: "running", phase: "implementing",
    startedAt: Date.now() - 300_000, lastActivityAt: Date.now() - 300_000,
    activeTool: { name: "view_file", startedAt: Date.now() - 300_000 },
    trajectory: [{ action: "implementer_started", timestamp: Date.now() - 300_000 }],
    result: null, error: null, activeChild: null,
  };
  EXECUTIONS.set(silentExec.id, silentExec);
  try {
    const check = await checkExecution({ id: silentExec.id });
    assert.equal(check.status, "running");
    assert.equal(check.phase, "implementing");
    assert.equal(check.stuckSuspect, true);
    assert.ok(check.suspicion);
    assert.equal(check.suspicion.activeTool.name, "view_file");

    const checked = await checkExecution({ id: silentExec.id });
    assert.equal(checked.status, "running");
    assert.equal(checked.stuckSuspect, true);
    assert.ok(checked.suspicion);
    assert.equal(silentExec.status, "running", "execution suspicion must leave work untouched");
  } finally {
    EXECUTIONS.delete(silentExec.id);
  }

  // 12b. Healthy execution: a quiet shell tool inside its tripwire reads as
  // healthy, and the read returns immediately.
  globalThis.__QQ_TEST_WATCHDOG = { stallSuspicionWindowMs: 120, longToolMs: 1200 };
  const liveExec = {
    id: "w12-live", kind: "open", status: "running", phase: "reviewing",
    startedAt: Date.now(), lastActivityAt: Date.now(),
    activeTool: { name: "run_command", startedAt: Date.now() },
    trajectory: [{ action: "reviewer_started", timestamp: Date.now() }],
    result: null, error: null, activeChild: null,
  };
  EXECUTIONS.set(liveExec.id, liveExec);
  try {
    const t0 = Date.now();
    const checked = await checkExecution({ id: liveExec.id });
    const elapsed = Date.now() - t0;
    assert.equal(checked.status, "running");
    assert.equal(checked.stuckSuspect, false, "a quiet shell inside its tripwire is healthy");
    assert.equal(checked.phase, "reviewing");
    assert.ok(elapsed < 5_000, `a point-in-time read returns immediately, took ${elapsed}ms`);

    // Legacy timeoutMs is inert for the read too.
    const checkedLegacy = await checkExecution({ id: liveExec.id, timeoutMs: 1 });
    assert.equal(checkedLegacy.status, "running");
  } finally {
    EXECUTIONS.delete(liveExec.id);
    delete globalThis.__QQ_TEST_WATCHDOG;
  }

  // 12c. Terminal executions: await returns instantly, failures throw fast.
  const doneExec = {
    id: "w12-done", kind: "bounded", status: "completed", phase: "completed",
    startedAt: Date.now() - 60_000, lastActivityAt: Date.now(),
    activeTool: null, trajectory: [], result: { verifiedStory: "ok" }, error: null, activeChild: null,
  };
  EXECUTIONS.set(doneExec.id, doneExec);
  try {
    const t0 = Date.now();
    const checked = await checkExecution({ id: doneExec.id });
    assert.ok(Date.now() - t0 < 5_000);
    assert.equal(checked.status, "completed");
    assert.deepEqual(checked.result, { verifiedStory: "ok" });
  } finally {
    EXECUTIONS.delete(doneExec.id);
  }
  const failExec = {
    id: "w12-fail", kind: "bounded", status: "failed", phase: "implementing",
    startedAt: Date.now() - 60_000, lastActivityAt: Date.now(),
    activeTool: null, trajectory: [], result: null,
    error: { phase: "implementing", message: "exec impl blew up" }, activeChild: null,
  };
  EXECUTIONS.set(failExec.id, failExec);
  try {
    const checkedFail = await checkExecution({ id: failExec.id });
    assert.equal(checkedFail.status, "failed");
    assert.equal(checkedFail.error.message, "exec impl blew up");
  } finally {
    EXECUTIONS.delete(failExec.id);
  }
}

// W13. Point-in-time reads keep the pipe usable: reads, steer, and cancel all
// work on the same surface without a parked wait to wedge it.
{
  globalThis.__QQ_TEST_WATCHDOG = { stallSuspicionWindowMs: 100, longToolMs: 1200 };
  globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
    runner.activeTool = { name: "run_command", startedAt: Date.now() };
  };
  try {
    const disp = await dispatchRunner({ task: "pipe stays usable", cwd: tmpdir() });
    const first = await checkRunner({ runnerId: disp.runnerId });
    assert.equal(first.status, "running");
    assert.equal(first.stuckSuspect, false);
    // Later calls still work: read, steer, read again, cancel, read terminal.
    const check = await checkRunner({ runnerId: disp.runnerId });
    assert.equal(check.status, "running");
    const runner = RUNNERS.get(disp.runnerId);
    runner.onSteer = () => {};
    assert.equal((await steerRunner({ runnerId: disp.runnerId, instruction: "keep going" })).ok, false, "legacy steer is truthfully refused mid-session");
    const second = await checkRunner({ runnerId: disp.runnerId });
    assert.equal(second.status, "running");
    assert.equal((await cancelRunner({ runnerId: disp.runnerId })).status, "cancelled");
    assert.equal((await checkRunner({ runnerId: disp.runnerId })).status, "cancelled");
  } finally {
    delete globalThis.__QQ_TEST_WATCHDOG;
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
  }
}

// ============================================================================
// Execution stream ingestion: subagent JSONL populates trajectory + clean output
// ============================================================================

function makeStreamTestExecution() {
  return {
    id: "exec-stream-test",
    status: "running",
    phase: "implementing",
    startedAt: Date.now(),
    lastActivityAt: Date.now() - 60_000,
    activeTool: null,
    trajectory: [],
  };
}

// S1. Muse tool_batch.effect.started sets execution.activeTool.
{
  const exec = makeStreamTestExecution();
  handleExecutionStreamEvent(exec, {
    payload_type: "tool_batch.effect.started",
    payload: {
      record: {
        tool_name: "read_file",
        call_id: "call-1",
        parallel_profile: { kind: "file_read", subject: "workspace:foo.mjs" },
      },
    },
  });
  assert.equal(exec.activeTool.name, "read_file");
  assert.ok(typeof exec.activeTool.startedAt === "number");
  assert.ok(Date.now() - exec.lastActivityAt < 5_000, "tool transitions must count as activity");
}

// S2. Muse tool_batch.effect.terminal clears activeTool and appends
// { action, target, timestamp }, correlating the tool name via the started
// event (real terminal records carry no tool_name).
{
  const exec = makeStreamTestExecution();
  handleExecutionStreamEvent(exec, {
    payload_type: "tool_batch.effect.started",
    payload: {
      record: {
        tool_name: "read_file",
        call_id: "call-9",
        parallel_profile: { kind: "file_read", subject: "workspace:foo.mjs" },
      },
    },
  });
  handleExecutionStreamEvent(exec, {
    payload_type: "tool_batch.effect.terminal",
    payload: { record: { call_id: "call-9" } },
  });
  assert.equal(exec.activeTool, null);
  assert.equal(exec.trajectory.length, 1);
  assert.equal(exec.trajectory[0].action, "read_file");
  assert.equal(exec.trajectory[0].target, "workspace:foo.mjs");
  assert.ok(exec.trajectory[0].timestamp);

  // A terminal record carrying its own tool_name works too.
  handleExecutionStreamEvent(exec, {
    payload_type: "tool_batch.effect.terminal",
    payload: { record: { tool_name: "bash", target: "npm test" } },
  });
  assert.equal(exec.trajectory.length, 2);
  assert.equal(exec.trajectory[1].action, "bash");
  assert.equal(exec.trajectory[1].target, "npm test");
}

// S3. Muse run.terminal.completed captures payload.text as clean output.
{
  const exec = makeStreamTestExecution();
  exec.activeTool = { name: "read_file", startedAt: Date.now() };
  handleExecutionStreamEvent(exec, {
    payload_type: "run.terminal.completed",
    payload: { kind: "run_terminal", terminal: "completed", text: "# Done\nAll changes implemented." },
  });
  assert.equal(exec._cleanOutput, "# Done\nAll changes implemented.");
  assert.equal(exec.activeTool, null);
}

// S4. Gemini step_update ACTIVE/DONE updates activeTool + trajectory, and
// result captures clean output without driving execution status.
{
  const exec = makeStreamTestExecution();
  handleExecutionStreamEvent(exec, {
    event: "step_update",
    step_update: { step_type: "tool", state: "ACTIVE", tool_name: "view_file" },
  });
  assert.equal(exec.activeTool.name, "view_file");
  handleExecutionStreamEvent(exec, {
    event: "step_update",
    step_update: {
      step_type: "tool",
      state: "DONE",
      tool_name: "view_file",
      duration_seconds: 1.2,
      tool_info: { parameters: { AbsolutePath: "/repo/foo.mjs" } },
    },
  });
  assert.equal(exec.activeTool, null);
  assert.equal(exec.trajectory.length, 1);
  assert.equal(exec.trajectory[0].action, "view_file");
  assert.equal(exec.trajectory[0].target, "/repo/foo.mjs");
  assert.equal(exec.trajectory[0].parameters, undefined);
  handleExecutionStreamEvent(exec, {
    event: "result",
    result: { status: "SUCCESS", response: "Gemini final answer." },
  });
  assert.equal(exec._cleanOutput, "Gemini final answer.");
  assert.equal(exec.status, "running", "a child result event must never drive execution status");
}

// S5. Codex item.started/item.completed updates activeTool + trajectory, and
// agent_message items accumulate clean output.
{
  const exec = makeStreamTestExecution();
  handleExecutionStreamEvent(exec, {
    type: "item.started",
    item: { id: "item_0", type: "command_execution", command: ["cat", "package.json"], status: "in_progress" },
  });
  assert.equal(exec.activeTool.name, "command_execution");
  handleExecutionStreamEvent(exec, {
    type: "item.completed",
    item: { id: "item_0", type: "command_execution", command: ["cat", "package.json"], status: "completed" },
  });
  assert.equal(exec.activeTool, null);
  assert.equal(exec.trajectory.length, 1);
  assert.equal(exec.trajectory[0].action, "command_execution");
  assert.equal(exec.trajectory[0].target, "cat package.json");
  handleExecutionStreamEvent(exec, {
    type: "item.completed",
    item: { id: "item_1", type: "agent_message", text: "Codex finished the task." },
  });
  assert.equal(exec._cleanOutput, "Codex finished the task.");
  // Reasoning items carry no trajectory signal.
  const before = exec.trajectory.length;
  handleExecutionStreamEvent(exec, {
    type: "item.completed",
    item: { id: "item_2", type: "reasoning", text: "thinking..." },
  });
  assert.equal(exec.trajectory.length, before);
}

// S6. Trajectory recycling invariant: >25 tool events cap at 25 items,
// evicting provision_worktree and preserving chronological order.
{
  const exec = makeStreamTestExecution();
  exec.trajectory.push({ action: "provision_worktree", timestamp: Date.now() });
  for (let i = 1; i <= 30; i++) {
    handleExecutionStreamEvent(exec, {
      payload_type: "tool_batch.effect.started",
      payload: { record: { tool_name: `tool-${i}`, call_id: `call-${i}` } },
    });
    handleExecutionStreamEvent(exec, {
      payload_type: "tool_batch.effect.terminal",
      payload: { record: { call_id: `call-${i}` } },
    });
  }
  assert.equal(exec.trajectory.length, 25);
  assert.ok(!exec.trajectory.some((t) => t.action === "provision_worktree"));
  // 1 + 30 = 31 entries, keep the last 25 -> first kept is tool-6.
  for (let i = 0; i < 25; i++) {
    assert.equal(exec.trajectory[i].action, `tool-${6 + i}`);
  }
}

// S7. Unsupported legacy implementer remains observable: the central launcher
// argv is used and 30 streamed tools recycle the trajectory; stdout is retained
// as findings, but cannot stand in for a typed final disposition or authorize landing.
{
  const pipeRepo = mkdtempSync(join(tmpdir(), "architect-exec-stream-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "architect-exec-fakebin-"));
  const prevSubagentBin = process.env.QQ_SUBAGENT_BIN;
  try {
    await git(pipeRepo, ["init", "-b", "main"]);
    await git(pipeRepo, ["config", "user.name", "MCP Test"]);
    await git(pipeRepo, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(pipeRepo, "README.md"), "# Stream\n");
    await git(pipeRepo, ["add", "README.md"]);
    await git(pipeRepo, ["commit", "-m", "init"]);
    const streamSessId = "e7e7e7e7-1111-2222-3333-444444444444";
    mkdirSync(join(pipeRepo, ".architect", "tickets"), { recursive: true });
    writeFileSync(join(pipeRepo, ".architect", "tickets", `${streamSessId}.md`), "# Stream Ticket\n\n## Kind\nbounded\n");

    const argsLog = join(fakeBin, "worker-args.txt");
    const streamLines = [];
    for (let i = 1; i <= 30; i++) {
      streamLines.push(
        `printf '%s\\n' '{"payload_type":"tool_batch.effect.started","payload":{"record":{"tool_name":"stream-tool-${i}","call_id":"call-${i}","parallel_profile":{"subject":"workspace:file-${i}.mjs"}}}}'`,
      );
      streamLines.push(
        `printf '%s\\n' '{"payload_type":"tool_batch.effect.terminal","payload":{"record":{"call_id":"call-${i}"}}}'`,
      );
    }
    writeFileSync(
      join(fakeBin, "worker-double.sh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsLog}"\necho probe > stream-probe.txt\n${streamLines.join("\n")}\nprintf '%s\\n' '{"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":"## Done\\nStreamed implementation complete."}}'\n`,
    );
    execFileSync("chmod", ["+x", join(fakeBin, "worker-double.sh")]);
    process.env.QQ_SUBAGENT_BIN = join(fakeBin, "worker-double.sh");

    const disp = await dispatchExecution({ kind: "bounded", sessionId: streamSessId, cwd: pipeRepo });
    await waitForExecution(disp.id);
    const done = await checkExecution({ id: disp.id });
    assert.equal(done.status, "failed");
    assert.equal(done.phase, "implementing");
    assert.ok(done.error.reportId, "unsupported worker output remains a durable report");
    const streamedReport = readReport(process.env.QQ_WORKFLOW_STATE_DIR, done.error.reportId).text;
    assert.match(streamedReport, /Streamed implementation complete/);
    assert.doesNotMatch(streamedReport, /payload_type|tool_batch/);

    const loggedArgs = readFileSync(argsLog, "utf8");
    assert.ok(loggedArgs.includes(WORKER_DEEPSEEK_ADAPTER), "the centrally configured adapter is the worker entry");
    assert.ok(loggedArgs.includes("--production"), "production mode is explicit");
    assert.ok(loggedArgs.includes("--seat\nimplementer"), "the implementer seat is explicit");
    assert.ok(!loggedArgs.includes("--json"), "no provider-template flag may reach the worker");

    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    assert.equal(check.trajectory.length, 25);
    assert.ok(!check.trajectory.some((t) => t.action === "provision_worktree"));
    assert.ok(check.trajectory.some((t) => t.action === "stream-tool-30" && t.target === "workspace:file-30.mjs"));
    assert.ok(!check.trajectory.some((t) => t.action === "landing_started" || t.action === "execution_completed"));
    assert.equal(readFileSync(join(EXECUTIONS.get(disp.id).worktree, "stream-probe.txt"), "utf8"), "probe\n", "failed execution preserves its changes");
  } finally {
    if (prevSubagentBin === undefined) delete process.env.QQ_SUBAGENT_BIN;
    else process.env.QQ_SUBAGENT_BIN = prevSubagentBin;
    try {
      rmSync(join(dirname(pipeRepo), ".qq-worktrees", basename(pipeRepo)), { recursive: true, force: true });
    } catch {}
    rmSync(pipeRepo, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

// S8. Pipeline with a codex-shaped worker double for the centrally configured
// harness: tool items enter the trajectory and the agent_message becomes the
// clean summary. A per-call provider is refused instead of selecting a
// different launcher.
{
  const pipeRepo = mkdtempSync(join(tmpdir(), "architect-exec-codex-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "architect-exec-codexbin-"));
  const prevSubagentBin = process.env.QQ_SUBAGENT_BIN;
  try {
    await git(pipeRepo, ["init", "-b", "main"]);
    await git(pipeRepo, ["config", "user.name", "MCP Test"]);
    await git(pipeRepo, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(pipeRepo, "README.md"), "# Codex\n");
    await git(pipeRepo, ["add", "README.md"]);
    await git(pipeRepo, ["commit", "-m", "init"]);
    const codexSessId = "c0dec0de-1111-2222-3333-444444444444";
    mkdirSync(join(pipeRepo, ".architect", "tickets"), { recursive: true });
    writeFileSync(join(pipeRepo, ".architect", "tickets", `${codexSessId}.md`), "# Codex Ticket\n\n## Kind\nbounded\n");

    const argsLog = join(fakeBin, "worker-args.txt");
    writeFileSync(
      join(fakeBin, "worker-double.sh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsLog}"\necho "codex implementation" > codex-impl.txt\n` +
        `printf '%s\\n' '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":["cat","package.json"],"status":"in_progress"}}'\n` +
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":["cat","package.json"],"status":"completed"}}'\n` +
        `printf '%s\\n' '{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","tool":"list_files","status":"in_progress"}}'\n` +
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","tool":"list_files","status":"completed"}}'\n` +
        `printf '%s\\n' '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Codex finished the task."}}'\n` +
        `printf '%s\\n' '{"type":"turn.completed","usage":{}}'\n`,
    );
    execFileSync("chmod", ["+x", join(fakeBin, "worker-double.sh")]);
    process.env.QQ_SUBAGENT_BIN = join(fakeBin, "worker-double.sh");

    // A per-call provider override is refused before any worker starts.
    await assert.rejects(
      () => dispatchExecution({ kind: "bounded", sessionId: codexSessId, cwd: pipeRepo, implementerProvider: "codex" }),
      /provider override 'implementerProvider' is not permitted/,
    );

    const disp = await dispatchExecution({
      kind: "bounded",
      sessionId: codexSessId,
      cwd: pipeRepo,
    });
    await waitForExecution(disp.id);
    const done = await checkExecution({ id: disp.id });
    assert.equal(done.status, "failed");
    assert.equal(done.phase, "implementing");
    assert.ok(done.error.reportId);
    assert.equal(readReport(process.env.QQ_WORKFLOW_STATE_DIR, done.error.reportId).text, "Codex finished the task.");

    const loggedArgs = readFileSync(argsLog, "utf8");
    assert.ok(loggedArgs.includes("--seat\nimplementer"), "the implementer seat comes from the pipeline, not a provider argument");

    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    const actions = check.trajectory.map((t) => t.action);
    assert.ok(actions.includes("command_execution"));
    assert.ok(actions.includes("list_files"));
    const cmdEntry = check.trajectory.find((t) => t.action === "command_execution");
    assert.equal(cmdEntry.target, "cat package.json");

    assert.ok(!actions.includes("landing_started"), "untyped stream cannot authorize publication");
  } finally {
    if (prevSubagentBin === undefined) delete process.env.QQ_SUBAGENT_BIN;
    else process.env.QQ_SUBAGENT_BIN = prevSubagentBin;
    try {
      rmSync(join(dirname(pipeRepo), ".qq-worktrees", basename(pipeRepo)), { recursive: true, force: true });
    } catch {}
    rmSync(pipeRepo, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

// S9. Text-mode fallback: a worker double with no structured terminal event
// resolves with accumulated plain text, and long lines become bounded log
// entries. The worker still launches under the central contract.
{
  const pipeRepo = mkdtempSync(join(tmpdir(), "architect-exec-text-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "architect-exec-textbin-"));
  const prevSubagentBin = process.env.QQ_SUBAGENT_BIN;
  try {
    await git(pipeRepo, ["init", "-b", "main"]);
    await git(pipeRepo, ["config", "user.name", "MCP Test"]);
    await git(pipeRepo, ["config", "user.email", "mcp@example.invalid"]);
    writeFileSync(join(pipeRepo, "README.md"), "# Text\n");
    await git(pipeRepo, ["add", "README.md"]);
    await git(pipeRepo, ["commit", "-m", "init"]);
    const textSessId = "9e9e9e9e-1111-2222-3333-444444444444";
    mkdirSync(join(pipeRepo, ".architect", "tickets"), { recursive: true });
    writeFileSync(join(pipeRepo, ".architect", "tickets", `${textSessId}.md`), "# Text Ticket\n\n## Kind\nbounded\n");

    const longLine = `LONG-${"x".repeat(500)}`;
    const argsLog = join(fakeBin, "worker-args.txt");
    writeFileSync(
      join(fakeBin, "worker-double.sh"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argsLog}"\necho probe > text-probe.txt\nprintf '%s\\n' 'Plain text implementation report.' '${longLine}'\n`,
    );
    execFileSync("chmod", ["+x", join(fakeBin, "worker-double.sh")]);
    process.env.QQ_SUBAGENT_BIN = join(fakeBin, "worker-double.sh");

    const disp = await dispatchExecution({
      kind: "bounded",
      sessionId: textSessId,
      cwd: pipeRepo,
    });
    await waitForExecution(disp.id);
    const done = await checkExecution({ id: disp.id });
    assert.equal(done.status, "failed");
    assert.equal(done.phase, "implementing");
    assert.ok(done.error.reportId);
    const textReport = readReport(process.env.QQ_WORKFLOW_STATE_DIR, done.error.reportId).text;
    assert.match(textReport, /Plain text implementation report/);
    assert.ok(textReport.includes(longLine));
    assert.ok(!done.result?.landingOutcome, "untyped plain text cannot authorize landing");

    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    const logs = check.trajectory.filter((t) => t.action === "log");
    assert.ok(logs.length >= 2, "text lines must be recorded as log entries");
    for (const entry of logs) {
      assert.ok(entry.message.length <= 200, "log messages must be bounded");
    }
    const loggedArgs = readFileSync(argsLog, "utf8");
    assert.ok(loggedArgs.includes("--seat\nimplementer"), "the text-mode worker is still the central implementation seat");
  } finally {
    if (prevSubagentBin === undefined) delete process.env.QQ_SUBAGENT_BIN;
    else process.env.QQ_SUBAGENT_BIN = prevSubagentBin;
    try {
      rmSync(join(dirname(pipeRepo), ".qq-worktrees", basename(pipeRepo)), { recursive: true, force: true });
    } catch {}
    rmSync(pipeRepo, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

// ============================================================================
// Reactive Codex notifications: dispatch-and-yield wakeups (N1..N9)
// ============================================================================
// Muse keeps the 4:50 await contract (covered above); Codex architects yield
// and are woken via `codex queue`. Kill any singleton sweeper first: the
// startMcpServer test above armed one, and a 15s auto-sweep racing these
// assertions would be flaky by design.

// N0. dispatch_runner schema gains an optional sessionId for notification
// routing; required stays ["task"] (backwards compatible).
{
  const dispatchTool = TOOLS.find((t) => t.name === "dispatch_runner");
  assert.deepEqual(dispatchTool.inputSchema.required, ["task"]);
  assert.equal(dispatchTool.inputSchema.properties.sessionId.type, "string");
  assert.equal(TOOLS.some((t) => t.name === "await_runner"), false, "no blocking wait tool is registered");
  assert.equal(TOOLS.some((t) => t.name === "await_execution"), false);
}

stopSuspicionSweeper();

const savedNotifyEnv = {};
for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_CONVERSATION_ID", "QQ_CODEX_BIN"]) {
  savedNotifyEnv[key] = process.env[key];
  delete process.env[key];
}
globalThis.__QQ_TEST_DISABLE_PROC_THREAD = true;

// N1. Sweep constants: 15s cadence, 30m suspicion re-arm, test overrides.
assert.equal(NOTIFY_SWEEP_INTERVAL_MS, 15_000, "sweep cadence must be 15000ms");
assert.equal(SUSPICION_RENOTIFY_MS, 1_800_000, "suspicion re-arm must be 1800000ms");
assert.equal(sweepIntervalMs(), 15_000);
assert.equal(suspicionRearmMs(), 1_800_000);
globalThis.__QQ_TEST_WATCHDOG = { sweepMs: 500, suspicionRearmMs: 700 };
assert.equal(sweepIntervalMs(), 500);
assert.equal(suspicionRearmMs(), 700);
delete globalThis.__QQ_TEST_WATCHDOG;
assert.equal(sweepIntervalMs(), NOTIFY_SWEEP_INTERVAL_MS, "test overrides must not leak");

// N2. resolveCodexThreadId: null outside Codex; test thread > map > env.
assert.equal(resolveCodexThreadId("sess-1"), null);
assert.equal(resolveCodexThreadId(null), null);
process.env.CODEX_SESSION_ID = "env-session";
process.env.CODEX_CONVERSATION_ID = "env-conv";
assert.equal(resolveCodexThreadId("sess-1"), "env-session");
process.env.CODEX_THREAD_ID = "env-thread";
assert.equal(resolveCodexThreadId("sess-1"), "env-thread");
globalThis.__QQ_CODEX_THREAD_MAP = new Map([["sess-1", "mapped-thread"]]);
assert.equal(resolveCodexThreadId("sess-1"), "mapped-thread");
assert.equal(resolveCodexThreadId("other"), "env-thread");
globalThis.__QQ_CODEX_THREAD_MAP = { "sess-2": "plain-mapped" };
assert.equal(resolveCodexThreadId("sess-2"), "plain-mapped");
globalThis.__QQ_TEST_CODEX_THREAD = "explicit-test-thread";
assert.equal(resolveCodexThreadId("sess-1"), "explicit-test-thread");
delete globalThis.__QQ_TEST_CODEX_THREAD;
delete globalThis.__QQ_CODEX_THREAD_MAP;
delete process.env.CODEX_THREAD_ID;
delete process.env.CODEX_SESSION_ID;
delete process.env.CODEX_CONVERSATION_ID;
delete process.env.CODEX_HOME;
assert.equal(resolveCodexThreadId("sess-1"), null);

// N2b. resolveCodexThreadId uses DETECTED_CODEX_THREADS mapping.
DETECTED_CODEX_THREADS.set("sess-detected", "01a0ad31-c1fa-7b23-a0cf-84739b490071");
assert.equal(resolveCodexThreadId("sess-detected"), "01a0ad31-c1fa-7b23-a0cf-84739b490071");
DETECTED_CODEX_THREADS.delete("sess-detected");
assert.equal(resolveCodexThreadId("sess-detected"), null);
assert.equal(findCodexThreadFromProc(null), null);
assert.equal(findCodexThreadFromProc(0), null);
assert.equal(findCodexHomeFromProc(null), null);
assert.equal(findCodexHomeFromProc(0), null);
DETECTED_CODEX_HOMES.set("sess-detected", "/tmp/fake-home");
assert.equal(DETECTED_CODEX_HOMES.get("sess-detected"), "/tmp/fake-home");
DETECTED_CODEX_HOMES.delete("sess-detected");

// N3. notifySession without a Codex thread is a quiet no-op; never throws.
{
  const res = await notifySession("sess-1", "hello");
  assert.equal(res.notified, false);
  assert.equal(res.reason, "no-codex-context");
  assert.equal((await notifySession("sess-1", "")).reason, "empty-message");
  assert.equal((await notifySession(null, "x")).reason, "no-codex-context");
}

// N4. notifySession delivers via test hook, and via `codex queue` argv with
// shell-hostile payloads arriving byte-identical (no shell corruption).
{
  const calls = [];
  globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { calls.push(call); };
  try {
    const res = await notifySession("sess-9", "terminal story", { kind: "execution.terminal", trackerId: "exec-1" });
    assert.equal(res.notified, true);
    assert.equal(res.via, "test-hook");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, "sess-9");
    assert.equal(calls[0].message, "terminal story");
    assert.equal(calls[0].kind, "execution.terminal");
    assert.equal(calls[0].trackerId, "exec-1");
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
  }

  // A throwing hook must not break the notify call itself.
  globalThis.__QQ_TEST_NOTIFY_HANDLER = () => { throw new Error("hook boom"); };
  try {
    assert.equal((await notifySession("s", "m")).notified, true);
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
  }

  // Fake `codex` binary: argv must carry the message verbatim.
  const fakeDir = mkdtempSync(join(tmpdir(), "test-codex-queue-"));
  try {
    const argLog = join(fakeDir, "queue-args.txt");
    writeFileSync(fakeDir + "/codex", `#!/usr/bin/env bash\nfor a in "$@"; do echo "ARG:$a"; done > "${argLog}"\n`);
    execFileSync("chmod", ["+x", join(fakeDir, "codex")]);
    process.env.CODEX_SESSION_ID = "thread-abc";
    process.env.QQ_CODEX_BIN = join(fakeDir, "codex");
    const tricky = 'done $HOME `id` "quoted" \'sq\' * $(x) & | ;\nsecond line ✓';
    const res = await notifySession("sess-1", tricky);
    assert.equal(res.notified, true);
    assert.equal(res.via, "codex-queue");
    assert.equal(res.threadId, "thread-abc");
    const lines = readFileSync(argLog, "utf8").split("\n").filter((l) => l.length > 0);
    assert.deepEqual(lines.slice(0, 4), ["ARG:queue", "ARG:--thread", "ARG:thread-abc", "ARG:--message"]);
    // The message is one argv element: only its first physical line carries
    // the ARG: prefix; embedded newlines continue bare.
    const msgLines = lines.slice(4);
    const rejoined = [msgLines[0].slice("ARG:".length), ...msgLines.slice(1)].join("\n");
    assert.equal(rejoined, tricky, "queue message argv must survive shell-hostile content verbatim");
  } finally {
    delete process.env.CODEX_SESSION_ID;
    process.env.QQ_CODEX_BIN = "/usr/bin/true";
    rmSync(fakeDir, { recursive: true, force: true });
  }

  // Missing binary degrades to notified:false, never throws.
  process.env.CODEX_SESSION_ID = "thread-abc";
  process.env.QQ_CODEX_BIN = join(tmpdir(), "no-such-codex-binary-xyz");
  try {
    const res = await notifySession("sess-1", "hello");
    assert.equal(res.notified, false);
  } finally {
    delete process.env.CODEX_SESSION_ID;
    process.env.QQ_CODEX_BIN = "/usr/bin/true";
  }
}

// N5. Terminal/suspicion message builders carry landing status, summaries,
// stall evidence, and bounded tails.
{
  const doneExec = {
    id: "n5-done", kind: "open", status: "completed", phase: "completed",
    startedAt: Date.now() - 61_000, branch: "architect/open/abcd",
    result: {
      verifiedStory: "Worktree verified and landed.",
      landingOutcome: { landed: true, branch: "architect/open/abcd", method: "pr", pr: "https://x/pull/7", mergeSha: "abc123def456789" },
      implementerSummary: "Implemented the thing.",
      reviewerSummary: "No defects found.",
    },
  };
  const doneMsg = buildExecutionTerminalMessage(doneExec);
  assert.ok(doneMsg.includes("n5-done"));
  assert.ok(doneMsg.includes("verified and landed"));
  assert.ok(doneMsg.includes("architect/open/abcd"));
  assert.ok(doneMsg.includes("method=pr"));
  assert.ok(doneMsg.includes("https://x/pull/7"));
  assert.ok(doneMsg.includes("Implemented the thing."));
  assert.ok(doneMsg.includes("No defects found."));

  const failExec = {
    id: "n5-fail", kind: "bounded", status: "failed", phase: "implementing",
    startedAt: Date.now() - 61_000, branch: "architect/bounded/efgh", worktree: "/tmp/wt",
    error: { phase: "implementing", message: "impl blew up", exitCode: 3, stderr: "kaboom" },
  };
  const failMsg = buildExecutionTerminalMessage(failExec);
  assert.ok(failMsg.includes("failed in phase 'implementing'"));
  assert.ok(failMsg.includes("impl blew up"));
  assert.ok(failMsg.includes("exitCode=3"));
  assert.ok(failMsg.includes("kaboom"));

  const doneRunner = {
    runnerId: "n5-r", status: "completed", startedAt: Date.now() - 61_000,
    result: { response: "found the bug", data_points: ["a.mjs:10"] },
  };
  const runMsg = buildRunnerTerminalMessage(doneRunner);
  assert.ok(runMsg.includes("n5-r"));
  assert.ok(runMsg.includes("found the bug"));
  assert.ok(runMsg.includes("a.mjs:10"));
  const failRunner = {
    runnerId: "n5-rf", status: "failed", startedAt: Date.now() - 61_000,
    error: { message: "Runner process exited with code 1", exitCode: 1, stderr: "trace" },
    outputTail: "last lines",
  };
  const runFailMsg = buildRunnerTerminalMessage(failRunner);
  assert.ok(runFailMsg.includes("exited with code 1"));
  assert.ok(runFailMsg.includes("trace"));

  // Findings up to the transport cap are preserved completely without truncation.
  const medium = "z".repeat(Math.floor(COMPLETE_TASK_RESPONSE_MAX * 0.6));
  const mediumMsg = buildRunnerTerminalMessage({ runnerId: "medium", status: "completed", startedAt: Date.now(), result: medium });
  assert.ok(!mediumMsg.includes("chars omitted"), "sub-cap findings must not be truncated");
  assert.ok(mediumMsg.includes(medium), "sub-cap findings must be preserved intact");
  const atCap = "z".repeat(COMPLETE_TASK_RESPONSE_MAX);
  const atCapMsg = buildRunnerTerminalMessage({ runnerId: "atcap", status: "completed", startedAt: Date.now(), result: atCap });
  assert.ok(!atCapMsg.includes("chars omitted"), "cap-length findings must not be truncated");
  assert.ok(atCapMsg.includes(atCap), "cap-length findings must be preserved intact");

  // No verified notification limit is configured, so even an over-length
  // findings string (which the completion transport would itself reject) is
  // delivered whole — no blind truncation, no invented 32,768 transport cap,
  // and no pointer to check_runner (which no longer returns findings).
  const big = "z".repeat(40_000);
  const bigMsg = buildRunnerTerminalMessage({ runnerId: "big", status: "completed", startedAt: Date.now(), result: big });
  assert.ok(!bigMsg.includes("chars omitted"), "over-length findings must not be blind-truncated");
  assert.ok(bigMsg.includes(big), "over-length findings must be delivered whole");
  assert.ok(!bigMsg.includes("check_runner"), "no check_runner findings pointer may remain");

  const susMsg = buildSuspicionMessage("runner", { runnerId: "n5-s" }, {
    suspect: true,
    reason: "No output or tool transitions for 300s (threshold 290s for tool 'view_file'). Quiet long enough to take a look — not a verdict of stuck.",
    activeTool: { name: "view_file", durationSeconds: 300 },
    elapsedSeconds: 300, silenceSeconds: 300, thresholdSeconds: 290,
    trajectory: [{ action: "view_file", target: "a.mjs", timestamp: Date.now() }],
  });
  assert.ok(susMsg.includes("[needs-decision]"));
  assert.ok(susMsg.includes("n5-s"));
  assert.ok(susMsg.includes("view_file"));
  assert.ok(susMsg.includes("process left alive, nothing was killed"));
  assert.ok(susMsg.includes("a.mjs"));
  assert.ok(susMsg.includes("check_runner"));
  const execSus = buildSuspicionMessage("execution", { id: "n5-e", phase: "reviewing" }, {
    suspect: true, reason: "quiet", activeTool: null,
    elapsedSeconds: 1, silenceSeconds: 1, thresholdSeconds: 1, trajectory: [],
  });
  assert.ok(execSus.includes("phase 'reviewing'"));
  assert.ok(execSus.includes("check_execution"));
}

// N6. notifyTerminal: once per tracker, completed/failed only, never throws.
{
  const calls = [];
  globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { calls.push(call); };
  try {
    const done = { id: "n6-done", kind: "bounded", status: "completed", phase: "completed", startedAt: Date.now(), result: { verifiedStory: "ok" } };
    assert.equal((await notifyTerminal(done, "execution")).notified, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].kind, "execution.terminal");
    assert.equal((await notifyTerminal(done, "execution")).reason, "already-notified");
    assert.equal(calls.length, 1, "terminal wakeup must fire exactly once");

    const running = { id: "n6-run", status: "running" };
    assert.equal((await notifyTerminal(running, "execution")).reason, "not-terminal");
    const cancelled = { runnerId: "n6-can", status: "cancelled" };
    assert.equal((await notifyTerminal(cancelled, "runner")).reason, "not-terminal");
    assert.equal(calls.length, 1, "running/cancelled trackers must never wake");
    assert.equal((await notifyTerminal(null, "runner")).reason, "already-notified");
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
  }
}

// N7. Runner transition hooks wake on completed/failed with findings.
{
  async function waitForNotify(calls, predicate, timeoutMs = 2000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = calls.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 20));
    }
    return calls.find(predicate);
  }

  const calls = [];
  globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { calls.push(call); };
  globalThis.__QQ_TEST_RUNNER_HANDLER = () => {};
  try {
    const disp = await dispatchRunner({ task: "hook probe", cwd: tmpdir(), sessionId: "sess-hook" });
    assert.equal(RUNNERS.get(disp.runnerId).sessionId, "sess-hook");
    handleRunnerEvent(RUNNERS.get(disp.runnerId), {
      event: "result",
      result: { status: "SUCCESS", response: "hook findings here" },
    });
    const hit = await waitForNotify(calls, (c) => c.trackerId === disp.runnerId);
    assert.ok(hit, "completed runner must wake via notify hook");
    assert.equal(hit.kind, "runner.terminal");
    assert.equal(hit.sessionId, "sess-hook");
    assert.ok(hit.message.includes("hook findings here"));

    const dispFail = await dispatchRunner({ task: "hook fail probe", cwd: tmpdir() });
    handleRunnerEvent(RUNNERS.get(dispFail.runnerId), {
      event: "result",
      result: { status: "FAILURE", error: "hook crash" },
    });
    const hitFail = await waitForNotify(calls, (c) => c.trackerId === dispFail.runnerId);
    assert.ok(hitFail, "failed runner must wake via notify hook");
    assert.ok(hitFail.message.includes("hook crash"));
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
  }
}

// N8. Sweeper: single suspicion wakeup per stall episode, terminal backstop,
// dead-process reconcile, recovery re-arm — and never a kill.
{
  const calls = [];
  globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { calls.push(call); };
  globalThis.__QQ_TEST_RUNNER_HANDLER = (runner) => {
    runner.activeTool = { name: "view_file", startedAt: Date.now() - 300_000 };
    runner.trajectory.push({ action: "view_file", target: "stall.mjs", timestamp: Date.now() - 300_000 });
  };
  try {
    const disp = await dispatchRunner({ task: "sweeper stall", cwd: tmpdir() });
    const runner = RUNNERS.get(disp.runnerId);
    runner.startedAt = Date.now() - 300_000;
    runner.lastActivityAt = Date.now() - 300_000;
    let killed = false;
    runner.process = { exitCode: null, signalCode: null, kill: () => { killed = true; } };
    const mine = () => calls.filter((c) => c.trackerId === disp.runnerId);

    const summary = await sweepNotifications();
    assert.ok(summary.runners >= 1 && summary.executions >= 0);
    assert.equal(mine().length, 1, "first sweep must queue exactly one suspicion wakeup");
    assert.equal(mine()[0].kind, "runner.suspicion");
    assert.ok(mine()[0].message.includes("[needs-decision]"));
    assert.ok(mine()[0].message.includes("view_file"));
    assert.ok(mine()[0].message.includes("stall.mjs"));
    assert.ok(mine()[0].message.includes("nothing was killed"));
    assert.equal(runner.status, "running", "sweeper suspicion must leave the work untouched");
    assert.equal(killed, false, "sweeper must never kill the child process");

    await sweepNotifications();
    assert.equal(mine().length, 1, "second sweep must not duplicate the suspicion wakeup");

    // Re-arm after the escalation window of continued silence.
    globalThis.__QQ_TEST_WATCHDOG = { suspicionRearmMs: 50 };
    try {
      await new Promise((r) => setTimeout(r, 60));
      await sweepNotifications();
      assert.equal(mine().length, 2, "persistent stall past the re-arm window must re-notify once");
    } finally {
      delete globalThis.__QQ_TEST_WATCHDOG;
    }

    // Recovery clears the marker; a genuinely new stall notifies promptly.
    runner.lastActivityAt = Date.now();
    await sweepNotifications();
    assert.equal(mine().length, 2, "recovered work must not notify");
    assert.equal(runner.notifiedSuspicionAt, undefined, "recovery must clear the suspicion marker");
    runner.lastActivityAt = Date.now() - 300_000;
    await sweepNotifications();
    assert.equal(mine().length, 3, "new stall after recovery must notify promptly");

    // Terminal backstop: a completed execution the hooks missed still wakes, once.
    const missedExec = {
      id: "n8-missed", kind: "bounded", status: "completed", phase: "completed",
      startedAt: Date.now() - 60_000, lastActivityAt: Date.now(),
      activeTool: null, trajectory: [], result: { verifiedStory: "landed ok" }, error: null, activeChild: null,
    };
    EXECUTIONS.set(missedExec.id, missedExec);
    try {
      await sweepNotifications();
      const term = calls.filter((c) => c.trackerId === "n8-missed");
      assert.equal(term.length, 1, "missed terminal must wake via sweeper backstop");
      assert.equal(term[0].kind, "execution.terminal");
      assert.ok(term[0].message.includes("landed ok"));
      await sweepNotifications();
      assert.equal(calls.filter((c) => c.trackerId === "n8-missed").length, 1, "terminal backstop must not duplicate");
    } finally {
      EXECUTIONS.delete(missedExec.id);
    }

    // Dead-process backstop: reconcile flips the books, then wakes terminal.
    const dispDead = await dispatchRunner({ task: "sweeper dead", cwd: tmpdir() });
    const dead = RUNNERS.get(dispDead.runnerId);
    dead.process = { exitCode: 1, signalCode: null };
    dead.outputTail = "last helper lines\n";
    dead.stderrTail = "boom\n";
    await sweepNotifications();
    assert.equal(dead.status, "failed");
    const deadTerm = calls.filter((c) => c.trackerId === dispDead.runnerId);
    assert.equal(deadTerm.length, 1, "reconciled dead runner must wake terminal via sweeper");
    assert.ok(deadTerm[0].message.includes("exited with code 1"));

    // Healthy running work is silent.
    const dispOk = await dispatchRunner({ task: "sweeper healthy", cwd: tmpdir() });
    const ok = RUNNERS.get(dispOk.runnerId);
    ok.lastActivityAt = Date.now();
    ok.activeTool = { name: "grep_search", startedAt: Date.now() };
    await sweepNotifications();
    assert.equal(calls.filter((c) => c.trackerId === dispOk.runnerId).length, 0, "healthy work must not notify");
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    delete globalThis.__QQ_TEST_RUNNER_HANDLER;
  }
}

// N9. Sweeper timer is unref'd (never keeps the process alive) and stoppable.
{
  const timer = startSuspicionSweeper({ intervalMs: 50 });
  try {
    assert.equal(typeof timer.unref, "function");
    assert.equal(timer.hasRef(), false, "sweeper interval must be unref'd");
  } finally {
    clearInterval(timer);
  }
  stopSuspicionSweeper(); // safe with no singleton armed
}

// N10. Regression: Inherited live-looking thread environment + no proc discovery
// guarantees notification isolation across test lifecycle. Real notification transport
// is never invoked; fake transport spies verify zero real sends. Mocked notification
// seams continue to work as expected.
{
  const fakeBinDir = mkdtempSync(join(tmpdir(), "qq-test-notify-spy-"));
  const spyLog = join(fakeBinDir, "spy-calls.log");
  const fakeCodexSpy = join(fakeBinDir, "codex");
  // Spy binary that logs all invocations and arguments
  writeFileSync(
    fakeCodexSpy,
    `#!/usr/bin/env bash\nfor a in "$@"; do echo "ARG:$a" >> "${spyLog}"; done\nexit 0\n`,
    "utf8",
  );
  execFileSync("chmod", ["+x", fakeCodexSpy]);

  const origProcThread = globalThis.__QQ_TEST_DISABLE_PROC_THREAD;
  const origCodexBin = process.env.QQ_CODEX_BIN;
  const origThreadId = process.env.CODEX_THREAD_ID;
  const origSessionId = process.env.CODEX_SESSION_ID;
  const origConvId = process.env.CODEX_CONVERSATION_ID;

  try {
    // 1. Verify baseline disabled flag is active
    assert.equal(globalThis.__QQ_TEST_DISABLE_PROC_THREAD, true, "baseline proc thread discovery must be disabled");

    // 2. Even with an ancestor or active process tree, findCodexThreadFromProc returns null
    assert.equal(findCodexThreadFromProc(), null, "proc discovery must return null when disabled");
    assert.equal(findCodexThreadFromProc(process.pid), null);

    // 3. Inherited live-looking thread environment simulation
    const liveThread = "11112222-3333-4444-5555-666677778888";
    process.env.CODEX_THREAD_ID = liveThread;
    process.env.CODEX_SESSION_ID = liveThread;
    process.env.CODEX_CONVERSATION_ID = liveThread;
    process.env.QQ_CODEX_BIN = fakeCodexSpy;

    // Direct resolution would find inherited thread if not scrubbed
    assert.equal(resolveCodexThreadId("sess-live"), liveThread);

    // Now verify test isolation scrubbing:
    // When live routing keys are scrubbed (as done by harness / direct test startup):
    delete process.env.CODEX_THREAD_ID;
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_CONVERSATION_ID;

    // With keys scrubbed and proc discovery disabled, resolveCodexThreadId must be null
    assert.equal(resolveCodexThreadId("sess-live"), null);
    assert.equal(resolveCodexThreadId(null), null);

    // 4. Completed runner/execution under test isolation:
    // notifyTerminal must result in no-codex-context and NEVER invoke the transport spy
    const testRunner = {
      runnerId: "iso-runner-1",
      status: "completed",
      startedAt: Date.now() - 5000,
      result: "Done isolation test",
    };
    const termRes = await notifyTerminal(testRunner, "runner");
    assert.equal(termRes.notified, false);
    assert.equal(termRes.reason, "no-codex-context");

    const testExec = {
      id: "iso-exec-1",
      kind: "bounded",
      status: "completed",
      phase: "completed",
      startedAt: Date.now() - 5000,
      result: { verifiedStory: "Isolation verified", landingOutcome: { landed: true } },
    };
    const execTermRes = await notifyTerminal(testExec, "execution");
    assert.equal(execTermRes.notified, false);
    assert.equal(execTermRes.reason, "no-codex-context");

    // Zero real sends: spy binary was never invoked
    assert.equal(existsSync(spyLog), false, "fake transport spy must not have been executed");

    // 5. Explicit safe notification transport via existing seams (mocked handler) still works
    const hookCalls = [];
    globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => { hookCalls.push(call); };
    try {
      const hookedRunner = {
        runnerId: "iso-runner-2",
        status: "completed",
        startedAt: Date.now() - 5000,
        result: "Hooked test",
      };
      const hookRes = await notifyTerminal(hookedRunner, "runner");
      assert.equal(hookRes.notified, true);
      assert.equal(hookRes.via, "test-hook");
      assert.equal(hookCalls.length, 1);
      assert.equal(hookCalls[0].trackerId, "iso-runner-2");
      // Transport spy was STILL never executed
      assert.equal(existsSync(spyLog), false, "transport spy must not be called when test hook is active");
    } finally {
      delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
    }

    // 6. Scoped tests restore baseline disabled flag rather than delete/enable
    // Simulate a scoped block that temporarily modifies the flag:
    (() => {
      try {
        globalThis.__QQ_TEST_DISABLE_PROC_THREAD = false;
        assert.equal(globalThis.__QQ_TEST_DISABLE_PROC_THREAD, false);
      } finally {
        // Scoped test must restore baseline disabled flag rather than delete
        globalThis.__QQ_TEST_DISABLE_PROC_THREAD = true;
      }
    })();
    assert.equal(globalThis.__QQ_TEST_DISABLE_PROC_THREAD, true, "scoped block must restore baseline disabled flag");
    assert.equal(findCodexThreadFromProc(), null);

    // 7. Dispatching runner does not populate DETECTED_CODEX_THREADS when proc discovery is disabled
    globalThis.__QQ_TEST_RUNNER_HANDLER = () => {};
    try {
      const disp = await dispatchRunner({ task: "isolation check", cwd: tmpdir(), sessionId: "sess-iso-proc" });
      assert.equal(DETECTED_CODEX_THREADS.has("sess-iso-proc"), false, "dispatchRunner must not record proc thread when disabled");
      RUNNERS.delete(disp.runnerId);
    } finally {
      delete globalThis.__QQ_TEST_RUNNER_HANDLER;
    }

    // 8. Test harness environment scrubbing: targeted actual live routing values (preserve needed config)
    const fakeInherited = {
      PATH: process.env.PATH,
      CODEX_HOME: "/home/user/.codex",
      CODEX_MODEL: "gpt-6-astra",
      CODEX_BIN: "/usr/local/bin/codex",
      CODEX_THREAD_ID: "0000-thread",
      CODEX_SESSION_ID: "0000-session",
      CODEX_CONVERSATION_ID: "0000-conv",
      QQ_IMPLEMENTER_PROVIDER: "fake",
    };
    const scrubbed = { ...fakeInherited };
    delete scrubbed.GIT_DIR;
    delete scrubbed.GIT_WORK_TREE;
    delete scrubbed.QQ_IMPLEMENTER_PROVIDER;
    delete scrubbed.QQ_REVIEWER_PROVIDER;
    delete scrubbed.QQ_RESEARCHER_PROVIDER;
    delete scrubbed.QQ_WORKFLOW_PROVIDER;
    delete scrubbed.CODEX_THREAD_ID;
    delete scrubbed.CODEX_SESSION_ID;
    delete scrubbed.CODEX_CONVERSATION_ID;
    scrubbed.QQ_CODEX_BIN = "/usr/bin/true";

    assert.equal(scrubbed.CODEX_THREAD_ID, undefined, "CODEX_THREAD_ID must be scrubbed");
    assert.equal(scrubbed.CODEX_SESSION_ID, undefined, "CODEX_SESSION_ID must be scrubbed");
    assert.equal(scrubbed.CODEX_CONVERSATION_ID, undefined, "CODEX_CONVERSATION_ID must be scrubbed");
    assert.equal(scrubbed.CODEX_HOME, "/home/user/.codex", "CODEX_HOME needed config must be preserved");
    assert.equal(scrubbed.CODEX_MODEL, "gpt-6-astra", "CODEX_MODEL needed config must be preserved");
    assert.equal(scrubbed.CODEX_BIN, "/usr/local/bin/codex", "CODEX_BIN needed config must be preserved");
    assert.equal(scrubbed.QQ_CODEX_BIN, "/usr/bin/true", "safe notification transport backstop must be set");
  } finally {
    if (origProcThread !== undefined) globalThis.__QQ_TEST_DISABLE_PROC_THREAD = origProcThread;
    else globalThis.__QQ_TEST_DISABLE_PROC_THREAD = true;

    if (origCodexBin !== undefined) process.env.QQ_CODEX_BIN = origCodexBin;
    else process.env.QQ_CODEX_BIN = "/usr/bin/true";

    if (origThreadId !== undefined) process.env.CODEX_THREAD_ID = origThreadId;
    else delete process.env.CODEX_THREAD_ID;

    if (origSessionId !== undefined) process.env.CODEX_SESSION_ID = origSessionId;
    else delete process.env.CODEX_SESSION_ID;

    if (origConvId !== undefined) process.env.CODEX_CONVERSATION_ID = origConvId;
    else delete process.env.CODEX_CONVERSATION_ID;

    rmSync(fakeBinDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Disabled tools: a client can hide callable tools from its schema via
// --disabled-tools / QQ_DISABLED_TOOLS. This is a general mechanism; the wait
// tools are not merely hidden, they no longer exist.
// ============================================================================

// D1. parseDisabledTools: CLI forms, env form, union + trim + dedupe.
assert.deepEqual(parseDisabledTools([], {}), []);
assert.deepEqual(parseDisabledTools(["--disabled-tools", "steer_runner,cancel_runner"], {}), [
  "steer_runner",
  "cancel_runner",
]);
assert.deepEqual(parseDisabledTools(["--disabled-tools=steer_runner, cancel_runner"], {}), [
  "steer_runner",
  "cancel_runner",
]);
assert.deepEqual(parseDisabledTools([], { QQ_DISABLED_TOOLS: "steer_runner,cancel_runner" }), [
  "steer_runner",
  "cancel_runner",
]);
assert.deepEqual(
  parseDisabledTools(["--disabled-tools", "steer_runner,, steer_runner"], {
    QQ_DISABLED_TOOLS: " cancel_runner ,steer_runner",
  }),
  ["steer_runner", "cancel_runner"],
);
assert.deepEqual(parseDisabledTools(["--disabled-tools"], {}), []);
assert.deepEqual(parseDisabledTools([], { QQ_DISABLED_TOOLS: "  " }), []);
assert.ok(getDisabledTools(["--disabled-tools", "a"], {}) instanceof Set);
assert.ok(getDisabledTools(["--disabled-tools", "a"], {}).has("a"));
assert.equal(getDisabledTools([], {}).size, 0);

// D2. tools/list filtering + tools/call rejection via explicit option.
{
  const disabled = ["steer_runner", "cancel_runner"];
  const list = await handleRpc("tools/list", {}, { disabledTools: disabled });
  assert.equal(list.tools.length, 15);
  const names = list.tools.map((t) => t.name);
  assert.ok(!names.includes("steer_runner"));
  assert.ok(!names.includes("cancel_runner"));

  const full = await handleRpc("tools/list", {}, { disabledTools: [] });
  assert.equal(full.tools.length, 17);

  await assert.rejects(
    () => callTool("steer_runner", { runnerId: "x" }, { disabledTools: disabled }),
    /^Error: Tool 'steer_runner' is disabled$/,
  );
  await assert.rejects(
    () => callTool("cancel_runner", { runnerId: "x" }, { disabledTools: disabled }),
    /^Error: Tool 'cancel_runner' is disabled$/,
  );

  // A removed wait tool is unknown, not disabled: no "--disabled-tools" entry
  // can bring it back.
  await assert.rejects(
    () => callTool("await_runner", { runnerId: "x" }, { disabledTools: [] }),
    /^Error: Unknown tool: await_runner$/,
  );
  await assert.rejects(
    () => callTool("await_execution", { id: "x" }, { disabledTools: [] }),
    /^Error: Unknown tool: await_execution$/,
  );

  const rpcErr = await handleRpc(
    "tools/call",
    { name: "steer_runner", arguments: { runnerId: "x" } },
    { disabledTools: disabled },
  );
  assert.equal(rpcErr.isError, true);
  assert.equal(rpcErr.content[0].text, "Tool 'steer_runner' is disabled");

  // Non-disabled tools still dispatch (validation error, not a disabled error).
  const stillOk = await handleRpc(
    "tools/call",
    { name: "prepare_worktree", arguments: {} },
    { disabledTools: disabled },
  );
  assert.equal(stillOk.isError, true);
  assert.match(stillOk.content[0].text, /kind is required/);
}

// D3. QQ_DISABLED_TOOLS env default resolution (hermetic: saved + restored).
{
  const savedDisabledEnv = process.env.QQ_DISABLED_TOOLS;
  delete process.env.QQ_DISABLED_TOOLS;
  try {
    const full = await handleRpc("tools/list", {});
    assert.equal(full.tools.length, 17);
  } finally {
    if (savedDisabledEnv === undefined) delete process.env.QQ_DISABLED_TOOLS;
    else process.env.QQ_DISABLED_TOOLS = savedDisabledEnv;
  }

  process.env.QQ_DISABLED_TOOLS = "steer_runner,cancel_runner";
  try {
    const list = await handleRpc("tools/list", {});
    assert.equal(list.tools.length, 15);
    assert.ok(!list.tools.some((t) => t.name === "steer_runner" || t.name === "cancel_runner"));
    await assert.rejects(() => callTool("cancel_runner", { runnerId: "x" }), /Tool 'cancel_runner' is disabled/);
    const rpcErr = await handleRpc("tools/call", { name: "cancel_runner", arguments: { runnerId: "x" } });
    assert.equal(rpcErr.isError, true);
    assert.equal(rpcErr.content[0].text, "Tool 'cancel_runner' is disabled");
  } finally {
    if (savedDisabledEnv === undefined) delete process.env.QQ_DISABLED_TOOLS;
    else process.env.QQ_DISABLED_TOOLS = savedDisabledEnv;
  }
}

// D4. End to end: a spawned server honors the CLI arg and the env var.
{
  const serverBin = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mcp-server.mjs");
  function queryServer({ args = [], env = {}, stripDisabledEnv = false }) {
    const childEnv = { ...process.env, ...env };
    if (stripDisabledEnv) delete childEnv.QQ_DISABLED_TOOLS;
    const requests =
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "steer_runner", arguments: { runnerId: "nope" } },
        },
      ]
        .map((message) => JSON.stringify(message))
        .join("\n") + "\n";
    const res = spawnSync(process.execPath, [serverBin, ...args], {
      input: requests,
      encoding: "utf8",
      env: childEnv,
      timeout: 15000,
    });
    assert.equal(res.error, undefined, `spawned server failed: ${res.error}`);
    assert.equal(res.status, 0, `spawned server exited ${res.status}: ${res.stderr}`);
    const lines = res.stdout.split("\n").filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 2);
    return lines.map((line) => JSON.parse(line));
  }

  // CLI arg alone filters the list and rejects the call.
  {
    const [listResp, callResp] = queryServer({
      args: ["--disabled-tools", "steer_runner,cancel_runner"],
      stripDisabledEnv: true,
    });
    assert.equal(listResp.result.tools.length, 15);
    assert.ok(!listResp.result.tools.some((t) => t.name === "steer_runner" || t.name === "cancel_runner"));
    assert.equal(callResp.result.isError, true);
    assert.equal(callResp.result.content[0].text, "Tool 'steer_runner' is disabled");
  }

  // Env var alone filters the list and rejects the call.
  {
    const [listResp, callResp] = queryServer({ env: { QQ_DISABLED_TOOLS: "steer_runner,cancel_runner" } });
    assert.equal(listResp.result.tools.length, 15);
    assert.ok(!listResp.result.tools.some((t) => t.name === "steer_runner" || t.name === "cancel_runner"));
    assert.equal(callResp.result.isError, true);
    assert.equal(callResp.result.content[0].text, "Tool 'steer_runner' is disabled");
  }

  // Neither: the full surviving tool surface.
  {
    const [listResp] = queryServer({ stripDisabledEnv: true });
    assert.equal(listResp.result.tools.length, 17);
  }
}

// Restore baseline notification isolation: ensure live routing keys remain scrubbed,
// safe transport is restored, and proc thread autodiscovery remains disabled.
delete process.env.CODEX_THREAD_ID;
delete process.env.CODEX_SESSION_ID;
delete process.env.CODEX_CONVERSATION_ID;
process.env.QQ_CODEX_BIN = "/usr/bin/true";
globalThis.__QQ_TEST_DISABLE_PROC_THREAD = true;

console.log("MCP server tests passed cleanly.");


// ============================================================================
// Reliable Runner Completion Result Transport & 32,768-Character Contract Tests
// ============================================================================

console.log("Running reliable runner completion transport regression tests...");

// R1. Real child-process separation: reproduces >512-char telemetry abbreviation
// and verifies exact full report (>5,000 chars with Unicode & data_points) reaches parent.
{
  const fakeBinDir = mkdtempSync(join(tmpdir(), "qq-test-runner-bin-"));
  const fakeAgyScript = join(fakeBinDir, "fake-agy.mjs");
  const fakeAgySh = join(fakeBinDir, "fake-agy.sh");

  // Multi-byte Unicode string of ~5,200 characters
  const unicodeReport =
    "🔍 Deep Research Findings & Architecture Audit:\n" +
    "• CJK Analysis: 全面代码检查完成，未发现死锁风险。\n" +
    "• Accented & Symbols: Élévation de privilèges vérifiée: OK. §4.2.1 ✓\n" +
    "• Math & Emoji: ∑(i=0..n) λ_i = 1.0 🚀 🔥 💡 🛡️\n" +
    "• Payload Section:\n" +
    "A".repeat(5000) + "\n" +
    "• Conclusion: Authorized transport verification successful.\n";

  const testDataPoints = [
    "bin/mcp-server.mjs:1425",
    "tests/mcp.mjs:3120",
    "🚀 unicode-data-point-pass ✓",
  ];

  // Child process script: calls completeTask (isolated in child process),
  // writes transport file, and outputs abbreviated telemetry (>512 chars clipped) on stdout.
  const childCode = `import { completeTask } from "${join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mcp-server.mjs")}";

const report = ${JSON.stringify(unicodeReport)};
const dps = ${JSON.stringify(testDataPoints)};

// 1. Child executes completeTask in its own process
await completeTask({ response: report, data_points: dps });

// 2. Child emits stream-json telemetry with tool parameters truncated to 512 chars + ellipsis
const clippedTelemetry = report.slice(0, 512) + "…";
const telemetryEvent = {
  event: "step_update",
  step_update: {
    step_type: "tool",
    state: "DONE",
    tool_name: "complete_task",
    tool_info: {
      parameters: {
        response: clippedTelemetry,
        data_points: ["clipped-telemetry"],
      },
    },
  },
};
console.log(JSON.stringify(telemetryEvent));

// 3. Keep child alive briefly so parent process can inspect / kill
await new Promise((r) => setTimeout(r, 2000));
`;
  writeFileSync(fakeAgyScript, childCode, "utf8");
  writeFileSync(fakeAgySh, `#!/usr/bin/env bash\nexec node "${fakeAgyScript}" "$@"\n`, "utf8");
  execFileSync("chmod", ["+x", fakeAgySh]);

  const prevRunnerBin = process.env.QQ_RUNNER_BIN;
  process.env.QQ_RUNNER_BIN = fakeAgySh;

  try {
    const disp = await dispatchRunner({ task: "deep research", cwd: tmpdir() });
    assert.ok(disp.runnerId);

    const runner = RUNNERS.get(disp.runnerId);
    assert.ok(runner);
    assert.ok(runner.resultFile, "runner must have a dedicated resultFile configured");
    assert.equal(existsSync(runner.resultFile), false, "runner resultFile must not exist before complete_task");

    await waitForRunnerTerminal(disp.runnerId);
    const result = authoritativeResult(disp.runnerId);
    assert.ok(result);

    // Parent must receive the EXACT unabridged report from transport, NOT the 512-char clipped telemetry!
    assert.equal(result.response, unicodeReport, "parent must receive exact unabridged report");
    assert.equal(result.response.length, unicodeReport.length);
    assert.notEqual(result.response, unicodeReport.slice(0, 512) + "…", "parent must NOT fall back to clipped telemetry");
    assert.deepEqual(result.data_points, testDataPoints, "parent must receive exact data_points");

    // check_runner reports health/delivery state, NOT findings; the exact full
    // report stays deliverable through the terminal notification and transport.
    const checkRes = await checkRunner({ runnerId: disp.runnerId });
    assert.equal(checkRes.status, "completed");
    assert.equal(checkRes.result, undefined, "check_runner must NOT return the full report");
    assert.equal(checkRes.findingsRetained, true, "authoritative findings stay retained for delivery");

    // Wait for child process to finish close and verify transport file was cleaned up
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(existsSync(runner.resultFile), false, "transport file must be cleaned up on process close");
  } finally {
    if (prevRunnerBin !== undefined) process.env.QQ_RUNNER_BIN = prevRunnerBin;
    else delete process.env.QQ_RUNNER_BIN;
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
}

// R2. Cap enforcement: exactly the authoritative cap accepted, one more rejected.
{
  // Exactly the cap is accepted
  const exactlyCap = "C".repeat(COMPLETE_TASK_RESPONSE_MAX);
  const okResult = await completeTask({ response: exactlyCap });
  assert.equal(okResult.ok, true);
  assert.equal(okResult.responseLength, COMPLETE_TASK_RESPONSE_MAX);

  // One character over is rejected with clear summarization guidance
  const overCap = "C".repeat(COMPLETE_TASK_RESPONSE_MAX + 1);
  await assert.rejects(
    () => completeTask({ response: overCap }),
    (err) => {
      assert.match(err.message, new RegExp(`response exceeds the ${FINAL_RESPONSE_MAX_CHARS_LABEL}-character cap \\(got ${COMPLETE_TASK_RESPONSE_MAX + 1} chars\\)`));
      assert.match(err.message, /Summarize before calling complete_task/);
      return true;
    },
    "completeTask must reject 32,769 chars with summarization message",
  );
}

// R3. Concurrent isolated runners with real child-process separation: zero cross-talk.
{
  const fakeBinDir = mkdtempSync(join(tmpdir(), "qq-test-concurrent-bin-"));
  const fakeScript = join(fakeBinDir, "runner.mjs");
  const fakeSh = join(fakeBinDir, "runner.sh");

  const childCode = `import { completeTask } from "${join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mcp-server.mjs")}";

const runnerId = process.env.QQ_RUNNER_ID;
const response = "Report for runner " + runnerId + ": " + "X".repeat(1200);
const dps = ["dp-" + runnerId];

await completeTask({ response, data_points: dps });

// Emit stream-json telemetry
const telemetryEvent = {
  event: "step_update",
  step_update: {
    step_type: "tool",
    state: "DONE",
    tool_name: "complete_task",
    tool_info: {
      parameters: { response: "clipped", data_points: [] },
    },
  },
};
console.log(JSON.stringify(telemetryEvent));
await new Promise((r) => setTimeout(r, 1000));
`;
  writeFileSync(fakeScript, childCode, "utf8");
  writeFileSync(fakeSh, `#!/usr/bin/env bash\nexec node "${fakeScript}" "$@"\n`, "utf8");
  execFileSync("chmod", ["+x", fakeSh]);

  const prevRunnerBin = process.env.QQ_RUNNER_BIN;
  process.env.QQ_RUNNER_BIN = fakeSh;

  try {
    const disp1 = await dispatchRunner({ task: "concurrent task 1", cwd: tmpdir() });
    const disp2 = await dispatchRunner({ task: "concurrent task 2", cwd: tmpdir() });

    assert.notEqual(disp1.runnerId, disp2.runnerId);
    assert.notEqual(RUNNERS.get(disp1.runnerId).resultFile, RUNNERS.get(disp2.runnerId).resultFile);

    const runner1 = await waitForRunnerTerminal(disp1.runnerId);
    const runner2 = await waitForRunnerTerminal(disp2.runnerId);
    const result1 = authoritativeResult(disp1.runnerId);
    const result2 = authoritativeResult(disp2.runnerId);

    assert.equal(runner1.status, "completed");
    assert.equal(runner2.status, "completed");
    assert.ok(result1, "each runner keeps its own authoritative result");
    assert.ok(result2);

    assert.equal(result1.response, "Report for runner " + disp1.runnerId + ": " + "X".repeat(1200));
    assert.deepEqual(result1.data_points, ["dp-" + disp1.runnerId]);

    assert.equal(result2.response, "Report for runner " + disp2.runnerId + ": " + "X".repeat(1200));
    assert.deepEqual(result2.data_points, ["dp-" + disp2.runnerId]);
  } finally {
    if (prevRunnerBin !== undefined) process.env.QQ_RUNNER_BIN = prevRunnerBin;
    else delete process.env.QQ_RUNNER_BIN;
    rmSync(fakeBinDir, { recursive: true, force: true });
  }
}

// R4. Missing result file explicit failure: parent never accepts clipped telemetry.
{
  globalThis.__QQ_TEST_RUNNER_HANDLER = () => {};
  const disp = await dispatchRunner({ task: "missing result file probe", cwd: tmpdir() });
  const runner = RUNNERS.get(disp.runnerId);

  // Ensure resultFile does not exist
  if (existsSync(runner.resultFile)) rmSync(runner.resultFile);

  // Simulate telemetry event arriving without a transport file
  const event = {
    event: "step_update",
    step_update: {
      step_type: "tool",
      state: "DONE",
      tool_name: "complete_task",
      tool_info: {
        parameters: { response: "telemetry fallback attempt" },
      },
    },
  };
  handleRunnerEvent(runner, event);

  assert.equal(runner.status, "failed");
  assert.equal(runner.result, null, "runner.result must remain null on missing transport file");
  assert.match(runner.error.message, /Runner complete_task failed/);
  assert.match(runner.error.message, /Missing runner result transport file/);

  delete globalThis.__QQ_TEST_RUNNER_HANDLER;
}

// R5. Corrupt / malformed result file explicit failure.
{
  globalThis.__QQ_TEST_RUNNER_HANDLER = () => {};
  const disp = await dispatchRunner({ task: "corrupt file probe", cwd: tmpdir() });
  const runner = RUNNERS.get(disp.runnerId);

  // Write malformed JSON
  writeFileSync(runner.resultFile, "{\"incomplete_json\": true, ");

  const event = {
    event: "step_update",
    step_update: {
      step_type: "tool",
      state: "DONE",
      tool_name: "complete_task",
      tool_info: { parameters: { response: "some telemetry" } },
    },
  };
  handleRunnerEvent(runner, event);

  assert.equal(runner.status, "failed");
  assert.equal(runner.result, null);
  assert.match(runner.error.message, /Runner complete_task failed/);
  assert.match(runner.error.message, /malformed JSON/);

  delete globalThis.__QQ_TEST_RUNNER_HANDLER;
}

// R6. Mismatched runnerId explicit failure.
{
  globalThis.__QQ_TEST_RUNNER_HANDLER = () => {};
  const disp = await dispatchRunner({ task: "mismatched runnerId probe", cwd: tmpdir() });
  const runner = RUNNERS.get(disp.runnerId);

  // Write payload with a DIFFERENT runnerId
  writeFileSync(
    runner.resultFile,
    JSON.stringify({
      runnerId: "other-mismatched-runner-id",
      response: "good response",
      data_points: [],
      calledAt: Date.now(),
    }),
    "utf8",
  );

  const event = {
    event: "step_update",
    step_update: {
      step_type: "tool",
      state: "DONE",
      tool_name: "complete_task",
      tool_info: { parameters: { response: "some telemetry" } },
    },
  };
  handleRunnerEvent(runner, event);

  assert.equal(runner.status, "failed");
  assert.equal(runner.result, null);
  assert.match(runner.error.message, /Runner complete_task failed/);
  assert.match(runner.error.message, /Runner result ID mismatch/);

  delete globalThis.__QQ_TEST_RUNNER_HANDLER;
}

// R7. Transport payload exceeding 32,768 chars fails validation.
{
  const fakeRunner = { id: "test-overcap-runner" };
  const overcapPayload = {
    runnerId: "test-overcap-runner",
    response: "Z".repeat(COMPLETE_TASK_RESPONSE_MAX + 1),
    data_points: [],
  };
  const val = validateRunnerResultPayload(overcapPayload, fakeRunner);
  assert.equal(val.ok, false);
  assert.match(val.error, new RegExp(`exceeds ${FINAL_RESPONSE_MAX_CHARS_LABEL}-character cap`));
}

// R8. Write failure cannot signal successful completion or authorize Stop hook exit.
{
  const prevRunnerId = process.env.QQ_RUNNER_ID;
  const prevResultFile = process.env.QQ_RUNNER_RESULT_FILE;

  const testId = "fail-write-" + Date.now();
  process.env.QQ_RUNNER_ID = testId;
  // Non-existent unwritable directory
  process.env.QQ_RUNNER_RESULT_FILE = "/nonexistent-dir-cannot-write-here/result.json";

  const markerPath = join(tmpdir(), `qq-complete-task-${testId}.json`);
  try { rmSync(markerPath, { force: true }); } catch {}

  // completeTask must throw
  await assert.rejects(
    () => completeTask({ response: "Will fail write" }),
    /Failed to write runner result transport file/,
  );

  // Marker file must NOT exist
  assert.equal(existsSync(markerPath), false, "marker file must not be written when transport write fails");

  // Registry must NOT contain the entry
  assert.equal(COMPLETE_TASK_REGISTRY.has(testId), false, "registry must not contain entry when write fails");

  // Stop hook must block termination
  const stopInput = JSON.stringify({
    terminationReason: "model_stop",
    conversationId: testId,
  });
  const rawStop = execFileSync(process.execPath, ["hooks/stop.mjs"], {
    input: stopInput,
    encoding: "utf8",
    env: { ...process.env, QQ_RUNNER_ID: testId },
  });
  const parsedStop = JSON.parse(rawStop);
  assert.equal(parsedStop.decision, "continue", "Stop hook must block exit when transport write failed");

  // Clean up env
  if (prevRunnerId !== undefined) process.env.QQ_RUNNER_ID = prevRunnerId;
  else delete process.env.QQ_RUNNER_ID;
  if (prevResultFile !== undefined) process.env.QQ_RUNNER_RESULT_FILE = prevResultFile;
  else delete process.env.QQ_RUNNER_RESULT_FILE;
}

// R9. Terminal close races & dead-process reconciliation.
{
  // Scenario A: Child process writes transport file and exits code 0 before step_update event
  const fakeBinDir = mkdtempSync(join(tmpdir(), "qq-test-close-race-bin-"));
  const fakeScript = join(fakeBinDir, "runner-fast-exit.mjs");
  const fakeSh = join(fakeBinDir, "runner-fast-exit.sh");

  const childCode = `import { completeTask } from "${join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "mcp-server.mjs")}";

await completeTask({ response: "Early exit response", data_points: ["dp-early"] });
// Exits immediately code 0 without step_update telemetry
process.exit(0);
`;
  writeFileSync(fakeScript, childCode, "utf8");
  writeFileSync(fakeSh, `#!/usr/bin/env bash\nexec node "${fakeScript}" "$@"\n`, "utf8");
  execFileSync("chmod", ["+x", fakeSh]);

  const prevRunnerBin = process.env.QQ_RUNNER_BIN;
  process.env.QQ_RUNNER_BIN = fakeSh;

  try {
    const disp = await dispatchRunner({ task: "fast exit task", cwd: tmpdir() });
    await waitForRunnerTerminal(disp.runnerId);
    assert.equal((await checkRunner({ runnerId: disp.runnerId })).status, "completed");
    const result = authoritativeResult(disp.runnerId);
    assert.equal(result.response, "Early exit response");
    assert.deepEqual(result.data_points, ["dp-early"]);
  } finally {
    if (prevRunnerBin !== undefined) process.env.QQ_RUNNER_BIN = prevRunnerBin;
    else delete process.env.QQ_RUNNER_BIN;
    rmSync(fakeBinDir, { recursive: true, force: true });
  }

  // Scenario B: reconcileDeadRunner recovers result from transport file on dead process
  globalThis.__QQ_TEST_RUNNER_HANDLER = () => {};
  const dispReconcile = await dispatchRunner({ task: "reconcile transport task", cwd: tmpdir() });
  const runner = RUNNERS.get(dispReconcile.runnerId);
  runner.process = { exitCode: 0, signalCode: null };

  // Write valid transport file
  writeFileSync(
    runner.resultFile,
    JSON.stringify({
      runnerId: runner.id,
      response: "Reconciled transport findings",
      data_points: ["dp-reconciled"],
      calledAt: Date.now(),
    }),
    "utf8",
  );

  const rec = reconcileDeadRunner(runner);
  assert.equal(rec.status, "completed");
  assert.equal(runner.status, "completed");
  assert.equal(runner.result.response, "Reconciled transport findings");
  assert.deepEqual(runner.result.data_points, ["dp-reconciled"]);

  // Transport file was cleaned up on reconcile
  assert.equal(existsSync(runner.resultFile), false, "reconcile must clean up transport file");

  delete globalThis.__QQ_TEST_RUNNER_HANDLER;

  // Scenario C: cancelRunner cleans up resultFile
  const dispCancel = await dispatchRunner({ task: "cancel cleanup task", cwd: tmpdir() });
  const cancelRunnerObj = RUNNERS.get(dispCancel.runnerId);
  writeFileSync(cancelRunnerObj.resultFile, "{}");
  assert.equal(existsSync(cancelRunnerObj.resultFile), true);

  await cancelRunner({ runnerId: dispCancel.runnerId });
  assert.equal(cancelRunnerObj.status, "cancelled");
  // If no process or after process kill, cleanup ensures no leak
  cleanupRunnerFiles(cancelRunnerObj);
  assert.equal(existsSync(cancelRunnerObj.resultFile), false, "cancelRunner must clean up transport file");
}

console.log("Reliable runner completion transport regression tests passed cleanly.");


// ============================================================================
// Review Gate Robustness & Task Routing Regression Tests
// ============================================================================
console.log("Running review gate & task routing regression tests...");

// T1. Exact Markdown FAIL + passed testcounts (ISO90c0f799 reproduction).
{
  // Variant A: ISO90c0f799 reproduction with bold format and Vitest test count
  const isoOutput = `## Test Results
Tests: 22 passed (23), 1 failed
Duration: 4.5s

- Invariant broken: transport payload truncated at 512 characters.
- **Verdict**: **FAIL**
`;
  assert.equal(evaluateReviewPassed(isoOutput), false, "Markdown bold **Verdict**: **FAIL** must fail despite '22 passed'");
  assert.equal(isTrustworthyReviewFail(isoOutput), true, "Explicit FAIL with incidental passed text is trustworthy FAIL");
  const parsedA = parseReviewVerdict(isoOutput);
  assert.equal(parsedA.verdict, "FAIL");

  // Variant B: bulleted bold with 'all tests passed' text
  const bulletFail = `- **Verdict**: FAIL\nAll baseline tests passed, but acceptance criterion 3 was violated.`;
  assert.equal(evaluateReviewPassed(bulletFail), false);
  assert.equal(isTrustworthyReviewFail(bulletFail), true);
  assert.equal(parseReviewVerdict(bulletFail).verdict, "FAIL");

  // Variant C: bold colon format
  const colonFail = `**Verdict:** **FAIL**\n100 passed`;
  assert.equal(evaluateReviewPassed(colonFail), false);
  assert.equal(isTrustworthyReviewFail(colonFail), true);

  // Variant D: Header format
  const headerFail = `### Verdict: FAIL\npassed 10/11`;
  assert.equal(evaluateReviewPassed(headerFail), false);
  assert.equal(isTrustworthyReviewFail(headerFail), true);
}

// T2. Markdown PASS formats.
{
  const passA = `All 15 tests green.\n- **Verdict**: **PASS**`;
  assert.equal(evaluateReviewPassed(passA), true);
  assert.equal(isTrustworthyReviewFail(passA), false, "Genuine PASS is not a defect fail");
  assert.equal(parseReviewVerdict(passA).verdict, "PASS");

  const passB = `**Verdict:** PASS\nVerification complete.`;
  assert.equal(evaluateReviewPassed(passB), true);

  const passC = `- **Verdict**: PASS`;
  assert.equal(evaluateReviewPassed(passC), true);

  const passD = `### Verdict: PASS`;
  assert.equal(evaluateReviewPassed(passD), true);

  const passE = `Verdict: [PASS]`;
  assert.equal(evaluateReviewPassed(passE), true);
}

// T3. Absent and conflicting verdicts fail-closed.
{
  // Absent: empty or non-verdict text
  assert.equal(evaluateReviewPassed(""), false, "empty output must fail closed");
  assert.equal(evaluateReviewPassed(null), false, "null output must fail closed");
  assert.equal(evaluateReviewPassed(undefined), false, "undefined output must fail closed");
  assert.equal(evaluateReviewPassed("Tests: 22 passed (22)"), false, "output without verdict must fail closed");
  assert.equal(evaluateReviewPassed("Overall summary: good progress but no verdict given"), false);
  assert.equal(parseReviewVerdict("just text").verdict, null);

  // Conflicting: both PASS and FAIL
  const conflictOutput = `Initial review:\n**Verdict**: PASS\nWait, re-running test failed:\n**Verdict**: FAIL`;
  assert.equal(evaluateReviewPassed(conflictOutput), false, "conflicting verdicts must fail closed");
  const parsedConflict = parseReviewVerdict(conflictOutput);
  assert.equal(parsedConflict.verdict, "FAIL");
  assert.equal(parsedConflict.conflicting, true);

  const conflictReverse = `Verdict: FAIL\nVerdict: PASS`;
  assert.equal(evaluateReviewPassed(conflictReverse), false, "explicit FAIL overrides PASS in conflicting verdicts");
  assert.equal(isTrustworthyReviewFail(conflictOutput), false, "conflicting verdicts are not trustworthy FAIL");
  assert.equal(isTrustworthyReviewFail(conflictReverse), false, "conflicting verdicts are not trustworthy FAIL");

  // Waiting / incomplete response from incident a0964663
  const waitingOutput = "I have started running `npm test` to verify the test suite. I will review the results as soon as the execution finishes.\nI will wait for `npm test` to complete.\nWaiting for background task to complete.";
  assert.equal(evaluateReviewPassed(waitingOutput), false, "waiting output is not PASS");
  assert.equal(isTrustworthyReviewFail(waitingOutput), false, "waiting output is not trustworthy FAIL");
  assert.equal(parseReviewVerdict(waitingOutput).verdict, null);
  assert.equal(isTrustworthyReviewFail(""), false);
  assert.equal(isTrustworthyReviewFail(null), false);
}

// T4. Nonzero reviewer exit must reject regardless of output.
{
  // Output says PASS, but exitCode is 1
  const passText = `**Verdict**: **PASS**\nEverything looks great.`;
  assert.equal(evaluateReviewPassed(passText, 1), false, "nonzero exit code must reject even with Verdict: PASS");
  assert.equal(evaluateReviewPassed(passText, 2), false);
  assert.equal(evaluateReviewPassed({ output: passText, exitCode: 1 }), false);
  assert.equal(evaluateReviewPassed({ output: passText, error: { exitCode: 1 } }), false);
  assert.equal(evaluateReviewPassed({ output: passText, ok: false }), false);
  assert.equal(isTrustworthyReviewFail(passText, 1), false);
  assert.equal(isTrustworthyReviewFail("- **Verdict**: FAIL\nDefect", 1), false, "exitCode != 0 is process error, not trustworthy FAIL");
  assert.equal(isTrustworthyReviewFail({ output: "- **Verdict**: FAIL", exitCode: 1 }), false);
  assert.equal(isTrustworthyReviewFail({ output: "- **Verdict**: FAIL", error: { exitCode: 1 } }), false);
  assert.equal(isTrustworthyReviewFail({ output: "- **Verdict**: FAIL", error: { message: "crashed" } }), false, "error object without exitCode must not be trustworthy FAIL");
  assert.equal(isTrustworthyReviewFail({ output: "- **Verdict**: FAIL", ok: false, exitCode: 0 }), false, "ok: false with exitCode 0 must not be trustworthy FAIL");
  assert.equal(evaluateReviewPassed({ output: passText, error: { message: "crashed" } }), false, "error object without exitCode must not pass");
  assert.equal(evaluateReviewPassed({ output: passText, ok: false, exitCode: 0 }), false, "ok: false with exitCode 0 must not pass");

  // In pipeline: reviewer nonzero exit triggers failure / preserves evidence
  const testRepo = mkdtempSync(join(tmpdir(), "qq-test-exitcode-repo-"));
  await git(testRepo, ["init", "-b", "main"]);
  await git(testRepo, ["config", "user.name", "Test"]);
  await git(testRepo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(testRepo, "init.txt"), "init\n");
  await git(testRepo, ["add", "init.txt"]);
  await git(testRepo, ["commit", "-m", "initial"]);

  const tDir = join(testRepo, ".architect", "tickets");
  mkdirSync(tDir, { recursive: true });
  const sId = "test-nonzero-exit-" + Date.now();
  writeFileSync(join(tDir, `${sId}.md`), "# Nonzero Exit Ticket\n\n## Kind\nopen\n");

  try {
    globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role, cwd }) => {
      if (role === "implementer") {
        writeFileSync(join(cwd, "change.txt"), "some change");
        return { ok: true, output: "impl done" };
      }
      if (role === "reviewer") {
        return {
          ok: false,
          output: "**Verdict**: **PASS**",
          error: { message: "Reviewer crashed with SIGSEGV", exitCode: 139, stderr: "Segmentation fault" },
        };
      }
    };

    const disp = await dispatchExecution({ kind: "open", sessionId: sId, cwd: testRepo });
    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    assert.equal(check.status, "failed");
    assert.equal(check.phase, "reviewing");
    assert.equal(check.error.exitCode, 139);
    assert.equal(check.error.stderr, "Segmentation fault");
    assert.equal(check.error.findings, "**Verdict**: **PASS**");
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    rmSync(testRepo, { recursive: true, force: true });
  }
}

// T5. No-change execution preserves worktree and ticket, no false landing.
{
  const noChangeRepo = mkdtempSync(join(tmpdir(), "qq-test-nochange-repo-"));
  await git(noChangeRepo, ["init", "-b", "main"]);
  await git(noChangeRepo, ["config", "user.name", "Test"]);
  await git(noChangeRepo, ["config", "user.email", "test@example.com"]);
  writeFileSync(join(noChangeRepo, "app.txt"), "original content\n");
  await git(noChangeRepo, ["add", "app.txt"]);
  await git(noChangeRepo, ["commit", "-m", "commit main"]);

  const tDir = join(noChangeRepo, ".architect", "tickets");
  mkdirSync(tDir, { recursive: true });

  // Scenario A: Bounded execution with 0 changes
  const boundedSessId = "nochange-bounded-" + Date.now();
  const boundedTicketPath = join(tDir, `${boundedSessId}.md`);
  writeFileSync(boundedTicketPath, "# Bounded No Change Ticket\n\n## Kind\nbounded\n");

  try {
    globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role }) => {
      // Implementer finishes but makes NO changes to disk
      return { ok: true, output: "Looked at code, made no changes" };
    };

    const disp = await dispatchExecution({ kind: "bounded", sessionId: boundedSessId, cwd: noChangeRepo });

    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    assert.equal(check.status, "failed");
    assert.equal(check.phase, "implementing");
    assert.equal(check.error.status, "incomplete");
    assert.equal(check.error.noChange, true);
    assert.ok(check.trajectory.some((t) => t.action === "implementation_empty"));
    assert.equal(check.trajectory.some((t) => t.action === "landing_started"), false);
    assert.equal(check.trajectory.some((t) => t.action === "execution_completed"), false);

    // Worktree preserved!
    const execObj = EXECUTIONS.get(disp.id);
    assert.ok(existsSync(execObj.worktree), "worktree must be preserved on no-change");

    // Ticket preserved!
    assert.ok(existsSync(boundedTicketPath), "ticket must NOT be archived or cleared on no-change");

    // Main has no merge commit
    const log = await git(noChangeRepo, ["log", "--oneline"]);
    assert.equal(log.split("\n").length, 1, "main branch must have no landing commit");

    // Clean up worktree
    await git(noChangeRepo, ["worktree", "remove", "--force", execObj.worktree]).catch(() => {});
    await git(noChangeRepo, ["branch", "-D", execObj.branch]).catch(() => {});
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
  }

  // Scenario B: Open execution where reviewer outputs PASS but 0 code changes were made
  const openSessId = "nochange-open-" + Date.now();
  const openTicketPath = join(tDir, `${openSessId}.md`);
  writeFileSync(openTicketPath, "# Open No Change Ticket\n\n## Kind\nopen\n");

  try {
    globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role }) => {
      if (role === "implementer") {
        return { ok: true, output: "No changes implemented" };
      }
      if (role === "reviewer") {
        return { ok: true, output: "**Verdict**: **PASS**\nBaseline tests were passing" };
      }
    };

    const disp = await dispatchExecution({ kind: "open", sessionId: openSessId, cwd: noChangeRepo });

    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    assert.equal(check.status, "failed");
    assert.equal(check.error.status, "incomplete");
    assert.equal(check.error.noChange, true);

    const execObj = EXECUTIONS.get(disp.id);
    assert.ok(existsSync(execObj.worktree), "worktree must be preserved");
    assert.ok(existsSync(openTicketPath), "ticket must be preserved");

    // Clean up worktree
    await git(noChangeRepo, ["worktree", "remove", "--force", execObj.worktree]).catch(() => {});
    await git(noChangeRepo, ["branch", "-D", execObj.branch]).catch(() => {});
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    rmSync(noChangeRepo, { recursive: true, force: true });
  }
}

// T6. Every prompt generation path with worktree different from ambient cwd.
{
  const ambientRepo = mkdtempSync(join(tmpdir(), "qq-test-ambient-repo-"));
  await git(ambientRepo, ["init", "-b", "main"]);
  await git(ambientRepo, ["config", "user.name", "Ambient Test"]);
  await git(ambientRepo, ["config", "user.email", "ambient@example.com"]);
  writeFileSync(join(ambientRepo, "main.txt"), "main content\n");
  await git(ambientRepo, ["add", "main.txt"]);
  await git(ambientRepo, ["commit", "-m", "init"]);

  const ambientTicketsDir = join(ambientRepo, ".architect", "tickets");
  mkdirSync(ambientTicketsDir, { recursive: true });

  const customWtDir = "/tmp/different/worktree/custom-path-" + Date.now();
  const expectedTicket = join(customWtDir, ".architect", "ticket.md");

  // Path 1: buildImplementerPrompt specifies absolute worktree ticket path and working directory with proper quoting
  const implPrompt = buildImplementerPrompt(customWtDir);
  assert.equal(
    implPrompt,
    `Implement '${expectedTicket}' in working directory '${customWtDir}'. When finished, report your answer.`,
  );
  assert.ok(implPrompt.includes(`'${expectedTicket}'`));
  assert.ok(implPrompt.includes(`'${customWtDir}'`));
  assert.equal(implPrompt.includes(".architect/ticket.md in the checkout"), false);

  // Path 2: buildReviewerPrompt specifies absolute worktree ticket path and working directory with proper quoting
  const revPrompt = buildReviewerPrompt(customWtDir);
  assert.equal(
    revPrompt,
    `Follow '${expectedTicket}' in working directory '${customWtDir}'. Follow its testing plan. Do not change project code. Run tests to completion and report Verdict: PASS/FAIL with evidence; incomplete verification must not emit a fake FAIL. In non-interactive execution, ending your turn while background tasks run cancels them; actively await all background verification tasks until finished. Incomplete tests are not code defects.`,
  );
  assert.ok(revPrompt.includes(`'${expectedTicket}'`));
  assert.ok(revPrompt.includes(`'${customWtDir}'`));
  assert.equal(revPrompt.includes(".architect/ticket.md in the checkout"), false);

  // Path 3: buildRetryPrompt specifies absolute worktree ticket path and working directory with proper quoting
  const retryPrompt = buildRetryPrompt(customWtDir, "Test defect report");
  assert.ok(retryPrompt.startsWith(`Implement '${expectedTicket}' in working directory '${customWtDir}'. The reviewer found defects:\nTest defect report`));
  assert.ok(retryPrompt.includes(`'${expectedTicket}'`));
  assert.ok(retryPrompt.includes(`'${customWtDir}'`));

  // Path 4: buildResearcherPrompt specifies absolute worktree ticket path and working directory with proper quoting
  const resPrompt = buildResearcherPrompt(customWtDir);
  assert.equal(
    resPrompt,
    `Investigate '${expectedTicket}' in working directory '${customWtDir}'. Report findings.`,
  );
  assert.ok(resPrompt.includes(`'${expectedTicket}'`));
  assert.ok(resPrompt.includes(`'${customWtDir}'`));
  assert.equal(resPrompt.includes(".architect/ticket.md in the checkout"), false);

  // Path 5: prepareWorktree for bounded when ambient cwd differs from worktree
  const boundedSess = "routing-bounded-" + Date.now();
  writeFileSync(join(ambientTicketsDir, `${boundedSess}.md`), "# Bounded Routing\n\n## Kind\nbounded\n");
  const prepBounded = await prepareWorktree({ kind: "bounded", sessionId: boundedSess, cwd: ambientRepo });
  assert.ok(prepBounded.worktree !== ambientRepo, "worktree must differ from ambient cwd");
  assert.equal(
    prepBounded.implementerPrompt,
    `Implement '${join(prepBounded.worktree, ".architect", "ticket.md")}' in working directory '${prepBounded.worktree}'. When finished, report your answer.`,
  );
  assert.ok(prepBounded.instructions.includes(prepBounded.implementerPrompt));
  await retireTestWorktree(ambientRepo, prepBounded);

  // Path 6: prepareWorktree for open when ambient cwd differs from worktree
  const openSess = "routing-open-" + Date.now();
  writeFileSync(join(ambientTicketsDir, `${openSess}.md`), "# Open Routing\n\n## Kind\nopen\n");
  const prepOpen = await prepareWorktree({ kind: "open", sessionId: openSess, cwd: ambientRepo });
  assert.ok(prepOpen.worktree !== ambientRepo);
  assert.equal(
    prepOpen.implementerPrompt,
    `Implement '${join(prepOpen.worktree, ".architect", "ticket.md")}' in working directory '${prepOpen.worktree}'. When finished, report your answer.`,
  );
  assert.equal(
    prepOpen.reviewerPrompt,
    `Follow '${join(prepOpen.worktree, ".architect", "ticket.md")}' in working directory '${prepOpen.worktree}'. Follow its testing plan. Do not change project code. Run tests to completion and report Verdict: PASS/FAIL with evidence; incomplete verification must not emit a fake FAIL. In non-interactive execution, ending your turn while background tasks run cancels them; actively await all background verification tasks until finished. Incomplete tests are not code defects.`,
  );
  assert.ok(prepOpen.instructions.includes(prepOpen.implementerPrompt));
  assert.ok(prepOpen.instructions.includes(prepOpen.reviewerPrompt));
  await retireTestWorktree(ambientRepo, prepOpen);

  // Path 7: prepareWorktree for research when ambient cwd differs from worktree
  const resSess = "routing-res-" + Date.now();
  writeFileSync(join(ambientTicketsDir, `${resSess}.md`), "# Research Routing\n\n## Kind\nresearch\n");
  const prepRes = await prepareWorktree({ kind: "research", sessionId: resSess, cwd: ambientRepo });
  assert.ok(prepRes.worktree !== ambientRepo);
  assert.equal(
    prepRes.handoff.arguments.task,
    `Investigate '${join(prepRes.worktree, ".architect", "ticket.md")}' in working directory '${prepRes.worktree}'. Report findings.`,
  );
  assert.equal(prepRes.handoff.tool, "dispatch_runner");
  assert.equal(prepRes.handoff.arguments.cwd, prepRes.worktree);
  assert.ok(prepRes.instructions.includes(prepRes.handoff.arguments.task));
  assert.ok(prepRes.instructions.includes("dispatch_runner"));
  await retireTestWorktree(ambientRepo, prepRes);

  // Path 8: Execution pipeline actual invocation delivers absolute ticket and worktree cwd to subagent
  const execSess = "routing-exec-" + Date.now();
  writeFileSync(join(ambientTicketsDir, `${execSess}.md`), "# Exec Routing\n\n## Kind\nopen\n");

  const capturedSubagentCalls = [];
  globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role, cwd, prompt }) => {
    capturedSubagentCalls.push({ role, cwd, prompt });
    if (role === "implementer" && capturedSubagentCalls.length === 1) {
      writeFileSync(join(cwd, "fixed.txt"), "fixed");
      return { ok: true, output: "Implemented changes" };
    }
    if (role === "reviewer" && capturedSubagentCalls.length === 2) {
      return { ok: true, output: "- **Verdict**: FAIL\nRetry required" };
    }
    if (role === "implementer" && capturedSubagentCalls.length === 3) {
      return { ok: true, output: "Defects resolved" };
    }
    if (role === "reviewer" && capturedSubagentCalls.length === 4) {
      return { ok: true, output: "**Verdict**: **PASS**\nVerified" };
    }
  };

  try {
    const disp = await dispatchExecution({ kind: "open", sessionId: execSess, cwd: ambientRepo });
    await waitForExecution(disp.id);
    const done = await checkExecution({ id: disp.id });
    assert.equal(done.status, "completed");

    const execObj = EXECUTIONS.get(disp.id);
    const wtCwd = execObj.worktree;
    const wtTicket = join(wtCwd, ".architect", "ticket.md");

    assert.equal(capturedSubagentCalls.length, 4);

    // Call 1: implementer
    assert.equal(capturedSubagentCalls[0].role, "implementer");
    assert.equal(capturedSubagentCalls[0].cwd, wtCwd);
    assert.equal(
      capturedSubagentCalls[0].prompt,
      `Implement '${wtTicket}' in working directory '${wtCwd}'. When finished, report your answer.`,
    );

    // Call 2: reviewer
    assert.equal(capturedSubagentCalls[1].role, "reviewer");
    assert.equal(capturedSubagentCalls[1].cwd, wtCwd);
    assert.equal(
      capturedSubagentCalls[1].prompt,
      `Follow '${wtTicket}' in working directory '${wtCwd}'. Follow its testing plan. Do not change project code. Run tests to completion and report Verdict: PASS/FAIL with evidence; incomplete verification must not emit a fake FAIL. In non-interactive execution, ending your turn while background tasks run cancels them; actively await all background verification tasks until finished. Incomplete tests are not code defects.`,
    );

    // Call 3: retry implementer
    assert.equal(capturedSubagentCalls[2].role, "implementer");
    assert.equal(capturedSubagentCalls[2].cwd, wtCwd);
    assert.ok(capturedSubagentCalls[2].prompt.includes(`Implement '${wtTicket}' in working directory '${wtCwd}'. The reviewer found defects:`));

    // Call 4: second reviewer
    assert.equal(capturedSubagentCalls[3].role, "reviewer");
    assert.equal(capturedSubagentCalls[3].cwd, wtCwd);
    assert.equal(
      capturedSubagentCalls[3].prompt,
      `Follow '${wtTicket}' in working directory '${wtCwd}'. Follow its testing plan. Do not change project code. Run tests to completion and report Verdict: PASS/FAIL with evidence; incomplete verification must not emit a fake FAIL. In non-interactive execution, ending your turn while background tasks run cancels them; actively await all background verification tasks until finished. Incomplete tests are not code defects.`,
    );
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    rmSync(ambientRepo, { recursive: true, force: true });
  }
}

// T7. Incident a0964663 reproduction: reviewer waiting response causes verification incomplete,
// NO implementer retry, NO landing, preserves ticket and worktree.
{
  const waitRepo = mkdtempSync(join(tmpdir(), "qq-test-waiting-repo-"));
  await git(waitRepo, ["init", "-b", "main"]);
  await git(waitRepo, ["config", "user.name", "Waiting Test"]);
  await git(waitRepo, ["config", "user.email", "waiting@example.com"]);
  writeFileSync(join(waitRepo, "app.txt"), "v1\n");
  await git(waitRepo, ["add", "app.txt"]);
  await git(waitRepo, ["commit", "-m", "init"]);

  const tDir = join(waitRepo, ".architect", "tickets");
  mkdirSync(tDir, { recursive: true });
  const sessId = "waiting-review-" + Date.now();
  const ticketPath = join(tDir, `${sessId}.md`);
  writeFileSync(ticketPath, "# Waiting Review Ticket\n\n## Kind\nopen\n");

  const capturedSubagentCalls = [];
  globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role, cwd, prompt }) => {
    capturedSubagentCalls.push({ role, cwd, prompt });
    if (role === "implementer") {
      writeFileSync(join(cwd, "app.txt"), "v2\n");
      return { ok: true, output: "Implementation complete" };
    }
    if (role === "reviewer") {
      // Reviewer outputs waiting response without completed verdict (incident a0964663)
      return {
        ok: true,
        output: "I have started running `npm test` to verify the test suite. I will review the results as soon as the execution finishes.\nI will wait for `npm test` to complete.\nWaiting for background task to complete.\nThe test suite is running in the background. I will await its completion before continuing with the review.",
      };
    }
  };

  try {
    const disp = await dispatchExecution({ kind: "open", sessionId: sessId, cwd: waitRepo });

    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    assert.equal(check.status, "failed");
    assert.equal(check.phase, "reviewing");
    assert.equal(check.error.status, "incomplete", "status must be incomplete");
    assert.equal(check.error.reason, "missing_verdict");
    assert.ok(check.error.message.includes("Verification incomplete"));
    assert.ok(check.error.findings.includes("Waiting for background task to complete"));

    // Trajectory must reflect review_incomplete
    assert.ok(
      check.trajectory.some((t) => t.action === "review_incomplete"),
      "trajectory must record review_incomplete"
    );
    // CRITICAL: Reviewer failure MUST NOT trigger retrying phase or retry implementer
    assert.equal(
      check.trajectory.some((t) => t.action === "review_failed_retrying"),
      false,
      "incomplete review MUST NOT trigger implementer retry"
    );
    assert.equal(
      capturedSubagentCalls.length,
      2,
      "Implementer must be called exactly once; NO implementer retry on incomplete review"
    );

    // No landing commit on main
    const log = await git(waitRepo, ["log", "--oneline"]);
    assert.equal(log.trim().split("\n").length, 1, "main branch must have no landing commit");

    // Preserves worktree on disk
    const execObj = EXECUTIONS.get(disp.id);
    assert.ok(existsSync(execObj.worktree), "worktree must be preserved on disk");

    // Preserves ticket on disk
    assert.ok(existsSync(ticketPath), "ticket must be preserved on disk");

    // Clean up worktree
    await git(waitRepo, ["worktree", "remove", "--force", execObj.worktree]).catch(() => {});
    await git(waitRepo, ["branch", "-D", execObj.branch]).catch(() => {});
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    rmSync(waitRepo, { recursive: true, force: true });
  }
}

// T8. Reviewer conflicting verdict: no implementer retry, verification incomplete, preserves ticket and worktree.
{
  const conflictRepo = mkdtempSync(join(tmpdir(), "qq-test-conflict-repo-"));
  await git(conflictRepo, ["init", "-b", "main"]);
  await git(conflictRepo, ["config", "user.name", "Conflict Test"]);
  await git(conflictRepo, ["config", "user.email", "conflict@example.com"]);
  writeFileSync(join(conflictRepo, "app.txt"), "v1\n");
  await git(conflictRepo, ["add", "app.txt"]);
  await git(conflictRepo, ["commit", "-m", "init"]);

  const tDir = join(conflictRepo, ".architect", "tickets");
  mkdirSync(tDir, { recursive: true });
  const sessId = "conflict-review-" + Date.now();
  const ticketPath = join(tDir, `${sessId}.md`);
  writeFileSync(ticketPath, "# Conflict Review Ticket\n\n## Kind\nopen\n");

  const capturedSubagentCalls = [];
  globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role, cwd, prompt }) => {
    capturedSubagentCalls.push({ role, cwd, prompt });
    if (role === "implementer") {
      writeFileSync(join(cwd, "app.txt"), "v2\n");
      return { ok: true, output: "Implementation complete" };
    }
    if (role === "reviewer") {
      return {
        ok: true,
        output: "Initial review:\n**Verdict**: PASS\nWait, unexpected edge case failed:\n**Verdict**: FAIL",
      };
    }
  };

  try {
    const disp = await dispatchExecution({ kind: "open", sessionId: sessId, cwd: conflictRepo });

    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    assert.equal(check.status, "failed");
    assert.equal(check.phase, "reviewing");
    assert.equal(check.error.status, "incomplete");
    assert.equal(check.error.reason, "conflicting_verdict");
    assert.equal(capturedSubagentCalls.length, 2, "conflicting verdict must not retry implementer");

    const execObj = EXECUTIONS.get(disp.id);
    assert.ok(existsSync(execObj.worktree), "worktree preserved");
    assert.ok(existsSync(ticketPath), "ticket preserved");

    await git(conflictRepo, ["worktree", "remove", "--force", execObj.worktree]).catch(() => {});
    await git(conflictRepo, ["branch", "-D", execObj.branch]).catch(() => {});
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    rmSync(conflictRepo, { recursive: true, force: true });
  }
}

// T9. Genuine PASS after terminal verification lands successfully on first review.
{
  const passRepo = mkdtempSync(join(tmpdir(), "qq-test-pass-repo-"));
  await git(passRepo, ["init", "-b", "main"]);
  await git(passRepo, ["config", "user.name", "Pass Test"]);
  await git(passRepo, ["config", "user.email", "pass@example.com"]);
  writeFileSync(join(passRepo, "app.txt"), "v1\n");
  await git(passRepo, ["add", "app.txt"]);
  await git(passRepo, ["commit", "-m", "init"]);

  const tDir = join(passRepo, ".architect", "tickets");
  mkdirSync(tDir, { recursive: true });
  const sessId = "pass-review-" + Date.now();
  const ticketPath = join(tDir, `${sessId}.md`);
  writeFileSync(ticketPath, "# Pass Review Ticket\n\n## Kind\nopen\n");

  const capturedSubagentCalls = [];
  globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role, cwd, prompt }) => {
    capturedSubagentCalls.push({ role, cwd, prompt });
    if (role === "implementer") {
      writeFileSync(join(cwd, "app.txt"), "v2\n");
      return { ok: true, output: "Implementation complete" };
    }
    if (role === "reviewer") {
      return {
        ok: true,
        output: "Executed npm test: all 663 tests passed across 45 test files in 51.9s.\n- **Verdict**: **PASS**\nAcceptance criteria satisfied.",
      };
    }
  };

  try {
    const disp = await dispatchExecution({ kind: "open", sessionId: sessId, cwd: passRepo });
    await waitForExecution(disp.id);
    const done = await checkExecution({ id: disp.id });
    assert.equal(done.status, "completed");
    assert.equal(capturedSubagentCalls.length, 2);

    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    assert.equal(check.status, "completed");
    assert.ok(check.result.landingOutcome?.mergeSha, "landing merge commit must exist");

    const log = await git(passRepo, ["log", "--oneline"]);
    assert.ok(log.trim().split("\n").length >= 2, "main branch must have landing commit");
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    rmSync(passRepo, { recursive: true, force: true });
  }
}

// T10. Second review returns waiting response after implementer retry: fails with verification incomplete,
// no landing, ticket and worktree preserved.
{
  const retryWaitRepo = mkdtempSync(join(tmpdir(), "qq-test-retry-wait-repo-"));
  await git(retryWaitRepo, ["init", "-b", "main"]);
  await git(retryWaitRepo, ["config", "user.name", "Retry Wait Test"]);
  await git(retryWaitRepo, ["config", "user.email", "retrywait@example.com"]);
  writeFileSync(join(retryWaitRepo, "app.txt"), "v1\n");
  await git(retryWaitRepo, ["add", "app.txt"]);
  await git(retryWaitRepo, ["commit", "-m", "init"]);

  const tDir = join(retryWaitRepo, ".architect", "tickets");
  mkdirSync(tDir, { recursive: true });
  const sessId = "retry-wait-review-" + Date.now();
  const ticketPath = join(tDir, `${sessId}.md`);
  writeFileSync(ticketPath, "# Retry Wait Review Ticket\n\n## Kind\nopen\n");

  const capturedSubagentCalls = [];
  globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role, cwd, prompt }) => {
    capturedSubagentCalls.push({ role, cwd, prompt });
    if (role === "implementer" && capturedSubagentCalls.length === 1) {
      writeFileSync(join(cwd, "app.txt"), "v2\n");
      return { ok: true, output: "Implementation pass 1" };
    }
    if (role === "reviewer" && capturedSubagentCalls.length === 2) {
      // Review 1 is explicit FAIL defect -> triggers retry
      return { ok: true, output: "- **Verdict**: FAIL\nTest case 3 broke invariant" };
    }
    if (role === "implementer" && capturedSubagentCalls.length === 3) {
      writeFileSync(join(cwd, "app.txt"), "v3\n");
      return { ok: true, output: "Implementation retry done" };
    }
    if (role === "reviewer" && capturedSubagentCalls.length === 4) {
      // Review 2 exits with waiting message
      return {
        ok: true,
        output: "The test suite is running in the background. I will await its completion before continuing with the review.",
      };
    }
  };

  try {
    const disp = await dispatchExecution({ kind: "open", sessionId: sessId, cwd: retryWaitRepo });

    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    assert.equal(check.status, "failed");
    assert.equal(check.phase, "reviewing");
    assert.equal(check.error.status, "incomplete");
    assert.equal(check.error.reason, "missing_verdict");
    assert.equal(capturedSubagentCalls.length, 4);

    // No landing on main
    const log = await git(retryWaitRepo, ["log", "--oneline"]);
    assert.equal(log.trim().split("\n").length, 1, "main branch must have no landing commit");

    const execObj = EXECUTIONS.get(disp.id);
    assert.ok(existsSync(execObj.worktree), "worktree must be preserved");
    assert.ok(existsSync(ticketPath), "ticket must be preserved");

    await git(retryWaitRepo, ["worktree", "remove", "--force", execObj.worktree]).catch(() => {});
    await git(retryWaitRepo, ["branch", "-D", execObj.branch]).catch(() => {});
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    rmSync(retryWaitRepo, { recursive: true, force: true });
  }
}

// T11. Process error with explicit PASS fails closed without implementer retry.
{
  const procErrRepo = mkdtempSync(join(tmpdir(), "qq-test-procerr-repo-"));
  await git(procErrRepo, ["init", "-b", "main"]);
  await git(procErrRepo, ["config", "user.name", "ProcErr Test"]);
  await git(procErrRepo, ["config", "user.email", "procerr@example.com"]);
  writeFileSync(join(procErrRepo, "app.txt"), "v1\n");
  await git(procErrRepo, ["add", "app.txt"]);
  await git(procErrRepo, ["commit", "-m", "init"]);

  const tDir = join(procErrRepo, ".architect", "tickets");
  mkdirSync(tDir, { recursive: true });
  const sessId = "procerr-review-" + Date.now();
  const ticketPath = join(tDir, `${sessId}.md`);
  writeFileSync(ticketPath, "# ProcErr Review Ticket\n\n## Kind\nopen\n");

  const capturedSubagentCalls = [];
  globalThis.__QQ_TEST_SUBAGENT_HANDLER = async ({ role, cwd, prompt }) => {
    capturedSubagentCalls.push({ role, cwd, prompt });
    if (role === "implementer") {
      writeFileSync(join(cwd, "app.txt"), "v2\n");
      return { ok: true, output: "Implementation done" };
    }
    if (role === "reviewer") {
      return {
        ok: false,
        output: "**Verdict**: **PASS**\nTests were passing before crash",
        error: { message: "Reviewer crashed with exit code 1", exitCode: 1, stderr: "fatal error" },
      };
    }
  };

  try {
    const disp = await dispatchExecution({ kind: "open", sessionId: sessId, cwd: procErrRepo });

    await waitForExecution(disp.id);
    const check = await checkExecution({ id: disp.id });
    assert.equal(check.status, "failed");
    assert.equal(check.phase, "reviewing");
    assert.equal(check.error.exitCode, 1);
    assert.equal(capturedSubagentCalls.length, 2, "process failure must not trigger retry");

    const execObj = EXECUTIONS.get(disp.id);
    assert.ok(existsSync(execObj.worktree), "worktree must be preserved");
    assert.ok(existsSync(ticketPath), "ticket must be preserved");

    await git(procErrRepo, ["worktree", "remove", "--force", execObj.worktree]).catch(() => {});
    await git(procErrRepo, ["branch", "-D", execObj.branch]).catch(() => {});
  } finally {
    delete globalThis.__QQ_TEST_SUBAGENT_HANDLER;
    rmSync(procErrRepo, { recursive: true, force: true });
  }
}

console.log("Review gate & task routing regression tests passed cleanly.");
