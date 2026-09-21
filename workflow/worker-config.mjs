// Central, operator-controlled worker configuration.
//
// The runner, implementer, and reviewer seats run through ONE documented worker
// runtime interface: pi's RPC mode (`pi --mode rpc`, see workflow/pi-worker).
// Provider, model, protocol, endpoint, capabilities and credentials belong to
// pi's own registry (`~/.pi/agent/models.json`, `auth.json`); this module owns
// the operator's selection (provider, model, effort, context policy) plus the
// credential *reference* (env key / key file), and never a source-level model
// allowlist. Changing provider or model inside pi's supported catalog is a
// config change, not a code change.
//
// Fail-closed contract: the selection is validated structurally, the requested
// effort is validated against the model's real capability at launch, and
// nothing here ever substitutes another provider, model, or effort level. A
// missing or unusable selection is an error before a process is spawned.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

// Harness selection. `pi` is the one worker runtime interface: a single
// documented Pi RPC process per seat, with shared role instructions, shared
// root-bound ZG search, and the authoritative result/completion modules. The
// two legacy harnesses remain selectable through this same central field so an
// installed release keeps working until the operator activates the Pi worker
// selection; they are never selected implicitly and never substituted.
export const WORKER_HARNESSES = ["pi", "deepseek-minimal", "codex"];
export const WORKER_HARNESS = "pi";

// Legacy DeepSeek runtime values. These are facts about the retained legacy
// harness (its pinned sdk-minimal bundle fixes DEEPSEEK_API_KEY and speaks the
// Messages protocol), not a global worker pin: the `pi` harness takes its
// provider and model from the operator's configuration and pi's registry only.
export const WORKER_PROVIDER = "deepseek";
export const WORKER_PROVIDER_NAME = "DeepSeek";
export const WORKER_MODEL = "deepseek-flash";
export const WORKER_BASE_URL = "https://api.deepseek.com";
export const WORKER_WIRE_API = "responses";
export const WORKER_ENV_KEY = "DEEPSEEK_API_KEY";

// Private, stable, relocatable runtime root for the pinned DeepSeek Harness.
// Setup and the adapter both honor it, so a runtime materialized by
// scripts/setup-runtime.mjs is found without any repo-relative path.
export const WORKER_DEEPSEEK_RUNTIME_ROOT_ENV = "QQ_DEEPSEEK_RUNTIME_ROOT";
export const WORKER_DEEPSEEK_ADAPTER = fileURLToPath(
  new URL("../prototype/deepseek-minimal/adapter/worker.mjs", import.meta.url),
);

// DeepSeek Harness Messages endpoint facts, from the pinned `llm-deepseek`
// source: the operator's `base_url` pin is the Codex/Responses root
// `https://api.deepseek.com`, while the Messages protocol root is
// `https://api.deepseek.com/anthropic` (the harness appends `/v1` once).
export const WORKER_MESSAGES_HOST = "api.deepseek.com";
export const WORKER_MESSAGES_BASE_URL = "https://api.deepseek.com/anthropic";
// The pinned sdk-minimal bundle fixes `apiKeyEnv: DEEPSEEK_API_KEY`.
export const WORKER_DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
// Bounded operator-owned output-token setting. Unset leaves the client's own
// upstream default (llm-deepseek: 256_000) untouched.
export const WORKER_MAX_OUTPUT_TOKENS_MAX = 1_000_000;

// Reasoning-effort levels, per runtime. The Pi runtime accepts every level pi
// documents (`off|minimal|low|medium|high|xhigh|max`); whether a level is
// actually available for the selected model is validated at launch against
// `get_available_thinking_levels`, never assumed. The legacy DeepSeek runtime
// serves the narrower set below. An operator pins one level in
// worker-config.json as `reasoning_effort`; it is emitted verbatim (`--thinking`
// for pi, `model_reasoning_effort` for the legacy Codex path) with no alias or
// downgrade table. Absent means "leave the runtime default alone".
export const WORKER_PI_REASONING_EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const WORKER_LEGACY_REASONING_EFFORT_LEVELS = ["low", "high", "max"];
export const WORKER_REASONING_EFFORT_LEVELS = WORKER_PI_REASONING_EFFORT_LEVELS;

// Worker working-context policy. pi compacts when
// `contextTokens > contextWindow - reserveTokens` (docs/compaction.md), so the
// reserve is the knob that decides how much working context a worker may
// accumulate. Capacity metadata from a provider is NOT a hard enforced input
// bound and a compaction trigger is NOT a bound on one oversized tool result;
// only the arithmetic below is claimed, and only `get_session_stats` reporting
// is treated as measured usage.
export const WORKER_CONTEXT_DEFAULTS = Object.freeze({
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
});
export const WORKER_CONTEXT_MAX_TOKENS = 10_000_000;

export const WORKER_CONFIG_FILE_ENV = "QQ_WORKER_CONFIG_FILE";
export const WORKER_CODEX_HOME_ENV = "QQ_WORKER_CODEX_HOME";
export const WORKER_CODEX_BIN_ENV = "QQ_WORKER_CODEX_BIN";

// Seats served by the central worker configuration, with the role contract
// file that supplies each seat's instructions. There are exactly three worker
// seats. Research/investigation work is ordinary runner work
// (`dispatch_runner`); there is no separate researcher seat, so an explicit
// `--seat researcher` is rejected by the seat validation below rather than
// silently aliased onto the runner.
export const WORKER_SEATS = ["runner", "implementer", "reviewer"];
export const WORKER_ROLE_FILES = {
  runner: "runner",
  implementer: "implementer",
  reviewer: "reviewer",
};

const WORKER_MCP_SERVER = fileURLToPath(new URL("../bin/mcp-server.mjs", import.meta.url));
const WORKER_REPO_ROOT = dirname(dirname(WORKER_MCP_SERVER));

// Only the legacy Codex harness needs an MCP tool: complete_task is the
// runner's authoritative result transport there. The Pi worker runtime reuses
// the same authoritative completion modules directly (no general-purpose MCP
// bridge) and gives every seat the shared root-bound ZG search tool instead.
export const WORKER_MCP_TOOLS = {
  runner: ["complete_task"],
  implementer: [],
  reviewer: [],
};

// The Pi worker runtime: one adapter process per seat, one `pi --mode rpc`
// child inside it, one shared extension file providing the root-bound ZG tool.
export const WORKER_PI_ADAPTER = fileURLToPath(new URL("./pi-worker/adapter.mjs", import.meta.url));
export const WORKER_PI_EXTENSION = fileURLToPath(new URL("../pi-extension/worker-tools.mjs", import.meta.url));
export const WORKER_PI_BIN_ENV = "QQ_WORKER_PI_BIN";
export const WORKER_PI_AGENT_DIR_ENV = "QQ_WORKER_PI_AGENT_DIR";

// Seat tool allowlists for the one Pi worker runtime. Every seat keeps the
// capabilities its shared role contract requires, and no seat loses what the
// legacy seats had:
//   * every seat reads files and searches (`read`/`grep`/`find`/`ls` plus the
//     root-bound `zvec_grep_search` extension tool this runtime registers);
//   * the runner and the reviewer execute commands (`bash`) - the runner's
//     contract mandates tests, reproductions and diagnostic commands, the
//     reviewer's mandates running the plan to completion;
//   * the implementer alone writes (`edit`/`write`).
// The runner's shell is the same capability its seat had in every previous
// runtime (`run_command` in the Antigravity contracts, `bash` + `read_image` in
// the DeepSeek runtime); image reading on the Pi runtime is pi's own `read`
// tool. Migrating the seat therefore preserves tool permissions instead of
// silently dropping them (`tests/pi-worker.mjs` asserts the policy, the role
// contract each seat receives, and that no instruction names a tool outside its
// allowlist).
export const WORKER_PI_TOOLS = {
  runner: ["read", "grep", "find", "ls", "bash", "zvec_grep_search"],
  implementer: ["read", "grep", "find", "ls", "bash", "edit", "write", "zvec_grep_search"],
  reviewer: ["read", "grep", "find", "ls", "bash", "zvec_grep_search"],
};

export function defaultWorkerConfigFile(env = process.env) {
  const base = env.XDG_CONFIG_HOME && String(env.XDG_CONFIG_HOME).trim()
    ? String(env.XDG_CONFIG_HOME)
    : join(env.HOME && String(env.HOME).trim() ? String(env.HOME) : homedir(), ".config");
  return join(base, "qq-workflows", "worker-config.json");
}

export function workerConfigDir(configFile) {
  return dirname(configFile);
}

function stateBaseDir(env) {
  return env.XDG_STATE_HOME && String(env.XDG_STATE_HOME).trim()
    ? String(env.XDG_STATE_HOME)
    : join(env.HOME && String(env.HOME).trim() ? String(env.HOME) : homedir(), ".local", "state");
}

// The shared, configurable runtime root: an explicit env value wins, otherwise
// the private per-user state directory (never inside a checkout).
export function deepSeekMinimalRuntimeRoot(env = process.env) {
  const override = env[WORKER_DEEPSEEK_RUNTIME_ROOT_ENV];
  if (typeof override === "string" && override.trim()) return override.trim();
  return join(stateBaseDir(env), "qq-workflows", "deepseek-minimal-runtime");
}

// Load and validate the operator's worker configuration. Missing file means
// the pinned defaults, which are still validated exactly like a supplied file.
export function loadWorkerConfig({ env = process.env, file } = {}) {
  const configFile = file || env[WORKER_CONFIG_FILE_ENV] || defaultWorkerConfigFile(env);
  let supplied = {};
  if (configFile && existsSync(configFile)) {
    let text;
    try {
      text = readFileSync(configFile, "utf8");
    } catch (err) {
      throw new Error(`worker config at '${configFile}' could not be read: ${err.message}`);
    }
    try {
      supplied = JSON.parse(text);
    } catch (err) {
      throw new Error(`worker config at '${configFile}' is not valid JSON: ${err.message}`);
    }
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
      throw new Error(`worker config at '${configFile}' must be a JSON object`);
    }
  }

  return validateWorkerConfig(supplied, { configFile });
}

// Validate a candidate worker configuration. Fails closed on anything that
// cannot be launched: an unknown harness, a missing provider/model selection
// for the Pi runtime, an unsupported effort level, or an unusable context
// policy. Provider and model are validated structurally (non-empty strings)
// and, for the Pi runtime, resolved against pi's own registry at launch - there
// is no source-level model allowlist and no substitution.
export function validateWorkerConfig(supplied = {}, { configFile } = {}) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new Error("worker configuration must be an object");
  }
  const harness = normalizeWorkerHarness(supplied.harness ?? supplied.harness_type);
  const legacy = harness !== "pi";
  const provider = normalizeWorkerProvider(supplied.provider ?? (legacy ? WORKER_PROVIDER : undefined));
  const model = supplied.model ?? supplied.model_id ?? (legacy ? WORKER_MODEL : undefined);
  const baseUrl = supplied.base_url ?? supplied.baseUrl ?? (legacy ? WORKER_BASE_URL : null);
  const wireApi = supplied.wire_api ?? supplied.wireApi ?? (legacy ? WORKER_WIRE_API : null);
  const envKey = supplied.env_key ?? supplied.envKey ?? (legacy ? WORKER_ENV_KEY : null);
  const reasoningEffort = normalizeWorkerReasoningEffort(
    supplied.reasoning_effort ?? supplied.reasoningEffort,
    harness,
  );
  const context = normalizeWorkerContext(supplied.context ?? supplied.worker_context ?? null);
  const maxOutputTokens = normalizeWorkerMaxOutputTokens(
    supplied.max_output_tokens ?? supplied.maxOutputTokens,
  );
  const messagesOverride = supplied.messages_base_url ?? supplied.messagesBaseUrl;
  const apiKeyFile = supplied.api_key_file ?? supplied.apiKeyFile
    ?? (configFile ? join(workerConfigDir(configFile), legacy ? "deepseek-api-key" : "model-api-key") : null);

  if (typeof provider !== "string" || !provider.trim()) {
    throw new Error(
      `worker configuration must select a provider: set 'provider' in ${configFile ?? "the central worker configuration"} (the pi worker runtime has no source-level default provider)`,
    );
  }
  if (typeof model !== "string" || !model.trim()) {
    throw new Error(
      `worker configuration must select a model: set 'model' in ${configFile ?? "the central worker configuration"} (the pi worker runtime has no source-level default model)`,
    );
  }
  if (harness === "deepseek-minimal" && provider !== WORKER_PROVIDER) {
    throw new Error(
      `harness 'deepseek-minimal' serves only '${WORKER_PROVIDER}' (${WORKER_PROVIDER_NAME}); got provider '${provider}'. Select harness 'pi' for any other provider.`,
    );
  }
  if (harness === "deepseek-minimal" && model !== WORKER_MODEL) {
    throw new Error(
      `harness 'deepseek-minimal' serves only model '${WORKER_MODEL}'; got '${model}'. Select harness 'pi' for any other model.`,
    );
  }
  if (legacy) {
    if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
      throw new Error(`worker base_url '${baseUrl}' must be an http(s) URL`);
    }
    if (wireApi !== "responses") {
      throw new Error(`worker wire_api '${wireApi}' is not supported; expected 'responses'`);
    }
  } else if (baseUrl !== null || wireApi !== null) {
    throw new Error(
      "the pi worker runtime takes its endpoint and protocol from pi's own registry; remove base_url/wire_api from the central worker configuration",
    );
  }
  // The Pi runtime has no launch-side output cap: pi takes it from the model's
  // own registry entry (`maxTokens`). Accepting the knob and never applying it
  // would be a silently inert setting, so it is refused like the other
  // runtime-owned knobs instead of being carried and ignored.
  if (harness === "pi" && maxOutputTokens !== null) {
    throw new Error(
      "the pi worker runtime takes its output cap from pi's own registry (the model's maxTokens); remove max_output_tokens from the central worker configuration",
    );
  }
  if (envKey !== null && (typeof envKey !== "string" || !envKey.trim())) {
    throw new Error("worker env_key must be a non-empty string");
  }
  if (harness === "deepseek-minimal" && envKey !== WORKER_DEEPSEEK_API_KEY_ENV) {
    throw new Error(
      `worker env_key '${envKey}' is not supported by the pinned DeepSeek Minimal runtime, whose sdk-minimal bundle fixes apiKeyEnv: '${WORKER_DEEPSEEK_API_KEY_ENV}'`,
    );
  }
  // The Messages root is derived only for the harness that speaks Messages.
  // For `codex` an explicit override is still validated, but the Responses pin
  // itself is never reinterpreted.
  const messagesBaseUrl = harness === "deepseek-minimal"
    ? resolveMessagesBaseUrl(baseUrl, messagesOverride)
    : (messagesOverride === undefined || messagesOverride === null
      ? null
      : normalizeMessagesBaseUrl(messagesOverride));

  return {
    provider: String(provider).trim(),
    providerName: harness === "deepseek-minimal" ? WORKER_PROVIDER_NAME : String(provider).trim(),
    model: String(model).trim(),
    baseUrl,
    wireApi,
    envKey: envKey === null ? null : String(envKey).trim(),
    harness,
    messagesBaseUrl,
    context,
    maxOutputTokens,
    reasoningEffort,
    apiKeyFile: typeof apiKeyFile === "string" ? apiKeyFile : null,
    configFile,
  };
}

// Validate the worker context policy. Only the three keys pi documents drive
// compaction; anything else fails closed instead of being silently ignored.
export function normalizeWorkerContext(supplied) {
  const policy = { ...WORKER_CONTEXT_DEFAULTS };
  if (supplied === undefined || supplied === null) return policy;
  if (typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new Error("worker context must be an object with {enabled, reserve_tokens, keep_recent_tokens}");
  }
  const allowed = new Set(["enabled", "reserve_tokens", "reserveTokens", "keep_recent_tokens", "keepRecentTokens"]);
  for (const key of Object.keys(supplied)) {
    if (!allowed.has(key)) throw new Error(`worker context key '${key}' is not supported (expected enabled | reserve_tokens | keep_recent_tokens)`);
  }
  if (supplied.enabled !== undefined) {
    if (typeof supplied.enabled !== "boolean") throw new Error("worker context enabled must be a boolean");
    policy.enabled = supplied.enabled;
  }
  const reserve = supplied.reserve_tokens ?? supplied.reserveTokens;
  if (reserve !== undefined) policy.reserveTokens = positiveTokenCount(reserve, "context reserve_tokens");
  const keepRecent = supplied.keep_recent_tokens ?? supplied.keepRecentTokens;
  if (keepRecent !== undefined) policy.keepRecentTokens = nonNegativeTokenCount(keepRecent, "context keep_recent_tokens");
  return policy;
}

function positiveTokenCount(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > WORKER_CONTEXT_MAX_TOKENS) {
    throw new Error(`worker ${field} must be a positive integer no greater than ${WORKER_CONTEXT_MAX_TOKENS} (got ${JSON.stringify(value)})`);
  }
  return value;
}

function nonNegativeTokenCount(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > WORKER_CONTEXT_MAX_TOKENS) {
    throw new Error(`worker ${field} must be a non-negative integer no greater than ${WORKER_CONTEXT_MAX_TOKENS} (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * The honest arithmetic behind a compaction policy, kept separate from any
 * claim about provider capacity:
 *   - `capacity` is what the registry reports for the model (metadata);
 *   - `workingWindow` is the largest context the configured reserve allows
 *     before compaction triggers - a compaction target, not a hard input cap;
 *   - neither bounds one oversized tool result or prompt by itself.
 */
export function workerCompactionBudget({ contextWindow, reserveTokens } = {}) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) throw new Error("contextWindow must be a positive integer from the model registry");
  if (!Number.isSafeInteger(reserveTokens) || reserveTokens <= 0) throw new Error("reserveTokens must be a positive integer");
  const workingWindow = contextWindow - reserveTokens;
  return {
    capacity: contextWindow,
    reserveTokens,
    workingWindow,
    compactionTriggerTokens: workingWindow,
    note: "workingWindow is the compaction trigger target (capacity - reserve), not an enforced hard input bound",
  };
}

// Validate the operator's harness selector. Absence means `codex`, so existing
// configuration and the rollback path keep launching Codex unchanged.
function normalizeWorkerHarness(value) {
  if (value === undefined || value === null) return WORKER_HARNESS;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `worker harness must be one of ${WORKER_HARNESSES.join(", ")} (got ${JSON.stringify(value)})`,
    );
  }
  const harness = value.trim().toLowerCase();
  if (!WORKER_HARNESSES.includes(harness)) {
    throw new Error(
      `worker harness '${value}' is not supported; expected one of ${WORKER_HARNESSES.join(", ")}`,
    );
  }
  return harness;
}

function normalizeWorkerMaxOutputTokens(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `worker max_output_tokens must be a positive safe integer (got ${JSON.stringify(value)})`,
    );
  }
  if (value > WORKER_MAX_OUTPUT_TOKENS_MAX) {
    throw new Error(
      `worker max_output_tokens ${value} exceeds the supported maximum ${WORKER_MAX_OUTPUT_TOKENS_MAX}`,
    );
  }
  return value;
}

function normalizeHttpRoot(raw, field) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error(`worker ${field} must be a non-empty http(s) URL`);
  }
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`worker ${field} '${raw}' is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`worker ${field} '${raw}' must be an http(s) URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`worker ${field} '${raw}' must be an http(s) root without credentials, query, or fragment`);
  }
  return url;
}

/** Path portion with trailing slashes removed; collapsed duplicate `/v1`. */
function messagesRootPath(url) {
  let path = url.pathname.replace(/\/+$/u, "");
  if (path.endsWith("/messages")) {
    throw new Error(`worker messages_base_url '${url.href}' must be a root, not a /messages endpoint`);
  }
  if (path.endsWith("/v1/v1")) path = path.slice(0, -3);
  return path;
}

function normalizeMessagesBaseUrl(raw) {
  const url = normalizeHttpRoot(raw, "messages_base_url");
  if (url.host === WORKER_MESSAGES_HOST) return officialMessagesBase(url);
  return `${url.origin}${messagesRootPath(url)}`;
}

/**
 * Map the operator's pinned provider base to the documented DeepSeek Harness
 * Messages root. `https://api.deepseek.com` (the Codex/Responses pin) becomes
 * `https://api.deepseek.com/anthropic`; the harness appends `/v1` exactly once.
 * Any other host must be named explicitly through `messages_base_url` - a
 * protocol string never selects an endpoint, and the official host never
 * silently routes elsewhere.
 */
export function resolveMessagesBaseUrl(baseUrl, explicitOverride) {
  const official = normalizeHttpRoot(baseUrl, "base_url");
  if (explicitOverride !== undefined && explicitOverride !== null) {
    return normalizeMessagesBaseUrl(explicitOverride);
  }
  if (official.host !== WORKER_MESSAGES_HOST) {
    throw new Error(
      `worker base_url '${baseUrl}' has no documented DeepSeek Messages root; set messages_base_url explicitly to the Messages base`,
    );
  }
  return officialMessagesBase(official);
}

function officialMessagesBase(url) {
  // `/anthropic` and `/anthropic/v1` are the same Messages root: the harness
  // adds `/v1` itself when it is absent, so the canonical form never doubles it.
  if (url.protocol !== "https:") {
    throw new Error(`worker base_url '${url.href}' must be https for the official DeepSeek host`);
  }
  const path = messagesRootPath(url).replace(/\/v1$/u, "");
  if (path === "" || path === "/anthropic") return WORKER_MESSAGES_BASE_URL;
  throw new Error(
    `worker base_url '${url.href}' does not map to the documented DeepSeek Messages base '${WORKER_MESSAGES_BASE_URL}'`,
  );
}

// `worker reasoning_effort` is operator-owned and must name a real backend
// level. Unknown values fail closed instead of silently degrading to a
// different level (the client accepts spellings like `ultra`/`xhigh` that mean
// something else on this backend).
function normalizeWorkerReasoningEffort(value, harness = WORKER_HARNESS) {
  if (value === undefined || value === null) return null;
  const levels = harness === "pi" ? WORKER_PI_REASONING_EFFORT_LEVELS : WORKER_LEGACY_REASONING_EFFORT_LEVELS;
  const expected = levels.join(", ");
  if (typeof value !== "string") {
    throw new Error(
      `worker reasoning_effort must be one of ${expected} (got ${JSON.stringify(value)})`,
    );
  }
  const level = value.trim().toLowerCase();
  if (!levels.includes(level)) {
    throw new Error(`worker reasoning_effort '${value}' is not supported by harness '${harness}'; expected one of ${expected}`);
  }
  return level;
}

function normalizeWorkerProvider(value) {
  if (typeof value !== "string") return value;
  const p = value.trim().toLowerCase();
  if (p === "deepseek-v4" || p === "deepseek-flash") return "deepseek";
  return p;
}

// Resolve the API key for the worker provider. Prefers the process
// environment; falls back to the operator's 0600 key file. The value is never
// logged or returned in receipts - only a source label.
export function resolveWorkerApiKey(config, { env = process.env } = {}) {
  const fromEnv = env[config.envKey];
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return { key: fromEnv, source: `env:${config.envKey}` };
  }
  if (config.apiKeyFile && existsSync(config.apiKeyFile)) {
    const mode = statSync(config.apiKeyFile).mode;
    if ((mode & 0o077) !== 0) {
      throw new Error(`worker key file '${config.apiKeyFile}' must not be group/world accessible (expected 0600)`);
    }
    const key = readFileSync(config.apiKeyFile, "utf8").trim();
    if (!key) throw new Error(`worker key file '${config.apiKeyFile}' is empty`);
    return { key, source: `file:${config.apiKeyFile}` };
  }
  return { key: null, source: null };
}

export function workerCodexHome(env = process.env) {
  if (env[WORKER_CODEX_HOME_ENV] && String(env[WORKER_CODEX_HOME_ENV]).trim()) {
    return String(env[WORKER_CODEX_HOME_ENV]);
  }
  const stateBase = env.XDG_STATE_HOME && String(env.XDG_STATE_HOME).trim()
    ? String(env.XDG_STATE_HOME)
    : join(env.HOME && String(env.HOME).trim() ? String(env.HOME) : homedir(), ".local", "state");
  return join(stateBase, "qq-workflows", "worker-codex-home");
}

// The Codex configuration overrides that pin the worker provider. Mirrors the
// verified smoke invocation: Responses API, no OpenAI auth, no retries.
export function codexWorkerConfigOverrides(config) {
  const p = config.provider;
  const overrides = [
    `model=${tomlString(config.model)}`,
    `model_provider=${tomlString(p)}`,
    `model_providers.${p}.name=${tomlString(config.providerName)}`,
    `model_providers.${p}.base_url=${tomlString(config.baseUrl)}`,
    `model_providers.${p}.env_key=${tomlString(config.envKey)}`,
    `model_providers.${p}.wire_api=${tomlString(config.wireApi)}`,
    `model_providers.${p}.requires_openai_auth=false`,
    `model_providers.${p}.request_max_retries=0`,
    `model_providers.${p}.stream_max_retries=0`,
    "features.multi_agent=false",
    'web_search="disabled"',
    'disabled_tools=["wait","sleep","web__run","web","web_search"]',
  ];
  // Emitted only when the operator pinned a level, so a config without
  // reasoning_effort keeps the client's own default request unchanged.
  if (config.reasoningEffort) {
    overrides.push(`model_reasoning_effort=${tomlString(config.reasoningEffort)}`);
  }
  return overrides;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlStringArray(values) {
  return `[${values.map(tomlString).join(",")}]`;
}

function tomlInlineTable(record) {
  return `{${Object.entries(record).map(([k, v]) => `${tomlKey(k)}=${tomlString(v)}`).join(",")}}`;
}

function tomlKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : tomlString(key);
}

// --------------------------------------------------------------- pi runtime
// pi's own agent directory (its config root). The operator's registry -
// providers, models, capabilities, credentials - lives here and is the single
// source of truth; worker sessions must not fork it.
export function piAgentDir(env = process.env) {
  const override = String(env?.PI_CODING_AGENT_DIR ?? "").trim();
  return override || join(env.HOME && String(env.HOME).trim() ? String(env.HOME) : homedir(), ".pi", "agent");
}

// The isolated worker agent directory. Workers get their own settings file (so
// the worker context policy is explicit and cannot be inherited from an
// operator setting that disables compaction) while the operator's registry
// files are referenced in place, never copied.
export function piWorkerAgentDir(env = process.env) {
  const override = String(env?.[WORKER_PI_AGENT_DIR_ENV] ?? "").trim();
  if (override) return override;
  return join(stateBaseDir(env), "qq-workflows", "pi-worker-agent");
}

/** Registry files a worker session needs from the operator's pi directory. */
export const PI_REGISTRY_FILES = ["models.json", "models-store.json", "auth.json"];

/**
 * Materialize the worker agent directory: our own `settings.json` (the worker
 * context/compaction policy) plus in-place references to the operator's
 * registry files. Credentials are never copied - only the operator's own file
 * is referenced, so a rotated key needs no worker-side change.
 *
 * @returns `{dir, settingsFile, settings, linked, absent}`.
 */
export function ensurePiWorkerSettings(env = process.env, config = null) {
  const resolved = config ?? loadWorkerConfig({ env });
  const dir = piWorkerAgentDir(env);
  mkdirSync(dir, { recursive: true });
  const policy = resolved.context ?? WORKER_CONTEXT_DEFAULTS;
  const settings = {
    compaction: {
      enabled: policy.enabled,
      reserveTokens: policy.reserveTokens,
      keepRecentTokens: policy.keepRecentTokens,
    },
  };
  const settingsFile = join(dir, "settings.json");
  writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

  const source = piAgentDir(env);
  const linked = [];
  const absent = [];
  for (const name of PI_REGISTRY_FILES) {
    const from = join(source, name);
    if (!existsSync(from)) {
      absent.push(name);
      continue;
    }
    const to = join(dir, name);
    if (resolvePath(from) === resolvePath(to)) continue;
    try {
      rmSync(to, { force: true });
      symlinkSync(from, to);
      linked.push(name);
    } catch (err) {
      throw new Error(`worker pi registry file '${name}' could not be referenced at '${to}': ${err.message}`);
    }
  }
  return { dir, settingsFile, settings, linked, absent, source };
}

/** Read back the materialized worker settings (the value the runtime will use). */
export function readPiWorkerSettings(env = process.env, { readFile = readFileSync } = {}) {
  const file = join(piWorkerAgentDir(env), "settings.json");
  let parsed;
  try {
    parsed = JSON.parse(readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`worker pi settings at '${file}' are unreadable: ${err.message}`);
  }
  const compaction = parsed?.compaction;
  if (!compaction || typeof compaction !== "object") {
    throw new Error(`worker pi settings at '${file}' must declare a compaction policy`);
  }
  return {
    file,
    enabled: compaction.enabled === true,
    reserveTokens: compaction.reserveTokens,
    keepRecentTokens: compaction.keepRecentTokens,
  };
}

/** The pi executable for a worker launch (test/operator override, else PATH). */
export function workerPiBin(env = process.env) {
  const override = String(env?.[WORKER_PI_BIN_ENV] ?? "").trim();
  return override || "pi";
}

export function workerPiAllowedTools(seat) {
  const tools = WORKER_PI_TOOLS[seat];
  if (!tools) throw new Error(`no pi tool policy for seat '${seat}'`);
  return [...tools];
}

export function workerRoleInstructionsPath(seat, env = process.env) {
  const dir = join(workerCodexHome(env), "roles");
  return join(dir, `${WORKER_ROLE_FILES[seat] || seat}.md`);
}

// Materialize the repo role contract for a seat into the worker Codex home.
// Returns the absolute path used by model_instructions_file.
export function ensureWorkerRoleInstructions(seat, env = process.env) {
  const { body } = loadRoleContract(seat);
  const path = workerRoleInstructionsPath(seat, env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${body}\n`, "utf8");
  return path;
}

// Extract the prose role contract from agents/<role>/agent.md, dropping the
// runtime frontmatter (which is Gemini/Muse agent metadata, not prompt text).
export function loadRoleContract(seat, { repoRoot = WORKER_REPO_ROOT } = {}) {
  const roleFile = WORKER_ROLE_FILES[seat];
  if (!roleFile) throw new Error(`no worker role contract for seat '${seat}'`);
  const path = join(repoRoot, "agents", roleFile, "agent.md");
  if (!existsSync(path)) throw new Error(`worker role contract not found at '${path}'`);
  const raw = readFileSync(path, "utf8");
  return { path, body: stripFrontmatter(raw) };
}

export function stripFrontmatter(text) {
  if (typeof text !== "string") return "";
  if (!text.startsWith("---\n")) return text.trim();
  const end = text.indexOf("\n---", 4);
  if (end === -1) return text.trim();
  const after = text.indexOf("\n", end + 1);
  return after === -1 ? "" : text.slice(after + 1).trim();
}

// Build the full worker invocation for the centrally selected harness.
// `codex` (the default and the rollback path) emits the Codex argv exactly as
// before; `deepseek-minimal` emits the pinned-harness adapter argv. `mcpEnv` is
// injected into the Codex worker's MCP server (runner only), which is how
// complete_task receives the authoritative result transport path.
export function buildWorkerLaunch({
  seat,
  cwd,
  prompt,
  env = process.env,
  config,
  mcpEnv = {},
  roleInstructionsFile,
} = {}) {
  if (!WORKER_SEATS.includes(seat)) {
    throw new Error(`unknown worker seat '${seat}'`);
  }
  const resolved = config ? validateWorkerConfig(config) : loadWorkerConfig({ env });
  if (resolved.harness === "pi") {
    return buildPiWorkerLaunch({ seat, cwd, prompt, env, resolved, mcpEnv });
  }
  if (resolved.harness === "deepseek-minimal") {
    return buildDeepSeekMinimalLaunch({ seat, cwd, prompt, env, resolved, mcpEnv });
  }
  const args = [
    "exec",
    "--ignore-user-config",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C", cwd,
  ];
  for (const override of codexWorkerConfigOverrides(resolved)) {
    args.push("-c", override);
  }
  const instructionsFile = roleInstructionsFile || ensureWorkerRoleInstructions(seat, env);
  args.push("-c", `model_instructions_file=${tomlString(instructionsFile)}`);
  const tools = WORKER_MCP_TOOLS[seat] || [];
  if (tools.length > 0) {
    const mcpArgs = [WORKER_MCP_SERVER, "--enabled-tools", tools.join(",")];
    args.push("-c", `mcp_servers.qq-workflows.command="node"`);
    args.push("-c", `mcp_servers.qq-workflows.args=${tomlStringArray(mcpArgs)}`);
    if (mcpEnv && Object.keys(mcpEnv).length > 0) {
      args.push("-c", `mcp_servers.qq-workflows.env=${tomlInlineTable(mcpEnv)}`);
    }
    args.push("-c", "mcp_servers.qq-workflows.startup_timeout_sec=30");
  }
  args.push(prompt);

  const childEnv = workerIsolationEnv(env);
  childEnv.CODEX_HOME = workerCodexHome(env);

  const { key } = resolveWorkerApiKey(resolved, { env });
  if (key) childEnv[resolved.envKey] = key;
  // Runner identity is deliberately retained in the Codex child env (the
  // hooks read QQ_RUNNER_ID). The completion *transport* paths must not leak
  // there: they are consumed by the runner MCP server via its own config `env`
  // table built above, and putting them in the general shell env is what let
  // subprocesses/tests inherit and overwrite a live runner's result file.
  // completeTask's runnerId-based fallback resolves to the identical path, so
  // real completion is unaffected.
  if (seat === "runner") {
    for (const [k, v] of Object.entries(mcpEnv || {})) {
      if (v === undefined || v === null) continue;
      if (k === "QQ_RUNNER_RESULT_FILE" || k === "QQ_RUNNER_MARKER_FILE") continue;
      childEnv[k] = v;
    }
  }

  return { bin: workerCodexBin(env), args, env: childEnv, config: resolved, tools };
}

export function workerCodexBin(env = process.env) {
  return env[WORKER_CODEX_BIN_ENV] || env.QQ_CODEX_BIN || "codex";
}

// Env every worker child starts from: never inherit live runner identity,
// notification routing, legacy provider selection, or an operator's Codex home
// unless this launch itself is the runner. A caller re-adds what it owns.
function workerIsolationEnv(env) {
  const childEnv = { ...env };
  delete childEnv.QQ_RUNNER_ID;
  delete childEnv.QQ_RUNNER_RESULT_FILE;
  delete childEnv.QQ_RUNNER_MARKER_FILE;
  delete childEnv.CODEX_THREAD_ID;
  delete childEnv.CODEX_SESSION_ID;
  delete childEnv.CODEX_CONVERSATION_ID;
  delete childEnv.QQ_IMPLEMENTER_PROVIDER;
  delete childEnv.QQ_REVIEWER_PROVIDER;
  // Legacy researcher seat selection no longer names a role, but the name is
  // still scrubbed defensively so an inherited value cannot reach a worker.
  delete childEnv.QQ_RESEARCHER_PROVIDER;
  delete childEnv.QQ_WORKFLOW_PROVIDER;
  return childEnv;
}

// The DeepSeek Minimal launch spec: the adapter is the child process and it
// drives the pinned harness itself. The adapter re-reads the same central
// operator config (QQ_WORKER_CONFIG_FILE is deliberately retained), so harness,
// model, endpoint, effort, and output cap cannot diverge from the parent.
function buildDeepSeekMinimalLaunch({ seat, cwd, prompt, env, resolved, mcpEnv }) {
  const runtimeRoot = deepSeekMinimalRuntimeRoot(env);
  const runnerId = mcpEnv?.QQ_RUNNER_ID;
  const resultFile = mcpEnv?.QQ_RUNNER_RESULT_FILE;
  if (seat === "runner") {
    // Fail closed at the launch boundary too: a runner without a bound identity
    // or an explicit transport path must not start work or completion.
    if (typeof runnerId !== "string" || !runnerId.trim()) {
      throw new Error("runner seat requires a bound runner identity; missing QQ_RUNNER_ID");
    }
    if (typeof resultFile !== "string" || !resultFile.trim()) {
      throw new Error("runner seat requires an explicit result transport path; missing QQ_RUNNER_RESULT_FILE");
    }
  }
  const args = [
    WORKER_DEEPSEEK_ADAPTER,
    "--production",
    "--seat", seat,
    "--cwd", cwd,
    "--prompt", prompt,
    "--runtime-root", runtimeRoot,
  ];
  const childEnv = workerIsolationEnv(env);
  delete childEnv.CODEX_HOME;
  delete childEnv.QQ_WORKER_CODEX_HOME;
  childEnv[WORKER_DEEPSEEK_RUNTIME_ROOT_ENV] = runtimeRoot;
  if (seat === "runner") {
    childEnv.QQ_RUNNER_ID = String(runnerId);
    childEnv.QQ_RUNNER_RESULT_FILE = String(resultFile);
  }
  const { key } = resolveWorkerApiKey(resolved, { env });
  if (key) childEnv[resolved.envKey] = key;
  return {
    harness: resolved.harness,
    bin: process.execPath,
    args,
    env: childEnv,
    config: resolved,
    tools: [],
  };
}

// The Pi worker launch spec: one adapter process per seat (bin/…/adapter.mjs),
// which owns the single `pi --mode rpc` child. The adapter re-reads the same
// central operator configuration (QQ_WORKER_CONFIG_FILE is deliberately
// retained), so harness, provider, model, effort, and context policy cannot
// diverge from the parent.
function buildPiWorkerLaunch({ seat, cwd, prompt, env, resolved, mcpEnv }) {
  const runnerId = mcpEnv?.QQ_RUNNER_ID;
  const resultFile = mcpEnv?.QQ_RUNNER_RESULT_FILE;
  if (seat === "runner") {
    // Fail closed at the launch boundary: a runner without a bound identity or
    // an explicit transport path must not start work or completion.
    if (typeof runnerId !== "string" || !runnerId.trim()) {
      throw new Error("runner seat requires a bound runner identity; missing QQ_RUNNER_ID");
    }
    if (typeof resultFile !== "string" || !resultFile.trim()) {
      throw new Error("runner seat requires an explicit result transport path; missing QQ_RUNNER_RESULT_FILE");
    }
  }
  const settings = ensurePiWorkerSettings(env, resolved);
  const args = [
    WORKER_PI_ADAPTER,
    "--production",
    "--seat", seat,
    "--cwd", cwd,
    "--prompt", prompt,
  ];
  const childEnv = workerIsolationEnv(env);
  delete childEnv.CODEX_HOME;
  delete childEnv.QQ_WORKER_CODEX_HOME;
  // The worker's own pi config root: our explicit context policy plus in-place
  // references to the operator's provider/model/credential registry.
  childEnv.PI_CODING_AGENT_DIR = settings.dir;
  childEnv.PI_SKIP_VERSION_CHECK = "1";
  childEnv.PI_TELEMETRY = "0";
  // Bind the shared search tool to THIS seat and THIS worktree: the binding is
  // owned here, not by whatever the parent process happened to export.
  childEnv.QQ_ZVEC_GREP_ROOT = cwd;
  childEnv.QQ_ZVEC_GREP_SEAT = seat;
  if (seat === "runner") {
    childEnv.QQ_RUNNER_ID = String(runnerId);
    childEnv.QQ_RUNNER_RESULT_FILE = String(resultFile);
  }
  const { key } = resolveWorkerApiKey(resolved, { env });
  if (key) childEnv[resolved.envKey] = key;
  return {
    harness: resolved.harness,
    bin: process.execPath,
    args,
    env: childEnv,
    config: resolved,
    tools: [],
    pi: {
      bin: workerPiBin(env),
      agentDir: settings.dir,
      settingsFile: settings.settingsFile,
      settings: settings.settings,
      registry: { source: settings.source, linked: settings.linked, absent: settings.absent },
      allowedTools: workerPiAllowedTools(seat),
    },
  };
}
