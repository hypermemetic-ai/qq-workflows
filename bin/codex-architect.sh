#!/usr/bin/env bash
set -euo pipefail

# codex-architect: launch the qq-workflows architect loop under OpenAI Codex.
# Repo-owned launcher; the installer links ~/.local/bin/codex-architect here.
# Seeds .architect/tickets/<id>.md, renders the architect prompt from
# agents/architect/agent.md with Astra delegation model and Git lifecycle overview,
# and execs codex.

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      cat << 'EOF'
Usage: codex-architect [--session|--conversation|-c <id>] [--prompt <text>]
                       [--model <model>] [codex args...]

Launch the qq-workflows architect loop: seed .architect/tickets/<id>.md,
render the architect prompt from agents/architect/agent.md with Astra delegation model
and Git lifecycle overview, and exec codex.

Options:
  --session, --conversation, -c <id>
                        Reuse a ticket session (default: mint a new UUID).
  --prompt <text>       Initial prompt.
  --model <model>       Model to use (default: gpt-6-astra or $CODEX_MODEL).
  -h, --help            Show this help and exit (no side effects).
  -V, --version         Show the qq-workflows version and exit (no side effects).

Environment:
  CODEX_BIN             codex binary (default: codex on PATH).
  CODEX_MODEL           Default model (default: gpt-6-astra).
  CODEX_HOME            Config base (default: $HOME/.codex).
  QQ_DISABLED_TOOLS     Exported as await_runner,await_execution (Astra never sees await tools).
EOF
      exit 0
      ;;
    -V|--version)
      SHIM_FILE="$(readlink -f "${BASH_SOURCE[0]}")"
      SHIM_PKG="$(dirname "$(dirname "$SHIM_FILE")")/package.json"
      SHIM_VERSION="unknown"
      if [ -f "$SHIM_PKG" ]; then
        SHIM_VERSION="$(sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$SHIM_PKG" | head -n 1)"
        [ -n "$SHIM_VERSION" ] || SHIM_VERSION="unknown"
      fi
      echo "codex-architect $SHIM_VERSION"
      exit 0
      ;;
  esac
done

export PATH="$HOME/.local/bin:$PATH"

# Astra runs dispatch-and-yield and must never see the await tools.
# config.toml passes --disabled-tools to the MCP server; this env var is
# defense in depth (the server also honors QQ_DISABLED_TOOLS).
export QQ_DISABLED_TOOLS="await_runner,await_execution"

SHIM_FILE="$(readlink -f "${BASH_SOURCE[0]}")"
SHIM_REPO="$(dirname "$(dirname "$SHIM_FILE")")"

WORKSPACE="${PWD}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$WORKSPACE")"

SESSION_ID=""
for ((i=1; i<=$#; i++)); do
  val="${!i}"
  if [[ "$val" == "--session" || "$val" == "--conversation" || "$val" == "-c" ]]; then
    next=$((i+1))
    SESSION_ID="${!next}"
    break
  fi
done
if [ -z "$SESSION_ID" ]; then
  SESSION_ID="$(python3 -c 'import uuid; print(uuid.uuid4())')"
fi

TICKETS_DIR="${REPO_ROOT}/.architect/tickets"
mkdir -p "${TICKETS_DIR}"
TICKET_PATH="${TICKETS_DIR}/${SESSION_ID}.md"

if [ ! -f "${TICKET_PATH}" ]; then
  TEMPLATE_SRC="${REPO_ROOT}/.architect/template.md"
  if [ ! -f "${TEMPLATE_SRC}" ] && [ -f "${SHIM_REPO}/.architect/template.md" ]; then
    TEMPLATE_SRC="${SHIM_REPO}/.architect/template.md"
  fi
  if [ -f "${TEMPLATE_SRC}" ]; then
    cp "${TEMPLATE_SRC}" "${TICKET_PATH}"
  else
    cat << 'EOF' > "${TICKET_PATH}"
# Ticket

## Kind
bounded — straightforward work.
open — needs implementer judgment.

## Problem
The specific situation that is failing today.

## Testing plan
Behavioral invariants that gate acceptance, and feasible real-world failures that must not happen.

## [open]
### Budget
Time we will spend. The solution fits this.
### Solution
The approach: main pieces and how they connect. Leave room for the implementer.
### Rabbit holes
Holes we can see from here, and how each one is closed.
### No-gos
What we are leaving out so this fits the budget.
EOF
  fi
fi

# Notify Orca IDE to open the ticket file in an editor pane if available.
# On Linux, Orca IDE installs its CLI as `orca-ide` to avoid colliding with
# the system screen reader (`orca`). On macOS and other platforms, it is `orca`.
if command -v orca-ide >/dev/null 2>&1; then
  (orca-ide file open "${TICKET_PATH}" || true) </dev/null >/dev/null 2>&1 &
elif [ "$(uname -s)" != "Linux" ] && command -v orca >/dev/null 2>&1; then
  (orca file open "${TICKET_PATH}" || true) </dev/null >/dev/null 2>&1 &
fi

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
mkdir -p "${CODEX_DIR}"
ARCHITECT_PROMPT_FILE="${CODEX_DIR}/architect-instructions.md"

cat << EOF > "${ARCHITECT_PROMPT_FILE}"
You are the architect collaborating with the operator. The active ticket is \`.architect/tickets/${SESSION_ID}.md\`.

## Active Ticket (pre-seeded)
$(cat "${TICKET_PATH}" 2>/dev/null || echo "(ticket not yet filled in)")

Your goal is to fill in the ticket collaboratively with the operator. Investigate their intent and contribute architectural judgement to the conversation. Shape the testing plan, problem scope, and solution boundaries together with the operator rather than assuming them.

## Git Lifecycle
Worktrees live under \`.qq-worktrees/\` on dedicated branches. When changes are approved, they are implemented, reviewed, and automatically landed back into the main repository by the execution pipeline. You do not edit project code directly or manage git branches manually.

## Tools & Delegation Model
You operate with a high-leverage, bounded tool surface:
- \`zvec_grep_search\`: Fast, indexed semantic search across the repository to discover concepts, file paths, and anchors.
- \`dispatch_runner(task, [targetPaths])\`: Asynchronously dispatches a Gemini runner helper for research, deep investigation, code reading, running tests, or diagnostic scripts. Strictly non-blocking; returns a tracking ID. Yield your turn after dispatching — findings arrive as a reactive notification.
- \`check_runner(runnerId)\`: Returns telemetry: status ('running' | 'completed' | 'failed' | 'cancelled'), total elapsedSeconds, activeTool with running duration, last 25 trajectory steps, and the stuck-suspicion flag with evidence when silent past threshold. Optional point-in-time read for when the operator asks; never poll it in a loop.
- \`steer_runner(runnerId, instruction)\`: Injects a one-way instruction to course-correct an in-flight runner.
- \`cancel_runner(runnerId)\`: Terminates an in-flight runner cleanly.
- \`read_ticket([section], [sectionsOnly])\`: Reads the active session ticket (\`.architect/tickets/${SESSION_ID}.md\`). Can read the full ticket, list sections, or read a specific section.
- \`update_ticket(content, [section])\`: Updates the active session ticket (\`.architect/tickets/${SESSION_ID}.md\`). Pass \`section\` to surgically update only that section, or omit to replace the full ticket.
- \`dispatch_execution({ kind })\`: Strictly non-blocking dispatch of the automated worktree implementation + review + auto-landing pipeline. Returns a tracking ID. Yield your turn after dispatching — the terminal outcome arrives as a reactive notification.
- \`check_execution(id)\`: Tracks total elapsedSeconds, phase ('implementing' | 'reviewing' | 'retrying' | 'landing' | 'completed'), active tool duration, 25-step trajectory, and the stuck-suspicion flag with evidence when silent past threshold. Optional point-in-time read for when the operator asks; never poll it in a loop.

## Guidelines
- Ask questions one at a time with recommendations.
- Populate the entire ticket and testing plan collaboratively with the operator.
- Advance the conversation with the operator in parallel when appropriate while the runner is in flight.
- Batch substantive, high-yield tasks to the runner rather than micro-queries.
- Grounding invariant: Never guess or assume codebase structure, test results, or implementation details. When facts are needed, dispatch the runner.
- Do not call \`dispatch_execution\` until the operator explicitly approves the ticket.
- **Never poll background work**: after \`dispatch_runner\` or \`dispatch_execution\`, yield your turn to the operator immediately without waiting. Do not call \`check_*\` in a loop and do not wait on the work — you will be reactively notified when it finishes or if a decision is needed.
- Operating pattern for background work: dispatch → yield turn to the operator → reactive notification (terminal outcome, or needs-decision with stall evidence while the work keeps running untouched).
- A needs-decision notification leaves the work untouched: steer, cancel, or keep waiting for the terminal notification afterward.

## Teaching
If the user cannot give an informed opinion on a live question, ask whether the ticket can stay underspecified; the user decides. If the user wants to learn, or the ticket is too consequential to leave open, teach until the user is informed enough to decide. Put the decision in the ticket.

## Execution
When the operator approves the ticket, call \`dispatch_execution(kind)\`. The managed execution pipeline automatically provisions the worktree, runs the implementer, runs the reviewer (for open tickets), retries on review failure, and automatically lands the verified change. The pipeline runs in the background. Yield your turn to the operator immediately without waiting. You will be reactively notified when execution finishes or if a decision is needed; then report the final outcome to the operator.
EOF

PASSED_ARGS=()
INITIAL_PROMPT=""
HAS_MODEL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session|--conversation|-c)
      shift 2
      ;;
    --prompt)
      INITIAL_PROMPT="${2:-}"
      shift 2
      ;;
    --model|-m)
      HAS_MODEL=true
      PASSED_ARGS+=("$1" "$2")
      shift 2
      ;;
    *)
      PASSED_ARGS+=("$1")
      shift 1
      ;;
  esac
done

DEFAULT_ARGS=(
  -c features.plugins=false
  -c features.remote_plugin=false
  -c features.apps=false
  -c features.sleep_tool=false
  -c 'disabled_tools=["wait","sleep"]'
  -c code_mode.default_exec_yield_time_ms=7200000
  -c features.shell_tool=false
  -c features.unified_exec=false
  -c "model_instructions_file=\"${ARCHITECT_PROMPT_FILE}\""
)

if [ "$HAS_MODEL" = false ]; then
  DEFAULT_ARGS+=(-m "${CODEX_MODEL:-gpt-6-astra}")
fi

echo "=== OpenAI Codex (Astra) Architect ==="
echo "Ticket: ${TICKET_PATH}"
echo "Model:  ${CODEX_MODEL:-gpt-6-astra}"
echo "======================================"

CODEX_BIN="${CODEX_BIN:-codex}"
if [ -n "$INITIAL_PROMPT" ]; then
  exec "$CODEX_BIN" "${DEFAULT_ARGS[@]}" "${PASSED_ARGS[@]}" "$INITIAL_PROMPT"
else
  exec "$CODEX_BIN" "${DEFAULT_ARGS[@]}" "${PASSED_ARGS[@]}"
fi
