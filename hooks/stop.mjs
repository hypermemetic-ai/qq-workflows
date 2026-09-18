#!/usr/bin/env node
// task-completion Stop hook: blocks model termination unless complete_task was called.
// The Gemini Stop hook protocol sends a JSON payload to stdin with:
//   { terminationReason, conversationId, ... }
// and expects a JSON response to stdout:
//   { "decision": "continue" | "proceed", "reason": "..." }

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
      // No input: allow termination by default
      process.stdout.write(JSON.stringify({ decision: "proceed" }) + "\n");
      return;
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      process.stdout.write(JSON.stringify({ decision: "proceed" }) + "\n");
      return;
    }

    const { terminationReason, conversationId } = data;

    // Only enforce for model_stop (natural LLM completion) — not for timeouts or signals.
    if (terminationReason !== "model_stop") {
      process.stdout.write(JSON.stringify({ decision: "proceed" }) + "\n");
      return;
    }

    // Check if complete_task was called for this conversation/runner via authoritative marker.
    // Dispatched runner is strictly runner-bound; standalone completion uses conversation identity.
    const called = hasValidCompletionMarker(conversationId);

    if (called) {
      // complete_task was called: allow termination
      process.stdout.write(JSON.stringify({ decision: "proceed" }) + "\n");
    } else {
      // complete_task was NOT called: block termination
      process.stdout.write(
        JSON.stringify({
          decision: "continue",
          reason:
            "You cannot terminate via conversation. You must conclude and report your outcome using the complete_task tool.",
        }) + "\n",
      );
    }
  } catch {
    // On any error, allow termination to avoid blocking the agent
    process.stdout.write(JSON.stringify({ decision: "proceed" }) + "\n");
  }
}

await main();
