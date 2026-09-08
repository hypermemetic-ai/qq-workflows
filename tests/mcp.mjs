#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  ticketReadTool,
  ticketWriteTool,
} from "../bin/mcp-server.mjs";
import { git } from "../workflow/git.mjs";

const exec = promisify(execFile);

// 1. Tool schema checks
assert.equal(TOOLS.length, 4);
const toolNames = TOOLS.map((t) => t.name).sort();
assert.deepEqual(toolNames, ["land", "prepare_worktree", "ticket_read", "ticket_write"]);

const prepareTool = TOOLS.find((t) => t.name === "prepare_worktree");
assert.ok(prepareTool);
assert.deepEqual(prepareTool.inputSchema.required, ["kind"]);
assert.deepEqual(prepareTool.inputSchema.properties.kind.enum, ["bounded", "open"]);

const landTool = TOOLS.find((t) => t.name === "land");
assert.ok(landTool);

const ticketReadToolDef = TOOLS.find((t) => t.name === "ticket_read");
assert.ok(ticketReadToolDef);
assert.ok(ticketReadToolDef.inputSchema.properties.sessionId);
assert.ok(ticketReadToolDef.inputSchema.properties.cwd);

const ticketWriteToolDef = TOOLS.find((t) => t.name === "ticket_write");
assert.ok(ticketWriteToolDef);
assert.ok(ticketWriteToolDef.inputSchema.properties.text);
assert.ok(ticketWriteToolDef.inputSchema.properties.old_string);
assert.ok(ticketWriteToolDef.inputSchema.properties.new_string);
assert.ok(ticketWriteToolDef.inputSchema.properties.replace_all);

// 2. Validation failures
await assert.rejects(
  () => prepareWorktree({}),
  /kind is required: 'bounded' \| 'open'/,
  "Must fail without kind",
);
await assert.rejects(
  () => prepareWorktree({ kind: "invalid" }),
  /kind is required: 'bounded' \| 'open'/,
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
  assert.ok(boundedResult.instructions.includes("implementer subagent"));
  assert.ok(boundedResult.instructions.includes("call 'land'"));
  assert.equal(boundedResult.implementerPrompt, "Follow .architect/ticket.md in the checkout. When finished, report your answer.");
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
  assert.ok(openResult.instructions.includes("reviewer subagent"));
  assert.equal(openResult.implementerPrompt, "Follow .architect/ticket.md in the checkout. When finished, report your answer.");
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

  // 7. Test ticket_read and ticket_write
  // Read active ticket
  const readRes = await ticketReadTool({ cwd: repoDir, sessionId });
  assert.equal(readRes.ok, true);
  assert.equal(readRes.path, join(ticketsDir, `${sessionId}.md`));
  assert.match(readRes.text, /# Test Session Ticket/);

  // Read without explicit sessionId (resolves active ticket, which is openSessionId)
  const readAuto = await ticketReadTool({ cwd: repoDir });
  assert.equal(readAuto.ok, true);
  assert.equal(readAuto.path, join(ticketsDir, `${openSessionId}.md`));

  // Surgical edit via ticketWriteTool
  const writeSurgical = await ticketWriteTool({
    cwd: repoDir,
    sessionId,
    old_string: "bounded",
    new_string: "open",
  });
  assert.equal(writeSurgical.ok, true);
  assert.match(writeSurgical.text, /## Kind\nopen/);
  assert.equal(readFileSync(join(ticketsDir, `${sessionId}.md`), "utf8"), writeSurgical.text);

  // Full replacement via ticketWriteTool
  const newTicketContent = "# Replaced Session Ticket\n\n## Kind\nbounded\n\n## Problem\nFixed bug\n";
  const writeFull = await ticketWriteTool({
    cwd: repoDir,
    sessionId,
    text: newTicketContent,
  });
  assert.equal(writeFull.ok, true);
  assert.equal(writeFull.text, newTicketContent);
  assert.equal(readFileSync(join(ticketsDir, `${sessionId}.md`), "utf8"), newTicketContent);

  // Validation failures on ticket_write
  await assert.rejects(
    () => ticketWriteTool({ cwd: repoDir, sessionId }),
    /ticket_write requires text or old_string\/new_string/,
  );
  await assert.rejects(
    () => ticketWriteTool({ cwd: repoDir, sessionId, old_string: "missing_content", new_string: "replacement" }),
    /ticket_write old_string not found/,
  );

  // Fallback to .architect/ticket.md when no tickets in .architect/tickets
  const fallbackRepo = mkdtempSync(join(tmpdir(), "architect-fallback-repo-"));
  try {
    await git(fallbackRepo, ["init", "-b", "main"]);
    const fbRead = await ticketReadTool({ cwd: fallbackRepo });
    assert.equal(fbRead.ok, true);
    assert.equal(fbRead.path, join(fallbackRepo, ".architect", "ticket.md"));
    assert.match(fbRead.text, /^# Ticket/);

    const fbWrite = await ticketWriteTool({
      cwd: fallbackRepo,
      old_string: "bounded — straightforward work.",
      new_string: "bounded — simple task.",
    });
    assert.equal(fbWrite.ok, true);
    assert.match(fbWrite.text, /bounded — simple task\./);
  } finally {
    rmSync(fallbackRepo, { recursive: true, force: true });
  }

  // 8. Test RPC tools/call with ticket_read and ticket_write
  const rpcRead = await handleRpc("tools/call", {
    name: "ticket_read",
    arguments: { cwd: repoDir, sessionId },
  });
  assert.equal(rpcRead.isError, undefined);
  const parsedRead = JSON.parse(rpcRead.content[0].text);
  assert.equal(parsedRead.ok, true);
  assert.equal(parsedRead.text, newTicketContent);

  const rpcWrite = await handleRpc("tools/call", {
    name: "ticket_write",
    arguments: {
      cwd: repoDir,
      sessionId,
      old_string: "Fixed bug",
      new_string: "Fixed critical bug",
    },
  });
  assert.equal(rpcWrite.isError, undefined);
  const parsedWrite = JSON.parse(rpcWrite.content[0].text);
  assert.equal(parsedWrite.ok, true);
  assert.match(parsedWrite.text, /Fixed critical bug/);

  const rpcWriteErr = await handleRpc("tools/call", {
    name: "ticket_write",
    arguments: {
      cwd: repoDir,
      sessionId,
      old_string: "nonexistent",
      new_string: "foo",
    },
  });
  assert.equal(rpcWriteErr.isError, true);
  assert.match(rpcWriteErr.content[0].text, /ticket_write old_string not found/);

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
}

// 9. RPC & JSON-RPC stdio protocol tests
const initResp = await handleRpc("initialize", {});
assert.equal(initResp.serverInfo.name, "qq-workflows");
assert.equal(initResp.serverInfo.version, "0.2.0");

const pingResp = await handleRpc("ping", {});
assert.deepEqual(pingResp, {});

const listResp = await handleRpc("tools/list", {});
assert.equal(listResp.tools.length, 4);

// tools/call with missing kind should return isError: true
const errCallResp = await handleRpc("tools/call", {
  name: "prepare_worktree",
  arguments: {},
});
assert.equal(errCallResp.isError, true);
assert.match(errCallResp.content[0].text, /kind is required: 'bounded' \| 'open'/);

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
assert.equal(responses[1].result.tools.length, 4);

assert.equal(responses[2].id, 3);
assert.deepEqual(responses[2].result, {});

assert.equal(responses[3].id, 4);
assert.equal(responses[3].error.code, -32601);

rl.close();
console.log("MCP server tests passed cleanly.");
