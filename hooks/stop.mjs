#!/usr/bin/env node
// task-completion Stop hook: blocks model termination unless complete_task was called.
// The Gemini Stop hook protocol sends a JSON payload to stdin with:
//   { terminationReason, conversationId, ... }
// and expects a JSON response to stdout:
//   { "decision": "continue" | "proceed", "reason": "..." }

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
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

    // Check if complete_task was called for this conversation.
    // The registry is maintained by the MCP server process via the COMPLETE_TASK_REGISTRY Map.
    // Since the hook runs as a subprocess, we read the state from the marker file that the
    // MCP server writes when complete_task is invoked.
    const markerKey = conversationId || "default";
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    // Marker file written by mcp-server.mjs when complete_task is called.
    const markerPath = join(tmpdir(), `qq-complete-task-${markerKey}.json`);
    const called = existsSync(markerPath);

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
