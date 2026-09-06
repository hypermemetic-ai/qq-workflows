import { ZVEC_GREP_RG, ZVEC_GREP_SEARCH } from "./zg-tools.mjs";

export const TICKET_WRITE = Object.freeze({
  name: "ticket_write",
  description:
    "Only `.architect/ticket.md`. If missing, create from template, then apply. `text` whole file OR `old_string`/`new_string`/`replace_all`. Returns the file.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      text: { type: "string", description: "Replace the whole ticket file." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every old_string match." },
    }),
  }),
});

export const TICKET_READ = Object.freeze({
  name: "ticket_read",
  description: "Same path, same create-from-template. Returns the file.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({}),
  }),
});

export const TEACHER = Object.freeze({
  name: "teacher",
  description:
    "Start the teacher. Required: parked_question (the live question they cannot convincingly answer), direction (minimal context so the teacher teaches the right lesson), informed_enough (what an informed opinion on the question looks like).",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      parked_question: { type: "string", description: "The live question they cannot convincingly answer." },
      direction: { type: "string", description: "Minimal context so the teacher teaches the right lesson." },
      informed_enough: { type: "string", description: "What an informed opinion on the question looks like." },
    }),
    required: Object.freeze(["parked_question", "direction", "informed_enough"]),
  }),
});

export const DONE = Object.freeze({
  name: "done",
  description: "Finished.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      answer: { type: "string", description: "Teacher or researcher answer." },
      findings: {
        type: "array",
        description: "Reviewer verdict. Empty array passes. Each item: path, line, body.",
        items: Object.freeze({
          type: "object",
          properties: Object.freeze({
            path: { type: "string" },
            line: { type: "integer" },
            body: { type: "string" },
          }),
          required: Object.freeze(["path", "line", "body"]),
        }),
      },
    }),
  }),
});

export const DELEGATE = Object.freeze({
  name: "delegate",
  description: "Start implementer or researcher. If implementer, required kind: bounded or open.",
  parameters: Object.freeze({
    type: "object",
    properties: Object.freeze({
      to: { type: "string", enum: Object.freeze(["implementer", "researcher"]) },
      kind: { type: "string", enum: Object.freeze(["bounded", "open"]) },
      question: { type: "string", description: "Researcher question." },
    }),
    required: Object.freeze(["to"]),
  }),
});

export function toResponsesFunction(tool) {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters ?? tool.inputSchema ?? { type: "object", properties: {} },
  };
}

export function architectTools() {
  return [
    TICKET_WRITE,
    TEACHER,
    DELEGATE,
    {
      name: ZVEC_GREP_SEARCH.name,
      description: ZVEC_GREP_SEARCH.description,
      parameters: ZVEC_GREP_SEARCH.inputSchema,
    },
    {
      name: ZVEC_GREP_RG.name,
      description: ZVEC_GREP_RG.description,
      parameters: ZVEC_GREP_RG.inputSchema,
    },
  ];
}

export function teacherTools() {
  return [TICKET_READ, TICKET_WRITE, DONE, ZVEC_GREP_SEARCH, ZVEC_GREP_RG];
}

export function researcherTools() {
  return [
    {
      name: "brave_search",
      description: "Lexical web search via Brave. Use for names, docs, APIs, exact phrases.",
    },
    {
      name: "exa_search",
      description: "Semantic web search via Exa. Use when you know the meaning but not the wording.",
    },
    {
      name: "visit_webpage",
      description: "Fetch a URL as text.",
    },
    ZVEC_GREP_SEARCH,
    ZVEC_GREP_RG,
    DONE,
  ];
}

export function implementerTools() {
  return [DONE];
}

export function reviewerTools() {
  return [DONE];
}

export function validateTeacherArgs(input) {
  const parked_question = String(input?.parked_question ?? "").trim();
  const direction = String(input?.direction ?? "").trim();
  const informed_enough = String(input?.informed_enough ?? "").trim();
  if (!parked_question || !direction || !informed_enough) {
    throw new Error("teacher requires parked_question, direction, and informed_enough");
  }
  return { parked_question, direction, informed_enough };
}

export function teacherFirstUserMessage(args) {
  const { parked_question, direction, informed_enough } = validateTeacherArgs(args);
  return [
    `parked_question: ${parked_question}`,
    `direction: ${direction}`,
    `informed_enough: ${informed_enough}`,
  ].join("\n");
}

export function validateDelegateArgs(input, ticketKind) {
  const to = String(input?.to ?? "").trim();
  if (to !== "implementer" && to !== "researcher") {
    throw new Error("delegate to must be implementer or researcher");
  }
  if (to === "implementer") {
    const kind = String(input?.kind ?? "").trim();
    if (kind !== "bounded" && kind !== "open") {
      throw new Error("delegate implementer requires kind bounded or open");
    }
    if (ticketKind && kind !== ticketKind) {
      throw new Error(`delegate kind ${kind} does not match ticket kind ${ticketKind}`);
    }
    return { to, kind };
  }
  const question = String(input?.question ?? "").trim();
  if (!question) throw new Error("delegate researcher requires question");
  return { to, question };
}
