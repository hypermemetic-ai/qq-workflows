/**
 * Pure, runtime-free logic for the root-bound `zvec_grep_search` gateway.
 *
 * The gateway exists because the agent MCP toolset exposes exactly one tool
 * (`zvec_grep_search`) whose schema carries three caller-supplied fields the
 * harness must never let the model choose:
 *
 *   * `root`       - would let a seat query the main repo or any other absolute
 *                    path (the audit's "isolation is advisory" finding);
 *   * `freshness`  - `eventual` returns possibly-stale results;
 *   * `autoUpdate` - `false` suppresses the search-triggered reconciliation
 *                    that heals a stale index.
 *
 * This module owns the deterministic, side-effect-free part of that contract:
 * the model-facing tool definition (derived from the pinned upstream snapshot,
 * `zvec-grep-search.tool.json`), the defensive rejection of override fields,
 * the canonical arguments the gateway always forwards, and the classification
 * of upstream results (missing index / freshness) plus the gateway's validated
 * environment. The executable wiring (MCP server + MCP stdio client, index
 * CLI, timeouts, cancellation) lives in `zvec-grep-gateway.mjs`, which imports
 * this module; keeping the decisions here lets the runtime-independent core
 * suite verify them without the pinned runtime.
 *
 * Model-facing schema rules (all enforced below, all tested):
 *   * the three injected fields are REMOVED from `properties` and `required`;
 *   * every remaining upstream query/filter option is kept;
 *   * the advertised object is closed (`additionalProperties: false`) so an
 *     unknown or override field is refused by both schema and handler;
 *   * the schema is projected into the harness's enforced JSON Schema subset
 *     (`dsh-tools` `assertSupportedJsonSchema`): `type`/`oneOf`/`properties`/
 *     `required`/`additionalProperties`/`items`/`enum`/`const` plus the
 *     `description`/`title`/`default`/`examples` annotations. `anyOf` becomes
 *     `oneOf`; pure numeric/length bounds and `$schema` are dropped because the
 *     subset has no vocabulary for them (zg still enforces them and reports a
 *     bounded validation error). Any other keyword fails closed so a refreshed
 *     snapshot cannot silently widen or misinterpret the advertised contract.
 *
 * Model-facing description rule (also enforced below and tested): the published
 * description is the pinned upstream snapshot's OWN text, re-derived at load
 * with only the documented hidden-field adaptations applied (see
 * `modelFacingDescription`). No authored prose, indexing, or waiting
 * implementation detail is published, and a refreshed snapshot that no longer
 * carries the reviewed wording fails closed rather than silently shipping
 * unreviewed prose to the model.
 *
 * @module gateway/zvec-grep-tool
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GATEWAY_DIR = dirname(fileURLToPath(import.meta.url));
export const SNAPSHOT_FILE = join(GATEWAY_DIR, "zvec-grep-search.tool.json");

/** Public MCP server namespace; dsh composes `mcp__<server>__<tool>`. */
export const SERVER_NAME = "zvec_grep";
/** Raw upstream tool name (the only tool the pinned agent toolset exposes). */
export const TOOL_NAME = "zvec_grep_search";
/** The one model-visible tool name this gateway publishes. */
export const PUBLIC_TOOL_NAME = `mcp__${SERVER_NAME}__${TOOL_NAME}`;
/** Seats that receive the gateway; the runner deliberately never does. */
export const SEARCH_SEATS = Object.freeze(["implementer", "reviewer"]);
/** Upstream launch: the reviewed stdio bridge into the shared zg daemon. */
export const SERVER_COMMAND_ARGS = Object.freeze(["server", "--stdio", "--mcp-toolset", "agent"]);
/** Fields the gateway always supplies and the model must never supply. */
export const INJECTED_SEARCH_FIELDS = Object.freeze(["root", "freshness", "autoUpdate"]);
/** Canonical injected values. */
export const INJECTED_FRESHNESS = "wait_for_fresh";
export const INJECTED_AUTO_UPDATE = true;
/** Upstream error code meaning "no index exists for this root". */
export const INDEX_MISSING_CODE = "INDEX_MISSING";

export const DEFAULT_ZG_BIN = "zg";
export const DEFAULT_SEARCH_TIMEOUT_MS = 180_000;
export const DEFAULT_INDEX_TIMEOUT_MS = 600_000;
export const DEFAULT_RECONCILE_ATTEMPTS = 1;
export const DEFAULT_RECONCILE_DELAY_MS = 1_000;

/** Environment names the gateway reads (all supplied by the adapter/overlay). */
export const ENV_ROOT = "QQ_ZVEC_GREP_ROOT";
export const ENV_SEAT = "QQ_ZVEC_GREP_SEAT";
export const ENV_BIN = "QQ_ZVEC_GREP_BIN";
export const ENV_SEARCH_TIMEOUT_MS = "QQ_ZVEC_GREP_SEARCH_TIMEOUT_MS";
export const ENV_INDEX_TIMEOUT_MS = "QQ_ZVEC_GREP_INDEX_TIMEOUT_MS";
export const ENV_RECONCILE_ATTEMPTS = "QQ_ZVEC_GREP_RECONCILE_ATTEMPTS";
export const ENV_RECONCILE_DELAY_MS = "QQ_ZVEC_GREP_RECONCILE_DELAY_MS";

/** JSON Schema keywords the harness subset enforces (kept verbatim). */
const SUPPORTED_KEYWORDS = new Set([
  "type", "oneOf", "properties", "required", "additionalProperties", "items", "enum", "const",
  "description", "title", "default", "examples",
]);
/** Upstream union keyword: projected to `oneOf`, which the subset enforces. */
const UNION_KEYWORD = "anyOf";
/**
 * Constraint keywords with no vocabulary in the harness subset. Dropping them
 * keeps the *option* (the property) while leaving its enforcement to zg.
 */
const DROPPED_KEYWORDS = new Set([
  "$schema", "$id", "$comment", "$defs", "definitions",
  "maxLength", "minLength", "pattern", "format",
  "maxItems", "minItems", "uniqueItems", "contains",
  "maximum", "minimum", "exclusiveMaximum", "exclusiveMinimum", "multipleOf",
  "readOnly", "writeOnly", "deprecated", "contentEncoding", "contentMediaType",
]);
/** Keywords valid only beside `oneOf`/`type`; kept only where the subset allows. */
const STRUCTURAL_KEYWORDS = new Set(["properties", "required", "additionalProperties", "items", "enum", "const"]);

/** Read the pinned upstream tool snapshot (provenance + verbatim tool). */
export function readSearchToolSnapshot(file = SNAPSHOT_FILE) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`zvec-grep tool snapshot '${file}' is unreadable: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || !parsed.tool || typeof parsed.tool !== "object") {
    throw new Error(`zvec-grep tool snapshot '${file}' must carry a 'tool' object`);
  }
  if (parsed.tool.name !== TOOL_NAME) {
    throw new Error(`zvec-grep tool snapshot names tool '${parsed.tool.name}', expected '${TOOL_NAME}'`);
  }
  return parsed;
}

/**
 * Project one upstream JSON Schema node into the harness's enforced subset.
 * @param node - verbatim upstream schema node.
 * @param path - diagnostic path for fail-closed keyword rejections.
 */
function projectSchemaNode(node, path) {
  if (Array.isArray(node)) return node.map((entry, index) => projectSchemaNode(entry, `${path}[${index}]`));
  if (!node || typeof node !== "object") {
    if (typeof node === "boolean") return node;
    throw new Error(`${path} must be a schema object`);
  }
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (SUPPORTED_KEYWORDS.has(key) || key === UNION_KEYWORD) continue;
    if (DROPPED_KEYWORDS.has(key)) continue;
    throw new Error(
      `${path}.${key} is not part of the reviewed zvec-grep search vocabulary; `
      + "re-review the gateway snapshot before publishing it to the model",
    );
  }
  for (const key of ["description", "title", "default", "examples"]) {
    if (Object.hasOwn(node, key)) out[key] = node[key];
  }
  if (Object.hasOwn(node, "type")) {
    if (typeof node.type !== "string") throw new Error(`${path}.type must be a single type string`);
    out.type = node.type;
  }
  if (Object.hasOwn(node, "enum")) out.enum = node.enum;
  if (Object.hasOwn(node, "const")) out.const = node.const;
  if (Object.hasOwn(node, "anyOf") && Object.hasOwn(node, "oneOf")) {
    throw new Error(`${path} carries both anyOf and oneOf`);
  }
  const union = node.oneOf ?? node.anyOf;
  if (Array.isArray(union)) {
    if (union.length < 2) throw new Error(`${path} union needs at least two branches`);
    out.oneOf = union.map((branch, index) => projectSchemaNode(branch, `${path}.oneOf[${index}]`));
  }
  if (Object.hasOwn(node, "properties")) {
    out.properties = {};
    for (const [key, value] of Object.entries(node.properties)) {
      out.properties[key] = projectSchemaNode(value, `${path}.properties.${key}`);
    }
  }
  if (Object.hasOwn(node, "required")) {
    out.required = [...node.required];
  }
  if (Object.hasOwn(node, "additionalProperties")) out.additionalProperties = node.additionalProperties;
  if (Object.hasOwn(node, "items")) out.items = projectSchemaNode(node.items, `${path}.items`);
  // A branch of `oneOf` may not carry structural siblings the subset rejects.
  if (Array.isArray(union)) {
    for (const key of STRUCTURAL_KEYWORDS) {
      if (Object.hasOwn(out, key)) throw new Error(`${path}.${key} is not supported beside a union`);
    }
  }
  return out;
}

/**
 * Derive the model-facing input schema from the upstream snapshot.
 *
 * `root`, `freshness`, and `autoUpdate` MUST be present upstream (their removal
 * is the whole point) and MUST be gone from the result. The advertised object
 * is closed, and any `required` entry naming a removed field is dropped.
 *
 * @param tool - the snapshot's verbatim upstream tool.
 * @returns the harness-subset schema advertised to the model.
 */
export function modelFacingSearchSchema(tool) {
  const upstream = tool?.inputSchema;
  if (!upstream || typeof upstream !== "object" || Array.isArray(upstream)) {
    throw new Error("upstream zvec_grep_search inputSchema is missing");
  }
  if (upstream.type !== "object" || typeof upstream.properties !== "object" || upstream.properties === null) {
    throw new Error("upstream zvec_grep_search inputSchema must be an object with properties");
  }
  for (const field of INJECTED_SEARCH_FIELDS) {
    if (!Object.hasOwn(upstream.properties, field)) {
      throw new Error(`upstream zvec_grep_search schema no longer declares '${field}'; refresh the gateway snapshot`);
    }
  }
  const projected = projectSchemaNode(upstream, "zvec_grep_search.inputSchema");
  const properties = {};
  for (const [key, value] of Object.entries(projected.properties)) {
    if (INJECTED_SEARCH_FIELDS.includes(key)) continue;
    properties[key] = value;
  }
  if (Object.keys(properties).length === 0) {
    throw new Error("the model-facing zvec_grep_search schema would expose no options");
  }
  const required = (projected.required ?? []).filter(entry => !INJECTED_SEARCH_FIELDS.includes(entry));
  return Object.freeze({
    type: "object",
    properties: Object.freeze(properties),
    required: Object.freeze(required),
    additionalProperties: false,
  });
}

/**
 * The ONLY reviewed deviations from the pinned upstream description. The
 * operator requires the official wording: the wrapper hides `root`,
 * `freshness`, and `autoUpdate`, so the single reference the hidden root makes
 * inapplicable - the caller choosing "an existing workspace index" - is
 * rewritten to the bound worktree. Every other sentence, including the
 * `freshness`/`background_refresh` RESPONSE guidance (those fields are returned,
 * not hidden), is retained verbatim.
 */
const DESCRIPTION_ADAPTATIONS = Object.freeze([
  Object.freeze({ from: "Search an existing workspace index", to: "Search the bound worktree's index" }),
]);

/**
 * The model-facing description: the pinned upstream snapshot's own description
 * with only the documented hidden-field adaptations applied. Fails closed if the
 * snapshot no longer carries the reviewed wording, so refreshing the snapshot
 * can never silently publish unreviewed prose to the model.
 * @param tool - the snapshot's verbatim upstream tool.
 */
export function modelFacingDescription(tool) {
  const upstream = tool?.description;
  if (typeof upstream !== "string" || upstream.trim() === "") {
    throw new Error("upstream zvec_grep_search description is missing; refresh the gateway snapshot");
  }
  let description = upstream;
  for (const { from, to } of DESCRIPTION_ADAPTATIONS) {
    if (!description.includes(from)) {
      throw new Error(`the upstream zvec_grep_search description no longer contains '${from}'; refresh the gateway snapshot`);
    }
    description = description.replace(from, to);
  }
  return description;
}

/** The model-facing tool definition (name, official description, projected schema). */
export function modelFacingTool(tool) {
  return Object.freeze({
    name: TOOL_NAME,
    description: modelFacingDescription(tool),
    inputSchema: modelFacingSearchSchema(tool),
  });
}

/**
 * Reject caller-supplied override fields. `root`/`freshness`/`autoUpdate` are
 * refused by name (defense in depth) and any field outside the model-facing
 * schema is refused as unknown.
 * @param args - candidate tool arguments (any JSON value).
 * @param schema - the model-facing schema.
 * @returns a bounded violation list; empty means acceptable.
 */
export function searchArgumentViolations(args, schema) {
  if (args === undefined || args === null) return [];
  if (typeof args !== "object" || Array.isArray(args)) {
    return ["arguments must be a JSON object of search options"];
  }
  const violations = [];
  const allowed = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(args)) {
    if (INJECTED_SEARCH_FIELDS.includes(key)) {
      violations.push(`'${key}' is bound by the harness for this worktree and must not be supplied`);
      continue;
    }
    if (!allowed.has(key)) violations.push(`'${key}' is not a supported search option`);
  }
  return violations;
}

/**
 * Canonical forwarded arguments: the caller's accepted options plus the three
 * bound values, always spelled exactly the same way.
 * @param args - caller options (already validated).
 * @param root - the bound absolute worktree root.
 */
export function boundSearchArguments(args, root) {
  const forwarded = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (INJECTED_SEARCH_FIELDS.includes(key)) continue;
    if (value === undefined) continue;
    forwarded[key] = value;
  }
  forwarded.root = root;
  forwarded.freshness = INJECTED_FRESHNESS;
  forwarded.autoUpdate = INJECTED_AUTO_UPDATE;
  return forwarded;
}

/** Text blocks of one MCP tool result, joined, bounded for classification. */
function resultText(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map(block => block.text)
    .join("\n");
}

/**
 * Whether an upstream result proves the root has no index yet. Accepts every
 * shape the pinned server can produce: an `isError` text result carrying the
 * `[INDEX_MISSING]`/`INDEX_MISSING` code, a `structuredContent.error.code`, or
 * a thrown JSON-RPC error whose message carries the code.
 * @param result - MCP result object, or `{error}` for a thrown transport error.
 */
export function indexMissingEvidence(result) {
  if (result === undefined || result === null) return false;
  if (result.isError === true) {
    const text = resultText(result);
    if (text.includes(INDEX_MISSING_CODE)) return true;
    const code = result.structuredContent?.error?.code;
    if (typeof code === "string" && code.includes(INDEX_MISSING_CODE)) return true;
    return false;
  }
  const message = result.error?.message ?? result.message;
  return typeof message === "string" && message.includes(INDEX_MISSING_CODE);
}

/**
 * The freshness the upstream reply reports, when it reports one. Only the
 * pinned server's own status line (and its structured twin) counts as proof.
 * @param result - MCP result object.
 */
export function reportedFreshness(result) {
  if (result === undefined || result === null || result.isError === true) return undefined;
  const structured = result.structuredContent?.freshness;
  if (structured === "fresh" || structured === "possibly_stale") return structured;
  const match = /^freshness:\s*(fresh|possibly_stale)\s*$/mu.exec(resultText(result));
  return match === null ? undefined : match[1];
}

/** Whether an upstream reply is a possibly-stale result that still needs reconciliation. */
export function needsReconcile(result) {
  return reportedFreshness(result) === "possibly_stale";
}

/** Whether an upstream reply is a definitive no-matches answer. */
export function reportsNoMatches(result) {
  if (result?.isError === true) return false;
  return /^No matches\.$/mu.test(resultText(result));
}

/** The supported index CLI invocation: exact root, no rebuild/drop/ignore flags. */
export function indexCommand(root) {
  return ["index", root];
}

/** The upstream stdio MCP launch argv (never a daemon port or PID). */
export function serverCommandArgs() {
  return [...SERVER_COMMAND_ARGS];
}

function positiveInt(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${field} must be a positive integer (got ${JSON.stringify(value)})`);
  }
  return parsed;
}

/**
 * Validate and resolve the gateway's environment. Fails closed on anything
 * ambiguous: the bound root must be an absolute EXISTING directory (never a
 * guess, never the runtime upstream cwd), the seat must be one of the two
 * search seats, and every bound must be a positive integer.
 * @param env - environment (defaults to `process.env`).
 */
export function searchGatewayEnv(env = process.env) {
  const rawRoot = env[ENV_ROOT];
  if (typeof rawRoot !== "string" || rawRoot.trim() === "") {
    throw new Error(`${ENV_ROOT} is required: the gateway must be bound to an explicit worktree root`);
  }
  const root = resolve(rawRoot.trim());
  if (!isAbsolute(root)) throw new Error(`${ENV_ROOT} '${rawRoot}' must be absolute`);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`${ENV_ROOT} '${root}' is not an existing directory`);
  }
  const seat = env[ENV_SEAT];
  if (!SEARCH_SEATS.includes(seat)) {
    throw new Error(`${ENV_SEAT} must be one of ${SEARCH_SEATS.join(", ")} (got ${JSON.stringify(seat)})`);
  }
  const bin = typeof env[ENV_BIN] === "string" && env[ENV_BIN].trim() !== "" ? env[ENV_BIN].trim() : DEFAULT_ZG_BIN;
  return Object.freeze({
    root,
    seat,
    bin,
    searchTimeoutMs: env[ENV_SEARCH_TIMEOUT_MS] === undefined ? DEFAULT_SEARCH_TIMEOUT_MS : positiveInt(env[ENV_SEARCH_TIMEOUT_MS], ENV_SEARCH_TIMEOUT_MS),
    indexTimeoutMs: env[ENV_INDEX_TIMEOUT_MS] === undefined ? DEFAULT_INDEX_TIMEOUT_MS : positiveInt(env[ENV_INDEX_TIMEOUT_MS], ENV_INDEX_TIMEOUT_MS),
    reconcileAttempts: env[ENV_RECONCILE_ATTEMPTS] === undefined
      ? DEFAULT_RECONCILE_ATTEMPTS
      : nonNegativeInt(env[ENV_RECONCILE_ATTEMPTS], ENV_RECONCILE_ATTEMPTS),
    reconcileDelayMs: env[ENV_RECONCILE_DELAY_MS] === undefined
      ? DEFAULT_RECONCILE_DELAY_MS
      : nonNegativeInt(env[ENV_RECONCILE_DELAY_MS], ENV_RECONCILE_DELAY_MS),
  });
}

function nonNegativeInt(value, field) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return parsed;
}
