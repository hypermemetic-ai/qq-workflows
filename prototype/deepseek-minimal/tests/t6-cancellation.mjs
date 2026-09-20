#!/usr/bin/env node
/**
 * Acceptance 6: cancelling a prototype worker that is running a long-lived
 * shell child shuts down the adapter, the harness, and the shell descendants
 * within a bounded time, covering both the graceful and the forced path, and
 * leaving no orphan processes. Only this run's own processes are touched.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startMockProvider } from "../mock/mock-provider.mjs";
import { HarnessClient } from "../adapter/harness-client.mjs";
import { isolatedRuntime, scrubRoutingEnv, tempDir, WORKER } from "./harness.mjs";

scrubRoutingEnv();

// A private runtime root materialized by the same setup-runtime.mjs the
// deployment runs: an implementer seat needs the materialized search gateway,
// and no test writes to the operator's shared root.
const RUNTIME = isolatedRuntime();

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** True while the pid exists (signal 0 probe). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Direct children of one pid, read from /proc (this run's processes only). */
function spawnList(pid) {
  const pids = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const ppid = Number(stat.slice(close + 2).split(" ")[1]);
      if (ppid === pid) pids.push(Number(entry));
    } catch {
      /* process vanished mid-scan */
    }
  }
  return pids;
}

async function waitGone(pid, timeoutMs, label) {
  await waitFor(() => !alive(pid), timeoutMs, `${label} (pid ${pid}) to exit`);
}

// --- A. real harness running a real long-lived shell child ------------------
const workdir = tempDir("t6");
const pidFile = join(workdir, "grandchild.pid");
const command = `bash -c 'sleep 601 & echo $! > ${pidFile}; wait'`;
const mock = await startMockProvider({
  scenario: { turns: [{ blocks: [{ type: "tool_use", name: "bash", input: { command } }], stopReason: "tool_use" }] },
});
const worker = spawn(process.execPath, [
  WORKER, "--seat", "implementer", "--cwd", workdir, "--prompt", "start a long-lived child",
  "--base-url", mock.url, "--summary-file", join(workdir, "summary.json"),
], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, QQ_DEEPSEEK_RUNTIME_ROOT: RUNTIME } });
let workerStderr = "";
worker.stderr.on("data", (chunk) => { workerStderr += chunk; });

const grandchild = Number(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim(), 90_000, "the shell grandchild pid file"));
assert.ok(Number.isInteger(grandchild) && grandchild > 0, "a grandchild pid must be recorded");
const harness = await waitFor(() => {
  const child = spawnList(worker.pid);
  return child.length > 0 ? child[0] : 0;
}, 60_000, "the harness child of the worker");
assert.equal(alive(grandchild), true, "the long-lived shell grandchild must be running before cancel");
assert.equal(alive(harness), true, "the harness must be running before cancel");

const cancelStart = Date.now();
worker.kill("SIGTERM");
const exit = await new Promise((resolve) => worker.on("close", (code, signal) => resolve({ code, signal })));
const cancelMs = Date.now() - cancelStart;
assert.equal(exit.code, 143, `a cancelled worker must exit 143, got ${JSON.stringify(exit)}`);
assert.ok(cancelMs < 15_000, `cancellation must be bounded, took ${cancelMs}ms`);
assert.match(workerStderr, /received SIGTERM/u);
assert.match(workerStderr, /cancel teardown/u);
await waitGone(harness, 5_000, "harness");
await waitGone(grandchild, 10_000, "shell grandchild");
await mock.close();

// --- B. graceful teardown of an idle real runtime ---------------------------
const { resolveRuntime, harnessEnv } = await import("../adapter/runtime.mjs");
const idleRuntime = resolveRuntime({ seat: "implementer", baseUrl: "http://127.0.0.1:9", cwd: workdir, runtimeRoot: RUNTIME });
const idle = new HarnessClient({ launch: idleRuntime.launch, env: harnessEnv({ runtime: idleRuntime }) });
await idle.initialize({ cwd: workdir, provider: idleRuntime.provider, model: idleRuntime.model, reasoningEffort: idleRuntime.reasoningEffort, maxTokens: 1_024 });
const gracefulJournal = await idle.stop();
assert.deepEqual(gracefulJournal, [{ step: "shutdown-request", ok: true }], `an idle runtime must shut down gracefully: ${JSON.stringify(gracefulJournal)}`);
assert.equal(idle.running, false);

// --- C. forced escalation when the harness ignores SIGTERM ------------------
const stubborn = new HarnessClient({
  launch: { bin: "/bin/bash", args: ["-c", 'trap "" TERM; sleep 602 & echo $! > "$0"; wait', join(tempDir("t6-force"), "child.pid")], cwd: "/tmp" },
  env: { ...process.env },
});
assert.equal(stubborn.running, true);
const journal = await stubborn.stop({ gracefulMs: 300, signalWaitMs: 1_000 });
assert.ok(journal.some(entry => entry.step === "sigterm-group"), "the graceful group signal must be attempted");
assert.ok(journal.some(entry => entry.step === "sigkill-group"), "a stubborn process must be force-killed");
assert.equal(stubborn.running, false, "the forced path must leave no running process");

console.log("ok t6-cancellation");
console.log(JSON.stringify({ cancelMs, exit, journal, gracefulJournal, workerStderr: workerStderr.trim().split("\n") }, null, 2));
