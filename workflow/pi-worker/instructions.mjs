#!/usr/bin/env node
/**
 * Effective seat instructions for the one Pi worker runtime.
 *
 * The runtime surface is fixed before the model sees it: `pi --mode rpc` is
 * launched with a `--tools` allowlist plus exactly one extension tool
 * (`zvec_grep_search`) and with **no MCP server at all**
 * (`workflow/worker-config.mjs` `buildPiWorkerLaunch`). The shared role
 * contracts in `agents/<role>/agent.md` are written for the MCP/Codex era: the
 * runner's `## Completion` section mandates `mcp__qq_workflows__complete_task`,
 * and the shared workspace-search section names the MCP-qualified ZG spelling.
 * Appended verbatim to the system prompt, those sections order a worker to call
 * a tool this runtime cannot resolve - the instruction surface contradicting the
 * executable surface, which is the failure mode this module removes.
 *
 * Exactly two sections are adapted, in the terms of THIS runtime:
 *
 *   1. `## Completion` (the runner) is replaced by the transport the adapter
 *      actually implements - the closing assistant message, bridged through the
 *      existing authoritative completion modules - and names no tool at all;
 *   2. `## Workspace search` names the tool the runtime registers
 *      (`zvec_grep_search`), or states plainly that no search tool is exposed.
 *
 * Everything else (role boundaries, task instructions, reporting shape) stays
 * byte-identical to the shared contract, and every remaining tool reference is
 * checked against the seat's allowlist: a name that cannot resolve refuses the
 * launch (exit 2) instead of reaching the model as an impossible instruction.
 *
 * @module pi-worker/instructions
 */
import { FINAL_RESPONSE_MAX_CHARS_LABEL } from "../limits.mjs";
import { WORKER_PI_TOOLS, loadRoleContract } from "../worker-config.mjs";

/**
 * The one extension tool every worker seat receives (registered by
 * `pi-extension/worker-tools.mjs`, pinned equal to `WORKER_SEARCH_TOOL_NAME` and
 * to every seat's allowlist by `tests/pi-worker.mjs`).
 */
export const PI_SEARCH_TOOL = "zvec_grep_search";

const COMPLETION_HEADING = "## Completion";
const SEARCH_INTRO = "When this runtime exposes `mcp__zvec_grep__zvec_grep_search`, use it to";

/**
 * The completion instruction for a runtime that exposes no completion tool.
 * Deliberately free of tool names: the result is the closing assistant message,
 * which the adapter bridges through `completeTask` + the runner-result
 * validator (`workflow/pi-worker/adapter.mjs`).
 */
export const PI_COMPLETION_SECTION = `## Completion
When finished, write your final answer as the closing assistant message of your turn: a concise synthesis with key evidence (with exact file and line references where applicable) and remaining uncertainties, respecting the ${FINAL_RESPONSE_MAX_CHARS_LABEL}-character limit (an over-length final answer is rejected fail-closed, never truncated). This runtime exposes no completion tool, so calling one is neither possible nor required: the closing assistant message is the result, and the adapter delivers it through the existing authoritative transport. Retain voluminous logs in artifact files if needed.`;

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
  view_file: "read",
  read_image: "read",
  run_command: "bash",
  grep_search: "grep",
  find_by_name: "find",
  list_dir: "ls",
  write_to_file: "write",
  replace_file_content: "edit",
  read_url_content: null,
  search_web: null,
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

function introForTools(tools) {
  return tools.includes(PI_SEARCH_TOOL)
    ? `This runtime exposes \`${PI_SEARCH_TOOL}\` (root-bound to this worktree, the same shared tool for every worker seat); use it to`
    : "This runtime exposes no semantic-search tool; use `grep`, `rg`, and direct file reads to";
}

function replaceSection(body, heading, replacement) {
  const start = body.indexOf(heading);
  if (start === -1) return body;
  const next = body.indexOf("\n## ", start + heading.length);
  const tail = next === -1 ? "" : body.slice(next + 1);
  return `${body.slice(0, start)}${replacement}${tail === "" ? "" : `\n\n${tail}`}`.trimEnd();
}

function adaptBody({ seat, body, tools }) {
  const adaptedSections = [];
  let adapted = replaceSection(body, COMPLETION_HEADING, PI_COMPLETION_SECTION);
  if (adapted !== body) adaptedSections.push("Completion");
  if (adapted.includes(SEARCH_INTRO)) {
    adapted = adapted.replace(SEARCH_INTRO, introForTools(tools));
    adaptedSections.push("Workspace search");
  }
  return { body: adapted, adaptedSections };
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
  const { body: adapted } = adaptBody({ seat, body, tools });
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
  const { body, adaptedSections } = adaptBody({ seat, body: contract.body, tools });
  assertResolvable({ seat, body, tools });
  return { source: contract.path, body, adaptedSections, namedTools: referencedToolNames(body) };
}
