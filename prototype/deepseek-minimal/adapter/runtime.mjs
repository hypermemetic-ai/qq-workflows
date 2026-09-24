/**
 * Runtime pinning, mode separation, and environment construction for the
 * DeepSeek Minimal worker adapter.
 *
 * Two explicitly selected modes exist and never weaken one another:
 *
 *   * `mock`       - a loopback-only provider endpoint with a fixed dummy
 *                    credential. A remote endpoint is refused outright, so an
 *                    offline test can never reach a real provider.
 *   * `production` - the operator's configured (https) DeepSeek Messages
 *                    endpoint with the credential resolved through the existing
 *                    worker mechanism. It is selected only by the parent's
 *                    central launch spec (`--production`), never inferred.
 *
 * Everything a seat needs (provider route, model, reasoning effort, the pinned
 * private runtime, the seat instructions) is pinned here; nothing comes from
 * per-call architect arguments.
 *
 * @module adapter/runtime
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deepSeekMinimalRuntimeRoot,
  loadRoleContract,
  WORKER_SEATS,
} from "../../../workflow/worker-config.mjs";
import { FINAL_RESPONSE_MAX_CHARS_LABEL } from "../../../workflow/limits.mjs";
import { SEARCH_SEATS } from "../gateway/zvec-grep-tool.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROTOTYPE_ROOT = dirname(HERE);
export const REPO_ROOT = dirname(dirname(PROTOTYPE_ROOT));
/** Repository-local fallback only; the private runtime lives outside a checkout. */
export const ARTIFACTS_ROOT = join(REPO_ROOT, ".architect", "artifacts", "deepseek-minimal");
export const PIN = JSON.parse(readFileSync(join(PROTOTYPE_ROOT, "PIN.json"), "utf8"));

export const PROVIDER = PIN.provider.route;
export const MODEL = PIN.provider.model;
export const REASONING_EFFORT = PIN.provider.reasoningEffort;
/**
 * Mock-mode output cap. Deliberately NOT a production default: production
 * omits `maxTokens` unless the operator configures `max_output_tokens`, which
 * leaves the upstream llm-deepseek default (256_000) in force.
 */
export const DEFAULT_MAX_TOKENS = 8_192;
export const MODES = ["mock", "production"];
/**
 * Runtime entry: the BUILT CLI (`apps/cli/lib/bin.js`). One module graph per
 * package keeps a single `@deepseek-ai/dsh-tools` instance; loading the TS
 * entry through tsx with the monorepo's path aliases produced two instances of
 * that package (one via aliases, one via node_modules) and broke the tool
 * scheduler symbol. TypeScript inside the pinned checkout still loads because
 * Node strips types natively (`@deepseek-ai/dsh-tool-fs/src/read-image.ts`).
 */
export const CLI_ENTRY = ["apps", "cli", "lib", "bin.js"];
/** The only credential a mock run ever sees; never read from the operator. */
export const DUMMY_API_KEY = "prototype-dummy-key";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Harness completion mechanics for every worker seat. This harness has no
 * completion tool: the adapter bridges the closing response through the
 * existing transport. Keep large artifacts separate when task scope permits.
 */
export const PROTOTYPE_COMPLETION_SECTION = `## Completion
Complete with your closing assistant response, not a completion tool. Keep it within ${FINAL_RESPONSE_MAX_CHARS_LABEL} characters (over-length responses fail closed); reference artifact files for larger outputs when task scope permits them. The adapter delivers your closing message through the existing authoritative transport.`;

/**
 * Adapt a seat's role contract for the harness runtime.
 * @param seat - worker seat.
 * @param body - the role contract prose loaded from agents/<role>/agent.md.
 * @returns the contract with harness completion mechanics appended, replacing
 *   any legacy Completion section so an unavailable tool is never requested.
 */
export function adaptSeatInstructions(seat, body) {
  const start = body.indexOf("## Completion");
  if (start === -1) return `${body.trimEnd()}\n\n${PROTOTYPE_COMPLETION_SECTION}`;
  const next = body.indexOf("\n## ", start + 1);
  const tail = next === -1 ? "" : body.slice(next + 1);
  return `${body.slice(0, start)}${PROTOTYPE_COMPLETION_SECTION}\n\n${tail}`.trimEnd();
}

/** Fail closed on any mock endpoint that is not loopback. */
export function assertLoopbackEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`provider endpoint '${rawUrl}' is not a URL`);
  }
  if (parsed.protocol !== "http:" || !LOOPBACK.has(parsed.hostname)) {
    throw new Error(`provider endpoint '${rawUrl}' is not a loopback http URL; mock runs must not reach a real provider`);
  }
  return parsed.origin;
}

/**
 * Fail closed on an endpoint a production run must not use. Remote endpoints
 * must be https; plain http is tolerated only for a loopback test endpoint.
 * Credentials, query strings, and fragments are never part of a provider root.
 */
export function assertProductionEndpoint(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch {
    throw new Error(`production provider endpoint '${rawUrl}' is not a URL`);
  }
  const loopback = LOOPBACK.has(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new Error(`production provider endpoint '${rawUrl}' must be https (loopback http is allowed only for tests)`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`production provider endpoint '${rawUrl}' must be a root without credentials, query, or fragment`);
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/u, "")}`;
}

/**
 * Resolve the private runtime layout. The shared configurable runtime root is
 * the default; the prototype-only `QQ_PROTO_*` overrides remain for ad-hoc
 * development and never select a different upstream silently in production
 * (provenance is verified either way).
 */
export function runtimeLayout({ runtimeRoot, env = process.env } = {}) {
  const root = runtimeRoot || env.QQ_PROTO_RUNTIME_ROOT || deepSeekMinimalRuntimeRoot(env);
  // A runtime root declares its own (possibly shared) pinned upstream in its
  // provenance, so a relocatable destination resolves without env magic.
  const declared = readDeclaredRuntime(root);
  const upstream = env.QQ_PROTO_UPSTREAM
    ? String(env.QQ_PROTO_UPSTREAM)
    : (declared?.upstreamRoot ?? join(root, "upstream"));
  const dshHome = env.QQ_PROTO_DSH_HOME ? String(env.QQ_PROTO_DSH_HOME) : join(root, "dsh-home");
  return {
    root,
    upstream,
    dshHome,
    // The runtime root carries its own copies; the repo prototype paths are the
    // development fallback when a runtime was materialized without them.
    overlay: firstExisting(
      join(root, "profile", "read-image-only.patch.yml"),
      join(PROTOTYPE_ROOT, "profile", "read-image-only.patch.yml"),
    ),
    plugin: firstExisting(
      join(root, "plugin", "dsh-tool-read-image-only"),
      join(PROTOTYPE_ROOT, "plugin", "dsh-tool-read-image-only"),
    ),
    // Seat-scoped search overlay + the root-bound gateway it mounts. Both are
    // materialized INSIDE the runtime root by setup-runtime.mjs, and the
    // overlay's `command` is anchored at DSH_HOME (this root), so there is
    // deliberately no repo fallback here: a root without them cannot mount the
    // gateway, and `assertSearchArtifacts` fails a search seat closed instead
    // of letting the harness quietly run without the search tool.
    searchOverlay: join(root, "profile", "zvec-grep-gateway.patch.yml"),
    gateway: join(root, "gateway"),
    profileDir: join(dshHome, "profiles", "sdk-minimal"),
    provenanceFile: join(root, "provenance.json"),
  };
}

/** The runtime root's declared upstream/dsh-home, or null when not materialized. */
function readDeclaredRuntime(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, "provenance.json"), "utf8"));
    if (parsed && typeof parsed === "object" && typeof parsed.upstreamRoot === "string" && parsed.upstreamRoot) return parsed;
  } catch {
    /* missing or malformed provenance is reported by verifyRuntimeProvenance */
  }
  return null;
}

function firstExisting(...candidates) {
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return candidates[candidates.length - 1];
}

/**
 * Read and verify the pinned-runtime provenance written by
 * scripts/setup-runtime.mjs. A missing, mismatched, or global-runtime
 * provenance fails closed: the adapter must never run an unpinned harness or
 * the operator's installed global `dsh`.
 */
export function verifyRuntimeProvenance(layout) {
  const file = layout.provenanceFile;
  if (!existsSync(file)) {
    throw new Error(`pinned runtime provenance is missing at '${file}'; run prototype/deepseek-minimal/scripts/setup-runtime.mjs`);
  }
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`pinned runtime provenance at '${file}' is not valid JSON: ${err.message}`);
  }
  if (provenance.head !== PIN.upstream.commit) {
    throw new Error(`pinned runtime provenance at '${file}' names ${provenance.head}, expected pinned ${PIN.upstream.commit}`);
  }
  if (provenance.version !== PIN.upstream.version) {
    throw new Error(`pinned runtime provenance at '${file}' names version ${provenance.version}, expected pinned ${PIN.upstream.version}`);
  }
  if (provenance.globalDshUsed !== false) {
    throw new Error(`pinned runtime provenance at '${file}' does not assert the global dsh was unused`);
  }
  return provenance;
}

/** Defaults the overlay forwards to the gateway; every one is bounded. */
export const GATEWAY_ENV_DEFAULTS = Object.freeze({
  QQ_ZVEC_GREP_BIN: "zg",
  QQ_ZVEC_GREP_SEARCH_TIMEOUT_MS: "180000",
  QQ_ZVEC_GREP_INDEX_TIMEOUT_MS: "600000",
  QQ_ZVEC_GREP_RECONCILE_ATTEMPTS: "1",
  QQ_ZVEC_GREP_RECONCILE_DELAY_MS: "1000",
});

/**
 * Resolve the seat-scoped search binding.
 *
 * Only the implementer and reviewer seats receive the gateway, and only when
 * the seat has an explicit worktree cwd. The runner (and any other seat) gets
 * `null`, so no overlay is appended and the tool surface stays unchanged.
 *
 * The bound root is the seat's own resolved cwd - never the runtime upstream
 * checkout, never a repo-relative guess - and it must be an existing
 * directory: a seat that cannot be bound to its worktree fails closed instead
 * of silently querying some other root.
 *
 * @param seat - worker seat.
 * @param cwd - the seat's working directory (the prepared worktree).
 * @returns `{root, seat}` for a search seat, otherwise `null`.
 */
export function resolveSearchBinding(seat, cwd) {
  if (!SEARCH_SEATS.includes(seat)) return null;
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new Error(`seat '${seat}' requires an explicit worktree cwd to bind zvec-grep search`);
  }
  const root = resolve(cwd);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`seat '${seat}' worktree root '${root}' is not an existing directory; refusing to bind zvec-grep search`);
  }
  return { root, seat };
}

/**
 * The runtime-root artifacts the seat-scoped search overlay mounts. Every one
 * is created by scripts/setup-runtime.mjs; the list is checked before the
 * harness starts for an implementer/reviewer seat.
 */
function searchArtifacts(layout) {
  return [
    join(layout.gateway, "zvec-grep-gateway.mjs"),
    join(layout.gateway, "zvec-grep-tool.mjs"),
    join(layout.gateway, "zvec-grep-search.tool.json"),
    join(layout.gateway, "node_modules", "@modelcontextprotocol", "server"),
    join(layout.gateway, "node_modules", "@modelcontextprotocol", "client"),
    layout.searchOverlay,
    join(layout.profileDir, "node_modules", "@deepseek-ai", "dsh-mcp-client"),
  ];
}

/**
 * Fail closed when this runtime root cannot mount the search gateway.
 *
 * dsh treats a plugin row that fails to activate as a warning, not a boot
 * failure, so a half-materialized root would otherwise run the seat with a
 * silently missing `mcp__zvec_grep__zvec_grep_search`. The check is static and
 * cheap: the gateway script and its reviewed snapshot, the MCP protocol
 * libraries the gateway imports, the overlay that mounts it, and the bridge
 * package the overlay's row resolves.
 *
 * @param layout - resolved runtime layout.
 * @throws when any reviewed artifact is absent.
 */
export function assertSearchArtifacts(layout) {
  const missing = searchArtifacts(layout).filter(path => !existsSync(path));
  if (missing.length === 0) return layout;
  const shown = missing.slice(0, 4).map(path => relative(layout.root, path) || path);
  const more = missing.length > shown.length ? ` (+${missing.length - shown.length} more)` : "";
  throw new Error(
    `zvec-grep search gateway is not materialized in the runtime root '${layout.root}' `
    + `(missing ${shown.join(", ")}${more}); run prototype/deepseek-minimal/scripts/setup-runtime.mjs `
    + "against this root before dispatching an implementer/reviewer seat",
  );
}

/**
 * Resolve the pinned runtime, seat instructions, and provider endpoint.
 * @param options.seat - worker seat (runner/implementer/reviewer).
 * @param options.mode - `mock` (loopback only) or `production` (explicit).
 * @param options.baseUrl - mock provider origin; required in mock mode.
 * @param options.endpoint - explicit production Messages root from the central
 *   operator configuration (already normalized by workflow/worker-config.mjs).
 * @param options.runtimeRoot - shared configurable runtime root.
 * @param options.maxTokens - operator-configured output cap, or undefined to
 *   leave the upstream default untouched.
 * @param options.cwd - the seat's worktree cwd; binds the search gateway for
 *   the implementer/reviewer seats.
 * @param options.env - environment for the isolated paths.
 */
export function resolveRuntime({
  seat,
  mode = "mock",
  baseUrl,
  endpoint,
  runtimeRoot,
  maxTokens,
  cwd,
  env = process.env,
} = {}) {
  if (!WORKER_SEATS.includes(seat)) throw new Error(`unknown worker seat '${seat}'`);
  if (!MODES.includes(mode)) throw new Error(`unknown adapter mode '${mode}'`);
  const layout = runtimeLayout({ runtimeRoot, env });
  const provenance = verifyRuntimeProvenance(layout);

  const cli = join(layout.upstream, ...CLI_ENTRY);
  const upstreamPackage = join(layout.upstream, "package.json");
  for (const required of [
    cli,
    upstreamPackage,
    layout.overlay,
    join(layout.plugin, "index.mjs"),
    join(layout.profileDir, "cordis.yml"),
  ]) {
    if (!existsSync(required)) {
      throw new Error(`pinned runtime is not prepared at '${required}'; run prototype/deepseek-minimal/scripts/setup-runtime.mjs`);
    }
  }
  const version = JSON.parse(readFileSync(upstreamPackage, "utf8")).version;
  if (version !== PIN.upstream.version) {
    throw new Error(`pinned runtime at '${layout.upstream}' reports version ${version}, expected pinned ${PIN.upstream.version}`);
  }

  const resolvedEndpoint = mode === "production"
    ? assertProductionEndpoint(endpoint)
    : assertLoopbackEndpoint(baseUrl ?? env.QQ_PROTO_PROVIDER_URL ?? "");
  if (maxTokens !== undefined && maxTokens !== null
    && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)) {
    throw new Error(`maxTokens must be a positive integer (got ${JSON.stringify(maxTokens)})`);
  }
  const search = resolveSearchBinding(seat, cwd);
  const launchArgs = [cli, "--profile", "sdk-minimal", "--patch", layout.overlay];
  if (search !== null) {
    assertSearchArtifacts(layout);
    launchArgs.push("--patch", layout.searchOverlay);
  }
  return {
    seat,
    mode,
    provider: PROVIDER,
    model: MODEL,
    reasoningEffort: REASONING_EFFORT,
    maxTokens: maxTokens ?? null,
    search,
    launch: { bin: process.execPath, args: launchArgs, cwd: layout.upstream },
    layout,
    provenance,
    dshHome: layout.dshHome,
    endpoint: resolvedEndpoint,
    instructions: adaptSeatInstructions(seat, loadRoleContract(seat).body),
  };
}

/**
 * Environment for the harness child.
 *
 * Isolation rules: workflow routing identity, provider-selection flags, and
 * every credential-shaped variable are removed from the inherited environment
 * before the provider credential is added back. The harness itself scrubs
 * `KEY|PASSWORD|SECRET|TOKEN` names before spawning any shell or tool child
 * (pinned `dsh-subprocess` `scrubbedParentEnv`), so the provider credential
 * never reaches a model-driven subprocess.
 *
 * @param options.env - parent environment.
 * @param options.runtime - resolved runtime.
 * @param options.apiKey - credential for production mode; refused when absent.
 */
export function harnessEnv({ env = process.env, runtime, apiKey }) {
  const child = { ...env };
  for (const key of [
    "QQ_RUNNER_ID",
    "QQ_RUNNER_RESULT_FILE",
    "QQ_RUNNER_MARKER_FILE",
    "QQ_IMPLEMENTER_PROVIDER",
    "QQ_REVIEWER_PROVIDER",
    // Legacy researcher seat selection: no longer a role, scrubbed defensively.
    "QQ_RESEARCHER_PROVIDER",
    "QQ_WORKFLOW_PROVIDER",
    "QQ_WORKER_CONFIG_FILE",
    "QQ_WORKER_CODEX_HOME",
    "QQ_WORKER_CODEX_BIN",
    "QQ_CODEX_BIN",
    "QQ_SUBAGENT_BIN",
    "QQ_DEEPSEEK_RUNTIME_ROOT",
    "QQ_PROTO_RUNTIME_ROOT",
    "QQ_PROTO_UPSTREAM",
    "QQ_PROTO_DSH_HOME",
    "QQ_PROTO_PROVIDER_URL",
    "CODEX_HOME",
    "CODEX_THREAD_ID",
    "CODEX_SESSION_ID",
    "CODEX_CONVERSATION_ID",
  ]) {
    delete child[key];
  }
  // The harness forwards non-credential-shaped ambient variables to tools, so
  // drop every credential-shaped name here as well and add back only the
  // provider credential this runtime is meant to present.
  for (const key of Object.keys(child)) {
    if (/KEY|PASSWORD|SECRET|TOKEN/iu.test(key)) delete child[key];
  }
  let credential;
  if (runtime.mode === "production") {
    if (typeof apiKey !== "string" || apiKey.trim() === "") {
      throw new Error("production harness requires a resolved provider credential; refusing to run with dummy auth");
    }
    credential = apiKey;
  } else {
    credential = DUMMY_API_KEY;
  }
  child.DSH_HOME = runtime.dshHome;
  child.DSH_SYSTEM_PROMPT = runtime.instructions;
  // Seat-scoped search binding. Explicit, bounded, and never inherited: the
  // overlay reads exactly these names, and the gateway re-validates them.
  if (runtime.search) {
    child.QQ_ZVEC_GREP_ROOT = runtime.search.root;
    child.QQ_ZVEC_GREP_SEAT = runtime.search.seat;
    for (const [name, fallback] of Object.entries(GATEWAY_ENV_DEFAULTS)) {
      const supplied = typeof env[name] === "string" && env[name].trim() !== "" ? env[name].trim() : fallback;
      child[name] = supplied;
    }
  }
  child.DEEPSEEK_BASE_URL = runtime.endpoint;
  child.DEEPSEEK_API_KEY = credential;
  return child;
}
