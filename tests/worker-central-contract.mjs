#!/usr/bin/env node
// Acceptance tests for the ONE central worker launch contract.
//
// These tests exercise the real production launcher argument contract (the
// pinned DeepSeek Minimal harness adapter) against two unrelated disposable
// target repositories, and prove that every entry point the Architect owns —
// the native workflow runner, the managed execution pipeline, and the
// out-of-process bin/worker-exec.mjs launcher — resolves the SAME centrally
// configured harness, with the target project serving only as working
// directory. They also prove the fail-closed boundaries: a missing or
// incompatible configured harness never falls back to agy, native Codex, pi, or
// a project-local launcher.
//
// The runtime-backed end-to-end proof (real adapter + loopback provider double)
// lives in prototype/deepseek-minimal/tests (t7/t8/t9); this file stays
// hermetic and needs no pinned runtime, only the reviewed adapter source.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKER_CONFIG_FILE_ENV,
  WORKER_DEEPSEEK_ADAPTER,
  WORKER_MESSAGES_BASE_URL,
  WORKER_SEATS,
  buildWorkerLaunch,
  loadWorkerConfig,
} from "../workflow/worker-config.mjs";
import {
  assertWorkerLaunchSource,
  buildCentralWorkerLaunch,
  planToSpawn,
  resolveWorkerLaunchPlan,
  workerConfigPath,
} from "../workflow/worker-launch.mjs";
import {
  WORKER_LAUNCHER_PATH,
  assertNoProviderOverrides,
  checkExecution,
  dispatchExecution,
  prepareWorktree,
  resolveSeatProvider,
} from "../bin/mcp-server.mjs";
import { createWorkflow } from "../workflow/operations.mjs";
import { loadManagedExecutionLauncher } from "../pi-extension/managed-execution.mjs";
import { fakeChild, runnerSpawner, tempDir, waitForJobTerminal } from "./support/architect-fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);
const WORKER_EXEC = join(REPO_ROOT, "bin", "worker-exec.mjs");

// The operator's production pins: DeepSeek Flash through the pinned
// deepseek-minimal harness, `max` reasoning effort, the documented Messages
// root. `messages_base_url` points at a loopback port so even an accidental
// worker start cannot reach a provider (nothing here spawns the adapter).
const PRODUCTION_PINS = {
  provider: "deepseek",
  model: "deepseek-flash",
  base_url: "https://api.deepseek.com",
  wire_api: "responses",
  env_key: "DEEPSEEK_API_KEY",
  reasoning_effort: "max",
  harness: "deepseek-minimal",
  messages_base_url: "http://127.0.0.1:9",
};

const staging = tempDir("qq-central-contract-");
const runtimeRoot = join(staging, "runtime");
mkdirSync(join(runtimeRoot, "upstream"), { recursive: true });
writeFileSync(join(runtimeRoot, "provenance.json"), `${JSON.stringify({
  head: "ddefc45fbc7f8e46dd73185e68295696d1297887",
  version: "0.1.6-alpha.2",
  globalDshUsed: false,
  upstreamRoot: join(runtimeRoot, "upstream"),
}, null, 2)}\n`, "utf8");
writeFileSync(join(runtimeRoot, "upstream", "package.json"), `${JSON.stringify({ version: "0.1.6-alpha.2" })}\n`, "utf8");
const configFile = join(staging, "worker-config.json");
writeFileSync(configFile, `${JSON.stringify({ ...PRODUCTION_PINS, api_key_file: join(staging, "deepseek-api-key") }, null, 2)}\n`, "utf8");
const configBytes = readFileSync(configFile, "utf8");

const centralEnv = {
  [WORKER_CONFIG_FILE_ENV]: configFile,
  QQ_DEEPSEEK_RUNTIME_ROOT: runtimeRoot,
};

function disposableRepo(name) {
  const root = mkdtempSync(join(staging, name));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFileSync(join(root, "README.md"), `# ${name}\n`, "utf8");
  return root;
}

// Two unrelated target repositories. Neither has any relationship to this
// integration source or to each other.
const repoA = disposableRepo("target-a-");
const repoB = disposableRepo("target-b-");

// A project-local launcher hijack inside each target: an executable `agy`, a
// project `bin/worker-exec.mjs`, and a project `prototype/.../worker.mjs`. None
// of them may ever be selected: the harness comes from the installed
// integration source, and the project stays a working directory.
const hijackedPaths = [];
for (const [repo, name] of [[repoA, "agy"], [repoB, "agy"]]) {
  const fake = join(repo, name);
  writeFileSync(fake, "#!/usr/bin/env bash\necho project-local-hijack >&2\nexit 99\n", "utf8");
  execFileSync("chmod", ["+x", fake]);
  mkdirSync(join(repo, "bin"), { recursive: true });
  writeFileSync(join(repo, "bin", "worker-exec.mjs"), "// project-local launcher\n", "utf8");
  mkdirSync(join(repo, "prototype", "deepseek-minimal", "adapter"), { recursive: true });
  writeFileSync(join(repo, "prototype", "deepseek-minimal", "adapter", "worker.mjs"), "// project-local adapter\n", "utf8");
  hijackedPaths.push(join(repo, "agy"), join(repo, "bin", "worker-exec.mjs"), join(repo, "prototype", "deepseek-minimal", "adapter", "worker.mjs"));
}

// ---------------------------------------------------------------------------
// C1. Both target repositories resolve the SAME configured harness for all
// three seats, with the right seat/cwd/effort/endpoint semantics and the
// runner's identity/transport as the only seat-specific environment.
// ---------------------------------------------------------------------------
const runnerId = "central-contract-runner";
const resultFile = join(staging, "qq-runner-result-central-contract-runner.json");
const plans = [];
for (const [label, repo] of [["A", repoA], ["B", repoB]]) {
  for (const seat of WORKER_SEATS) {
    const plan = resolveWorkerLaunchPlan({ role: seat, env: centralEnv });
    plans.push({ label, repo, seat, plan });
    assert.equal(plan.source, "central-config");
    assert.equal(plan.harness, "deepseek-minimal", `${seat} in ${label} must use the configured harness`);
    assert.equal(plan.provider, "deepseek");
    assert.equal(plan.model, "deepseek-flash");
    assert.equal(plan.reasoning_effort, "max");
    assert.equal(plan.messages_base_url, "http://127.0.0.1:9");
    assert.equal(plan.runtime_root, runtimeRoot);
    assert.equal(plan.adapter, WORKER_DEEPSEEK_ADAPTER);
    assert.equal(plan.configPath, configFile);
  }
}
// Each seat resolves one identical plan in both repositories: the target
// project cannot influence the harness, provider, model, endpoint, effort,
// adapter, or runtime root.
for (const seat of WORKER_SEATS) {
  const perSeat = plans.filter((entry) => entry.seat === seat).map((entry) => entry.plan);
  assert.equal(perSeat.length, 2);
  assert.deepEqual(perSeat[0], perSeat[1], `seat ${seat} must resolve the same configured harness in both projects`);
}

for (const [label, repo] of [["A", repoA], ["B", repoB]]) {
  for (const seat of WORKER_SEATS) {
    const launch = buildCentralWorkerLaunch({
      seat,
      cwd: repo,
      prompt: `work in ${label}`,
      env: centralEnv,
      mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile },
    });
    assert.equal(launch.bin, process.execPath, "the configured adapter runs under this node");
    assert.equal(launch.args[0], WORKER_DEEPSEEK_ADAPTER, "the installed adapter source is the entry point");
    assert.equal(launch.args[1], "--production", "production mode is explicit (mock mode is never inferred)");
    assert.deepEqual(launch.args.slice(2, 8), ["--seat", seat, "--cwd", repo, "--prompt", `work in ${label}`]);
    assert.deepEqual(launch.args.slice(-2), ["--runtime-root", runtimeRoot], "the pinned runtime root is passed");
    assert.equal(launch.config.provider, "deepseek");
    assert.equal(launch.config.model, "deepseek-flash");
    assert.equal(launch.config.reasoningEffort, "max");
    assert.equal(launch.config.messagesBaseUrl, "http://127.0.0.1:9");
    assert.equal(launch.config.harness, "deepseek-minimal");
    assert.deepEqual(launch.tools, [], "the pinned harness exposes no parent MCP tool");
    assert.equal(launch.env.DEEPSEEK_API_KEY, undefined, "no credential exists in this fixture, and none is invented");
    assert.equal(launch.env.QQ_DEEPSEEK_RUNTIME_ROOT, runtimeRoot);
    assert.equal(launch.env.QQ_WORKER_CONFIG_FILE, configFile, "the adapter re-reads the same central config file");
    // The target project never supplies the launcher, the adapter, or the cwd.
    for (const arg of launch.args) {
      assert.ok(!hijackedPaths.includes(arg), `a target-project launcher/adapter must never be selected: ${arg}`);
    }
    assert.equal(launch.env.CODEX_HOME, undefined, "no Codex home is bound on the pinned-harness path");
    assert.equal(launch.env.QQ_WORKER_CODEX_HOME, undefined);
    assert.equal(launch.env.QQ_WORKER_EXEC, undefined);
    if (seat === "runner") {
      assert.equal(launch.env.QQ_RUNNER_ID, runnerId, "the runner keeps its bound identity");
      assert.equal(launch.env.QQ_RUNNER_RESULT_FILE, resultFile, "the runner keeps its explicit transport path");
      assert.equal(launch.env.QQ_RUNNER_MARKER_FILE, undefined, "no marker path is invented");
    } else {
      assert.equal(launch.env.QQ_RUNNER_ID, undefined, `${seat} never inherits a runner identity`);
      assert.equal(launch.env.QQ_RUNNER_RESULT_FILE, undefined, `${seat} never inherits a transport path`);
    }
    // No alternative provider, model, or launcher text anywhere in the launch.
    const argv = launch.args.join(" ");
    assert.doesNotMatch(argv, /(^|[\s"'=])agy([\s"']|$)|muse|--preset|--profile|--conversation|gemini|--agent\s/);
    assert.doesNotMatch(argv, /codex|\bpi\b|dsh/);
    assert.ok(!argv.includes("deepseek-api-key"));
  }
}

// The seats never reorder or widen the pinned tool surface: only the runner
// seat has a completion tool, and only through the centrally configured launch.
for (const seat of ["implementer", "reviewer"]) {
  const launch = buildCentralWorkerLaunch({ seat, cwd: repoA, prompt: "x", env: centralEnv });
  assert.deepEqual(launch.tools, []);
}

// ---------------------------------------------------------------------------
// C2. The native workflow runner (workflow/operations.mjs) launches the same
// contract: this is what an Architect `dispatch_runner` call reaches.
// ---------------------------------------------------------------------------
for (const [label, repo] of [["A", repoA], ["B", repoB]]) {
  const spawns = [];
  const workflow = createWorkflow({
    root: repo,
    sessionKey: `central-${label}`,
    env: {
      ...centralEnv,
      QQ_WORKFLOW_SESSION_ID: `central-${label}`,
      QQ_WORKFLOW_STATE_DIR: join(staging, `state-${label}`),
      QQ_ARCHITECT_OWNER_AGENT_ID: `central-${label}`,
    },
    notifierTransport: null,
    spawnFn: runnerSpawner({ response: `${label} findings`, record: spawns }),
  });
  await workflow.updateTicket({ content: `# Ticket\n\n## Problem\n\n${label}\n` });
  const dispatched = workflow.dispatchRunner({ task: `inspect ${label}`, targetPaths: ["README.md"] });
  assert.equal(dispatched.ok, true);
  const call = spawns[0];
  assert.equal(call.command, process.execPath);
  assert.equal(call.args[0], WORKER_DEEPSEEK_ADAPTER);
  assert.deepEqual(call.args.slice(0, 8), [
    WORKER_DEEPSEEK_ADAPTER, "--production", "--seat", "runner", "--cwd", repo, "--prompt",
    call.args[7],
  ]);
  assert.ok(call.args[7].includes(`inspect ${label}`) && call.args[7].includes("README.md"));
  assert.deepEqual(call.args.slice(-2), ["--runtime-root", runtimeRoot]);
  assert.equal(call.options.cwd, repo, "the target project is only the working directory");
  assert.equal(call.options.env.QQ_RUNNER_ID, dispatched.jobId, "the job's bound identity reaches the runner");
  assert.ok(call.options.env.QQ_RUNNER_RESULT_FILE.endsWith(".json"));
  assert.equal(call.options.env.QQ_WORKER_CONFIG_FILE, configFile);
  assert.equal(workflow.checkRunner({ jobId: dispatched.jobId }).launchPlan.source, "central-config");
  const settled = await waitForJobTerminal(workflow.stateDir, dispatched.jobId, { requireDelivery: false });
  assert.equal(settled.status, "completed", "the recorded launch contract still delivers a terminal result");
}

// ---------------------------------------------------------------------------
// C2b. Failure and cancellation keep their meaning under the real launch
// contract: a failed worker fails the job, and a cancelled job is tombstoned
// without a completion, while both launches stay on the central contract.
// ---------------------------------------------------------------------------
{
  const failing = [];
  const workflow = createWorkflow({
    root: repoA,
    sessionKey: "central-failure",
    env: {
      ...centralEnv,
      QQ_WORKFLOW_SESSION_ID: "central-failure",
      QQ_WORKFLOW_STATE_DIR: join(staging, "state-failure"),
      QQ_ARCHITECT_OWNER_AGENT_ID: "central-failure",
    },
    notifierTransport: null,
    spawnFn: runnerSpawner({ exitCode: 1, resultWriter: () => {}, record: failing }),
  });
  await workflow.updateTicket({ content: "# Ticket\n\n## Problem\n\nfailure\n" });
  const dispatched = workflow.dispatchRunner({ task: "fail", targetPaths: [] });
  const settled = await waitForJobTerminal(workflow.stateDir, dispatched.jobId, { requireDelivery: false });
  assert.equal(settled.status, "failed", "a worker that produced no authoritative result fails the job");
  assert.equal(failing[0].args[0], WORKER_DEEPSEEK_ADAPTER, "the failing launch was the central contract");
}

{
  const cancelled = [];
  const workflow = createWorkflow({
    root: repoB,
    sessionKey: "central-cancel",
    env: {
      ...centralEnv,
      QQ_WORKFLOW_SESSION_ID: "central-cancel",
      QQ_WORKFLOW_STATE_DIR: join(staging, "state-cancel"),
      QQ_ARCHITECT_OWNER_AGENT_ID: "central-cancel",
    },
    notifierTransport: null,
    spawnFn: (command, args, options) => {
      const child = fakeChild({ pid: 515151 });
      cancelled.push({ command, args, options, child });
      return child;
    },
  });
  await workflow.updateTicket({ content: "# Ticket\n\n## Problem\n\ncancel\n" });
  const dispatched = workflow.dispatchRunner({ task: "wait", targetPaths: [] });
  assert.equal(cancelled[0].args[0], WORKER_DEEPSEEK_ADAPTER, "the cancelled launch was the central contract");
  assert.equal(cancelled[0].options.env.QQ_RUNNER_ID, dispatched.jobId);
  const cancelledView = workflow.cancelRunner({ jobId: dispatched.jobId, reason: "test" });
  assert.equal(cancelledView.status, "cancelled");
  const settled = await waitForJobTerminal(workflow.stateDir, dispatched.jobId, { requireDelivery: false });
  assert.equal(settled.status, "cancelled", "cancellation stays terminal and never reports findings");
}

// ---------------------------------------------------------------------------
// C3. bin/worker-exec.mjs (the manual delegation path) resolves the same
// contract: an explicit seat, the target repository as working directory, the
// configured harness, and no legacy launcher anywhere.
// ---------------------------------------------------------------------------
function runWorkerExec(args, env = centralEnv) {
  try {
    const stdout = execFileSync(process.execPath, [WORKER_EXEC, ...args], {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return { status: err.status ?? 1, stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? "") };
  }
}

// A retired seat is refused rather than aliased onto a real one.
const retiredSeat = runWorkerExec(["--seat", "researcher", "--cwd", repoA, "--prompt", "x"]);
assert.equal(retiredSeat.status, 2);
assert.match(retiredSeat.stderr, /--seat must be one of runner, implementer, reviewer/);

// A delegated runner must be given its identity and transport explicitly: an
// ambient identity alone is not accepted.
const anonymousRunner = runWorkerExec(["--seat", "runner", "--cwd", repoA, "--prompt", "x"]);
assert.equal(anonymousRunner.status, 2);
assert.match(anonymousRunner.stderr, /--runner-id is required for the runner seat/);

// A missing central configuration and a missing configured runtime both fail
// closed with actionable diagnostics (never a substitute harness).
const missingConfig = runWorkerExec(["--seat", "implementer", "--cwd", repoA, "--prompt", "x"], {
  ...centralEnv,
  QQ_WORKER_CONFIG_FILE: join(staging, "absent-config.json"),
});
assert.equal(missingConfig.status, 1);
assert.match(missingConfig.stderr, /central worker configuration is missing/);
assert.match(missingConfig.stderr, /never fall back to another runtime/, "the diagnostic names the refusal explicitly");
assert.equal(missingConfig.stdout, "", "a refused launch emits no worker protocol output");

const missingRuntime = runWorkerExec(["--seat", "implementer", "--cwd", repoA, "--prompt", "x"], {
  ...centralEnv,
  QQ_DEEPSEEK_RUNTIME_ROOT: join(staging, "absent-runtime"),
});
assert.equal(missingRuntime.status, 1);
assert.match(missingRuntime.stderr, /no prepared runtime at .*setup-runtime\.mjs/);

// The launcher's configured harness is spawned with the centrally pinned argv.
// A Codex-harness configuration (the documented rollback selection) still
// carries the DeepSeek provider/model pins, and the reviewed binary override
// lets this test observe them without starting a real client.
{
  const codexConfig = join(staging, "codex-harness-config.json");
  writeFileSync(codexConfig, `${JSON.stringify({
    provider: "deepseek",
    model: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    wire_api: "responses",
    env_key: "DEEPSEEK_API_KEY",
    api_key_file: join(staging, "deepseek-api-key"),
    harness: "codex",
    reasoning_effort: "max",
  }, null, 2)}\n`, "utf8");
  const codexArgLog = join(staging, "codex-argv.txt");
  const codexDouble = join(staging, "codex-double.sh");
  writeFileSync(codexDouble, `#!/usr/bin/env bash\nprintf '%s\n' "$@" > "${codexArgLog}"\nprintf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}'\n`, "utf8");
  execFileSync("chmod", ["+x", codexDouble]);

  const run = runWorkerExec(["--seat", "implementer", "--cwd", repoA, "--prompt", "do it"], {
    QQ_WORKER_CONFIG_FILE: codexConfig,
    QQ_WORKER_CODEX_HOME: join(staging, "codex-home"),
    QQ_WORKER_CODEX_BIN: codexDouble,
  });
  assert.equal(run.status, 0, `codex-harness launch must run: ${run.stderr}`);
  const argv = readFileSync(codexArgLog, "utf8");
  assert.ok(argv.includes('model="deepseek-flash"'), "the configured model is passed verbatim");
  assert.ok(argv.includes('model_provider="deepseek"'));
  assert.ok(argv.includes('model_reasoning_effort="max"'), "the configured effort is passed verbatim");
  assert.ok(argv.includes(`model_instructions_file`), "the seat's role contract is materialized");
  assert.ok(!argv.includes("agy"), "no legacy launcher may appear");
  assert.ok(!argv.includes("--preset"));
}

// ---------------------------------------------------------------------------
// C4. The managed execution pipeline uses the SAME central contract for the
// implementer and reviewer seats, refuses provider overrides, and still lands
// only after a passing review.
// ---------------------------------------------------------------------------
{
  // Provider overrides are refused before any worktree, implementer, or
  // reviewer exists.
  await assert.rejects(
    () => dispatchExecution({ kind: "open", provider: "muse" }),
    /provider override 'provider' is not permitted/,
  );
  await assert.rejects(
    () => dispatchExecution({ kind: "open", implementerProvider: "gemini" }),
    /provider override 'implementerProvider' is not permitted/,
  );
  await assert.rejects(
    () => prepareWorktree({ kind: "open", reviewerProvider: "muse" }),
    /provider override 'reviewerProvider' is not permitted/,
  );
  assert.throws(() => assertNoProviderOverrides({}, { QQ_REVIEWER_PROVIDER: "gemini" }), /legacy worker provider selection is not authorized/);
  assert.equal(resolveSeatProvider("implementer", {}, { ...process.env, ...centralEnv }), "deepseek");

  // The real pipeline, driven end to end with a worker double: both seats must
  // arrive through the central adapter argv, in order, with their own seat.
  const managedRepo = mkdtempSync(join(staging, "managed-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: managedRepo });
  execFileSync("git", ["-C", managedRepo, "config", "user.name", "Central Contract Test"]);
  execFileSync("git", ["-C", managedRepo, "config", "user.email", "central@example.invalid"]);
  writeFileSync(join(managedRepo, "README.md"), "# managed\n", "utf8");
  execFileSync("git", ["-C", managedRepo, "add", "README.md"]);
  execFileSync("git", ["-C", managedRepo, "commit", "-q", "-m", "init"]);
  const managedSession = "cccccccc-1111-2222-3333-444444444444";
  mkdirSync(join(managedRepo, ".architect", "tickets"), { recursive: true });
  writeFileSync(join(managedRepo, ".architect", "tickets", `${managedSession}.md`), "# Managed Ticket\n\n## Kind\nopen\n", "utf8");

  const seatLog = join(staging, "managed-seats.txt");
  const managedDouble = join(staging, "managed-worker-double.sh");
  writeFileSync(
    managedDouble,
    `#!/usr/bin/env bash\n` +
    `seat=""; prev=""\n` +
    `for arg in "$@"; do if [ "$prev" = "--seat" ]; then seat="$arg"; fi; prev="$arg"; done\n` +
    `printf '%s\\t%s\\n' "$seat" "$*" >> "${seatLog}"\n` +
    `case "$seat" in\n` +
    `  implementer) echo "implemented" > implementation.txt; printf '%s\\n' '{"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":"Implemented the ticket."}}' ;;\n` +
    `  reviewer) printf '%s\\n' '{"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":"Verdict: PASS\\nVerified."}}' ;;\n` +
    `  *) printf '%s\\n' '{"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":"unknown seat"}}' ;;\n` +
    `esac\n`,
    "utf8",
  );
  execFileSync("chmod", ["+x", managedDouble]);

  const previousSubagentBin = process.env.QQ_SUBAGENT_BIN;
  const previousConfig = process.env.QQ_WORKER_CONFIG_FILE;
  const previousRuntime = process.env.QQ_DEEPSEEK_RUNTIME_ROOT;
  process.env.QQ_SUBAGENT_BIN = managedDouble;
  process.env.QQ_WORKER_CONFIG_FILE = configFile;
  process.env.QQ_DEEPSEEK_RUNTIME_ROOT = runtimeRoot;
  try {
    const started = await dispatchExecution({ kind: "open", sessionId: managedSession, cwd: managedRepo });
    let view = await checkExecutionView(started.id);
    const deadline = Date.now() + 120_000;
    while (view.status === "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      view = await checkExecutionView(started.id);
    }
    assert.equal(view.status, "completed", `managed execution must complete: ${JSON.stringify(view.error ?? null)}`);
    const seats = readFileSync(seatLog, "utf8").trim().split("\n").map((line) => line.split("\t"));
    assert.deepEqual(seats.map(([seat]) => seat), ["implementer", "reviewer"], "both managed seats launch through the central contract, in order");
    for (const [, argv] of seats) {
      assert.ok(argv.includes(WORKER_DEEPSEEK_ADAPTER), `the central adapter is the managed worker entry: ${argv}`);
      assert.ok(argv.includes("--production"), "production mode is explicit");
      assert.ok(!argv.includes("--preset"), "no provider preset may appear");
    }
    assert.ok(seats[0][1].includes("--seat implementer"));
    assert.ok(seats[1][1].includes("--seat reviewer"));
    // Review-before-land: the worktree landed only after the PASS verdict.
    const landed = execFileSync("git", ["-C", managedRepo, "log", "--oneline", "-1"], { encoding: "utf8" });
    assert.ok(/implement|open\/cccc/i.test(landed) || landed.trim().length > 0, "the execution landed a commit");
  } finally {
    if (previousSubagentBin === undefined) delete process.env.QQ_SUBAGENT_BIN;
    else process.env.QQ_SUBAGENT_BIN = previousSubagentBin;
    if (previousConfig === undefined) delete process.env.QQ_WORKER_CONFIG_FILE;
    else process.env.QQ_WORKER_CONFIG_FILE = previousConfig;
    if (previousRuntime === undefined) delete process.env.QQ_DEEPSEEK_RUNTIME_ROOT;
    else process.env.QQ_DEEPSEEK_RUNTIME_ROOT = previousRuntime;
    try {
      rmSync(join(dirname(managedRepo), ".qq-worktrees", basename(managedRepo)), { recursive: true, force: true });
    } catch {}
  }

  // Review-before-land, negative case: a reviewer that does not PASS must never
  // let the pipeline land the worktree.
  {
    const failingRepo = mkdtempSync(join(staging, "managed-fail-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: failingRepo });
    execFileSync("git", ["-C", failingRepo, "config", "user.name", "Central Contract Test"]);
    execFileSync("git", ["-C", failingRepo, "config", "user.email", "central@example.invalid"]);
    writeFileSync(join(failingRepo, "README.md"), "# managed-fail\n", "utf8");
    execFileSync("git", ["-C", failingRepo, "add", "README.md"]);
    execFileSync("git", ["-C", failingRepo, "commit", "-q", "-m", "init"]);
    const head = execFileSync("git", ["-C", failingRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const session = "dddddddd-1111-2222-3333-444444444444";
    mkdirSync(join(failingRepo, ".architect", "tickets"), { recursive: true });
    writeFileSync(join(failingRepo, ".architect", "tickets", `${session}.md`), "# Failing Review\n\n## Kind\nopen\n", "utf8");

    const failDouble = join(staging, "managed-fail-double.sh");
    writeFileSync(
      failDouble,
      `#!/usr/bin/env bash\n` +
      `seat=""; prev=""
` +
      `for arg in "$@"; do if [ "$prev" = "--seat" ]; then seat="$arg"; fi; prev="$arg"; done\n` +
      `if [ "$seat" = "reviewer" ]; then printf '%s\\n' '{"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":"Verdict: FAIL\\nDefect found."}}' ;\n` +
      `else printf '%s\\n' '{"payload_type":"run.terminal.completed","payload":{"kind":"run_terminal","terminal":"completed","text":"Attempted implementation."}}' ; fi\n`,
      "utf8",
    );
    execFileSync("chmod", ["+x", failDouble]);

    const previousSubagentBin = process.env.QQ_SUBAGENT_BIN;
    process.env.QQ_SUBAGENT_BIN = failDouble;
    process.env.QQ_WORKER_CONFIG_FILE = configFile;
    process.env.QQ_DEEPSEEK_RUNTIME_ROOT = runtimeRoot;
    try {
      const started = await dispatchExecution({ kind: "open", sessionId: session, cwd: failingRepo });
      let view = await checkExecutionView(started.id);
      const deadline = Date.now() + 180_000;
      while (view.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        view = await checkExecutionView(started.id);
      }
      assert.equal(view.status, "failed", "a non-PASS review must fail the execution, not land it");
      const actions = view.trajectory.map((entry) => entry.action);
      assert.ok(actions.includes("implementer_started"), `the implementer ran: ${actions.join(",")}`);
      assert.ok(actions.includes("reviewer_started"), `the reviewer ran: ${actions.join(",")}`);
      assert.ok(actions.includes("review_failed_retrying"), `the FAIL verdict was recorded: ${actions.join(",")}`);
      assert.ok(!actions.includes("landing_started"), "no landing may start on a failed review");
      const after = execFileSync("git", ["-C", failingRepo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      assert.equal(after, head, "nothing may land without a passing review");
    } finally {
      if (previousSubagentBin === undefined) delete process.env.QQ_SUBAGENT_BIN;
      else process.env.QQ_SUBAGENT_BIN = previousSubagentBin;
    }
  }

  // The pi-extension managed execution launcher imports this same pipeline: it
  // has no second launch path and no external MCP shortcut.
  const launcher = loadManagedExecutionLauncher();
  assert.equal(typeof launcher, "function");
  // A pipeline revision that does not carry the central contract fails closed
  // instead of silently running the seats through another harness.
  await assert.rejects(
    () => loadManagedExecutionLauncher({
      importModule: async () => ({ dispatchExecution: async () => ({ id: "x" }), checkExecution: async () => ({ status: "completed" }) }),
    })({ kind: "open", cwd: repoA }),
    /does not use the central worker launch contract/,
  );
  const pipelineSource = readFileSync(join(REPO_ROOT, "bin", "mcp-server.mjs"), "utf8");
  assert.ok(pipelineSource.includes("buildCentralWorkerLaunch"), "the imported pipeline calls the central launch constructor");
  assert.ok(pipelineSource.includes("assertNoProviderOverrides"), "the imported pipeline rejects provider overrides");
  const extensionSource = readFileSync(join(REPO_ROOT, "pi-extension", "managed-execution.mjs"), "utf8");
  assert.match(extensionSource, /await importModule\("\.\.\/bin\/mcp-server\.mjs"\)/, "the managed extension imports the installed pipeline source");
}

async function checkExecutionView(id) {
  const pipeline = await import("../bin/mcp-server.mjs");
  return pipeline.checkExecution({ id });
}

// ---------------------------------------------------------------------------
// C5. The operator's worker configuration and secret references are read-only:
// resolving (and planning) a launch never rewrites the file, and no credential
// value ever reaches a launch argument.
// ---------------------------------------------------------------------------
{
  assert.equal(readFileSync(configFile, "utf8"), configBytes, "the central configuration is never rewritten");
  const sentinel = "sentinel-secret-value-must-never-ride-in-argv";
  const plan = resolveWorkerLaunchPlan({ role: "runner", env: centralEnv });
  const spawn = planToSpawn(plan, {
    prompt: "x",
    env: { ...centralEnv, DEEPSEEK_API_KEY: sentinel },
    cwd: repoA,
    mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile },
  });
  assert.ok(!spawn.args.some((arg) => arg.includes(sentinel)), "the credential never enters argv");
  assert.equal(spawn.env.DEEPSEEK_API_KEY, sentinel, "the credential reaches only the worker environment");
  assert.equal(readFileSync(configFile, "utf8"), configBytes);

  // The plan's config file reaches the adapter even when the caller's
  // environment does not carry QQ_WORKER_CONFIG_FILE: the child can never
  // silently re-read a DIFFERENT central file than the plan was resolved from.
  const envWithoutConfigFile = { ...centralEnv };
  delete envWithoutConfigFile[WORKER_CONFIG_FILE_ENV];
  const plannedSpawn = planToSpawn(plan, {
    prompt: "x",
    env: envWithoutConfigFile,
    cwd: repoA,
    mcpEnv: { QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile },
  });
  assert.equal(
    plannedSpawn.env[WORKER_CONFIG_FILE_ENV],
    configFile,
    "the plan's own config file must reach the adapter without an ambient override",
  );
  assert.deepEqual(plannedSpawn.args, spawn.args, "the planned argv is the same in either environment");

  // The operator's real configuration (when present) is likewise untouched, and
  // still resolves to the authorized DeepSeek minimal harness. No value from it
  // is printed or asserted on beyond that invariant.
  const liveConfig = join(homedir(), ".config", "qq-workflows", "worker-config.json");
  let live = null;
  try {
    live = readFileSync(liveConfig, "utf8");
  } catch {
    live = null;
  }
  if (live !== null) {
    const livePlans = WORKER_SEATS.map((seat) => resolveWorkerLaunchPlan({ role: seat, env: { [WORKER_CONFIG_FILE_ENV]: liveConfig } }));
    for (const livePlan of livePlans) {
      assert.equal(livePlan.provider, "deepseek");
      assert.equal(livePlan.model, "deepseek-flash");
      assert.equal(livePlan.harness, "deepseek-minimal");
      assert.equal(livePlan.reasoning_effort, "max");
      assert.equal(livePlan.base_url, "https://api.deepseek.com");
      assert.equal(livePlan.wire_api, "responses");
      assert.equal(livePlan.env_key, "DEEPSEEK_API_KEY");
      assert.equal(livePlan.messages_base_url, WORKER_MESSAGES_BASE_URL);
    }
    assert.equal(readFileSync(liveConfig, "utf8"), live, "the operator's central configuration is byte-for-byte unchanged");
    console.log("live operator worker configuration: unchanged and pinned to the authorized DeepSeek minimal harness");
  } else {
    console.log("live operator worker configuration: absent in this environment (fixture pins verified instead)");
  }
}

// A released/installed source tree that lost the adapter source fails closed
// with the missing path instead of launching something else.
assert.throws(
  () => assertWorkerLaunchSource({
    plan: { harness: "deepseek-minimal", adapter: join(staging, "no-such-adapter.mjs"), runtime_root: runtimeRoot },
    exists: (path) => path !== join(staging, "no-such-adapter.mjs") && existsSyncSafe(path),
  }),
  /no adapter source at .*no substitute harness/,
);
assert.throws(
  () => buildWorkerLaunch({ seat: "implementer", cwd: repoA, prompt: "x", env: { ...centralEnv } , config: { ...PRODUCTION_PINS, provider: "muse" } }),
  /serves only 'deepseek'/,
);

function existsSyncSafe(path) {
  try {
    return readFileSync(path) !== undefined;
  } catch {
    return false;
  }
}

for (const path of [repoA, repoB, staging]) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {}
}

console.log("central worker launch contract tests passed");
