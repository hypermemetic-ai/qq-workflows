# Ticket

## Kind

bounded

## Problem

The Architect workflow requires explicit operator approval before delegating work to an implementer. Currently, operator approval relies on unstructured chat text, while Antigravity natively provides interactive artifact review cards with a tactile "Proceed" button when documents exist in the session brain.

To streamline operator collaboration, `ticket_write` should automatically mirror the ticket to `~/.gemini/antigravity-cli/brain/<sessionId>/ticket.md` as an interactive artifact, and the Architect prompt guidelines should formalize the "Proceed" button as the primary approval gate.

## Testing plan

1. **Artifact Mirroring in `ticket_write`:**
   - When `ticket_write` (or `ticketWrite`) updates a session ticket with a `sessionId`, it automatically mirrors the markdown text to `~/.gemini/antigravity-cli/brain/<sessionId>/ticket.md` if the directory exists (or creates it safely).
   - Test in `tests/mcp.mjs` verifies that calling `ticket_write` with `sessionId` creates/updates both `.architect/tickets/<sessionId>.md` and the brain artifact.
2. **Architect Prompt & Guidelines:**
   - `agents/architect/agent.md` and `workflow/prompts.mjs` specify in `## Guidelines`:
     - Update the ticket collaboratively using `ticket_write`.
     - Do not call `prepare_worktree` until the operator approves the ticket (via the Proceed button or explicit confirmation).
   - In `## Delegation`:
     - When the operator approves the ticket, call `prepare_worktree`. Follow the tool's returned instructions to invoke the implementer (and reviewer when required) using the prompt provided by the tool, then call `land`.
3. **Automated Test Suite:**
   - `npm test` runs cleanly across all 7 test suites.
   - `git status` remains clean.
