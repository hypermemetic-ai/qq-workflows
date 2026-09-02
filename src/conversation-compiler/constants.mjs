// Deterministic compiler constants ported from the audited v0.7.0 source.
export const COMPILER_MARKER = "<!-- child-conversation-compiler:v1 -->";

export const TRUNCATE_USER = 256;
export const SEGMENT_CLOSING_ASSISTANT_HEAD_WORDS = 120;
export const SEGMENT_CLOSING_ASSISTANT_TAIL_WORDS = 120;
export const ASSISTANT_HEAD_WORDS = 80;
export const ASSISTANT_TAIL_WORDS = 120;
export const BASH_CAP = 240;
export const TOOL_CALLS_PER_TURN = 8;
export const BRIEF_MAX_LINES = 120;
export const TUI_SAFE_LINE_CHARS = 120;
export const DEFAULT_MAX_BLOCKS = 80;
export const DEFAULT_RECENT_BLOCKS = 16;
export const RANKED_BRIEF_BUDGET_TOKENS = 1_100;
export const RANKED_BRIEF_CEILING_TOKENS = 2_000;
export const RANKED_BRIEF_TOKENS_PER_BLOCK = 15;
export const DEFAULT_CHARS_PER_TOKEN = 4;
export const MIN_CHARS_PER_TOKEN = 2;
export const MAX_CHARS_PER_TOKEN = 6;
export const IMAGE_CONTENT_CHARS = 4_800;

// Compatibility names used by the landed DSH integration. Their values now
// describe the audited character/block contracts, never a Bash word budget.
export const MAX_TOOL_CALLS = TOOL_CALLS_PER_TURN;
export const WRAP_COLUMNS = TUI_SAFE_LINE_CHARS;
export const MAX_BLOCKS = DEFAULT_MAX_BLOCKS;
export const RECENT_BLOCKS = DEFAULT_RECENT_BLOCKS;
export const MIN_BUDGET_TOKENS = RANKED_BRIEF_BUDGET_TOKENS;
export const MAX_BUDGET_TOKENS = RANKED_BRIEF_CEILING_TOKENS;
export const TOKENS_PER_BLOCK = RANKED_BRIEF_TOKENS_PER_BLOCK;
export const CHARS_PER_TOKEN = DEFAULT_CHARS_PER_TOKEN;
export const GOAL_CAP = 8;
export const COMMIT_CAP = 8;
export const FILE_CATEGORY_CAP = 10;
export const PREFERENCE_EXTRACT_CAP = 10;
export const PREFERENCE_MERGE_CAP = 15;

// DSH adaptation: recall remains the existing exact-current-session tool.
export const RECALL_NOTE = [
  "> For omitted history: search `session_history` with 1–5 literal clues, expand a matching `seq` with `context`,",
  "> then verify referenced files/current state before acting.",
].join("\n");
