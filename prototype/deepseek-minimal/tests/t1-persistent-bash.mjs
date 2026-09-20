#!/usr/bin/env node
/**
 * Acceptance 1: the real pinned harness runs an isolated sdk-minimal turn
 * against the local scripted provider, executes persistent bash, and shows
 * cwd/environment persistence plus a disposable file write.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startMockProvider } from "../mock/mock-provider.mjs";
import { cleanOutput, parseLines, runWorker, tempDir } from "./harness.mjs";

const CANARY = "proto-canary-2b7f";
const workdir = tempDir("t1");
const first = `pwd; export PROTO_CANARY=${CANARY}; printf '%s' "$PROTO_CANARY" > disposable.txt; cat disposable.txt`;
const second = `test "$PROTO_CANARY" = ${CANARY} && echo PERSIST_ENV_OK || echo PERSIST_ENV_FAIL; pwd; test -f disposable.txt && echo PERSIST_FILE_OK || echo PERSIST_FILE_FAIL`;

const mock = await startMockProvider({
  scenario: {
    turns: [
      { blocks: [{ type: "tool_use", name: "bash", input: { command: first } }], stopReason: "tool_use" },
      { blocks: [{ type: "tool_use", name: "bash", input: { command: second } }], stopReason: "tool_use" },
      { blocks: [{ type: "text", text: "FINAL: persistent bash verified" }], stopReason: "end_turn" },
    ],
  },
});

const result = await runWorker(["--seat", "implementer", "--cwd", workdir, "--prompt", "verify persistent bash", "--base-url", mock.url]);
await mock.close();

assert.equal(result.code, 0, `worker must succeed: ${result.stderr}`);
const lines = parseLines(result.stdout);
assert.equal(cleanOutput(lines), "FINAL: persistent bash verified");
assert.ok(lines.some(line => line.item?.tool === "bash"), "bash tool activity must appear on the parent event contract");

const requests = mock.messageRequests;
assert.equal(requests.length, 3, "one outbound provider request per scripted turn");
// Request N carries the tool results produced by turn N-1.
const secondTurn = requests[2].toolResults.map(entry => entry.text).join("\n");
assert.match(secondTurn, /PERSIST_ENV_OK/u, "exported environment must survive across bash calls");
assert.match(secondTurn, /PERSIST_FILE_OK/u, "the disposable file must still exist on the second call");
assert.match(secondTurn, new RegExp(workdir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"), "shell cwd must persist as the seat worktree");

// The disposable file is owned by this test's temp workdir.
const written = join(workdir, "disposable.txt");
assert.ok(existsSync(written), "bash must be able to write a disposable file");
assert.equal(readFileSync(written, "utf8"), CANARY);

for (const request of requests) {
  assert.equal(request.apiKeyIsDummy, true, "only the prototype dummy credential may be presented");
  assert.equal(request.model, "deepseek-flash");
  assert.equal(request.effort, "max");
}
console.log("ok t1-persistent-bash");
console.log(JSON.stringify({ workdir, requests: requests.map(r => ({ toolResults: r.toolResults.map(t => t.text.slice(0, 80)) })) }, null, 2));
