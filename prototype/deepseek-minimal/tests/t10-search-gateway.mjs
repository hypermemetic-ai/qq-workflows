#!/usr/bin/env node
/**
 * Acceptance 10: the root-bound zvec-grep search gateway, offline.
 *
 * Every case here drives the REAL gateway process over real MCP stdio against
 * a stub upstream (`fake zg`: an MCP server + an index CLI, both written with
 * the same pinned MCP SDK) and a journal file. No daemon, provider, embedding
 * model, or operator index is touched: the gateway is bound to a temp worktree
 * and told to use the fake binary through the same environment the production
 * overlay forwards.
 *
 * Covered: the published tool list and schema; the bound root surviving an
 * unrelated process cwd; the injected `root`/`wait_for_fresh`/`autoUpdate`
 * arguments on every forwarded request; override/admin fields refused without
 * contacting zg; index creation on the first search only (never without a
 * search, never twice, never concurrently); stale results reconciled rather
 * than returned as current, and labelled honestly when they cannot be;
 * unavailable/exit-failure/timeout/cancel all reported as explicit errors; the
 * upstream child reaped after cancellation (no orphans); and a sentinel in an
 * unrelated root left untouched.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeZg, readJournal, upstreamSearchSchema } from "./fake-zg.mjs";
import { evidenceDir, isolatedRuntime, sdkModuleUrl, tempDir } from "./harness.mjs";

const RUNTIME = isolatedRuntime();
const GATEWAY = join(RUNTIME, "gateway", "zvec-grep-gateway.mjs");
const SNAPSHOT = JSON.parse(readFileSync(join(RUNTIME, "gateway", "zvec-grep-search.tool.json"), "utf8"));
const UPSTREAM_SCHEMA = upstreamSearchSchema(RUNTIME);
const { Client } = await import(sdkModuleUrl(RUNTIME, "@modelcontextprotocol/client"));
const { StdioClientTransport } = await import(sdkModuleUrl(RUNTIME, "@modelcontextprotocol/client", "./stdio"));

const SEARCH_TIMEOUT_MS = 4_000;
const INDEX_TIMEOUT_MS = 4_000;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const results = [];

/**
 * Start the gateway bound to `root`, with `cwd` deliberately unrelated (the
 * gateway must bind from its environment, never from where it was spawned).
 */
async function startGateway({ root, fake, seat = "implementer", env = {}, cwd = RUNTIME }) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [GATEWAY], env: {
    ...process.env,
    QQ_ZVEC_GREP_ROOT: root,
    QQ_ZVEC_GREP_SEAT: seat,
    QQ_ZVEC_GREP_BIN: fake.script,
    QQ_ZVEC_GREP_SEARCH_TIMEOUT_MS: String(SEARCH_TIMEOUT_MS),
    QQ_ZVEC_GREP_INDEX_TIMEOUT_MS: String(INDEX_TIMEOUT_MS),
    QQ_ZVEC_GREP_RECONCILE_ATTEMPTS: "1",
    QQ_ZVEC_GREP_RECONCILE_DELAY_MS: "20",
    ...fake.env,
    ...env,
  }, cwd, stderr: "pipe" });
  let gatewayStderr = "";
  transport.stderr?.on("data", (chunk) => { gatewayStderr += chunk; });
  const client = new Client({ name: "t10-harness", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport, pid: transport.pid, stderr: () => gatewayStderr };
}

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

function sentinel(dir, name = "sentinel.txt", body = "untouched-sentinel") {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

/**
 * Every option description the model sees must be the pinned snapshot's own
 * text, verbatim: the projection renames `anyOf` to `oneOf` but never rewrites
 * prose.
 */
function assertVerbatimDescriptions(published, upstream, path) {
  if (typeof upstream?.description === "string") {
    assert.equal(published.description, upstream.description, `${path}: the official option description must stay verbatim`);
  }
  const upstreamBranches = upstream.anyOf ?? upstream.oneOf ?? [];
  const publishedBranches = published.oneOf ?? [];
  assert.equal(publishedBranches.length, upstreamBranches.length, `${path}: every union branch must be preserved`);
  for (let index = 0; index < upstreamBranches.length; index += 1) {
    assertVerbatimDescriptions(publishedBranches[index], upstreamBranches[index], `${path}[${index}]`);
  }
}

// --- 1. tool list, schema, forwarded arguments, unrelated sentinel ----------
{
  const workspace = tempDir("t10-main");
  const otherRoot = tempDir("t10-other");
  const workspaceSentinel = sentinel(workspace, "sentinel.txt", "workspace-sentinel");
  const otherSentinel = sentinel(otherRoot, "sentinel.txt", "other-root-sentinel");
  const marker = join(tempDir("t10-main-state"), "index.marker");
  writeFileSync(marker, workspace);
  const fake = writeFakeZg({ dir: tempDir("t10-main-fake"), runtimeRoot: RUNTIME, config: { indexMarker: marker } });
  const gateway = await startGateway({ root: workspace, fake });
  const client = gateway.client;

  const tools = await client.listTools();
  assert.equal(tools.tools.length, 1, "the gateway must publish exactly one tool");
  const tool = tools.tools[0];
  assert.equal(tool.name, "zvec_grep_search", "the raw name the harness publishes as mcp__zvec_grep__zvec_grep_search");
  for (const field of ["root", "freshness", "autoUpdate"]) {
    assert.ok(!Object.hasOwn(tool.inputSchema.properties, field), `${field} must not be model-visible`);
    assert.ok(!(tool.inputSchema.required ?? []).includes(field), `${field} must not be required`);
  }
  assert.equal(tool.inputSchema.additionalProperties, false, "unknown fields must be refused by the advertised schema");
  assert.ok(Object.hasOwn(tool.inputSchema.properties, "query"), "the supported query option must remain");
  assert.ok(Object.hasOwn(tool.inputSchema.properties, "globs"), "supported filter options must remain");
  // The published description is the pinned snapshot's OWN upstream text, not
  // authored prose: the only permitted deviation is the documented adaptation
  // of the hidden-root reference, and the freshness/background_refresh RESPONSE
  // guidance must survive verbatim (those fields are returned, not hidden).
  const official = SNAPSHOT.tool.description;
  const boundClause = "Search the bound worktree's index";
  assert.ok(!official.includes(boundClause), "the snapshot must hold the official wording, never the adapted clause");
  assert.equal(
    tool.description,
    official.replace("Search an existing workspace index", boundClause),
    "the description must be the official text with only the hidden-root reference adapted",
  );
  for (const retained of [
    "Results include bounded source snippets and query-group metadata; treat sufficient snippets as already-read evidence.",
    "Use native Grep or rg instead when exact lookup alone is sufficient.",
    "Read freshness and background_refresh from the response without a status preflight; when results are served_from_current_index, use them if sufficient.",
  ]) {
    assert.ok(official.includes(retained), `the snapshot must still carry the official sentence: ${retained}`);
    assert.ok(tool.description.includes(retained), `the official sentence must be published verbatim: ${retained}`);
  }
  assert.doesNotMatch(
    tool.description,
    /CURRENT WORKTREE|search creates it|waits for pending/u,
    "no authored prose, indexing, or waiting detail may be published as tool documentation",
  );
  for (const [key, property] of Object.entries(tool.inputSchema.properties)) {
    assert.ok(UPSTREAM_SCHEMA.properties[key], `published option '${key}' must exist in the pinned snapshot`);
    assertVerbatimDescriptions(property, UPSTREAM_SCHEMA.properties[key], `inputSchema.properties.${key}`);
  }

  const reply = await client.callTool({ name: "zvec_grep_search", arguments: { query: "where is auth", limit: 3 } }, { timeout: 20_000 });
  assert.equal(reply.isError, undefined, `a bound search must succeed: ${JSON.stringify(reply)}`);
  assert.match(reply.content[0].text, /fake hit for where is auth/u, "results must be delivered verbatim");

  const refusedRoot = await client.callTool({ name: "zvec_grep_search", arguments: { query: "x", root: otherRoot } }, { timeout: 20_000 });
  assert.equal(refusedRoot.isError, true, "a caller-supplied root must be refused");
  assert.match(refusedRoot.content[0].text, /'root' is bound by the harness/u);
  const refusedAdmin = await client.callTool({ name: "zvec_grep_search", arguments: { query: "x", drop: true, rebuild: true, indexOnly: true } }, { timeout: 20_000 });
  assert.equal(refusedAdmin.isError, true, "index/admin operations must be refused, never forwarded");
  assert.match(refusedAdmin.content[0].text, /'drop' is not a supported search option/u);
  assert.match(refusedAdmin.content[0].text, /'rebuild' is not a supported search option/u);
  assert.match(refusedAdmin.content[0].text, /'indexOnly' is not a supported search option/u);
  await client.close();
  await waitGone(gateway.pid);

  const entries = readJournal(fake.journalFile);
  const searches = entries.filter(entry => entry.kind === "search");
  assert.equal(searches.length, 1, "refused calls must never reach the upstream: exactly one forwarded search");
  assert.equal(searches[0].name, "zvec_grep_search");
  assert.deepEqual(searches[0].args, { query: "where is auth", limit: 3, root: workspace, freshness: "wait_for_fresh", autoUpdate: true });
  assert.equal(entries.filter(entry => entry.kind === "index-cli").length, 0, "an indexed root must never be re-indexed");
  assert.equal(readFileSync(workspaceSentinel, "utf8"), "workspace-sentinel");
  assert.equal(readFileSync(otherSentinel, "utf8"), "other-root-sentinel", "no other root may be touched");
  assert.ok(!existsSync(join(otherRoot, ".zvec-grep")) && !existsSync(join(workspace, ".zvec-grep")), "the fake index storage is the test's own marker, never a real .zvec-grep");
  results.push({ case: "main", searches: searches.length, tool: tool.name });
}

// --- 2. first search creates the index once, later searches reuse it --------
{
  const workspace = tempDir("t10-init");
  const marker = join(tempDir("t10-init-state"), "index.marker");
  const fake = writeFakeZg({ dir: tempDir("t10-init-fake"), runtimeRoot: RUNTIME, config: { indexMarker: marker, indexDelayMs: 60 } });
  const gateway = await startGateway({ root: workspace, fake });
  const client = gateway.client;
  const first = await client.callTool({ name: "zvec_grep_search", arguments: { query: "first" } }, { timeout: 30_000 });
  assert.equal(first.isError, undefined, `the first search must answer after creating the index: ${JSON.stringify(first)}`);
  assert.match(first.content[0].text, /freshness: fresh/u);
  const second = await client.callTool({ name: "zvec_grep_search", arguments: { query: "second" } }, { timeout: 30_000 });
  assert.equal(second.isError, undefined);
  await client.close();
  await waitGone(gateway.pid);

  const entries = readJournal(fake.journalFile);
  const indexRuns = entries.filter(entry => entry.kind === "index-cli");
  assert.equal(indexRuns.length, 1, "a missing index must be created exactly once");
  assert.deepEqual(indexRuns[0].argv, ["index", workspace], "only the exact root, with no rebuild/drop/ignore flags");
  const searches = entries.filter(entry => entry.kind === "search");
  assert.equal(searches.length, 3, "one miss, one retry after creation, then one reused search");
  assert.deepEqual(searches.map(entry => entry.indexed), [false, true, true]);
  for (const entry of searches) assert.equal(entry.args.root, workspace);
  results.push({ case: "init-once", indexRuns: indexRuns.length, searches: searches.length });
}

// --- 3. no search => no indexing, no zg spawn at all ------------------------
{
  const workspace = tempDir("t10-nosearch");
  const marker = join(tempDir("t10-nosearch-state"), "index.marker");
  const fake = writeFakeZg({ dir: tempDir("t10-nosearch-fake"), runtimeRoot: RUNTIME, config: { indexMarker: marker } });
  const gateway = await startGateway({ root: workspace, fake });
  const client = gateway.client;
  await client.listTools();
  await client.close();
  await waitGone(gateway.pid);
  const entries = readJournal(fake.journalFile);
  assert.deepEqual(entries, [], "without a search the gateway must not spawn zg, index, or query anything");
  assert.ok(!existsSync(marker), "no index may be created without a search");
  results.push({ case: "no-search-no-index", entries: entries.length });
}

// --- 4. concurrent first searches share ONE index creation ------------------
{
  const workspace = tempDir("t10-concurrent");
  const marker = join(tempDir("t10-concurrent-state"), "index.marker");
  const fake = writeFakeZg({ dir: tempDir("t10-concurrent-fake"), runtimeRoot: RUNTIME, config: { indexMarker: marker, indexDelayMs: 400 } });
  const gateway = await startGateway({ root: workspace, fake });
  const client = gateway.client;
  const [a, b] = await Promise.all([
    client.callTool({ name: "zvec_grep_search", arguments: { query: "a" } }, { timeout: 30_000 }),
    client.callTool({ name: "zvec_grep_search", arguments: { query: "b" } }, { timeout: 30_000 }),
  ]);
  assert.equal(a.isError, undefined, `concurrent search A must succeed: ${JSON.stringify(a)}`);
  assert.equal(b.isError, undefined, `concurrent search B must succeed: ${JSON.stringify(b)}`);
  await client.close();
  await waitGone(gateway.pid);
  const indexRuns = readJournal(fake.journalFile).filter(entry => entry.kind === "index-cli");
  assert.equal(indexRuns.length, 1, "concurrent first searches must deduplicate index creation");
  results.push({ case: "concurrent-init", indexRuns: indexRuns.length });
}

// --- 5. a watcher gap is reconciled, not returned as current ---------------
{
  const workspace = tempDir("t10-stale");
  const state = tempDir("t10-stale-state");
  const marker = join(state, "index.marker");
  writeFileSync(marker, workspace);
  const fake = writeFakeZg({ dir: tempDir("t10-stale-fake"), runtimeRoot: RUNTIME, config: { indexMarker: marker, searchSequence: ["possibly_stale", "fresh"] } });
  const gateway = await startGateway({ root: workspace, fake });
  const client = gateway.client;
  const reply = await client.callTool({ name: "zvec_grep_search", arguments: { query: "reconcile" } }, { timeout: 30_000 });
  await client.close();
  await waitGone(gateway.pid);
  assert.equal(reply.isError, undefined);
  assert.match(reply.content[0].text, /^freshness: fresh/mu, "the reply must come from the reconciled generation");
  assert.doesNotMatch(reply.content[0].text, /possibly_stale/u, "a reconciled reply must not carry a stale warning");
  const searches = readJournal(fake.journalFile).filter(entry => entry.kind === "search");
  assert.equal(searches.length, 2, "the gateway must re-issue wait_for_fresh while the index is stale");
  for (const entry of searches) {
    assert.equal(entry.args.freshness, "wait_for_fresh");
    assert.equal(entry.args.autoUpdate, true);
  }
  results.push({ case: "reconcile", searches: searches.length });
}

// --- 6. unreconcilable staleness is labelled, never passed off as current ---
{
  const workspace = tempDir("t10-always-stale");
  const marker = join(tempDir("t10-always-stale-state"), "index.marker");
  writeFileSync(marker, workspace);
  const fake = writeFakeZg({ dir: tempDir("t10-always-stale-fake"), runtimeRoot: RUNTIME, config: { indexMarker: marker, searchSequence: ["possibly_stale"] } });
  const gateway = await startGateway({ root: workspace, fake });
  const client = gateway.client;
  const reply = await client.callTool({ name: "zvec_grep_search", arguments: { query: "stale" } }, { timeout: 30_000 });
  await client.close();
  await waitGone(gateway.pid);
  assert.equal(reply.isError, undefined, "stale results are still results, but must be labelled");
  assert.match(reply.content[0].text, /^note: the index for .* is still possibly_stale/u, "the freshness warning must be explicit");
  assert.match(reply.content[0].text, /treat these results as possibly stale/u);
  assert.match(reply.content.map(block => block.text).join("\n"), /fake hit for stale/u, "the upstream result must still be delivered next to the warning");
  const searches = readJournal(fake.journalFile).filter(entry => entry.kind === "search");
  assert.equal(searches.length, 2, "a bounded reconcile retry, not an endless loop");
  results.push({ case: "stale-labelled", searches: searches.length });
}

// --- 7. failed index creation is an explicit unavailable error --------------
{
  const workspace = tempDir("t10-indexfail");
  const fake = writeFakeZg({ dir: tempDir("t10-indexfail-fake"), runtimeRoot: RUNTIME, config: { indexExitCode: 3, indexStderr: "fake embedding model missing\n" } });
  const gateway = await startGateway({ root: workspace, fake });
  const client = gateway.client;
  const reply = await client.callTool({ name: "zvec_grep_search", arguments: { query: "x" } }, { timeout: 30_000 });
  await client.close();
  await waitGone(gateway.pid);
  assert.equal(reply.isError, true, "a missing index that cannot be created is NOT an empty result");
  assert.match(reply.content[0].text, /search unavailable/u);
  assert.match(reply.content[0].text, /creating one failed/u);
  assert.match(reply.content[0].text, /exited with code 3/u);
  assert.match(reply.content[0].text, /rg or direct file reads/u, "the fallback must be actionable");
  assert.equal(readJournal(fake.journalFile).filter(entry => entry.kind === "search").length, 1, "no retry search after a failed creation");
  results.push({ case: "index-failed" });
}

// --- 8. a missing zg is unavailable, never an empty result ------------------
{
  const workspace = tempDir("t10-nobinary");
  const fake = writeFakeZg({ dir: tempDir("t10-nobinary-fake"), runtimeRoot: RUNTIME, config: {} });
  const gateway = await startGateway({ root: workspace, fake, env: { QQ_ZVEC_GREP_BIN: "/nonexistent/zg-not-installed" } });
  const client = gateway.client;
  const reply = await client.callTool({ name: "zvec_grep_search", arguments: { query: "x" } }, { timeout: 30_000 });
  await client.close();
  await waitGone(gateway.pid);
  assert.equal(reply.isError, true);
  assert.match(reply.content[0].text, /search unavailable/u);
  assert.match(reply.content[0].text, /rg or direct file reads/u);
  assert.deepEqual(readJournal(fake.journalFile), [], "an unavailable binary must not reach the fake at all");
  results.push({ case: "zg-missing" });
}

// --- 9. a slow upstream is a bounded, honest timeout ------------------------
{
  const workspace = tempDir("t10-timeout");
  const marker = join(tempDir("t10-timeout-state"), "index.marker");
  writeFileSync(marker, workspace);
  const fake = writeFakeZg({ dir: tempDir("t10-timeout-fake"), runtimeRoot: RUNTIME, config: { indexMarker: marker, searchDelayMs: 3_000 } });
  const gateway = await startGateway({ root: workspace, fake, env: { QQ_ZVEC_GREP_SEARCH_TIMEOUT_MS: "300" } });
  const client = gateway.client;
  const reply = await client.callTool({ name: "zvec_grep_search", arguments: { query: "slow" } }, { timeout: 30_000 });
  await client.close();
  await waitGone(gateway.pid);
  assert.equal(reply.isError, true, "a timeout must not look like a result");
  assert.match(reply.content[0].text, /search timed out within 300ms/u);
  assert.match(reply.content[0].text, /mid-update/u);
  results.push({ case: "timeout" });
}

// --- 10. an empty worktree answer stays "No matches.", not an error ---------
{
  const workspace = tempDir("t10-nomatch");
  const marker = join(tempDir("t10-nomatch-state"), "index.marker");
  writeFileSync(marker, workspace);
  const fake = writeFakeZg({ dir: tempDir("t10-nomatch-fake"), runtimeRoot: RUNTIME, config: { indexMarker: marker, noMatches: true } });
  const gateway = await startGateway({ root: workspace, fake });
  const client = gateway.client;
  const reply = await client.callTool({ name: "zvec_grep_search", arguments: { query: "nothing" } }, { timeout: 30_000 });
  await client.close();
  await waitGone(gateway.pid);
  assert.equal(reply.isError, undefined, "no matches is a normal result");
  assert.match(reply.content[0].text, /No matches\./u);
  results.push({ case: "no-matches" });
}

// --- 11. a lost transport is reconnected, then answered --------------------
{
  const workspace = tempDir("t10-reconnect");
  const marker = join(tempDir("t10-reconnect-state"), "index.marker");
  writeFileSync(marker, workspace);
  const fake = writeFakeZg({ dir: tempDir("t10-reconnect-fake"), runtimeRoot: RUNTIME, config: { indexMarker: marker, silentServerGenerations: [1] } });
  const gateway = await startGateway({ root: workspace, fake });
  const client = gateway.client;
  const reply = await client.callTool({ name: "zvec_grep_search", arguments: { query: "reconnect" } }, { timeout: 30_000 });
  await client.close();
  await waitGone(gateway.pid);
  assert.equal(reply.isError, undefined, `a lost upstream generation must be reconnected: ${JSON.stringify(reply)}`);
  assert.match(reply.content[0].text, /fake hit for reconnect/u);
  const starts = readJournal(fake.journalFile).filter(entry => entry.kind === "server-start");
  assert.ok(starts.length >= 2, "the gateway must spawn a fresh upstream generation after the loss");
  results.push({ case: "reconnect", generations: starts.length });
}

// --- 12. cancellation reaps the upstream child (no orphans) ----------------
{
  const workspace = tempDir("t10-cancel");
  const marker = join(tempDir("t10-cancel-state"), "index.marker");
  writeFileSync(marker, workspace);
  const fake = writeFakeZg({ dir: tempDir("t10-cancel-fake"), runtimeRoot: RUNTIME, config: { indexMarker: marker, searchDelayMs: 30_000 } });
  const gateway = await startGateway({ root: workspace, fake });
  const client = gateway.client;
  const controller = new AbortController();
  const pending = client.callTool({ name: "zvec_grep_search", arguments: { query: "cancel me" } }, { signal: controller.signal, timeout: 60_000 });
  const upstreamPid = await (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const starts = readJournal(fake.journalFile).filter(entry => entry.kind === "server-start");
      if (starts.length > 0) return starts[0].pid;
      await sleep(50);
    }
    return 0;
  })();
  assert.ok(upstreamPid > 0, "the upstream zg child must have started");
  controller.abort(new Error("t10 cancel"));
  await pending.then(
    () => assert.fail("a cancelled call must reject on the client side"),
    (error) => assert.ok(error !== undefined, "cancellation must surface to the caller"),
  );
  await client.close();
  assert.equal(await waitGone(gateway.pid, 10_000), true, "the gateway must exit once its client goes away");
  assert.equal(await waitGone(upstreamPid), true, "the upstream zg child must not outlive the gateway");
  results.push({ case: "cancel-reaps-upstream", upstreamPid });
}

// --- evidence -----------------------------------------------------------------
const evidence = {
  recordedAt: new Date().toISOString(),
  runtimeRoot: RUNTIME,
  gateway: GATEWAY,
  upstreamToolSnapshot: { name: SNAPSHOT.tool.name, provenance: SNAPSHOT.provenance },
  cases: results,
};
mkdirSync(evidenceDir(), { recursive: true });
writeFileSync(join(evidenceDir(), "search-gateway.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log("ok t10-search-gateway");
console.log(JSON.stringify(evidence, null, 2));
