# Code guide

The Paseo plugin provides the UI and starts an independent host. Role adapters communicate with that host over local HTTP. The host owns durable jobs and completion; unloading the plugin leaves those jobs running.

## Entry points

| File | Responsibility |
| --- | --- |
| `paseo-plugin/index.ts` | Registers the sidebar surface, workspace ticket panel, command and RPC handlers |
| `paseo-plugin/architect.client.tsx` | Workspace-scoped ticket and child-session UI |
| `paseo-plugin/architect.server.ts` | Applies provider configuration and forwards UI requests |
| `paseo-plugin/host/host-process.mjs` | Acquires the host lease, opens SQLite and reconciles saved jobs |
| `paseo-plugin/host/runtime.mjs` | Delegation, completion, review, landing and wake delivery |
| `paseo-plugin/host/host-client.mjs` | Host startup, upgrade requests and HTTP transport |
| `paseo-plugin/host/acp.mjs` | Architect's ACP session, retained exchanges and wake processing |
| `paseo-plugin/host/teacher-acp.mjs` | Native Grok Teacher process and isolated agent profile |
| `paseo-plugin/host/mini-acp.mjs` | Mini Implementer process and completion bridge |
| `paseo-plugin/host/researcher.mjs` | Researcher's Python stdin and completion-envelope bridge |

## Supporting modules

- `host/workflow/` contains the approved prompts, ticket handling, role tools, child configuration, completion routing, Git operations and OCR review. `tools.mjs` supplies the role lists for both discovery and execution checks.
- `host/providers/` contains model transports, supervised request boundaries, authentication and text-repetition detection.
- `host/search/` contains the official ZG interface and guidance, plus web-search adapters.
- `host/store.mjs` owns durable records, attempts, receipts and the acknowledged outbox. `recovery.mjs` defines recovery policy; `supervisor.mjs` applies it at runner boundaries.
- `mini-researcher/src/mini_researcher/` contains the Python Researcher and upstream Mini wrapper. Provider errors and outcomes cross the Node/Python boundary as structured data.

The executable entry-point paths stay stable for installed providers and surviving children. Host version detection includes nested source modules, so their changes participate in the drain-and-upgrade process.

## Working on the workflow

Run the checks from the root README. Use `.architect/scratch.md` for live checks in a disposable environment. The tests mirror behavior: runtime routing and recovery, actual Git worktrees, compiled Paseo bundles, effective model requests, and actual Mini/smolagents loops.

Keep prompts in `host/workflow/prompts.mjs`; the Python Researcher and native Teacher carry their exact runtime copies. Tests and saved runtime requests verify those copies. Keep the packaged ticket template in `host/workflow/ticket.mjs`; repositories may supply their own `.architect/template.md` and optional `.architect/scratch.md`.
