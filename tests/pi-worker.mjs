#!/usr/bin/env node
// Offline acceptance for the one worker runtime (Pi RPC).
//
// Everything here is hermetic: a fake `pi --mode rpc` binary
// (tests/support/fake-pi.mjs), temporary state/config directories, and a fake
// gateway for the shared search tool. No provider call, no operator config, no
// live model. What is proven:
//
//   * provider/model/effort swaps are CONFIG changes (argv + plan follow the
//     file; no source edit, no model-specific branch);
//   * the requested effort is validated against the model's real capability and
//     an unavailable level refuses the launch instead of degrading to `high`;
//   * the configured context policy is materialized into the isolated worker
//     settings and the runtime's compaction state is verified, not assumed;
//   * the runner's authoritative completion uses the shared `complete_task`
//     module and a rejected/empty/over-cap answer never becomes success;
//   * cancellation aborts through the runtime and never reports success;
//   * the shared root-bound ZG tool is registered for every worker seat with the
//     injected root fields removed from its schema;
//   * the per-seat tool policy is explicit (the runner keeps the command
//     execution its contract mandates),
//   * the instructions a seat actually receives describe THIS runtime: the
//     shared contract is adapted, no MCP-only tool is named, and a name outside
//     the seat's allowlist refuses the launch instead of reaching the model, and
//   * native per-attempt session recording is default-on for production
//     launches (disabled argv equivalence, directory resolution, exclusive
//     0600 allocation with a 0600 metadata sidecar in a 0700 directory,
//     collision retries, and every named refusal path).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKER_PI_EXTENSION,
  WORKER_PI_TOOLS,
  buildWorkerLaunch,
  ensurePiWorkerSettings,
  loadRoleContract,
  loadWorkerConfig,
  piWorkerAgentDir,
  readPiWorkerSettings,
  validateWorkerConfig,
  workerCompactionBudget,
} from "../workflow/worker-config.mjs";
import { FINAL_RESPONSE_MAX_CHARS_LABEL } from "../workflow/limits.mjs";
import { PI_HARNESS, assertWorkerLaunchSource, planToSpawn, resolveWorkerLaunchPlan } from "../workflow/worker-launch.mjs";
import {
  ADAPTER_EXIT,
  assertSelectedModel,
  buildPiArgs,
  classifyPiTerminal,
  defaultNativeSessionDir,
  parseArgs,
  resolveNativeSessionPath,
  resolveRunnerTransport,
} from "../workflow/pi-worker/adapter.mjs";
import {
  PI_SEARCH_TOOL,
  adaptPiSeatInstructions,
  loadPiSeatInstructions,
  referencedToolNames,
  unavailablePiSeatTools,
} from "../workflow/pi-worker/instructions.mjs";
import { encodeCommand, splitRecords } from "../workflow/pi-worker/rpc.mjs";
import {
  WORKER_SEARCH_SEATS,
  WORKER_SEARCH_TOOL_NAME,
  createWorkerToolsExtension,
  resolveWorkerSearchBinding,
  workerSearchEnv,
  workerSearchToolSchema,
} from "../pi-extension/worker-tools.mjs";
import { INJECTED_SEARCH_FIELDS } from "../prototype/deepseek-minimal/gateway/zvec-grep-tool.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(here);
const ADAPTER = join(repoRoot, "workflow", "pi-worker", "adapter.mjs");
const root = mkdtempSync(join(tmpdir(), "qq-pi-worker-"));
// The pi binary override is a shim (chmod +x) that runs the shared fake runtime.
const fakePi = join(root, "fake-pi");
writeFileSync(fakePi, `#!/usr/bin/env node\nawait import(${JSON.stringify(join(here, "support", "fake-pi.mjs"))});\n`, "utf8");
spawnSync("chmod", ["+x", fakePi]);

function writeConfig(name, extra = {}) {
  const file = join(root, `worker-config-${name}.json`);
  writeFileSync(file, `${JSON.stringify({
    harness: "pi",
    context: { enabled: true, reserve_tokens: 16_384, keep_recent_tokens: 20_000 },
    ...extra,
  }, null, 2)}\n`, "utf8");
  return file;
}

function adapterEnv({ configFile, name, extra = {} }) {
  return {
    ...process.env,
    HOME: root,
    XDG_STATE_HOME: join(root, "state"),
    QQ_WORKER_CONFIG_FILE: configFile,
    QQ_WORKER_PI_BIN: fakePi,
    QQ_WORKER_PI_AGENT_DIR: join(root, `agent-${name}`),
    QQ_ZVEC_GREP_SEAT: undefined,
    ...extra,
  };
}

function runAdapter({ args, env, timeout = 30_000 }) {
  const result = spawnSync(process.execPath, [ADAPTER, ...args], {
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    timeout,
  });
  return result;
}

function parseEvents(stdout) {
  return stdout.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

try {
  // A1. The runtime interface is pi and only pi: the launch is one adapter
  // process per seat, with the configured provider/model/effort on the command
  // line and no provider-specific argv branch.
  const configFile = writeConfig("muse", {
    provider: "meta",
    model: "muse-spark-1.3-contributor",
    reasoning_effort: "xhigh",
    env_key: "MODEL_API_KEY",
  });
  const env = adapterEnv({ configFile, name: "muse", extra: { MODEL_API_KEY: "test-key-not-a-real-secret" } });
  const launch = buildWorkerLaunch({ seat: "reviewer", cwd: root, prompt: "review this", env });
  assert.equal(launch.harness, PI_HARNESS);
  assert.equal(launch.bin, process.execPath);
  assert.equal(launch.args[0], join(repoRoot, "workflow", "pi-worker", "adapter.mjs"));
  assert.deepEqual(launch.args.slice(1, 8), ["--production", "--seat", "reviewer", "--cwd", root, "--prompt", "review this"]);
  assert.equal(launch.pi.bin, fakePi, "the pi binary is the configured/overridable one");
  assert.equal(launch.env.PI_CODING_AGENT_DIR, join(root, "agent-muse"));
  assert.equal(launch.env[launch.config.envKey], "test-key-not-a-real-secret", "the credential reference resolves into the child env, never argv");

  const piArgs = buildPiArgs({
    seat: "reviewer",
    config: launch.config,
    extension: WORKER_PI_EXTENSION,
    tools: WORKER_PI_TOOLS.reviewer,
    roleInstructions: "ROLE",
  });
  assert.deepEqual(piArgs.slice(0, 6), ["--mode", "rpc", "--provider", "meta", "--model", "muse-spark-1.3-contributor"]);
  assert.deepEqual(piArgs.slice(6, 8), ["--thinking", "xhigh"], "the configured effort is requested verbatim");
  assert.ok(piArgs.includes("--no-approve"), "worker sessions never trust target-project resources");
  assert.ok(piArgs.includes("--no-extensions") && piArgs.includes(WORKER_PI_EXTENSION));
  assert.deepEqual(piArgs[piArgs.indexOf("--tools") + 1], WORKER_PI_TOOLS.reviewer.join(","));
  assert.equal(piArgs[piArgs.indexOf("--append-system-prompt") + 1], "ROLE", "role instructions come from the shared contract");

  // A2. A provider/model swap is a config change: nothing in the checkout
  // changes, only the file, and the plan follows it.
  const swappedFile = writeConfig("swapped", { provider: "deepseek", model: "some-other-pi-model", env_key: "OTHER_KEY" });
  const swapped = resolveWorkerLaunchPlan({ role: "implementer", env: adapterEnv({ configFile: swappedFile, name: "swapped" }) });
  assert.equal(swapped.provider, "deepseek");
  assert.equal(swapped.model, "some-other-pi-model");
  assert.equal(swapped.harness, PI_HARNESS);
  assert.equal(swapped.adapter, join(repoRoot, "workflow", "pi-worker", "adapter.mjs"));
  assert.equal(validateWorkerConfig({ harness: "pi", provider: "meta", model: "m" }).provider, "meta");
  for (const bad of [{ harness: "pi", model: "m" }, { harness: "pi", provider: "p" }]) {
    assert.throws(() => validateWorkerConfig(bad), /must select a (provider|model)/, "the pi runtime has no source-level default selection");
  }
  // The Pi runtime takes endpoint/protocol and the output cap from the registry,
  // not the config: an inert knob is refused, never carried and ignored.
  assert.throws(() => validateWorkerConfig({ harness: "pi", provider: "p", model: "m", base_url: "https://x" }), /pi's own registry/);
  assert.throws(
    () => validateWorkerConfig({ harness: "pi", provider: "p", model: "m", max_output_tokens: 2048 }),
    /output cap from pi's own registry/,
  );
  assert.equal(
    validateWorkerConfig({ harness: "deepseek-minimal", provider: "deepseek", model: "deepseek-flash", max_output_tokens: 2048 }).maxOutputTokens,
    2048,
    "the legacy harness still consumes max_output_tokens",
  );
  // An unknown harness still fails closed.
  assert.throws(() => validateWorkerConfig({ harness: "agy", provider: "p", model: "m" }), /harness 'agy' is not supported/);

  // A3. Context policy: the isolated worker settings carry the configured
  // compaction policy, the effective value is read back, and the budget
  // arithmetic is reported as a compaction target - never as a hard cap.
  const settings = ensurePiWorkerSettings(env, loadWorkerConfig({ env }));
  assert.equal(settings.file ?? settings.settingsFile, join(piWorkerAgentDir(env), "settings.json"));
  assert.deepEqual(JSON.parse(readFileSync(settings.settingsFile, "utf8")), {
    compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
  });
  const effective = readPiWorkerSettings(env);
  assert.equal(effective.enabled, true);
  assert.equal(effective.reserveTokens, 16_384);
  const budget = workerCompactionBudget({ contextWindow: 1_048_576, reserveTokens: 917_504 });
  assert.equal(budget.workingWindow, 131_072, "reserve 917504 yields a ~128k working window on 1M capacity");
  assert.match(budget.note, /not an enforced hard input bound/);

  // A4. Runner completion through the shared authoritative module.
  {
    const runnerEnv = adapterEnv({ configFile, name: "runner-run" });
    const runnerId = "pi-worker-runner-1";
    const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
    const log = join(root, "commands-runner.log");
    const summaryFile = join(root, "summary-runner.json");
    const result = runAdapter({
      args: ["--production", "--seat", "runner", "--cwd", root, "--prompt", "find it", "--summary-file", summaryFile],
      env: {
        ...runnerEnv,
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: resultFile,
        QQ_FAKE_PI_ANSWER: "FINDINGS: the answer",
        QQ_FAKE_PI_COMMAND_LOG: log,
      },
    });
    assert.equal(result.status, ADAPTER_EXIT.ok, result.stderr);
    const events = parseEvents(result.stdout);
    assert.ok(events.some((event) => event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text === "FINDINGS: the answer"), "the final answer is emitted on the parent contract");
    assert.ok(events.some((event) => event.event === "step_update" && event.step_update?.tool_name === "zvec_grep_search" && event.step_update.state === "ACTIVE"), "tool activity is reported as parent step updates");
    const transport = JSON.parse(readFileSync(resultFile, "utf8"));
    assert.equal(transport.response, "FINDINGS: the answer", "the runner's result lands in the shared transport");
    assert.equal(transport.runnerId, runnerId);
    const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      commands.map((command) => command.type).slice(0, 4),
      ["get_state", "get_available_thinking_levels", "get_state", "prompt"],
      "capability and context policy are verified before the prompt is sent",
    );
    // The runtime receives the ADAPTED contract and the seat's own allowlist: the
    // instruction surface and the executable surface agree.
    const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
    assert.deepEqual(summary.instructions.adaptedSections, ["Completion"]);
    assert.deepEqual(summary.instructions.namedTools, []);
    const runnerSystemPrompt = summary.piArgs[summary.piArgs.indexOf("--append-system-prompt") + 1];
    assert.equal(runnerSystemPrompt.includes("complete_task"), false, "the runtime is never told to call a tool it does not expose");
    assert.match(runnerSystemPrompt, /closing assistant message/);
    assert.equal(
      summary.piArgs[summary.piArgs.indexOf("--tools") + 1],
      WORKER_PI_TOOLS.runner.join(","),
      "the runner's allowlist reaches the runtime with command execution intact",
    );
    rmSync(resultFile, { force: true });
  }

  // A5. Capability validation: an effort the model does not offer refuses the
  // launch (exit 2) instead of silently reducing the level.
  {
    const unsupported = writeConfig("unsupported-effort", { provider: "meta", model: "m", reasoning_effort: "max", env_key: "K" });
    const result = runAdapter({
      args: ["--production", "--seat", "reviewer", "--cwd", root, "--prompt", "x"],
      env: { ...adapterEnv({ configFile: unsupported, name: "unsupported" }), QQ_FAKE_PI_LEVELS: "off,minimal,low,medium,high,xhigh", K: "test-key" },
    });
    assert.equal(result.status, ADAPTER_EXIT.refused);
    assert.match(result.stderr, /reasoning_effort 'max' is not offered/);
    assert.match(result.stderr, /refusing instead of silently reducing/);
  }

  // A6. Compaction verification: a runtime that refuses to enable auto
  // compaction is a refusal, not a silent overflow.
  {
    const result = runAdapter({
      args: ["--production", "--seat", "implementer", "--cwd", root, "--prompt", "x"],
      env: { ...adapterEnv({ configFile, name: "nocompaction" }), MODEL_API_KEY: "test-key", QQ_FAKE_PI_COMPACTION: "false" },
    });
    assert.equal(result.status, ADAPTER_EXIT.refused);
    assert.match(result.stderr, /did not enable automatic compaction/);
  }

  // A7. Failure is a name, never a success: a worker extension error fails the
  // run (exit 1) and no agent_message is published.
  {
    const result = runAdapter({
      args: ["--production", "--seat", "reviewer", "--cwd", root, "--prompt", "x"],
      env: { ...adapterEnv({ configFile, name: "error" }), MODEL_API_KEY: "test-key", QQ_FAKE_PI_MODE: "error" },
    });
    assert.equal(result.status, ADAPTER_EXIT.failed);
    assert.match(result.stderr, /extension_error/);
    assert.equal(parseEvents(result.stdout).some((event) => event.item?.type === "agent_message"), false);
  }

  // A8. Cancellation propagates to the runtime's own abort and never reports
  // success.
  {
    const runnerId = "pi-worker-runner-cancel";
    const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
    const log = join(root, "commands-cancel.log");
    const result = spawnSync("bash", ["-c", `exec "${process.execPath}" "${ADAPTER}" --production --seat runner --cwd "${root}" --prompt x & sleep 1.2; kill -TERM %1; wait %1`], {
      encoding: "utf8",
      env: {
        ...adapterEnv({ configFile, name: "cancel" }),
        MODEL_API_KEY: "test-key",
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: resultFile,
        QQ_FAKE_PI_MODE: "stall",
        QQ_FAKE_PI_COMMAND_LOG: log,
      },
      timeout: 30_000,
    });
    assert.ok([ADAPTER_EXIT.terminated, ADAPTER_EXIT.failed].includes(result.status ?? 1), `unexpected cancel exit ${result.status}`);
    const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(commands.some((command) => command.type === "abort"), "cancellation asks the runtime to abort");
    assert.equal(existsSync(resultFile), false, "a cancelled run never lands a result");
  }

  // A9. Argument/transport refusals stay explicit.
  assert.throws(() => resolveRunnerTransport({}), /runner_identity_required|QQ_RUNNER_ID/);
  assert.throws(
    () => resolveRunnerTransport({ QQ_RUNNER_ID: "r", QQ_RUNNER_RESULT_FILE: "/etc/passwd" }),
    /outside the shared os\.tmpdir\(\) transport root/,
  );
  const durableEnv = { QQ_RUNNER_ID: "r", QQ_RUNNER_RESULT_FILE: "/home/fixture/state/runner-results/r.json" };
  const communication = { enabled: true, binding: { role: "runner", jobId: "r", stateDir: "/home/fixture/state" } };
  assert.equal(resolveRunnerTransport(durableEnv, { communication }).resultFile, durableEnv.QQ_RUNNER_RESULT_FILE);
  assert.throws(() => resolveRunnerTransport(durableEnv), /outside the shared/);
  assert.throws(() => resolveRunnerTransport({ ...durableEnv, QQ_RUNNER_ID: "other" }, { communication }), /outside the shared/);
  assert.throws(() => resolveRunnerTransport({ ...durableEnv, QQ_RUNNER_RESULT_FILE: "/home/fixture/state/unrelated.json" }, { communication }), /outside the shared/);
  assert.deepEqual(parseArgs(["--seat", "runner", "--prompt", "hi"]).seat, "runner");
  assert.deepEqual(classifyPiTerminal({ settled: false }), { ok: false, code: "missing_terminal", diagnostic: "the pi run never settled (no agent_settled before the child ended)" });
  assert.equal(classifyPiTerminal({ settled: true, finalText: "x" }).ok, true);
  assert.equal(classifyPiTerminal({ settled: true, finalText: "x".repeat(20_000) }).code, "final_answer_over_cap");
  assert.equal(classifyPiTerminal({ settled: true, finalText: "  " }).code, "empty_final_answer");

  // A9b. Terminal discipline: a failed or aborted request never authorizes
  // success, even though pi keeps the text streamed before the failure in the
  // message; a truncated (output-cap) answer is not a completed answer either.
  assert.equal(classifyPiTerminal({ settled: true, finalText: "partial", stopReason: "error", errorMessage: "529 overloaded" }).code, "message_error");
  assert.match(
    classifyPiTerminal({ settled: true, finalText: "partial", stopReason: "error", errorMessage: "529 overloaded" }).diagnostic,
    /529 overloaded/,
  );
  assert.equal(classifyPiTerminal({ settled: true, finalText: "partial", stopReason: "aborted" }).code, "run_aborted");
  assert.equal(classifyPiTerminal({ settled: true, finalText: "cut off", stopReason: "length" }).code, "final_answer_truncated");
  assert.equal(classifyPiTerminal({ settled: true, finalText: "x", stopReason: "stop" }).ok, true);
  assert.equal(classifyPiTerminal({ settled: true, finalText: "x", stopReason: "toolUse" }).ok, true, "the gate fails closed only on the named bad reasons");

  // A9c. Selection confirmation: the runtime's report of the provider/model is
  // checked against the central configuration, so a config-only swap is
  // confirmed instead of assumed and a substitution is refused.
  assert.throws(
    () => assertSelectedModel({ config: { provider: "meta", model: "muse-spark-1.3-contributor" }, selected: { provider: "openai-codex", id: "muse-spark-1.3-contributor" } }),
    (error) => error.code === "provider_mismatch" && /refusing instead of running on a different provider/u.test(error.message),
  );
  assert.throws(
    () => assertSelectedModel({ config: { provider: "meta", model: "muse-spark-1.3-contributor" }, selected: { provider: "meta", id: "other-model" } }),
    (error) => error.code === "model_mismatch" && /refusing instead of running on a different model/u.test(error.message),
  );
  assert.equal(
    assertSelectedModel({ config: { provider: "meta", model: "Muse Spark 1.3 Contributor" }, selected: { provider: "meta", id: "muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" } }).confirmed,
    true,
    "a registry id and a display name are both acceptable evidence of the configured selection",
  );

  // A12. A runtime that reports a different provider/model than the central
  // configuration is refused BEFORE the prompt: no turn is sent, the exit is a
  // refusal, and nothing is delivered as a result.
  {
    const seatLog = join(root, "commands-mismatch.log");
    const mismatch = runAdapter({
      args: ["--production", "--seat", "implementer", "--cwd", root, "--prompt", "x"],
      env: {
        ...adapterEnv({ configFile, name: "mismatch" }),
        MODEL_API_KEY: "test-key",
        QQ_FAKE_PI_MODEL: "some-other-model",
        QQ_FAKE_PI_COMMAND_LOG: seatLog,
      },
    });
    assert.equal(mismatch.status, ADAPTER_EXIT.refused);
    assert.match(mismatch.stderr, /selected model 'some-other-model'/);
    assert.match(mismatch.stderr, /refusing instead of running on a different model/);
    const commands = readFileSync(seatLog, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(commands.map((command) => command.type), ["get_state"], "the refusal happens before any prompt is sent");

    const wrongProvider = runAdapter({
      args: ["--production", "--seat", "implementer", "--cwd", root, "--prompt", "x"],
      env: {
        ...adapterEnv({ configFile, name: "mismatch-provider" }),
        MODEL_API_KEY: "test-key",
        QQ_FAKE_PI_PROVIDER: "openai-codex",
      },
    });
    assert.equal(wrongProvider.status, ADAPTER_EXIT.refused);
    assert.match(wrongProvider.stderr, /selected provider 'openai-codex'/);

    // The confirmation is not a false-failure surface: selecting the model by
    // its registry display name still resolves to the configured selection.
    const byNameFile = writeConfig("byname", { provider: "meta", model: "Muse Spark 1.3 Contributor", env_key: "MODEL_API_KEY" });
    const byNameSummary = join(root, "summary-byname.json");
    const byName = runAdapter({
      args: ["--production", "--seat", "implementer", "--cwd", root, "--prompt", "x", "--summary-file", byNameSummary],
      env: {
        ...adapterEnv({ configFile: byNameFile, name: "byname" }),
        MODEL_API_KEY: "test-key",
        QQ_FAKE_PI_MODEL: "muse-spark-1.3-contributor",
        QQ_FAKE_PI_MODEL_NAME: "Muse Spark 1.3 Contributor",
      },
    });
    assert.equal(byName.status, ADAPTER_EXIT.ok, byName.stderr);
    assert.deepEqual(JSON.parse(readFileSync(byNameSummary, "utf8")).selectedModel, {
      provider: "meta",
      model: "muse-spark-1.3-contributor",
      confirmed: true,
    });
  }

  // A13. Failure and truncation never become a delivered result: the terminal
  // stop reason fails the run (exit 1) and the runner's transport stays empty.
  for (const [stopReason, code] of [["error", "message_error"], ["aborted", "run_aborted"], ["length", "final_answer_truncated"]]) {
    const runnerId = `pi-worker-runner-${stopReason}`;
    const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
    rmSync(resultFile, { force: true });
    const result = runAdapter({
      args: ["--production", "--seat", "runner", "--cwd", root, "--prompt", "x"],
      env: {
        ...adapterEnv({ configFile, name: `terminal-${stopReason}` }),
        MODEL_API_KEY: "test-key",
        QQ_RUNNER_ID: runnerId,
        QQ_RUNNER_RESULT_FILE: resultFile,
        QQ_FAKE_PI_ANSWER: "partial text that must never be delivered",
        QQ_FAKE_PI_STOP_REASON: stopReason,
        QQ_FAKE_PI_ERROR_MESSAGE: stopReason === "error" ? "529 overloaded_error: Overloaded" : undefined,
      },
    });
    assert.equal(result.status, ADAPTER_EXIT.failed, `${stopReason} must fail the run`);
    assert.match(result.stderr, new RegExp(code));
    assert.equal(
      parseEvents(result.stdout).some((event) => event.item?.type === "agent_message"),
      false,
      `${stopReason}: a failed/truncated message is never published as the final answer`,
    );
    assert.equal(existsSync(resultFile), false, `${stopReason}: nothing lands in the authoritative transport`);
  }

  // A14. Native per-attempt session recording: a production worker records its
  // attempt's native session by default in the dedicated private
  // worker-session directory; a disabled launch is byte-equal to the
  // pre-recording argv; every allocation is an exclusive 0600 file plus a
  // 0600 metadata sidecar inside a verified 0700 directory; and every
  // initialization problem is a named refusal that never silently falls back
  // to `--no-session`, never chmods an unrelated path, and never follows a
  // symlink into someone else's directory.
  {
    const CONFIG = { provider: "meta", model: "muse-spark-1.3-contributor", reasoningEffort: "high", harness: "pi" };
    const TOOLS = WORKER_PI_TOOLS.runner;
    // The exact pre-recording argv: what a recording-disabled launch must
    // still produce, byte for byte.
    const baselineArgs = [
      "--mode", "rpc",
      "--provider", "meta",
      "--model", "muse-spark-1.3-contributor",
      "--thinking", "high",
      "--no-session",
      "--no-extensions",
      "--extension", WORKER_PI_EXTENSION,
      "--no-approve",
      "--tools", TOOLS.join(","),
      "--append-system-prompt", "ROLE BODY",
    ];
    // Disabled argv equivalence: no sessionPath means the exact prior argv.
    assert.deepEqual(
      buildPiArgs({ seat: "runner", config: CONFIG, extension: WORKER_PI_EXTENSION, tools: TOOLS, roleInstructions: "ROLE BODY" }),
      baselineArgs,
    );
    assert.equal(baselineArgs.includes("--no-session"), true);
    assert.equal(baselineArgs.includes("--session"), false);

    // `--session <path>` replaces `--no-session` at the same position (+1
    // token); provider/model/effort/tools/role stay verbatim.
    const recordingArgs = buildPiArgs({ seat: "runner", config: CONFIG, extension: WORKER_PI_EXTENSION, tools: TOOLS, roleInstructions: "ROLE BODY", sessionPath: "/tmp/s.jsonl" });
    assert.equal(recordingArgs.length, baselineArgs.length + 1);
    assert.equal(recordingArgs.indexOf("--session"), baselineArgs.indexOf("--no-session"));
    assert.equal(recordingArgs[recordingArgs.indexOf("--session") + 1], "/tmp/s.jsonl");
    assert.deepEqual(
      [
        ...recordingArgs.slice(0, recordingArgs.indexOf("--session")),
        "--no-session",
        ...recordingArgs.slice(recordingArgs.indexOf("--session") + 2),
      ],
      baselineArgs,
    );
    for (const [flag, value] of [["--provider", "meta"], ["--model", "muse-spark-1.3-contributor"], ["--thinking", "high"], ["--extension", WORKER_PI_EXTENSION], ["--tools", TOOLS.join(",")]]) {
      assert.equal(recordingArgs[recordingArgs.indexOf(flag) + 1], value, flag);
    }
    assert.equal(recordingArgs[recordingArgs.indexOf("--append-system-prompt") + 1], "ROLE BODY");
    assert.ok(recordingArgs.includes("--no-extensions") && recordingArgs.includes("--no-approve"));

    // Directory resolution: XDG_STATE_HOME wins, a blank value falls back to
    // HOME/.local/state, and with neither the process homedir is used.
    assert.equal(defaultNativeSessionDir({ HOME: "/home/u" }), "/home/u/.local/state/qq-workflows/worker-sessions");
    assert.equal(defaultNativeSessionDir({ XDG_STATE_HOME: "/xdg", HOME: "/home/u" }), "/xdg/qq-workflows/worker-sessions");
    assert.equal(defaultNativeSessionDir({ XDG_STATE_HOME: "  ", HOME: "/home/u" }), "/home/u/.local/state/qq-workflows/worker-sessions");
    assert.equal(defaultNativeSessionDir({}), join(homedir(), ".local/state/qq-workflows/worker-sessions"));

    // Production default allocation: under HOME/.local/state, an empty 0600
    // session file plus a 0600 sidecar in a created 0700 directory, with the
    // sidecar carrying exactly the documented schema and fields and nothing
    // about the prompt, the environment, or credentials.
    const t4Home = join(root, "t4-home");
    const t4Dir = join(t4Home, ".local/state/qq-workflows/worker-sessions");
    const t4Path = resolveNativeSessionPath({ env: { HOME: t4Home }, seat: "runner", production: true, cwd: "/work/x", runnerId: "job-9" });
    assert.ok(t4Path.startsWith(`${t4Dir}/pi-runner-`), t4Path);
    assert.equal(statSync(t4Path).mode & 0o777, 0o600);
    assert.equal(statSync(t4Path).size, 0);
    assert.equal(statSync(t4Dir).mode & 0o777, 0o700);
    const t4MetaPath = `${t4Path}.meta.json`;
    assert.ok(existsSync(t4MetaPath));
    assert.equal(statSync(t4MetaPath).mode & 0o777, 0o600);
    const t4Meta = JSON.parse(readFileSync(t4MetaPath, "utf8"));
    assert.deepEqual(Object.keys(t4Meta).sort(), ["cwd", "pid", "runnerId", "schema", "seat", "sessionFile", "startedAt"]);
    assert.equal(t4Meta.schema, "qq-worker-session-meta/1");
    assert.equal(t4Meta.sessionFile, t4Path);
    assert.equal(t4Meta.seat, "runner");
    assert.equal(t4Meta.cwd, "/work/x");
    assert.equal(t4Meta.runnerId, "job-9");
    assert.equal(typeof t4Meta.pid, "number");
    assert.ok(!Number.isNaN(Date.parse(t4Meta.startedAt)));
    const t4Raw = readFileSync(t4MetaPath, "utf8");
    assert.ok(!t4Raw.includes("prompt") && !t4Raw.includes("env") && !t4Raw.includes("KEY"), "no prompt/env/credential in the sidecar");

    // An explicit absolute QQ_WORKER_SESSION_DIR wins over the default.
    const t5Dir = join(root, "t5-ovr");
    const t5Path = resolveNativeSessionPath({ env: { HOME: root, QQ_WORKER_SESSION_DIR: t5Dir }, seat: "implementer", production: true, cwd: null });
    assert.ok(t5Path.startsWith(`${t5Dir}/pi-implementer-`), t5Path);
    assert.equal(statSync(t5Dir).mode & 0o777, 0o700);
    assert.equal(statSync(t5Path).mode & 0o777, 0o600);

    // A non-production launch records nothing at all (the exact prior
    // --no-session behavior); a blank override still defaults recording on.
    const t6Before = readdirSync(t4Dir).length;
    assert.equal(resolveNativeSessionPath({ env: { HOME: root }, seat: "runner", production: false }), null);
    assert.equal(readdirSync(t4Dir).length, t6Before);
    const t6Path = resolveNativeSessionPath({ env: { HOME: join(root, "t6-home"), QQ_WORKER_SESSION_DIR: "   " }, seat: "runner", production: true });
    assert.ok(t6Path.startsWith(join(root, "t6-home")), t6Path);

    // Fifty allocations in one directory: unique names, 0600 empty files plus
    // 0600 sidecars, and no stray entries (exactly 50 pairs).
    const t7Dir = join(root, "t7");
    const t7Paths = new Set();
    for (let index = 0; index < 50; index += 1) {
      t7Paths.add(resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t7Dir }, seat: "reviewer", production: false }));
    }
    assert.equal(t7Paths.size, 50);
    for (const path of t7Paths) {
      assert.equal(statSync(path).mode & 0o777, 0o600);
      assert.equal(statSync(path).size, 0);
      assert.equal(statSync(`${path}.meta.json`).mode & 0o777, 0o600);
    }
    assert.equal(readdirSync(t7Dir).length, 100);

    // A collision retries with a fresh exclusive name; exhausting the retries
    // is the named native_session_collision failure.
    const t8Dir = join(root, "t8");
    let t8Calls = 0;
    let t8Winner = null;
    const t8OpenCollide = (path) => {
      t8Calls += 1;
      if (t8Calls <= 2) {
        const error = new Error("x");
        error.code = "EEXIST";
        throw error;
      }
      t8Winner = path;
      return 3;
    };
    const t8Path = resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t8Dir }, seat: "runner", production: false, open: t8OpenCollide, close: () => {} });
    assert.equal(t8Calls, 3);
    assert.equal(t8Winner, t8Path, "the winning exclusive create used the returned path");
    let t8Always = 0;
    const t8OpenAlways = () => {
      t8Always += 1;
      const error = new Error("x");
      error.code = "EEXIST";
      throw error;
    };
    assert.throws(
      () => resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t8Dir }, seat: "runner", production: false, open: t8OpenAlways, close: () => {} }),
      (error) => error.code === "native_session_collision",
    );
    assert.equal(t8Always, 5);

    // An identical timestamp+pid with a varying random suffix still yields
    // distinct exclusive files.
    const t9Dir = join(root, "t9");
    const t9Now = new Date(0);
    let t9Counter = 0;
    const t9Random = () => Buffer.from([t9Counter++, 0, 0, 0, 0, 0]);
    const t9Seen = new Set();
    for (let index = 0; index < 5; index += 1) {
      t9Seen.add(resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t9Dir }, seat: "runner", production: false, now: t9Now, random: t9Random, close: () => {} }));
    }
    assert.equal(t9Seen.size, 5);

    // A relative override is refused without creating anything.
    const t10Dir = join(root, "t10-marker");
    mkdirSync(t10Dir);
    const t10Before = readdirSync(t10Dir).length;
    assert.throws(
      () => resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: "relative/dir" }, seat: "runner", production: false }),
      (error) => error.code === "native_session_dir_invalid",
    );
    assert.equal(readdirSync(t10Dir).length, t10Before);

    // A preexisting symlink at the leaf is never followed.
    const t11Real = join(root, "t11-real");
    mkdirSync(t11Real);
    const t11Link = join(root, "t11-link");
    symlinkSync(t11Real, t11Link);
    assert.throws(
      () => resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t11Link }, seat: "runner", production: false }),
      (error) => error.code === "native_session_dir_invalid",
    );
    assert.equal(readdirSync(t11Real).length, 0, "symlink target untouched");

    // A regular-file leaf is refused.
    const t12File = join(root, "t12-file");
    writeFileSync(t12File, "x\n");
    assert.throws(
      () => resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t12File }, seat: "runner", production: false }),
      (error) => error.code === "native_session_dir_invalid",
    );

    // A preexisting wider-mode directory is refused and NEVER chmodded.
    const t13Dir = join(root, "t13-0755");
    mkdirSync(t13Dir, { mode: 0o755 });
    assert.throws(
      () => resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t13Dir }, seat: "runner", production: false }),
      (error) => error.code === "native_session_dir_unsafe",
    );
    assert.equal(statSync(t13Dir).mode & 0o777, 0o755, "no chmod of the existing directory");

    // An injected lstat proves the ownership and real-directory checks without
    // needing a second uid: a foreign-owned directory and a symlinked stat are
    // both refusals.
    const t14Dir = join(root, "t14-owned-by-other");
    mkdirSync(t14Dir, { mode: 0o700 });
    const t14Foreign = () => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 12345, mode: 0o700 });
    assert.throws(
      () => resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t14Dir }, seat: "runner", production: false, lstat: t14Foreign }),
      (error) => error.code === "native_session_dir_unsafe",
    );
    const t14Linked = () => ({ isDirectory: () => true, isSymbolicLink: () => true, uid: process.getuid(), mode: 0o700 });
    assert.throws(
      () => resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t14Dir }, seat: "runner", production: false, lstat: t14Linked }),
      (error) => error.code === "native_session_dir_invalid",
    );

    // A sidecar write failure removes the just-created session file: no
    // half-associated recording is ever left behind.
    const t15Dir = join(root, "t15");
    const t15WriteFail = () => {
      const error = new Error("disk full");
      error.code = "ENOSPC";
      throw error;
    };
    assert.throws(
      () => resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t15Dir }, seat: "runner", production: false, write: t15WriteFail }),
      (error) => error.code === "native_session_meta_failed",
    );
    assert.equal(readdirSync(t15Dir).length, 0, "no orphan session file left behind");

    // A preexisting sidecar at the allocated name is never overwritten.
    const t16Dir = join(root, "t16");
    let t16Opened = null;
    const t16Open = (path) => {
      t16Opened = path;
      return 3;
    };
    const t16Write = (path) => {
      if (String(path).endsWith(".meta.json")) {
        const error = new Error("exists");
        error.code = "EEXIST";
        throw error;
      }
    };
    assert.throws(
      () => resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t16Dir }, seat: "runner", production: false, open: t16Open, write: t16Write, close: () => {} }),
      (error) => error.code === "native_session_meta_failed",
    );
    assert.ok(t16Opened.endsWith(".jsonl"), t16Opened);

    // A directory-initialization failure is a named refusal with its cause,
    // never a silent fallback to --no-session.
    const t17MkdirFail = () => {
      const error = new Error("denied");
      error.code = "EACCES";
      throw error;
    };
    assert.throws(
      () => resolveNativeSessionPath({ env: { HOME: join(root, "t17") }, seat: "runner", production: true, mkdir: t17MkdirFail }),
      (error) => error.code === "native_session_dir_invalid" && /denied/.test(error.message),
    );

    // An unbound attempt records runnerId null; seat and cwd are recorded.
    const t18Dir = join(root, "t18");
    const t18Path = resolveNativeSessionPath({ env: { QQ_WORKER_SESSION_DIR: t18Dir }, seat: "reviewer", production: false, cwd: "/c" });
    const t18Meta = JSON.parse(readFileSync(`${t18Path}.meta.json`, "utf8"));
    assert.equal(t18Meta.runnerId, null);
    assert.equal(t18Meta.seat, "reviewer");
    assert.equal(t18Meta.cwd, "/c");

    // The adapter source stays syntactically valid (the file every launch
    // re-reads at spawn time).
    const syntax = spawnSync(process.execPath, ["--check", ADAPTER], { encoding: "utf8" });
    assert.equal(syntax.status, 0, syntax.stderr);

    // Through the real adapter process (fake RPC runtime): a production launch
    // allocates the session, prints exactly one bounded payload-free
    // trace-path line, passes --session <path> where --no-session used to sit,
    // and reports the same path as summary.sessionFile with the sidecar bound
    // to this attempt.
    {
      const runnerId = "pi-worker-runner-recording";
      const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
      rmSync(resultFile, { force: true });
      const summaryFile = join(root, "summary-recording.json");
      const result = runAdapter({
        args: ["--production", "--seat", "runner", "--cwd", root, "--prompt", "find it", "--summary-file", summaryFile],
        env: {
          ...adapterEnv({ configFile, name: "recording" }),
          MODEL_API_KEY: "test-key",
          QQ_RUNNER_ID: runnerId,
          QQ_RUNNER_RESULT_FILE: resultFile,
          QQ_FAKE_PI_ANSWER: "FINDINGS: the answer",
        },
      });
      assert.equal(result.status, ADAPTER_EXIT.ok, result.stderr);
      const stderrPaths = [...result.stderr.matchAll(/pi-worker-adapter: native session file: (\S+)/gu)].map((match) => match[1]);
      assert.equal(stderrPaths.length, 1, `exactly one trace-path stderr line (stderr: ${result.stderr})`);
      const sessionPath = stderrPaths[0];
      assert.ok(sessionPath.startsWith(join(root, "state", "qq-workflows", "worker-sessions") + "/pi-runner-"), `the default directory under the fixture state home is used: ${sessionPath}`);
      const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
      assert.equal(summary.sessionFile, sessionPath, "summary carries the same session path");
      const sessionIndex = summary.piArgs.indexOf("--session");
      assert.ok(sessionIndex > 0, "--session present in the runtime argv");
      assert.equal(summary.piArgs[sessionIndex + 1], sessionPath);
      assert.equal(summary.piArgs.includes("--no-session"), false);
      const meta = JSON.parse(readFileSync(`${sessionPath}.meta.json`, "utf8"));
      assert.equal(meta.seat, "runner");
      assert.equal(meta.runnerId, runnerId);
      assert.equal(meta.cwd, root);
      assert.equal(meta.schema, "qq-worker-session-meta/1");
      assert.equal(statSync(sessionPath).mode & 0o777, 0o600);
      rmSync(resultFile, { force: true });
    }

    // A recording-initialization failure refuses the launch BEFORE the runtime
    // is spawned: exit 2, the named diagnostic, and no fake-pi traffic at all.
    {
      const notADir = join(root, "recording-refusal-file");
      writeFileSync(notADir, "x\n");
      const commandLog = join(root, "recording-refusal-commands.log");
      const runnerId = "pi-worker-runner-refusal";
      const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
      rmSync(resultFile, { force: true });
      const result = runAdapter({
        args: ["--production", "--seat", "runner", "--cwd", root, "--prompt", "x"],
        env: {
          ...adapterEnv({ configFile, name: "recording-refusal" }),
          MODEL_API_KEY: "test-key",
          QQ_RUNNER_ID: runnerId,
          QQ_RUNNER_RESULT_FILE: resultFile,
          QQ_WORKER_SESSION_DIR: notADir,
          QQ_FAKE_PI_COMMAND_LOG: commandLog,
        },
      });
      assert.equal(result.status, ADAPTER_EXIT.refused);
      assert.match(result.stderr, /native_session_dir_invalid/);
      assert.equal(existsSync(commandLog), false, "the runtime was never spawned: no session, no provider traffic");
      assert.equal(existsSync(resultFile), false, "nothing lands in the authoritative transport");
      rmSync(resultFile, { force: true });
    }
  }

  // A10. Seat tool policy: explicit per seat, asserted, and never a silent
  // reduction of what the seat's own contract requires. The runner keeps the
  // command execution (tests, reproductions, diagnostics) every previous
  // runtime gave its seat; only the implementer writes.
  assert.deepEqual(WORKER_PI_TOOLS.runner, ["read", "grep", "find", "ls", "bash", "zvec_grep_search"]);
  assert.deepEqual(WORKER_PI_TOOLS.implementer, ["read", "grep", "find", "ls", "bash", "edit", "write", "zvec_grep_search"]);
  assert.deepEqual(WORKER_PI_TOOLS.reviewer, ["read", "grep", "find", "ls", "bash", "zvec_grep_search"]);
  for (const seat of ["runner", "implementer", "reviewer"]) {
    assert.ok(WORKER_PI_TOOLS[seat].includes("bash"), `${seat} must be able to run the commands its contract mandates`);
    assert.ok(WORKER_PI_TOOLS[seat].includes(PI_SEARCH_TOOL), `${seat} keeps the shared root-bound search tool`);
    assert.equal(PI_SEARCH_TOOL, WORKER_SEARCH_TOOL_NAME, "seat instructions name the tool this runtime actually registers");
  }
  assert.equal(WORKER_PI_TOOLS.runner.includes("bash"), true, "the runner's 'Execute assigned tasks, tests, ... and diagnostic commands' must stay executable");
  assert.equal(WORKER_PI_TOOLS.runner.includes("edit") || WORKER_PI_TOOLS.runner.includes("write"), false, "the runner does not own mutation");
  assert.equal(WORKER_PI_TOOLS.reviewer.includes("edit") || WORKER_PI_TOOLS.reviewer.includes("write"), false, "the reviewer does not change project code");

  // A11. Effective seat instructions: the shared contract (written for a seat
  // that has the qq-workflows MCP server) is adapted to this runtime, so what a
  // seat is told and what it can actually call cannot contradict each other.
  const rawRunnerContract = loadRoleContract("runner").body;
  assert.match(rawRunnerContract, /mcp__qq_workflows__complete_task/, "the shared contract still mandates complete_task where an MCP server exposes it");
  for (const seat of ["runner", "implementer", "reviewer"]) {
    const effective = loadPiSeatInstructions(seat);
    assert.equal(effective.source, loadRoleContract(seat).path);
    assert.equal(/mcp__/u.test(effective.body), false, `${seat} instructions must name no MCP tool: this session has no MCP server`);
    assert.equal(effective.body.includes("complete_task"), false, `${seat} instructions must not mandate a tool this runtime cannot expose`);
    assert.ok(effective.body.includes(FINAL_RESPONSE_MAX_CHARS_LABEL), `${seat} instructions must state the shared narrative cap`);
    assert.deepEqual(unavailablePiSeatTools({ body: effective.body, tools: WORKER_PI_TOOLS[seat] }), []);
    for (const name of effective.namedTools) {
      assert.ok(WORKER_PI_TOOLS[seat].includes(name), `tool '${name}' named by the ${seat} instructions must exist in that seat's Pi allowlist`);
    }
  }
  const effectiveRunner = loadPiSeatInstructions("runner");
  assert.deepEqual(effectiveRunner.adaptedSections, ["Completion"]);
  assert.deepEqual(effectiveRunner.namedTools, []);
  assert.match(effectiveRunner.body, /write your final answer as the closing assistant message/);
  assert.match(effectiveRunner.body, /no completion tool/);
  assert.ok(
    effectiveRunner.body.startsWith(rawRunnerContract.slice(0, rawRunnerContract.indexOf("## Completion"))),
    "role boundaries stay verbatim: only the completion section is adapted",
  );
  const effectiveImplementer = loadPiSeatInstructions("implementer");
  assert.deepEqual(effectiveImplementer.adaptedSections, ["Workspace search"]);
  assert.deepEqual(effectiveImplementer.namedTools, [PI_SEARCH_TOOL]);
  assert.match(effectiveImplementer.body, /This runtime exposes `zvec_grep_search`/);
  assert.match(effectiveImplementer.body, /Read the actual files before editing them\./, "seat-specific wording survives adaptation");

  // The shared contract as written is refused for this runtime, and the
  // adaptation is exactly what removes the impossible reference.
  assert.deepEqual(
    unavailablePiSeatTools({ body: rawRunnerContract, tools: WORKER_PI_TOOLS.runner }),
    ["complete_task", "mcp__qq_workflows__complete_task"],
    "the shared runner contract names a tool this runtime cannot expose",
  );
  const adaptedRunner = adaptPiSeatInstructions({ seat: "runner", body: rawRunnerContract, tools: WORKER_PI_TOOLS.runner });
  assert.equal(adaptedRunner.includes("complete_task"), false);
  assert.deepEqual(unavailablePiSeatTools({ body: adaptedRunner, tools: WORKER_PI_TOOLS.runner }), []);

  // The refusal guard is not vacuous: a tool named OUTSIDE the adapted sections
  // (an MCP spelling this runtime has no server for, or a known tool the seat is
  // not allowed) refuses the launch instead of reaching the model.
  const foreignMcp = rawRunnerContract.replace("## Role & Boundaries", "## Role & Boundaries\n- Land your branch with `mcp__qq_workflows__land` when done.");
  assert.throws(
    () => adaptPiSeatInstructions({ seat: "runner", body: foreignMcp, tools: WORKER_PI_TOOLS.runner }),
    (error) => error.code === "instruction_tool_unavailable"
      && /mcp__qq_workflows__land/u.test(error.message)
      && /refusing instead of instructing an impossible action/u.test(error.message),
  );
  const foreignKnownTool = rawRunnerContract.replace("## Role & Boundaries", "## Role & Boundaries\n- Persist notes with `write_to_file`.");
  assert.throws(
    () => adaptPiSeatInstructions({ seat: "runner", body: foreignKnownTool, tools: WORKER_PI_TOOLS.runner }),
    (error) => error.code === "instruction_tool_unavailable" && /write_to_file/u.test(error.message),
  );
  const implementerView = adaptPiSeatInstructions({ seat: "implementer", body: foreignKnownTool, tools: WORKER_PI_TOOLS.implementer });
  assert.ok(
    implementerView.includes("`write_to_file`"),
    "the guard is seat-specific: the same reference resolves against the implementer allowlist and is left as written",
  );
  for (const seat of ["runner", "implementer", "reviewer"]) {
    const seatArgs = buildPiArgs({
      seat,
      config: launch.config,
      extension: WORKER_PI_EXTENSION,
      tools: WORKER_PI_TOOLS[seat],
      roleInstructions: loadPiSeatInstructions(seat).body,
    });
    const allowlist = new Set(seatArgs[seatArgs.indexOf("--tools") + 1].split(","));
    const systemPrompt = seatArgs[seatArgs.indexOf("--append-system-prompt") + 1];
    assert.equal(systemPrompt, loadPiSeatInstructions(seat).body);
    for (const name of referencedToolNames(systemPrompt)) {
      assert.ok(allowlist.has(name), `the ${seat} system prompt names '${name}' but '--tools' does not allow it`);
    }
  }

  // R1. RPC framing is LF-only JSONL.
  assert.deepEqual(splitRecords("a\nb\r\npartial"), { records: ["a", "b"], rest: "partial" });
  assert.equal(encodeCommand({ type: "abort" }), '{"type":"abort"}\n');

  // S1. Shared ZG tool: every worker seat gets it, root-bound, with the injected
  // fields removed from the model-facing schema.
  assert.deepEqual([...WORKER_SEARCH_SEATS].sort(), ["implementer", "reviewer", "runner"]);
  const schema = workerSearchToolSchema();
  for (const field of INJECTED_SEARCH_FIELDS) {
    assert.equal(schema.properties?.[field], undefined, `'${field}' must not be model-settable`);
    assert.equal(schema.required?.includes(field) ?? false, false);
  }
  const searchRoot = join(root, "worktree");
  mkdirSync(searchRoot, { recursive: true });
  const binding = resolveWorkerSearchBinding({ seat: "runner", root: searchRoot });
  assert.equal(binding.root, searchRoot);
  assert.throws(() => resolveWorkerSearchBinding({ seat: "runner", root: join(root, "missing") }), /not an existing directory/);
  assert.throws(() => resolveWorkerSearchBinding({ seat: "architect", root: searchRoot }), /must be one of/);
  const searchEnv = workerSearchEnv({ seat: "reviewer", root: searchRoot, env: {} });
  assert.equal(searchEnv.seat, "reviewer");
  assert.equal(searchEnv.root, searchRoot);

  const registered = [];
  const calls = [];
  const pi = { registerTool: (tool) => registered.push(tool) };
  const extension = createWorkerToolsExtension(pi, {
    env: { QQ_ZVEC_GREP_SEAT: "implementer", QQ_ZVEC_GREP_ROOT: searchRoot },
    cwd: searchRoot,
    gateway: {
      search: async (args) => {
        calls.push(args);
        return { content: [{ type: "text", text: "No matches." }] };
      },
      close: async () => {},
    },
  });
  await extension.register();
  assert.deepEqual(registered.map((tool) => tool.name), [WORKER_SEARCH_TOOL_NAME]);
  assert.equal(registered[0].parameters.properties.root, undefined);
  const toolResult = await registered[0].execute("call-1", { query: "needle" }, undefined);
  assert.deepEqual(calls[0], { query: "needle" }, "only the caller's query reaches the gateway");
  assert.equal(toolResult.content[0].text, "No matches.");
  assert.equal(toolResult.details.root, searchRoot, "the tool result reports the bound root for auditability");
  await extension.close();

  // P1. Preflight: the pi adapter source is part of the installed integration.
  assert.equal(
    assertWorkerLaunchSource({ plan: { harness: PI_HARNESS, adapter: join(repoRoot, "workflow", "pi-worker", "adapter.mjs") } }).harness,
    PI_HARNESS,
  );
  assert.throws(
    () => assertWorkerLaunchSource({ plan: { harness: PI_HARNESS, adapter: join(root, "missing.mjs") }, exists: () => false }),
    /no adapter source at/,
  );
  const plan = resolveWorkerLaunchPlan({ role: "runner", env });
  const spawnPlan = planToSpawn(plan, { prompt: "p", cwd: root, env, mcpEnv: { QQ_RUNNER_ID: "r1", QQ_RUNNER_RESULT_FILE: join(tmpdir(), "r1.json") } });
  assert.equal(spawnPlan.executable.harness, PI_HARNESS);
  assert.equal(spawnPlan.executable.pi, fakePi);
  assert.equal(spawnPlan.args[1], "--production");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("Pi worker runtime tests passed (fake RPC runtime, no provider calls).");
