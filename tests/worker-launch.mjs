#!/usr/bin/env node
// Focused offline tests for the central DeepSeek-Flash worker launch path.
// These tests inject their own operator config file so they never depend on
// (or touch) the real operator configuration or runner identity.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WORKER_MODEL,
  WORKER_PROVIDER,
  WORKER_REASONING_EFFORT_LEVELS,
  WORKER_SEATS,
  buildWorkerLaunch,
  loadWorkerConfig,
  loadRoleContract,
  workerRoleInstructionsPath,
} from "../workflow/worker-config.mjs";
import { runChildSubagent } from "../bin/mcp-server.mjs";
import { FINAL_RESPONSE_MAX_CHARS_LABEL } from "../workflow/limits.mjs";

const root = mkdtempSync(join(tmpdir(), "qq-worker-launch-"));
const configFile = join(root, "worker-config.json");
writeFileSync(configFile, JSON.stringify({
  provider: "deepseek",
  model: "deepseek-flash",
  base_url: "https://api.deepseek.com",
  wire_api: "responses",
  env_key: "DEEPSEEK_API_KEY",
  api_key_file: join(root, "missing-key-file"),
}));

const env = {
  ...process.env,
  QQ_WORKER_CONFIG_FILE: configFile,
  QQ_WORKER_CODEX_HOME: join(root, "codex-home"),
  DEEPSEEK_API_KEY: "sentinel-secret-key-value",
  QQ_RUNNER_ID: "outer-runner-must-not-leak",
  QQ_RUNNER_RESULT_FILE: "/tmp/outer-runner-must-not-leak.json",
  CODEX_THREAD_ID: "outer-thread-must-not-leak",
  QQ_IMPLEMENTER_PROVIDER: "gemini",
  QQ_RESEARCHER_PROVIDER: "gemini",
};
delete env.QQ_SUBAGENT_BIN;

const ALT_PROVIDER = /(^|[\s"'=;[\]{}(,:-])(agy|muse|dsh)(?=$|[\s"'=;\]}),:-])/;

function assertDeepSeekLaunch(launch) {
  const argv = launch.args.join(" ");
  assert.ok(launch.args[0] === "exec", "worker launch must be `codex exec`");
  assert.ok(argv.includes(`model="${WORKER_MODEL}"`), "worker model must be deepseek-flash");
  assert.ok(argv.includes(`model_provider="${WORKER_PROVIDER}"`), "worker provider must be deepseek");
  assert.ok(argv.includes('base_url="https://api.deepseek.com"'));
  assert.ok(argv.includes('wire_api="responses"'));
  assert.ok(argv.includes("requires_openai_auth=false"));
  assert.ok(argv.includes("request_max_retries=0"));
  assert.ok(argv.includes("stream_max_retries=0"));
  assert.ok(argv.includes("features.multi_agent=false"));
  assert.ok(argv.includes("--ignore-user-config"));
  assert.ok(argv.includes("--dangerously-bypass-approvals-and-sandbox"));
  // Never a per-call provider/profile flag.
  assert.doesNotMatch(argv, /--profile|--agent\s|--model\s+gemini|--preset/);
  // No alternative provider binary anywhere in argv.
  assert.doesNotMatch(argv, ALT_PROVIDER, `worker argv must not name an alternative provider: ${argv}`);
}

// L1. Every worker seat launches through the same pinned DeepSeek path. There
// are exactly three seats: the retired `researcher` seat is rejected, never
// aliased.
assert.deepEqual(WORKER_SEATS, ["runner", "implementer", "reviewer"], "there are exactly three worker seats");
for (const seat of WORKER_SEATS) {
  const launch = buildWorkerLaunch({ seat, cwd: "/tmp", prompt: "hi", env, mcpEnv: { QQ_RUNNER_ID: "r1", QQ_RUNNER_RESULT_FILE: "/tmp/r1.json" } });
  assertDeepSeekLaunch(launch);
  assert.equal(launch.config.provider, "deepseek");
  assert.equal(launch.config.model, "deepseek-flash");
  // Secrets never enter argv.
  assert.ok(!launch.args.some((a) => a.includes("sentinel-secret-key-value")), "api key must never appear in argv");
  assert.equal(launch.env.DEEPSEEK_API_KEY, "sentinel-secret-key-value");
  assert.equal(launch.env.CODEX_HOME, join(root, "codex-home"));
  // Live runner identity and notification routing never leak into workers.
  assert.equal(launch.env.CODEX_THREAD_ID, undefined, "worker must not inherit CODEX_THREAD_ID");
  assert.equal(launch.env.QQ_IMPLEMENTER_PROVIDER, undefined, "legacy provider env must be scrubbed");
  assert.equal(launch.env.QQ_RESEARCHER_PROVIDER, undefined, "legacy researcher provider env must be scrubbed");
  // Completion transport paths are confined to the runner MCP server config
  // (`mcp_servers.qq-workflows.env`), never the general Codex shell env, so a
  // subprocess or test running under a worker cannot inherit them. Runner
  // identity itself is deliberately retained for the hooks.
  assert.equal(launch.env.QQ_RUNNER_RESULT_FILE, undefined, `${seat} child env must not carry QQ_RUNNER_RESULT_FILE`);
  assert.equal(launch.env.QQ_RUNNER_MARKER_FILE, undefined, `${seat} child env must not carry QQ_RUNNER_MARKER_FILE`);
  if (seat !== "runner") {
    assert.equal(launch.env.QQ_RUNNER_ID, undefined, `${seat} must not inherit QQ_RUNNER_ID`);
  } else {
    assert.equal(launch.env.QQ_RUNNER_ID, "r1", "runner must retain its own identity, not the inherited one");
    assert.notEqual(launch.env.QQ_RUNNER_ID, "outer-runner-must-not-leak");
  }
}

// L2. Only the runner receives an MCP server, and only complete_task.
{
  const runner = buildWorkerLaunch({ seat: "runner", cwd: "/tmp", prompt: "hi", env, mcpEnv: { QQ_RUNNER_ID: "r2", QQ_RUNNER_RESULT_FILE: "/tmp/r2.json" } });
  const runnerArgv = runner.args.join(" ");
  assert.ok(runnerArgv.includes("mcp_servers.qq-workflows.command=\"node\""), "runner must configure the MCP server");
  assert.ok(runnerArgv.includes("--enabled-tools"));
  assert.ok(runnerArgv.includes("complete_task"));
  assert.ok(!runnerArgv.includes("dispatch_runner"), "runner MCP allow-list must exclude workflow control tools");
  assert.equal(runner.env.QQ_RUNNER_ID, "r2");
  // The transport path reaches only the MCP server (config env table), not the
  // shell env that subprocesses inherit.
  assert.equal(runner.env.QQ_RUNNER_RESULT_FILE, undefined, "runner shell env must not carry the transport path");
  assert.ok(
    runnerArgv.includes('QQ_RUNNER_RESULT_FILE="/tmp/r2.json"'),
    "completion MCP server must still receive the transport path",
  );

  for (const seat of ["implementer", "reviewer"]) {
    const launch = buildWorkerLaunch({ seat, cwd: "/tmp", prompt: "hi", env });
    assert.ok(!launch.args.join(" ").includes("mcp_servers.qq-workflows"), `${seat} must not configure workflow MCP tools`);
  }
}

// L3. Fail-closed validation: any non-DeepSeek-Flash pin throws, no fallback.
{
  const badProvider = join(root, "bad-provider.json");
  writeFileSync(badProvider, JSON.stringify({ provider: "muse", model: "deepseek-flash" }));
  assert.throws(() => loadWorkerConfig({ env, file: badProvider }), /worker provider 'muse' is not authorized/);

  const badModel = join(root, "bad-model.json");
  writeFileSync(badModel, JSON.stringify({ provider: "deepseek", model: "deepseek-v4-pro" }));
  assert.throws(() => loadWorkerConfig({ env, file: badModel }), /worker model 'deepseek-v4-pro' is not authorized/);

  const badJson = join(root, "bad.json");
  writeFileSync(badJson, "{ not json");
  assert.throws(() => loadWorkerConfig({ env, file: badJson }), /not valid JSON/);

  assert.throws(
    () => buildWorkerLaunch({ seat: "implementer", cwd: "/tmp", prompt: "x", env, config: { provider: "gemini", model: "deepseek-flash" } }),
    /worker provider 'gemini' is not authorized|not authorized/,
  );
}

// L3b. Operator reasoning effort: one canonical validated field, emitted
// verbatim as the Codex model_reasoning_effort override for every seat, and
// absent unless the operator explicitly configures it.
{
  const baseConfig = {
    provider: "deepseek",
    model: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    wire_api: "responses",
    env_key: "DEEPSEEK_API_KEY",
    api_key_file: join(root, "missing-key-file"),
  };
  const writeEffortConfig = (name, extra = {}) => {
    const file = join(root, `effort-${name}.json`);
    writeFileSync(file, JSON.stringify({ ...baseConfig, ...extra }));
    return file;
  };
  const overrideArg = (level) => `model_reasoning_effort="${level}"`;

  // Supported backend levels normalize to the canonical level.
  assert.deepEqual(WORKER_REASONING_EFFORT_LEVELS, ["low", "high", "max"]);
  for (const [name, extra, expected] of [
    ["max-raw", { reasoning_effort: "max" }, "max"],
    ["high-camel", { reasoningEffort: "high" }, "high"],
    ["low-padded", { reasoning_effort: "  LOW " }, "low"],
  ]) {
    const config = loadWorkerConfig({ env, file: writeEffortConfig(name, extra) });
    assert.equal(config.reasoningEffort, expected, `${name} must normalize to '${expected}'`);
    // The non-effort fields and API-key handling are untouched by the new field.
    assert.equal(config.provider, "deepseek");
    assert.equal(config.model, "deepseek-flash");
    assert.equal(config.baseUrl, "https://api.deepseek.com");
    assert.equal(config.wireApi, "responses");
    assert.equal(config.envKey, "DEEPSEEK_API_KEY");
    assert.equal(config.apiKeyFile, join(root, "missing-key-file"));
  }

  // Absent field: no default is invented and no override is emitted.
  const defaultConfig = loadWorkerConfig({ env, file: writeEffortConfig("absent") });
  assert.equal(defaultConfig.reasoningEffort, null);
  for (const seat of WORKER_SEATS) {
    const launch = buildWorkerLaunch({ seat, cwd: "/tmp", prompt: "hi", env, config: { ...baseConfig } });
    assert.equal(launch.config.reasoningEffort, null);
    assert.ok(
      !launch.args.some((a) => a.startsWith("model_reasoning_effort")),
      `${seat} must not emit a reasoning effort override when the field is absent`,
    );
  }

  // Exact `max` override (never xhigh/ultra) for every configured seat.
  for (const seat of WORKER_SEATS) {
    const launch = buildWorkerLaunch({
      seat, cwd: "/tmp", prompt: "hi", env,
      config: { ...baseConfig, reasoning_effort: "max" },
      mcpEnv: { QQ_RUNNER_ID: "effort-runner", QQ_RUNNER_RESULT_FILE: "/tmp/effort-runner.json" },
    });
    assertDeepSeekLaunch(launch);
    assert.equal(launch.config.reasoningEffort, "max");
    const at = launch.args.indexOf(overrideArg("max"));
    assert.ok(at > 0, `${seat} argv must carry ${overrideArg("max")}`);
    assert.equal(launch.args[at - 1], "-c", "reasoning effort must be a -c config override");
    assert.equal(
      launch.args.filter((a) => a.startsWith("model_reasoning_effort")).length,
      1,
      `${seat} must carry exactly one reasoning effort override`,
    );
    const argv = launch.args.join(" ");
    assert.doesNotMatch(argv, /xhigh|ultra|"maximum"/, `${seat} must not translate the configured level: ${argv}`);
  }

  // Unsupported levels fail closed with the field name and the accepted values.
  for (const bad of ["ultra", "xhigh", "medium", "minimal", "maximum", "", 3, true, ["max"]]) {
    assert.throws(
      () => loadWorkerConfig({ env, file: writeEffortConfig("bad", { reasoning_effort: bad }) }),
      (err) => /reasoning_effort/.test(err.message) && /low, high, max/.test(err.message),
      `reasoning_effort ${JSON.stringify(bad)} must be rejected clearly`,
    );
  }
  // Unknown keys stay dropped, so a typo'd effort field is never honored.
  const typoConfig = loadWorkerConfig({ env, file: writeEffortConfig("typo", { reasoning_effort_max: true }) });
  assert.equal(typoConfig.reasoningEffort, null);
}

// L4. Role contracts are the repository contracts (prose preserved, frontmatter
// dropped); the runner contract requires complete_task.
{
  const runnerRole = loadRoleContract("runner");
  // The runner contract requires complete_task, names the exact qualified
  // client spelling mcp__qq_workflows__complete_task (not a discover-your-
  // spelling deferral), and tells the worker to correct and retry a rejected
  // call.
  assert.match(runnerRole.body, /call `mcp__qq_workflows__complete_task`/);
  assert.match(runnerRole.body, /`complete_task`/);
  assert.doesNotMatch(runnerRole.body, /whatever qualified\/namespaced spelling/);
  assert.doesNotMatch(runnerRole.body, /your harness registers/);
  assert.match(runnerRole.body, /correct the call, and retry/);
  assert.ok(!runnerRole.body.startsWith("---"), "role frontmatter must be dropped");
  // Every seat states the one shared final-answer cap (characters, not
  // tokens); none may restate a stale literal.
  const capPhrase = new RegExp(`${FINAL_RESPONSE_MAX_CHARS_LABEL}-character`, "u");
  assert.match(runnerRole.body, capPhrase);
  assert.match(runnerRole.body, /fail-closed, never truncated/u);
  assert.doesNotMatch(runnerRole.body, /32,768/u);
  const implementerRole = loadRoleContract("implementer");
  assert.match(implementerRole.body, /You are the implementer/);
  assert.match(implementerRole.body, capPhrase);
  assert.doesNotMatch(implementerRole.body, /32,768/u);
  const reviewerRole = loadRoleContract("reviewer");
  assert.match(reviewerRole.body, /Verdict: PASS or FAIL/);
  assert.match(reviewerRole.body, capPhrase);
  assert.doesNotMatch(reviewerRole.body, /32,768/u);

  const launch = buildWorkerLaunch({ seat: "runner", cwd: "/tmp", prompt: "x", env });
  const instructionsPath = workerRoleInstructionsPath("runner", env);
  assert.ok(launch.args.join(" ").includes(instructionsPath), "launch must point at the materialized role contract");
  assert.ok(existsSync(instructionsPath));
  assert.match(readFileSync(instructionsPath, "utf8"), /complete_task/);
}

// L5. runChildSubagent ignores its provider argument and always launches the
// central DeepSeek worker (no agy/muse/dsh).
{
  const fakeBinDir = mkdtempSync(join(root, "fake-bin-"));
  const logPath = join(fakeBinDir, "call.txt");
  const fakePath = join(fakeBinDir, "fake-codex.sh");
  writeFileSync(fakePath, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${logPath}"\necho probe > subagent-probe.txt\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"Verdict: PASS"}}'\n`);
  execFileSync("chmod", ["+x", fakePath]);
  const subEnv = { ...process.env, QQ_WORKER_CONFIG_FILE: configFile, QQ_WORKER_CODEX_HOME: join(root, "codex-home"), QQ_SUBAGENT_BIN: fakePath, DEEPSEEK_API_KEY: "sentinel-secret-key-value" };
  delete subEnv.QQ_RUNNER_ID;
  delete subEnv.QQ_RUNNER_RESULT_FILE;
  const prev = {};
  for (const k of Object.keys(subEnv)) {
    prev[k] = process.env[k];
    process.env[k] = subEnv[k];
  }
  try {
    const exec = { id: "l5", trajectory: [], activeTool: null, activeChild: null };
    const res = await runChildSubagent(exec, { role: "reviewer", cwd: fakeBinDir, prompt: "review it", provider: "gemini" });
    assert.equal(res.ok, true, JSON.stringify(res));
    const argv = readFileSync(logPath, "utf8");
    assert.ok(argv.includes('model="deepseek-flash"'), "child subagent must launch deepseek-flash");
    assert.doesNotMatch(argv, ALT_PROVIDER, `child subagent must not name an alternative provider: ${argv}`);
    assert.match(res.output, /Verdict: PASS/);
  } finally {
    for (const k of Object.keys(subEnv)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
  rmSync(fakeBinDir, { recursive: true, force: true });
}

// L6. Conflicting legacy provider env fails closed at the launch boundary.
{
  const launchEnv = { ...env, QQ_IMPLEMENTER_PROVIDER: "gemini" };
  // buildWorkerLaunch itself is env-config driven, not seat-env driven, so it
  // still pins DeepSeek; the entry-point guard is covered in mcp.mjs.
  const launch = buildWorkerLaunch({ seat: "implementer", cwd: "/tmp", prompt: "x", env: launchEnv });
  assert.deepEqual(launch.config.provider, "deepseek");
}

// L7. The retired researcher seat is rejected at every launch boundary, and an
// explicit `--seat researcher` is refused rather than aliased onto the runner.
{
  assert.throws(
    () => buildWorkerLaunch({ seat: "researcher", cwd: "/tmp", prompt: "x", env }),
    /unknown worker seat 'researcher'/,
  );
  const workerExec = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "worker-exec.mjs");
  const refused = spawnSync(
    process.execPath,
    [workerExec, "--seat", "researcher", "--cwd", "/tmp", "--prompt", "x"],
    { env, encoding: "utf8" },
  );
  assert.equal(refused.status, 2, `worker-exec must reject --seat researcher: ${refused.stderr}`);
  assert.match(refused.stderr, /--seat must be one of runner, implementer, reviewer/);
  assert.doesNotMatch(refused.stderr, /--seat researcher/);
}

rmSync(root, { recursive: true, force: true });
console.log("Worker launch tests passed cleanly.");
