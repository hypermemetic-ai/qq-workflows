#!/usr/bin/env node
// task-completion-terminate PostInvocation hook: forces immediate loop termination
// when complete_task was called during the turn.
// The Gemini PostInvocation hook protocol sends a JSON payload to stdin with:
//   { conversationId, invocationNum, ... }
// and expects a JSON response to stdout:
//   { "terminationBehavior": "terminate" }  — to stop the loop immediately
//   {}                                       — to let the loop continue normally

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

    // Check if complete_task was called for this conversation via the marker file.
    const markerKey = conversationId || "default";
    const { existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    // Marker file written by mcp-server.mjs when complete_task is invoked.
    const markerPath = join(tmpdir(), `qq-complete-task-${markerKey}.json`);
    const calledViaMarker = existsSync(markerPath);

    // Also detect via payload if complete_task was executed during the turn
    const calledViaPayload = Boolean(
      data.tool === "complete_task" ||
      data.toolName === "complete_task" ||
      data.tool_name === "complete_task" ||
      (Array.isArray(data.toolCalls) && data.toolCalls.some((t) => t?.name === "complete_task" || t?.tool === "complete_task")) ||
      (Array.isArray(data.tools) && data.tools.some((t) => t?.name === "complete_task" || t === "complete_task")) ||
      (Array.isArray(data.steps) && data.steps.some((s) => s?.tool_name === "complete_task" || s?.name === "complete_task"))
    );

    if (calledViaMarker || calledViaPayload) {
      // complete_task was called: terminate the execution loop immediately.
      process.stdout.write(JSON.stringify({ terminationBehavior: "terminate" }) + "\n");
    } else {
      // complete_task was NOT called: let the loop continue.
      process.stdout.write(JSON.stringify({}) + "\n");
    }
  } catch {
    // On any error, continue normally to avoid blocking the agent
    process.stdout.write(JSON.stringify({}) + "\n");
  }
}

await main();
