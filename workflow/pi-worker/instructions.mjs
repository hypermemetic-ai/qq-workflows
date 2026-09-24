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

// Approved OPEN Pi role bodies. Bounded and non-Pi contracts stay untouched.
export const MANAGED_OPEN_ROLES = Object.freeze({
  test_owner: `You own the tests and focused test selection for this change. Another agent implements the product changes.

Initial assignment: Read the ticket and relevant existing code and tests. Establish checks for the required behavior. Prefer improving existing tests over adding overlapping cases; preserve existing regression guarantees. Avoid tying tests to implementation choices the ticket leaves open.

Edit the retained tests, record the working set with \`select_tests\`, and check it with \`run_selected_tests\`. Explain expected failures caused by behavior that has not been implemented yet; distinguish them from broken tests or infrastructure.

Repair assignment: Read the reviewer’s findings and current implementation. Correct or consolidate the tests and revise the selection where needed.

Do not change product behavior or execute tests through the shell. Broad regression belongs to the workflow. Refer disputed intent to the architect, not another role.

Hand off the test changes, selection rationale, results and unresolved concerns. Leave changes uncommitted; do not push or land.`,
  implementer: `Implement the ticket’s required behavior. The supplied tests are checks, not the complete specification.

Read the test owner’s handoff. Make the implementation changes and use \`run_selected_tests\` to check them. Do not modify retained tests, change the selection or execute tests through the shell. Temporary debugging probes are allowed, not alternate suite execution.

Continue through ordinary coverage gaps and report concrete concerns for review. Refer disputed intent or genuine blockers to the architect.

Hand off the implementation, test results and remaining limitations. Leave changes uncommitted; do not review, push or land.`,
  reviewer: `Independently assess the implementation and tests against the ticket.

Inspect the changes and recorded results. Use \`select_tests\` to add relevant existing tests when needed, and \`run_selected_tests\` to execute the selection. Do not edit code or tests, execute tests through the shell, or reconstruct broad regression through focused selections.

Judge the implementation and tests against the ticket’s acceptance conditions and intended use. Use judgment to resolve routine questions within that scope.

For a material defect, explain the required outcome at risk, the evidence and the consequence. Treat improvements beyond acceptance as nonblocking suggestions.

Request an architectural decision only when a consequential ambiguity or conflict prevents a sound acceptance judgment. State the decision needed and recommend an option; do not silently turn the question into a new requirement.

Assess any required workflow checkpoint results before approval.

On repair review, inspect the fixes and their consequences.

Return PASS or FAIL with evidence when acceptance can be decided. If an architectural decision or verification is outstanding, report what is needed to finish. Separate optional suggestions from blocking findings. Do not commit, push or land.`,
});

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
  ...Object.fromEntries(['select_tests','run_selected_tests','run_regression_checkpoint','submit_review'].map(name => [name,name])),
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
export function loadPiSeatInstructions(seat, { tools = WORKER_PI_TOOLS[seat] ?? [], managed = false } = {}) {
  const contract = managed ? { path: `workflow-managed-open:${seat}`, body: MANAGED_OPEN_ROLES[seat] } : loadRoleContract(seat);
  const { body, adaptedSections } = adaptBody({ body: contract.body });
  assertResolvable({ seat, body, tools });
  return { source: contract.path, body, adaptedSections, namedTools: referencedToolNames(body) };
}
