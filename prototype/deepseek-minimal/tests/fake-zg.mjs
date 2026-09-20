/**
 * Test-only `zg` double: one executable that serves both halves of the pinned
 * zg surface the gateway uses.
 *
 *   * `<bin> server --stdio --mcp-toolset agent` - a REAL MCP stdio server
 *     (built with the same pinned MCP SDK the gateway reuses) that advertises
 *     the verbatim upstream `zvec_grep_search` schema, journals every received
 *     argument set, reports `[INDEX_MISSING]` until its marker file exists, and
 *     can be told to answer stale, to answer slowly, to answer "No matches.",
 *     or to die silently (a dead daemon/transport).
 *   * `<bin> index <root>` - the index CLI: journals its exact argv, optionally
 *     delays, optionally fails, and otherwise writes the marker file.
 *
 * Nothing here touches the real daemon, provider, embedding model, or index.
 *
 * @module tests/fake-zg
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sdkModuleUrl } from "./harness.mjs";

/** Verbatim upstream input schema from the runtime's gateway snapshot. */
export function upstreamSearchSchema(runtimeRoot) {
  const snapshot = JSON.parse(readFileSync(join(runtimeRoot, "gateway", "zvec-grep-search.tool.json"), "utf8"));
  return snapshot.tool.inputSchema;
}

/**
 * Write the fake zg into `dir`.
 * @param options.dir - directory owning the script and config.
 * @param options.runtimeRoot - materialized runtime root (SDK resolution + schema).
 * @param options.config - scenario knobs: `indexMarker`, `indexDelayMs`,
 *   `indexExitCode`, `indexStderr`, `searchDelayMs`, `searchSequence`,
 *   `noMatches`, `silentServerGenerations`.
 * @returns `{script, configFile, journalFile, env}`.
 */
export function writeFakeZg({ dir, runtimeRoot, config = {} }) {
  const configFile = join(dir, "fake-zg-config.json");
  const journalFile = join(dir, "journal.jsonl");
  const serverEntry = sdkModuleUrl(runtimeRoot, "@modelcontextprotocol/server");
  const serverStdio = sdkModuleUrl(runtimeRoot, "@modelcontextprotocol/server", "./stdio");
  const source = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const config = JSON.parse(readFileSync(process.env.FAKE_ZG_CONFIG, "utf8"));
const journalText = existsSync(config.journalFile) ? readFileSync(config.journalFile, "utf8") : "";
const priorStarts = journalText.split("\\n").filter(line => line.includes('"server-start"')).length;
const journal = (entry) => appendFileSync(config.journalFile, JSON.stringify({ at: Date.now(), ...entry }) + "\\n");
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const [mode, ...rest] = process.argv.slice(2);
if (mode === "index") {
  journal({ kind: "index-cli", argv: process.argv.slice(2), root: rest[0] });
  if (config.indexDelayMs) await sleep(config.indexDelayMs);
  if (config.indexExitCode) {
    process.stderr.write(config.indexStderr ?? "fake index failure\\n");
    process.exit(config.indexExitCode);
  }
  writeFileSync(config.indexMarker, String(rest[0]));
  process.stdout.write("Workspace index: succeeded\\n");
  process.exit(0);
}
if (mode !== "server") {
  process.stderr.write("fake zg: unexpected argv\\n");
  process.exit(2);
}
const generation = priorStarts + 1;
journal({ kind: "server-start", pid: process.pid, generation, argv: process.argv.slice(2) });
const { Server } = await import(${JSON.stringify(serverEntry)});
const { StdioServerTransport } = await import(${JSON.stringify(serverStdio)});
const server = new Server({ name: "fake-zg", version: "0.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler("tools/list", async () => ({
  tools: [{ name: "zvec_grep_search", title: "Search with zvec-grep", description: "fake upstream", inputSchema: config.upstreamSchema, annotations: { readOnlyHint: false } }],
}));
let calls = 0;
server.setRequestHandler("tools/call", async (request) => {
  calls += 1;
  const args = request.params.arguments ?? {};
  const indexed = existsSync(config.indexMarker);
  journal({ kind: "search", call: calls, generation, pid: process.pid, name: request.params.name, args, indexed });
  if (config.searchDelayMs) await sleep(config.searchDelayMs);
  if ((config.silentServerGenerations ?? []).includes(generation)) {
    setTimeout(() => process.exit(1), 5);
    await sleep(10_000);
  }
  if (!indexed) {
    return { content: [{ type: "text", text: "[INDEX_MISSING] Indexed search requires a built zvec-grep index for " + String(args.root) + ". Creating or rebuilding a persistent index requires explicit user authorization." }], isError: true };
  }
  const sequence = config.searchSequence ?? ["fresh"];
  const freshness = sequence[Math.min(calls - 1, sequence.length - 1)];
  const body = config.noMatches === true ? "No matches." : "README.md:1: fake hit for " + String(args.query ?? "");
  return { content: [{ type: "text", text: "freshness: " + freshness + "\\nresults: served_from_current_index\\n" + body }] };
});
await server.connect(new StdioServerTransport());
`;
  const script = join(dir, "fake-zg.mjs");
  writeFileSync(configFile, JSON.stringify({ journalFile, upstreamSchema: upstreamSearchSchema(runtimeRoot), ...config }, null, 2));
  writeFileSync(script, source);
  chmodSync(script, 0o755);
  return { script, configFile, journalFile, env: { FAKE_ZG_CONFIG: configFile } };
}

/** Parsed journal entries, in order (empty when the fake never ran). */
export function readJournal(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").filter(line => line !== "").map(line => JSON.parse(line));
}
