/**
 * Shared helpers for the prototype's runtime tests.
 *
 * Every test owns its own temp workdir, its own mock provider on a random
 * loopback port, and its own dsh session id. No test touches the operator's
 * configuration, credentials, or installed `dsh`.
 *
 * @module tests/harness
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deepSeekMinimalRuntimeRoot } from "../../../workflow/worker-config.mjs";
import { setup } from "../scripts/setup-runtime.mjs";

export const PROTOTYPE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(dirname(PROTOTYPE_ROOT));
export const WORKER = join(PROTOTYPE_ROOT, "adapter", "worker.mjs");

/**
 * Generated receipts live under the gitignored `.architect/artifacts` tree, so
 * a test run never rewrites committed source evidence.
 */
export function evidenceDir() {
  const dir = join(REPO_ROOT, ".architect", "artifacts", "deepseek-minimal", "evidence");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Remove live-session routing from this process before it touches parent code
 * (`completeTask`, `notifySession`): tests must never wake an operator thread.
 */
export function scrubRoutingEnv(env = process.env) {
  for (const key of [
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CODEX_CONVERSATION_ID",
    "QQ_RUNNER_ID",
    "QQ_RUNNER_RESULT_FILE",
    "QQ_RUNNER_MARKER_FILE",
    "QQ_IMPLEMENTER_PROVIDER",
    "QQ_REVIEWER_PROVIDER",
    "QQ_RESEARCHER_PROVIDER",
    "QQ_WORKFLOW_PROVIDER",
  ]) delete env[key];
  return env;
}

/** Prototype-owned temp directory (never a broad shared path). */
export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `proto-${prefix}-`));
}

let isolatedRuntimeRoot;

/**
 * Materialize (once per test process) a PRIVATE runtime root that reuses the
 * already-built pinned upstream checkout. Tests must never run against - or
 * write into - the operator's production runtime root, and a private root is
 * also the only way to exercise the seat-scoped search gateway that
 * `setup-runtime.mjs` materializes alongside the read_image overlay.
 */
export function isolatedRuntime() {
  if (isolatedRuntimeRoot === undefined) {
    const productionRoot = deepSeekMinimalRuntimeRoot();
    const upstream = join(productionRoot, "upstream");
    assert.ok(existsSync(upstream), `the pinned production runtime must be materialized at ${productionRoot} before this suite runs`);
    const root = mkdtempSync(join(tmpdir(), "proto-runtime-"));
    setup({ runtimeRoot: root, upstreamRoot: upstream, skipBuild: true });
    isolatedRuntimeRoot = root;
  }
  return isolatedRuntimeRoot;
}

/** Launch/child environment for a worker run: the private runtime root, never the operator's. */
export function workerEnv(extra = {}) {
  return { ...process.env, QQ_DEEPSEEK_RUNTIME_ROOT: isolatedRuntime(), ...extra };
}

/**
 * File URL of one dependency of the materialized gateway, resolved through the
 * gateway's own `node_modules` (the private runtime root's copies). Tests use
 * this to speak real MCP to the gateway and to their stub servers without
 * gaining a repo-level dependency on the pinned runtime.
 */
export function sdkModuleUrl(runtimeRoot, packageName, subpath = ".") {
  const dir = join(runtimeRoot, "gateway", "node_modules", ...packageName.split("/"));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const entry = pkg.exports?.[subpath];
  const relative = typeof entry === "string"
    ? entry
    : (entry?.import?.default ?? entry?.import ?? entry?.default ?? entry);
  assert.equal(typeof relative, "string", `${packageName}${subpath} must resolve to a module path`);
  return pathToFileURL(join(dir, relative)).href;
}

/**
 * Run one worker process to completion.
 * @returns `{code, stdout, stderr, lines}` where lines are parsed JSON events.
 */
export function runWorker(args, { env = workerEnv(), timeoutMs = 180_000 } = {}) {
  const child = spawn(process.execPath, [WORKER, ...args], { stdio: ["ignore", "pipe", "pipe"], env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const lines = stdout.trim() === "" ? [] : stdout.trim().split("\n").map(line => JSON.parse(line));
      resolve({ code, signal, stdout, stderr, lines });
    });
  });
}

/**
 * Run one already-built launch spec (bin/args/env) to completion. Used by the
 * production-mode tests that go through `buildWorkerLaunch`.
 * @returns `{code, signal, stdout, stderr, lines}`.
 */
export function runLaunch(launch, { cwd, timeoutMs = 180_000 } = {}) {
  const child = spawn(launch.bin, launch.args, {
    cwd: cwd ?? process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: launch.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  return new Promise((resolve) => {
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const lines = stdout.trim() === "" ? [] : stdout.trim().split("\n").map(line => JSON.parse(line));
      resolve({ code, signal, stdout, stderr, lines });
    });
  });
}

/** Parse stdout events defensively (fails the test on non-JSON protocol output). */
export function parseLines(stdout) {
  return stdout.trim() === "" ? [] : stdout.trim().split("\n").map((line) => {
    assert.ok(line.startsWith("{"), `stdout must carry only JSON protocol lines, got: ${line.slice(0, 120)}`);
    return JSON.parse(line);
  });
}

/** All `agent_message` texts a parent pipeline would accumulate as clean output. */
export function cleanOutput(lines) {
  return lines
    .filter(event => event.type === "item.completed" && event.item?.type === "agent_message")
    .map(event => event.item.text)
    .join("\n");
}

export function testFiles() {
  return readdirSync(dirname(fileURLToPath(import.meta.url)))
    .filter(name => /^t\d.*\.mjs$/u.test(name))
    .sort();
}

/** Minimal assertion-reporting runner used by `tests/run.mjs` and each file's `--self`. */
export function report(name, error) {
  if (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${name}`);
  }
}
