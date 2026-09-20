/**
 * Translation of pinned-harness session events into the event contract the
 * parent worker pipeline already consumes (`bin/mcp-server.mjs`):
 *
 *   * `{type:"item.started"|"item.completed", item:{...}}`  (Codex-shaped items)
 *   * `{type:"item.completed", item:{type:"agent_message", text}}` for the final answer
 *
 * It is deliberately NOT a Codex emulator: only the shapes `handleRunnerEvent`
 * and `handleExecutionStreamEvent` read are produced, plus one explicit
 * `prototype_intermediate_text` item that those handlers record as trajectory
 * and never treat as an answer.
 *
 * Terminal discipline (ticket invariant): success requires a `turn/end` whose
 * `reason.kind === "completed"` AND a non-empty final assistant text within the
 * parent's cap. Text alone, a process exit code, or a stop reason never
 * authorize success by themselves.
 *
 * @module adapter/translate
 */
import { FINAL_RESPONSE_MAX_CHARS } from "../../../workflow/limits.mjs";

// Kept as the adapter's named export; the value has one shared source
// (workflow/limits.mjs) with the parent's authoritative completion cap.
export const MAX_FINAL_ANSWER_CHARS = FINAL_RESPONSE_MAX_CHARS;

const INTERMEDIATE_TEXT_CAP = 600;

function capText(value, max = 200) {
  if (typeof value !== "string") return undefined;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function assistantText(data) {
  const blocks = data?.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter(block => block?.type === "text").map(block => block.text ?? "").join("");
}

function reasoningText(data) {
  const blocks = data?.message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter(block => block?.type === "reasoning").map(block => block.text ?? "").join("");
}

function toolTarget(argumentsJson) {
  try {
    const parsed = JSON.parse(argumentsJson ?? "{}");
    if (typeof parsed?.command === "string") return capText(parsed.command, 80);
    if (typeof parsed?.file_path === "string") return capText(parsed.file_path, 80);
    if (typeof parsed?.path === "string") return capText(parsed.path, 80);
  } catch {
    /* unparsable arguments stay unreported */
  }
  return undefined;
}

/**
 * One translator per worker run. It ignores foreign session identity: only the
 * session this adapter created (and its announced in-runtime children) are
 * accepted, everything else is counted as foreign evidence.
 */
export class SessionTranslator {
  /**
   * @param options.sessionId - the session id this adapter owns.
   * @param options.onLine - sink for translated parent-contract events.
   */
  constructor({ sessionId, onLine }) {
    this.sessionId = sessionId;
    this.onLine = onLine;
    this.sessionTree = new Set([sessionId]);
    this.foreignEvents = 0;
    this.terminal = undefined;
    this.lastAssistantText = "";
    /**
     * Text from the current turn, in arrival order. Nothing is emitted as
     * intermediate until the turn ends, because only then is it known which
     * message was the final answer: the parent must never see intermediate or
     * reasoning prose inside the reviewer's clean output.
     */
    this.pendingTexts = [];
    this.turnEnds = [];
    this.toolNames = new Map();
    this.finalLineEmitted = false;
  }

  /** True when this session id belongs to the adapter's own session tree. */
  owns(sessionId) {
    return this.sessionTree.has(sessionId);
  }

  #line(event) {
    this.onLine(event);
  }

  /** Handle one accepted `session.event` payload. */
  handleEvent(event) {
    const type = event?.type;
    const data = event?.data ?? {};
    switch (type) {
      case "turn/start":
        this.pendingTexts = [];
        return;
      case "assistant/message": {
        const text = assistantText(data);
        const reasoning = reasoningText(data);
        if (reasoning !== "") {
          // Reasoning is structured stdout, never stderr, and the parent
          // deliberately ignores this item type.
          this.#line({ type: "item.completed", item: { type: "reasoning", text: capText(reasoning, 2_000) } });
        }
        if (text !== "") {
          this.lastAssistantText = text;
          this.pendingTexts.push(text);
        }
        return;
      }
      case "tool/call": {
        this.toolNames.set(data.callId, data.name);
        const target = toolTarget(data.arguments);
        this.#line({
          type: "item.started",
          item: { type: "tool_call", tool: data.name, ...(target === undefined ? {} : { path: target }) },
        });
        return;
      }
      case "tool/result": {
        const callId = data.message?.source?.callId ?? data.message?.content?.[0]?.toolCallId;
        const name = this.toolNames.get(callId) ?? "tool";
        this.#line({
          type: "item.completed",
          item: {
            type: "tool_call",
            tool: name,
            ...(data.message?.isError === true ? { status: "error" } : {}),
          },
        });
        return;
      }
      case "turn/end":
        this.terminal = data.reason;
        this.turnEnds.push(data.reason?.kind ?? null);
        return;
      default:
        return;
    }
  }

  /** Handle a `session.event` notification, filtering session identity. */
  handleNotification(notification) {
    const sessionId = notification?.params?.sessionId ?? notification?.sessionId;
    if (typeof sessionId !== "string" || !this.owns(sessionId)) {
      this.foreignEvents += 1;
      return;
    }
    this.handleEvent(notification?.params?.event ?? notification?.event);
  }

  /**
   * Emit every superseded text of the finished turn as trajectory-only items.
   * The last text of a `completed` turn is reserved for the final answer.
   * @returns the number of intermediate items emitted.
   */
  drainIntermediateLines() {
    const superseded = this.terminal?.kind === "completed" ? this.pendingTexts.slice(0, -1) : this.pendingTexts;
    for (const text of superseded) {
      this.#line({
        type: "item.completed",
        item: { type: "prototype_intermediate_text", text: capText(text, INTERMEDIATE_TEXT_CAP) },
      });
    }
    return superseded.length;
  }

  /** Register an in-runtime child session announced by `subagent.started`. */
  registerChild(parentSessionId, childSessionId) {
    if (this.sessionTree.has(parentSessionId) && typeof childSessionId === "string") {
      this.sessionTree.add(childSessionId);
    }
  }

  /**
   * Build the parent-facing final answer line, exactly once.
   * @returns the `agent_message` item, or undefined when no final text exists.
   */
  finalAnswerLine() {
    if (this.terminal?.kind !== "completed") return undefined;
    const text = this.lastAssistantText;
    if (typeof text !== "string" || text.trim() === "") return undefined;
    if (!this.finalLineEmitted) this.finalLineEmitted = true;
    return { type: "item.completed", item: { type: "agent_message", text } };
  }
}

/**
 * Terminal gate: only `completed` may deliver success, and only with a final
 * answer inside the parent's cap. The diagnostic is bounded and content-free.
 * @param options.terminal - last `turn/end` reason, if any was observed.
 * @param options.finalText - last assistant text of the run.
 * @param options.cap - parent response cap (COMPLETE_TASK_RESPONSE_MAX).
 * @returns `{ok:true}` or `{ok:false, code, diagnostic}`.
 */
export function classifyTerminal({ terminal, finalText, cap = MAX_FINAL_ANSWER_CHARS }) {
  if (terminal === undefined) {
    return { ok: false, code: "missing_terminal", diagnostic: "no turn/end reason was observed before the session went idle" };
  }
  if (terminal.kind !== "completed") {
    const code = typeof terminal.kind === "string" && terminal.kind !== "" ? terminal.kind : "unknown";
    return { ok: false, code: `turn_end_${code}`, diagnostic: `turn ended with reason '${code}' (only 'completed' delivers success)` };
  }
  if (typeof finalText !== "string" || finalText.trim() === "") {
    return { ok: false, code: "empty_final_answer", diagnostic: "turn completed without a final assistant text block" };
  }
  if (finalText.length > cap) {
    return {
      ok: false,
      code: "final_answer_over_cap",
      diagnostic: `final answer is ${finalText.length} chars, above the ${cap}-char transport cap; failing closed instead of truncating`,
    };
  }
  return { ok: true };
}
