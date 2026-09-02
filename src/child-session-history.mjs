import { Buffer } from "node:buffer";

const TOOL_NAME = "session_history";
const EVENT_TYPES = Object.freeze(["user/message", "assistant/message", "tool/call", "tool/result"]);
const SURFACES = Object.freeze(["current", "shadowed"]);
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;
const MAX_QUERIES = 5;
const DEFAULT_CONTEXT_WINDOW = 3;
const MAX_CONTEXT_WINDOW = 12;
const RAW_CONTEXT_WINDOW = 50;
const MAX_QUERY_CHARS = 500;
const MAX_CURSOR_CHARS = 2_000;
const MAX_SNIPPET_CHARS = 320;
const MAX_EVENT_CHARS = 900;
const MAX_CONTEXT_TEXT_CHARS = 11_000;
const MAX_CONTEXT_OUTPUT_BYTES = 16 * 1024;
const TRUNCATION = " [truncated]";
const COMPILER_MARKER = "<!-- child-conversation-compiler:v1 -->";
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CHILD_SESSION_HISTORY_INSTRUCTIONS = [
  "Compacted current-session history remains available through the read-only `session_history` action.",
  "Treat the compacted checkpoint as an overview. When needed context is omitted, search with 1–5 distinctive literal words or phrases; results preserve DSH's ranking separately for each clue.",
  "Expand a promising exact `seq` with `context` and a small before/after window. The session is always this child and cannot be changed.",
  "After reconstructing intent, verify referenced files and current workspace state before acting because transcript state can be stale.",
].join("\n");

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function rejectUnknown(args, allowed, action) {
  const unexpected = Object.keys(args).find((key) => !allowed.has(key));
  if (unexpected) throw new TypeError(`${TOOL_NAME} ${action} does not accept ${unexpected}`);
}

function queriesOf(value) {
  if (!Array.isArray(value)) throw new TypeError(`${TOOL_NAME} search requires a queries array`);
  const seen = new Set();
  const queries = [];
  for (const item of value) {
    if (typeof item !== "string") throw new TypeError(`${TOOL_NAME} query clues must be strings`);
    const query = item.replaceAll(/\s+/g, " ").trim();
    if (!query) continue;
    if (query.length > MAX_QUERY_CHARS) throw new TypeError(`${TOOL_NAME} query exceeds ${MAX_QUERY_CHARS} characters`);
    const key = query.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  if (queries.length < 1 || queries.length > MAX_QUERIES) {
    throw new TypeError(`${TOOL_NAME} queries must contain 1 to 5 unique non-empty literal clues`);
  }
  return queries;
}

function integer(name, value, fallback, max) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 0 || resolved > max) {
    throw new TypeError(`${TOOL_NAME} ${name} must be an integer between 0 and ${max}`);
  }
  return resolved;
}

function searchLimit(value) {
  const limit = value ?? DEFAULT_SEARCH_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new TypeError(`${TOOL_NAME} limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}`);
  }
  return limit;
}

function cursorOf(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_CURSOR_CHARS) {
    throw new TypeError(`${TOOL_NAME} cursor must be a non-empty bounded string`);
  }
  return value;
}

function sessionIdOf(agent) {
  const id = agent?.session?.id;
  if (typeof id !== "string" || !SESSION_ID.test(id)) throw new Error(`${TOOL_NAME} requires a canonical current child session`);
  return id;
}

function responseSessionId(response) {
  return response?.session?.id ?? response?.session?.header?.id ?? response?.sessionId;
}

function assertPinned(response, sessionId, operation) {
  if (responseSessionId(response) !== sessionId) throw new Error(`${TOOL_NAME} ${operation} refused a cross-session response`);
}

function blocksOfEvent(event) {
  if (event?.type === "user/message") return event.data?.content;
  if (event?.type === "assistant/message") return event.data?.message?.content;
  if (event?.type === "tool/result") return event.data?.message?.content;
  return [];
}

function callIdOf(block) {
  return block?.id ?? block?.callId;
}

function historyCallIds(events) {
  const result = new Set();
  for (const event of events ?? []) {
    if (event?.type === "assistant/message") {
      for (const block of blocksOfEvent(event) ?? []) {
        if (block?.type === "tool-call" && block.name === TOOL_NAME && callIdOf(block) != null) result.add(callIdOf(block));
      }
    } else if (event?.type === "tool/call" && event.data?.name === TOOL_NAME) {
      const id = event.data?.callId ?? event.data?.id;
      if (id != null) result.add(id);
    }
  }
  return result;
}

function isHistoryFeedback(event, events, knownCallIds) {
  if (!event) return false;
  const ids = knownCallIds ?? historyCallIds(events);
  if (event.type === "assistant/message") {
    return (blocksOfEvent(event) ?? []).some((block) => block?.type === "tool-call" && block.name === TOOL_NAME);
  }
  if (event.type === "tool/call") return event.data?.name === TOOL_NAME || ids.has(event.data?.callId ?? event.data?.id);
  if (event.type === "tool/result") {
    const sourceId = event.data?.message?.source?.callId;
    if (ids.has(sourceId)) return true;
    return (blocksOfEvent(event) ?? []).some((block) => block?.type === "tool-result" && ids.has(block.toolCallId ?? block.callId));
  }
  if (event.type === "user/message") {
    const source = event.data?.source;
    return source?.kind === "plugin" && source.plugin === "compact"
      && contentText(event.data?.content).includes(COMPILER_MARKER);
  }
  return false;
}

function localEvent(agent, seq) {
  const event = agent?.session?.events?.[seq];
  return event?.seq === seq ? event : undefined;
}

function feedbackSeq(agent, seq, knownCallIds) {
  return isHistoryFeedback(localEvent(agent, seq), agent?.session?.events, knownCallIds);
}

function plain(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value ?? ""); }
}

function blockText(block) {
  if (block?.type === "text") return typeof block.text === "string" ? [block.text] : [];
  if (block?.type === "reasoning") return [];
  if (block?.type === "tool-call") return [`${block.name}(${plain(block.arguments)})`];
  if (block?.type === "tool-result" && Array.isArray(block.content)) return block.content.flatMap(blockText);
  return [];
}

function contentText(content) {
  return Array.isArray(content)
    ? content.flatMap(blockText).map((part) => part.trim()).filter(Boolean).join("\n")
    : "";
}

function semanticEvent(event) {
  if (event?.type === "user/message") return { role: "user", text: contentText(event.data?.content) };
  if (event?.type === "assistant/message") return { role: "assistant", text: contentText(event.data?.message?.content) };
  if (event?.type === "tool/call") return {
    role: "tool-call",
    text: `${String(event.data?.name ?? "tool")}(${plain(event.data?.arguments)})`,
  };
  if (event?.type === "tool/result") return { role: "tool-result", text: contentText(event.data?.message?.content) };
  return null;
}

function compact(value, max = MAX_EVENT_CHARS) {
  const text = String(value ?? "").replaceAll(/\s+/g, " ").trim();
  if (text.length <= max) return { text, truncated: false };
  if (max <= TRUNCATION.length) return { text: text.slice(0, Math.max(0, max)), truncated: true };
  const room = max - TRUNCATION.length;
  return { text: `${text.slice(0, room)}${TRUNCATION}`, truncated: true };
}

function roleForType(type) {
  if (type === "user/message") return "user";
  if (type === "assistant/message") return "assistant";
  if (type === "tool/call") return "tool-call";
  if (type === "tool/result") return "tool-result";
  throw new Error(`${TOOL_NAME} refused unsupported event type ${String(type)}`);
}

function iso(value) {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : String(value ?? "");
}

function bytes(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function enforceContextCeiling(result) {
  while (bytes(result) > MAX_CONTEXT_OUTPUT_BYTES) {
    const reducible = result.events
      .filter((event) => event.text.length > 32)
      .sort((left, right) => right.text.length - left.text.length || Math.abs(right.seq - result.targetSeq) - Math.abs(left.seq - result.targetSeq));
    if (reducible.length === 0) throw new Error(`${TOOL_NAME} could not satisfy its fixed context output ceiling`);
    const event = reducible[0];
    event.text = compact(event.text, Math.max(32, Math.floor(event.text.length * 0.75))).text;
    event.truncated = true;
    result.truncated = true;
  }
}

function filters() {
  return [
    { kind: "type", values: [...EVENT_TYPES] },
    { kind: "surface", values: [...SURFACES] },
  ];
}

export function createChildSessionHistoryAdapter(sessionQuery, agent) {
  if (!sessionQuery || typeof sessionQuery.searchEvents !== "function"
      || typeof sessionQuery.readEvent !== "function" || typeof sessionQuery.traceEvent !== "function") {
    throw new Error(`${TOOL_NAME} requires DSH sessionQuery searchEvents/readEvent/traceEvent`);
  }
  const sessionId = sessionIdOf(agent);
  let disposed = false;
  const live = () => {
    if (disposed) throw new Error(`${TOOL_NAME} adapter is disposed`);
    if (sessionIdOf(agent) !== sessionId) throw new Error(`${TOOL_NAME} child session identity changed`);
  };

  async function search(input, exec = {}) {
    live();
    const args = object(input, `${TOOL_NAME} search input`);
    rejectUnknown(args, new Set(["action", "queries", "limit", "cursor"]), "search");
    const queries = queriesOf(args.queries);
    const limit = searchLimit(args.limit);
    const cursor = cursorOf(args.cursor);
    if (cursor !== undefined && queries.length !== 1) throw new TypeError(`${TOOL_NAME} continuation requires exactly one query`);
    exec.signal?.throwIfAborted?.();
    const feedbackIds = historyCallIds(agent?.session?.events);
    const pages = await Promise.all(queries.map(async (query) => {
      const page = await sessionQuery.searchEvents({
        sessionId,
        query,
        filters: filters(),
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      }, { signal: exec.signal });
      exec.signal?.throwIfAborted?.();
      assertPinned(page, sessionId, "search");
      if (!Array.isArray(page.items) || page.items.length > limit) {
        throw new Error(`${TOOL_NAME} search received an invalid or oversized backend page`);
      }
      if (page.nextCursor !== undefined) cursorOf(page.nextCursor);
      const events = [];
      for (const hit of page.items) {
        if (hit?.sessionId !== sessionId) throw new Error(`${TOOL_NAME} search refused a cross-session hit`);
        if (!Number.isSafeInteger(hit.seq) || !EVENT_TYPES.includes(hit.type) || !SURFACES.includes(hit.surface)) {
          throw new Error(`${TOOL_NAME} search received a malformed or unauthorized hit`);
        }
        if (feedbackSeq(agent, hit.seq, feedbackIds)) continue;
        events.push({
          seq: hit.seq,
          time: iso(hit.time),
          role: roleForType(hit.type),
          surface: hit.surface,
          snippet: compact(hit.snippet, MAX_SNIPPET_CHARS).text,
        });
      }
      return {
        query,
        events,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      };
    }));
    return { action: "search", results: pages };
  }

  async function trace(seq, signal) {
    const observation = await sessionQuery.traceEvent({ sessionId, seq }, signal);
    signal?.throwIfAborted?.();
    assertPinned(observation, sessionId, "context trace");
    const target = observation?.target;
    if (target?.sessionId !== sessionId || target.seq !== seq) throw new Error(`${TOOL_NAME} trace returned the wrong event`);
    return target;
  }

  async function context(input, exec = {}) {
    live();
    const args = object(input, `${TOOL_NAME} context input`);
    rejectUnknown(args, new Set(["action", "seq", "before", "after"]), "context");
    const seq = args.seq;
    if (!Number.isSafeInteger(seq) || seq < 0) throw new TypeError(`${TOOL_NAME} seq must be a non-negative safe integer`);
    const before = integer("before", args.before, DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
    const after = integer("after", args.after, DEFAULT_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
    const feedbackIds = historyCallIds(agent?.session?.events);
    const targetTrace = await trace(seq, exec.signal);
    if (!SURFACES.includes(targetTrace.surface)) throw new Error(`${TOOL_NAME} target #${seq} is not current or shadowed`);
    if (!EVENT_TYPES.includes(targetTrace.type)) throw new Error(`${TOOL_NAME} target #${seq} has no supported semantic context`);
    if (feedbackSeq(agent, seq, feedbackIds)) throw new Error(`${TOOL_NAME} target #${seq} is session_history feedback`);

    const observation = await sessionQuery.readEvent({
      sessionId,
      seq,
      before: RAW_CONTEXT_WINDOW,
      after: RAW_CONTEXT_WINDOW,
    }, exec.signal);
    exec.signal?.throwIfAborted?.();
    assertPinned(observation, sessionId, "context read");
    if (observation?.target?.seq !== seq || observation.target.type !== targetTrace.type) {
      throw new Error(`${TOOL_NAME} context target changed during exact read`);
    }

    const candidates = (observation.events ?? []).filter((event) => EVENT_TYPES.includes(event?.type)
      && !isHistoryFeedback(event, agent?.session?.events, feedbackIds));
    const traced = await Promise.all(candidates.map(async (event) => ({ event, record: await trace(event.seq, exec.signal) })));
    const projected = [];
    for (const { event, record } of traced) {
      if (!SURFACES.includes(record.surface) || record.type !== event.type) continue;
      const semantic = semanticEvent(event);
      if (!semantic?.text.trim()) continue;
      const bounded = compact(semantic.text);
      projected.push({
        seq: event.seq,
        time: iso(event.time),
        role: semantic.role,
        text: bounded.text,
        ...(bounded.truncated ? { truncated: true } : {}),
      });
    }
    const target = projected.find((event) => event.seq === seq);
    if (!target) throw new Error(`${TOOL_NAME} target #${seq} has no presentable semantic context`);
    const selectedBefore = projected.filter((event) => event.seq < seq).slice(-before);
    const selectedAfter = projected.filter((event) => event.seq > seq).slice(0, after);
    const selected = [...selectedBefore, target, ...selectedAfter];
    target.target = true;

    let remaining = MAX_CONTEXT_TEXT_CHARS;
    for (const event of [...selected].sort((left, right) => Math.abs(left.seq - seq) - Math.abs(right.seq - seq))) {
      const bounded = compact(event.text, Math.max(1, Math.min(MAX_EVENT_CHARS, remaining)));
      event.text = bounded.text;
      if (bounded.truncated) event.truncated = true;
      remaining = Math.max(0, remaining - event.text.length);
    }
    const result = {
      action: "context",
      targetSeq: seq,
      requested: { before, after },
      events: selected,
      truncated: selected.some((event) => event.truncated === true)
        || (before > selectedBefore.length && observation.startSeq > 0)
        || (after > selectedAfter.length && observation.endSeq < (agent.session.events.length - 1)),
    };
    enforceContextCeiling(result);
    return result;
  }

  async function execute(input, exec = {}) {
    const args = object(input, `${TOOL_NAME} input`);
    if (args.action === "search") return search(args, exec);
    if (args.action === "context") return context(args, exec);
    throw new TypeError(`${TOOL_NAME} action must be "search" or "context"`);
  }

  return Object.freeze({ search, context, execute, dispose() { disposed = true; } });
}

function render(_args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

export function sessionHistoryToolDefinition(invoke) {
  return {
    name: TOOL_NAME,
    description: "Search compacted current-child history with literal clues, then expand one exact role-labeled event neighborhood. Read-only; the session is fixed and cannot be widened.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["search", "context"], description: "Search for clues or expand exact context." },
        queries: { type: "array", minItems: 1, maxItems: MAX_QUERIES, items: { type: "string" }, description: "For search: 1–5 literal words or phrases." },
        limit: { type: "integer", minimum: 1, maximum: MAX_SEARCH_LIMIT, description: "For search: events per independently ranked clue page." },
        cursor: { type: "string", description: "For one-query search: backend continuation from the identical prior clue." },
        seq: { type: "integer", minimum: 0, description: "For context: exact event sequence from a search result or checkpoint." },
        before: { type: "integer", minimum: 0, maximum: MAX_CONTEXT_WINDOW, description: "For context: preceding semantic events." },
        after: { type: "integer", minimum: 0, maximum: MAX_CONTEXT_WINDOW, description: "For context: following semantic events." },
      },
    },
    output: { schema: { type: "object", additionalProperties: true, properties: {} }, render },
    async execute(args, exec) { return invoke(args, exec); },
    presentCall(args) {
      return {
        card: "generic",
        title: args.action === "context" ? "Inspect current-session history" : "Search current-session history",
        kind: "read",
        rawInput: args.action === "context" ? `#${args.seq ?? ""}` : (args.queries ?? []).join(" | "),
      };
    },
  };
}

function serviceOf(ctx, name) {
  try {
    const injected = ctx?.get?.(name, false);
    if (injected != null) return injected;
  } catch { /* direct fallback below */ }
  try { return ctx?.[name] ?? null; } catch { return null; }
}

/** Register one HMR-owned, agent-local presentation adapter when DSH exposes sessionQuery. */
export function installChildSessionHistory(agentCtx) {
  const sessionQuery = serviceOf(agentCtx, "sessionQuery");
  const tools = serviceOf(agentCtx, "tools");
  const agent = agentCtx?.agent;
  if (!sessionQuery) return () => {}; // Standalone unit contexts do not carry the production backend.
  if (!tools || typeof tools.register !== "function") throw new Error(`${TOOL_NAME} requires child tools.register`);
  const adapter = createChildSessionHistoryAdapter(sessionQuery, agent);
  let unregister;
  try {
    unregister = tools.register(sessionHistoryToolDefinition((args, exec) => adapter.execute(args, exec)));
  } catch (error) {
    adapter.dispose();
    throw error;
  }
  return () => {
    try { unregister?.(); } finally { adapter.dispose(); }
  };
}

export const internals = Object.freeze({
  EVENT_TYPES,
  SURFACES,
  MAX_QUERIES,
  MAX_SEARCH_LIMIT,
  MAX_CONTEXT_WINDOW,
  RAW_CONTEXT_WINDOW,
  MAX_EVENT_CHARS,
  MAX_CONTEXT_TEXT_CHARS,
  MAX_CONTEXT_OUTPUT_BYTES,
  contentText,
  isHistoryFeedback,
  semanticEvent,
});
