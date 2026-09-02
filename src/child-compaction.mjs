import { compileConversation, COMPILER_MARKER } from "./conversation-compiler/index.mjs";

export const CHILD_COMPACTION_POLICY = Object.freeze({
  auto: true,
  thresholdRatio: 0.8,
  retainTokens: 25_000,
  compactionRetries: 1,
  maxOverflowRetries: 1,
});

export const CHILD_COMPILER_IDENTITY = Object.freeze({
  provider: "qq-workflows",
  model: "child-conversation-compiler-v1",
});

function serviceOf(ctx, name) {
  try {
    const injected = ctx?.get?.(name, false);
    if (injected != null) return injected;
  } catch { /* direct fallback below */ }
  try { return ctx?.[name] ?? null; } catch { return null; }
}

function methodOf(ctx, name) {
  try { return typeof ctx?.[name] === "function" ? ctx[name] : null; } catch { return null; }
}

function messageOfEvent(event) {
  if (event?.type === "user/message") return event.data;
  if (event?.type === "assistant/message") return event.data?.message;
  if (event?.type === "tool/result") return event.data?.message;
  return null;
}

function textContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export function isPreviousCompiledCheckpoint(message) {
  return message?.role === "user"
    && message?.source?.kind === "plugin"
    && message.source.plugin === "compact"
    && textContent(message.content).includes(COMPILER_MARKER);
}

export function previousCompiledSummary(message) {
  if (!isPreviousCompiledCheckpoint(message)) return "";
  const text = textContent(message.content);
  const lines = text.slice(text.indexOf(COMPILER_MARKER)).replace(/\r\n/g, "\n").split("\n");
  const last = lines.findLastIndex((line) => line !== "");
  // BasicCompactionEngine owns this outer envelope. Remove only its closing tag
  // at the final logical position; identical user content inside the summary is
  // not a boundary.
  if (last >= 0 && lines[last] === "</compacted-summary>") lines.splice(last, 1);
  return lines.join("\n").trimEnd();
}

/** Map replayed DSH messages to their exact durable events by stable message id. */
export function adaptDshMessages(input, agent) {
  if (!input || !Array.isArray(input.messages)) throw new TypeError("child conversation compiler requires replayed messages");
  const events = agent?.session?.events;
  if (!Array.isArray(events)) throw new TypeError("child conversation compiler requires the owner session log");
  const byMessageId = new Map();
  const toolNameByCallId = new Map();
  for (const event of events) {
    if (event?.type === "tool/call") {
      const callId = event.data?.callId ?? event.data?.id;
      if (callId != null && typeof event.data?.name === "string") toolNameByCallId.set(callId, event.data.name);
    }
    const message = messageOfEvent(event);
    if (!message?.id || !Number.isSafeInteger(event?.seq)) continue;
    if (byMessageId.has(message.id)) throw new Error(`child conversation compiler found duplicate message id ${String(message.id)}`);
    byMessageId.set(message.id, event);
  }

  let previousSummary = "";
  const records = [];
  for (const message of input.messages) {
    const event = byMessageId.get(message?.id);
    if (!event) throw new Error(`child conversation compiler cannot resolve replayed message ${String(message?.id ?? "<missing-id>")} to an event seq`);
    if (isPreviousCompiledCheckpoint(message)) {
      previousSummary = previousCompiledSummary(message); // latest surface checkpoint wins
      continue;
    }
    let role;
    if (event.type === "assistant/message") role = "assistant";
    else if (event.type === "tool/result" || message.source?.kind === "tool") role = "tool-result";
    else if (event.type === "user/message") role = "user";
    else throw new Error(`child conversation compiler cannot adapt ${String(event.type)}`);
    const resultBlock = role === "tool-result"
      ? message.content?.find?.((block) => block?.type === "tool-result")
      : undefined;
    const callId = message.source?.callId ?? resultBlock?.toolCallId ?? resultBlock?.callId;
    records.push({
      seq: event.seq,
      role,
      content: message.content,
      source: message.source,
      ...(role === "tool-result" ? { toolName: toolNameByCallId.get(callId) ?? "" } : {}),
    });
  }
  return { records, previousSummary };
}

export function createChildCompactionEngineClass(BasicCompactionEngine) {
  if (typeof BasicCompactionEngine !== "function"
      || typeof BasicCompactionEngine.prototype?.compactIfNeeded !== "function"
      || typeof BasicCompactionEngine.prototype?.compactRegion !== "function") {
    throw new TypeError("child conversation compiler requires DSH BasicCompactionEngine");
  }
  return class ChildConversationCompactionEngine extends BasicCompactionEngine {
    /** The sole documented BasicCompactionEngine customization hook. */
    async summarize(input, agent, signal) {
      signal?.throwIfAborted?.();
      const { records, previousSummary } = adaptDshMessages(input, agent);
      const text = compileConversation(records, { previousSummary });
      signal?.throwIfAborted?.();
      return {
        summary: [{ type: "text", text }],
        provider: CHILD_COMPILER_IDENTITY.provider,
        model: CHILD_COMPILER_IDENTITY.model,
      };
    }
  };
}

/**
 * Mount the deterministic engine below one Agent scope. The unique compaction
 * isolation label protects the root `auto:false` service and makes HMR overlap
 * harmless; the nested plugin fiber owns service/listener teardown.
 */
export function installChildCompaction(agentCtx) {
  const inherited = serviceOf(agentCtx, "compaction");
  // Plain unit-test contexts intentionally omit host services. A real Cordis
  // Agent context has isolate/plugin and must fail closed if its base is wrong.
  const isolate = methodOf(agentCtx, "isolate");
  const plugin = methodOf(agentCtx, "plugin");
  if (!inherited && (!isolate || !plugin)) return () => {};
  if (!inherited) throw new Error("child conversation compiler requires the host BasicCompactionEngine");
  if (!isolate || !plugin) return () => {};

  const Engine = createChildCompactionEngineClass(inherited.constructor);
  const isolated = isolate.call(agentCtx, "compaction", Symbol("child-conversation-compiler"));
  const isolatedPlugin = methodOf(isolated, "plugin");
  if (!isolatedPlugin) throw new Error("child conversation compiler requires Cordis isolated plugin ownership");
  const fiber = isolatedPlugin.call(isolated, Engine, CHILD_COMPACTION_POLICY);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    return fiber?.dispose?.();
  };
  // Agent setup is allowed to await. Unit contexts remain synchronous, while
  // production publication waits for the nested engine's dependency injection.
  if (fiber && typeof fiber.then === "function") {
    dispose.ready = Promise.resolve(fiber).catch(async (error) => {
      await dispose();
      throw error;
    });
  }
  dispose.engineFiber = fiber;
  return dispose;
}

export const internals = Object.freeze({ messageOfEvent, textContent, serviceOf, methodOf });
