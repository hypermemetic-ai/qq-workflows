// Single authoritative source for the final-response character cap.
//
// Units are CHARACTERS, not tokens. The cap bounds the narrative a worker may
// deliver through the completion transport: the `complete_task` tool on a
// harness that exposes it, and the adapter's closing-answer gate for every seat
// on the `deepseek-minimal` and `pi` harnesses (the Pi session has no MCP tool
// at all, so its effective seat instructions state this same cap for the
// closing assistant message). It is deliberately the ONE place the number
// lives: the complete_task schema/description/writer, the runner-result reader,
// the DeepSeek and Pi terminal adapters, the effective seat instructions, and
// the tests all derive from it instead of restating a literal.
//
// Policy is fail-closed: an over-cap answer is rejected with a bounded
// diagnostic and never silently truncated, and it can never authorize a
// successful completion or a reviewer PASS. It is unrelated to (and must never
// be conflated with) stderr/log/tool-output/token limits.

export const FINAL_RESPONSE_MAX_CHARS = 16_384;

/**
 * Human-readable form of the cap for instructions and error messages
 * ("16,384"). Derived from the constant so the two cannot drift.
 */
export const FINAL_RESPONSE_MAX_CHARS_LABEL = String(FINAL_RESPONSE_MAX_CHARS).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
