#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "architect-hook-"));
try {
  const sessionId = "sess-hook-456";
  const input = JSON.stringify({
    conversationId: sessionId,
    workspacePaths: [dir],
    invocationNum: 1,
  });

  const raw = execFileSync("node", ["hooks/pre-invocation.mjs"], {
    input,
    encoding: "utf8",
  });
  const parsed = JSON.parse(raw);
  assert.equal(
    parsed.injectSteps[0].ephemeralMessage,
    `The ticket for this session is \`.architect/tickets/${sessionId}.md\`.`,
  );

  const ticketFile = join(dir, ".architect", "tickets", `${sessionId}.md`);
  assert.ok(existsSync(ticketFile), "Ticket file must be created on disk");

  const content = readFileSync(ticketFile, "utf8");
  assert.match(content, /^# Ticket/);

  // Second invocation: should be no-op ({})
  const input2 = JSON.stringify({
    conversationId: sessionId,
    workspacePaths: [dir],
    invocationNum: 2,
  });
  const raw2 = execFileSync("node", ["hooks/pre-invocation.mjs"], {
    input: input2,
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(raw2), {});

  console.log("Hook tests passed successfully.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
