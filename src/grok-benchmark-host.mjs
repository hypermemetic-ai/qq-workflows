import { timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn as nodeSpawn } from "node:child_process";

export const BENCHMARK_HOST_ROUTE = "/api/qq-workflows/grok-reviewer-benchmark";
export const BENCHMARK_DESCRIPTOR = ".grok-reviewer-benchmark-launch.json";
export const DESCRIPTOR_SCHEMA = "qq.grok-reviewer-benchmark-launch/v1";
export const STATUS_SCHEMA = "qq.grok-reviewer-benchmark-host-job/v1";
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MIN_TOKEN_LENGTH = 43;
export const MAX_TOKEN_LENGTH = 128;
export const MAX_DESCRIPTOR_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4096;
const REPOSITORY_ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
const RUNNER_PATH = join(REPOSITORY_ROOT, "experiments", "grok-reviewer-benchmark", "host", "runner.py");
const GLOBAL_SLOT = Symbol.for("qq.workflows.grokReviewerBenchmarkHostJob/v1");
const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function globalState() {
  globalThis[GLOBAL_SLOT] ??= { job: null };
  return globalThis[GLOBAL_SLOT];
}

function contained(parent, child) {
  const suffix = relative(parent, child);
  return suffix !== "" && !suffix.startsWith("..") && !isAbsolute(suffix);
}

function privateRegularFile(metadata, owner) {
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("enablement descriptor must be a regular file");
  if (metadata.uid !== owner) throw new Error("enablement descriptor owner does not match the qq service user");
  if ((metadata.mode & 0o777) !== 0o600) throw new Error("enablement descriptor mode must be exactly 0600");
  if (metadata.nlink !== 1) throw new Error("enablement descriptor must not be hard-linked");
  if (metadata.size < 2 || metadata.size > MAX_BODY_BYTES) {
    throw new Error(`enablement descriptor must be 2-${MAX_BODY_BYTES} bytes`);
  }
  return metadata;
}

function exactKeys(value, expected, description) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${description} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${description} has unsupported fields`);
  }
}

export function readBenchmarkDescriptor({
  repositoryRoot = REPOSITORY_ROOT,
  descriptorPath = join(repositoryRoot, BENCHMARK_DESCRIPTOR),
  now = Date.now(),
  uid = process.getuid(),
} = {}) {
  const repository = realpathSync(repositoryRoot);
  const expectedPath = resolve(repository, BENCHMARK_DESCRIPTOR);
  if (resolve(descriptorPath) !== expectedPath) throw new Error("enablement descriptor must use the fixed repository path");
  let descriptorFd;
  let source;
  try {
    descriptorFd = openSync(expectedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    privateRegularFile(fstatSync(descriptorFd), uid);
    source = readFileSync(descriptorFd, "utf8");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("enablement descriptor")) throw error;
    throw new Error("cannot open enablement descriptor as a private regular file");
  } finally {
    if (descriptorFd !== undefined) closeSync(descriptorFd);
  }
  if (realpathSync(expectedPath) !== expectedPath) throw new Error("enablement descriptor real path mismatch");
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    // JSON parser diagnostics can include source snippets. Never reflect a
    // malformed descriptor because that snippet could contain the bearer.
    throw new Error("cannot parse enablement descriptor");
  }
  exactKeys(value, ["schema", "token", "runtime_root", "run_id", "expires_at"], "enablement descriptor");
  if (value.schema !== DESCRIPTOR_SCHEMA) throw new Error("unsupported enablement descriptor schema");
  if (typeof value.token !== "string"
      || value.token.length < MIN_TOKEN_LENGTH
      || value.token.length > MAX_TOKEN_LENGTH
      || !/^[A-Za-z0-9_-]+$/.test(value.token)) {
    throw new Error(`descriptor token must be ${MIN_TOKEN_LENGTH}-${MAX_TOKEN_LENGTH} URL-safe characters`);
  }
  if (typeof value.run_id !== "string" || !RUN_ID.test(value.run_id)) throw new Error("descriptor run_id is invalid");
  if (typeof value.runtime_root !== "string" || !isAbsolute(value.runtime_root)) {
    throw new Error("descriptor runtime_root must be absolute");
  }
  const runtimeRoot = realpathSync(value.runtime_root);
  const runtimeMetadata = lstatSync(value.runtime_root);
  if (!runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink() || runtimeMetadata.uid !== uid
      || (runtimeMetadata.mode & 0o022) !== 0 || !contained(repository, runtimeRoot)) {
    throw new Error("descriptor runtime_root must be an owner-controlled existing directory contained by the qq-workflows repository");
  }
  if (resolve(value.runtime_root) !== runtimeRoot) throw new Error("descriptor runtime_root must be its canonical real path");
  const expires = Date.parse(value.expires_at);
  if (!Number.isFinite(expires) || expires <= now || expires - now > MAX_DESCRIPTOR_LIFETIME_MS) {
    throw new Error("descriptor expires_at must be in the next 24 hours");
  }
  return Object.freeze({
    ...value, runtime_root: runtimeRoot, repository_root: repository, expires_at_ms: expires,
  });
}

function authorized(header, token) {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(token, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function safeEnvironment(source = process.env) {
  const allowed = [
    "HOME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "USER", "LOGNAME",
    "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
  ];
  return Object.fromEntries(allowed.filter((name) => typeof source[name] === "string").map((name) => [name, source[name]]));
}

function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function publicStatus(job) {
  if (!job) return { schema: STATUS_SCHEMA, state: "idle" };
  return {
    schema: STATUS_SCHEMA,
    state: job.status.state,
    stage: job.status.stage,
    run_id: job.status.run_id,
    repeat_count: job.status.repeat_count,
    started_at: job.status.started_at,
    finished_at: job.status.finished_at,
    exit_code: job.status.exit_code,
    signal: job.status.signal,
    cancelled: job.status.cancelled,
    artifact_directory: job.status.artifact_directory,
  };
}

function sendJson(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be JSON");
  }
}

function timestamp() {
  return new Date().toISOString();
}

function jobDirectory(descriptor, stage) {
  const parent = realpathSync(descriptor.runtime_root);
  const runtimeMetadata = lstatSync(descriptor.runtime_root);
  if (parent !== descriptor.runtime_root || !contained(descriptor.repository_root, parent)
      || !runtimeMetadata.isDirectory() || runtimeMetadata.isSymbolicLink()
      || runtimeMetadata.uid !== process.getuid() || (runtimeMetadata.mode & 0o022) !== 0) {
    throw new Error("runtime root changed or escaped after descriptor validation");
  }
  const jobs = join(parent, "host-jobs");
  try {
    mkdirSync(jobs, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const jobsMetadata = lstatSync(jobs);
  if (!jobsMetadata.isDirectory() || jobsMetadata.isSymbolicLink()
      || jobsMetadata.uid !== process.getuid() || (jobsMetadata.mode & 0o077) !== 0
      || realpathSync(jobs) !== jobs) {
    throw new Error("job artifact parent must be an owner-controlled real directory under the runtime root");
  }
  const directory = join(jobs, `${descriptor.run_id}-${stage}`);
  if (!contained(parent, directory)) throw new Error("job artifact path escaped the runtime root");
  mkdirSync(directory, { mode: 0o700 });
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid()
      || (metadata.mode & 0o077) !== 0 || !contained(parent, realpathSync(directory))) {
    throw new Error("job artifact real path escaped the runtime root");
  }
  return directory;
}

function defaultKill(pid, signal) {
  process.kill(-pid, signal);
}

export function createBenchmarkHostLauncher({
  webServer,
  repositoryRoot = REPOSITORY_ROOT,
  runnerPath = RUNNER_PATH,
  python = "python3",
  spawnProcess = nodeSpawn,
  killProcessGroup = defaultKill,
  descriptorPath = join(repositoryRoot, BENCHMARK_DESCRIPTOR),
  now = () => Date.now(),
  logger = {},
} = {}) {
  if (!webServer || typeof webServer.register !== "function") throw new Error("benchmark host launcher requires webServer");
  if (webServer.host !== "127.0.0.1") throw new Error("benchmark host launcher requires webServer.host to be exactly 127.0.0.1");
  const repository = realpathSync(repositoryRoot);
  const fixedRunner = realpathSync(runnerPath);
  if (!contained(repository, fixedRunner)) {
    throw new Error("benchmark runner must remain inside the repository");
  }
  if (runnerPath === RUNNER_PATH
      && fixedRunner !== realpathSync(join(repository, "experiments", "grok-reviewer-benchmark", "host", "runner.py"))) {
    throw new Error("benchmark runner must be the fixed repository host/runner.py");
  }
  const state = globalState();
  let disposed = false;

  function descriptorFor(request) {
    if (!LOOPBACK_PEERS.has(request.socket?.remoteAddress)) throw new Error("benchmark host route is loopback-only");
    const descriptor = readBenchmarkDescriptor({ repositoryRoot: repository, descriptorPath, now: now() });
    if (!authorized(request.headers?.authorization, descriptor.token)) throw new Error("unauthorized benchmark host request");
    return descriptor;
  }

  function setStatus(job, patch) {
    job.status = { ...job.status, ...patch };
    atomicJson(job.statusPath, job.status);
  }

  async function cancelJob(job, reason = "operator") {
    if (!job || job.done) return publicStatus(job);
    if (!job.cancelPromise) {
      job.cancelPromise = (async () => {
        setStatus(job, { state: "cancelling", cancelled: true, cancellation_reason: reason });
        // runner.py handles TERM and cascades it through its registered bridge/
        // benchmark sessions; benchmark.py in turn reaps reviewer/proxy groups.
        // Their 3s/1s watchdogs complete before this 5s host fallback.
        try { killProcessGroup(job.child.pid, "SIGTERM"); } catch (error) {
          if (error?.code !== "ESRCH") throw error;
        }
        const exited = await Promise.race([
          job.exitPromise.then(() => true),
          new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 5000)),
        ]);
        if (!exited) {
          try { killProcessGroup(job.child.pid, "SIGKILL"); } catch (error) {
            if (error?.code !== "ESRCH") throw error;
          }
          await job.exitPromise;
        }
        return publicStatus(job);
      })();
    }
    return job.cancelPromise;
  }

  function launch(descriptor, stage, repeatCount) {
    if (disposed) throw new Error("benchmark host launcher is disposed");
    if (!Number.isInteger(repeatCount) || repeatCount < 1 || repeatCount > 5) throw new Error("repeat_count must be an integer from 1 through 5");
    if (stage === "pilot" && repeatCount !== 1) throw new Error("pilot repeat_count must be exactly 1");
    if (stage !== "pilot" && stage !== "matrix") throw new Error("unsupported benchmark stage");
    if (state.job && !state.job.done) throw new Error("another benchmark host job is already running");
    const directory = jobDirectory(descriptor, stage);
    const stdoutPath = join(directory, "stdout.log");
    const stderrPath = join(directory, "stderr.log");
    const statusPath = join(directory, "status.json");
    const args = [fixedRunner, stage, "--root", descriptor.runtime_root, "--run-id", descriptor.run_id];
    if (stage === "matrix") args.push("--repeat-count", String(repeatCount));
    const status = {
      schema: STATUS_SCHEMA,
      state: "starting",
      stage,
      run_id: descriptor.run_id,
      repeat_count: repeatCount,
      started_at: timestamp(),
      finished_at: null,
      exit_code: null,
      signal: null,
      cancelled: false,
      artifact_directory: directory,
      stdout: stdoutPath,
      stderr: stderrPath,
      command: [python, "experiments/grok-reviewer-benchmark/host/runner.py", stage, "--root", descriptor.runtime_root,
        "--run-id", descriptor.run_id, ...(stage === "matrix" ? ["--repeat-count", String(repeatCount)] : [])],
    };
    atomicJson(statusPath, status);
    const stdout = openSync(stdoutPath, "wx", 0o600);
    const stderr = openSync(stderrPath, "wx", 0o600);
    let child;
    try {
      child = spawnProcess(python, args, {
        cwd: repository,
        env: safeEnvironment(),
        detached: true,
        stdio: ["ignore", stdout, stderr],
      });
    } finally {
      closeSync(stdout);
      closeSync(stderr);
    }
    const job = {
      child, directory, statusPath, status, done: false, cancelPromise: null, exitPromise: null,
    };
    state.job = job;
    setStatus(job, { state: "running", pid: child.pid });
    job.exitPromise = new Promise((resolvePromise) => {
      const finish = (code, signal) => {
        if (job.done) return;
        job.done = true;
        const cancelled = job.status.cancelled === true;
        setStatus(job, {
          state: cancelled ? "cancelled" : code === 0 ? "completed" : "failed",
          finished_at: timestamp(), exit_code: code, signal: signal ?? null,
        });
        resolvePromise(publicStatus(job));
      };
      child.once("exit", finish);
      child.once("error", (error) => {
        logger.warn?.(`qq-workflows: benchmark host runner spawn failed: ${error instanceof Error ? error.message : String(error)}`);
        finish(null, "spawn-error");
      });
    });
    return publicStatus(job);
  }

  async function handle(stage, request, response) {
    try {
      if (request.method !== "POST") return sendJson(response, 405, { error: "method not allowed" });
      const descriptor = descriptorFor(request);
      const body = await readJsonBody(request);
      exactKeys(body, ["runtime_root", "run_id", "repeat_count"], "launch request");
      if (body.runtime_root !== descriptor.runtime_root || body.run_id !== descriptor.run_id) {
        throw new Error("launch options do not match the run-scoped descriptor");
      }
      const result = launch(descriptor, stage, body.repeat_count);
      return sendJson(response, 202, result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /unauthorized|descriptor|loopback|options do not match/.test(message) ? 403
        : /already running|artifact path/.test(message) ? 409 : 400;
      return sendJson(response, status, { error: message });
    }
  }

  async function handleStatus(request, response) {
    try {
      if (request.method !== "GET") return sendJson(response, 405, { error: "method not allowed" });
      const descriptor = descriptorFor(request);
      const job = state.job;
      if (job && job.status.run_id !== descriptor.run_id) throw new Error("active job belongs to a different run descriptor");
      return sendJson(response, 200, publicStatus(job));
    } catch (error) {
      return sendJson(response, 403, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleCancel(request, response) {
    try {
      if (request.method !== "POST") return sendJson(response, 405, { error: "method not allowed" });
      const descriptor = descriptorFor(request);
      const body = await readJsonBody(request);
      exactKeys(body, [], "cancel request");
      const job = state.job;
      if (job && job.status.run_id !== descriptor.run_id) throw new Error("active job belongs to a different run descriptor");
      return sendJson(response, 200, await cancelJob(job));
    } catch (error) {
      return sendJson(response, 403, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  const unregister = [
    webServer.register({ kind: "exact", path: `${BENCHMARK_HOST_ROUTE}/pilot`, handler: (req, res) => handle("pilot", req, res) }),
    webServer.register({ kind: "exact", path: `${BENCHMARK_HOST_ROUTE}/matrix`, handler: (req, res) => handle("matrix", req, res) }),
    webServer.register({ kind: "exact", path: `${BENCHMARK_HOST_ROUTE}/status`, handler: handleStatus }),
    webServer.register({ kind: "exact", path: `${BENCHMARK_HOST_ROUTE}/cancel`, handler: handleCancel }),
  ];

  return Object.freeze({
    status: () => publicStatus(state.job),
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const release of unregister.reverse()) {
        try { release(); } catch { /* unregister all routes */ }
      }
      await cancelJob(state.job, "plugin-disposal");
    },
  });
}

export function installBenchmarkHostLauncher(ctx) {
  if (typeof ctx?.inject !== "function") return;
  ctx.inject(["webServer"], (injected) => {
    if (!injected?.webServer) return;
    if (typeof injected.effect !== "function") {
      throw new Error("benchmark host launcher requires a lifecycle-owned Cordis effect");
    }
    const host = createBenchmarkHostLauncher({ webServer: injected.webServer, logger: ctx.logger });
    injected.effect(() => () => host.dispose(), "qq-workflows: Grok benchmark host launcher");
  });
}
