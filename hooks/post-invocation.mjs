#!/usr/bin/env node
// task-completion-terminate PostInvocation hook: forces immediate loop termination
// when complete_task was successfully called and published during the turn.
// The Gemini PostInvocation hook protocol sends a JSON payload to stdin with:
//   { conversationId, invocationNum, ... }
// and expects a JSON response to stdout:
//   { "terminationBehavior": "terminate" }  — to stop the loop immediately
//   {}                                       — to let the loop continue normally

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function hasValidCompletionMarker(conversationId) {
  const runnerId = process.env.QQ_RUNNER_ID;

  if (runnerId) {
    // Dispatched runner: marker MUST be runner-bound to this specific runner.
    // Wrong runner markers or ambient markers MUST NOT be accepted.
    const runnerMarkerPath = join(tmpdir(), `qq-complete-task-${runnerId}.json`);
    if (!existsSync(runnerMarkerPath)) {
      return false;
    }
    try {
      const raw = readFileSync(runnerMarkerPath, "utf8");
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.calledAt) {
        return false;
      }
      if (parsed.runnerId && parsed.runnerId !== runnerId) {
        return false;
      }
      if (parsed.key && parsed.key !== runnerId) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // Standalone completion: preserve existing conversation/ambient identity
  const markerKey = conversationId || process.env.GEMINI_CONVERSATION_ID || process.env.ASTRA_CONVERSATION_ID || "default";
  const markerPath = join(tmpdir(), `qq-complete-task-${markerKey}.json`);
  if (!existsSync(markerPath)) {
    return false;
  }
  try {
    const raw = readFileSync(markerPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !parsed.calledAt) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function main() {
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      // No input: continue normally
      process.stdout.write(JSON.stringify({}) + "\n");
      return;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      process.stdout.write(JSON.stringify({}) + "\n");
      return;
    }

    const { conversationId } = data;

    // The marker is authoritative and must be runner-bound for a dispatched runner.
    // Failed publication, oversized complete_task, or tool exceptions do not create
    // a valid marker and cannot authorize stopping; retries are preserved.
    const calledViaMarker = hasValidCompletionMarker(conversationId);

    if (calledViaMarker) {
      // complete_task was successfully called: terminate execution loop immediately.
      process.stdout.write(JSON.stringify({ terminationBehavior: "terminate" }) + "\n");
    } else {
      // complete_task was NOT successfully called: let the loop continue.
      process.stdout.write(JSON.stringify({}) + "\n");
    }
  } catch {
    // On any error, continue normally to avoid blocking the agent
    process.stdout.write(JSON.stringify({}) + "\n");
  }
}

await main();
