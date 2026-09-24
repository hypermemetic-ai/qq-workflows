#!/usr/bin/env node
/**
 * Effective seat instructions for the one Pi worker runtime.
 *
 * The runtime has a fixed tool allowlist and no MCP server. Append only
 * Pi completion mechanics to the shared role body, and refuse unavailable
 * tool references before the prompt reaches the model.
 *
 * @module pi-worker/instructions
 */
import { FINAL_RESPONSE_MAX_CHARS_LABEL } from "../limits.mjs";
import { COMMUNICATION_TOOL_NAMES } from "../communication.mjs";
import { WORKER_PI_TOOLS, loadRoleContract } from "../worker-config.mjs";

/**
 * The one extension tool every worker seat receives (registered by
 * `pi-extension/worker-tools.mjs`, pinned equal to `WORKER_SEARCH_TOOL_NAME` and
 * to every seat's allowlist by `tests/pi-worker.mjs`).
 */
export const PI_SEARCH_TOOL = "zvec_grep_search";

/** The adapter bridges the closing assistant response through the existing
 * authoritative completion transport; Pi exposes no completion tool. */
export const PI_COMPLETION_SECTION = `## Pi completion
Complete with your closing assistant response, not a completion tool. Keep it within ${FINAL_RESPONSE_MAX_CHARS_LABEL} characters (over-length responses fail closed); reference artifact files for larger outputs when task scope permits them.`;

/**
 * Legacy/MCP tool spellings that appear in the shared contracts, mapped to the
 * Pi worker runtime's equivalent. `null` means the runtime has no equivalent:
 * a reference that survives adaptation refuses the launch.
 */
export const PI_WORKER_TOOL_EQUIVALENTS = Object.freeze({
  "mcp__qq_workflows__complete_task": null,
  complete_task: null,
  "mcp__zvec_grep__zvec_grep_search": PI_SEARCH_TOOL,
  [PI_SEARCH_TOOL]: PI_SEARCH_TOOL,
  // Runner communication tools (registered only on a validated,
  // communication-enabled runner): mapped to themselves so a contract that
  // names them resolves exactly when the runtime actually exposes them - a
  // reference on a non-communication launch still refuses, as it must.
  ...Object.fromEntries(COMMUNICATION_TOOL_NAMES.map((name) => [name, name])),
  view_file: "read",
  read_image: "read",
  run_command: "bash",
  grep_search: "grep",
  find_by_name: "find",
  list_dir: "ls",
  write_to_file: "write",
  replace_file_content: "edit",
  read_url_content: null,
  search_web: "search_web",
});

const BACKTICKED = /`([^`\n]+)`/gu;
const MCP_QUALIFIED = /mcp__[a-z0-9_]+(?:__[a-z0-9_]+)?/gu;

/**
 * Tool names a seat's instruction body actually names: any MCP-qualified
 * spelling (this runtime has no MCP server, so every one of them is
 * unavailable) plus any backticked token from the known tool vocabulary. Prose
 * words are not guesses: only explicit mentions are returned.
 */
export function referencedToolNames(body) {
  const text = String(body ?? "");
  const references = new Set();
  for (const match of text.matchAll(MCP_QUALIFIED)) references.add(match[0]);
  for (const match of text.matchAll(BACKTICKED)) {
    const token = match[1].trim();
    if (Object.hasOwn(PI_WORKER_TOOL_EQUIVALENTS, token)) references.add(token);
  }
  return [...references].sort();
}

/** The named tools of `body` that this seat's allowlist cannot resolve. */
export function unavailablePiSeatTools({ body, tools = [] }) {
  const allowed = new Set(tools);
  const unavailable = [];
  for (const reference of referencedToolNames(body)) {
    const piTool = PI_WORKER_TOOL_EQUIVALENTS[reference];
    if (typeof piTool === "string" && allowed.has(piTool)) continue;
    unavailable.push(reference);
  }
  return unavailable;
}

function adaptBody({ body }) {
  return { body: `${body.trimEnd()}\n\n${PI_COMPLETION_SECTION}`, adaptedSections: ["Pi completion"] };
}

function assertResolvable({ seat, body, tools }) {
  const unavailable = unavailablePiSeatTools({ body, tools });
  if (unavailable.length === 0) return;
  throw Object.assign(
    new Error(
      `seat '${seat}' instructions name ${unavailable.map((name) => `'${name}'`).join(", ")}, which this runtime does not expose `
      + `(allowlist: ${tools.length > 0 ? tools.join(", ") : "none"}); refusing instead of instructing an impossible action`,
    ),
    { code: "instruction_tool_unavailable", unavailable },
  );
}

/**
 * Adapt one shared seat contract for the Pi runtime. Throws (code
 * `instruction_tool_unavailable`) when a tool the body names cannot resolve in
 * this runtime.
 */
export function adaptPiSeatInstructions({ seat, body, tools = WORKER_PI_TOOLS[seat] ?? [] }) {
  const { body: adapted } = adaptBody({ body });
  assertResolvable({ seat, body: adapted, tools });
  return adapted;
}

/**
 * Load and adapt a seat's shared contract. Returns the effective body plus the
 * evidence the adapter records: which sections were adapted and which tool
 * names the effective instructions contain (all of them resolvable).
 */
export function loadPiSeatInstructions(seat, { tools = WORKER_PI_TOOLS[seat] ?? [] } = {}) {
  const contract = loadRoleContract(seat);
  const { body, adaptedSections } = adaptBody({ body: contract.body });
  assertResolvable({ seat, body, tools });
  return { source: contract.path, body, adaptedSections, namedTools: referencedToolNames(body) };
}
