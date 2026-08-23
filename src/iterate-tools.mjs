// Iterate tools. Desk has journal + wiki + go. Hands have the frontend
// kind pack. Pixel tools never register on the desk.

import { formatProjection, projectJournal } from "./journal.mjs";
import { repoRootFor } from "./iterate.mjs";

const DESIGN_LOOP_URL = new URL("../../bin/lib/frontend-design-loop.mjs", import.meta.url);

function textBlock(text) {
  return { type: "text", text };
}

function refusal(reason) {
  return { status: "refused", reason };
}

function isOperatorUserMessage(event) {
  if (event?.type !== "user/message") return false;
  const source = event.data?.source;
  return !source || source.kind === "user";
}

function lastOperatorSeq(session) {
  const events = session?.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (isOperatorUserMessage(event) && Number.isSafeInteger(event.seq)) return event.seq;
  }
  return 0;
}

function seqOf(args, session) {
  return Number.isSafeInteger(args?.seq) ? args.seq : lastOperatorSeq(session);
}

function sessionIdOf(exec) {
  return exec?.agent?.session?.id ?? "";
}

export function buildDeskTools({ journal, wiki, go } = {}) {
  return [
    {
      name: "journal_record",
      description: "Record what the operator just said: a nit, praise, living directive, or living theory. Cite the operator turn. Do not send work.",
      parameters: {
        kind: {
          type: "string",
          required: true,
          description: "directive | theory | nit | praise",
        },
        text: {
          type: "string",
          required: true,
          description: "Short recorded text. Ambiguous input is still recorded as heard.",
        },
        seq: {
          type: "number",
          description: "DSH seq of the operator turn. Defaults to the latest operator message.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            status: { type: "string" },
            recorded: { type: "object", additionalProperties: true },
            reason: { type: "string" },
          },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Journal refused: ${value.reason}`)];
          const recorded = value.recorded ?? {};
          const kind = recorded.kind === "note" ? recorded.polarity : recorded.kind;
          return [textBlock(`recorded ${kind} ${recorded.id}: ${recorded.text}`)];
        },
      },
      async execute(args, exec) {
        try {
          const sessionId = sessionIdOf(exec);
          if (!sessionId) return refusal("journal_record requires a live session");
          const seq = seqOf(args, exec.agent?.session);
          const kind = String(args.kind ?? "").trim();
          const text = String(args.text ?? "");
          let recorded;
          if (kind === "directive") recorded = journal.recordDirective(sessionId, { text, seq });
          else if (kind === "theory") recorded = journal.recordTheory(sessionId, { text, seq });
          else if (kind === "nit" || kind === "praise") {
            recorded = journal.recordNote(sessionId, { polarity: kind, text, seq });
          } else {
            return refusal("journal_record kind must be directive, theory, nit, or praise");
          }
          return { status: "ok", recorded };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "journal_close",
      description: "Close a nit the operator took back. Review pass also closes; do not close on fail.",
      parameters: {
        target: {
          type: "string",
          required: true,
          description: "Note id (n1).",
        },
        reason: {
          type: "string",
          description: "Why it closed. Default operator.",
        },
        seq: { type: "number" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: { status: { type: "string" }, reason: { type: "string" } },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Close refused: ${value.reason}`)];
          return [textBlock(`closed ${value.closed?.target}`)];
        },
      },
      async execute(args, exec) {
        try {
          const sessionId = sessionIdOf(exec);
          if (!sessionId) return refusal("journal_close requires a live session");
          const closed = journal.closeNote(sessionId, {
            target: args.target,
            seq: seqOf(args, exec.agent?.session),
            reason: args.reason,
          });
          return { status: "ok", closed };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "journal_list",
      description: "Show the stable desk projection: directive, theory, open nits / praise, cheap wiki index. Not the whole wiki.",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: { status: { type: "string" }, projection: { type: "string" } },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Journal refused: ${value.reason}`)];
          return [textBlock(value.projection)];
        },
      },
      async execute(_args, exec) {
        try {
          const sessionId = sessionIdOf(exec);
          if (!sessionId) return refusal("journal_list requires a live session");
          const projection = formatProjection(journal.load(sessionId), wiki?.index(sessionId) ?? []);
          const proj = projectJournal(journal.load(sessionId));
          return {
            status: "ok",
            projection,
            journal: {
              ...proj,
              sent: Array.from(proj.sent ?? []),
            },
          };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "wiki_file",
      description: "File an unlabeled wiki node. Invent the label. Merge when two labels name the same thing.",
      parameters: {
        target: { type: "string", required: true, description: "Wiki node id (w1)." },
        labels: {
          type: "array",
          items: { type: "string" },
          required: true,
          description: "Desk-invented labels.",
        },
        seq: { type: "number" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: { status: { type: "string" }, reason: { type: "string" } },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Wiki refused: ${value.reason}`)];
          return [textBlock(`filed ${value.filed?.target} as ${(value.filed?.labels ?? []).join(", ")}`)];
        },
      },
      async execute(args, exec) {
        try {
          const sessionId = sessionIdOf(exec);
          if (!sessionId) return refusal("wiki_file requires a live session");
          const filed = wiki.file(sessionId, {
            target: args.target,
            labels: args.labels,
            seq: seqOf(args, exec.agent?.session),
          });
          return { status: "ok", filed };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "wiki_select",
      description: "Choose which filed wiki nodes the next hands packet gets. Missable on purpose.",
      parameters: {
        ids: {
          type: "array",
          items: { type: "string" },
          required: true,
          description: "Wiki node ids to include in the next packet.",
        },
        seq: { type: "number" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: { status: { type: "string" }, reason: { type: "string" } },
        },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Select refused: ${value.reason}`)];
          return [textBlock(`selected ${(value.selected?.ids ?? []).join(", ") || "(none)"}`)];
        },
      },
      async execute(args, exec) {
        try {
          const sessionId = sessionIdOf(exec);
          if (!sessionId) return refusal("wiki_select requires a live session");
          const selected = journal.selectWiki(sessionId, {
            ids: args.ids,
            seq: seqOf(args, exec.agent?.session),
          });
          return { status: "ok", selected };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "go",
      description: "Bundle this breath's nits into one fresh hands session. Call only when the operator says go / implement / go ahead. Refused without qq-relay. Praise-only is not work.",
      parameters: {
        justThese: {
          type: "boolean",
          description: "If true, send only this breath. Open pile from earlier turns stays.",
        },
        includeIds: {
          type: "array",
          items: { type: "string" },
          description: "Earlier open nits in the same area to include with this breath.",
        },
      },
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
          if (value.status === "refused") return [textBlock(`Go refused: ${value.reason}`)];
          const alias = value.alias ? ` alias ${value.alias}` : "";
          return [textBlock(`hands ${value.child}${alias} breath ${value.breath}`)];
        },
      },
      async execute(args, exec) {
        try {
          if (!go) return refusal("go is unavailable");
          return await go({
            agent: exec?.agent,
            justThese: args.justThese === true,
            includeIds: Array.isArray(args.includeIds) ? args.includeIds : [],
          });
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

function renderLoop(prefix, value) {
  if (value.status === "refused") return [textBlock(`${prefix} refused: ${value.reason}`)];
  return [textBlock(value.message ?? prefix)];
}

async function loadDesignLoop(injected) {
  if (injected) return injected;
  return import(DESIGN_LOOP_URL);
}

export function buildHandsTools({ designLoop, onDump } = {}) {
  async function run(name, fn, fallback) {
    try {
      const impl = await loadDesignLoop(designLoop);
      const result = await fn(impl);
      return { status: "ok", message: fallback(result), result };
    } catch (error) {
      return refusal(error instanceof Error ? error.message : String(error));
    }
  }

  return [
    {
      name: "design_loop_start",
      description: "Start the design loop with live CSS/JS assets and return the origin plus session URL.",
      parameters: { live: { type: "boolean" } },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => renderLoop("design_loop_start", value),
      },
      async execute(args, exec) {
        const cwd = exec?.agent?.session?.header?.cwd;
        const root = repoRootFor(cwd);
        return run("start", (impl) => impl.startFixture({
          root,
          live: args?.live !== false,
        }), (started) => `Design-loop fixture listening at ${started.origin}. Open ${started.sessionUrl}. Live assets: ${started.live ? "on" : "off"}.`);
      },
    },
    {
      name: "design_loop_capture",
      description: "Open a URL (the live product the nits are about, or a fixture), shoot desktop 1280x800 and Pixel 10 412x915 (optional 412x520 short), and measure default boxes. Then look at the PNGs.",
      parameters: {
        url: { type: "string", description: "Page to shoot. Live product or fixture. Required unless a fixture is already running." },
        label: { type: "string" },
        short: { type: "boolean" },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => renderLoop("design_loop_capture", value),
      },
      async execute(args) {
        return run("capture", async (impl) => {
          const { captureProduct } = await import(new URL("./live-capture.mjs", import.meta.url));
          return captureProduct({
            impl,
            url: typeof args?.url === "string" ? args.url : undefined,
            label: args?.label,
            short: args?.short === true,
          });
        }, (captured) => {
          const shotList = Object.entries(captured.shots ?? {}).map(([name, path]) => `${name}=${path}`).join(" ");
          return `Captured ${captured.label}: ${shotList}`;
        });
      },
    },
    {
      name: "design_loop_measure",
      description: "Read get box and get styles for console selectors on the dedicated design-loop browser session.",
      parameters: {
        selectors: { type: "array", items: { type: "string" } },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => renderLoop("design_loop_measure", value),
      },
      async execute(args) {
        return run("measure", (impl) => impl.measureBoxes({
          selectors: Array.isArray(args?.selectors) && args.selectors.length ? args.selectors : undefined,
        }), () => "Measured design-loop selectors.");
      },
    },
    {
      name: "design_loop_seed",
      description: "POST a sample prompt to the running design-loop fixture so user and assistant cards exist.",
      parameters: { prompt: { type: "string" } },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => renderLoop("design_loop_seed", value),
      },
      async execute(args) {
        return run("seed", (impl) => impl.seedPrompt({ prompt: args?.prompt }), (seeded) => `Seeded ${seeded.sessionId}.`);
      },
    },
    {
      name: "design_loop_stop",
      description: "Kill the fixture and close the dedicated agent-browser session.",
      parameters: {},
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => renderLoop("design_loop_stop", value),
      },
      async execute() {
        return run("stop", (impl) => impl.stopLoop(), (stopped) => `Design-loop stopped (fixture ${stopped.fixture}, browser ${stopped.browser}).`);
      },
    },
    {
      name: "wiki_dump",
      description: "Queue a short this-loop memory node. Filed only after review passes. No taxonomy.",
      parameters: {
        text: { type: "string", required: true, description: "Short note, maybe a selector or shot path." },
      },
      output: {
        schema: { type: "object", additionalProperties: true },
        render: (_args, value) => {
          if (value.status === "refused") return [textBlock(`Dump refused: ${value.reason}`)];
          return [textBlock("queued wiki node")];
        },
      },
      async execute(args, exec) {
        try {
          const text = String(args.text ?? "").trim();
          if (!text) return refusal("wiki_dump requires text");
          onDump?.({ text, sessionId: sessionIdOf(exec) });
          return { status: "ok", queued: text };
        } catch (error) {
          return refusal(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
}

export const DESK_TOOL_NAMES = Object.freeze([
  "journal_record",
  "journal_close",
  "journal_list",
  "wiki_file",
  "wiki_select",
  "go",
]);

export const HANDS_TOOL_NAMES = Object.freeze([
  "design_loop_start",
  "design_loop_capture",
  "design_loop_measure",
  "design_loop_seed",
  "design_loop_stop",
  "wiki_dump",
]);

export const PIXEL_TOOL_NAMES = Object.freeze([
  "design_loop_start",
  "design_loop_capture",
  "design_loop_measure",
  "design_loop_seed",
  "design_loop_stop",
]);

export const internals = Object.freeze({
  lastOperatorSeq,
  textBlock,
  refusal,
});
