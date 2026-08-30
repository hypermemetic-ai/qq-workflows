#!/usr/bin/env node
/** Build the ordinary production Mini QA packet/task for one frozen case. */
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function required(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`qq task renderer requires ${name}`);
  return value;
}

function commandRunner(command, args, options = {}) {
  return new Promise((accept) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => accept({ code: 1, stdout, stderr: error.message }));
    child.on("close", (code) => accept({ code: code ?? 1, stdout, stderr }));
  });
}

const source = resolve(required("BENCH_TOOL_SOURCE"));
const [{ compilePacket, formatPacket }, { materializeTaskArtifact }, { renderDelegationPhaseTask }] = await Promise.all([
  import(pathToFileURL(`${source}/src/proposal-packet.mjs`)),
  import(pathToFileURL(`${source}/src/task-artifact.mjs`)),
  import(pathToFileURL(`${source}/src/land.mjs`)),
]);
const workspace = resolve(required("BENCH_REPOSITORY"));
const task = await readFile(resolve(required("BENCH_TASK_PATH")), "utf8");
const artifact = await materializeTaskArtifact(commandRunner, { worktree: workspace, workspace, task });
const packet = await compilePacket(commandRunner, {
  worktree: workspace,
  baseRef: required("BENCH_BASE"),
  ref: required("BENCH_HEAD"),
}, { mark: "review" });
const rendered = renderDelegationPhaseTask({
  role: "qa",
  input: {
    taskArtifact: artifact.pointer,
    taskSha256: artifact.sha256,
    proposal: formatPacket(packet),
    delta: `Base revision: ${required("BENCH_BASE")}\nHead revision: ${required("BENCH_HEAD")}`,
  },
});
await writeFile(resolve(required("BENCH_QQ_RENDERED_TASK_PATH")), rendered, { encoding: "utf8", mode: 0o600 });
