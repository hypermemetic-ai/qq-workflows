#!/usr/bin/env node
// Offline stand-in for `pi --mode rpc` used by the worker runtime tests.
//
// It speaks the documented JSONL protocol (one JSON record per line on stdin,
// responses plus streamed events on stdout) and is configured entirely through
// environment variables, so a test can drive capability validation, compaction
// verification, completion, failure and cancellation without a provider:
//
//   QQ_FAKE_PI_LEVELS          comma-separated available thinking levels
//   QQ_FAKE_PI_COMPACTION      "true" | "false"  (set_auto_compaction outcome)
//   QQ_FAKE_PI_MODE            "ok" | "error" | "stall"
//   QQ_FAKE_PI_ANSWER          final assistant text (default "OK")
//   QQ_FAKE_PI_COMMAND_LOG     file to append every received command to
//   QQ_FAKE_PI_CAPACITY        reported model contextWindow
//   QQ_FAKE_PI_STOP_REASON     final message stopReason (default "stop")
//   QQ_FAKE_PI_ERROR_MESSAGE   final message errorMessage
//   QQ_FAKE_PI_MODEL/PROVIDER  override the selection reported by get_state
//                              (default: the --model/--provider it was launched
//                              with, like the real runtime)
//   QQ_FAKE_PI_SESSION_ID      sessionId reported by get_state (default
//                              "fake-session"; set a bare UUID for the
//                              communication-binding tests)
//   QQ_FAKE_PI_INJECT_TURN_DELAY_MS
//                              after the FIRST turn settles, start a second
//                              agent run after this many milliseconds (0 =
//                              off) - models the receiver's idle injection
//                              during the drain window
//   QQ_FAKE_PI_INJECT_TURN_SETTLES  "true" (default) = the injected run emits
//                              message_end + agent_settled with
//                              QQ_FAKE_PI_SECOND_ANSWER; "false" = it starts
//                              and never settles (drain-deadline refusal path)
//   QQ_FAKE_PI_SECOND_ANSWER   final text of the injected run (default "UPDATED")
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const env = process.env;
const levels = String(env.QQ_FAKE_PI_LEVELS ?? "off,minimal,low,medium,high,xhigh,max").split(",").map((level) => level.trim()).filter(Boolean);
const compactionEnabled = String(env.QQ_FAKE_PI_COMPACTION ?? "true") === "true";
const mode = env.QQ_FAKE_PI_MODE ?? "ok";
const answer = env.QQ_FAKE_PI_ANSWER ?? "OK";
const capacity = Number(env.QQ_FAKE_PI_CAPACITY ?? 1_048_576);
const commandLog = env.QQ_FAKE_PI_COMMAND_LOG ?? null;
const stopReason = env.QQ_FAKE_PI_STOP_REASON ?? "stop";
const errorMessage = env.QQ_FAKE_PI_ERROR_MESSAGE ?? null;
const sessionId = env.QQ_FAKE_PI_SESSION_ID ?? "fake-session";
const injectTurnDelayMs = Number(env.QQ_FAKE_PI_INJECT_TURN_DELAY_MS ?? 0);
const injectTurnSettles = String(env.QQ_FAKE_PI_INJECT_TURN_SETTLES ?? "true") === "true";
const secondAnswer = env.QQ_FAKE_PI_SECOND_ANSWER ?? "UPDATED";

// The real runtime reports the model it resolved from the launch selection, so
// the fake does the same unless a test overrides it to prove a refusal path.
function flagValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
const launchedModel = flagValue("--model");
const launchedProvider = flagValue("--provider");

const write = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (command, success = true, data = undefined) =>
  write({ type: "response", command: command.type, id: command.id ?? null, success, ...(data === undefined ? {} : { data }) });

let compactionState = compactionEnabled;
let streaming = false;
let firstTurnSettled = false;
let injectedTurn = false;

// Simulates the communication receiver's idle injection: after the first turn
// settles, a NEW agent run starts (agent_start ... agent_settled). The adapter's
// drain window must postpone final-result selection until this run settles, so
// the post-update answer - not the stale pre-injection one - is the outcome.
function maybeInjectTurn() {
  if (firstTurnSettled === false || injectedTurn === true || injectTurnDelayMs <= 0) return;
  injectedTurn = true;
  setTimeout(() => {
    write({ type: "agent_start" });
    if (!injectTurnSettles) return;
    write({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: secondAnswer }],
        stopReason,
        ...(errorMessage === null ? {} : { errorMessage }),
      },
    });
    write({ type: "agent_end", messages: [], willRetry: false });
    write({ type: "agent_settled" });
  }, injectTurnDelayMs);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.replace(/\r$/u, "");
  if (text.trim() === "") return;
  let command;
  try {
    command = JSON.parse(text);
  } catch {
    return;
  }
  if (commandLog) appendFileSync(commandLog, `${JSON.stringify(command)}\n`);

  switch (command.type) {
    case "get_state":
      respond(command, true, {
        model: {
          id: env.QQ_FAKE_PI_MODEL ?? launchedModel ?? "fake-model",
          name: env.QQ_FAKE_PI_MODEL_NAME ?? undefined,
          provider: env.QQ_FAKE_PI_PROVIDER ?? launchedProvider ?? "fake",
          contextWindow: capacity,
        },
        thinkingLevel: env.QQ_FAKE_PI_THINKING ?? levels.at(-1) ?? "off",
        isStreaming: streaming,
        isCompacting: false,
        autoCompactionEnabled: compactionState,
        sessionId,
        messageCount: 0,
      });
      return;
    case "get_available_thinking_levels":
      respond(command, true, { levels });
      return;
    case "set_auto_compaction":
      compactionState = command.enabled === true ? compactionEnabled : false;
      respond(command, true, { enabled: compactionState });
      return;
    case "set_thinking_level":
      respond(command, true, {});
      return;
    case "get_session_stats":
      respond(command, true, {
        assistantMessages: 1,
        toolCalls: 1,
        tokens: { input: 1200, output: 40, cacheRead: 0, cacheWrite: 0, total: 1240 },
        cost: 0,
        contextUsage: { tokens: 1240, contextWindow: capacity, percent: 1 },
      });
      return;
    case "compact":
      respond(command, true, { tokensBefore: 1240, estimatedTokensAfter: 300 });
      return;
    case "abort":
      respond(command, true, {});
      process.exit(0);
      return;
    case "prompt": {
      respond(command, true, {});
      streaming = true;
      write({ type: "agent_start" });
      write({ type: "turn_start" });
      write({ type: "tool_execution_start", toolName: "zvec_grep_search", toolCallId: "call-1", args: { query: "needle" } });
      write({ type: "tool_execution_end", toolName: "zvec_grep_search", toolCallId: "call-1", isError: false });
      if (mode === "error") {
        write({ type: "extension_error", error: { message: "worker extension exploded" } });
        write({ type: "agent_end", messages: [], willRetry: false });
        write({ type: "agent_settled" });
        streaming = false;
        return;
      }
      if (mode !== "stall") {
        write({ type: "message_start", message: { role: "assistant", content: [] } });
        write({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial " } });
        write({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: answer }],
            stopReason,
            ...(errorMessage === null ? {} : { errorMessage }),
          },
        });
        write({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: answer }] }, toolResults: [] });
        write({ type: "agent_end", messages: [], willRetry: false });
        write({ type: "agent_settled" });
        streaming = false;
        firstTurnSettled = true;
        maybeInjectTurn();
        return;
      }
      streaming = false;
      return;
    }
    default:
      respond(command, false, {});
  }
});

rl.on("close", () => process.exit(0));
