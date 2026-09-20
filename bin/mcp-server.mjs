#!/usr/bin/env node
import {
  OPERATOR_ACTION_TOOLS,
  stageOperatorAction,
  checkOperatorAction,
  cancelOperatorAction,
  cleanupOperatorAction,
} from "../workflow/operator-action.mjs";

const OPERATOR_ACTION_TOOL_NAMES = new Set(OPERATOR_ACTION_TOOLS.map((t) => t.name));

function isOperatorActionEnabled(options = {}) {
  return Boolean(options.enableOperatorAction || process.env.QQ_ENABLE_OPERATOR_ACTION === "1");
}
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  createWorktree,
  currentBranch,
  defaultBaseRef,
  defaultLocalBranch,
  git,
  hasImplementationChanges,
  isDirty,
  landWorktree,
  mainRepoRoot,
  parseWorktreePorcelain,
} from "../workflow/git.mjs";
import {
  COMPLETE_TASK_DATA_POINT_LEN_MAX,
  COMPLETE_TASK_DATA_POINTS_MAX,
  COMPLETE_TASK_RESPONSE_MAX,
  acceptRunnerResult,
  cleanupRunnerFiles,
  validateRunnerResultPayload,
  readAuthoritativeRunnerResult as readAuthoritativeResultFromStore,
  renderRunnerFindings,
} from "../workflow/results.mjs";
import { routeNotification } from "../workflow/notify.mjs";
import { saveReport } from "../workflow/reports.mjs";
import { stateDirFor } from "../workflow/session.mjs";
import {
  CANONICAL_PROVIDERS,
  PROVIDERS,
  assertKnownProvider,
  extractSection,
  listSections,
  loadPackagedTemplate,
  normalizeProvider,
  replaceSection,
  resolveTicketSource,
  templatePath,
  ticketPath,
} from "../workflow/ticket.mjs";

export { CANONICAL_PROVIDERS, PROVIDERS, assertKnownProvider, normalizeProvider, hasImplementationChanges, OPERATOR_ACTION_TOOLS };

export const TOOLS = [
  {
    name: "prepare_worktree",
    description: "Prepare a git worktree and branch for delegation (bounded, open, or research).",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["bounded", "open", "research"],
          description: "Work kind: 'bounded', 'open', or 'research'",
        },
        sessionId: {
          type: "string",
          description: "Optional session ID. If omitted, resolved from active ticket in .architect/tickets/",
        },
        cwd: {
          type: "string",
          description: "Optional repository working directory (defaults to process.cwd())",
        },
        provider: {
          type: "string",
          enum: ["muse", "gemini", "deepseek", "codex", "astra"],
          description: "Optional global provider default: 'muse' (default), 'gemini', 'deepseek', 'codex', or 'astra'. Per-seat providers override it.",
        },
        implementerProvider: {
          type: "string",
          enum: ["muse", "gemini", "deepseek", "codex", "astra"],
          description: "Optional implementer seat provider. Overrides the global provider.",
        },
        reviewerProvider: {
          type: "string",
          enum: ["muse", "gemini", "deepseek", "codex", "astra"],
          description: "Optional reviewer seat provider. Overrides the global provider.",
        },
        researcherProvider: {
          type: "string",
          enum: ["muse", "gemini", "deepseek", "codex", "astra"],
          description: "Optional researcher seat provider. Overrides the global provider.",
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "land",
    description: "Land changes from an implementer or research worktree: commit changes, merge PR (or fast-forward main), and retire worktree and branch.",
    inputSchema: {
      type: "object",
      properties: {
        worktree: {
          type: "string",
          description: "Optional path to the worktree to land. If omitted, detects active worktree.",
        },
        message: {
          type: "string",
          description: "Optional commit and PR message.",
        },
        cwd: {
          type: "string",
          description: "Optional working directory (defaults to process.cwd())",
        },
      },
    },
  },
  {
    name: "dispatch_runner",
    description: "Spawn a background Gemini runner for research, deep investigation, diagnostics, or test runs.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Task description, research question, or command instructions for the runner",
        },
        targetPaths: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of target file or directory paths to investigate",
        },
        cwd: {
          type: "string",
          description: "Optional working directory (defaults to process.cwd())",
        },
        sessionId: {
          type: "string",
          description: "Optional architect session ID used to route reactive Codex notifications",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "check_runner",
    description: "Check telemetry, trajectory, and status of a running or finished runner. Point-in-time read; surfaces the stuck-suspicion flag with evidence when silent past threshold.",
    inputSchema: {
      type: "object",
      properties: {
        runnerId: {
          type: "string",
          description: "Tracking ID of the runner",
        },
      },
      required: ["runnerId"],
    },
  },
  {
    name: "steer_runner",
    description: "Inject a one-way instruction to course-correct a running runner.",
    inputSchema: {
      type: "object",
      properties: {
        runnerId: {
          type: "string",
          description: "Tracking ID of the runner",
        },
        instruction: {
          type: "string",
          description: "Instruction to guide the runner",
        },
      },
      required: ["runnerId", "instruction"],
    },
  },
  {
    name: "cancel_runner",
    description: "Cancel and terminate a running runner process cleanly.",
    inputSchema: {
      type: "object",
      properties: {
        runnerId: {
          type: "string",
          description: "Tracking ID of the runner",
        },
      },
      required: ["runnerId"],
    },
  },
  {
    name: "await_runner",
    description: "Wait for a runner and return status by 4:50: terminal payload if finished, needs-decision with stall evidence if silent past threshold, or running-fine heartbeat. Never fails for clocks; re-await while running. Parking an await on running work is safe.",
    inputSchema: {
      type: "object",
      properties: {
        runnerId: {
          type: "string",
          description: "Tracking ID of the runner",
        },
      },
      required: ["runnerId"],
    },
  },
  {
    name: "dispatch_execution",
    description: "Provision dedicated worktree, run implementer, run reviewer (for open kind) with retry loop, and automatically land on passing review.",
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["bounded", "open"],
          description: "Work kind: 'bounded' or 'open'",
        },
        sessionId: {
          type: "string",
          description: "Optional session ID. Defaults to active ticket in .architect/tickets/",
        },
        cwd: {
          type: "string",
          description: "Optional repository working directory (defaults to process.cwd())",
        },
        provider: {
          type: "string",
          enum: ["muse", "gemini", "deepseek", "codex", "astra"],
          description: "Optional provider default",
        },
        implementerProvider: {
          type: "string",
          enum: ["muse", "gemini", "deepseek", "codex", "astra"],
        },
        reviewerProvider: {
          type: "string",
          enum: ["muse", "gemini", "codex", "astra"],
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "check_execution",
    description: "Check progress, active phase, telemetry, and status of an execution pipeline. Point-in-time read; surfaces the stuck-suspicion flag with evidence when silent past threshold.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Tracking ID of the execution",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "await_execution",
    description: "Wait for an execution pipeline and return status by 4:50: terminal payload if finished, needs-decision with stall evidence if silent past threshold, or running-fine heartbeat. Never fails for clocks; re-await while running. Parking an await on running work is safe.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Tracking ID of the execution",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "read_ticket",
    description: "Read the active session ticket (.architect/tickets/<sessionId>.md). Supports reading the full ticket, listing available sections, or reading a specific section.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Optional session ID",
        },
        cwd: {
          type: "string",
          description: "Optional working directory",
        },
        section: {
          type: "string",
          description: "Optional section heading to read (e.g. 'Problem', 'Testing plan', 'Kind', '[open]'). If omitted, returns the full ticket and a list of available sections.",
        },
        sectionsOnly: {
          type: "boolean",
          description: "Optional boolean. If true, returns only the list of section headings without the full content.",
        },
      },
    },
  },
  {
    name: "update_ticket",
    description: "Update the active session ticket (.architect/tickets/<sessionId>.md). Supports full file replacement or surgical section-level updates.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Markdown content to write. If 'section' is specified, this content replaces only that section; otherwise replaces the entire ticket.",
        },
        section: {
          type: "string",
          description: "Optional section heading to update (e.g. 'Problem', 'Testing plan', 'Kind', '[open]'). When provided, only this section is replaced (or appended if not found), leaving the rest of the ticket untouched.",
        },
        sessionId: {
          type: "string",
          description: "Optional session ID",
        },
        cwd: {
          type: "string",
          description: "Optional working directory",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "complete_task",
    description: "Report task completion with a narrative summary and optional discrete data points. Must be called before terminating.",
    inputSchema: {
      type: "object",
      properties: {
        response: {
          type: "string",
          description: "Narrative findings/outcome. Hard cap of 32,768 characters.",
        },
        data_points: {
          type: "array",
          items: { type: "string" },
          description: "Discrete factual references (file:line, commit hash, error code). Max 20 items, max 100 chars each.",
        },
      },
      required: ["response"],
    },
  },
];

// Only strict session-id filenames are candidates for omitted-sessionId
// resolution. Backups (*-sources.md) and anything else never resolve.
export const STRICT_TICKET_FILENAME = /^[0-9a-fA-F-]{36}\.md$/;

export async function resolveActiveSessionId(root, explicitId) {
  if (explicitId) return explicitId;
  const ticketsDir = join(root, ".architect", "tickets");
  if (existsSync(ticketsDir)) {
    try {
      const entries = readdirSync(ticketsDir)
        .filter((f) => STRICT_TICKET_FILENAME.test(f))
        .sort();
      if (entries.length === 1) {
        return basename(entries[0], ".md");
      }
      if (entries.length > 1) {
        const ids = entries.map((f) => basename(f, ".md"));
        throw new Error(`ambiguous active ticket: ${entries.length} candidates (${ids.join(", ")}); pass sessionId explicitly`);
      }
    } catch (error) {
      if (error?.message?.startsWith("ambiguous active ticket")) throw error;
      /* ignore */
    }
  }
  return undefined;
}

export async function resolveSessionId(root, explicitId) {
  const resolved = await resolveActiveSessionId(root, explicitId);
  if (!resolved) {
    throw new Error("no active ticket: pass sessionId or create .architect/tickets/<id>.md");
  }
  return resolved;
}

// Which providers serve which seat. Wiring a provider into another seat
// later is additive: extend the seat's list and add its template below.
export const SEAT_PROVIDERS = {
  implementer: ["muse", "gemini", "deepseek", "codex", "astra"],
  reviewer: ["muse", "gemini", "codex", "astra"],
  researcher: ["muse", "gemini", "codex", "astra"],
  architect: ["muse", "gemini", "codex", "astra"],
};

// Resolve which provider serves a seat. Precedence:
// seat arg > seat env > global arg > global env > 'muse'.
// Unknown strings always throw; a known provider that does not serve the
// seat throws with no silent fallback.
export function resolveProvider(seat, { arg, seatEnv, globalArg, globalEnv } = {}) {
  for (const value of [arg, seatEnv, globalArg, globalEnv]) {
    if (value !== undefined && value !== null) assertKnownProvider(value);
  }
  const raw = arg ?? seatEnv ?? globalArg ?? globalEnv ?? "muse";
  const normalized = normalizeProvider(raw);
  if (!SEAT_PROVIDERS[seat].includes(raw) && !SEAT_PROVIDERS[seat].includes(normalized)) {
    throw new Error(`provider '${raw}' does not support seat '${seat}'`);
  }
  return normalized;
}

const SEAT_ARGS = {
  implementer: "implementerProvider",
  reviewer: "reviewerProvider",
  researcher: "researcherProvider",
};

const SEAT_ENVS = {
  implementer: "QQ_IMPLEMENTER_PROVIDER",
  reviewer: "QQ_REVIEWER_PROVIDER",
  researcher: "QQ_RESEARCHER_PROVIDER",
};

export function resolveSeatProvider(seat, args = {}, env = process.env) {
  return resolveProvider(seat, {
    arg: args[SEAT_ARGS[seat]],
    seatEnv: env[SEAT_ENVS[seat]],
    globalArg: args.provider,
    globalEnv: env.QQ_WORKFLOW_PROVIDER,
  });
}

// Per-seat command templates, keyed by provider. Each template renders one
// delegation step; unsupported seat x provider pairs have no template.
const IMPLEMENTER_TEMPLATES = {
  muse: (cwd, prompt) => `Delegate via run_command (with Cwd: ${cwd}): 'muse exec --preset implementer --yolo "${prompt} Leave changes uncommitted. Do not commit, push, review, or land."'`,
  gemini: (cwd, prompt, conversationId) =>
    `Delegate via run_command (with Cwd: ${cwd}) using a fresh conversation: 'agy --agent implementer --conversation ${conversationId} --print-timeout 60m --print "${prompt} Leave changes uncommitted. Do not commit, push, review, or land."'
Do NOT pass '--new-project'.`,
  deepseek: (cwd, prompt) => `Delegate via run_command (with Cwd: ${cwd}): 'dsh --profile implementer "${prompt} Leave changes uncommitted. Do not commit, push, review, or land."'`,
  codex: (cwd, prompt) => `Delegate via run_command (with Cwd: ${cwd}): 'codex exec --profile implementer "${prompt} Leave changes uncommitted. Do not commit, push, review, or land."'`,
};
IMPLEMENTER_TEMPLATES.astra = IMPLEMENTER_TEMPLATES.codex;

const REVIEWER_TEMPLATES = {
  muse: (cwd, prompt) => `invoke reviewer via run_command (with Cwd: ${cwd}): 'muse exec --preset reviewer --yolo "${prompt} Do not commit, push, or land."'`,
  gemini: (cwd, prompt, conversationId) =>
    `invoke reviewer via run_command (with Cwd: ${cwd}) using a fresh conversation: 'agy --agent reviewer --conversation ${conversationId} --print-timeout 60m --print "${prompt} Do not commit, push, or land."'
Do NOT pass '--new-project'.`,
  codex: (cwd, prompt) => `invoke reviewer via run_command (with Cwd: ${cwd}): 'codex exec --profile reviewer "${prompt} Do not commit, push, or land."'`,
};
REVIEWER_TEMPLATES.astra = REVIEWER_TEMPLATES.codex;

const RESEARCHER_TEMPLATES = {
  muse: (cwd, prompt) => `Delegate via run_command (with Cwd: ${cwd}): 'muse exec --preset researcher --yolo "${prompt} Leave files uncommitted. Do not commit, push, or land."'`,
  gemini: (cwd, prompt) => `Invoke research subagent with ticket path ${cwd}/.architect/ticket.md and worktree cwd via run_command (with Cwd: ${cwd}) using Prompt: "${prompt} Leave files uncommitted. Do not commit, push, or land."`,
  codex: (cwd, prompt) => `Delegate via run_command (with Cwd: ${cwd}): 'codex exec --profile researcher "${prompt} Leave files uncommitted. Do not commit, push, or land."'`,
};
RESEARCHER_TEMPLATES.astra = RESEARCHER_TEMPLATES.codex;

export function buildImplementerPrompt(worktreeCwd) {
  const ticketPath = join(worktreeCwd, ".architect", "ticket.md");
  return `Implement '${ticketPath}' in working directory '${worktreeCwd}'. When finished, report your answer.`;
}

export function buildReviewerPrompt(worktreeCwd) {
  const ticketPath = join(worktreeCwd, ".architect", "ticket.md");
  return `Follow '${ticketPath}' in working directory '${worktreeCwd}'. Follow its testing plan. Do not change project code. Run tests to completion and report Verdict: PASS/FAIL with evidence; incomplete verification must not emit a fake FAIL. In non-interactive execution, ending your turn while background tasks run cancels them; actively await all background verification tasks until finished. Incomplete tests are not code defects.`;
}

export function buildRetryPrompt(worktreeCwd, reviewerOutput) {
  const ticketPath = join(worktreeCwd, ".architect", "ticket.md");
  return `Implement '${ticketPath}' in working directory '${worktreeCwd}'. The reviewer found defects:
${reviewerOutput}
Please resolve these defects. When finished, report your answer.`;
}

export function buildResearcherPrompt(worktreeCwd) {
  const ticketPath = join(worktreeCwd, ".architect", "ticket.md");
  return `Investigate '${ticketPath}' in working directory '${worktreeCwd}'. Report findings.`;
}

export function buildImplementerStep(cwd, prompt, provider, conversationId) {
  const p = normalizeProvider(provider);
  return IMPLEMENTER_TEMPLATES[p](cwd, prompt, conversationId);
}

export function buildReviewerStep(cwd, prompt, provider, conversationId) {
  const p = normalizeProvider(provider);
  return REVIEWER_TEMPLATES[p](cwd, prompt, conversationId);
}

export function buildResearcherStep(cwd, prompt, provider) {
  const p = normalizeProvider(provider);
  return RESEARCHER_TEMPLATES[p](cwd, prompt);
}

export async function prepareWorktree(args = {}) {
  const { kind, cwd = process.cwd() } = args;
  if (!kind || (kind !== "bounded" && kind !== "open" && kind !== "research")) {
    throw new Error("kind is required: 'bounded' | 'open' | 'research'");
  }
  // Resolve providers before creating anything so a bad value fails fast
  // without leaving a stray worktree or branch behind. Only seats the kind
  // delegates to are resolved; config for unused seats is inert.
  const implementerProvider = kind === "research" ? null : resolveSeatProvider("implementer", args);
  const reviewerProvider = kind === "open" ? resolveSeatProvider("reviewer", args) : null;
  const researcherProvider = kind === "research" ? resolveSeatProvider("researcher", args) : null;

  const curr = await currentBranch(cwd).catch(() => null);
  if ((curr && curr.startsWith("architect/")) || cwd.includes(".qq-worktrees") || resolve(cwd).includes(".qq-worktrees")) {
    throw new Error("prepare_worktree cannot be called from within a delegated worktree");
  }

  const root = await mainRepoRoot(cwd);
  const sessionId = await resolveSessionId(root, args.sessionId || args.id || args.conversationId);
  // Fail fast on a missing ticket before any worktree or branch exists.
  await resolveTicketSource(root, sessionId);

  const wt = await createWorktree(root, { kind, sessionId });
  const ticketSource = wt.ticketSource ?? await resolveTicketSource(root, sessionId);
  const reviewRequired = kind === "open";

  if (kind === "research") {
    const researcherPrompt = buildResearcherPrompt(wt.cwd);
    const step = buildResearcherStep(wt.cwd, researcherPrompt, researcherProvider);
    const instructions = `Worktree ready at ${wt.cwd}.
Branch: ${wt.branch}
Review required: false

Next steps:
1. ${step}
2. When finished, call 'land'.`;

    return {
      ok: true,
      kind,
      branch: wt.branch,
      worktree: wt.cwd,
      reviewRequired: false,
      sessionId,
      ticketSource,
      researcherPrompt,
      researcherProvider,
      instructions,
    };
  }

  const childSessionId = randomUUID();
  const implementerPrompt = buildImplementerPrompt(wt.cwd);
  const reviewerPrompt = buildReviewerPrompt(wt.cwd);
  const reviewerSessionId = randomUUID();

  const implementerStep = buildImplementerStep(wt.cwd, implementerPrompt, implementerProvider, childSessionId);
  const instructions = reviewRequired
    ? `Worktree ready at ${wt.cwd}.\nBranch: ${wt.branch}\nReview required: true\n\nNext steps:\n1. ${implementerStep}\n2. When implementation finishes, ${buildReviewerStep(wt.cwd, reviewerPrompt, reviewerProvider, reviewerSessionId)}\n3. When review passes, call 'land'.`
    : `Worktree ready at ${wt.cwd}.\nBranch: ${wt.branch}\nReview required: false\n\nNext steps:\n1. ${implementerStep}\n2. When finished, call 'land'.`;

  return {
    ok: true,
    kind,
    branch: wt.branch,
    worktree: wt.cwd,
    reviewRequired,
    sessionId,
    ticketSource,
    childSessionId,
    implementerPrompt,
    implementerProvider,
    ...(reviewRequired ? { reviewerPrompt, reviewerSessionId, reviewerProvider } : {}),
    instructions,
  };
}

export async function land(args = {}) {
  const cwd = args.cwd || process.cwd();
  const curr = await currentBranch(cwd).catch(() => null);
  if (!args.worktree && (cwd.includes(".qq-worktrees") || resolve(cwd).includes(".qq-worktrees") || (curr && curr.startsWith("architect/")))) {
    throw new Error("land must be called from the parent architect session");
  }

  const root = await mainRepoRoot(cwd);

  let worktree = args.worktree;
  let branch = args.branch;

  if (!worktree) {
    const curr = await currentBranch(cwd).catch(() => null);
    if (curr && curr !== "main" && curr !== "master" && curr !== "HEAD") {
      worktree = cwd;
      branch = curr;
    } else {
      const trees = parseWorktreePorcelain(await git(root, ["worktree", "list", "--porcelain"]));
      const candidate = trees.find((t) => t.branch && (t.branch.startsWith("architect/") || t.branch.startsWith("feat/")));
      if (candidate) {
        worktree = candidate.worktree;
        branch = candidate.branch;
      }
    }
  }

  if (!worktree) {
    throw new Error("No worktree specified or active worktree detected to land");
  }

  const result = await landWorktree(root, {
    worktree,
    branch,
    message: args.message,
    clearTicket: args.clearTicket !== false,
  });

  return {
    ok: true,
    ...result,
  };
}

// Extract a deterministic, length-capped target string from known tool parameters.
// Returns undefined if no meaningful target can be extracted.
function extractTarget(toolName, parameters) {
  if (!parameters || typeof parameters !== "object") return undefined;
  const MAX = 80;
  function cap(s) {
    if (typeof s !== "string") return undefined;
    return s.length <= MAX ? s : s.slice(0, MAX - 1) + "…";
  }
  switch (toolName) {
    case "view_file":
      return cap(parameters.AbsolutePath || parameters.path || parameters.file);
    case "run_command":
      return cap(parameters.CommandLine || parameters.command);
    case "grep_search":
      return cap(
        parameters.Query
          ? `${parameters.Query}${parameters.SearchPath ? ` in ${parameters.SearchPath}` : ""}`
          : parameters.SearchPath,
      );
    case "find_by_name":
      return cap(
        parameters.Pattern
          ? `${parameters.Pattern}${parameters.SearchDirectory ? ` in ${parameters.SearchDirectory}` : ""}`
          : parameters.SearchDirectory,
      );
    case "list_dir":
      return cap(parameters.DirectoryPath || parameters.path);
    case "zvec_grep_search":
      return cap(parameters.query || parameters.Query);
    case "read_url_content":
      return cap(parameters.Url || parameters.url);
    case "search_web":
      return cap(parameters.query || parameters.Query);
    case "steer":
      return cap(parameters.instruction || parameters.message);
    case "stage_operator_action":
      return cap(parameters.title || parameters.targetMachine);
    case "check_operator_action":
    case "cancel_operator_action":
    case "cleanup_operator_action":
      return cap(parameters.actionId);
    case "complete_task":
      return cap(parameters.response ? parameters.response.slice(0, MAX) : undefined);
    default:
      return undefined;
  }
}

function addTrajectory(target, entry) {
  // Filter out agent_response thinking steps — they add no signal and bloat context.
  if (entry.action === "agent_response") return;

  // Replace raw parameters with a capped target string.
  const { parameters, action, ...rest } = entry;
  const toolTarget = parameters !== undefined ? extractTarget(action, parameters) : rest.target;
  const clean = { action, ...rest };
  if (toolTarget !== undefined) clean.target = toolTarget;
  // Ensure parameters is never stored.
  delete clean.parameters;

  target.trajectory.push(clean);
  if (target.trajectory.length > 25) {
    target.trajectory.shift();
  }
}

// ============================================================================
// Watchdog: bounded waits, suspicion-with-evidence, dead-process reconcile
// ============================================================================
//
// The MCP client transport kills any call open past ~300s. Awaits therefore
// return status by 4:50 every time: terminal payload if finished,
// needs-decision with stall evidence if the work looks stuck, or a
// running-fine heartbeat if nothing to report. Elapsed time never fails a
// wait — there is no timeout-as-error.
//
// Suspicion is evidence-triggered (full silence past a threshold), while the
// 4:50 heartbeat is a status report forced by the harness cliff. Neither is
// a verdict: time gates evidence, it is not the verdict. Healthy work can go
// quiet that long (buffered test output, quiet reporters, one long single
// test), so the threshold means "quiet long enough that the architect should
// take a look" — never "sure it's stuck."
//
// Evaluation is on-access (check_*/await_* drive the check): no background
// timer, no sticky flag. Each call recomputes suspicion from last-activity;
// delivering a needs-decision envelope touches nothing underneath, so the
// flag inherently clears on delivery and re-arms on the next access if the
// work is still silent. Re-await keeps watching with nothing lost.

export const AWAIT_CALL_WINDOW_MS = 290_000; // 4:50 — always home before the ~300s harness cliff
export const LONG_TOOL_SUSPICION_MS = 600_000; // 10:00 absolute for known-long shell tools

// Tools whose quiet runs are legitimately long (test suites, builds). All
// other tools (and the between-tools idle state) trip suspicion after one
// quiet 4:50 call window.
export const LONG_RUNNING_TOOLS = ["run_command"];

function watchdogOverrides() {
  const o = globalThis.__QQ_TEST_WATCHDOG;
  if (o && typeof o === "object") return o;
  return {};
}

export function awaitWindowMs() {
  const o = watchdogOverrides();
  if (typeof o.awaitWindowMs === "number" && o.awaitWindowMs > 0) return o.awaitWindowMs;
  return AWAIT_CALL_WINDOW_MS;
}

export function longToolSuspicionMs() {
  const o = watchdogOverrides();
  if (typeof o.longToolMs === "number" && o.longToolMs > 0) return o.longToolMs;
  return LONG_TOOL_SUSPICION_MS;
}

// Per-tool max-duration contract: generous maxima per tool; tool started +
// nothing changed past its max = stuck-suspect (notify with evidence, never
// a verdict).
export function toolSilenceThresholdMs(toolName) {
  if (toolName && LONG_RUNNING_TOOLS.includes(toolName)) return longToolSuspicionMs();
  return awaitWindowMs();
}

function touchActivity(target, now = Date.now()) {
  target.lastActivityAt = now;
}

function appendTail(target, key, text, max = 2000) {
  if (!text) return;
  const next = (target[key] || "") + text;
  target[key] = next.length > max ? next.slice(next.length - max) : next;
}

function activeToolView(activeTool, now = Date.now()) {
  if (!activeTool) return null;
  return {
    name: activeTool.name,
    durationSeconds: Math.max(0, Math.round((now - activeTool.startedAt) / 1000)),
  };
}

// Evaluate stuck-suspicion for a running tracker (runner or execution).
// Returns null when healthy or terminal; otherwise a suspicion evidence
// object (active tool + duration, last trajectory steps, elapsed and silence
// durations). Never touches the work underneath.
export function evaluateSuspicion(tracker, now = Date.now()) {
  if (!tracker || tracker.status !== "running") return null;
  const lastActivity = tracker.lastActivityAt || tracker.startedAt || now;
  const silenceMs = Math.max(0, now - lastActivity);
  const thresholdMs = toolSilenceThresholdMs(tracker.activeTool?.name);
  if (silenceMs < thresholdMs) return null;
  const elapsedSeconds = Math.round((now - (tracker.startedAt || now)) / 1000);
  const silenceSeconds = Math.round(silenceMs / 1000);
  const thresholdSeconds = Math.round(thresholdMs / 1000);
  const toolName = tracker.activeTool?.name || "none";
  return {
    suspect: true,
    reason: `No output or tool transitions for ${silenceSeconds}s (threshold ${thresholdSeconds}s for tool '${toolName}'). Quiet long enough to take a look — not a verdict of stuck.`,
    activeTool: activeToolView(tracker.activeTool, now),
    elapsedSeconds,
    silenceSeconds,
    thresholdSeconds,
    trajectory: Array.isArray(tracker.trajectory) ? [...tracker.trajectory] : [],
  };
}

// ============================================================================
// Reactive Codex notifications: dispatch-and-yield wakeups
// ============================================================================
//
// Muse has no session queueing, so it keeps the 4:50 await contract above
// (await_runner / await_execution with heartbeat + suspicion envelopes).
// Codex (Astra) architects instead dispatch and yield their turn immediately;
// this section wakes the idle session only when something needs it:
//
// 1. Terminal wakeup: an execution or runner reaches completed/failed.
//    Per-transition hooks call notifyTerminal exactly once (deduped by a
//    tracker flag); the sweeper below backstops any transition the hooks
//    missed (e.g. a dead process reconciled off the hot path).
// 2. Suspicion wakeup: the background sweeper re-evaluates running work with
//    the same evaluateSuspicion evidence contract. A trip queues a single
//    needs-decision notification; the child is never touched. Re-arming only
//    happens after SUSPICION_RENOTIFY_MS of continued silence, or immediately
//    on recovery-then-new-stall (recovery clears the marker).
//
// Delivery is `codex queue --thread <threadId> --message <text>` via argv
// (never a shell string, so JSON/markdown cannot corrupt). Outside a Codex
// session there is no thread to wake, so every entry point resolves the
// thread id first and quietly skips when none exists. Nothing here ever
// throws into the pipeline: failures degrade to a { notified: false } result.
//
// Note on the watchdog header above ("no background timer, no sticky flag"):
// that still describes the check_*/await_* contract — every read recomputes
// suspicion from last-activity and the notifiedSuspicionAt marker gates only
// queue delivery, never what check/await report.

export const NOTIFY_SWEEP_INTERVAL_MS = 15_000; // background suspicion sweep cadence
export const SUSPICION_RENOTIFY_MS = 1_800_000; // 30m re-arm while a stall persists

export function sweepIntervalMs() {
  const o = watchdogOverrides();
  if (typeof o.sweepMs === "number" && o.sweepMs > 0) return o.sweepMs;
  return NOTIFY_SWEEP_INTERVAL_MS;
}

export function suspicionRearmMs() {
  const o = watchdogOverrides();
  if (typeof o.suspicionRearmMs === "number" && o.suspicionRearmMs > 0) return o.suspicionRearmMs;
  return SUSPICION_RENOTIFY_MS;
}

// Map of ticket sessionId (or caller session ID) -> resolved Codex threadId
export const DETECTED_CODEX_THREADS = new Map();
// Map of ticket sessionId (or caller session ID) -> resolved CODEX_HOME directory
export const DETECTED_CODEX_HOMES = new Map();

// Discover the active CODEX_HOME by inspecting ancestor process environments
// or open rollout file paths.
export function findCodexHomeFromProc(startPid = process.ppid) {
  if (!startPid) return null;
  if (process.env.CODEX_HOME) return process.env.CODEX_HOME;
  let currPid = startPid;
  for (let depth = 0; depth < 4; depth++) {
    try {
      try {
        const environ = readFileSync(`/proc/${currPid}/environ`, "utf8");
        for (const entry of environ.split("\0")) {
          if (entry.startsWith("CODEX_HOME=")) {
            const val = entry.slice("CODEX_HOME=".length);
            if (val) return val;
          }
        }
      } catch {}

      const fdDir = `/proc/${currPid}/fd`;
      if (existsSync(fdDir)) {
        const fds = readdirSync(fdDir);
        for (const fd of fds) {
          try {
            const target = readlinkSync(`${fdDir}/${fd}`);
            const m = target.match(/^(.*?)\/sessions(?:\/.*)?\/rollout-.*\.jsonl$/);
            if (m && m[1]) return m[1];
          } catch {}
        }
      }

      const stat = readFileSync(`/proc/${currPid}/stat`, "utf8");
      const lastParen = stat.lastIndexOf(")");
      if (lastParen !== -1) {
        const rest = stat.slice(lastParen + 2);
        const fields = rest.split(" ");
        const ppid = parseInt(fields[1], 10);
        if (ppid > 1 && ppid !== currPid) currPid = ppid;
        else break;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return null;
}

// Discover the active Codex thread ID by walking ancestor process descriptors
// for an open rollout JSONL file (standard Linux procfs environment).
export function findCodexThreadFromProc(startPid = process.ppid) {
  if (globalThis.__QQ_TEST_DISABLE_PROC_THREAD) return null;
  if (!startPid) return null;
  let currPid = startPid;
  for (let depth = 0; depth < 4; depth++) {
    try {
      const fdDir = `/proc/${currPid}/fd`;
      if (existsSync(fdDir)) {
        const fds = readdirSync(fdDir);
        for (const fd of fds) {
          try {
            const target = readlinkSync(`${fdDir}/${fd}`);
            const m = target.match(/rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/);
            if (m) {
              const homeMatch = target.match(/^(.*?)\/sessions(?:\/.*)?\/rollout-/);
              if (homeMatch && homeMatch[1] && !process.env.CODEX_HOME) {
                process.env.CODEX_HOME = homeMatch[1];
              }
              return m[1];
            }
          } catch {}
        }
      }
      const stat = readFileSync(`/proc/${currPid}/stat`, "utf8");
      const lastParen = stat.lastIndexOf(")");
      if (lastParen !== -1) {
        const rest = stat.slice(lastParen + 2);
        const fields = rest.split(" ");
        const ppid = parseInt(fields[1], 10);
        if (ppid > 1 && ppid !== currPid) currPid = ppid;
        else break;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return null;
}

// Resolve the Codex thread to wake for a tracker session. Precedence:
// explicit test thread > session map > Codex-provided env > recorded proc thread.
// Returns null outside a Codex session (Muse path, plain CLI runs, most tests).
export function resolveCodexThreadId(sessionId) {
  const testThread = globalThis.__QQ_TEST_CODEX_THREAD;
  if (typeof testThread === "string" && testThread) return testThread;
  const map = globalThis.__QQ_CODEX_THREAD_MAP;
  if (sessionId != null && map) {
    if (map instanceof Map && map.has(sessionId)) return map.get(sessionId);
    if (!(map instanceof Map) && typeof map === "object" && map[sessionId]) return map[sessionId];
  }
  const env = process.env;
  if (env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.CODEX_CONVERSATION_ID) {
    return env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.CODEX_CONVERSATION_ID;
  }
  if (sessionId != null && DETECTED_CODEX_THREADS.has(sessionId)) {
    return DETECTED_CODEX_THREADS.get(sessionId);
  }
  const procThread = findCodexThreadFromProc();
  if (procThread) {
    if (sessionId != null) DETECTED_CODEX_THREADS.set(sessionId, procThread);
    return procThread;
  }
  return null;
}

function runCodexQueue(bin, args, env = process.env) {
  return new Promise((resolvePromise) => {
    let child;
    let stderr = "";
    try {
      child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"], env });
    } catch (err) {
      resolvePromise({ ok: false, error: err });
      return;
    }
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }, 15_000);
    if (typeof timer.unref === "function") timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, error: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ ok: true });
      else resolvePromise({ ok: false, error: new Error(`codex queue exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ""}`) });
    });
  });
}

// Queue one message to the architect session. Never throws: without a Codex
// thread (or with an empty message) it reports notified:false instead.
// Tests capture deliveries via globalThis.__QQ_TEST_NOTIFY_HANDLER.
export async function notifySession(sessionId, message, opts = {}) {
  const text = String(message ?? "");
  if (!text) return { notified: false, reason: "empty-message" };
  const threadId = opts.threadId || resolveCodexThreadId(sessionId);
  const testHandler = globalThis.__QQ_TEST_NOTIFY_HANDLER;
  if (typeof testHandler === "function") {
    try {
      await testHandler({
        sessionId: sessionId || null,
        threadId: threadId || sessionId || "test-thread",
        message: text,
        kind: opts.kind || null,
        trackerId: opts.trackerId || null,
      });
    } catch {
      /* test hooks must never break the pipeline */
    }
    return { notified: true, via: "test-hook", threadId: threadId || sessionId || "test-thread" };
  }
  if (!threadId) return { notified: false, reason: "no-codex-context" };
  const bin = process.env.QQ_CODEX_BIN || "codex";
  const queueEnv = { ...process.env };
  const codexHome = opts.codexHome
    || (sessionId ? DETECTED_CODEX_HOMES.get(sessionId) : null)
    || process.env.CODEX_HOME
    || findCodexHomeFromProc();
  if (codexHome) {
    queueEnv.CODEX_HOME = codexHome;
    if (!process.env.CODEX_HOME) process.env.CODEX_HOME = codexHome;
  }
  const res = await runCodexQueue(bin, ["queue", "--thread", threadId, "--message", text], queueEnv);
  if (res.ok) return { notified: true, via: "codex-queue", threadId };
  console.error(`[qq-workflows] failed to queue message to codex thread ${threadId}:`, res.error?.message);
  return { notified: false, reason: res.error?.message || "queue-failed", threadId };
}

function trackerSessionId(tracker) {
  return tracker?.sessionId || tracker?.architectSessionId || null;
}

function trackerRef(tracker) {
  return tracker?.id || tracker?.runnerId || null;
}

function trackerElapsedSeconds(tracker) {
  return Math.max(0, Math.round((Date.now() - (tracker?.startedAt || Date.now())) / 1000));
}

function trajectoryLines(trajectory, limit = 8) {
  const steps = Array.isArray(trajectory) ? trajectory.slice(-limit) : [];
  return steps.map((s) => {
    const action = s?.action || "step";
    const extra = s?.target
      ? ` ${s.target}`
      : s?.message
        ? ` ${String(s.message).slice(0, 80)}`
        : "";
    return `- ${action}${extra}`.slice(0, 160);
  });
}

export function buildExecutionTerminalMessage(execution) {
  const id = execution?.id || "unknown";
  const kind = execution?.kind || "unknown";
  const elapsed = trackerElapsedSeconds(execution);
  const branch = execution?.branch ? `\nBranch: ${execution.branch}` : "";
  if (execution?.status === "completed") {
    const result = execution.result || {};
    const landing = result.landingOutcome || {};
    const landingBits = [];
    if (landing.method) landingBits.push(`method=${landing.method}`);
    if (landing.pr) landingBits.push(`pr=${landing.pr}`);
    if (landing.mergeSha) landingBits.push(`sha=${String(landing.mergeSha).slice(0, 12)}`);
    const landingLine = landingBits.length ? `\nLanding: ${landingBits.join(" ")}` : "";
    const story = result.verifiedStory ? `\n\n${result.verifiedStory}` : "";
    const impl = result.implementerSummary
      ? `\n\nImplementer summary:\n${sanitizeHeadTail(String(result.implementerSummary), { headLen: 2000, tailLen: 2000 })}`
      : "";
    const review = result.reviewerSummary
      ? `\n\nReviewer summary:\n${sanitizeHeadTail(String(result.reviewerSummary), { headLen: 2000, tailLen: 2000 })}`
      : "";
    return `Execution ${id} (${kind}) completed in ${elapsed}s — verified and landed.${branch}${landingLine}${story}${impl}${review}`;
  }
  const err = execution?.error || {};
  const phase = execution?.phase || err.phase || "unknown";
  const message = err.message || "unknown error";
  const extras = [];
  if (err.exitCode !== undefined && err.exitCode !== null) extras.push(`exitCode=${err.exitCode}`);
  if (err.stderr) extras.push(`stderr:\n${sanitizeHeadTail(String(err.stderr), { headLen: 500, tailLen: 500 })}`);
  if (err.findings) extras.push(`findings:\n${sanitizeHeadTail(String(err.findings), { headLen: 1000, tailLen: 1000 })}`);
  const extra = extras.length ? `\n\n${extras.join("\n\n")}` : "";
  const wt = execution?.worktree ? `\nWorktree: ${execution.worktree}` : "";
  return `Execution ${id} (${kind}) failed in phase '${phase}' after ${elapsed}s: ${message}${branch}${wt}${extra}`;
}

export function buildRunnerTerminalMessage(runner) {
  const id = runner?.runnerId || runner?.id || "unknown";
  const elapsed = trackerElapsedSeconds(runner);
  if (runner?.status === "completed") {
    const result = runner.result;
    let findings;
    let dataPoints = [];
    if (typeof result === "string") {
      findings = result;
    } else if (result && typeof result === "object") {
      findings = result.response ?? JSON.stringify(result);
      if (Array.isArray(result.data_points)) dataPoints = result.data_points;
    } else {
      findings = String(result ?? "(no output)");
    }
    const dp = dataPoints.length ? `\n\ndata_points:\n${dataPoints.map((d) => `- ${d}`).join("\n")}` : "";
    const findingsStr = String(findings);
    let findingsBlock;
    if (findingsStr.length <= 32_768) {
      findingsBlock = findingsStr;
    } else {
      findingsBlock = `${sanitizeHeadTail(findingsStr, { headLen: 16_000, tailLen: 16_000 })}\n\n[Findings shortened to 32,000 chars. Full findings available via check_runner for runner '${id}'.]`;
    }
    return `Runner ${id} completed in ${elapsed}s.\n\nFindings:\n${findingsBlock}${dp}`;
  }
  const err = runner?.error || {};
  const message = err.message || "unknown error";
  const extras = [];
  if (err.exitCode !== undefined && err.exitCode !== null) extras.push(`exitCode=${err.exitCode}`);
  if (err.stderr) extras.push(`stderr:\n${sanitizeHeadTail(String(err.stderr), { headLen: 500, tailLen: 500 })}`);
  const extra = extras.length ? `\n\n${extras.join("\n\n")}` : "";
  const tail = runner?.outputTail && String(runner.outputTail).trim()
    ? `\n\nLast output:\n${sanitizeHeadTail(String(runner.outputTail).trim(), { headLen: 500, tailLen: 500 })}`
    : "";
  return `Runner ${id} failed after ${elapsed}s: ${message}${extra}${tail}`;
}

export function buildSuspicionMessage(kind, tracker, suspicion) {
  const label = kind === "execution" ? "Execution" : "Runner";
  const id = trackerRef(tracker) || "unknown";
  const phase = kind === "execution" && tracker?.phase ? ` (phase '${tracker.phase}')` : "";
  const reason = suspicion?.reason || "quiet past threshold";
  const elapsed = suspicion?.elapsedSeconds ?? trackerElapsedSeconds(tracker);
  const silence = suspicion?.silenceSeconds ?? elapsed;
  const threshold = suspicion?.thresholdSeconds ?? "?";
  const tool = suspicion?.activeTool
    ? `${suspicion.activeTool.name} (${suspicion.activeTool.durationSeconds}s)`
    : "none";
  const traj = trajectoryLines(suspicion?.trajectory);
  const trajBlock = traj.length ? `\n\nRecent trajectory:\n${traj.join("\n")}` : "";
  const inspect = kind === "execution" ? "check_execution" : "check_runner";
  const steer = kind === "execution" ? "" : " For runners you can steer_runner or cancel_runner.";
  return `[needs-decision] ${label} ${id}${phase} may be stalled: ${reason}\n\nStatus: running — process left alive, nothing was killed.\nElapsed: ${elapsed}s, silence: ${silence}s (threshold ${threshold}s).\nActive tool: ${tool}${trajBlock}\n\nInspect with ${inspect}.${steer} No action needed if the work is healthy.`;
}

// Notify once when a tracker reaches a terminal state. Completed/failed only:
// cancelled is architect-initiated (no wakeup needed) and running is never
// terminal. The flag is set synchronously so concurrent transition paths
// (event handler + sweeper backstop) cannot double-notify. Never throws.
export async function notifyTerminal(tracker, kind) {
  try {
    if (!tracker || tracker.notifiedTerminal) return { notified: false, reason: "already-notified" };
    if (tracker.status !== "completed" && tracker.status !== "failed") {
      return { notified: false, reason: "not-terminal" };
    }
    tracker.notifiedTerminal = true;
    const message = kind === "execution"
      ? buildExecutionTerminalMessage(tracker)
      : buildRunnerTerminalMessage(tracker);
    // Persist the complete terminal report BEFORE notifying: the notification is
    // a bounded delivery, never the only copy of the result.
    const report = persistTrackerReport(tracker, kind);
    const stateDir = trackerStateDir(tracker);
    const sessionDir = join(stateDir, kind === "execution" ? "executions" : "runners");
    const routed = await routeNotification({
      stateDir: sessionDir,
      eventId: `${kind}:${trackerRef(tracker) || "unknown"}:terminal`,
      jobId: trackerRef(tracker) || null,
      role: kind,
      workflow: { sessionKey: trackerSessionId(tracker) || null, sessionId: trackerSessionId(tracker) || null },
      text: message,
      reportText: buildTrackerReport(tracker, kind),
      reportId: report?.reportId ?? null,
      reportChars: report?.chars ?? 0,
      transport: {
        name: "codex-queue",
        deliver: async () =>
          await notifySession(trackerSessionId(tracker), message, {
            kind: `${kind}.terminal`,
            trackerId: trackerRef(tracker),
          }),
      },
      // Compatibility: an in-memory MCP tracker keeps its own notified flag and
      // process-scoped dedupe, while the durable record stays inspectable.
      dedupe: "process",
      cap: MCP_NOTIFY_CAP,
    });
    if (routed.state === "duplicate") {
      return { notified: false, reason: "duplicate-event", eventId: routed.eventId };
    }
    const raw = routed.transportResult ?? {};
    return {
      notified: Boolean(raw.notified),
      ...(raw.notified
        ? { via: raw.via ?? "codex-queue", threadId: raw.threadId ?? null }
        : { reason: raw.reason ?? routed.delivery?.reason ?? "delivery-failed" }),
      eventId: routed.eventId,
      reportId: report?.reportId ?? null,
      deliveryState: routed.state,
    };
  } catch (err) {
    return { notified: false, reason: err?.message || String(err) };
  }
}

// Notify once per stall episode. The marker is set synchronously (same
// single-flight rationale as notifyTerminal); the sweeper clears it on
// recovery and re-arms it after SUSPICION_RENOTIFY_MS. Never throws.
export async function notifySuspicion(tracker, kind, suspicion, now = Date.now()) {
  try {
    if (!tracker || tracker.status !== "running" || !suspicion) {
      return { notified: false, reason: "not-suspicious" };
    }
    tracker.notifiedSuspicionAt = now;
    const message = buildSuspicionMessage(kind, tracker, suspicion);
    return await notifySession(trackerSessionId(tracker), message, {
      kind: `${kind}.suspicion`,
      trackerId: trackerRef(tracker),
    });
  } catch (err) {
    return { notified: false, reason: err?.message || String(err) };
  }
}

async function sweepTracker(tracker, kind, now, summary) {
  if (tracker.status === "completed" || tracker.status === "failed") {
    const res = await notifyTerminal(tracker, kind);
    if (res?.notified) summary.terminalNotified += 1;
    return;
  }
  if (tracker.status !== "running") return;
  const suspicion = evaluateSuspicion(tracker, now);
  if (!suspicion) {
    // Recovery clears the marker so a genuinely new stall notifies promptly.
    if (tracker.notifiedSuspicionAt !== undefined) delete tracker.notifiedSuspicionAt;
    return;
  }
  if (
    typeof tracker.notifiedSuspicionAt === "number" &&
    now - tracker.notifiedSuspicionAt < suspicionRearmMs()
  ) {
    return;
  }
  const res = await notifySuspicion(tracker, kind, suspicion, now);
  if (res?.notified) summary.suspicionNotified += 1;
}

// One sweep over all live trackers: backstop terminal wakeups the transition
// hooks missed, reconcile dead runner processes, and queue a single
// needs-decision notification per stall episode. Read-only toward the work
// itself — no process is ever signalled here. Never throws.
export async function sweepNotifications(now = Date.now()) {
  const summary = { executions: 0, runners: 0, suspicionNotified: 0, terminalNotified: 0 };
  for (const execution of EXECUTIONS.values()) {
    try {
      summary.executions += 1;
      await sweepTracker(execution, "execution", now, summary);
    } catch {
      /* one bad tracker must never wedge the sweep */
    }
  }
  for (const runner of RUNNERS.values()) {
    try {
      summary.runners += 1;
      reconcileDeadRunner(runner);
      await sweepTracker(runner, "runner", now, summary);
    } catch {
      /* one bad tracker must never wedge the sweep */
    }
  }
  return summary;
}

let suspicionSweeperTimer = null;

// Start the background suspicion sweeper. The interval is unref'd so it never
// keeps the process alive on SIGTERM or stdin EOF. Returns the timer handle.
export function startSuspicionSweeper({ intervalMs } = {}) {
  const ms = typeof intervalMs === "number" && intervalMs > 0 ? intervalMs : sweepIntervalMs();
  const timer = setInterval(() => {
    void sweepNotifications().catch(() => {});
  }, ms);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

export function ensureSuspicionSweeperStarted(opts) {
  if (!suspicionSweeperTimer) suspicionSweeperTimer = startSuspicionSweeper(opts);
  return suspicionSweeperTimer;
}

export function stopSuspicionSweeper() {
  if (suspicionSweeperTimer) {
    clearInterval(suspicionSweeperTimer);
    suspicionSweeperTimer = null;
  }
}

// 99%+ auto-case set: cases where diagnosing plus reporting without asking
// is 99%+ accurate. When in doubt, notify (needs-decision) instead.
//
// 1. dead-process reconcile — the helper process has observably exited
//    (kernel-reported exitCode/signalCode) while our tracker still says
//    "running". Nothing is killed (there is nothing left to kill — we only
//    read the exit fields, never call kill()); reporting the exit code plus
//    the last output is factual bookkeeping, not a judgment call.
//    Rationale for 99%+: exit status is kernel truth, not inference; the
//    only alternative (leaving a dead tracker "running" forever) is
//    strictly worse. No live process is ever touched by this path.
//
// No other auto-cases exist today. In particular, silence-past-threshold
// is notify-first (needs-decision, process left alive) because healthy work
// (buffered test output, quiet reporters, one long single test) can go
// quiet that long.
export function reconcileDeadRunner(runner) {
  if (!runner || runner.status !== "running") return null;
  const proc = runner.process;
  if (!proc) return null;
  const exitCode = proc.exitCode;
  const signalCode = proc.signalCode;
  const exited = typeof exitCode === "number" || typeof signalCode === "string";
  if (!exited) return null;
  // Dead: fix the books to match reality. Terminal transitions only out of
  // "running" (caller guarantees this); never overwrite another terminal
  // state and never signal the (already dead) process.
  if (signalCode === "SIGTERM" || signalCode === "SIGINT") {
    runner.status = "cancelled";
    runner.activeTool = null;
    cleanupRunnerFiles(runner);
    return { reconciled: true, status: "cancelled", signalCode };
  }
  if (exitCode === 0) {
    if (runner.resultFile && existsSync(runner.resultFile)) {
      const loaded = readAuthoritativeRunnerResult(runner);
      if (loaded.ok) {
        runner.status = "completed";
        runner.result = loaded.result;
        runner.activeTool = null;
        cleanupRunnerFiles(runner);
        return { reconciled: true, status: "completed", exitCode };
      } else {
        runner.status = "failed";
        runner.error = {
          message: `Runner completed with transport error: ${loaded.error}`,
          exitCode,
          stderr: sanitizeHeadTail((runner.stderrTail || "").trim()),
          outputTail: sanitizeHeadTail((runner.outputTail || "").trim()),
        };
        runner.activeTool = null;
        cleanupRunnerFiles(runner);
        return { reconciled: true, status: "failed", exitCode };
      }
    }
    runner.status = "completed";
    if (runner.result == null) {
      const tail = (runner.outputTail || "").trim();
      runner.result = tail || "";
    }
    runner.activeTool = null;
    cleanupRunnerFiles(runner);
    return { reconciled: true, status: "completed", exitCode };
  }
  runner.status = "failed";
  runner.error = {
    message: `Runner process exited with code ${exitCode}`,
    exitCode,
    stderr: sanitizeHeadTail((runner.stderrTail || "").trim()),
    outputTail: sanitizeHeadTail((runner.outputTail || "").trim()),
  };
  runner.activeTool = null;
  cleanupRunnerFiles(runner);
  return { reconciled: true, status: "failed", exitCode };
}

// ============================================================================
// Runner helper implementation
// ============================================================================

export const RUNNERS = new Map();

// Per-runner complete_task state: tracks whether each runner called complete_task.
// Keyed by runnerId. Also used by the Stop hook for sub-agent tracking.
export const COMPLETE_TASK_REGISTRY = new Map();

// The MCP compatibility path keeps its long-standing 32,768-character delivery
// budget; the Architect path uses the observed 16,384-character transport cap.
export const MCP_NOTIFY_CAP = 32_768;

// Authoritative worker-result transport lives in workflow/results.mjs so the
// MCP adapter and the native pi Architect share one implementation.
export {
  COMPLETE_TASK_RESPONSE_MAX,
  COMPLETE_TASK_DATA_POINTS_MAX,
  COMPLETE_TASK_DATA_POINT_LEN_MAX,
  cleanupRunnerFiles,
  validateRunnerResultPayload,
};

// Registry-bound read for the in-memory complete_task registry used by MCP
// clients and test doubles.
export function readAuthoritativeRunnerResult(runner) {
  return readAuthoritativeResultFromStore(runner, { registry: COMPLETE_TASK_REGISTRY });
}

// Tracker state directory: the durable job/report store for the repository the
// tracker is working in. `QQ_WORKFLOW_STATE_DIR` overrides it (tests and
// non-default deployments).
export function trackerStateDir(tracker, { cwd = null } = {}) {
  const root = cwd || tracker?.cwd || process.cwd();
  return stateDirFor(root, process.env);
}

// Full terminal text for a tracker, used to persist the complete report before
// any bounded notification is sent.
export function buildTrackerReport(tracker, kind) {
  if (!tracker) return "";
  if (kind === "execution") {
    const payload = {
      id: trackerRef(tracker),
      kind: tracker.kind ?? null,
      status: tracker.status,
      phase: tracker.phase ?? null,
      branch: tracker.branch ?? null,
      worktree: tracker.worktree ?? null,
      error: tracker.error ?? null,
      result: tracker.result ?? null,
    };
    return JSON.stringify(payload, null, 2);
  }
  const error = tracker.error ? `\n\nerror:\n${JSON.stringify(tracker.error, null, 2)}` : "";
  return `${renderRunnerFindings(tracker.result)}${error}`;
}

/**
 * Persist the complete terminal report for a tracker. Idempotent per tracker.
 * Returns the durable reference (or null when there is nothing to persist).
 */
export function persistTrackerReport(tracker, kind) {
  if (!tracker) return null;
  if (tracker.durableReport) return tracker.durableReport;
  const text = buildTrackerReport(tracker, kind);
  if (!text || !text.trim()) return null;
  try {
    const saved = saveReport(trackerStateDir(tracker), {
      jobId: trackerRef(tracker) || "unknown",
      role: kind,
      text,
    });
    tracker.durableReport = { reportId: saved.reportId, chars: saved.chars, path: saved.path };
    return tracker.durableReport;
  } catch (err) {
    console.error("[qq-workflows] failed to persist terminal report:", err?.message);
    return null;
  }
}

export async function dispatchRunner(args = {}) {
  const { task, targetPaths, cwd = process.cwd() } = args;
  if (!task || typeof task !== "string" || !task.trim()) {
    throw new Error("task is required");
  }

  const runnerId = randomUUID();
  const startedAt = Date.now();
  const resultFile = join(tmpdir(), `qq-runner-result-${runnerId}.json`);
  try { rmSync(resultFile, { force: true }); } catch {}
  const runner = {
    id: runnerId,
    runnerId,
    task,
    targetPaths: Array.isArray(targetPaths) ? targetPaths : [],
    cwd,
    sessionId: args.sessionId ?? args.architectSessionId ?? null,
    status: "running",
    startedAt,
    lastActivityAt: startedAt,
    activeTool: null,
    trajectory: [],
    result: null,
    error: null,
    process: null,
    outputTail: "",
    stderrTail: "",
    resultFile,
  };
  if (runner.sessionId) {
    const procThread = findCodexThreadFromProc();
    if (procThread) DETECTED_CODEX_THREADS.set(runner.sessionId, procThread);
    const procHome = findCodexHomeFromProc();
    if (procHome) {
      DETECTED_CODEX_HOMES.set(runner.sessionId, procHome);
      if (!process.env.CODEX_HOME) process.env.CODEX_HOME = procHome;
    }
  }
  RUNNERS.set(runnerId, runner);

  startRunnerProcess(runner);

  return { ok: true, runnerId, status: "running" };
}

function startRunnerProcess(runner) {
  if (globalThis.__QQ_TEST_RUNNER_HANDLER) {
    try {
      globalThis.__QQ_TEST_RUNNER_HANDLER(runner);
    } catch (err) {
      runner.status = "failed";
      runner.error = { message: err.message };
      cleanupRunnerFiles(runner);
      void notifyTerminal(runner, "runner");
    }
    return;
  }

  let prompt = runner.task;
  if (runner.targetPaths.length > 0) {
    prompt += `\n\nTarget paths to inspect:\n${runner.targetPaths.join("\n")}`;
  }

  const bin = process.env.QQ_RUNNER_BIN || process.env.REAL_AGY_BIN || "agy";
  const runnerModel = process.env.QQ_RUNNER_MODEL || "gemini-3.8-flash-high";
  const childArgs = [
    "--agent", "runner",
    "--model", runnerModel,
    "--dangerously-skip-permissions",
    "--output-format", "stream-json",
    "--print-timeout", "60m",
    "--print", prompt,
  ];

  let child;
  try {
    child = spawn(bin, childArgs, {
      cwd: runner.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        QQ_RUNNER_ID: runner.runnerId,
        QQ_RUNNER_RESULT_FILE: runner.resultFile,
      },
    });
  } catch (err) {
    runner.status = "failed";
    runner.error = { message: err.message };
    cleanupRunnerFiles(runner);
    void notifyTerminal(runner, "runner");
    return;
  }
  runner.process = child;

  const rl = createInterface({ input: child.stdout });
  let rawOutput = "";
  let stderrBuf = "";

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    rawOutput += line + "\n";
    // Any output byte is liveness: output flowing = working.
    touchActivity(runner);
    appendTail(runner, "outputTail", line + "\n");
    try {
      const event = JSON.parse(trimmed);
      handleRunnerEvent(runner, event);
    } catch {
      addTrajectory(runner, { action: "log", message: trimmed.slice(0, 200), timestamp: Date.now() });
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    stderrBuf += text;
    touchActivity(runner);
    appendTail(runner, "stderrTail", text);
  });

  child.on("close", (code, signal) => {
    // Terminal-overwrite guard: late or duplicate process events must never
    // overwrite an already-recorded terminal state. Transition out of
    // "running" only.
    if (runner.status !== "running") {
      runner.activeTool = null;
      cleanupRunnerFiles(runner);
      return;
    }
    touchActivity(runner);
    if (signal === "SIGTERM" || signal === "SIGINT") {
      runner.status = "cancelled";
      runner.activeTool = null;
      cleanupRunnerFiles(runner);
      return;
    }
    if (runner.resultFile && existsSync(runner.resultFile)) {
      // Ingestion keeps the pinned 32,768-character complete_task contract but
      // never discards the only copy of an over-cap report: the full response is
      // spilled to the durable report store and the runner still completes.
      const loaded = acceptRunnerResult(
        runner,
        {
          registry: COMPLETE_TASK_REGISTRY,
          stateDir: trackerStateDir(runner),
          saveReport: (dir, options) => saveReport(dir, options),
        },
      );
      if (loaded.ok) {
        runner.status = "completed";
        runner.result = loaded.result;
        if (loaded.report) runner.spilledReport = loaded.report;
      } else {
        runner.status = "failed";
        runner.error = {
          message: `Runner completed with transport error: ${loaded.error}`,
          exitCode: code,
          stderr: sanitizeHeadTail(stderrBuf.trim()),
        };
      }
    } else if (code === 0) {
      runner.status = "completed";
      if (runner.result == null) {
        runner.result = rawOutput.trim();
      }
    } else {
      runner.status = "failed";
      runner.error = {
        message: `Runner process exited with code ${code}`,
        exitCode: code,
        stderr: sanitizeHeadTail(stderrBuf.trim()),
      };
    }
    runner.activeTool = null;
    cleanupRunnerFiles(runner);
    void notifyTerminal(runner, "runner");
  });

  child.on("error", (err) => {
    if (runner.status !== "running") return;
    runner.status = "failed";
    runner.error = {
      message: err.message,
      stderr: sanitizeHeadTail(stderrBuf.trim()),
    };
    runner.activeTool = null;
    cleanupRunnerFiles(runner);
    void notifyTerminal(runner, "runner");
  });
}

export function handleRunnerEvent(runner, event) {
  if (event.event === "step_update" && event.step_update) {
    const su = event.step_update;
    // Any transition is liveness.
    touchActivity(runner);
    if (su.step_type === "tool") {
      if (su.state === "ACTIVE") {
        runner.activeTool = {
          name: su.tool_name,
          startedAt: Date.now(),
        };
      } else if (su.state === "DONE") {
        runner.activeTool = null;
        addTrajectory(runner, {
          action: su.tool_name,
          parameters: su.tool_info?.parameters,
          duration: su.duration_seconds,
          timestamp: Date.now(),
        });
        // Immediate termination on complete_task: mark completed and kill child process.
        // Terminal-overwrite guard: only out of "running".
        const isCompleteTask = su.tool_name === "complete_task" ||
          (su.tool_name === "call_mcp_tool" && (
            su.tool_info?.parameters?.ToolName === "complete_task" ||
            su.tool_info?.parameters?.toolName === "complete_task"
          ));
        if (isCompleteTask && runner.status === "running") {
          const loaded = readAuthoritativeRunnerResult(runner);
          if (loaded.ok) {
            runner.status = "completed";
            runner.result = loaded.result;
          } else {
            runner.status = "failed";
            runner.error = {
              message: `Runner complete_task failed: ${loaded.error}`,
            };
          }
          runner.activeTool = null;
          if (runner.process) {
            try { runner.process.kill("SIGTERM"); } catch {}
          }
          void notifyTerminal(runner, "runner");
        }
      }
    } else if (su.step_type === "agent_response") {
      if (su.state === "ACTIVE") {
        runner.activeTool = {
          name: "thinking",
          startedAt: Date.now(),
        };
      } else if (su.state === "DONE") {
        runner.activeTool = null;
        addTrajectory(runner, {
          action: "agent_response",
          duration: su.duration_seconds,
          timestamp: Date.now(),
        });
      }
    }
  } else if (event.event === "result" && event.result) {
    touchActivity(runner);
    // Terminal-overwrite guard: only out of "running".
    if (runner.status !== "running") {
      runner.activeTool = null;
      return;
    }
    const res = event.result;
    if (res.status === "SUCCESS") {
      runner.status = "completed";
      runner.result = res.response;
    } else {
      runner.status = "failed";
      runner.error = {
        message: res.error || "Runner reported error",
        details: res,
      };
    }
    runner.activeTool = null;
    void notifyTerminal(runner, "runner");
  }
}

export async function checkRunner(args = {}) {
  const runnerId = args.runnerId || args.id;
  if (!runnerId) throw new Error("runnerId is required");
  const runner = RUNNERS.get(runnerId);
  if (!runner) throw new Error(`no runner found for id '${runnerId}'`);

  // Dead-process reconcile first: fix the books before reporting.
  reconcileDeadRunner(runner);

  const now = Date.now();
  const elapsedSeconds = Math.round((now - runner.startedAt) / 1000);
  const activeTool = activeToolView(runner.activeTool, now);

  if (runner.status !== "running") {
    return {
      runnerId: runner.id,
      status: runner.status,
      elapsedSeconds,
      activeTool,
      trajectory: [...runner.trajectory],
      suspicion: null,
      stuckSuspect: false,
      // Completed runners include the full unabridged result so clients
      // without await_runner (e.g. Codex dispatch-and-yield) can inspect it.
      ...(runner.status === "completed" ? { result: runner.result } : {}),
      ...(runner.status === "failed" ? { error: runner.error } : {}),
    };
  }

  const suspicion = evaluateSuspicion(runner, now);
  const silenceSeconds = Math.max(0, Math.round((now - (runner.lastActivityAt || runner.startedAt)) / 1000));

  return {
    runnerId: runner.id,
    status: runner.status,
    elapsedSeconds,
    silenceSeconds,
    activeTool,
    trajectory: [...runner.trajectory],
    suspicion,
    stuckSuspect: suspicion !== null,
  };
}

export async function steerRunner(args = {}) {
  const runnerId = args.runnerId || args.id;
  const instruction = args.instruction;
  if (!runnerId) throw new Error("runnerId is required");
  if (!instruction || typeof instruction !== "string") throw new Error("instruction is required");
  const runner = RUNNERS.get(runnerId);
  if (!runner) throw new Error(`no runner found for id '${runnerId}'`);
  if (runner.status !== "running") {
    throw new Error(`cannot steer runner in status '${runner.status}'`);
  }

  addTrajectory(runner, {
    action: "steer",
    instruction,
    timestamp: Date.now(),
  });

  if (runner.onSteer && typeof runner.onSteer === "function") {
    runner.onSteer(instruction);
  }

  if (runner.process && runner.process.stdin && runner.process.stdin.writable) {
    try {
      runner.process.stdin.write(`${instruction}\n`);
    } catch {
      /* ignore pipe error */
    }
  }

  return { ok: true, runnerId, steered: true };
}

export async function cancelRunner(args = {}) {
  const runnerId = args.runnerId || args.id;
  if (!runnerId) throw new Error("runnerId is required");
  const runner = RUNNERS.get(runnerId);
  if (!runner) throw new Error(`no runner found for id '${runnerId}'`);

  if (runner.status === "running") {
    runner.status = "cancelled";
    runner.activeTool = null;
    addTrajectory(runner, { action: "cancelled", timestamp: Date.now() });
    if (runner.process) {
      try {
        runner.process.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    } else {
      cleanupRunnerFiles(runner);
    }
  }

  return { ok: true, runnerId, status: "cancelled" };
}

export async function awaitRunner(args = {}) {
  const runnerId = args.runnerId || args.id;
  if (!runnerId) throw new Error("runnerId is required");
  const runner = RUNNERS.get(runnerId);
  if (!runner) throw new Error(`no runner found for id '${runnerId}'`);
  // Legacy timeoutMs is accepted but never fails the wait: awaits return
  // status by 4:50 every time (heartbeat, suspicion, or terminal). There is
  // no timeout-as-error.

  const windowMs = awaitWindowMs();
  const start = Date.now();
  for (;;) {
    // Dead-process reconcile on every pass: a dead helper reports factually.
    reconcileDeadRunner(runner);

    if (runner.status === "completed") {
      return {
        ok: true,
        runnerId,
        status: "completed",
        result: runner.result,
      };
    }
    if (runner.status === "cancelled") {
      const err = new Error(`Runner '${runnerId}' was cancelled`);
      err.status = "cancelled";
      throw err;
    }
    if (runner.status === "failed") {
      const err = new Error(runner.error?.message || `Runner '${runnerId}' failed`);
      err.error = runner.error;
      throw err;
    }

    // Running: suspicion-with-evidence ends the wait immediately with a
    // needs-decision envelope. The work underneath is untouched.
    const now = Date.now();
    const suspicion = evaluateSuspicion(runner, now);
    if (suspicion) {
      const elapsedSeconds = Math.round((now - runner.startedAt) / 1000);
      const silenceSeconds = Math.max(0, Math.round((now - (runner.lastActivityAt || runner.startedAt)) / 1000));
      const activeTool = activeToolView(runner.activeTool, now);
      const trajectory = [...runner.trajectory];
      return {
        ok: true,
        runnerId,
        status: "running",
        needsDecision: true,
        suspicion,
        elapsedSeconds,
        silenceSeconds,
        activeTool,
        trajectory,
      };
    }

    // Window expired with nothing to report: running-fine heartbeat. The
    // work continues underneath; re-await keeps watching.
    if (now - start >= windowMs) {
      const elapsedSeconds = Math.round((now - runner.startedAt) / 1000);
      const silenceSeconds = Math.max(0, Math.round((now - (runner.lastActivityAt || runner.startedAt)) / 1000));
      return {
        ok: true,
        runnerId,
        status: "running",
        heartbeat: true,
        elapsedSeconds,
        silenceSeconds,
        activeTool: activeToolView(runner.activeTool, now),
        trajectory: [...runner.trajectory],
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ============================================================================
// Automated Execution Pipeline
// ============================================================================

export const EXECUTIONS = new Map();

export function parseReviewVerdict(output) {
  if (!output || typeof output !== "string" || !output.trim()) {
    return { verdict: null, reason: "missing_output" };
  }
  const text = output.trim();
  const verdictRegex = /(?:^|[\r\n])[^\r\n:]*\bverdict\b[\s*#_]*[:=]?(?:\s*[\r\n][\s\-*#_>]*)?[\s*#_`"'\[\]]*\b(PASS|FAIL)\b/gi;
  const matches = [...text.matchAll(verdictRegex)];

  if (matches.length === 0) {
    return { verdict: null, reason: "missing_verdict" };
  }

  const verdicts = new Set(matches.map((m) => m[1].toUpperCase()));

  if (verdicts.has("FAIL") && verdicts.has("PASS")) {
    return { verdict: "FAIL", conflicting: true, reason: "conflicting_verdict" };
  }

  if (verdicts.has("FAIL")) {
    return { verdict: "FAIL" };
  }

  if (verdicts.has("PASS")) {
    return { verdict: "PASS" };
  }

  return { verdict: null, reason: "ambiguous_verdict" };
}

export function isTrustworthyReviewFail(outputOrResult, explicitExitCode) {
  let output = outputOrResult;
  let exitCode = explicitExitCode ?? 0;
  let hasProcessError = false;

  if (outputOrResult && typeof outputOrResult === "object") {
    output = outputOrResult.output;
    hasProcessError = Boolean(
      outputOrResult.error ||
      outputOrResult.ok === false ||
      (typeof outputOrResult.exitCode === "number" && outputOrResult.exitCode !== 0) ||
      (typeof outputOrResult.error?.exitCode === "number" && outputOrResult.error.exitCode !== 0)
    );
    if (explicitExitCode === undefined) {
      if (typeof outputOrResult.exitCode === "number") {
        exitCode = outputOrResult.exitCode;
      } else if (typeof outputOrResult.error?.exitCode === "number") {
        exitCode = outputOrResult.error.exitCode;
      } else if (hasProcessError) {
        exitCode = 1;
      }
    }
  }

  if (hasProcessError || (typeof exitCode === "number" && exitCode !== 0)) {
    return false;
  }

  if (!output || typeof output !== "string" || !output.trim()) {
    return false;
  }

  const parsed = parseReviewVerdict(output);
  return parsed.verdict === "FAIL" && !parsed.conflicting;
}

export function evaluateReviewPassed(outputOrResult, explicitExitCode) {
  let output = outputOrResult;
  let exitCode = explicitExitCode ?? 0;
  let hasProcessError = false;

  if (outputOrResult && typeof outputOrResult === "object") {
    output = outputOrResult.output;
    hasProcessError = Boolean(
      outputOrResult.error ||
      outputOrResult.ok === false ||
      (typeof outputOrResult.exitCode === "number" && outputOrResult.exitCode !== 0) ||
      (typeof outputOrResult.error?.exitCode === "number" && outputOrResult.error.exitCode !== 0)
    );
    if (explicitExitCode === undefined) {
      if (typeof outputOrResult.exitCode === "number") {
        exitCode = outputOrResult.exitCode;
      } else if (typeof outputOrResult.error?.exitCode === "number") {
        exitCode = outputOrResult.error.exitCode;
      } else if (hasProcessError) {
        exitCode = 1;
      }
    }
  }

  if (hasProcessError || (typeof exitCode === "number" && exitCode !== 0)) {
    return false;
  }

  if (!output || typeof output !== "string" || !output.trim()) {
    return false;
  }

  const parsed = parseReviewVerdict(output);
  return parsed.verdict === "PASS" && !parsed.conflicting;
}

async function runChildSubagent(execution, { role, cwd, prompt, provider }) {
  if (globalThis.__QQ_TEST_SUBAGENT_HANDLER) {
    try {
      const res = await globalThis.__QQ_TEST_SUBAGENT_HANDLER({ role, cwd, prompt, provider, execution });
      return res;
    } catch (err) {
      return { ok: false, error: { message: err.message } };
    }
  }

  const conversationId = randomUUID();
  let bin, args;
  const p = normalizeProvider(provider);
  if (p === "gemini") {
    bin = process.env.REAL_AGY_BIN || "agy";
    args = [
      "--agent", role,
      "--conversation", conversationId,
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--print-timeout", "60m",
      "--add-dir", cwd,
      "--print", prompt,
    ];
  } else if (p === "deepseek") {
    bin = "dsh";
    args = ["--profile", role, prompt];
  } else if (p === "codex") {
    bin = "codex";
    args = ["exec", "--profile", role, "--json", prompt];
  } else {
    bin = "muse";
    const museModel = process.env.QQ_MUSE_MODEL || "muse-spark-1.3";
    const museEffort = process.env.QQ_MUSE_REASONING_EFFORT || "max";
    args = [
      "exec",
      "--preset", role,
      "--model", museModel,
      "--reasoning-effort", museEffort,
      "--yolo",
      "--json",
      prompt,
    ];
  }

  // Fresh per-child stream state. Structured terminal text wins; accumulated
  // plain-text lines are the fallback when no terminal event is emitted.
  delete execution._cleanOutput;
  delete execution._musePendingTools;

  return new Promise((resolvePromise) => {
    let output = "";
    let stderr = "";
    let child;
    try {
      child = spawn(bin, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
    } catch (err) {
      resolvePromise({ ok: false, error: { message: err.message } });
      return;
    }
    execution.activeChild = child;

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      // Child liveness + output recency feed the execution watchdog.
      touchActivity(execution);
      let structured = null;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && ("event" in parsed || "payload_type" in parsed || "type" in parsed)) {
          structured = parsed;
        }
      } catch {
        /* text output */
      }
      if (structured) {
        handleExecutionStreamEvent(execution, structured);
      } else {
        output += line + "\n";
        addTrajectory(execution, { action: "log", message: trimmed.slice(0, 200), timestamp: Date.now() });
      }
    });

    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      touchActivity(execution);
    });

    function finishCleanOutput() {
      const clean =
        typeof execution._cleanOutput === "string" && execution._cleanOutput.trim()
          ? execution._cleanOutput.trim()
          : output.trim();
      delete execution._cleanOutput;
      delete execution._musePendingTools;
      return clean;
    }

    child.on("close", (code) => {
      execution.activeChild = null;
      execution.activeTool = null;
      const finalOutput = finishCleanOutput();
      if (code === 0) {
        resolvePromise({ ok: true, output: finalOutput });
      } else {
        resolvePromise({
          ok: false,
          output: finalOutput,
          error: { message: `Child process exited with code ${code}`, exitCode: code, stderr: stderr.trim() },
        });
      }
    });

    child.on("error", (err) => {
      execution.activeChild = null;
      execution.activeTool = null;
      delete execution._cleanOutput;
      delete execution._musePendingTools;
      resolvePromise({
        ok: false,
        error: { message: err.message, stderr: stderr.trim() },
      });
    });
  });
}

function capTargetText(s) {
  if (typeof s !== "string") return undefined;
  return s.length <= 80 ? s : s.slice(0, 79) + "…";
}

function appendCleanOutput(execution, text) {
  if (typeof text !== "string" || !text.trim()) return;
  execution._cleanOutput = execution._cleanOutput ? `${execution._cleanOutput}\n${text}` : text;
}

function museToolTarget(record) {
  if (!record || typeof record !== "object") return undefined;
  if (typeof record.target === "string") return capTargetText(record.target);
  return capTargetText(record.parallel_profile?.subject);
}

function rememberMusePendingTool(execution, record, name, target) {
  if (!record || typeof record !== "object" || !name) return;
  if (!execution._musePendingTools) execution._musePendingTools = new Map();
  for (const key of [record.call_id, record.effect_id, record.task_id]) {
    if (key) execution._musePendingTools.set(key, { name, target });
  }
}

function resolveMusePendingTool(execution, record) {
  if (!record || typeof record !== "object" || !execution._musePendingTools) return {};
  for (const key of [record.call_id, record.effect_id, record.task_id]) {
    if (key && execution._musePendingTools.has(key)) {
      return execution._musePendingTools.get(key);
    }
  }
  return {};
}

function forgetMusePendingTool(execution, record) {
  if (!record || typeof record !== "object" || !execution._musePendingTools) return;
  for (const key of [record.call_id, record.effect_id, record.task_id]) {
    if (key) execution._musePendingTools.delete(key);
  }
}

function codexToolName(item) {
  if (!item || typeof item !== "object") return "codex_tool";
  return item.tool || item.name || item.type || "codex_tool";
}

function codexToolTarget(item) {
  if (!item || typeof item !== "object") return undefined;
  const direct = item.path || item.file || item.filename || item.url;
  if (typeof direct === "string") return capTargetText(direct);
  if (Array.isArray(item.command)) return capTargetText(item.command.join(" "));
  if (typeof item.command === "string") return capTargetText(item.command);
  return undefined;
}

export function handleExecutionStreamEvent(execution, event) {
  if (!event || typeof event !== "object") return;
  // ---- Gemini: step_update (tool ACTIVE / DONE) ----
  if (event.event === "step_update" && event.step_update) {
    const su = event.step_update;
    touchActivity(execution);
    if (su.step_type === "tool") {
      if (su.state === "ACTIVE") {
        execution.activeTool = {
          name: su.tool_name,
          startedAt: Date.now(),
        };
      } else if (su.state === "DONE") {
        execution.activeTool = null;
        addTrajectory(execution, {
          action: su.tool_name,
          parameters: su.tool_info?.parameters,
          duration: su.duration_seconds,
          timestamp: Date.now(),
        });
      }
    }
    return;
  }
  // ---- Gemini: result (terminal clean output; never drives execution status) ----
  if (event.event === "result" && event.result) {
    touchActivity(execution);
    const res = event.result;
    if (typeof res.response === "string") {
      appendCleanOutput(execution, res.response);
    } else if (typeof res.text === "string") {
      appendCleanOutput(execution, res.text);
    } else if (res.response != null) {
      try {
        appendCleanOutput(execution, JSON.stringify(res.response));
      } catch {
        /* ignore unserializable result */
      }
    }
    execution.activeTool = null;
    return;
  }
  // ---- Muse: tool_batch.effect.started ----
  if (event.payload_type === "tool_batch.effect.started") {
    touchActivity(execution);
    const record = event.payload?.record;
    const toolName = record?.tool_name || event.tool_name;
    if (toolName) {
      execution.activeTool = {
        name: toolName,
        startedAt: Date.now(),
      };
      rememberMusePendingTool(execution, record, toolName, museToolTarget(record));
    }
    return;
  }
  // ---- Muse: tool_batch.effect.terminal ----
  // The terminal record carries no tool_name, so correlate via the
  // started-event pending entry (call/effect/task id) or the active tool.
  if (event.payload_type === "tool_batch.effect.terminal") {
    touchActivity(execution);
    const record = event.payload?.record;
    const pending = resolveMusePendingTool(execution, record);
    const name = record?.tool_name || event.tool_name || pending.name || execution.activeTool?.name;
    const target = museToolTarget(record) ?? pending.target;
    forgetMusePendingTool(execution, record);
    execution.activeTool = null;
    if (name) {
      const entry = { action: name, timestamp: Date.now() };
      if (target !== undefined) entry.target = target;
      if (record?.parameters !== undefined) entry.parameters = record.parameters;
      addTrajectory(execution, entry);
    }
    return;
  }
  // ---- Muse: run.terminal.completed (terminal clean output) ----
  if (
    event.payload_type === "run.terminal.completed" ||
    (event.payload?.kind === "run_terminal" && event.payload?.terminal === "completed")
  ) {
    touchActivity(execution);
    appendCleanOutput(execution, event.payload?.text);
    execution.activeTool = null;
    return;
  }
  // ---- Codex: item.started / item.completed ----
  if (event.type === "item.started" && event.item) {
    touchActivity(execution);
    const item = event.item;
    if (item.type === "agent_message" || item.type === "reasoning") return;
    execution.activeTool = {
      name: codexToolName(item),
      startedAt: Date.now(),
    };
    return;
  }
  if (event.type === "item.completed" && event.item) {
    touchActivity(execution);
    const item = event.item;
    if (item.type === "agent_message") {
      appendCleanOutput(execution, item.text);
      return;
    }
    if (item.type === "reasoning") return;
    execution.activeTool = null;
    addTrajectory(execution, {
      action: codexToolName(item),
      ...(codexToolTarget(item) !== undefined ? { target: codexToolTarget(item) } : {}),
      timestamp: Date.now(),
    });
    return;
  }
}

async function runExecutionPipeline(execution) {
  const { root, kind, sessionId, args } = execution;

  touchActivity(execution);
  addTrajectory(execution, { action: "provision_worktree", timestamp: Date.now() });
  const wt = await createWorktree(root, { kind, sessionId });
  execution.worktree = wt.cwd;
  execution.branch = wt.branch;
  touchActivity(execution);
  addTrajectory(execution, {
    action: "worktree_ready",
    worktree: wt.cwd,
    branch: wt.branch,
    timestamp: Date.now(),
  });

  execution.phase = "implementing";
  const implementerProvider = resolveSeatProvider("implementer", args);
  addTrajectory(execution, {
    action: "implementer_started",
    provider: implementerProvider,
    timestamp: Date.now(),
  });

  const implementerPrompt = buildImplementerPrompt(wt.cwd);
  const implementerRes = await runChildSubagent(execution, {
    role: "implementer",
    cwd: wt.cwd,
    prompt: implementerPrompt,
    provider: implementerProvider,
  });
  touchActivity(execution);

  if (implementerRes.error) {
    execution.status = "failed";
    execution.error = {
      phase: "implementing",
      message: implementerRes.error.message || "Implementer failed",
      exitCode: implementerRes.error.exitCode,
      stderr: implementerRes.error.stderr,
    };
    await notifyTerminal(execution, "execution");
    return;
  }

  addTrajectory(execution, {
    action: "implementer_completed",
    timestamp: Date.now(),
  });

  let reviewerSummary = null;

  if (kind === "open") {
    execution.phase = "reviewing";
    const reviewerProvider = resolveSeatProvider("reviewer", args);
    addTrajectory(execution, {
      action: "reviewer_started",
      provider: reviewerProvider,
      timestamp: Date.now(),
    });

    const reviewerPrompt = buildReviewerPrompt(wt.cwd);
    let reviewRes = await runChildSubagent(execution, {
      role: "reviewer",
      cwd: wt.cwd,
      prompt: reviewerPrompt,
      provider: reviewerProvider,
    });
    touchActivity(execution);

    const hasProcessError = Boolean(
      reviewRes.error ||
      reviewRes.ok === false ||
      (typeof reviewRes.exitCode === "number" && reviewRes.exitCode !== 0) ||
      (typeof reviewRes.error?.exitCode === "number" && reviewRes.error.exitCode !== 0)
    );

    if (hasProcessError) {
      execution.status = "failed";
      execution.error = {
        phase: "reviewing",
        message: reviewRes.error?.message || "Reviewer process failed",
        exitCode: reviewRes.error?.exitCode ?? reviewRes.exitCode,
        stderr: reviewRes.error?.stderr,
        findings: reviewRes.output,
      };
      await notifyTerminal(execution, "execution");
      return;
    }

    if (evaluateReviewPassed(reviewRes)) {
      reviewerSummary = reviewRes.output;
    } else if (isTrustworthyReviewFail(reviewRes)) {
      execution.phase = "retrying";
      addTrajectory(execution, {
        action: "review_failed_retrying",
        findings: reviewRes.output,
        timestamp: Date.now(),
      });

      const retryPrompt = buildRetryPrompt(wt.cwd, reviewRes.output);
      const retryImplRes = await runChildSubagent(execution, {
        role: "implementer",
        cwd: wt.cwd,
        prompt: retryPrompt,
        provider: implementerProvider,
      });
      touchActivity(execution);

      if (retryImplRes.error) {
        execution.status = "failed";
        execution.error = {
          phase: "retrying",
          message: retryImplRes.error.message || "Implementer retry failed",
          exitCode: retryImplRes.error.exitCode,
          stderr: retryImplRes.error.stderr,
        };
        await notifyTerminal(execution, "execution");
        return;
      }

      execution.phase = "reviewing";
      addTrajectory(execution, {
        action: "reviewer_second_run",
        timestamp: Date.now(),
      });

      reviewRes = await runChildSubagent(execution, {
        role: "reviewer",
        cwd: wt.cwd,
        prompt: reviewerPrompt,
        provider: reviewerProvider,
      });
      touchActivity(execution);

      const hasProcessError2 = Boolean(
        reviewRes.error ||
        reviewRes.ok === false ||
        (typeof reviewRes.exitCode === "number" && reviewRes.exitCode !== 0) ||
        (typeof reviewRes.error?.exitCode === "number" && reviewRes.error.exitCode !== 0)
      );

      if (hasProcessError2) {
        execution.status = "failed";
        execution.error = {
          phase: "reviewing",
          message: reviewRes.error?.message || "Second reviewer process failed",
          exitCode: reviewRes.error?.exitCode ?? reviewRes.exitCode,
          stderr: reviewRes.error?.stderr,
          findings: reviewRes.output,
        };
        await notifyTerminal(execution, "execution");
        return;
      }

      if (evaluateReviewPassed(reviewRes)) {
        reviewerSummary = reviewRes.output;
      } else if (isTrustworthyReviewFail(reviewRes)) {
        execution.status = "failed";
        execution.error = {
          phase: "reviewing",
          message: `Review failed after retry: ${reviewRes.output || "no output"}`,
          findings: reviewRes.output,
          exitCode: reviewRes.exitCode,
        };
        await notifyTerminal(execution, "execution");
        return;
      } else {
        const parsed2 = parseReviewVerdict(reviewRes.output);
        execution.status = "failed";
        execution.error = {
          phase: "reviewing",
          status: "incomplete",
          message: `Verification incomplete: second reviewer exited without completed verdict (${parsed2.reason || "uncompleted"})`,
          findings: reviewRes.output,
          reason: parsed2.reason,
        };
        addTrajectory(execution, {
          action: "review_incomplete",
          reason: parsed2.reason,
          findings: reviewRes.output,
          timestamp: Date.now(),
        });
        await notifyTerminal(execution, "execution");
        return;
      }
    } else {
      const parsed = parseReviewVerdict(reviewRes.output);
      execution.status = "failed";
      execution.error = {
        phase: "reviewing",
        status: "incomplete",
        message: `Verification incomplete: reviewer exited without completed verdict (${parsed.reason || "uncompleted"})`,
        findings: reviewRes.output,
        reason: parsed.reason,
      };
      addTrajectory(execution, {
        action: "review_incomplete",
        reason: parsed.reason,
        findings: reviewRes.output,
        timestamp: Date.now(),
      });
      await notifyTerminal(execution, "execution");
      return;
    }
  }

  const hasChanges = await hasImplementationChanges(wt.cwd, wt.branch);
  if (!hasChanges) {
    execution.status = "failed";
    execution.error = {
      phase: "implementing",
      message: "Implementation produced no code changes or commits (incomplete)",
      status: "incomplete",
      noChange: true,
    };
    addTrajectory(execution, {
      action: "implementation_empty",
      worktree: wt.cwd,
      branch: wt.branch,
      timestamp: Date.now(),
    });
    await notifyTerminal(execution, "execution");
    return;
  }

  execution.phase = "landing";
  addTrajectory(execution, {
    action: "landing_started",
    worktree: wt.cwd,
    branch: wt.branch,
    timestamp: Date.now(),
  });

  const landResult = await landWorktree(root, {
    worktree: wt.cwd,
    branch: wt.branch,
    message: args.message || `feat: implement and verify ${wt.branch}`,
  });
  touchActivity(execution);

  execution.phase = "completed";
  execution.status = "completed";
  execution.result = {
    verifiedStory: `Worktree ${wt.branch} successfully verified and landed.`,
    landingOutcome: landResult,
    implementerSummary: sanitizeHeadTail(implementerRes.output, { headLen: 2000, tailLen: 2000 }),
    reviewerSummary: reviewerSummary !== null ? sanitizeHeadTail(reviewerSummary, { headLen: 2000, tailLen: 2000 }) : null,
  };
  addTrajectory(execution, {
    action: "execution_completed",
    landResult,
    timestamp: Date.now(),
  });
  await notifyTerminal(execution, "execution");
}

export async function dispatchExecution(args = {}) {
  const { kind, cwd = process.cwd() } = args;
  if (!kind || (kind !== "bounded" && kind !== "open")) {
    throw new Error("kind is required: 'bounded' | 'open'");
  }

  const root = await mainRepoRoot(cwd);
  const sessionId = await resolveSessionId(root, args.sessionId || args.id);
  await resolveTicketSource(root, sessionId);
  if (sessionId) {
    const procThread = findCodexThreadFromProc();
    if (procThread) DETECTED_CODEX_THREADS.set(sessionId, procThread);
    const procHome = findCodexHomeFromProc();
    if (procHome) {
      DETECTED_CODEX_HOMES.set(sessionId, procHome);
      if (!process.env.CODEX_HOME) process.env.CODEX_HOME = procHome;
    }
  }

  const id = randomUUID();
  const startedAt = Date.now();
  const execution = {
    id,
    kind,
    sessionId,
    root,
    cwd,
    args,
    status: "running",
    phase: "implementing",
    startedAt,
    lastActivityAt: startedAt,
    activeTool: null,
    trajectory: [],
    result: null,
    error: null,
    activeChild: null,
  };
  EXECUTIONS.set(id, execution);

  runExecutionPipeline(execution).catch(async (err) => {
    if (execution.status === "running") {
      execution.status = "failed";
      execution.error = {
        phase: execution.phase,
        message: err.message,
        stack: err.stack,
      };
    }
    await notifyTerminal(execution, "execution");
  });

  return { ok: true, id, status: "running", phase: "implementing" };
}

export async function checkExecution(args = {}) {
  const id = args.id || args.executionId;
  if (!id) throw new Error("id is required");
  const exec = EXECUTIONS.get(id);
  if (!exec) throw new Error(`no execution found for id '${id}'`);

  const now = Date.now();
  const elapsedSeconds = Math.round((now - exec.startedAt) / 1000);
  const activeTool = activeToolView(exec.activeTool, now);

  if (exec.status !== "running") {
    return {
      id: exec.id,
      status: exec.status,
      phase: exec.phase,
      elapsedSeconds,
      activeTool,
      trajectory: [...exec.trajectory],
      suspicion: null,
      stuckSuspect: false,
      ...(exec.status === "completed" ? { result: exec.result } : {}),
      ...(exec.status === "failed" ? { error: exec.error } : {}),
    };
  }

  const suspicion = evaluateSuspicion(exec, now);
  const silenceSeconds = Math.max(0, Math.round((now - (exec.lastActivityAt || exec.startedAt)) / 1000));

  return {
    id: exec.id,
    status: exec.status,
    phase: exec.phase,
    elapsedSeconds,
    silenceSeconds,
    activeTool,
    trajectory: [...exec.trajectory],
    suspicion,
    stuckSuspect: suspicion !== null,
  };
}

export async function awaitExecution(args = {}) {
  const id = args.id || args.executionId;
  if (!id) throw new Error("id is required");
  const exec = EXECUTIONS.get(id);
  if (!exec) throw new Error(`no execution found for id '${id}'`);
  // Legacy timeoutMs is accepted but never fails the wait: awaits return
  // status by 4:50 every time (heartbeat, suspicion, or terminal). There is
  // no timeout-as-error.

  const windowMs = awaitWindowMs();
  const start = Date.now();
  for (;;) {
    if (exec.status === "completed") {
      return {
        ok: true,
        id,
        status: "completed",
        result: exec.result,
      };
    }
    if (exec.status === "failed") {
      const err = new Error(exec.error?.message || `Execution '${id}' failed in phase '${exec.phase}'`);
      err.error = exec.error;
      throw err;
    }

    // Running: suspicion-with-evidence ends the wait immediately with a
    // needs-decision envelope. The work underneath is untouched.
    const now = Date.now();
    const suspicion = evaluateSuspicion(exec, now);
    if (suspicion) {
      const elapsedSeconds = Math.round((now - exec.startedAt) / 1000);
      const silenceSeconds = Math.max(0, Math.round((now - (exec.lastActivityAt || exec.startedAt)) / 1000));
      const activeTool = activeToolView(exec.activeTool, now);
      const trajectory = [...exec.trajectory];
      return {
        ok: true,
        id,
        status: "running",
        phase: exec.phase,
        needsDecision: true,
        suspicion,
        elapsedSeconds,
        silenceSeconds,
        activeTool,
        trajectory,
      };
    }

    // Window expired with nothing to report: running-fine heartbeat. The
    // work continues underneath; re-await keeps watching.
    if (now - start >= windowMs) {
      const elapsedSeconds = Math.round((now - exec.startedAt) / 1000);
      const silenceSeconds = Math.max(0, Math.round((now - (exec.lastActivityAt || exec.startedAt)) / 1000));
      return {
        ok: true,
        id,
        status: "running",
        phase: exec.phase,
        heartbeat: true,
        elapsedSeconds,
        silenceSeconds,
        activeTool: activeToolView(exec.activeTool, now),
        trajectory: [...exec.trajectory],
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// ============================================================================
// Dedicated Ticket Tools
// ============================================================================

export async function readTicket(args = {}) {
  const cwd = args.cwd || process.cwd();
  const root = await mainRepoRoot(cwd);
  const sessionId = await resolveSessionId(root, args.sessionId || args.id);
  const path = await resolveTicketSource(root, sessionId);
  const content = await readFile(path, "utf8");
  const sections = listSections(content);

  if (args.sectionsOnly || args.listSections) {
    return {
      ok: true,
      sessionId,
      path,
      sections,
    };
  }

  if (args.section) {
    const sectionContent = extractSection(content, args.section);
    if (sectionContent === null) {
      return {
        ok: false,
        sessionId,
        path,
        section: args.section,
        error: `Section '${args.section}' not found in ticket. Available sections: ${sections.join(", ")}`,
        sections,
      };
    }
    return {
      ok: true,
      sessionId,
      path,
      section: args.section,
      content: sectionContent,
      sections,
    };
  }

  return {
    ok: true,
    sessionId,
    path,
    content,
    sections,
  };
}

export async function updateTicket(args = {}) {
  const { content, section, cwd = process.cwd() } = args;
  if (content === undefined || typeof content !== "string") {
    throw new Error("content is required and must be a string");
  }
  const root = await mainRepoRoot(cwd);
  const sessionId = await resolveSessionId(root, args.sessionId || args.id);
  const path = ticketPath(root, sessionId);

  let newFullContent = content;
  if (section) {
    let currentContent = "";
    try {
      currentContent = await readFile(path, "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") throw err;
      try {
        currentContent = await readFile(templatePath(root), "utf8");
      } catch {
        currentContent = await loadPackagedTemplate();
      }
    }
    newFullContent = replaceSection(currentContent, section, content);
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, newFullContent, "utf8");
  return {
    ok: true,
    sessionId,
    path,
    ...(section ? { section } : {}),
  };
}

// Head + tail sanitization: keep up to headLen chars from start and tailLen chars from end.
// If the content fits within headLen + tailLen, it is returned as-is.
export function sanitizeHeadTail(text, { headLen = 1000, tailLen = 1000 } = {}) {
  if (typeof text !== "string") return String(text ?? "");
  const total = headLen + tailLen;
  if (text.length <= total) return text;
  const omitted = text.length - total;
  return `${text.slice(0, headLen)}\n… [${omitted} chars omitted] …\n${text.slice(text.length - tailLen)}`;
}

export async function completeTask(args = {}) {
  const { response, data_points } = args;
  if (!response || typeof response !== "string") {
    throw new Error("response is required and must be a string");
  }
  if (response.length > COMPLETE_TASK_RESPONSE_MAX) {
    throw new Error(
      `response exceeds the 32,768-character cap (got ${response.length} chars). Summarize before calling complete_task.`,
    );
  }
  if (data_points !== undefined) {
    if (!Array.isArray(data_points)) {
      throw new Error("data_points must be an array of strings");
    }
    if (data_points.length > COMPLETE_TASK_DATA_POINTS_MAX) {
      throw new Error(
        `data_points exceeds the 20-item cap (got ${data_points.length} items). Trim the list before calling complete_task.`,
      );
    }
    for (let i = 0; i < data_points.length; i++) {
      if (typeof data_points[i] !== "string") {
        throw new Error(`data_points[${i}] must be a string`);
      }
      if (data_points[i].length > COMPLETE_TASK_DATA_POINT_LEN_MAX) {
        throw new Error(
          `data_points[${i}] exceeds the 100-character cap (got ${data_points[i].length} chars).`,
        );
      }
    }
  }

  const runnerId = process.env.QQ_RUNNER_ID || null;
  const resultFile = process.env.QQ_RUNNER_RESULT_FILE || (runnerId ? join(tmpdir(), `qq-runner-result-${runnerId}.json`) : null);

  // If in runner context, atomically write to the dedicated result transport file first.
  // CRITICAL: Failed writes must throw and MUST NOT authorize termination via registry or marker file!
  if (resultFile) {
    const payload = JSON.stringify({
      runnerId,
      response,
      data_points: data_points ?? [],
      calledAt: Date.now(),
    });
    const tmpPath = `${resultFile}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    try {
      await writeFile(tmpPath, payload, "utf8");
      await rename(tmpPath, resultFile);
    } catch (err) {
      try { await rm(tmpPath, { force: true }); } catch {}
      throw new Error(`Failed to write runner result transport file: ${err.message}`);
    }
  }

  // Record in memory registry for this process/conversation.
  // Avoid default conversation ID cross-talk: bind explicitly to runnerId when present.
  const markerKeys = new Set();
  if (runnerId) markerKeys.add(runnerId);
  if (process.env.GEMINI_CONVERSATION_ID) markerKeys.add(process.env.GEMINI_CONVERSATION_ID);
  if (process.env.ASTRA_CONVERSATION_ID) markerKeys.add(process.env.ASTRA_CONVERSATION_ID);
  if (markerKeys.size === 0) markerKeys.add("default");

  const record = { calledAt: Date.now(), response, data_points: data_points ?? [] };
  for (const k of markerKeys) {
    COMPLETE_TASK_REGISTRY.set(k, record);
  }

  // Write marker file(s) for hooks across process boundaries.
  try {
    for (const k of markerKeys) {
      const markerPath = join(tmpdir(), `qq-complete-task-${k}.json`);
      await writeFile(markerPath, JSON.stringify({ calledAt: Date.now(), key: k, runnerId }), "utf8");
    }
  } catch {
    // Best-effort: marker file failure must never block tool response if transport file already succeeded
  }

  return {
    ok: true,
    recorded: true,
    responseLength: response.length,
    dataPointsCount: data_points ? data_points.length : 0,
  };
}

// Tool exclusion for clients that must not see certain tools: Codex/Astra
// runs dispatch-and-yield, so its MCP server hides await_runner and
// await_execution from the callable schema. Configured via the
// `--disabled-tools <comma-separated-names>` CLI arg and/or the
// QQ_DISABLED_TOOLS env var (comma-separated); both sources union.
export function parseDisabledTools(argv = process.argv.slice(2), env = process.env) {
  const names = [];
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--disabled-tools") {
      const value = args[i + 1];
      i += 1;
      if (value !== undefined) names.push(...String(value).split(","));
    } else if (typeof arg === "string" && arg.startsWith("--disabled-tools=")) {
      names.push(...arg.slice("--disabled-tools=".length).split(","));
    }
  }
  const fromEnv = env?.QQ_DISABLED_TOOLS;
  if (fromEnv !== undefined && fromEnv !== null && String(fromEnv).trim() !== "") {
    names.push(...String(fromEnv).split(","));
  }
  const seen = new Set();
  const out = [];
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

export function getDisabledTools(argv = process.argv.slice(2), env = process.env) {
  return new Set(parseDisabledTools(argv, env));
}

function resolveDisabledTools(disabledTools) {
  if (disabledTools === undefined || disabledTools === null) return getDisabledTools();
  if (disabledTools instanceof Set) return disabledTools;
  return new Set(disabledTools);
}

export async function callTool(name, args = {}, options = {}) {
  const disabled = resolveDisabledTools(options.disabledTools);
  if (disabled.has(name)) {
    throw new Error(`Tool '${name}' is disabled`);
  }
  if (OPERATOR_ACTION_TOOL_NAMES.has(name) && !isOperatorActionEnabled(options)) {
    throw new Error(`Tool '${name}' is disabled`);
  }
  if (name === "prepare_worktree") {
    return prepareWorktree(args);
  }
  if (name === "land") {
    return land(args);
  }
  if (name === "dispatch_runner") {
    return dispatchRunner(args);
  }
  if (name === "check_runner") {
    return checkRunner(args);
  }
  if (name === "steer_runner") {
    return steerRunner(args);
  }
  if (name === "cancel_runner") {
    return cancelRunner(args);
  }
  if (name === "await_runner") {
    return awaitRunner(args);
  }
  if (name === "dispatch_execution") {
    return dispatchExecution(args);
  }
  if (name === "check_execution") {
    return checkExecution(args);
  }
  if (name === "await_execution") {
    return awaitExecution(args);
  }
  if (name === "read_ticket") {
    return readTicket(args);
  }
  if (name === "update_ticket") {
    return updateTicket(args);
  }
  if (name === "stage_operator_action") {
    return stageOperatorAction(args);
  }
  if (name === "check_operator_action") {
    return checkOperatorAction(args);
  }
  if (name === "cancel_operator_action") {
    return cancelOperatorAction(args);
  }
  if (name === "cleanup_operator_action") {
    return cleanupOperatorAction(args);
  }
  if (name === "complete_task") {
    return completeTask(args);
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function handleRpc(method, params = {}, options = {}) {
  if (method === "initialize") {
    return {
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "qq-workflows",
        version: "0.2.0",
      },
    };
  }

  if (method === "notifications/initialized" || method === "notifications/cancelled") {
    return undefined;
  }

  if (method === "ping") {
    return {};
  }

  if (method === "tools/list") {
    const disabled = resolveDisabledTools(options.disabledTools);
    const available = isOperatorActionEnabled(options)
      ? [...TOOLS, ...OPERATOR_ACTION_TOOLS]
      : TOOLS;
    if (disabled.size === 0) return { tools: available };
    return { tools: available.filter((tool) => !disabled.has(tool.name)) };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments ?? {};
    try {
      const disabled = resolveDisabledTools(options.disabledTools);
      if (disabled.has(toolName)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Tool '${toolName}' is disabled` }],
        };
      }
      if (OPERATOR_ACTION_TOOL_NAMES.has(toolName) && !isOperatorActionEnabled(options)) {
        return {
          isError: true,
          content: [{ type: "text", text: `Tool '${toolName}' is disabled` }],
        };
      }

      const result = await callTool(toolName, toolArgs, options);
      return {
        content: [
          {
            type: "text",
            text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: err?.message || String(err),
          },
        ],
        isError: true,
      };
    }
  }

  const error = new Error(`Method not found: ${method}`);
  error.code = -32601;
  throw error;
}

export function writeMessage(message, stdout = process.stdout) {
  stdout.write(`${JSON.stringify(message)}\n`);
}

export function startMcpServer({ stdin = process.stdin, stdout = process.stdout, disabledTools } = {}) {
  // Reactive Codex wakeups: the sweeper is unref'd, so stdio servers still
  // exit cleanly on SIGTERM or stdin EOF.
  ensureSuspicionSweeperStarted();
  // Snapshot the exclusion set once: CLI arg + env at server start.
  const disabled = resolveDisabledTools(disabledTools);
  const rl = createInterface({ input: stdin });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      writeMessage({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }, stdout);
      return;
    }

    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    try {
      const result = await handleRpc(method, params, { disabledTools: disabled });
      if (!isNotification && result !== undefined) {
        writeMessage({ jsonrpc: "2.0", id, result }, stdout);
      }
    } catch (err) {
      if (!isNotification) {
        writeMessage(
          {
            jsonrpc: "2.0",
            id,
            error: {
              code: typeof err.code === "number" ? err.code : -32603,
              message: err?.message || String(err),
            },
          },
          stdout,
        );
      }
    }
  });

  return rl;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  startMcpServer();
}
