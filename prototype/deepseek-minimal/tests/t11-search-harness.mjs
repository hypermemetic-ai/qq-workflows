#!/usr/bin/env node
/**
 * Acceptance 11: the seat-scoped search gateway through the REAL pinned
 * harness, with a loopback provider double and the fake zg from t10.
 *
 * What this proves end to end:
 *   * the implementer and reviewer seats boot with exactly
 *     bash + read_image + `mcp__zvec_grep__zvec_grep_search`, while the runner
 *     seat still boots with bash + read_image only (no overlay, no gateway);
 *   * a model-issued search call actually reaches the gateway: the forwarded
 *     request carries the SEAT'S worktree root (never the runtime upstream cwd,
 *     never the main repo) plus freshness `wait_for_fresh` and `autoUpdate`
 *     `true`;
 *   * the first search under the real stack creates the worktree index exactly
 *     once (`zg index <root>`, no extra flags) and delivers the results back to
 *     the model on the next provider request;
 *   * the updated implementer/reviewer role guidance is the runtime prompt, and
 *     the runner's adapted contract is untouched;
 *   * the upstream fake zg child does not outlive the harness run.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRoleContract } from "../../../workflow/worker-config.mjs";
import { adaptSeatInstructions } from "../adapter/runtime.mjs";
import { startMockProvider } from "../mock/mock-provider.mjs";
import { readJournal, writeFakeZg } from "./fake-zg.mjs";
import { cleanOutput, isolatedRuntime, parseLines, runWorker, scrubRoutingEnv, tempDir, workerEnv } from "./harness.mjs";

scrubRoutingEnv();

const RUNTIME = isolatedRuntime();
const SEARCH_TOOL = "mcp__zvec_grep__zvec_grep_search";
const BASELINE_TOOLS = ["bash", "read_image"];
const SEARCH_TOOLS = [...BASELINE_TOOLS, SEARCH_TOOL].sort();
const QUERY = "where is the search gateway bound";
const sha256 = (text) => createHash("sha256").update(Buffer.from(text)).digest("hex");

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function waitGone(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(50);
  }
  return !pidAlive(pid);
}

/** One search seat: scripted gateway search, then the closing answer. */
async function runSearchSeat(seat) {
  const workdir = tempDir(`t11-${seat}`);
  const marker = join(tempDir(`t11-${seat}-state`), "index.marker");
  const fake = writeFakeZg({ dir: tempDir(`t11-${seat}-fake`), runtimeRoot: RUNTIME, config: { indexMarker: marker } });
  const mock = await startMockProvider({
    scenario: {
      turns: [
        { blocks: [{ type: "tool_use", name: SEARCH_TOOL, input: { query: QUERY, limit: 5 } }], stopReason: "tool_use" },
        { blocks: [{ type: "text", text: `FINAL: ${seat} search delivered` }], stopReason: "end_turn" },
      ],
    },
  });
  const result = await runWorker(
    ["--seat", seat, "--cwd", workdir, "--prompt", "find where the gateway binds", "--base-url", mock.url],
    // The zg the gateway is told to bridge is the fake double, never the
    // operator's real `zg` (which would query the live daemon).
    { env: workerEnv({ ...fake.env, QQ_ZVEC_GREP_BIN: fake.script }) },
  );
  const requests = mock.messageRequests;
  await mock.close();
  return { seat, workdir, fake, result, requests };
}

for (const seat of ["implementer", "reviewer"]) {
  const { workdir, fake, result, requests } = await runSearchSeat(seat);
  assert.equal(result.code, 0, `${seat} must complete with search available: ${result.stderr}`);
  assert.equal(cleanOutput(parseLines(result.stdout)), `FINAL: ${seat} search delivered`);
  assert.equal(requests.length, 2, `${seat}: one request per scripted turn`);

  // A. the seat-scoped tool surface.
  assert.deepEqual(requests[0].toolNames, SEARCH_TOOLS, `${seat} must see exactly bash + read_image + the qualified search tool`);
  assert.ok(!requests[0].toolNames.includes("zvec_grep_search"), "the bare upstream name must never be the model-facing tool");

  // A2. the model-visible description is the gateway's OFFICIAL provenance text
  // (the pinned snapshot's own wording, with only the documented hidden-root
  // reference adapted), never authored prose.
  const snapshot = JSON.parse(readFileSync(join(RUNTIME, "gateway", "zvec-grep-search.tool.json"), "utf8"));
  const official = snapshot.tool.description;
  const publishedDescription = requests[0].toolDescriptions?.[SEARCH_TOOL];
  assert.equal(
    publishedDescription,
    official.replace("Search an existing workspace index", "Search the bound worktree's index"),
    `${seat}: the model must receive the official search description`,
  );
  assert.ok(
    publishedDescription.includes("Read freshness and background_refresh from the response without a status preflight"),
    `${seat}: the official response-field guidance must survive to the model`,
  );

  // B. the search actually ran and delivered results back to the model.
  const toolText = requests[1].toolResults.map(entry => entry.text).join("\n");
  assert.match(toolText, new RegExp(`fake hit for ${QUERY}`, "u"), `${seat}: the search result must reach the model`);
  assert.match(toolText, /freshness: fresh/u, `${seat}: the delivered reply must carry the upstream freshness line`);

  // C. the root was BOUND to the seat worktree, with wait_for_fresh + autoUpdate.
  const entries = readJournal(fake.journalFile);
  const searches = entries.filter(entry => entry.kind === "search");
  assert.deepEqual(searches.map(entry => entry.indexed), [false, true], `${seat}: the index miss is retried exactly once, in the same tool call`);
  for (const entry of searches) {
    assert.equal(entry.name, "zvec_grep_search", "the raw upstream name is what goes on the wire");
    assert.equal(entry.args.root, workdir, `${seat}: the bound root must be the seat worktree, not the runtime upstream cwd`);
    assert.equal(entry.args.freshness, "wait_for_fresh");
    assert.equal(entry.args.autoUpdate, true);
    assert.equal(entry.args.query, QUERY, "supported query options must pass through unchanged");
    assert.equal(entry.args.limit, 5);
  }

  // D. the first search created the missing index exactly once, with no flags.
  const indexRuns = entries.filter(entry => entry.kind === "index-cli");
  assert.equal(indexRuns.length, 1, `${seat}: the missing worktree index must be created once`);
  assert.deepEqual(indexRuns[0].argv, ["index", workdir]);
  // ... and it was the SEARCH that triggered it: nothing at launch (no role,
  // phase, or startup boundary) ever runs the index CLI.
  assert.ok(
    entries.findIndex(entry => entry.kind === "search") < entries.findIndex(entry => entry.kind === "index-cli"),
    `${seat}: index creation must follow a search, never a launch`,
  );

  // E. the updated role guidance IS the runtime prompt (no stale contract).
  const role = loadRoleContract(seat).body;
  assert.match(role, /mcp__zvec_grep__zvec_grep_search/u, `${seat} contract must name the search tool`);
  assert.match(role, /Read the actual files before (editing|judging) them/u, `${seat} contract must require reading files`);
  assert.match(role, /unavailable/u, `${seat} contract must name the unavailable fallback`);
  assert.equal(requests[0].systemPromptSha256, sha256(role), `${seat}: the harness prompt must be the reviewed contract`);

  // F. nothing outlives the run.
  const starts = entries.filter(entry => entry.kind === "server-start");
  assert.ok(starts.length >= 1, `${seat}: the gateway must have spawned the upstream bridge`);
  for (const start of starts) {
    assert.equal(await waitGone(start.pid), true, `${seat}: upstream zg child ${start.pid} must not outlive the run`);
  }
  console.log(`ok t11-search-harness (${seat}) ${JSON.stringify({ toolNames: requests[0].toolNames, forwarded: searches.at(-1).args, searches: searches.length })}`);
}

// --- runner: unchanged surface, no gateway, no search ----------------------
{
  const runnerRoot = tempDir("t11-runner");
  const runnerId = `proto-t11-${randomUUID()}`;
  const resultFile = join(runnerRoot, `result-${runnerId}.json`);
  const fake = writeFakeZg({ dir: tempDir("t11-runner-fake"), runtimeRoot: RUNTIME, config: { indexMarker: join(runnerRoot, "never.marker") } });
  const mock = await startMockProvider({
    scenario: {
      turns: [
        { blocks: [{ type: "tool_use", name: "bash", input: { command: "echo RUNNER_SURFACE_OK" } }], stopReason: "tool_use" },
        { blocks: [{ type: "text", text: "FINAL: runner surface unchanged" }], stopReason: "end_turn" },
      ],
    },
  });
  const result = await runWorker(
    ["--seat", "runner", "--cwd", runnerRoot, "--prompt", "report the surface", "--base-url", mock.url],
    { env: workerEnv({ ...fake.env, QQ_ZVEC_GREP_BIN: fake.script, QQ_RUNNER_ID: runnerId, QQ_RUNNER_RESULT_FILE: resultFile, QQ_RUNNER_MARKER_FILE: join(runnerRoot, "marker.json") }) },
  );
  const requests = mock.messageRequests;
  await mock.close();
  assert.equal(result.code, 0, `the runner must still complete: ${result.stderr}`);
  assert.deepEqual(requests[0].toolNames, BASELINE_TOOLS, "the runner seat must NOT gain the search tool");
  assert.match(requests[1].toolResults.map(entry => entry.text).join("\n"), /RUNNER_SURFACE_OK/u);
  assert.equal(cleanOutput(parseLines(result.stdout)), "FINAL: runner surface unchanged");
  assert.deepEqual(readJournal(fake.journalFile), [], "the runner must never spawn the search gateway or its upstream");
  const payload = JSON.parse(readFileSync(resultFile, "utf8"));
  assert.equal(payload.runnerId, runnerId, "runner completion must still land on the authoritative transport");
  const adapted = adaptSeatInstructions("runner", loadRoleContract("runner").body);
  assert.equal(requests[0].systemPromptSha256, sha256(adapted), "runner prompt handling is unchanged (same adapted completion section)");
  console.log(`ok t11-search-harness (runner) ${JSON.stringify({ toolNames: requests[0].toolNames })}`);
}
