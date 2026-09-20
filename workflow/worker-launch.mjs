// Central worker launch resolution for the delegated seats (runner,
// implementer, reviewer).
//
// Worker harness, provider, model, endpoint, credential reference and reasoning
// effort are centrally configured by the operator in
// `~/.config/qq-workflows/worker-config.json` and are NEVER selected by an
// agent, by a target project, or by a per-call argument. This module is the one
// resolution point the native Architect workflow runner
// (workflow/operations.mjs), the managed execution pipeline
// (bin/mcp-server.mjs) and the out-of-process launcher (bin/worker-exec.mjs) all
// go through, so the three seats cannot diverge between them.
//
// Boundaries:
//   - It never rewrites provider/model/base_url/effort and never falls back to
//     a different provider, model, or harness. There is no agy/Codex/pi/native
//     substitution path left: a launch either resolves the centrally
//     configured harness or it fails closed with an actionable diagnostic.
//   - The target project is a working directory only. The harness executable,
//     the adapter source and the pinned runtime are resolved from the installed
//     integration source and the operator's state directory, never by probing
//     the target project for a launcher.
//   - A missing or incompatible central configuration is an error, never a
//     silent default.

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import {
  WORKER_CONFIG_FILE_ENV,
  WORKER_DEEPSEEK_ADAPTER,
  WORKER_HARNESS,
  WORKER_HARNESSES,
  WORKER_MESSAGES_BASE_URL,
  WORKER_MODEL,
  WORKER_PROVIDER,
  WORKER_SEATS,
  buildWorkerLaunch,
  deepSeekMinimalRuntimeRoot,
  defaultWorkerConfigFile,
  loadWorkerConfig,
  validateWorkerConfig,
} from "./worker-config.mjs";

export {
  WORKER_CONFIG_FILE_ENV,
  WORKER_HARNESS,
  WORKER_HARNESSES,
  WORKER_MESSAGES_BASE_URL,
  WORKER_MODEL,
  WORKER_PROVIDER,
  WORKER_SEATS,
};

// Retired executable overrides. They used to select a worker binary outside the
// central contract (the target-project probe and the agy fallback). They are
// refused rather than honored so an inherited value cannot quietly re-introduce
// a second launch path; the explicit binary overrides that remain are the
// centrally reviewed ones (QQ_WORKER_CODEX_BIN for the Codex harness, and the
// test-only QQ_SUBAGENT_BIN/QQ_RUNNER_BIN worker doubles in the pipeline).
export const UNSETTABLE_WORKER_EXEC_ENV = ["QQ_WORKER_EXEC"];

export const DEFAULT_WORKER_CONFIG_PATH = defaultWorkerConfigFile();

// The harness this checkout can execute with its own reviewed argv: the pinned
// DeepSeek Minimal adapter. The operator's file selects it explicitly.
export const DEEPSEEK_MINIMAL_HARNESS = "deepseek-minimal";

export function workerConfigPath(env = process.env) {
  const configured = env?.[WORKER_CONFIG_FILE_ENV];
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return defaultWorkerConfigFile(env);
}

/**
 * The central configuration file a worker launch must use, or an actionable
 * refusal. Every worker entry point (native runner, managed pipeline, manual
 * launcher) resolves the same file, so absence can never be papered over by a
 * different harness.
 */
export function assertCentralWorkerConfig({ env = process.env, configFile = null, exists = existsSync } = {}) {
  const path = configFile
    || (typeof env?.[WORKER_CONFIG_FILE_ENV] === "string" && env[WORKER_CONFIG_FILE_ENV].trim()
      ? env[WORKER_CONFIG_FILE_ENV].trim()
      : workerConfigPath(env));
  if (!exists(path)) {
    throw new Error(
      `central worker configuration is missing at '${path}'; worker seats launch only the operator-configured harness and never fall back to agy, native Codex, or pi`,
    );
  }
  return path;
}

function assertNoLegacyExecOverride(env) {
  for (const key of UNSETTABLE_WORKER_EXEC_ENV) {
    const value = env?.[key];
    if (typeof value === "string" && value.trim()) {
      throw new Error(
        `${key}='${value.trim()}' is not a supported worker launch override: the harness executable comes from the central worker configuration (${workerConfigPath(env)})`,
      );
    }
  }
}

// Read-only access to the operator's central worker configuration. Returns the
// raw parsed object plus its path, or null when the file is absent. A malformed
// file is an error, never a silent default.
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

/**
 * Resolve the recorded launch plan for a worker seat from central operator
 * configuration only.
 *
 * `config` (an unvalidated object) and `configFile` exist for callers that
 * already know the file; when neither is supplied the operator's configured
 * path is used and MUST exist. Absence is refused: the three seats have no
 * default provider and no fallback harness.
 */
export function resolveWorkerLaunchPlan({ role = "runner", env = process.env, config = null, configFile = null } = {}) {
  if (!WORKER_SEATS.includes(role)) {
    throw new Error(`unknown worker seat '${role}': expected ${WORKER_SEATS.map((seat) => `'${seat}'`).join(" | ")}`);
  }
  assertNoLegacyExecOverride(env);
  const path = config === null ? assertCentralWorkerConfig({ env, configFile }) : (configFile ?? env?.[WORKER_CONFIG_FILE_ENV] ?? null);
  const resolved = config === null
    ? loadWorkerConfig({ env, file: path })
    : validateWorkerConfig(config, { configFile: configFile ?? undefined });
  const runtimeRoot = resolved.harness === DEEPSEEK_MINIMAL_HARNESS ? deepSeekMinimalRuntimeRoot(env) : null;
  return {
    role,
    source: "central-config",
    configPath: config === null ? path : (configFile ?? null),
    provider: resolved.provider,
    model: resolved.model,
    base_url: resolved.baseUrl,
    wire_api: resolved.wireApi,
    env_key: resolved.envKey,
    api_key_file: resolved.apiKeyFile,
    reasoning_effort: resolved.reasoningEffort,
    max_output_tokens: resolved.maxOutputTokens,
    messages_base_url: resolved.messagesBaseUrl,
    harness: resolved.harness,
    adapter: resolved.harness === DEEPSEEK_MINIMAL_HARNESS ? WORKER_DEEPSEEK_ADAPTER : null,
    runtime_root: runtimeRoot,
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

/**
 * Fail-closed preflight for the source and runtime a planned launch needs.
 *
 * Nothing here ever selects a different harness: it only reports that the
 * configured one cannot be executed from this installation, so the caller can
 * refuse the launch with an actionable diagnostic instead of spawning a worker
 * that is guaranteed to fail (or, worse, substituting another one).
 */
export function assertWorkerLaunchSource({ plan, env = process.env, exists = existsSync } = {}) {
  if (!plan) throw new Error("a launch plan is required");
  if (plan.configPath && !exists(plan.configPath)) {
    throw new Error(
      `central worker configuration is missing at '${plan.configPath}'; worker seats launch only the operator-configured harness and never fall back to agy, native Codex, or pi`,
    );
  }
  if (plan.harness !== DEEPSEEK_MINIMAL_HARNESS) return plan;
  const adapter = plan.adapter ?? WORKER_DEEPSEEK_ADAPTER;
  if (!exists(adapter)) {
    throw new Error(
      `configured harness '${DEEPSEEK_MINIMAL_HARNESS}' has no adapter source at '${adapter}'; this installation is incomplete and no substitute harness (agy, native Codex, pi) will be launched`,
    );
  }
  const runtimeRoot = plan.runtime_root ?? deepSeekMinimalRuntimeRoot(env);
  const provenance = join(runtimeRoot, "provenance.json");
  const upstream = join(runtimeRoot, "upstream", "package.json");
  if (!exists(provenance) || !exists(upstream)) {
    throw new Error(
      `configured harness '${DEEPSEEK_MINIMAL_HARNESS}' has no prepared runtime at '${runtimeRoot}' (missing ${exists(provenance) ? upstream : provenance}); run prototype/deepseek-minimal/scripts/setup-runtime.mjs before dispatching a worker`,
    );
  }
  return plan;
}

/**
 * The single central launch constructor used by every worker seat in every
 * entry point (native workflow runner, managed execution pipeline, and
 * bin/worker-exec.mjs).
 *
 * @returns the `buildWorkerLaunch` spec (`{bin, args, env, config, tools}`).
 */
export function buildCentralWorkerLaunch({ seat, cwd, prompt, env = process.env, mcpEnv = {}, config = null, configFile = null } = {}) {
  if (!WORKER_SEATS.includes(seat)) {
    throw new Error(`unknown worker seat '${seat}': expected ${WORKER_SEATS.map((s) => `'${s}'`).join(" | ")}`);
  }
  assertNoLegacyExecOverride(env);
  const path = config === null ? assertCentralWorkerConfig({ env, configFile }) : (configFile ?? env?.[WORKER_CONFIG_FILE_ENV] ?? null);
  const resolved = config === null
    ? loadWorkerConfig({ env, file: path })
    : validateWorkerConfig(config, { configFile: configFile ?? undefined });
  assertWorkerLaunchSource({
    plan: { harness: resolved.harness, adapter: WORKER_DEEPSEEK_ADAPTER, runtime_root: deepSeekMinimalRuntimeRoot(env) },
    env,
  });
  if (resolved.harness === DEEPSEEK_MINIMAL_HARNESS && path) {
    // The adapter re-reads the central file itself, so the child must be told
    // which file this launch resolved: without it a non-default path could
    // diverge between parent and adapter (the adapter would silently fall back
    // to the operator's default config path). A caller that supplied a plan and
    // its file explicitly (`planToSpawn`) therefore reaches the adapter with the
    // same file the plan was resolved from, not just when the path rode in the
    // environment.
    env = { ...env, [WORKER_CONFIG_FILE_ENV]: path };
  }
  const launch = buildWorkerLaunch({ seat, cwd, prompt, env, config: resolved, mcpEnv });
  return { ...launch, configPath: config === null ? path : (configFile ?? null) };
}

/**
 * Translate a resolved plan into the concrete worker invocation recorded in the
 * durable job record.
 *
 * `mcpEnv` carries the caller-owned completion transport for the runner seat
 * (bound runner identity and result path); it reaches the worker only through
 * the centrally configured transport, never by substituting a launcher.
 */
export function planToSpawn(plan, { prompt, cwd = null, root = null, env = process.env, mcpEnv = {}, exists = existsSync } = {}) {
  if (!plan) throw new Error("a launch plan is required");
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("a worker prompt is required");
  const workdir = cwd ?? root ?? process.cwd();
  assertWorkerLaunchSource({ plan, env, exists });
  const launch = buildCentralWorkerLaunch({
    seat: plan.role,
    cwd: workdir,
    prompt,
    env,
    mcpEnv,
    config: {
      provider: plan.provider,
      model: plan.model,
      base_url: plan.base_url,
      wire_api: plan.wire_api,
      env_key: plan.env_key,
      api_key_file: plan.api_key_file,
      reasoning_effort: plan.reasoning_effort,
      max_output_tokens: plan.max_output_tokens,
      messages_base_url: plan.messages_base_url,
      harness: plan.harness,
    },
    configFile: plan.configPath ?? undefined,
  });
  return {
    command: launch.bin,
    args: launch.args,
    env: launch.env,
    executable: {
      mode: "central",
      harness: plan.harness,
      source: "central-config",
      command: launch.bin,
      adapter: launch.harness === DEEPSEEK_MINIMAL_HARNESS ? launch.args[0] : null,
    },
  };
}
