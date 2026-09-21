#!/usr/bin/env node
/**
 * Acceptance 9: the notification wait tolerates a quiet harness.
 *
 * Regression for the adapter defect where `nextNotification`'s timeout
 * callback referenced the promise executor's `resolve` from outside its scope,
 * so any window longer than the bounded wait (30s in `adapter/worker.mjs`)
 * killed the adapter with `ReferenceError: resolve is not defined` instead of
 * simply waiting again. That breaks the primary agent-loop envelope: a shell
 * command that runs longer than 30s (builds, test suites, installs, downloads)
 * leaves the runtime quiet for exactly that window.
 *
 * Part A exercises the bounded-wait timeout directly (fast, deterministic).
 * Part B reproduces the realistic case end-to-end through the production
 * entrypoint: one `sleep` > 30s, then a closing answer.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessClient } from "../adapter/harness-client.mjs";
import { startMockProvider } from "../mock/mock-provider.mjs";
import { buildWorkerLaunch } from "../../../workflow/worker-config.mjs";
import { cleanOutput, isolatedRuntime, parseLines, runLaunch, scrubRoutingEnv, tempDir } from "./harness.mjs";

// Keep the test process away from any live session routing.
scrubRoutingEnv();
process.env.QQ_CODEX_BIN = "/usr/bin/true";

const workdir = tempDir("t9");
// A private root materialized by the same setup-runtime.mjs the deployment
// runs, so these cases never depend on - or write to - the shared root.
const RUNTIME_ROOT = isolatedRuntime();
const QUIET_WINDOW_MS = 33_000;

// --- A. the bounded wait itself -------------------------------------------
{
  // A stub runtime that stays silent past the requested window, then emits one
  // notification. Before the fix the timeout callback threw a ReferenceError
  // that escaped the promise and crashed this process.
  const script = [
    "setTimeout(() => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session.event', params: { seq: 1 } }) + '\\n'), 700);",
    "setInterval(() => {}, 1000);",
  ].join("");
  const client = new HarnessClient({
    launch: { bin: process.execPath, args: ["-e", script], cwd: workdir },
    env: { ...process.env },
  });
  const started = Date.now();
  const first = await client.nextNotification(250);
  const elapsed = Date.now() - started;
  assert.equal(first, undefined, "a quiet window must resolve to undefined, never throw");
  assert.ok(elapsed >= 200, `the wait must honor the requested bound (waited ${elapsed}ms)`);
  assert.ok(elapsed < 10_000, `the wait must not hang past the bound (waited ${elapsed}ms)`);
  // The timed-out waiter must be gone: a later notification still lands.
  const second = await client.nextNotification(5_000);
  assert.equal(second?.method, "session.event", "the client must keep working after a timeout");
  assert.equal(second?.params?.seq, 1);
  await client.stop({ gracefulMs: 50, signalWaitMs: 500 });
}

// --- B. a >30s quiet tool call through the production entrypoint ----------
{
  const configFile = join(workdir, "worker-config.json");
  const mock = await startMockProvider({
    scenario: {
      turns: [
        { blocks: [{ type: "tool_use", name: "bash", input: { command: `sleep ${QUIET_WINDOW_MS / 1000}; echo LONG_DONE` } }], stopReason: "tool_use" },
        { blocks: [{ type: "text", text: "FINAL: long command finished" }], stopReason: "end_turn" },
      ],
    },
  });
  writeFileSync(configFile, JSON.stringify({
    provider: "deepseek",
    model: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    wire_api: "responses",
    env_key: "DEEPSEEK_API_KEY",
    api_key_file: join(workdir, "missing-key-file"),
    harness: "deepseek-minimal",
    reasoning_effort: "max",
    max_output_tokens: 2048,
    messages_base_url: mock.url,
  }));
  const env = {
    ...process.env,
    QQ_WORKER_CONFIG_FILE: configFile,
    QQ_DEEPSEEK_RUNTIME_ROOT: RUNTIME_ROOT,
    DEEPSEEK_API_KEY: "t9-production-key",
  };
  for (const key of ["QQ_RUNNER_ID", "QQ_RUNNER_RESULT_FILE", "QQ_RUNNER_MARKER_FILE", "QQ_SUBAGENT_BIN"]) delete env[key];

  const launch = buildWorkerLaunch({ seat: "implementer", cwd: workdir, prompt: "run the long command", env });
  assert.equal(launch.harness, "deepseek-minimal", "the case must go through the production harness selection");
  const started = Date.now();
  const res = await runLaunch(launch, { cwd: workdir, timeoutMs: 180_000 });
  const requests = mock.messageRequests;
  await mock.close();

  const quiet = Date.now() - started;
  assert.equal(res.code, 0, `a quiet harness must not kill the worker: ${res.stderr}`);
  assert.ok(!/ReferenceError/u.test(res.stderr), `no ReferenceError may escape: ${res.stderr}`);
  assert.equal(cleanOutput(parseLines(res.stdout)), "FINAL: long command finished", "the task must complete after the quiet window");
  assert.ok(quiet >= QUIET_WINDOW_MS, `the shell must actually outlive the bounded wait (ran ${quiet}ms)`);
  assert.equal(requests.length, 2, "one request per scripted turn; the loop survived the quiet window");
  const toolText = requests.at(-1).toolResults.map(entry => entry.text).join("\n");
  assert.match(toolText, /LONG_DONE/u, "the long command's output must reach the model");
}

console.log("ok t9-quiet-window");
console.log(JSON.stringify({ runtimeRoot: RUNTIME_ROOT, quietWindowMs: QUIET_WINDOW_MS }, null, 2));
