#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import {
  TOOLS,
  callTool,
  handleRpc,
  land,
  prepareWorktree,
  resolveSessionId,
  startMcpServer,
} from "../bin/mcp-server.mjs";
import { git } from "../workflow/git.mjs";
import { brainTicketPath } from "../workflow/ticket.mjs";

const exec = promisify(execFile);

// 1. Tool schema checks
assert.equal(TOOLS.length, 2);
const toolNames = TOOLS.map((t) => t.name).sort();
assert.deepEqual(toolNames, ["land", "prepare_worktree"]);

const prepareTool = TOOLS.find((t) => t.name === "prepare_worktree");
assert.ok(prepareTool);
assert.deepEqual(prepareTool.inputSchema.required, ["kind"]);
assert.deepEqual(prepareTool.inputSchema.properties.kind.enum, ["bounded", "open", "research"]);

const landTool = TOOLS.find((t) => t.name === "land");
assert.ok(landTool);

// 2. Validation failures
await assert.rejects(
  () => prepareWorktree({}),
  /kind is required: 'bounded' \| 'open' \| 'research'/,
  "Must fail without kind",
);
await assert.rejects(
  () => prepareWorktree({ kind: "invalid" }),
  /kind is required: 'bounded' \| 'open' \| 'research'/,
  "Must fail with invalid kind",
);

// 3. Functional test in a temporary repository
const repoDir = mkdtempSync(join(tmpdir(), "architect-mcp-repo-"));
try {
  await git(repoDir, ["init", "-b", "main"]);
  await git(repoDir, ["config", "user.name", "MCP Test"]);
  await git(repoDir, ["config", "user.email", "mcp@example.invalid"]);

  writeFileSync(join(repoDir, "README.md"), "# Test Repo\n");
  await git(repoDir, ["add", "README.md"]);
  await git(repoDir, ["commit", "-m", "init repo"]);

  // Create a session ticket in .architect/tickets/<sessionId>.md
  const sessionId = "12345678-abcd-ef01-2345-6789abcdef01";
  const ticketsDir = join(repoDir, ".architect", "tickets");
  mkdirSync(ticketsDir, { recursive: true });
  writeFileSync(join(ticketsDir, `${sessionId}.md`), "# Test Session Ticket\n\n## Kind\nbounded\n");

  // Verify resolveSessionId picks up the active ticket
  const resolved = await resolveSessionId(repoDir);
  assert.equal(resolved, sessionId);

  // 4. prepare_worktree with kind = bounded
  const boundedResult = await prepareWorktree({
    kind: "bounded",
    sessionId,
    cwd: repoDir,
  });

  assert.equal(boundedResult.ok, true);
  assert.equal(boundedResult.kind, "bounded");
  assert.equal(boundedResult.branch, "architect/bounded/12345678");
  assert.equal(boundedResult.reviewRequired, false);
  assert.ok(boundedResult.worktree.includes(".qq-worktrees"));
  assert.match(boundedResult.instructions, /--conversation [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.ok(boundedResult.instructions.includes("Do NOT pass '--new-project'"));
  assert.ok(boundedResult.instructions.includes("agy --agent implementer"));
  assert.ok(boundedResult.instructions.includes("call 'land'"));
  assert.ok(boundedResult.instructions.includes(`Cwd: ${boundedResult.worktree}`));
  assert.ok(boundedResult.instructions.includes("run_command"));
  assert.equal(boundedResult.implementerPrompt, "Implement .architect/ticket.md in the checkout. When finished, report your answer.");
  assert.equal(boundedResult.reviewerPrompt, undefined);

  // Verify ticket was copied into the worktree as .architect/ticket.md
  const wtTicket = join(boundedResult.worktree, ".architect", "ticket.md");
  assert.equal(readFileSync(wtTicket, "utf8"), "# Test Session Ticket\n\n## Kind\nbounded\n");

  // 5. prepare_worktree with kind = open
  const openSessionId = "87654321-fedc-ba98-7654-3210fedcba98";
  writeFileSync(join(ticketsDir, `${openSessionId}.md`), "# Open Session Ticket\n\n## Kind\nopen\n");

  const openResult = await prepareWorktree({
    kind: "open",
    sessionId: openSessionId,
    cwd: repoDir,
  });

  assert.equal(openResult.ok, true);
  assert.equal(openResult.kind, "open");
  assert.equal(openResult.branch, "architect/open/87654321");
  assert.equal(openResult.reviewRequired, true);
  assert.match(openResult.instructions, /--conversation [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.ok(openResult.instructions.includes("Do NOT pass '--new-project'"));
  assert.ok(openResult.instructions.includes("agy --agent reviewer"));
  assert.ok(openResult.instructions.includes(`Cwd: ${openResult.worktree}`));
  assert.ok(openResult.instructions.includes("run_command"));
  assert.equal(openResult.implementerPrompt, "Implement .architect/ticket.md in the checkout. When finished, report your answer.");
  assert.equal(
    openResult.reviewerPrompt,
    "Follow .architect/ticket.md in the checkout. Follow its testing plan. Do not change project code. Report findings. Empty findings means it passed.",
  );

  // 6. Test landing worktree
  // Make changes in bounded worktree
  writeFileSync(join(boundedResult.worktree, "code.txt"), "console.log('hello');\n");

  const landResult = await land({
    worktree: boundedResult.worktree,
    cwd: repoDir,
    message: "feat: implemented feature",
  });

  assert.equal(landResult.ok, true);
  assert.equal(landResult.landed, true);
  assert.equal(landResult.branch, "architect/bounded/12345678");
  assert.equal(landResult.method, "ff");

  // Verify file landed in main
  assert.equal(readFileSync(join(repoDir, "code.txt"), "utf8"), "console.log('hello');\n");

  // 6b. prepare_worktree with kind = research and test landing with changes
  const researchSessionId = "abcdef99-1111-2222-3333-444455556666";
  writeFileSync(join(ticketsDir, `${researchSessionId}.md`), "# Research Session Ticket\n\n## Kind\nresearch\n");

  const researchResult = await prepareWorktree({
    kind: "research",
    sessionId: researchSessionId,
    cwd: repoDir,
  });

  assert.equal(researchResult.ok, true);
  assert.equal(researchResult.kind, "research");
  assert.equal(researchResult.branch, "architect/research/abcdef99");
  assert.equal(researchResult.reviewRequired, false);
  assert.equal(researchResult.researcherPrompt, "Investigate .architect/ticket.md in the checkout. Report findings.");
  assert.equal(researchResult.implementerPrompt, undefined);
  assert.equal(researchResult.reviewerPrompt, undefined);
  assert.ok(researchResult.instructions.includes(`Cwd: ${researchResult.worktree}`));
  assert.ok(researchResult.instructions.includes(`${researchResult.worktree}/.architect/ticket.md`));
  assert.ok(researchResult.instructions.includes("run_command"));
  assert.equal(
    researchResult.instructions,
    `Worktree ready at ${researchResult.worktree}.\nBranch: ${researchResult.branch}\nReview required: false\n\nNext steps:\n1. Invoke research subagent with ticket path ${researchResult.worktree}/.architect/ticket.md and worktree cwd via run_command (with Cwd: ${researchResult.worktree}) using Prompt: "Investigate .architect/ticket.md in the checkout. Report findings."\n2. When finished, call 'land'.`,
  );
  assert.equal(
    readFileSync(join(researchResult.worktree, ".architect", "ticket.md"), "utf8"),
    "# Research Session Ticket\n\n## Kind\nresearch\n",
  );

  writeFileSync(join(researchResult.worktree, "findings.md"), "# Research Findings\n");
  const landResearchResult = await land({
    worktree: researchResult.worktree,
    cwd: repoDir,
    message: "docs: research findings",
  });
  assert.equal(landResearchResult.ok, true);
  assert.equal(landResearchResult.landed, true);
  assert.equal(landResearchResult.branch, "architect/research/abcdef99");
  assert.equal(landResearchResult.method, "ff");
  assert.equal(readFileSync(join(repoDir, "findings.md"), "utf8"), "# Research Findings\n");

  // 6c. Test landing read-only research worktree with no diff/commits against base
  const roSessionId = "ro998877-1111-2222-3333-444455556666";
  writeFileSync(join(ticketsDir, `${roSessionId}.md`), "# Read-Only Research Ticket\n\n## Kind\nresearch\n");
  const roResult = await prepareWorktree({
    kind: "research",
    sessionId: roSessionId,
    cwd: repoDir,
  });
  assert.equal(roResult.ok, true);
  assert.equal(roResult.branch, "architect/research/ro998877");
  const landRoResult = await land({
    worktree: roResult.worktree,
    cwd: repoDir,
  });
  assert.equal(landRoResult.ok, true);
  assert.equal(landRoResult.landed, true);
  assert.equal(landRoResult.retired, true);
  assert.equal(landRoResult.branch, "architect/research/ro998877");
  assert.equal(landRoResult.method, "none");
  assert.equal(landRoResult.pr, null);
  const wtListAfterRo = await git(repoDir, ["worktree", "list"]);
  assert.ok(!wtListAfterRo.includes("architect/research/ro998877"));
  await assert.rejects(() => git(repoDir, ["rev-parse", "--verify", "refs/heads/architect/research/ro998877"]));

  // 7. Test ticket resolution in prepare_worktree
  // A. Brain artifact resolution
  const brainSessionId = "brain-session-0001";
  const brainPath = brainTicketPath(brainSessionId);
  mkdirSync(dirname(brainPath), { recursive: true });
  writeFileSync(brainPath, "# Brain Ticket\n\n## Kind\nbounded\n");

  const brainResult = await prepareWorktree({
    kind: "bounded",
    sessionId: brainSessionId,
    cwd: repoDir,
  });
  assert.equal(brainResult.ok, true);
  assert.equal(
    readFileSync(join(brainResult.worktree, ".architect", "ticket.md"), "utf8"),
    "# Brain Ticket\n\n## Kind\nbounded\n",
  );

  // Clean up brain worktree
  try {
    await git(repoDir, ["worktree", "remove", "--force", brainResult.worktree]);
  } catch {}
  try {
    await git(repoDir, ["branch", "-D", brainResult.branch]);
  } catch {}

  // B. Fallback to .architect/ticket.md when neither session ticket nor brain ticket exists
  const fallbackSessionId = "fallback-session-0002";
  const rootArchitectDir = join(repoDir, ".architect");
  writeFileSync(join(rootArchitectDir, "ticket.md"), "# Root Fallback Ticket\n\n## Kind\nbounded\n");

  const fbResult = await prepareWorktree({
    kind: "bounded",
    sessionId: fallbackSessionId,
    cwd: repoDir,
  });
  assert.equal(fbResult.ok, true);
  assert.equal(
    readFileSync(join(fbResult.worktree, ".architect", "ticket.md"), "utf8"),
    "# Root Fallback Ticket\n\n## Kind\nbounded\n",
  );

  // Clean up fallback worktree
  try {
    await git(repoDir, ["worktree", "remove", "--force", fbResult.worktree]);
  } catch {}
  try {
    await git(repoDir, ["branch", "-D", fbResult.branch]);
  } catch {}

  // 8. Test RPC tools/call rejects removed ticket tools
  const rpcRead = await handleRpc("tools/call", {
    name: "ticket_read",
    arguments: { cwd: repoDir, sessionId },
  });
  assert.equal(rpcRead.isError, true);
  assert.match(rpcRead.content[0].text, /Unknown tool: ticket_read/);

  const rpcWrite = await handleRpc("tools/call", {
    name: "ticket_write",
    arguments: { cwd: repoDir, sessionId },
  });
  assert.equal(rpcWrite.isError, true);
  assert.match(rpcWrite.content[0].text, /Unknown tool: ticket_write/);

  await assert.rejects(
    () => callTool("ticket_read"),
    /Unknown tool: ticket_read/,
  );
  await assert.rejects(
    () => callTool("ticket_write"),
    /Unknown tool: ticket_write/,
  );

  // Clean up open worktree
  try {
    await git(repoDir, ["worktree", "remove", "--force", openResult.worktree]);
  } catch {}
  try {
    await git(repoDir, ["branch", "-D", openResult.branch]);
  } catch {}
} finally {
  try {
    rmSync(join(dirname(repoDir), ".qq-worktrees", basename(repoDir)), { recursive: true, force: true });
  } catch {}
  rmSync(repoDir, { recursive: true, force: true });
  try {
    rmSync(join(homedir(), ".gemini", "antigravity-cli", "brain", sessionId), { recursive: true, force: true });
    rmSync(join(homedir(), ".gemini", "antigravity-cli", "brain", "brain-session-0001"), { recursive: true, force: true });
  } catch {}
}

// 9. RPC & JSON-RPC stdio protocol tests
const initResp = await handleRpc("initialize", {});
assert.equal(initResp.serverInfo.name, "qq-workflows");
assert.equal(initResp.serverInfo.version, "0.2.0");

const pingResp = await handleRpc("ping", {});
assert.deepEqual(pingResp, {});

const listResp = await handleRpc("tools/list", {});
assert.equal(listResp.tools.length, 2);

// tools/call with missing kind should return isError: true
const errCallResp = await handleRpc("tools/call", {
  name: "prepare_worktree",
  arguments: {},
});
assert.equal(errCallResp.isError, true);
assert.match(errCallResp.content[0].text, /kind is required: 'bounded' \| 'open' \| 'research'/);

// Test startMcpServer via stream piping
const stdinStream = new PassThrough();
const stdoutStream = new PassThrough();

const responses = [];
stdoutStream.on("data", (chunk) => {
  const lines = chunk.toString("utf8").split("\n").filter((l) => l.trim().length > 0);
  for (const line of lines) {
    responses.push(JSON.parse(line));
  }
});

const rl = startMcpServer({ stdin: stdinStream, stdout: stdoutStream });

// Send initialize request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
// Send tools/list request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
// Send ping request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping", params: {} }) + "\n");
// Send unknown method request
stdinStream.write(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "nonexistent", params: {} }) + "\n");

await new Promise((resolve) => setTimeout(resolve, 100));

assert.equal(responses.length, 4);
assert.equal(responses[0].id, 1);
assert.equal(responses[0].result.serverInfo.name, "qq-workflows");

assert.equal(responses[1].id, 2);
assert.equal(responses[1].result.tools.length, 2);

assert.equal(responses[2].id, 3);
assert.deepEqual(responses[2].result, {});

assert.equal(responses[3].id, 4);
assert.equal(responses[3].error.code, -32601);

rl.close();
console.log("MCP server tests passed cleanly.");
