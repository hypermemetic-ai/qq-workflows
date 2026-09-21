#!/usr/bin/env node
// Canonical out-of-process worker launcher.
//
// Used by the manual prepare_worktree delegation path so the architect never
// constructs provider flags by hand. All provider/model/endpoint/effort/harness
// selection is resolved from the central operator configuration
// (workflow/worker-config.mjs), through the same central launch constructor the
// native workflow runner and the managed execution pipeline use. The launch
// fails closed if the configuration is missing or does not resolve to the
// authorized worker pins.
//
// The runner seat's bound identity and result transport are explicit inputs: an
// identity that only exists in the ambient process environment is not enough for
// a delegated runner, so `--runner-id`/`--runner-result-file` (or exactly those
// two environment variables) must name them.
import { spawn } from "node:child_process";
import { WORKER_SEATS, buildCentralWorkerLaunch, workerConfigPath } from "../workflow/worker-launch.mjs";

function usage() {
  return [
    `usage: worker-exec.mjs --seat <${WORKER_SEATS.join("|")}> [--cwd <dir>] --prompt <text>`,
    "       runner seat also requires --runner-id <id> --runner-result-file <path>",
  ].join("\n");
}

const args = process.argv.slice(2);
let seat = null;
let cwd = process.cwd();
let prompt = null;
let runnerId = null;
let runnerResultFile = null;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--seat" && i + 1 < args.length) seat = args[++i];
  else if (arg === "--cwd" && i + 1 < args.length) cwd = args[++i];
  else if (arg === "--prompt" && i + 1 < args.length) prompt = args[++i];
  else if (arg === "--runner-id" && i + 1 < args.length) runnerId = args[++i];
  else if (arg === "--runner-result-file" && i + 1 < args.length) runnerResultFile = args[++i];
  else if (arg === "-h" || arg === "--help") { console.log(usage()); process.exit(0); }
  else { console.error(`unknown argument '${arg}'\n${usage()}`); process.exit(2); }
}

if (!seat || !WORKER_SEATS.includes(seat)) {
  console.error(`--seat must be one of ${WORKER_SEATS.join(", ")}\n${usage()}`);
  process.exit(2);
}
if (!prompt || !prompt.trim()) {
  console.error(`--prompt is required\n${usage()}`);
  process.exit(2);
}

// The runner seat never invents an identity or a transport path: the caller
// owns both, either explicitly or through the two documented environment
// variables its parent set.
const mcpEnv = {};
if (seat === "runner") {
  runnerId = runnerId ?? process.env.QQ_RUNNER_ID ?? null;
  runnerResultFile = runnerResultFile ?? process.env.QQ_RUNNER_RESULT_FILE ?? null;
  if (!runnerId) {
    console.error(`--runner-id is required for the runner seat (no identity is inferred)\n${usage()}`);
    process.exit(2);
  }
  if (!runnerResultFile) {
    console.error(`--runner-result-file is required for the runner seat (no transport path is inferred)\n${usage()}`);
    process.exit(2);
  }
  mcpEnv.QQ_RUNNER_ID = runnerId;
  mcpEnv.QQ_RUNNER_RESULT_FILE = runnerResultFile;
}

let launch;
try {
  launch = buildCentralWorkerLaunch({ seat, cwd, prompt, env: process.env, mcpEnv });
} catch (err) {
  console.error(`[worker-exec] launch rejected: ${err.message} (config: ${workerConfigPath(process.env)})`);
  process.exit(1);
}

const child = spawn(launch.bin, launch.args, {
  cwd,
  stdio: ["ignore", "inherit", "inherit"],
  env: launch.env,
});
child.on("error", (err) => {
  console.error(`[worker-exec] failed to start worker: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
