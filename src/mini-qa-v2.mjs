export const MINI_QA_SYSTEM_PROMPT = "You are a helpful assistant that can review code changes in a repository.";

export const MINI_QA_KIND = "mini-qa";
export const LEGACY_MINI_QA_KIND = "mini-review";
export const MINI_QA_TOOL_NAMES = Object.freeze(["bash", "submit_review"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

export const MINI_QA_SUBMIT_SCHEMA = deepFreeze({
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

export function renderMiniQaTask({ task } = {}) {
  return [
    `Please review this change: ${String(task ?? "")}`,
    "",
    "The task artifact and bounded proposal packet are the starting point: changed-file counts and hunk pointers identify the change without inlining diffs. The phase delta names the base and head revisions.",
    "",
    "Recommended Workflow",
    "",
    "1. Read the exact task artifact, then analyze the packet files and pointers to understand the intended change.",
    "2. Identify possible defects introduced by the change.",
    "3. For each possible defect, formulate the specific question that determines whether it is real.",
    "4. Use bash to inspect only the repository context needed to answer that question. Useful commands include git diff, git show, git grep, rg, and sed -n; use the packet's base and head revisions.",
    "5. Discard the candidate unless the evidence establishes a concrete trigger and incorrect behavior caused by the change.",
    '6. Submit the remaining findings with "submit_review". An empty findings array is a pass.',
    "",
    "Rules",
    "",
    "- Start from the packet. Do not explore the repository for general understanding.",
    "- Report only defects introduced by this change.",
    "- Do not report style, preferences, speculative risks, or optional improvements.",
    "- Do not edit files, commit, or otherwise change the worktree.",
    "- Do not run the Mini completion command.",
    "- Every response must call bash or submit_review.",
    "- It is correct to report zero findings.",
    '- Finish with "submit_review".',
  ].join("\n");
}
