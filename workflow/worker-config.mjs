// Central, operator-controlled worker configuration.
//
// The runner, implementer, and reviewer seats are pinned to DeepSeek Flash
// served through the Codex CLI. Provider/model/endpoint selection lives here
// (driven by an operator-owned config file) and never comes from per-call
// architect arguments, so there is no path by which an agent can select an
// alternative provider for a worker seat.
//
// Fail-closed contract: the resolved provider must be `deepseek` and the model
// must be `deepseek-flash`. Anything else throws before a process is spawned.
// There is no silent fallback to another provider or model.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKER_PROVIDER = "deepseek";
export const WORKER_PROVIDER_NAME = "DeepSeek";
export const WORKER_MODEL = "deepseek-flash";
export const WORKER_BASE_URL = "https://api.deepseek.com";
export const WORKER_WIRE_API = "responses";
export const WORKER_ENV_KEY = "DEEPSEEK_API_KEY";

// Operator-selected worker harness. Absent configuration keeps `codex` so a
// pre-existing operator config, and a rollback, both behave exactly as before.
// The DeepSeek pin (provider/model/base/effort/max) is unchanged either way;
// only the runtime that executes the seat turn differs.
export const WORKER_HARNESSES = ["codex", "deepseek-minimal"];
export const WORKER_HARNESS = "codex";

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

// Reasoning-effort levels the DeepSeek backend serves. An operator may pin one
// in worker-config.json as `reasoning_effort`; the value is validated and
// emitted verbatim as Codex's `model_reasoning_effort`. There is deliberately
// no alias/translation table (e.g. no max -> xhigh): the level on the wire is
// exactly the configured level. Absent means "leave the client default alone".
export const WORKER_REASONING_EFFORT_LEVELS = ["low", "high", "max"];

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

// Only the runner needs an MCP tool: complete_task is its authoritative
// result transport. Implementer/reviewer use Codex-native shell/file tools.
export const WORKER_MCP_TOOLS = {
  runner: ["complete_task"],
  implementer: [],
  reviewer: [],
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

// Validate a candidate worker configuration against the operator-authorized
// pin. Fails closed on anything that is not DeepSeek + deepseek-flash.
export function validateWorkerConfig(supplied = {}, { configFile } = {}) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw new Error("worker configuration must be an object");
  }
  const provider = normalizeWorkerProvider(supplied.provider ?? WORKER_PROVIDER);
  const model = supplied.model ?? supplied.model_id ?? WORKER_MODEL;
  const baseUrl = supplied.base_url ?? supplied.baseUrl ?? WORKER_BASE_URL;
  const wireApi = supplied.wire_api ?? supplied.wireApi ?? WORKER_WIRE_API;
  const envKey = supplied.env_key ?? supplied.envKey ?? WORKER_ENV_KEY;
  const harness = normalizeWorkerHarness(supplied.harness ?? supplied.harness_type);
  const reasoningEffort = normalizeWorkerReasoningEffort(
    supplied.reasoning_effort ?? supplied.reasoningEffort,
  );
  const maxOutputTokens = normalizeWorkerMaxOutputTokens(
    supplied.max_output_tokens ?? supplied.maxOutputTokens,
  );
  const messagesOverride = supplied.messages_base_url ?? supplied.messagesBaseUrl;
  const apiKeyFile = supplied.api_key_file ?? supplied.apiKeyFile
    ?? (configFile ? join(workerConfigDir(configFile), "deepseek-api-key") : null);

  if (provider !== WORKER_PROVIDER) {
    throw new Error(
      `worker provider '${supplied.provider}' is not authorized; workers are pinned to '${WORKER_PROVIDER}' (${WORKER_PROVIDER_NAME})`,
    );
  }
  if (model !== WORKER_MODEL) {
    throw new Error(
      `worker model '${model}' is not authorized; workers are pinned to '${WORKER_MODEL}'`,
    );
  }
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
    throw new Error(`worker base_url '${baseUrl}' must be an http(s) URL`);
  }
  if (wireApi !== "responses") {
    throw new Error(`worker wire_api '${wireApi}' is not supported; expected 'responses'`);
  }
  if (typeof envKey !== "string" || !envKey.trim()) {
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
    provider,
    providerName: WORKER_PROVIDER_NAME,
    model,
    baseUrl,
    wireApi,
    envKey,
    harness,
    messagesBaseUrl,
    maxOutputTokens,
    reasoningEffort,
    apiKeyFile: typeof apiKeyFile === "string" ? apiKeyFile : null,
    configFile,
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
function normalizeWorkerReasoningEffort(value) {
  if (value === undefined || value === null) return null;
  const expected = WORKER_REASONING_EFFORT_LEVELS.join(", ");
  if (typeof value !== "string") {
    throw new Error(
      `worker reasoning_effort must be one of ${expected} (got ${JSON.stringify(value)})`,
    );
  }
  const level = value.trim().toLowerCase();
  if (!WORKER_REASONING_EFFORT_LEVELS.includes(level)) {
    throw new Error(`worker reasoning_effort '${value}' is not supported; expected one of ${expected}`);
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
