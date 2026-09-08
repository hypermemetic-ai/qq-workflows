# Ticket

## Kind

open — needs implementer judgment across repository cleanup, MCP tool implementation, and installation scripting.

## Problem

`qq-workflows` is transitioning from a legacy Paseo plugin to a native Google Antigravity workflow. The repository currently carries historical baggage: deleted Paseo plugin files, dead tests, and no definitive delegation tools (`prepare_worktree` and `land`). As a result, the Architect is forced into error-prone manual bash scripting for git worktrees, branch creation, ticket copying, and PR landing.

Furthermore, giving the Architect general-purpose file modification tools (`write_to_file` and `replace_file_content`) creates an architectural flaw where the Architect can directly modify project files rather than delegating implementation to an isolated worktree. The Architect needs shell access (`run_command`) for inspection and diagnostics, but file edits must be strictly limited to the session ticket.

## Testing plan

1. **Definitive Prompts & Agents:**
   - `agents/architect/agent.md` and `workflow/prompts.mjs` are updated with the finalized text:
     - Introductory collaboration paragraph and `## Guidelines`.
     - `## Teaching` (renamed from `## Teacher`).
     - `## Delegation` instructing `prepare_worktree` and `land` using the prompt returned by `prepare_worktree`.
   - Tool capabilities for `architect`:
     - Must include: `view_file`, `run_command`, `grep_search`, `find_by_name`, `list_dir`, `read_url_content`, `search_web`, `invoke_subagent`, `send_message`, `ticket_read`, `ticket_write`, `prepare_worktree`, `land`.
     - Must NOT include: `write_to_file`, `replace_file_content`.
   - `npm run install:agents` successfully links agents into `~/.gemini/config/agents/` and registers the MCP server in `~/.gemini/config/mcp_config.json`.
2. **Lean MCP Server Tools (`bin/mcp-server.mjs`):**
   - Zero-bloat stdio JSON-RPC MCP server (`tools/list` and `tools/call`) using Node built-ins without external dependencies, exposing 4 tools:
     - `prepare_worktree`:
       - Invoking `prepare_worktree({ kind: "bounded" })` deterministically creates branch `architect/bounded/<id>`, creates the worktree at `.qq-worktrees/...`, copies `.architect/tickets/<id>.md` into the checkout as `.architect/ticket.md`, returns `reviewRequired: false`, `implementerPrompt`, and instructions.
       - Invoking `prepare_worktree({ kind: "open" })` returns `reviewRequired: true`, `implementerPrompt`, `reviewerPrompt`, and instructions.
       - Invoking without `kind` fails immediately with an explicit validation error (`kind is required: bounded | open`).
     - `land`:
       - Automatically commits changes in the worktree if dirty.
       - If remote repo, creates and merges PR via `gh` with `--delete-branch`. If local repo, fast-forwards main.
       - Retires the worktree (`git worktree remove --force`) and deletes the local branch.
     - `ticket_read`:
       - Reads `.architect/tickets/<sessionId>.md` (or `.architect/ticket.md`). Returns `{ ok: true, path, text }`.
     - `ticket_write`:
       - Writes/edits `.architect/tickets/<sessionId>.md` using `ticketWrite` from `workflow/ticket.mjs` (`text` for full replacement or `old_string`/`new_string`/`replace_all` for surgical edits). Returns `{ ok: true, path, text }`.
3. **Clean Repository & Test Suite:**
   - All dead `paseo-plugin/` files and obsolete tests are permanently purged (`git rm`).
   - Unit tests in `tests/mcp.mjs` verify all 4 MCP tools (`prepare_worktree`, `land`, `ticket_read`, `ticket_write`).
   - `tests/agy-roles.mjs` verifies tool definitions for `architect` (has `run_command`, `ticket_read`, `ticket_write`; does NOT have `write_to_file`, `replace_file_content`).
   - `npm test` passes cleanly across all active test suites.
   - `git status` is clean.

## [open]

### Budget

Fits within 1 implementer cycle.

### Solution

1. **MCP Server Updates (`bin/mcp-server.mjs`):**
   - Import `ticketRead` and `ticketWrite` from `workflow/ticket.mjs`.
   - Add schemas for `ticket_read` and `ticket_write` to `TOOLS`.
   - Implement tool handlers for `ticket_read` and `ticket_write` resolving `root` and `sessionId`.
2. **Agent Capabilities (`agents/architect/agent.md`):**
   - Remove `write_to_file` and `replace_file_content`.
   - Retain `run_command`.
   - Add `ticket_read` and `ticket_write`.
3. **Prompt & Test Synchronizations:**
   - Update `tests/mcp.mjs` to test `ticket_read` and `ticket_write`.
   - Update `tests/agy-roles.mjs` to test the new tool assertions.
   - Run `npm test` and `npm run install:agents`.

### Rabbit holes

1. **Heavy MCP Frameworks:** Do not pull in large third-party MCP SDK dependencies. Keep it zero-dependency stdio JSON-RPC.
2. **Over-abstracting worktree paths:** Keep worktrees strictly rooted in `.qq-worktrees/<repo-name>/...` as defined in `workflow/git.mjs`.

### No-gos

1. **No generic write tools for Architect:** Architect must not have `write_to_file` or `replace_file_content`.
2. **No Backwards Compatibility Layers:** Do not keep Paseo shims, unused adapter code, or dead documentation. Git history is the archive.
