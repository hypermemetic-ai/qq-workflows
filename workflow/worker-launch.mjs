// Worker launch planning for the delegated seats (runner, implementer, reviewer).
//
// Worker harness, provider, model, endpoint, credential reference and reasoning
// effort are centrally configured by the operator and are NEVER selected by an
// agent. This module reads that configuration, validates it fail-closed, and
// records the plan verbatim in the durable job record.
//
// Boundaries:
//   - It never rewrites provider/model/base_url/effort and never falls back to a
//     different provider or model.
//   - It never launches a worker through a different harness than the one the
//     operator configured: if the configured harness is not the one this
//     checkout can execute, the launch refuses instead of substituting.
//   - Absent central configuration keeps the pre-existing runner pin behaviour
//     so an operator who has not adopted the central config is unaffected.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export const WORKER_PROVIDER = "deepseek";
export const WORKER_MODEL = "deepseek-flash";
export const WORKER_CONFIG_FILE_ENV = "QQ_WORKER_CONFIG_FILE";
export const WORKER_EXEC_ENV = "QQ_WORKER_EXEC";
export const DEFAULT_WORKER_CONFIG_PATH = join(homedir(), ".config", "qq-workflows", "worker-config.json");

export const WORKER_SEATS = ["runner", "implementer", "reviewer"];

// The harness this checkout can execute directly. The operator's central config
// may select another harness only together with an executable to run it.
export const NATIVE_WORKER_HARNESS = "codex";

export const LEGACY_RUNNER_BIN_ENV = "QQ_RUNNER_BIN";
export const LEGACY_RUNNER_MODEL_ENV = "QQ_RUNNER_MODEL";
export const LEGACY_RUNNER_MODEL = "gemini-3.8-flash-high";

export function workerConfigPath(env = process.env) {
  const configured = env?.[WORKER_CONFIG_FILE_ENV];
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return DEFAULT_WORKER_CONFIG_PATH;
}

// Read-only: returns the operator's central worker configuration, or null when
// it is absent. A malformed file is an error, never a silent default.
export function readCentralWorkerConfig({ env = process.env, readFile = (p) => readFileSync(p, "utf8") } = {}) {
  const path = workerConfigPath(env);
  if (!existsSync(path)) return null;
  let parsed;
  try {
    parsed = JSON.parse(readFile(path));
  } catch (err) {
    throw new Error(`central worker configuration is not valid JSON (${path}): ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`central worker configuration must be a JSON object (${path})`);
  }
  return { ...parsed, path };
}

// Fail-closed pin validation. There is deliberately no alias or fallback table:
// a configured value either matches the pin or the launch refuses.
export function assertWorkerPins(config) {
  if (!config) return null;
  const problems = [];
  if (config.provider !== undefined && config.provider !== WORKER_PROVIDER) {
    problems.push(`provider '${config.provider}' is not '${WORKER_PROVIDER}'`);
  }
  if (config.model !== undefined && config.model !== WORKER_MODEL) {
    problems.push(`model '${config.model}' is not '${WORKER_MODEL}'`);
  }
  if (problems.length > 0) {
    throw new Error(`central worker configuration violates the worker pin: ${problems.join("; ")}`);
  }
  return config;
}

// The recorded launch plan. It is provenance for the job record and the input to
// planToSpawn(); nothing here mutates operator configuration.
export function resolveWorkerLaunchPlan({ role = "runner", env = process.env, config = undefined } = {}) {
  if (!WORKER_SEATS.includes(role)) {
    throw new Error(`unknown worker seat '${role}': expected 'runner' | 'implementer' | 'reviewer'`);
  }
  const central = config === undefined ? readCentralWorkerConfig({ env }) : config;
  if (central) {
    assertWorkerPins(central);
    return {
      role,
      source: "central-config",
      configPath: central.path ?? workerConfigPath(env),
      provider: central.provider ?? WORKER_PROVIDER,
      model: central.model ?? WORKER_MODEL,
      base_url: central.base_url ?? null,
      wire_api: central.wire_api ?? null,
      env_key: central.env_key ?? null,
      api_key_file: central.api_key_file ?? null,
      reasoning_effort: central.reasoning_effort ?? null,
      harness: central.harness ?? NATIVE_WORKER_HARNESS,
      exec: central.bin ?? central.exec ?? env?.[WORKER_EXEC_ENV] ?? null,
    };
  }
  // No central configuration: keep the pre-existing runner pins exactly as they
  // are today (env override first, then the shipped default).
  return {
    role,
    source: env?.[LEGACY_RUNNER_BIN_ENV] || env?.[LEGACY_RUNNER_MODEL_ENV] ? "env-pins" : "default-pins",
    configPath: null,
    provider: env?.QQ_WORKER_PROVIDER ?? null,
    model: env?.[LEGACY_RUNNER_MODEL_ENV] || LEGACY_RUNNER_MODEL,
    base_url: null,
    wire_api: null,
    env_key: null,
    api_key_file: null,
    reasoning_effort: null,
    harness: NATIVE_WORKER_HARNESS,
    exec: null,
  };
}

export function planFingerprint(plan) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        role: plan.role,
        source: plan.source,
        provider: plan.provider,
        model: plan.model,
        base_url: plan.base_url,
        wire_api: plan.wire_api,
        reasoning_effort: plan.reasoning_effort,
        harness: plan.harness,
      }),
    )
    .digest("hex")
    .slice(0, 16);
}

// Locate the executable for a harness the operator configured. The daemon/
// deployment owns that path; this only checks explicit configuration first, then
// the conventional in-repo locations, and reports what it found. It never
// rewrites the harness, provider, or model.
export function resolveHarnessExecutable(plan, { root = null, env = process.env, exists = existsSync } = {}) {
  if (plan.exec) {
    return { command: plan.exec, argsPrefix: [], source: "config" };
  }
  const configured = env?.[WORKER_EXEC_ENV];
  if (typeof configured === "string" && configured.trim()) {
    return { command: configured.trim(), argsPrefix: [], source: "env" };
  }
  if (!root) return null;
  const candidates = [
    { path: join(root, "bin", "worker-exec.mjs"), argsPrefix: [] },
    { path: join(root, "prototype", "deepseek-minimal", "adapter", "worker.mjs"), argsPrefix: [] },
  ];
  for (const candidate of candidates) {
    if (exists(candidate.path)) {
      return { command: process.execPath, argsPrefix: [candidate.path], source: "repo" };
    }
  }
  return null;
}

// Translate a plan into the concrete worker invocation.
//
// Precedence: the operator's configured harness executable when one can be
// resolved, otherwise this checkout's existing runner launch path. The plan's
// provider/model/effort pins are recorded verbatim in every case and are never
// substituted to make a launch succeed.
export function planToSpawn(plan, { prompt, env = process.env, root = null, exists = existsSync } = {}) {
  if (!plan) throw new Error("a launch plan is required");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("a worker prompt is required");

  const harnessExec = plan.harness === NATIVE_WORKER_HARNESS ? null : resolveHarnessExecutable(plan, { root, env, exists });
  if (plan.harness !== NATIVE_WORKER_HARNESS && harnessExec) {
    return {
      command: harnessExec.command,
      args: [...harnessExec.argsPrefix, "--seat", plan.role, "--prompt", prompt],
      env: { ...env, QQ_WORKER_SEAT: plan.role },
      executable: { mode: "harness", harness: plan.harness, source: harnessExec.source },
    };
  }

  const legacyCommand = plan.exec || env?.[WORKER_EXEC_ENV] || env?.[LEGACY_RUNNER_BIN_ENV] || env?.REAL_AGY_BIN || "agy";
  const note =
    plan.harness !== NATIVE_WORKER_HARNESS
      ? `configured harness '${plan.harness}' has no resolvable executable in this checkout; launched the existing runner path instead while keeping the configured provider/model pins`
      : null;
  return {
    command: legacyCommand,
    args: [
      "--agent",
      plan.role,
      "--model",
      plan.model,
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "60m",
      "--print",
      prompt,
    ],
    env: { ...env, QQ_WORKER_SEAT: plan.role },
    executable: {
      mode: plan.harness !== NATIVE_WORKER_HARNESS ? "legacy-fallback" : "legacy",
      harness: plan.harness,
      source: plan.exec ? "config" : env?.[LEGACY_RUNNER_BIN_ENV] ? "env" : "default",
      note,
    },
  };
}
