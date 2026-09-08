# Ticket

## Kind

open — needs implementer judgment across repository cleanup, MCP tool implementation, and installation scripting.

## Problem

`qq-workflows` is transitioning from a legacy Paseo plugin to a native Google Antigravity workflow. The repository currently carries historical baggage: deleted Paseo plugin files, dead tests, and no definitive delegation tools (`prepare_worktree` and `land`). As a result, the Architect is forced into error-prone manual bash scripting for git worktrees, branch creation, ticket copying, and PR landing.

## Testing plan

1. **Definitive Prompts & Agents:**
   - `agents/architect/agent.md` and `workflow/prompts.mjs` are updated with the finalized text:
     - Introductory collaboration paragraph and `## Guidelines`.
     - `## Teaching` (renamed from `## Teacher`).
     - `## Delegation` instructing `prepare_worktree` and `land`.
   - `npm run install:agents` successfully links agents into `~/.gemini/config/agents/` and registers the MCP server in `~/.gemini/config/mcp_config.json`.
2. **`prepare_worktree` Tool:**
   - Invoking `prepare_worktree({ kind: "bounded" })` deterministically creates branch `architect/bounded/<id>`, creates the worktree at `.qq-worktrees/...`, copies `.architect/tickets/<id>.md` into the checkout as `.architect/ticket.md`, and returns `reviewRequired: false` with next-step instructions.
   - Invoking `prepare_worktree({ kind: "open" })` returns `reviewRequired: true`.
   - Invoking without `kind` fails immediately with an explicit validation error (`kind is required: 'bounded' | 'open'`).
3. **`land` Tool:**
   - Automatically commits changes in the worktree if dirty.
   - If remote repo, creates and merges PR via `gh` with `--delete-branch`. If local repo, fast-forwards main.
   - Retires the worktree (`git worktree remove --force`) and deletes the local branch.
4. **Lean MCP Server:**
   - Zero-bloat stdio JSON-RPC MCP server (`tools/list` and `tools/call`) implementing `prepare_worktree` and `land` using Node built-ins without heavy external dependencies.
5. **Clean Repository & Test Suite:**
   - All dead `paseo-plugin/` files and obsolete tests are removed (`git rm`).
   - `npm test` passes cleanly across all active test suites.
   - `git status` is clean.

## [open]

### Budget

Fits within 1 implementer cycle.

### Solution

1. **Prompt Finalization:**
   - Apply the finalized `## Delegation` text in `agents/architect/agent.md` and `workflow/prompts.mjs`.
2. **Deterministic MCP Server (`bin/mcp-server.mjs`):**
   - Implement a lightweight stdio MCP server exposing `prepare_worktree` and `land`.
   - Wire it to use `workflow/git.mjs` (`createWorktree`, `landWorktree`, `retireWorktree`) and `workflow/ticket.mjs`.
   - Register it in `scripts/install-agents.mjs` to mount under `~/.gemini/config/mcp_config.json` as `qq-workflows`.
3. **Repository Refactoring & Purge:**
   - Permanently remove all deleted `paseo-plugin/` files and dead test files (`git rm`).
   - Keep only the definitive Antigravity implementation: `agents/`, `bin/`, `hooks/`, `workflow/`, `scripts/`, `tests/`.
4. **Verification & Tests:**
   - Add unit tests for `prepare_worktree` and `land` tool execution in `tests/`.
   - Verify `npm test` and `npm run install:agents`.

### Rabbit holes

1. **Heavy MCP Frameworks:** Do not pull in large third-party MCP SDK dependencies. A lean ~100-line stdio JSON-RPC server handles `tools/list` and `tools/call` cleanly with zero runtime baggage.
2. **Over-abstracting worktree paths:** Keep worktrees strictly rooted in `.qq-worktrees/<repo-name>/...` as defined in `workflow/git.mjs`.

### No-gos

1. **No Backwards Compatibility Layers:** Do not keep Paseo shims, unused adapter code, or dead documentation. Git history is the archive.
