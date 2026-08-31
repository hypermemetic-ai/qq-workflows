#!/usr/bin/env node
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";

import {
  BENCHMARK_DESCRIPTOR,
  BENCHMARK_HOST_ROUTE,
  DESCRIPTOR_SCHEMA,
  createBenchmarkHostLauncher,
  readBenchmarkDescriptor,
} from "../src/grok-benchmark-host.mjs";

function webServer(host = "127.0.0.1") {
  const routes = new Map();
  return {
    host,
    routes,
    register(route) {
      assert.equal(routes.has(route.path), false);
      routes.set(route.path, route.handler);
      return () => routes.delete(route.path);
    },
  };
}

function request({ method = "POST", token, body = {}, remoteAddress = "127.0.0.1" } = {}) {
  const input = Readable.from([Buffer.from(JSON.stringify(body))]);
  input.method = method;
  input.headers = token ? { authorization: `Bearer ${token}` } : {};
  input.socket = { remoteAddress };
  return input;
}

function response() {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  return {
    status: null,
    headers: null,
    body: "",
    done,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body = "") { this.body += body; resolveDone(this); },
  };
}

async function call(server, suffix, options) {
  const handler = server.routes.get(`${BENCHMARK_HOST_ROUTE}/${suffix}`);
  assert.equal(typeof handler, "function");
  const output = response();
  await handler(request(options), output);
  await output.done;
  return { status: output.status, body: JSON.parse(output.body) };
}

async function eventually(action, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await action();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for fixture process");
}

const root = await mkdtemp(join(tmpdir(), "qq-benchmark-host-"));
try {
  const repository = join(root, "qq-workflows");
  const runtime = join(repository, ".runtime");
  const fixtureDirectory = join(repository, "fixtures");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  mkdirSync(fixtureDirectory, { recursive: true, mode: 0o700 });
  const runner = join(fixtureDirectory, "runner.py");
  writeFileSync(runner, [
    "#!/usr/bin/env python3",
    "import sys, time",
    "print('fixture argv:', ' '.join(sys.argv[1:]), flush=True)",
    "time.sleep(30 if '--run-id' in sys.argv and sys.argv[sys.argv.index('--run-id') + 1] == 'cancel-me' else 0.05)",
    "",
  ].join("\n"), { mode: 0o700 });
  const descriptor = join(repository, BENCHMARK_DESCRIPTOR);
  const token = "T".repeat(48);

  function writeDescriptor({ runId = "paired-run", rootPath = runtime, expires = Date.now() + 60_000 } = {}) {
    writeFileSync(descriptor, `${JSON.stringify({
      schema: DESCRIPTOR_SCHEMA,
      token,
      runtime_root: rootPath,
      run_id: runId,
      expires_at: new Date(expires).toISOString(),
    })}\n`, { mode: 0o600 });
    chmodSync(descriptor, 0o600);
  }

  writeDescriptor();
  assert.equal(readBenchmarkDescriptor({ repositoryRoot: repository }).runtime_root, runtime);
  writeFileSync(descriptor, `{"schema":"${DESCRIPTOR_SCHEMA}","token":"${token}"`, { mode: 0o600 });
  assert.throws(
    () => readBenchmarkDescriptor({ repositoryRoot: repository }),
    (error) => error.message === "cannot parse enablement descriptor" && !error.message.includes(token),
  );
  writeDescriptor();
  assert.throws(() => readBenchmarkDescriptor({ repositoryRoot: repository, uid: process.getuid() + 1 }), /owner does not match/);
  chmodSync(descriptor, 0o644);
  assert.throws(() => readBenchmarkDescriptor({ repositoryRoot: repository }), /mode must be exactly 0600/);
  writeDescriptor({ expires: Date.now() + 25 * 60 * 60 * 1000 });
  assert.throws(() => readBenchmarkDescriptor({ repositoryRoot: repository }), /next 24 hours/);
  writeDescriptor({ runId: "../escape" });
  assert.throws(() => readBenchmarkDescriptor({ repositoryRoot: repository }), /run_id is invalid/);
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeDescriptor({ rootPath: outside });
  assert.throws(() => readBenchmarkDescriptor({ repositoryRoot: repository }), /contained by/);
  const linkedRoot = join(repository, ".linked-runtime");
  symlinkSync(outside, linkedRoot);
  writeDescriptor({ rootPath: linkedRoot });
  assert.throws(() => readBenchmarkDescriptor({ repositoryRoot: repository }), /contained by|canonical real path/);

  writeDescriptor();
  const symlinkedJobsTarget = join(root, "outside-jobs");
  mkdirSync(symlinkedJobsTarget);
  symlinkSync(symlinkedJobsTarget, join(runtime, "host-jobs"));
  const symlinkServer = webServer();
  const symlinkHost = createBenchmarkHostLauncher({ webServer: symlinkServer, repositoryRoot: repository, runnerPath: runner });
  let symlinkResult = await call(symlinkServer, "pilot", {
    token,
    body: { runtime_root: runtime, run_id: "paired-run", repeat_count: 1 },
  });
  assert.equal(symlinkResult.status, 400);
  assert.deepEqual(readdirSync(symlinkedJobsTarget), [], "symlink rejection writes nothing outside");
  await symlinkHost.dispose();
  unlinkSync(join(runtime, "host-jobs"));

  writeDescriptor();
  assert.throws(() => createBenchmarkHostLauncher({
    webServer: webServer("0.0.0.0"), repositoryRoot: repository, runnerPath: runner,
  }), /exactly 127.0.0.1/);

  const server = webServer();
  const host = createBenchmarkHostLauncher({ webServer: server, repositoryRoot: repository, runnerPath: runner });
  assert.equal(server.routes.size, 4);

  let result = await call(server, "pilot", {
    body: { runtime_root: runtime, run_id: "paired-run", repeat_count: 1 },
  });
  assert.equal(result.status, 403, "missing bearer token fails closed");

  result = await call(server, "pilot", {
    token,
    body: { runtime_root: runtime, run_id: "paired-run", repeat_count: 1, command: "id" },
  });
  assert.equal(result.status, 400, "arbitrary command-shaped fields are rejected");

  result = await call(server, "matrix", {
    token,
    body: { runtime_root: runtime, run_id: "paired-run", repeat_count: 6 },
  });
  assert.equal(result.status, 400, "repeat bounds fail closed");

  result = await call(server, "pilot", {
    token,
    remoteAddress: "10.0.0.1",
    body: { runtime_root: runtime, run_id: "paired-run", repeat_count: 1 },
  });
  assert.equal(result.status, 403, "peer address is independently constrained to loopback");

  result = await call(server, "pilot", {
    token,
    body: { runtime_root: runtime, run_id: "paired-run", repeat_count: 1 },
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.stage, "pilot");
  assert.equal(result.body.repeat_count, 1);
  assert.equal(JSON.stringify(result.body).includes(token), false);
  const completed = await eventually(
    () => call(server, "status", { method: "GET", token }),
    (value) => value.body.state === "completed",
  );
  assert.equal(completed.status, 200);
  assert.equal(completed.body.exit_code, 0);
  const pilotStatusPath = join(runtime, "host-jobs", "paired-run-pilot", "status.json");
  const pilotStdoutPath = join(runtime, "host-jobs", "paired-run-pilot", "stdout.log");
  const pilotStatus = readFileSync(pilotStatusPath, "utf8");
  const pilotStdout = readFileSync(pilotStdoutPath, "utf8");
  assert.equal(statSync(pilotStatusPath).mode & 0o777, 0o600);
  assert.equal(statSync(pilotStdoutPath).mode & 0o777, 0o600);
  assert.equal(pilotStatus.includes(token), false);
  assert.match(pilotStdout, /^fixture argv: pilot --root /);
  assert.doesNotMatch(pilotStdout, /command|oauth|bearer/i);

  writeDescriptor({ runId: "cancel-me" });
  result = await call(server, "matrix", {
    token,
    body: { runtime_root: runtime, run_id: "cancel-me", repeat_count: 3 },
  });
  assert.equal(result.status, 202);
  assert.equal(result.body.repeat_count, 3);
  const collision = await call(server, "pilot", {
    token,
    body: { runtime_root: runtime, run_id: "cancel-me", repeat_count: 1 },
  });
  assert.equal(collision.status, 409, "only one host benchmark job can run");
  const cancelled = await call(server, "cancel", { token, body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.state, "cancelled");
  const matrixStatus = readFileSync(join(runtime, "host-jobs", "cancel-me-matrix", "status.json"), "utf8");
  assert.equal(matrixStatus.includes(token), false);
  assert.match(matrixStatus, /"repeat_count": 3/);

  writeDescriptor({ runId: "dispose-me" });
  result = await call(server, "matrix", {
    token,
    body: { runtime_root: runtime, run_id: "dispose-me", repeat_count: 2 },
  });
  assert.equal(result.status, 202);
  await host.dispose();
  assert.equal(server.routes.size, 0);
  assert.equal(host.status().state, "cancelled", "disposal tracks and cancels the live process group");

  console.log("grok benchmark host launcher tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
