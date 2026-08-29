import { MINI_SWE_COMPLETION_COMMAND } from "./mini-swe-v2.mjs";

export const MINI_RESEARCH_SYSTEM_PROMPT = "You are a helpful assistant that can research questions using a computer.";

/** Render the dynamic instance data; the exact question already lives in question.md. */
export function renderMiniResearchTask() {
  return [
    "Please research the exact question in question.md.",
    "",
    "You can execute bash commands and edit answer.md to research the question.",
    "",
    "## Recommended Workflow",
    "",
    "This workflow should be done step-by-step so that you can iterate on your research and check the evidence behind the answer.",
    "",
    "1. Read question.md and inspect relevant repository files under repo/.",
    "2. Search for focused web and prior-session leads with web-search and session-search.",
    "3. Materialize every source you rely on with web-get or session-get, then inspect the immutable snapshot under evidence/.",
    "4. Seek contrary evidence for important conclusions and distinguish direct observation from inference.",
    "5. Write a direct answer to answer.md. Cite only acquired W### or S### refs and repo/ paths, and surface unresolved contradictions.",
    `6. Submit the answer and finish your work by issuing the following command: \`${MINI_SWE_COMPLETION_COMMAND}\`.`,
    "   Do not combine it with any other command. <important>After this command, you cannot continue working on this task.</important>",
    "",
    "## Command Execution Rules",
    "",
    "Every response must make at least one bash tool call. Invoke each host evidence command as a standalone bash command:",
    "",
    "```bash",
    "web-search 'query'",
    "web-get W001",
    "session-search 'phrase one' 'phrase two'",
    "session-get S001",
    "```",
    "",
    "Search results are leads, not evidence. Stop when additional retrieval is unlikely to change the answer.",
    "Mark strong evidence, weak evidence, and inference where that distinction matters.",
    `When answer.md is ready, issue \`${MINI_SWE_COMPLETION_COMMAND}\` alone.`,
  ].join("\n");
}

/** Fresh research QA gets pointers, never eager copies of capsule artifacts. */
export function renderMiniResearchReviewTask() {
  return [
    "Please review the proposed research answer using the exact capsule artifacts.",
    "",
    "Artifact pointers (relative to the capsule cwd):",
    "- Exact question: question.md",
    "- Proposed answer: answer.md",
    "- Acquired evidence manifest: evidence/manifest.jsonl",
    "- Evidence snapshots: evidence/",
    "- Repository context: repo/",
    "",
    "Read question.md, answer.md, and evidence/manifest.jsonl before deciding. Use ordinary bash in this capsule to inspect only question.md, answer.md, evidence/, and repo/. Do not request or perform new web or session retrieval.",
    "Find concrete answer defects: unsupported claims, citations that do not entail the claim, ignored contradictions, inference presented as fact, or conclusions stronger than the evidence.",
    "Report each defect at the relevant answer.md line. Submit only concrete defects; an empty findings array is valid.",
  ].join("\n");
}
