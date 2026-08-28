export const MINI_REVIEW_SYSTEM_PROMPT = "You are a helpful assistant that can review code changes in a repository.";

export const MINI_REVIEW_KIND = "mini-review";
export const MINI_REVIEW_TOOL_NAMES = Object.freeze(["grep", "glob", "view", "submit_review"]);

// Host-owned limits. They intentionally do not appear in model-visible schemas.
export const MINI_REVIEW_GREP_LIMIT = 40;
export const MINI_REVIEW_GLOB_LIMIT = 100;
export const MINI_REVIEW_VIEW_LINE_LIMIT = 120;
export const MINI_REVIEW_VIEW_BYTE_LIMIT = 32 * 1024;

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const MINI_REVIEW_GREP_SCHEMA = deepFreeze({
  description: "Search tracked repository files for a literal substring.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", description: "Literal substring to find." },
      path: { type: "string", description: "Optional repository-relative file or directory to search." },
      side: { type: "string", enum: ["head", "base"], description: "Revision side to inspect. Defaults to head." },
    },
  },
});

export const MINI_REVIEW_GLOB_SCHEMA = deepFreeze({
  description: "Find tracked repository paths matching a filename pattern.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["pattern"],
    properties: {
      pattern: { type: "string", description: "Repository-relative pattern using *, ?, and **." },
      side: { type: "string", enum: ["head", "base"], description: "Revision side to inspect. Defaults to head." },
    },
  },
});

export const MINI_REVIEW_VIEW_SCHEMA = deepFreeze({
  description: "Read a bounded line range from a tracked repository file.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["path", "start_line", "end_line"],
    properties: {
      path: { type: "string", description: "Repository-relative file path." },
      start_line: { type: "integer", description: "First line to read, inclusive and one-based." },
      end_line: { type: "integer", description: "Last line to read, inclusive and one-based." },
      side: { type: "string", enum: ["head", "base"], description: "Revision side to inspect. Defaults to head." },
    },
  },
});

export const MINI_REVIEW_SUBMIT_SCHEMA = deepFreeze({
  description: "Submit the concrete defects introduced by this change. Submit an empty findings array when there are none.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["findings"],
    properties: {
      findings: {
        type: "array",
        description: "Defects introduced by the change.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "line", "body"],
          properties: {
            path: { type: "string", description: "Repository-relative changed file path." },
            line: { type: "integer", description: "HEAD-side changed line that demonstrates the defect." },
            body: { type: "string", description: "Concrete trigger and incorrect behavior." },
          },
        },
      },
    },
  },
});

export function renderMiniReviewTask({ task } = {}) {
  return [
    `Please review this change: ${String(task ?? "")}`,
    "",
    "The packet is a bounded work order: its brief, changed-file counts, and hunk pointers are starting points. Retrieve code with grep, glob, and view.",
    "",
    "Recommended Workflow",
    "",
    "1. Analyze the packet brief, files, and pointers to understand the intended change.",
    "2. Identify possible defects introduced by the change.",
    "3. For each possible defect, formulate the specific question that determines whether it is real.",
    "4. Inspect only the repository context needed to answer that question with grep, glob, or view.",
    "5. Discard the candidate unless the evidence establishes a concrete trigger and incorrect behavior caused by the change.",
    '6. Submit the remaining findings with "submit_review".',
    "",
    "Rules",
    "",
    "- Start from the packet. Do not explore the repository for general understanding.",
    '- When a location is unknown, narrow it with "grep" or "glob" before reading.',
    "- When a location is known, read only the smallest useful range with view.",
    "- Make independent searches or reads in parallel when possible.",
    "- Report only defects introduced by this change.",
    "- Do not report style, preferences, speculative risks, or optional improvements.",
    "- It is correct to report zero findings.",
    '- Finish with "submit_review".',
  ].join("\n");
}
