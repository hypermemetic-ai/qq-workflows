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

// Test 10: Failed tool call named complete_task without marker must continue
// (failed publication / oversized complete_task / tool exception cannot authorize stopping)
{
  const testId = `hook-test-failed-call-${Date.now()}`;
  const noMarkerPath = join(tmpdir(), `qq-complete-task-${testId}.json`);
  try { rmSync(noMarkerPath, { force: true }); } catch {}

  // Scenario 10a: PostInvocation hook receives real hook input with tool: "complete_task" but no marker
  for (const inputPayload of [
    { conversationId: testId, invocationNum: 1, tool: "complete_task" },
    { conversationId: testId, invocationNum: 1, toolName: "complete_task", error: "response exceeds 32,768-character cap" },
    { conversationId: testId, invocationNum: 1, toolCalls: [{ name: "complete_task", status: "error" }] },
    { conversationId: testId, invocationNum: 1, steps: [{ tool_name: "complete_task" }] },
  ]) {
    const rawPi = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
      input: JSON.stringify(inputPayload),
      encoding: "utf8",
    });
    assert.deepEqual(
      JSON.parse(rawPi),
      {},
      "PostInvocation hook must return {} when complete_task was attempted in payload but failed (no marker)",
    );

    // Also with QQ_RUNNER_ID in dispatched runner context
    const rawPiRunner = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
      input: JSON.stringify(inputPayload),
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: testId },
    });
    assert.deepEqual(
      JSON.parse(rawPiRunner),
      {},
      "PostInvocation hook must return {} for dispatched runner when complete_task failed (no marker)",
    );
  }

  // Scenario 10b: Stop hook receives model_stop with complete_task tool call in payload but no marker
  const stopInput = JSON.stringify({
    terminationReason: "model_stop",
    conversationId: testId,
    tool: "complete_task",
  });
  const rawStop = execFileSync(process.execPath, ["hooks/stop.mjs"], {
    input: stopInput,
    encoding: "utf8",
  });
  assert.equal(
    JSON.parse(rawStop).decision,
    "continue",
    "Stop hook must return continue when complete_task failed without marker",
  );

  const rawStopRunner = execFileSync(process.execPath, ["hooks/stop.mjs"], {
    input: stopInput,
    encoding: "utf8",
    env: { ...process.env, QQ_RUNNER_ID: testId },
  });
  assert.equal(
    JSON.parse(rawStopRunner).decision,
    "continue",
    "Stop hook must return continue for dispatched runner when complete_task failed without marker",
  );
}

// Test 11: Valid marker success may terminate (PostInvocation terminates, Stop hook proceeds)
{
  const runnerId = `hook-test-valid-success-${Date.now()}`;
  const markerPath = join(tmpdir(), `qq-complete-task-${runnerId}.json`);
  writeFileSync(
    markerPath,
    JSON.stringify({ calledAt: Date.now(), key: runnerId, runnerId }),
    "utf8",
  );

  try {
    // PostInvocation hook authorizes termination when authoritative runner marker is present
    const rawPi = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
      input: JSON.stringify({ conversationId: runnerId, invocationNum: 1 }),
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: runnerId },
    });
    assert.equal(
      JSON.parse(rawPi).terminationBehavior,
      "terminate",
      "PostInvocation hook must return terminate when valid runner marker exists",
    );

    // Stop hook allows proceeding when authoritative runner marker is present
    const rawStop = execFileSync(process.execPath, ["hooks/stop.mjs"], {
      input: JSON.stringify({ terminationReason: "model_stop", conversationId: runnerId }),
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: runnerId },
    });
    assert.equal(
      JSON.parse(rawStop).decision,
      "proceed",
      "Stop hook must return proceed when valid runner marker exists",
    );
  } finally {
    try { rmSync(markerPath, { force: true }); } catch {}
  }
}

// Test 12: Wrong runner marker not accepted
{
  const runnerA = `hook-test-runner-A-${Date.now()}`;
  const runnerB = `hook-test-runner-B-${Date.now()}`;
  const markerBPath = join(tmpdir(), `qq-complete-task-${runnerB}.json`);
  const markerAPath = join(tmpdir(), `qq-complete-task-${runnerA}.json`);

  // Only runner B has written a completion marker; runner A has NOT completed
  writeFileSync(
    markerBPath,
    JSON.stringify({ calledAt: Date.now(), key: runnerB, runnerId: runnerB }),
    "utf8",
  );
  try { rmSync(markerAPath, { force: true }); } catch {}

  try {
    // Runner A running hook with runner B's conversationId or payload must NOT accept runner B's marker
    const wrongRunnerInput = JSON.stringify({
      conversationId: runnerB,
      invocationNum: 1,
      tool: "complete_task",
    });

    const rawPi = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
      input: wrongRunnerInput,
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: runnerA },
    });
    assert.deepEqual(
      JSON.parse(rawPi),
      {},
      "PostInvocation hook must reject wrong runner marker and continue",
    );

    const wrongStopInput = JSON.stringify({
      terminationReason: "model_stop",
      conversationId: runnerB,
      tool: "complete_task",
    });
    const rawStop = execFileSync(process.execPath, ["hooks/stop.mjs"], {
      input: wrongStopInput,
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: runnerA },
    });
    assert.equal(
      JSON.parse(rawStop).decision,
      "continue",
      "Stop hook must reject wrong runner marker and continue",
    );
  } finally {
    try { rmSync(markerBPath, { force: true }); } catch {}
  }
}

// Test 13: Concurrent identity isolation
{
  // 13a: Dispatched runners concurrent identity
  const concRunner1 = `hook-test-conc-1-${Date.now()}`;
  const concRunner2 = `hook-test-conc-2-${Date.now()}`;
  const marker1Path = join(tmpdir(), `qq-complete-task-${concRunner1}.json`);
  const marker2Path = join(tmpdir(), `qq-complete-task-${concRunner2}.json`);

  try { rmSync(marker1Path, { force: true }); } catch {}
  try { rmSync(marker2Path, { force: true }); } catch {}

  // Runner 1 completes first
  writeFileSync(
    marker1Path,
    JSON.stringify({ calledAt: Date.now(), key: concRunner1, runnerId: concRunner1 }),
    "utf8",
  );

  try {
    // Runner 2 still running: must not be authorized by runner 1's marker
    const pi2 = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
      input: JSON.stringify({ conversationId: concRunner2, invocationNum: 1 }),
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: concRunner2 },
    });
    assert.deepEqual(JSON.parse(pi2), {}, "Concurrent runner 2 must continue while runner 1 is done");

    const stop2 = execFileSync(process.execPath, ["hooks/stop.mjs"], {
      input: JSON.stringify({ terminationReason: "model_stop", conversationId: concRunner2 }),
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: concRunner2 },
    });
    assert.equal(JSON.parse(stop2).decision, "continue", "Concurrent runner 2 must be blocked by Stop hook");

    // Runner 1 is authorized
    const pi1 = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
      input: JSON.stringify({ conversationId: concRunner1, invocationNum: 1 }),
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: concRunner1 },
    });
    assert.equal(JSON.parse(pi1).terminationBehavior, "terminate");

    const stop1 = execFileSync(process.execPath, ["hooks/stop.mjs"], {
      input: JSON.stringify({ terminationReason: "model_stop", conversationId: concRunner1 }),
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: concRunner1 },
    });
    assert.equal(JSON.parse(stop1).decision, "proceed");

    // Now runner 2 completes
    writeFileSync(
      marker2Path,
      JSON.stringify({ calledAt: Date.now(), key: concRunner2, runnerId: concRunner2 }),
      "utf8",
    );

    const pi2Done = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
      input: JSON.stringify({ conversationId: concRunner2, invocationNum: 2 }),
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: concRunner2 },
    });
    assert.equal(JSON.parse(pi2Done).terminationBehavior, "terminate");

    const stop2Done = execFileSync(process.execPath, ["hooks/stop.mjs"], {
      input: JSON.stringify({ terminationReason: "model_stop", conversationId: concRunner2 }),
      encoding: "utf8",
      env: { ...process.env, QQ_RUNNER_ID: concRunner2 },
    });
    assert.equal(JSON.parse(stop2Done).decision, "proceed");
  } finally {
    try { rmSync(marker1Path, { force: true }); } catch {}
    try { rmSync(marker2Path, { force: true }); } catch {}
  }

  // 13b: Standalone sessions concurrent identity
  const concSess1 = `hook-test-concsess-1-${Date.now()}`;
  const concSess2 = `hook-test-concsess-2-${Date.now()}`;
  const markerSess1Path = join(tmpdir(), `qq-complete-task-${concSess1}.json`);
  const markerSess2Path = join(tmpdir(), `qq-complete-task-${concSess2}.json`);

  try { rmSync(markerSess1Path, { force: true }); } catch {}
  try { rmSync(markerSess2Path, { force: true }); } catch {}

  // Standalone session 1 completes
  writeFileSync(
    markerSess1Path,
    JSON.stringify({ calledAt: Date.now(), key: concSess1 }),
    "utf8",
  );

  try {
    // Standalone session 2 still running (no QQ_RUNNER_ID in env)
    const envClean = { ...process.env };
    delete envClean.QQ_RUNNER_ID;

    const piSess2 = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
      input: JSON.stringify({ conversationId: concSess2, invocationNum: 1 }),
      encoding: "utf8",
      env: envClean,
    });
    assert.deepEqual(JSON.parse(piSess2), {}, "Standalone session 2 must continue");

    const stopSess2 = execFileSync(process.execPath, ["hooks/stop.mjs"], {
      input: JSON.stringify({ terminationReason: "model_stop", conversationId: concSess2 }),
      encoding: "utf8",
      env: envClean,
    });
    assert.equal(JSON.parse(stopSess2).decision, "continue", "Standalone session 2 must be blocked");

    // Standalone session 1 is authorized
    const piSess1 = execFileSync(process.execPath, ["hooks/post-invocation.mjs"], {
      input: JSON.stringify({ conversationId: concSess1, invocationNum: 1 }),
      encoding: "utf8",
      env: envClean,
    });
    assert.equal(JSON.parse(piSess1).terminationBehavior, "terminate");

    const stopSess1 = execFileSync(process.execPath, ["hooks/stop.mjs"], {
      input: JSON.stringify({ terminationReason: "model_stop", conversationId: concSess1 }),
      encoding: "utf8",
      env: envClean,
    });
    assert.equal(JSON.parse(stopSess1).decision, "proceed");
  } finally {
    try { rmSync(markerSess1Path, { force: true }); } catch {}
    try { rmSync(markerSess2Path, { force: true }); } catch {}
  }
}

console.log("PostInvocation hook tests passed successfully.");
