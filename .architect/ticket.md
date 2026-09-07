# Ticket: session-scoped tickets, delegate subagent placement, unified ticket & delegate UI, wake notification, and 400k context window compaction threshold

## Kind

open — needs implementer judgment across plugin UI, runtime delegation, and host messaging.

## Problem

1. **Ticket-Session Coupling & Stale Disc Tickets:** Tickets currently default to a single shared path (`.architect/ticket.md`). Starting a new session opens whatever ticket was last left on disk, bleeding old work into new sessions. Tickets must be stored per session at `.architect/tickets/<sessionId>.md`.
2. **Worktree Ticket Desynchronization:** When child worktrees (Implementer, Reviewer) are prepared from git branches, uncommitted session tickets do not exist in the worktree, causing children to read stale recovery tickets from git HEAD. The host must copy or write the active session ticket to `.architect/ticket.md` in the child worktree checkout.
3. **Workspace Dropdown Clutter (Delegates creating workspaces):** Currently, `createPlacedAgent` in `spawn-agent.mjs` explicitly calls `client.workspaces.create` whenever an implementer is spawned. This pollutes the operator's workspace dropdown with temporary worktrees. Delegates are subagents connected to the existing workspace and session, not independent workspaces.
4. **Missing Delegate Wake Notification ("Didn't get the memo"):** When delegates finish, the Architect never receives the completion message. In `child-mcp.mjs`, `context.agentId` and `context.paseoAgentId` are omitted from tool call context, leaving `job.parent` undefined so `queueWake` has no recipient. The host must track and propagate parent agent ID and deliver wakes via `sendAgentWake` (or `agent.send`) to wake the parent session.
5. **Split Views in Ticket Panel:** The current `TicketPanel` splits Plan and Work into two separate tabs (`Plan` vs `Work`), and hides delegate conversations behind expandable accordion rows. The operator wants the ticket to simply be the ticket: render the ticket plan directly without tab switching, and display delegates at the bottom, with each delegate (implementer, reviewer, teacher, researcher) directly visible and individually clickable to jump straight into that conversation via Paseo primitives.
6. **Compaction Threshold / Context Window Size (400k tokens):** Currently, `GEMINI_FLASH_MODEL` in `paseo-plugin/host/config.mjs` and `~/.paseo-architect/config.json` does not declare `contextWindowMaxTokens`. `agy-acp` defaults all Gemini models to 1,048,576 tokens (1M), causing auto-compaction triggers in Antigravity CLI (~75-80%) to defer until ~800k tokens. Per operator requirement, `contextWindowMaxTokens` must be explicitly set to **400,000 (400k)** across `config.mjs` and the daemon configuration.
7. **Architect Prompt Invariants:** The sentence *"Take notes and reasoning on the ticket so the operator can see them."* must be removed per Option 1 (pure deletion), and the concrete `sessionId` must be prefilled in the prompt path.
8. **Model Transition Inconsistencies:** `README.md` and `paseo-plugin/host/acp.mjs` still reference Astra/Grok credentials instead of Antigravity Gemini 3.8 Flash.

## Testing plan

1. **Compaction Threshold & Context Window:**
   - `GEMINI_FLASH_MODEL` exports `contextWindowMaxTokens: 400_000`.
   - `daemonConfigPatch` ensures both `providers.architect` and `providers.agy` models include `contextWindowMaxTokens: 400_000`.
   - Unit tests in `tests/config.mjs` and `tests/agy-roles.mjs` assert `contextWindowMaxTokens === 400_000`.
2. **Workspace & Subagent Placement:**
   - Spawning an implementer or reviewer does NOT call `client.workspaces.create`.
   - The child agent is placed in the parent's `workspaceId` with `parent: parentAgentId` and `labels["paseo.parent-agent-id"] = parentAgentId`.
   - The child agent's `cwd` correctly points to the prepared git worktree checkout.
   - Verify that the operator's workspace list is unchanged (no new workspace added).
3. **Wake Notification Delivery:**
   - `child-mcp.mjs` passes `agentId` and `paseoAgentId` from `ARCHITECT_AGENT_ID` / `PASEO_AGENT_ID` in tool execution context.
   - `runtime.mjs` associates `job.parent` with the calling Architect agent ID (with a fallback lookup for the active architect in that workspace).
   - Upon child completion (or review decision), `queueWake` calls `sendAgentWake(job.parent, message)`.
4. **Child Worktree Ticket Synchronization:**
   - Preparing a child checkout copies the current session's ticket from `.architect/tickets/<sessionId>.md` into `.architect/ticket.md` in the child worktree before the child starts.
5. **Unified Ticket & Delegate UI:**
   - `TicketPanel` in `architect.client.tsx` removes the `Plan` / `Work` tabs.
   - The ticket plan renders at the top of the panel.
   - The delegates section renders at the bottom of the panel.
   - Each delegate row displays the role (Implementer, Reviewer, Teacher, Researcher), status/phase, and is directly clickable to call `navigation.openAgent({ agentId })`.
   - If multiple delegates are present (e.g. reviewer and implementer), both are displayed separately and clickable.
6. **Session-scoped tickets:**
   - Ticket read/write resolves to `.architect/tickets/<sessionId>.md` when `sessionId` is present, falling back to `.architect/ticket.md`.
   - `TicketPanel` passes the active session ID from composer pill origin.
7. **Prompt updates & Regressions:**
   - `agent.md` and `prompts.mjs` remove *"Take notes and reasoning on the ticket so the operator can see them."*
   - All tests pass: `npm test`, `npm run typecheck`, and `npm run test:python`.

## [open]

### Budget

Full stack refinement across:
- `paseo-plugin/host/config.mjs`
- `paseo-plugin/host/spawn-agent.mjs`
- `paseo-plugin/host/child-mcp.mjs`
- `paseo-plugin/host/runtime.mjs`
- `paseo-plugin/architect.client.tsx`
- `paseo-plugin/host/workflow/ticket.mjs`
- `paseo-plugin/host/workflow/prompts.mjs`
- `paseo-plugin/agents/architect/agent.md`
- `paseo-plugin/host/acp.mjs`
- `README.md`
- Unit and integration tests in `tests/`

Note: The implementer may incorporate the already-committed work from branch `architect/open/f8f21d22` (`6f07b7aeb5b8a935d1d2604f9bc26ef67a0d251e`) which has the initial implementations of the UI redesign, subagent placement, and wake propagation.

### Solution

1. **400k Context Window / Compaction Threshold (`config.mjs`):**
   - Add `contextWindowMaxTokens: 400_000` to `GEMINI_FLASH_MODEL`.
   - In `daemonConfigPatch`: ensure `architectProvider()` and `agyProvider()` set `contextWindowMaxTokens: 400_000` on the Gemini 3.8 Flash model entries.
   - Update tests in `tests/config.mjs` and `tests/agy-roles.mjs` to assert `contextWindowMaxTokens: 400_000`.
2. **Subagent & Workspace Placement (`spawn-agent.mjs`):**
   - In `createPlacedAgent(client, options)`: remove `client.workspaces.create` entirely.
   - When `options.workspaceId` is present, use `client.workspaces.ref(options.workspaceId)`.
   - If `workspace` is resolved, do not reject if `options.cwd` differs from `workspace.directory`; use `client.agents.create({ ...options, cwd: options.cwd })` or pass placement `{ workspaceId: options.workspaceId, cwd: options.cwd }` so the agent belongs to the workspace but runs in the worktree.
3. **Context & Wake Propagation (`child-mcp.mjs`, `runtime.mjs`):**
   - In `child-mcp.mjs`: include `agentId: process.env.ARCHITECT_AGENT_ID || process.env.PASEO_AGENT_ID`, `paseoAgentId: process.env.PASEO_AGENT_ID || process.env.ARCHITECT_AGENT_ID` in `context`.
   - In `runtime.mjs`: in `executeTool`, resolve parent agent ID from `context.agentId ?? context.paseoAgentId`. If missing, query `jobs` or active agents for that `cwd` as fallback.
   - When preparing child worktrees in `runtime.mjs` (`implementerCreateOptions`, `reviewerCreateOptions`), copy the session ticket `.architect/tickets/<sessionId>.md` into the child's `.architect/ticket.md`.
4. **Unified Ticket & Delegate UI (`architect.client.tsx`):**
   - Eliminate `section` state (`'plan' | 'work'`) and `<View style={styles.tabs}>`.
   - Top section: render `<TicketPlan tokens={tokens} theme={theme} />`.
   - Bottom section: render `<View testID="architect-delegates">` listing active and recent delegates.
   - Delegate item: directly clickable `<Pressable onPress={() => navigation?.openAgent({ agentId: child.agentId })}>`. Shows role icon, role name, status, and arrow indicator. Both reviewer and implementer are shown separately when present.
5. **Session-Scoped Tickets (`ticket.mjs`, `architect.server.ts`, `architect.client.tsx`):**
   - Implement `ticketPath(cwd, sessionId)`: `.architect/tickets/<sessionId>.md` with fallback to `.architect/ticket.md`.
   - Forward `sessionId` through `handleTicket` and `TicketPanel`.
6. **Prompt Updates & Cleanup:**
   - Remove short-term memory sentence from `agent.md` and `prompts.mjs`. Prefill `<sessionId>` in ticket path prompt.
   - Update `README.md` and `acp.mjs` for Gemini 3.8 Flash.

### Rabbit holes

- Overwriting uncommitted work in the child worktree: worktree preparation creates a clean branch, copying the session ticket file into `.architect/ticket.md` before starting the agent.
- Handling older Paseo daemon clients without subagent listing: Paseo's `daemonClient.createAgent` natively accepts `workspaceId` and `callerAgentId`.

### No-gos

- Do not create top-level Paseo workspaces for child delegates.
- Do not keep the two-tab Plan/Work split.
- Do not freehand or rewrite other instructions in `agent.md` or `prompts.mjs`.
