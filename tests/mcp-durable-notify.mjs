#!/usr/bin/env node
// Merged MCP terminal path: the compatibility adapter (durable report persisted
// BEFORE the notification, bounded delivered text, truthful delivery state) and
// origin/main's durable runner recovery (findings retained for replay, retryable
// failures, prune only after a confirmed delivery) must hold at the same time.
//
// These are integration assertions over the real adapter entry points; the
// retention/replay machinery is additionally covered by tests/mcp.mjs.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MCP_NOTIFY_CAP,
  buildTrackerReport,
  cleanupRunnerFiles,
  hasRetainedFindings,
  notifyTerminal,
  persistTrackerReport,
  trackerStateDir,
} from "../bin/mcp-server.mjs";
import { readReport } from "../workflow/reports.mjs";
import { readNotification } from "../workflow/notify.mjs";

// tests/run.mjs supplies isolated state/findings directories; a direct run of
// this file creates the same isolation itself.
const stateRoot = process.env.QQ_WORKFLOW_STATE_DIR ?? mkdtempSync(join(tmpdir(), "qq-mcp-notify-state-"));
process.env.QQ_WORKFLOW_STATE_DIR = stateRoot;
process.env.QQ_RUNNER_FINDINGS_DIR ??= mkdtempSync(join(tmpdir(), "qq-mcp-notify-findings-"));
const runnerStateDir = join(stateRoot, "runners");
const workDir = mkdtempSync(join(tmpdir(), "qq-mcp-notify-"));
// The legacy queue transport routes to a Codex thread; tests provide the
// trusted runtime thread explicitly (the same hook tests/mcp.mjs uses).
globalThis.__QQ_TEST_CODEX_THREAD = "durable-notify-thread";
const runnerId = "3f1c0a1e-1111-4222-8333-444455556666";

function tracker(extra = {}) {
  return { id: runnerId, runnerId, sessionId: "origin-sess", cwd: workDir, status: "completed", startedAt: Date.now(), ...extra };
}

// ---------------------------------------------------------------------------
// N1. The complete report exists BEFORE the transport runs, the delivered text
//     is bounded and carries the report reference, and the durable notification
//     record states exactly what the transport achieved.
// ---------------------------------------------------------------------------
{
  const findings = `FULL-REPORT-HEAD ${"y".repeat(50_000)} FULL-REPORT-TAIL`;
  const t = tracker({ result: { response: findings, data_points: ["dp-1"] } });
  const durable = persistTrackerReport(t, "runner");
  const observed = [];
  globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => {
    // Runs inside the transport: the durable copy must already be on disk.
    const persisted = readReport(stateRoot, durable.reportId);
    // Walk the whole report in chunks, as read_report does.
    let text = "";
    let offset = 0;
    const chunks = [];
    for (let i = 0; i < 20; i += 1) {
      const chunk = readReport(stateRoot, durable.reportId, { offset });
      if (!chunk.ok) break;
      text += chunk.text;
      offset = chunk.nextOffset;
      chunks.push(chunk.text.length);
      if (chunk.complete) break;
    }
    observed.push({
      message: call.message,
      persistedOk: persisted.ok,
      persistedComplete: persisted.complete,
      persistedChars: persisted.totalChars,
      chunks,
      retrieved: text,
    });
  };
  try {
    const res = await notifyTerminal(t, "runner");
    assert.equal(observed.length, 1, "exactly one transport call");
    assert.equal(observed[0].persistedOk, true, "the full report is persisted before the notification is sent");
    assert.equal(observed[0].retrieved, buildTrackerReport(t, "runner"), "chunked retrieval returns the complete report verbatim");
    assert.equal(observed[0].persistedChars, buildTrackerReport(t, "runner").length, "the durable report already held the complete text when the transport ran");
    assert.ok(observed[0].chunks.length >= 3, "the report is retrievable in bounded chunks");
    assert.ok(observed[0].retrieved.length > MCP_NOTIFY_CAP, "the full over-cap report is recoverable");
    assert.ok(observed[0].message.length <= MCP_NOTIFY_CAP, "the delivered notification stays inside the transport cap");
    assert.match(observed[0].message, /FULL-REPORT-HEAD/, "the bounded notification keeps the head");
    assert.match(observed[0].message, /FULL-REPORT-TAIL/, "the bounded notification keeps the tail");
    assert.match(observed[0].message, /chars omitted/, "the notification states exactly how much was omitted");
    assert.ok(observed[0].message.includes(res.reportId), "the notification carries the durable report reference");
    assert.equal(res.notified, true);
    assert.equal(res.deliveryState, "accepted", "the queue transport confirms acceptance, not a delivered turn");
    assert.equal(res.reportId, durable.reportId);
    assert.equal(t.notifiedTerminal, true, "a confirmed delivery marks the tracker delivered");
    assert.equal(t.notifiedTerminalInFlight, undefined, "the in-flight marker clears");
    assert.equal(res.via, "test-hook");

    const record = readNotification(runnerStateDir, `runner:${runnerId}:terminal`);
    assert.equal(record.state, "accepted", "the durable record reports transport acceptance truthfully");
    assert.equal(record.resultAvailable, true, "result availability is a property of persistence, not delivery");
    assert.equal(record.truncated, true);
    assert.equal(record.reportId, res.reportId);

    // A repeat is suppressed without touching the transport again.
    const repeat = await notifyTerminal(t, "runner");
    assert.equal(repeat.reason, "already-notified");
    assert.equal(observed.length, 1);
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
  }
}

// ---------------------------------------------------------------------------
// N2. A rejected transport stays retryable, reports failure truthfully, and a
//     retry actually delivers — with the durable record advancing in sequence.
// ---------------------------------------------------------------------------
{
  const binDir = mkdtempSync(join(tmpdir(), "qq-mcp-notify-bin-"));
  const countFile = join(binDir, "count");
  const fakeCodex = join(binDir, "codex");
  writeFileSync(
    fakeCodex,
    `#!/usr/bin/env bash\nn=0\n[ -f "${countFile}" ] && n=$(cat "${countFile}")\nn=$((n+1))\necho "$n" > "${countFile}"\nif [ "$n" -eq 1 ]; then exit 1; fi\nexit 0\n`,
    "utf8",
  );
  execFileSync("chmod", ["+x", fakeCodex]);
  const savedBin = process.env.QQ_CODEX_BIN;
  const savedThread = globalThis.__QQ_TEST_CODEX_THREAD;
  try {
    process.env.QQ_CODEX_BIN = fakeCodex;
    globalThis.__QQ_TEST_CODEX_THREAD = "durable-notify-thread";
    const t = tracker({ id: `${runnerId}-b`, runnerId: `${runnerId}-b`, result: "retry findings" });
    const failed = await notifyTerminal(t, "runner");
    assert.equal(failed.notified, false, "a rejected transport never claims delivery");
    assert.match(String(failed.reason), /exited with code 1/);
    assert.equal(failed.deliveryState, "failed");
    assert.equal(t.notifiedTerminal, undefined, "a failure leaves the tracker retryable");
    assert.equal(t.notifiedTerminalInFlight, undefined, "the in-flight marker clears on failure");
    const failedRecord = readNotification(runnerStateDir, `runner:${runnerId}-b:terminal`);
    assert.equal(failedRecord.state, "failed", "the durable record reports the failure truthfully");
    assert.equal(failedRecord.resultAvailable, true, "the report survives a failed notification");

    const delivered = await notifyTerminal(t, "runner");
    assert.equal(delivered.notified, true, "a retry after a failed transport delivers");
    assert.equal(t.notifiedTerminal, true);
    assert.equal(readFileSync(countFile, "utf8").trim(), "2", "exactly two transport attempts");
    const deliveredRecord = readNotification(runnerStateDir, `runner:${runnerId}-b:terminal`);
    assert.equal(deliveredRecord.state, "accepted");
    assert.equal(deliveredRecord.seq, 2, "the durable record keeps the delivery sequence");
  } finally {
    if (savedBin === undefined) delete process.env.QQ_CODEX_BIN;
    else process.env.QQ_CODEX_BIN = savedBin;
    globalThis.__QQ_TEST_CODEX_THREAD = savedThread ?? "durable-notify-thread";
    rmSync(binDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// N3. Concurrent attempts coalesce onto one send; nothing claims delivery while
//     the transport is still in flight.
// ---------------------------------------------------------------------------
{
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  globalThis.__QQ_TEST_NOTIFY_HANDLER = async (call) => {
    calls.push(call);
    await gate;
  };
  try {
    const t = tracker({ id: `${runnerId}-c`, runnerId: `${runnerId}-c`, result: "coalesced" });
    const first = notifyTerminal(t, "runner");
    assert.equal(t.notifiedTerminal, undefined, "an in-flight attempt must not claim delivery");
    assert.ok(t.notifiedTerminalInFlight, "the in-flight attempt is observable");
    const second = notifyTerminal(t, "runner");
    assert.equal(calls.length, 1, "a concurrent attempt must not start a duplicate send");
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.notified, true);
    assert.equal(b.notified, true, "the coalesced caller reports the in-flight outcome");
    assert.equal(calls.length, 1);
    assert.equal(t.notifiedTerminal, true);
    assert.equal(t.notifiedTerminalInFlight, undefined);
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
  }
}

// ---------------------------------------------------------------------------
// N4. origin/main's durable retention survives the merge: a terminal runner
//     retains findings for replay, a confirmed delivery prunes the redundant
//     copy, and the full report is still retrievable from the durable store.
// ---------------------------------------------------------------------------
{
  const retainedId = "9c2b1a04-5555-4666-8777-888899990000";
  const resultFile = join(workDir, `${retainedId}.json`);
  writeFileSync(resultFile, JSON.stringify({ runnerId: retainedId, response: "retained findings text", data_points: [] }), "utf8");
  const t = { id: retainedId, runnerId: retainedId, sessionId: "origin-sess", cwd: workDir, status: "completed", startedAt: Date.now(), resultFile, result: { response: "retained findings text", data_points: [] } };
  cleanupRunnerFiles(t);
  assert.equal(hasRetainedFindings(retainedId), true, "a terminal runner retains its findings durably");
  assert.equal(existsSync(resultFile), false, "the transient transport file is cleaned up");

  globalThis.__QQ_TEST_NOTIFY_HANDLER = async () => {};
  try {
    const res = await notifyTerminal(t, "runner");
    assert.equal(res.notified, true);
    assert.equal(hasRetainedFindings(retainedId), false, "a confirmed delivery prunes the redundant retained copy");
    const persisted = readReport(stateRoot, res.reportId);
    assert.equal(persisted.ok, true, "the durable report keeps the full findings after the prune");
    assert.match(persisted.text, /retained findings text/);
    // A cleanup pass after the prune must not resurrect a stale artifact.
    cleanupRunnerFiles(t);
    assert.equal(hasRetainedFindings(retainedId), false);
  } finally {
    delete globalThis.__QQ_TEST_NOTIFY_HANDLER;
  }
}

delete globalThis.__QQ_TEST_CODEX_THREAD;
rmSync(workDir, { recursive: true, force: true });
console.log("MCP durable notification + retention merge tests passed cleanly.");
