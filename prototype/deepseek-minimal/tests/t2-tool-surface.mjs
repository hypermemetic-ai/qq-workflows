#!/usr/bin/env node
/**
 * Acceptance 2: the runtime's exposed tool surface.
 *
 * The runner seat keeps exactly the baseline minimal set plus `read_image` - no
 * bundled editors, search, or completion tools. The implementer and reviewer
 * seats add exactly ONE named tool, `mcp__zvec_grep__zvec_grep_search`, from the
 * seat-scoped search overlay; nothing else (no root/admin tool, no generic MCP
 * resource tools, no read/write/edit) may appear. The runtime is the pinned
 * build, never the installed global dsh.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoleContract } from "../../../workflow/worker-config.mjs";
import { startMockProvider } from "../mock/mock-provider.mjs";
import { runtimeLayout, verifyRuntimeProvenance } from "../adapter/runtime.mjs";
import { evidenceDir, parseLines, PROTOTYPE_ROOT, runWorker, scrubRoutingEnv, tempDir, workerEnv } from "./harness.mjs";

// Never wake a live session from the runner-seat case below.
scrubRoutingEnv();

/** Baseline sdk-minimal tool surface, verified from the pinned profile patch. */
const BASELINE_MINIMAL_TOOLS = ["bash"];
const READ_IMAGE_TOOLS = [...BASELINE_MINIMAL_TOOLS, "read_image"].sort();
/** The one seat-scoped addition: the qualified upstream search tool name. */
const SEARCH_TOOL = "mcp__zvec_grep__zvec_grep_search";
const SEARCH_SEAT_TOOLS = [...READ_IMAGE_TOOLS, SEARCH_TOOL].sort();
const FORBIDDEN = ["read", "write", "edit", "grep", "glob", "search", "complete_task", "read_file", "str_replace",
  "zvec_grep_search", "zvec_grep_index", "zvec_grep_index_drop", "zvec_grep_index_status", "zvec_grep_server_status",
  "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

const mock = await startMockProvider({
  scenario: { turns: [{ blocks: [{ type: "text", text: "FINAL: tool surface" }], stopReason: "end_turn" }] },
});
const result = await runWorker(["--seat", "implementer", "--cwd", PROTOTYPE_ROOT, "--prompt", "report the tool surface", "--base-url", mock.url]);
const request = mock.lastMessageRequest;
await mock.close();

assert.equal(result.code, 0, `worker must succeed: ${result.stderr}`);
assert.deepEqual(request.toolNames, SEARCH_SEAT_TOOLS, `a search seat exposes exactly bash+read_image+the qualified search tool, got ${request.toolNames}`);
for (const name of FORBIDDEN) {
  assert.ok(!request.toolNames.includes(name), `tool '${name}' must not be exposed`);
}
assert.equal(request.model, "deepseek-flash");
assert.equal(request.effort, "max");
assert.equal(request.thinking, "enabled");

// Seat instructions are pinned by the adapter, not by the parent's per-call args.
const role = loadRoleContract("implementer").body;
assert.equal(request.systemPromptLength, role.length, "the seat's role contract is the runtime system prompt");
assert.ok(role.startsWith(request.systemPromptHead.slice(0, 40)), "system prompt must begin with the seat instructions");

// The runner seat is unchanged: no search overlay, no gateway, no extra tool.
const runnerRoot = tempDir("t2-runner");
const runnerMock = await startMockProvider({
  scenario: { turns: [{ blocks: [{ type: "text", text: "FINAL: runner surface" }], stopReason: "end_turn" }] },
});
const runner = await runWorker(["--seat", "runner", "--cwd", runnerRoot, "--prompt", "report the surface", "--base-url", runnerMock.url], {
  env: workerEnv({
    QQ_RUNNER_ID: `t2-runner-${randomUUID()}`,
    QQ_RUNNER_RESULT_FILE: join(runnerRoot, "result.json"),
    QQ_RUNNER_MARKER_FILE: join(runnerRoot, "marker.json"),
  }),
});
const runnerRequest = runnerMock.lastMessageRequest;
await runnerMock.close();
assert.equal(runner.code, 0, `the runner must still succeed: ${runner.stderr}`);
assert.deepEqual(runnerRequest.toolNames, READ_IMAGE_TOOLS, "the runner seat stays at the baseline + read_image");

// Pinned runtime provenance: the global dsh 0.1.5-rc.1 was never the runtime.
const provenance = verifyRuntimeProvenance(runtimeLayout());
const pin = JSON.parse(readFileSync(join(PROTOTYPE_ROOT, "PIN.json"), "utf8"));
assert.equal(provenance.head, pin.upstream.commit, "runtime must be the pinned commit");
assert.equal(provenance.sourceCliVersion, pin.upstream.version, "runtime CLI must report the pinned version");
assert.equal(provenance.globalDshVersion, pin.forbiddenGlobals.dshGlobalVersionObserved, "global dsh version is recorded for contrast");
assert.equal(provenance.globalDshUsed, false);
assert.equal(pin.provider.route, "deepseek-official");

// Fail closed on a non-loopback endpoint: no live model calls are possible.
const refused = await runWorker(["--seat", "implementer", "--cwd", PROTOTYPE_ROOT, "--prompt", "x", "--base-url", "https://api.deepseek.com"]);
assert.equal(refused.code, 2, "a remote endpoint must be refused");
assert.match(refused.stderr, /not a loopback http URL/u);
assert.equal(refused.stdout, "", "a refused run must not emit protocol lines");

assert.deepEqual(parseLines(result.stdout).at(-1).item.text, "FINAL: tool surface");

writeFileSync(join(evidenceDir(), "tool-surface.json"), `${JSON.stringify({
  recordedAt: new Date().toISOString(),
  exposedTools: request.toolNames,
  runnerTools: runnerRequest.toolNames,
  searchSeatTools: SEARCH_SEAT_TOOLS,
  baselineMinimalTools: BASELINE_MINIMAL_TOOLS,
  forbiddenToolsChecked: FORBIDDEN,
  provider: "deepseek-official",
  model: request.model,
  reasoningEffortOnWire: request.effort,
  maxTokens: request.maxTokens,
  seatInstructions: { seat: "implementer", systemPromptLength: request.systemPromptLength, systemPromptSha256: request.systemPromptSha256 },
  runtime: { head: provenance.head, cliVersion: provenance.sourceCliVersion, cliEntry: provenance.cliEntry, globalDshVersion: provenance.globalDshVersion, globalDshUsed: provenance.globalDshUsed },
  nonLoopbackRefusal: { exitCode: refused.code, stderr: refused.stderr.trim() },
}, null, 2)}\n`);
console.log("ok t2-tool-surface");
console.log(JSON.stringify({ toolNames: request.toolNames, runnerTools: runnerRequest.toolNames, baseline: BASELINE_MINIMAL_TOOLS, provenance }, null, 2));
