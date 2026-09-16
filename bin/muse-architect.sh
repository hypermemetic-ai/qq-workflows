#!/usr/bin/env bash
set -euo pipefail

# muse-architect: launch the qq-workflows architect loop under Muse Spark.
# Repo-owned launcher; the installer links ~/.local/bin/muse-architect here.
# Seeds .architect/tickets/<id>.md, renders the architect prompt from
# agents/architect/agent.md, and execs muse.

# Early exits first: --help/--version have no side effects
# (no ticket created, prompt.md untouched).
for arg in "$@"; do
  case "$arg" in
    -h|--help)
      cat << 'EOF'
Usage: muse-architect [--session|--conversation|-c <id>] [--prompt <text>]
                      [--preset <name>] [--model <model>]
                      [--reasoning-effort <level>] [--yolo] [--workspace <dir>]
                      [muse args...]

Launch the qq-workflows architect loop: seed .architect/tickets/<id>.md,
render the architect prompt from agents/architect/agent.md, and exec muse.

Options:
  --session, --conversation, -c <id>
                        Reuse a ticket session (default: mint a new UUID).
  --prompt <text>       Initial prompt (Orca flag-prompt style).
  --preset, --model, --reasoning-effort, --yolo, --workspace
                        Passed through to muse. Defaults: --preset architect,
                        --model muse-spark-1.3 ($MUSE_MODEL to override),
                        --reasoning-effort max, --yolo, --workspace $PWD.
  -h, --help            Show this help and exit (no side effects).
  -V, --version         Show the qq-workflows version and exit (no side effects).

Environment:
  MUSE_BIN              muse binary (default: muse on PATH).
  MUSE_MODEL            Default model (default: muse-spark-1.3).
  XDG_CONFIG_HOME       Config base (default: $HOME/.config).
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
      echo "muse-architect $SHIM_VERSION"
      exit 0
      ;;
  esac
done

# Ensure ~/.local/bin is in PATH
export PATH="$HOME/.local/bin:$PATH"

# Repo root of this launcher (resolves the ~/.local/bin symlink).
SHIM_FILE="$(readlink -f "${BASH_SOURCE[0]}")"
SHIM_REPO="$(dirname "$(dirname "$SHIM_FILE")")"

# Resolve workspace and git root
WORKSPACE="${PWD}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "$WORKSPACE")"

# Generate or reuse session ID
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

# Setup ticket directory and file
TICKETS_DIR="${REPO_ROOT}/.architect/tickets"
mkdir -p "${TICKETS_DIR}"
TICKET_PATH="${TICKETS_DIR}/${SESSION_ID}.md"

# Seed ticket from template if not present: workspace repo template, then this
# launcher's repo template, then a minimal inline fallback.
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

# Render the architect governing prompt from the repo role file (single source
# of truth): strip the YAML frontmatter, substitute the session id. The body
# stays byte-identical to agents/architect/agent.md apart from the id.
MUSE_CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/muse"
ARCHITECT_CONFIG_DIR="$MUSE_CONFIG_DIR/architect"
mkdir -p "${ARCHITECT_CONFIG_DIR}"
ARCHITECT_PROMPT_FILE="${ARCHITECT_CONFIG_DIR}/prompt.md"

AGENT_MD="${SHIM_REPO}/agents/architect/agent.md"
ESCAPED_SESSION_ID="$(printf '%s' "$SESSION_ID" | sed 's/[&|]/\\&/g')"
if [ -f "${AGENT_MD}" ]; then
  awk 'BEGIN { fences = 0 } /^---$/ && fences < 2 { fences++; next } fences < 2 { next } { print }' "${AGENT_MD}" \
    | sed "s|<sessionId>|${ESCAPED_SESSION_ID}|g" > "${ARCHITECT_PROMPT_FILE}"
fi
if [ ! -s "${ARCHITECT_PROMPT_FILE}" ]; then
  # Last-resort fallback when the role file is missing or renders empty.
  cat << EOF > "${ARCHITECT_PROMPT_FILE}"
You are the architect. The ticket is \`.architect/tickets/${SESSION_ID}.md\`.

Your goal is to fill in the ticket by collaborating with the operator. Investigate their intent and contribute architectural judgement to the conversation. Shape the testing plan, problem scope, and solution boundaries together with the operator rather than assuming them.

## Guidelines
- Ask questions one at a time with recommendations.
- Populate ticket and testing plan collaboratively with the operator.
- Grounding invariant: Never guess or assume codebase structure, test results, or implementation details. When facts are needed, dispatch the runner via dispatch_runner.
- Do not call dispatch_execution until the operator explicitly approves.

## Teaching
If the user cannot give an informed opinion on a live question, ask whether the ticket can stay underspecified; the user decides. If the user wants to learn, or the ticket is too consequential to leave open, teach until the user is informed enough to decide. Put the decision in the ticket.

## Execution
When the operator approves the ticket, call dispatch_execution(kind). The managed execution pipeline automatically provisions the worktree, runs the implementer, runs the reviewer (for open tickets), retries on review failure, and automatically lands the verified change. Then call await_execution(id) to wait for and report the final outcome. Do not modify project code directly.
EOF
fi

export TBH_EVAL_APPEND_DEVELOPER_PROMPT_FILE="${ARCHITECT_PROMPT_FILE}"

# Login-only auth (2026-09-13): never propagate a stored API key into the
# session environment. META_API_KEY always overrides the Meta-account login
# and re-triggers the override note on every launch, so keep it unset here
# even if the parent shell exported it. (A previous revision sourced the key
# from auth.json; re-add deliberately if key-auth is ever wanted back.)
unset META_API_KEY

# Parse arguments and handle Orca flag-prompt (--prompt <text>)
HAS_MODEL=false
HAS_EFFORT=false
HAS_YOLO=false
HAS_WORKSPACE=false
HAS_PRESET=false
INITIAL_PROMPT=""
PASSED_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session|--conversation|-c)
      shift 2
      ;;
    --prompt)
      INITIAL_PROMPT="${2:-}"
      shift 2
      ;;
    --preset)
      HAS_PRESET=true
      PASSED_ARGS+=("$1" "$2")
      shift 2
      ;;
    --model)
      HAS_MODEL=true
      PASSED_ARGS+=("$1" "$2")
      shift 2
      ;;
    --reasoning-effort)
      HAS_EFFORT=true
      PASSED_ARGS+=("$1" "$2")
      shift 2
      ;;
    --yolo)
      HAS_YOLO=true
      PASSED_ARGS+=("$1")
      shift 1
      ;;
    --workspace)
      HAS_WORKSPACE=true
      PASSED_ARGS+=("$1" "$2")
      shift 2
      ;;
    *)
      PASSED_ARGS+=("$1")
      shift 1
      ;;
  esac
done

# Build default options
DEFAULT_ARGS=()
if [ "$HAS_PRESET" = false ]; then
  DEFAULT_ARGS+=(--preset architect)
fi
if [ "$HAS_MODEL" = false ]; then
  DEFAULT_ARGS+=(--model "${MUSE_MODEL:-muse-spark-1.3}")
fi
if [ "$HAS_EFFORT" = false ]; then
  DEFAULT_ARGS+=(--reasoning-effort max)
fi
if [ "$HAS_YOLO" = false ]; then
  DEFAULT_ARGS+=(--yolo)
fi
if [ "$HAS_WORKSPACE" = false ]; then
  DEFAULT_ARGS+=(--workspace "${WORKSPACE}")
fi

echo "=== Muse Spark 1.3 Architect (Reasoning: max) ==="
echo "Ticket: ${TICKET_PATH}"
echo "Model:  ${MUSE_MODEL:-muse-spark-1.3}"
echo "=================================================="

MUSE_BIN="${MUSE_BIN:-muse}"
if [ -n "$INITIAL_PROMPT" ]; then
  exec "$MUSE_BIN" "${DEFAULT_ARGS[@]}" "${PASSED_ARGS[@]}" "$INITIAL_PROMPT"
else
  exec "$MUSE_BIN" "${DEFAULT_ARGS[@]}" "${PASSED_ARGS[@]}"
fi
