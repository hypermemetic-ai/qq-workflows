// Talking-architect tools: notes_list, notes_expand, session_search, invoke,
// and rundown when qq-tasks is loaded. Invocation is these tools. There is
// no run_workflow(name) dispatcher.

import { randomUUID } from "node:crypto";

function textBlock(text) {
  return { type: "text", text };
}

function refusal(reason) {
  return { status: "refused", reason };
}

function formatNotebook(notebook) {
  if (!notebook?.cards?.length) return "(empty notebook)";
  return notebook.cards.map((card) => {
    const flag = card.open ? "open" : "closed";
    const notes = card.notes.length === 0
      ? "  (no notes)"
      : card.notes.map((note) => `  - ${note.text} [${note.startSeq}-${note.endSeq}]`).join("\n");
    const stubs = (card.stubs ?? []).length === 0
      ? ""
      : `\n  stubs:\n${card.stubs.map((stub) => `  - [${stub.startSeq}-${stub.endSeq}] ${stub.text}`).join("\n")}`;
    return `card ${card.name} (${flag})\n${notes}${stubs}`;
  }).join("\n\n");
}

function eventPayload(event) {
  return {
    seq: event.seq,
    type: event.type,
    time: event.time,
    data: event.data,
  };
}

async function expandSeqs({ sessionQuery, session, seqs, before = 0, after = 0 }) {
  const windows = [];
  for (const seq of seqs) {
    if (sessionQuery && typeof sessionQuery.readEvent === "function") {
      try {
        const window = await sessionQuery.readEvent({
          sessionId: session.id,
          seq,
          before,
          after,
        });
        windows.push({
          seq,
          target: eventPayload(window.target),
          events: (window.events ?? []).map(eventPayload),
        });
        continue;
      } catch {
        // Fall through to the live log.
      }
    }
    const events = session.events ?? [];
    const index = events.findIndex((event) => event.seq === seq);
    if (index < 0) {
      windows.push({ seq, missing: true });
      continue;
    }
    const start = Math.max(0, index - before);
    const end = Math.min(events.length, index + 1 + after);
    windows.push({
      seq,
      target: eventPayload(events[index]),
      events: events.slice(start, end).map(eventPayload),
    });
  }
  return windows;
}

function buildRundownTool(tasks) {
  return {
    name: "rundown",
    description: "Report on the live task pile: what is on it, when it landed, what looks stale, what contradicts. Not a raw file listing. Not a judgment — operator and architect judge the report.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: {
          status: { type: "string" },
          report: { type: "string" },
          reason: { type: "string" },
        },
      },
      render: (_args, value) => {
        if (value.status === "refused") return [textBlock(`Rundown refused: ${value.reason}`)];
        return [textBlock(value.report || "(empty pile)")];
      },
    },
    async execute() {
      try {
        if (!tasks || typeof tasks.rundown !== "function") {
          return refusal("rundown requires qq-tasks");
        }
        const report = await tasks.rundown();
        return { status: "ok", report };
      } catch (error) {
        return refusal(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

export function buildArchitectTools({ store, sessionQuery, invoke, tasks } = {}) {
  const tools = [
    {
      name: "notes_list",
      description: "List the architect notebook for this session: cards, short notes with seq citations, and any frozen fold stubs. Cheap. Use this before asking to expand a citation.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            status: { type: "string" },
            notebook: { type: "object", additionalProperties: true },
            reason: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Notes refused: ${value.reason}`)];
          return [textBlock(formatNotebook(value.notebook))];
        },
      },
      async execute(_args, exec) {
        try {
          const sessionId = exec?.agent?.session?.id;
          if (!sessionId) return refusal("notes_list requires a live session");
          return { status: "ok", notebook: store.load(sessionId) };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "notes_expand",
      description: "Read the DSH events cited by notebook notes. Pass startSeq/endSeq or a list of seqs. Uses sessionQuery.readEvent when present; otherwise reads the live session log by seq. Small window only.",
      parameters: {
        seqs: {
          type: "array",
          items: { type: "number" },
          description: "Explicit seqs to expand.",
        },
        startSeq: {
          type: "number",
          description: "Inclusive start of a citation span when seqs is omitted.",
        },
        endSeq: {
          type: "number",
          description: "Inclusive end of a citation span when seqs is omitted.",
        },
        before: {
          type: "number",
          description: "Raw events before each target (small window; default 0).",
        },
        after: {
          type: "number",
          description: "Raw events after each target (small window; default 0).",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            status: { type: "string" },
            windows: { type: "array", items: { type: "object", additionalProperties: true } },
            reason: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Expand refused: ${value.reason}`)];
          const windows = Array.isArray(value.windows) ? value.windows : [];
          if (windows.length === 0) return [textBlock("No cited events.")];
          return [textBlock(windows.map((window) => {
            if (window.missing) return `seq ${window.seq}: missing`;
            return `seq ${window.seq} ${window.target?.type ?? ""}`;
          }).join("\n"))];
        },
      },
      async execute(args, exec) {
        try {
          const session = exec?.agent?.session;
          if (!session?.id) return refusal("notes_expand requires a live session");
          let seqs = Array.isArray(args.seqs) ? args.seqs.filter((seq) => Number.isSafeInteger(seq)) : [];
          if (seqs.length === 0 && Number.isSafeInteger(args.startSeq) && Number.isSafeInteger(args.endSeq)) {
            for (let seq = args.startSeq; seq <= args.endSeq; seq += 1) seqs.push(seq);
          }
          if (seqs.length === 0) return refusal("notes_expand requires seqs or startSeq/endSeq");
          if (seqs.length > 32) seqs = seqs.slice(0, 32);
          const windows = await expandSeqs({
            sessionQuery,
            session,
            seqs,
            before: Number.isSafeInteger(args.before) ? Math.min(8, Math.max(0, args.before)) : 0,
            after: Number.isSafeInteger(args.after) ? Math.min(8, Math.max(0, args.after)) : 0,
          });
          return { status: "ok", windows };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "session_search",
      description: "Search this session's events only when nothing in the notes names the thing. Wraps sessionQuery.searchEvents when present. Do not use this as a notebook dump.",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "Literal search text.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            status: { type: "string" },
            hits: { type: "array", items: { type: "object", additionalProperties: true } },
            reason: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Search refused: ${value.reason}`)];
          const hits = Array.isArray(value.hits) ? value.hits : [];
          if (hits.length === 0) return [textBlock("No matching events.")];
          return [textBlock(hits.map((hit) => `${hit.seq ?? "?"} ${hit.snippet ?? hit.type ?? ""}`).join("\n"))];
        },
      },
      async execute(args, exec) {
        try {
          const sessionId = exec?.agent?.session?.id;
          if (!sessionId) return refusal("session_search requires a live session");
          if (typeof args.query !== "string" || args.query.trim().length === 0) {
            return refusal("session_search requires a query");
          }
          if (!sessionQuery || typeof sessionQuery.searchEvents !== "function") {
            return refusal("session_search requires sessionQuery.searchEvents");
          }
          const page = await sessionQuery.searchEvents({
            sessionId,
            query: args.query,
            limit: 16,
          });
          const hits = (page?.hits ?? page?.events ?? []).map((hit) => ({
            seq: hit.seq ?? hit.target?.seq,
            type: hit.type ?? hit.target?.type,
            snippet: hit.snippet ?? "",
          }));
          return { status: "ok", hits };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "invoke",
      description: "Keep talking and start one live child session from the notebook plus the DSH log. You do not compile the packet. Results come back through qq-relay default steer. Refused when qq-relay is not loaded.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            status: { type: "string" },
            child: { type: "string" },
            alias: { type: "string" },
            reason: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Invoke refused: ${value.reason}`)];
          const alias = value.alias ? ` alias ${value.alias}` : "";
          return [textBlock(`invoked ${value.child}${alias}`)];
        },
      },
      async execute(_args, exec) {
        try {
          if (!invoke) return refusal("invoke is unavailable");
          return await invoke({ agent: exec?.agent });
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
  if (tasks && typeof tasks.rundown === "function") tools.push(buildRundownTool(tasks));
  return tools;
}

export function pluginUserMessage(text, form = "notice") {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "qq-workflows", form },
  };
}

export const internals = Object.freeze({
  formatNotebook,
  expandSeqs,
  textBlock,
  refusal,
});
