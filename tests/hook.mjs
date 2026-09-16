#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "architect-hook-"));
const emptyBinDir = mkdtempSync(join(tmpdir(), "architect-empty-bin-"));
const mockBinDir = mkdtempSync(join(tmpdir(), "architect-mock-bin-"));

try {
  // Test 1: pre-invocation executes cleanly when orca is NOT present
  const sessionId = "sess-hook-456";
  const input = JSON.stringify({
    conversationId: sessionId,
    workspacePaths: [dir],
    invocationNum: 1,
  });

  const raw = execFileSync(process.execPath, ["hooks/pre-invocation.mjs"], {
    input,
    encoding: "utf8",
    env: { ...process.env, PATH: emptyBinDir },
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
  const raw2 = execFileSync(process.execPath, ["hooks/pre-invocation.mjs"], {
    input: input2,
    encoding: "utf8",
    env: { ...process.env, PATH: emptyBinDir },
  });
  assert.deepEqual(JSON.parse(raw2), {});

  // Test 2: pre-invocation triggers `orca file open <path>` when orca IS present
  const mockOrcaLog = join(mockBinDir, "orca.log");
  const binName = process.platform === "linux" ? "orca-ide" : "orca";
  const mockOrcaScript = join(mockBinDir, binName);
  writeFileSync(mockOrcaScript, `#!/bin/sh\necho "$@" > "${mockOrcaLog}"\n`, { mode: 0o755 });
  chmodSync(mockOrcaScript, 0o755);

  const sessionIdOrca = "sess-hook-orca-789";
  const inputOrca = JSON.stringify({
    conversationId: sessionIdOrca,
    workspacePaths: [dir],
    invocationNum: 1,
  });

  const rawOrca = execFileSync(process.execPath, ["hooks/pre-invocation.mjs"], {
    input: inputOrca,
    encoding: "utf8",
    env: { ...process.env, PATH: `${mockBinDir}:${process.env.PATH || ""}` },
  });
  const parsedOrca = JSON.parse(rawOrca);
  assert.equal(
    parsedOrca.injectSteps[0].ephemeralMessage,
    `The ticket for this session is \`.architect/tickets/${sessionIdOrca}.md\`.`,
  );

  const ticketFileOrca = join(dir, ".architect", "tickets", `${sessionIdOrca}.md`);
  assert.ok(existsSync(ticketFileOrca), "Ticket file for orca session must be created");

  let waited = 0;
  while (!existsSync(mockOrcaLog) && waited < 2000) {
    await new Promise((r) => setTimeout(r, 20));
    waited += 20;
  }
  assert.ok(existsSync(mockOrcaLog), "Mock orca should have been invoked");
  const logContent = readFileSync(mockOrcaLog, "utf8").trim();
  assert.equal(logContent, `file open ${ticketFileOrca}`);

  console.log("Hook tests passed successfully.");
} finally {
  rmSync(dir, { recursive: true, force: true });
  rmSync(emptyBinDir, { recursive: true, force: true });
  rmSync(mockBinDir, { recursive: true, force: true });
}

// Stop hook tests: hooks/stop.mjs
// Test 3: Stop hook blocks termination with decision: "continue" when complete_task was NOT called
{
  // Use a unique conversationId that has no marker file
  const noCallId = `stop-hook-test-${Date.now()}-nocall`;
  const noCallInput = JSON.stringify({
    terminationReason: "model_stop",
    conversationId: noCallId,
  });

  // Make sure no marker file exists for this id
  const markerPath = join(tmpdir(), `qq-complete-task-${noCallId}.json`);
  try { rmSync(markerPath); } catch {}

  const rawStop = execFileSync(process.execPath, ["hooks/stop.mjs"], {
    input: noCallInput,
    encoding: "utf8",
  });
  const parsedStop = JSON.parse(rawStop);
  assert.equal(parsedStop.decision, "continue", "Stop hook must return decision: continue when complete_task not called");
  assert.ok(parsedStop.reason, "Stop hook must include a reason when blocking termination");
  assert.ok(
    parsedStop.reason.includes("complete_task"),
    "Stop hook reason must mention complete_task",
  );
  assert.ok(
    parsedStop.reason.includes("via conversation"),
    "Stop hook reason must mention 'via conversation'",
  );
}

// Test 4: Stop hook allows termination when complete_task WAS called (marker file present)
{
  const callId = `stop-hook-test-${Date.now()}-called`;
  const callInput = JSON.stringify({
    terminationReason: "model_stop",
    conversationId: callId,
  });

  // Write the marker file that complete_task would create
  const markerPath2 = join(tmpdir(), `qq-complete-task-${callId}.json`);
  writeFileSync(markerPath2, JSON.stringify({ calledAt: Date.now(), key: callId }));

  try {
    const rawStop2 = execFileSync(process.execPath, ["hooks/stop.mjs"], {
      input: callInput,
      encoding: "utf8",
    });
    const parsedStop2 = JSON.parse(rawStop2);
    assert.equal(parsedStop2.decision, "proceed", "Stop hook must return decision: proceed when complete_task was called");
  } finally {
    try { rmSync(markerPath2); } catch {}
  }
}

// Test 5: Stop hook allows termination for non-model_stop reasons (e.g., timeout)
{
  const timeoutInput = JSON.stringify({
    terminationReason: "max_turns",
    conversationId: "stop-hook-timeout-test",
  });
  const rawTimeout = execFileSync(process.execPath, ["hooks/stop.mjs"], {
    input: timeoutInput,
    encoding: "utf8",
  });
  const parsedTimeout = JSON.parse(rawTimeout);
  assert.equal(parsedTimeout.decision, "proceed", "Stop hook must allow termination for non-model_stop reasons");
}

// Test 6: Stop hook allows termination with empty input
{
  const rawEmpty = execFileSync(process.execPath, ["hooks/stop.mjs"], {
    input: "",
    encoding: "utf8",
  });
  const parsedEmpty = JSON.parse(rawEmpty);
  assert.equal(parsedEmpty.decision, "proceed", "Stop hook must allow termination with empty input");
}

console.log("Stop hook tests passed successfully.");

// PostInvocation hook tests: hooks/post-invocation.mjs
// Test 7: PostInvocation hook returns terminationBehavior: "terminate" when complete_task marker IS present
{
  const piCallId = `post-invocation-test-${Date.now()}-called`;
  const piCallInput = JSON.stringify({
    conversationId: piCallId,
    invocationNum: 1,
  });

  // Write the marker file that complete_task would create
  const piMarkerPath = join(tmpdir(), `qq-complete-task-${piCallId}.json`);
  writeFileSync(piMarkerPath, JSON.stringify({ calledAt: Date.now(), key: piCallId }));

  try {
    const rawPi = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
      input: piCallInput,
      encoding: "utf8",
    });
    const parsedPi = JSON.parse(rawPi);
    assert.equal(
      parsedPi.terminationBehavior,
      "terminate",
      "PostInvocation hook must return terminationBehavior: terminate when complete_task was called",
    );
  } finally {
    try { rmSync(piMarkerPath); } catch {}
  }
}

// Test 8: PostInvocation hook returns {} when complete_task marker is NOT present
{
  const piNoCallId = `post-invocation-test-${Date.now()}-nocall`;
  const piNoCallInput = JSON.stringify({
    conversationId: piNoCallId,
    invocationNum: 1,
  });

  // Ensure no marker file exists
  const piNoMarkerPath = join(tmpdir(), `qq-complete-task-${piNoCallId}.json`);
  try { rmSync(piNoMarkerPath); } catch {}

  const rawPiNo = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
    input: piNoCallInput,
    encoding: "utf8",
  });
  const parsedPiNo = JSON.parse(rawPiNo);
  assert.deepEqual(parsedPiNo, {}, "PostInvocation hook must return {} when complete_task was not called");
}

// Test 9: PostInvocation hook returns {} with empty input
{
  const rawPiEmpty = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
    input: "",
    encoding: "utf8",
  });
  const parsedPiEmpty = JSON.parse(rawPiEmpty);
  assert.deepEqual(parsedPiEmpty, {}, "PostInvocation hook must return {} with empty input");
}

// Test 10: PostInvocation hook returns terminationBehavior: "terminate" when complete_task is in payload
{
  const piPayloadId = `post-invocation-test-${Date.now()}-payload`;
  const piPayloadInput = JSON.stringify({
    conversationId: piPayloadId,
    invocationNum: 1,
    tool: "complete_task",
  });

  const rawPiPayload = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
    input: piPayloadInput,
    encoding: "utf8",
  });
  const parsedPiPayload = JSON.parse(rawPiPayload);
  assert.equal(
    parsedPiPayload.terminationBehavior,
    "terminate",
    "PostInvocation hook must return terminationBehavior: terminate when complete_task is in payload",
  );
}

console.log("PostInvocation hook tests passed successfully.");

