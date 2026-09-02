export const COMPILER_MARKER = "<!-- child-conversation-compiler:v1 -->";
export const USER_WORD_BUDGET = 256;
export const ASSISTANT_HEAD_WORDS = 80;
export const ASSISTANT_TAIL_WORDS = 120;
export const CLOSING_ASSISTANT_HEAD_WORDS = 120;
export const CLOSING_ASSISTANT_TAIL_WORDS = 120;
export const BASH_WORD_BUDGET = 240;
export const MAX_TOOL_CALLS = 8;
export const WRAP_COLUMNS = 120;
export const MAX_BLOCKS = 80;
export const RECENT_BLOCKS = 16;
export const MIN_BUDGET_TOKENS = 1_100;
export const MAX_BUDGET_TOKENS = 2_000;
export const TOKENS_PER_BLOCK = 15;
export const CHARS_PER_TOKEN = 4;
export const GOAL_CAP = 8;
export const COMMIT_CAP = 8;
export const FILE_CAP = 16;
export const PREFERENCE_CAP = 8;

export const RECALL_NOTE = [
  "> For omitted history: search `session_history` with 1–5 literal clues, expand a matching `seq` with `context`,",
  "> then verify referenced files/current state before acting.",
].join("\n");
