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
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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
  validateRunnerResultPayload,
  readAuthoritativeRunnerResult as readAuthoritativeResultFromStore,
  renderRunnerFindings,
  readSeatResult,
} from "../workflow/results.mjs";
import { readNotification, routeNotification } from "../workflow/notify.mjs";
import { COMMUNICATION_BINDING_ENV } from "../workflow/communication.mjs";
import { readReport, saveReport } from "../workflow/reports.mjs";
import { createJob, processFingerprint, readJob, recordCancellation, writeJob } from "../workflow/jobs.mjs";
import { openChange, viewsFor } from "../workflow/change-record.mjs";
import {
  acquireRelayRuntime,
  prepareRunnerCommunication,
  reconcileRunnerJob,
  recordRunnerCancelIntent,
  recordRunnerOutcome,
  releaseAllRunnerConsumers,
  retryPendingRunnerAmendments,
  runnerCommunicationView,
  steerRunnerLifecycle,
} from "../workflow/runner-lifecycle.mjs";
import { steerRoleAttempt } from "../workflow/execution-authority.mjs";
import {prepareManagedRoleCommunication} from "../workflow/execution-communication.mjs";
import {createMcpExecutionSurface} from "../workflow/mcp-executions.mjs";
import { cancelExecutionHost } from "../workflow/execution-supervisor.mjs";
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
import {
  WORKER_PROVIDER,
  WORKER_SEATS,
  loadWorkerConfig,
} from "../workflow/worker-config.mjs";
import { FINAL_RESPONSE_MAX_CHARS_LABEL } from "../workflow/limits.mjs";
import {
  assertCentralWorkerConfig,
  buildCentralWorkerLaunch,
  resolveWorkerLaunchPlan,
} from "../workflow/worker-launch.mjs";

export { CANONICAL_PROVIDERS, PROVIDERS, assertKnownProvider, normalizeProvider, hasImplementationChanges, OPERATOR_ACTION_TOOLS, loadWorkerConfig, WORKER_SEATS, WORKER_PROVIDER };

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
    description: "Delegate research, inspection, reproduction, or diagnostics to a runner. Returns a job ID for tracking. Communication-enabled runners can receive assignment updates and push progress; completion arrives through the existing notification path.",
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
    description: "Read a runner's current status, assignment revision, pending updates, and report reference. Transport receipt and worker acknowledgement are separate; neither proves the requested outcome succeeded. This tool does not return the full findings.",
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
    name: "retry_runner_notification",
    description: "Replay the retained terminal notification for a runner whose completion wakeup could not be delivered (e.g. after an MCP-server restart). Sends the SAME terminal message through the normal notification path; the full findings stay retained until a delivery is confirmed. Use only to recover a failed delivery, not for routine polling. Does not return findings.",
    inputSchema: {
      type: "object",
      properties: {
        runnerId: {
          type: "string",
          description: "Tracking ID of the runner whose retained notification should be replayed",
        },
      },
      required: ["runnerId"],
    },
  },
  {
    name: "steer_runner",
    description: "Submit an additional instruction to a runner as an assignment update. The result distinguishes recording, transport receipt, and worker acknowledgement. Pending or refused delivery does not mean the worker incorporated the update.",
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
    description: "Record cancellation intent and stop the owned runner process. Cancellation prevents later output from becoming a successful outcome and does not automatically restart the runner.",
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
    name: "read_report",
    description: "Read a durable workflow report by reportId. Large reports are paged; continue from nextOffset until complete is true.",
    inputSchema: {type:"object",properties:{reportId:{type:"string"},offset:{type:"integer",minimum:0},limit:{type:"integer",minimum:1},cwd:{type:"string"}},required:["reportId"]},
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
        phaseId: { type: "string", description: "Approved phase ticket UUID, separate from the coordinating session that owns notifications." },
        baseRef: { type: "string", description: "Explicit new-worktree base or required ancestor when resuming a preserved phase." },
        cwd: {
          type: "string",
          description: "Optional repository working directory (defaults to process.cwd())",
        },
      },
      required: ["kind"],
    },
  },
  {
    name: "check_execution",
    description: "Check progress, active phase, telemetry, and status of an execution pipeline, plus bounded role/job/attempt/revision/update/report state rebuilt from the authoritative change record. Update states stay distinct — submitted (recorded), transport-received (the attempt's receiver accepted delivery), worker-acknowledged (incorporated), fulfilled (an acknowledged update covered by a successful result). The outcome is reported known or unknown; a disappeared execution is never a known failed outcome.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {type:"string",description:"Repository directory used at dispatch; defaults to this MCP server's repository."},
        id: {
          type: "string",
          description: "Tracking ID of the execution",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "steer_execution",
    description: "Submit an additional instruction as an assignment update to the exact currently intended active implementer/reviewer attempt of a managed execution. The target is bound before submission; a phase or attempt change refuses truthfully instead of retargeting. The reply reports the update as recorded (submitted); transport-received, worker-acknowledged and fulfilled are later separate facts reported by check_execution. A legacy harness execution without workflow communication reports unsupported explicitly instead of pretending delivery.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {type:"string",description:"Repository directory used at dispatch; defaults to this MCP server's repository."},
        id: { type: "string", description: "Tracking ID of the execution (or its durable job id)" },
        message: { type: "string", description: "The additional instruction (an assignment update, never a replacement of the task)" },
        expectAttemptId: { type: "string", description: "The attempt id you believe is currently active; a mismatch refuses instead of retargeting" },
        expectJobId: { type: "string", description: "The role job id you believe is currently active; a mismatch refuses instead of retargeting" },
      },
      required: ["id", "message"],
    },
  },
  {
    name: "cancel_execution",
    description: "Cancel a managed execution. The authoritative cancellation intent is recorded before any fingerprint-matched owned process is signalled; repeated cancellation is idempotent and never restarts work. If irreversible landing has already been admitted the call refuses truthfully and preserves the landing evidence; a cancelled execution is never relabelled as success.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: {type:"string",description:"Repository directory used at dispatch; defaults to this MCP server's repository."},
        id: { type: "string", description: "Tracking ID of the execution (or its durable job id)" },
        reason: { type: "string" },
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
          description: `Narrative findings/outcome. Hard cap of ${FINAL_RESPONSE_MAX_CHARS_LABEL} characters.`,
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

const managedExecutionSurface=createMcpExecutionSurface({
  notify:(...args)=>notifySession(...args),
  resolveContext:async(args={})=>{
    const root=await mainRepoRoot(args.cwd??process.cwd());
    const trusted=process.env.QQ_WORKFLOW_SESSION_ID||process.env.PASEO_AGENT_ID||process.env.CODEX_THREAD_ID||findCodexThreadFromProc();
    if(trusted&&args.sessionId&&args.sessionId!==trusted)throw new Error("execution belongs to another coordinating session");
    const owner=trusted||await resolveSessionId(root,args.sessionId);
    return {root,owner};
  },
});

// Legacy provider-selection keys. `researcherProvider` / `QQ_RESEARCHER_PROVIDER`
// are retained ONLY as fail-closed compatibility defenses: research is ordinary
// investigation work carried by the runner seat, so a caller presenting one of
// those keys is rejected exactly like any other provider override rather than
// having it silently ignored or aliased onto a real seat. These defenses do not
// make a researcher seat available.
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

// Worker provider/model selection belongs to the operator's central
// configuration. Any per-call or per-seat override, and any conflicting legacy
// provider env, refuses the launch instead of being honored or silently
// ignored.
export function assertNoProviderOverrides(args = {}, env = process.env) {
  for (const key of ["provider", "implementerProvider", "reviewerProvider", "researcherProvider"]) {
    if (args[key] !== undefined && args[key] !== null) {
      throw new Error(
        `provider override '${key}' is not permitted: worker provider selection belongs to operator workflow configuration, not architect arguments`,
      );
    }
  }
  // A legacy provider environment value is refused for the same reason: the
  // selection lives in the central worker configuration, and honoring a stale
  // variable would silently reintroduce a second selection path.
  const conflicts = [];
  const globalValue = env?.QQ_WORKFLOW_PROVIDER;
  if (globalValue !== undefined && globalValue !== null && String(globalValue).trim() !== "") {
    conflicts.push(`QQ_WORKFLOW_PROVIDER=${globalValue}`);
  }
  for (const envKey of Object.values(SEAT_ENVS)) {
    const value = env?.[envKey];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      conflicts.push(`${envKey}=${value}`);
    }
  }
  if (conflicts.length > 0) {
    throw new Error(
      `legacy worker provider selection is not authorized: ${conflicts.join(", ")} is ignored by design; worker provider/model selection lives in the central worker configuration`,
    );
  }
}

// Resolve a worker seat from central operator configuration only. Fails closed
// on a misconfigured central config (or a missing one) and on a conflicting
// legacy provider env var.
export function resolveSeatProvider(seat, args = {}, env = process.env, options = {}) {
  if (!WORKER_SEATS.includes(seat)) {
    throw new Error(`provider resolution for seat '${seat}' does not use central worker configuration`);
  }
  assertNoProviderOverrides(args, env);
  const file = assertCentralWorkerConfig({ env, configFile: options.configFile ?? null });
  const config = loadWorkerConfig({ env, file });
  // No source-level provider allowance: the configured provider serves every
  // worker seat, and the runtime validates it against its own registry.
  return config.provider;
}

// Canonical worker launcher. All three worker seats launch through the same
// central harness; the architect never selects a provider, model, or
// executable, and the target project supplies only its working directory.
const WORKER_EXEC = fileURLToPath(new URL("../bin/worker-exec.mjs", import.meta.url));
export const WORKER_LAUNCHER_PATH = WORKER_EXEC;

const WORKER_OWNERSHIP = {
  implementer: "Leave changes uncommitted. Do not commit, push, review, or land.",
  reviewer: "Do not commit, push, or land.",
  runner: "Leave files uncommitted. Do not commit, push, review, or land.",
};

export function buildWorkerStep(seat, cwd, prompt) {
  const ownership = WORKER_OWNERSHIP[seat] || "";
  return `Delegate via run_command (with Cwd: ${cwd}): '${WORKER_EXEC} --seat ${seat} --cwd ${cwd} --prompt "${prompt} ${ownership}"'`;
}

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

// Investigation prompt for a prepared research worktree. It is the `task` of
// the concrete dispatch_runner handoff (below): research is ordinary
// investigation work carried by the runner seat, whose identity/transport the
// dispatch_runner tool owns. No manual worker-exec seat invocation is emitted.
export function buildInvestigationPrompt(worktreeCwd) {
  const ticketPath = join(worktreeCwd, ".architect", "ticket.md");
  return `Investigate '${ticketPath}' in working directory '${worktreeCwd}'. Report findings.`;
}

export const buildResearcherPrompt = buildInvestigationPrompt;

// Provider arguments are accepted for backwards compatibility but ignored:
// worker seats always launch through the central configuration, so there is
// exactly one implementer/reviewer delegation command.
export function buildImplementerStep(cwd, prompt) {
  return buildWorkerStep("implementer", cwd, prompt);
}

export function buildReviewerStep(cwd, prompt) {
  return buildWorkerStep("reviewer", cwd, prompt);
}

export async function prepareWorktree(args = {}) {
  const { kind, cwd = process.cwd() } = args;
  if (!kind || (kind !== "bounded" && kind !== "open" && kind !== "research")) {
    throw new Error("kind is required: 'bounded' | 'open' | 'research'");
  }
  // Reject provider overrides before creating anything so a bad value fails
  // fast without leaving a stray worktree or branch behind. Worker seats are
  // resolved from central operator configuration only.
  assertNoProviderOverrides(args);
  const implementerProvider = kind === "research" ? null : resolveSeatProvider("implementer", args);
  const reviewerProvider = kind === "open" ? resolveSeatProvider("reviewer", args) : null;

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
    // Research stays a real, read-only worktree; the delegation itself is a
    // concrete dispatch_runner tool call. The runner seat is the only carrier
    // for investigation work now, and dispatch_runner owns its identity and
    // completion transport, so no bare worker-exec command is emitted here and
    // no worker is launched as a hidden side effect of preparing the tree.
    const investigationTask = buildInvestigationPrompt(wt.cwd);
    const handoff = {
      tool: "dispatch_runner",
      arguments: { task: investigationTask, cwd: wt.cwd },
    };
    const instructions = `Worktree ready at ${wt.cwd}.
Branch: ${wt.branch}
Review required: false

Next steps:
1. Call the '${handoff.tool}' tool with cwd '${wt.cwd}' and task: ${investigationTask}
2. When finished, call 'land'.`;

    return {
      ok: true,
      kind,
      branch: wt.branch,
      worktree: wt.cwd,
      reviewRequired: false,
      sessionId,
      ticketSource,
      handoff,
      instructions,
    };
  }

  const childSessionId = randomUUID();
  const implementerPrompt = buildImplementerPrompt(wt.cwd);
  const reviewerPrompt = buildReviewerPrompt(wt.cwd);
  const reviewerSessionId = randomUUID();

  const implementerStep = buildImplementerStep(wt.cwd, implementerPrompt);
  const instructions = reviewRequired
    ? `Worktree ready at ${wt.cwd}.\nBranch: ${wt.branch}\nReview required: true\n\nNext steps:\n1. ${implementerStep}\n2. When implementation finishes, ${buildReviewerStep(wt.cwd, reviewerPrompt)}\n3. When review passes, call 'land'.`
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
    communication: {
      supported: false,
      mode: "manual-worker",
      reason: "Preparing a worktree does not register a managed worker. The manual worker-exec command has no managed communication or recovery obligations; use dispatch_execution for those guarantees.",
    },
    implementerPrompt,
    implementerProvider,
    ...(reviewRequired ? { reviewerPrompt, reviewerSessionId, reviewerProvider } : {}),
    instructions: `${instructions}\n\nThese manual worker-exec launches have no managed assignment updates, pushed progress, durable workflow report registration, or coordinator recovery. Use dispatch_execution for managed implementer/reviewer communication.`,
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
    default:
      return undefined;
  }
}

function addTrajectory(target, entry) {
  // Filter out agent_response thinking steps — they add no signal and bloat context.
  if (entry.action === "agent_response") return;

  // Replace raw parameters with a capped target string. The one exception is a
  // completion call: its arguments carry the authoritative findings payload, so
  // a capped copy must never become a trajectory target (that would covertly
  // re-surface the very findings check_runner is meant to exclude). Keep the
  // tool name and timing; drop the payload.
  const { parameters, action, ...rest } = entry;
  const payloadBearing = action === "complete_task" ||
    (parameters && typeof parameters === "object" &&
      (parameters.ToolName === "complete_task" || parameters.toolName === "complete_task"));
  const toolTarget = payloadBearing
    ? undefined
    : parameters !== undefined
      ? extractTarget(action, parameters)
      : rest.target;
  const clean = { action, ...rest };
  if (toolTarget !== undefined) clean.target = toolTarget;
  // Ensure parameters is never stored.
  delete clean.parameters;

  target.trajectory.push(clean);
  if (target.trajectory.length > 25) {
    target.trajectory.shift();
  }
}

// Record a non-JSON stdout line as a bounded, payload-free trajectory entry:
// the fact that output occurred (byte count + timing), never the text. Raw
// stdout is arbitrary payload — a runner that echoes its findings as plain
// stdout must not resurface them through check_runner's trajectory.
export function recordRunnerStdoutLine(target, line) {
  if (!target || typeof line !== "string" || !line.trim()) return;
  addTrajectory(target, { action: "log", bytes: Buffer.byteLength(line, "utf8"), timestamp: Date.now() });
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

export const LONG_TOOL_SUSPICION_MS = 600_000; // 10:00 absolute for known-long shell tools

// Tools whose quiet runs are legitimately long (test suites, builds). Both
// spellings a worker seat can report are known: the legacy Antigravity seat's
// `run_command` and the one Pi worker runtime's `bash` (the name its shell tool
// reports in `step_update`). All other tools (and the between-tools idle state)
// trip suspicion after one quiet 4:50 call window.
export const LONG_RUNNING_TOOLS = ["run_command", "bash"];

function watchdogOverrides() {
  const o = globalThis.__QQ_TEST_WATCHDOG;
  if (o && typeof o === "object") return o;
  return {};
}

export const STALL_SUSPICION_WINDOW_MS = 290_000; // 4:50 of silence before a point-in-time read calls the work quiet

export function stallSuspicionWindowMs() {
  const o = watchdogOverrides();
  if (typeof o.stallSuspicionWindowMs === "number" && o.stallSuspicionWindowMs > 0) return o.stallSuspicionWindowMs;
  return STALL_SUSPICION_WINDOW_MS;
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
  return stallSuspicionWindowMs();
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
// Architect turns dispatch and yield: nothing in the workflow blocks on a job,
// so this section wakes the idle session only when something needs it:
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

// Deliver the full composed terminal notification (header + findings +
// data_points) through the normal path. There is deliberately no blind
// truncation, no summary-only replay, and no speculative byte knob: the
// completion-response cap (COMPLETE_TASK_RESPONSE_MAX) is a completion cap, not
// a verified transport limit. If the transport rejects an over-long message,
// delivery is reported as failed and the durable retained copy stays in place
// for an explicit, truthfully-reported retry (replayRetainedRunnerFindings).
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
    return `Runner ${id} completed in ${elapsed}s.\n\nFindings:\n${String(findings)}${dp}`;
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
  // The failure diagnostic is intentionally part of the authoritative terminal
  // notification (the architect's delivery path), not check_runner.
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
// terminal. Never throws.
//
// Delivery truth lives in two fields on the tracker:
//   * notifiedTerminal — set only after a delivery has been CONFIRMED
//     successful. It dedupes and suppresses repeats. It is never set before
//     the send, so a returned failure or a rejection/throw leaves the tracker
//     retryable and the sweeper backstop re-attempts on its next pass.
//   * notifiedTerminalInFlight — the promise of an attempt currently waiting
//     on the transport. Concurrent transition paths (event handler + sweeper)
//     coalesce onto this promise instead of sending a duplicate. It is not a
//     delivery claim and is cleared once the attempt settles. Because the
//     `codex queue` transport can time out after the message was accepted,
//     this bounds concurrent duplicate sends but does not promise exactly-once
//     external delivery.
export async function notifyTerminal(tracker, kind) {
  if (tracker?.args?.notificationMode === "parent") return { notified: false, reason: "owned-parent-delivery" };
  try {
    if (!tracker || tracker.notifiedTerminal) return { notified: false, reason: "already-notified" };
    if (tracker.status !== "completed" && tracker.status !== "failed") {
      return { notified: false, reason: "not-terminal" };
    }
    if (tracker.notifiedTerminalInFlight) {
      // Coalesce onto the attempt already in flight instead of sending a
      // duplicate; report its outcome without claiming a new delivery.
      const res = await tracker.notifiedTerminalInFlight;
      return res?.notified ? res : { notified: false, reason: res?.reason || "in-flight", coalesced: true };
    }
    // Persist the complete terminal report BEFORE notifying: the notification is
    // a bounded delivery, never the only copy of the result.
    const report = persistTrackerReport(tracker, kind);
    const stateDir = trackerStateDir(tracker);
    // New communication runners share the native recovery journal. Separate
    // journals would let the ordinary callback and recovery each send the
    // same terminal event; genuinely legacy trackers keep their old namespace.
    const sessionDir = kind === "runner" && tracker.communication?.enabled
      ? stateDir : join(stateDir, kind === "execution" ? "executions" : "runners");
    // The change record is the authoritative outcome for a communication-enabled
    // runner: the validated outcome (pinned to the revision the attempt actually
    // worked against) is recorded — and its acceptance checked — before any
    // notification bookkeeping is reported. One shared implementation with the
    // cleanup choke point below.
    if (kind === "runner") finalizeRunnerOutcome(tracker);
    if (tracker.status !== "completed" && tracker.status !== "failed") return {notified:false,reason:"outcome-not-published"};
    if (kind === "runner" && tracker.communication?.enabled) {
      const prior = readNotification(sessionDir, `runner:${trackerRef(tracker)}:terminal`);
      if (prior?.state && prior.state !== "failed") {
        // Callback and coordinator recovery share this exact obligation. An
        // accepted/uncertain send needs session evidence, not another send.
        return {notified:false,reason:prior.state === "delivered" ? "already-notified" : "prior-delivery-unverified",
          eventId:prior.eventId,reportId:prior.reportId,deliveryState:prior.state};
      }
    }
    const attempt = (async () => {
      const message = kind === "execution"
        ? buildExecutionTerminalMessage(tracker)
        : buildRunnerTerminalMessage(tracker);
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
          // The bounded text the router produced (never the raw terminal
          // message): an over-cap report is delivered as a bounded summary that
          // points at the durable report, instead of being lost or rejected by
          // the transport.
          deliver: async (notification) => {
            const bounded = typeof notification?.text === "string" ? notification.text : message;
            const res = await notifySession(trackerSessionId(tracker), bounded, {
              kind: `${kind}.terminal`,
              trackerId: trackerRef(tracker),
            });
            // The queue transport confirms that the thread queue ACCEPTED the
            // message, not that the architect has seen a turn; report that
            // distinction honestly instead of implying delivery.
            return {
              state: res?.notified ? "accepted" : "failed",
              reason: res?.reason ?? null,
              via: res?.via ?? null,
              threadId: res?.threadId ?? null,
            };
          },
        },
        // Compatibility: an in-memory MCP tracker keeps its own notified flag
        // and a process-scoped dedupe, so a durable record from an earlier,
        // unrelated process can never swallow a fresh delivery. The durable
        // record itself is still written and stays inspectable.
        dedupe: kind === "runner" && tracker.communication?.enabled ? "durable" : "process",
        cap: MCP_NOTIFY_CAP,
      });
      if (routed.state === "duplicate") {
        return { notified: false, reason: "duplicate-event", eventId: routed.eventId, reportId: report?.reportId ?? null, deliveryState: routed.state };
      }
      const accepted = routed.state === "accepted" || routed.state === "queued" || routed.state === "delivered";
      const raw = routed.transportResult ?? {};
      // Mark delivered only after the transport confirms success. A confirmed
      // runner delivery means the architect holds the full notification, so the
      // durable retained copy is redundant and may be pruned. A rejected
      // transport leaves the artifact in place (truthful retry state).
      if (accepted) {
        tracker.notifiedTerminal = true;
        if (kind === "runner") pruneRetainedFindings(trackerRef(tracker));
      }
      return {
        notified: accepted,
        ...(accepted
          ? { via: raw.via ?? "codex-queue", threadId: raw.threadId ?? null }
          : { reason: raw.reason ?? routed.delivery?.reason ?? "delivery-failed" }),
        eventId: routed.eventId,
        reportId: report?.reportId ?? null,
        deliveryState: routed.state,
      };
    })();
    tracker.notifiedTerminalInFlight = attempt;
    try {
      return await attempt;
    } finally {
      // Always clear the in-flight marker: success is gated by
      // notifiedTerminal, while a failure/throw stays retryable.
      if (tracker.notifiedTerminalInFlight === attempt) delete tracker.notifiedTerminalInFlight;
    }
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
  const summary = { executions: 0, runners: 0, suspicionNotified: 0, terminalNotified: 0, amendmentsRetried: 0 };
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
      summary.amendmentsRetried += await retryRunnerAmendmentsSweep(runner);
    } catch {
      /* one bad tracker must never wedge the sweep */
    }
  }
  return summary;
}

// Recorded-but-unsent assignment updates are recovered on the EXISTING sweep
// lifecycle (no new orchestrator): the shared retry path re-pushes only when
// the relay journal shows no live/delivered obligation for the recorded
// correlation, and an attempt that is terminal, admission-closed, or unbound
// keeps the request recorded but unresolved (never a worker relaunch).
async function retryRunnerAmendmentsSweep(runner) {
  const communication = runner.communication;
  if (!communication?.enabled || !communication.changeId || runner.status !== "running") return 0;
  if (communication.retryInFlight) return 0;
  communication.retryInFlight = true;
  try {
    const stateDir = communication.stateDir ?? trackerStateDir(runner);
    const acquired = await acquireRelayRuntime({ stateDir, env: process.env });
    if (!acquired.ok) return 0;
    try {
      const retry = await retryPendingRunnerAmendments({
        stateDir,
        changeId: communication.changeId,
        jobId: runner.runnerId,
        relay: acquired.relay,
        actor: { kind: "runtime", id: communication.runtimeActorId ?? "qq-workflows-runtime" },
      });
      return retry.pushed.length;
    } finally {
      void acquired.relay.release();
    }
  } catch {
    return 0;
  } finally {
    communication.retryInFlight = false;
  }
}

let suspicionSweeperTimer = null;

// Start the background suspicion sweeper. The interval is unref'd so it never
// keeps the process alive on SIGTERM or stdin EOF. Returns the timer handle.
export function startSuspicionSweeper({ intervalMs } = {}) {
  const ms = typeof intervalMs === "number" && intervalMs > 0 ? intervalMs : sweepIntervalMs();
  const timer = setInterval(() => {
    void sweepNotifications().catch(() => {});
    void managedExecutionSurface.recover().catch(() => {});
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
// Whether an OPERATOR cancellation intent is durably recorded for this
// tracker's attempt (the authoritative change record decides; a signal or a
// stale cache never does).
export function authoritativeCancelIntent(runner) {
  const communication = runner?.communication;
  if (!communication?.enabled || !communication.changeId) return false;
  try {
    const attempt = viewsFor(
      openChange({ stateDir: communication.stateDir ?? trackerStateDir(runner), changeId: communication.changeId }).state,
    ).attempt(communication.jobId ?? runner.runnerId ?? runner.id, communication.attemptId);
    return Boolean(attempt?.cancelIntent) || attempt?.outcome?.status === "cancelled";
  } catch {
    return false;
  }
}

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
  //
  // A SIGTERM/SIGINT is operator cancellation ONLY with a recorded operator
  // intent (which is always durable BEFORE any signal). An unexpected signal
  // is never a cancellation: it preserves the unexpected-exit uncertainty —
  // no cancelled outcome is invented — and falls through to the validated
  // explicit-result check and the honest failure verdict below.
  if ((signalCode === "SIGTERM" || signalCode === "SIGINT") && (runner.cancelRequested === true || authoritativeCancelIntent(runner))) {
    runner.status = "cancelled";
    runner.activeTool = null;
    // A cancellation with recorded intent is still a cancellation: record the
    // authoritative outcome so later output can never complete it.
    if (runner.communication?.enabled && runner.communication.changeId && !runner.communication.outcomeRecorded) {
      runner.communication.outcomeRecorded = true;
      recordRunnerOutcome({
        stateDir: runner.communication.stateDir ?? trackerStateDir(runner),
        changeId: runner.communication.changeId,
        jobId: runner.runnerId,
        attemptId: runner.communication.attemptId,
        status: "cancelled",
        summary: "the runner process was terminated after a recorded cancellation intent",
        actor: { kind: "runtime", id: runner.communication.runtimeActorId ?? "qq-workflows-runtime" },
      });
    }
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
    if (runner.communication?.enabled) {
      // A communication-enabled runner's result comes ONLY from the validated
      // explicit transport (checked above) or the existing authority: a bare
      // exit 0 with stdout tails is never promoted into workflow truth.
      runner.status = "failed";
      runner.error = {
        message: "Runner exited 0 without an authoritative explicit result",
        exitCode,
        stderr: sanitizeHeadTail((runner.stderrTail || "").trim()),
        outputTail: sanitizeHeadTail((runner.outputTail || "").trim()),
      };
      runner.activeTool = null;
      cleanupRunnerFiles(runner);
      return { reconciled: true, status: "failed", exitCode };
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
    message: `Runner process exited with code ${exitCode}${signalCode ? ` (signal ${signalCode})` : ""}${signalCode && !runner.cancelRequested && !authoritativeCancelIntent(runner) ? "; no cancellation intent was recorded" : ""}`,
    exitCode,
    ...(signalCode ? { signalCode } : {}),
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

// runnerId -> { release } — one hold per runner on the OWNER's shared progress
// consumer (the consumer and its relay runtime are shared and refcounted; each
// runner releases its own hold when it terminalizes).
const RUNNER_CONSUMER_HOLDS = new Map();

// Test/shutdown seam: drop every consumer/relay hold this process still owns
// (each release drains bounded first and never deletes pending journal work).
export async function releaseRunnerCommunication() {
  await releaseAllRunnerConsumers();
}

// Per-runner complete_task state: tracks whether each runner called complete_task.
// Keyed by runnerId. Also used by the Stop hook for sub-agent tracking.
export const COMPLETE_TASK_REGISTRY = new Map();

// The MCP compatibility path keeps its long-standing 32,768-character delivery
// budget; the Architect path uses the observed 16,384-character transport cap.
export const MCP_NOTIFY_CAP = 32_768;

// Authoritative worker-result transport lives in workflow/results.mjs so the
// MCP adapter and the native pi Architect share one implementation. The
// validator and the pinned caps are shared; `cleanupRunnerFiles` deliberately
// stays local because this transport retains terminal findings for replay.
export {
  COMPLETE_TASK_RESPONSE_MAX,
  COMPLETE_TASK_DATA_POINTS_MAX,
  COMPLETE_TASK_DATA_POINT_LEN_MAX,
  validateRunnerResultPayload,
};

// Durable terminal bookkeeping for a tracker, exactly once: the complete
// report is persisted and the AUTHORITATIVE change-record outcome is recorded
// (and its acceptance checked) before the transient transport file is deleted
// and before any notification is attempted. A compatibility tracker never
// claims a success the record refused (e.g. output that arrived after a
// cancellation intent) and never contradicts an outcome the record already
// holds — the record wins in both directions.
function finalizeRunnerOutcome(runner) {
  if (!runner || !runner.communication?.enabled || !runner.communication.changeId) return null;
  if (runner.status !== "completed" && runner.status !== "failed" && runner.status !== "cancelled") return null;
  const report = persistTrackerReport(runner, "runner");
  if (runner.communication.outcomeRecorded) return report;
  const outcome = report ? recordRunnerOutcome({
    stateDir: runner.communication.stateDir ?? trackerStateDir(runner),
    changeId: runner.communication.changeId,
    jobId: trackerRef(runner),
    attemptId: runner.communication.attemptId,
    status: runner.status,
    summary: runner.status === "failed"
      ? String(runner.error?.message ?? "failed").slice(0, 500)
      : runner.status === "cancelled" ? "cancelled by architect" : "completed",
    reportId: report?.reportId ?? null,
    actor: { kind: "runtime", id: runner.communication.runtimeActorId ?? "qq-workflows-runtime" },
  }) : {ok:false,code:"report-unavailable",reason:"the full findings report could not be persisted"};
  runner.communication.outcomeRecorded = outcome.ok || outcome.code === "cancelled";
  if (outcome.ok) delete runner.communication.publicationRefused;
  if (!outcome.ok && outcome.code !== "cancelled") {
    // Refused publication is an unknown managed outcome, never a successful
    // tracker. Preserve both useful findings and raw transport for inspection.
    runner.status = "interrupted";
    runner.error = {message:`managed outcome publication refused: ${outcome.reason ?? outcome.code}`,phase:"reconciliation-required"};
    runner.communication.publicationRefused = runner.error.message;
    const stateDir = runner.communication.stateDir ?? trackerStateDir(runner);
    const cached = readJob(stateDir, trackerRef(runner));
    if (cached) writeJob(stateDir, {...cached,status:"interrupted",finishedAt:Date.now(),
      terminal:{status:"interrupted",ok:false,at:Date.now(),summary:runner.error.message,error:runner.error,
        reportId:report?.reportId ?? null,reportChars:report?.chars ?? 0,resultAvailable:Boolean(report)},
      recovery:{verdict:"reconciliation-required",detail:runner.error.message}});
  } else if (!outcome.ok && outcome.code === "cancelled") {
    runner.status = "cancelled";
    runner.result = null;
    runner.completionRejected = outcome.reason;
  } else if (outcome.ok && outcome.status && outcome.status !== runner.status) {
    runner.status = outcome.status;
    if (outcome.status !== "completed") runner.result = null;
  }
  return report;
}

export function cleanupRunnerFiles(runner) {
  if (!runner) return;
  // Release this runner's hold on the shared progress consumer. The consumer
  // and its relay runtime are shared and refcounted, so this never destroys
  // another runner's transport; the last hold drains bounded and stops.
  if (runner.communication?.enabled) {
    const held = RUNNER_CONSUMER_HOLDS.get(runner.id);
    if (held && !runner.communication.consumerReleased) {
      runner.communication.consumerReleased = true;
      RUNNER_CONSUMER_HOLDS.delete(runner.id);
      void Promise.resolve(held.release()).catch(() => {});
    }
  }
  // Record/report durable BEFORE the transient transport is deleted (the
  // shared finalize above): the complete terminal report is persisted and the
  // authoritative change-record outcome is recorded before anything below
  // removes the only other copy.
  finalizeRunnerOutcome(runner);
  if (runner.communication?.publicationRefused) return;
  // Single choke point for terminal transitions: every path sets
  // status/result/error and then calls this, so retaining here is what makes
  // BOTH completed and failed terminal outcomes durable BEFORE the transient
  // transport file is removed. A failed runner carries no `result`; its
  // bounded diagnostic (message/stderr/outputTail) is the authoritative
  // failure notification and the only place that evidence survives, so it is
  // retained too.
  const terminal = runner.status === "completed" || runner.status === "failed";
  // A confirmed terminal delivery means the architect already holds the full
  // notification and the durable copy was pruned, so a later cleanup pass (the
  // child's close event) must not re-retain a stale artifact that nothing would
  // ever prune.
  const delivered = runner.notifiedTerminal === true;
  const retainedPath = terminal && !delivered ? retainRunnerFindings(runner) : null;
  // A persistence failure must never destroy the ONLY durable copy of the
  // terminal outcome:
  //   * completed: the transport file holds the validated findings;
  //   * failed: the transport file (when one exists) is the sole durable copy
  //     of the failure payload/diagnostic, because check_runner no longer
  //     echoes the raw diagnostic and the in-memory tracker dies with this
  //     process.
  // A confirmed delivery already handed the full notification to the architect,
  // so the transient file is disposable; check_runner still reports
  // findingsRetained:false, truthfully.
  const hasResult = runner.result !== null && runner.result !== undefined;
  const keepTransport = terminal && !delivered && !retainedPath && (hasResult || runner.status === "failed");
  if (!keepTransport && runner.resultFile) {
    try { rmSync(runner.resultFile, { force: true }); } catch {}
  }
  if (runner.id) {
    try { rmSync(join(tmpdir(), `qq-complete-task-${runner.id}.json`), { force: true }); } catch {}
  }
}


// ============================================================================
// Durable retention of validated terminal findings
// ============================================================================
//
// Findings live on the in-memory tracker and are delivered by the terminal
// notification. `cleanupRunnerFiles` deletes the child's result transport file
// the moment a runner finalizes, so a delivery failure followed by an
// MCP-server restart would otherwise leave no copy at all. We therefore persist
// the validated outcome (completed OR failed) to a private, atomically-written
// file BEFORE the transport file is cleaned up (see `cleanupRunnerFiles`). The
// record carries stable identity/routing metadata so it can be replayed through
// the SAME terminal-notification mechanism (replayRetainedRunnerFindings).
//
// This is durable retention, not a second findings path: the retained file is
// never read by check_runner, and nothing here schedules jobs or
// claims exactly-once delivery.

export const RETAINED_FINDINGS_VERSION = 1;

// runnerIds are randomUUID() values. Validate strictly BEFORE any path is
// built, so a caller-supplied id can never escape the findings directory
// (path traversal) or name an arbitrary file. pruneRetainedFindings rmSyncs
// this path, so validation is a safety boundary, not cosmetics.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidRunnerId(runnerId) {
  return typeof runnerId === "string" && UUID_RE.test(runnerId);
}

export function runnerFindingsDir(env = process.env) {
  if (env && env.QQ_RUNNER_FINDINGS_DIR && String(env.QQ_RUNNER_FINDINGS_DIR).trim()) {
    return resolve(String(env.QQ_RUNNER_FINDINGS_DIR));
  }
  const base = env && env.XDG_STATE_HOME && String(env.XDG_STATE_HOME).trim()
    ? resolve(String(env.XDG_STATE_HOME))
    : join(env && env.HOME && String(env.HOME).trim() ? String(env.HOME) : homedir(), ".local", "state");
  return join(base, "qq-workflows", "runner-findings");
}

// Path for a runner's retained record, or null when the id is invalid or the
// resolved path would fall outside the findings directory. Returning null (not
// a path) is the fail-closed contract for every caller that touches the fs.
export function retainedFindingsPath(runnerId, env = process.env) {
  if (!isValidRunnerId(runnerId)) return null;
  const dir = runnerFindingsDir(env);
  const candidate = join(dir, `${runnerId}.json`);
  const rel = relative(dir, candidate);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return candidate;
}

// Create/verify a private (owner-only) findings directory. mkdirSync's mode
// does not fix a pre-existing directory, so re-check and tighten; refuse to
// proceed if the path is not a real directory or cannot be made private.
function ensurePrivateRunnerDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) return false; // rejects a symlink planted at the path
  if ((st.mode & 0o077) !== 0) {
    try { chmodSync(dir, 0o700); } catch { return false; }
    if ((lstatSync(dir).mode & 0o077) !== 0) return false;
  }
  return true;
}

// Bounded failure payload for retention/replay: only the fields the terminal
// builder uses, all already bounded on the tracker (message is short; stderr is
// sanitizeHeadTail'd to <= 2000 chars). Never a length cap and never the raw
// unbounded stream.
function failureRecord(runner) {
  const err = runner?.error && typeof runner.error === "object" ? runner.error : {};
  const out = {};
  for (const key of ["message", "exitCode", "signalCode", "stderr"]) {
    if (err[key] !== undefined && err[key] !== null) out[key] = err[key];
  }
  return out;
}

// Atomically persist a validated terminal outcome (completed OR failed) to a
// private, O_EXCL temp file renamed into place. Returns the path on success;
// null when there is nothing to retain, the id is invalid, or the write failed
// (best-effort: a retention failure must never fail the runner or its
// notification, and callers must not treat null as retention).
export function retainRunnerFindings(runner, { env = process.env, now = Date.now() } = {}) {
  const runnerId = runner?.runnerId || runner?.id;
  const status = runner?.status;
  if (!isValidRunnerId(runnerId)) return null;
  if (status !== "completed" && status !== "failed") return null;
  const path = retainedFindingsPath(runnerId, env);
  if (!path) return null;
  const dir = runnerFindingsDir(env);
  const record = {
    version: RETAINED_FINDINGS_VERSION,
    runnerId,
    sessionId: trackerSessionId(runner) || null,
    threadId: resolveCodexThreadId(trackerSessionId(runner)) || null,
    startedAt: typeof runner.startedAt === "number" ? runner.startedAt : null,
    retainedAt: now,
    status,
    result: status === "completed" ? runner.result : null,
    error: status === "failed" ? failureRecord(runner) : null,
    outputTail: status === "failed" && runner.outputTail ? String(runner.outputTail) : null,
  };
  // Unique, exclusive temp file inside the 0700 dir: "wx" is O_CREAT|O_EXCL, so
  // it never follows or clobbers a planted symlink/entry.
  const tmpPath = join(dir, `.${runnerId}.${process.pid}.${now}.${randomUUID()}.tmp`);
  try {
    if (!ensurePrivateRunnerDir(dir)) return null;
    writeFileSync(tmpPath, JSON.stringify(record), { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(tmpPath, path);
    return path;
  } catch {
    try { rmSync(tmpPath, { force: true }); } catch {}
    return null;
  }
}

export function loadRetainedFindings(runnerId, { env = process.env } = {}) {
  const path = retainedFindingsPath(runnerId, env);
  if (!path || !existsSync(path)) return null;
  try {
    const record = JSON.parse(readFileSync(path, "utf8"));
    if (!record || record.version !== RETAINED_FINDINGS_VERSION || record.runnerId !== runnerId) return null;
    return { ...record, path };
  } catch {
    return null;
  }
}

// Whether a durable record currently exists. This is the true "findings
// retained" state: result!=null on the in-memory tracker says nothing about
// durability.
export function hasRetainedFindings(runnerId, { env = process.env } = {}) {
  const path = retainedFindingsPath(runnerId, env);
  return Boolean(path && existsSync(path));
}

export function listRetainedFindings({ env = process.env } = {}) {
  const dir = runnerFindingsDir(env);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .filter((id) => isValidRunnerId(id))
      .sort();
  } catch {
    return [];
  }
}

export function pruneRetainedFindings(runnerId, { env = process.env } = {}) {
  const path = retainedFindingsPath(runnerId, env);
  if (!path) return false;
  try {
    rmSync(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

// Trusted runtime identity of THIS MCP-server process (the caller). Sourced
// only from harness-controlled context — the Codex-provided thread env or the
// ancestor rollout descriptor found via procfs — never from tool arguments. A
// tool caller cannot influence process.env of the server.
export function currentRuntimeIdentity() {
  const env = process.env;
  const sessionId = env.CODEX_SESSION_ID || env.CODEX_CONVERSATION_ID || null;
  const threadId = resolveCodexThreadId(null) || null;
  return { sessionId: sessionId || null, threadId };
}

// The caller owns a record iff its trusted runtime thread matches the thread
// recorded when the outcome was retained. Cross-session callers resolve to a
// different Codex thread (a different rollout descriptor), so they fail this
// check. Absent/ambiguous identity fails closed; there is no cross-session
// fallback.
function verifyRecordOwnership(record, caller) {
  if (record.threadId && caller.threadId && record.threadId === caller.threadId) return { ok: true };
  if (!record.threadId) return { ok: false, reason: "no-record-identity" };
  if (!caller.threadId) return { ok: false, reason: "no-caller-identity" };
  return { ok: false, reason: "not-originating-session" };
}

// Explicit recovery: replay the retained terminal notification for a runner
// whose wakeup could not be delivered (including after an MCP-server restart,
// when the in-memory tracker is gone). It rebuilds the SAME terminal message
// and sends it through the SAME notifySession transport — this is not a
// findings read and is never reachable from check_runner.
//
// Routing is taken ONLY from the retained record (its originating session and
// thread); a caller cannot redirect it. Ownership is verified against trusted
// runtime context first. Within the same process, an in-flight normal terminal
// send is awaited instead of duplicated. This makes no cross-process
// exactly-once claim; it reports notification delivery, not task outcome.
export async function replayRetainedRunnerFindings(runnerId, { env = process.env } = {}) {
  if (!isValidRunnerId(runnerId)) return { ok: false, runnerId: null, reason: "invalid-runner-id" };
  const record = loadRetainedFindings(runnerId, { env });
  if (!record) return { ok: false, runnerId, reason: "no-retained-findings" };
  const taskStatus = record.status === "failed" ? "failed" : "completed";

  const caller = currentRuntimeIdentity();
  const ownership = verifyRecordOwnership(record, caller);
  if (!ownership.ok) {
    return { ok: false, runnerId: record.runnerId, taskStatus, reason: ownership.reason };
  }

  // Same-process coordination: reuse an in-flight/confirmed normal send instead
  // of duplicating it.
  const tracker = RUNNERS.get(record.runnerId);
  if (tracker && tracker.notifiedTerminal) {
    return { ok: true, runnerId: record.runnerId, taskStatus, via: "already-notified", reason: null };
  }
  if (tracker && tracker.notifiedTerminalInFlight) {
    const res = await tracker.notifiedTerminalInFlight;
    if (res?.notified) {
      pruneRetainedFindings(record.runnerId, { env });
      return { ok: true, runnerId: record.runnerId, taskStatus, via: res.via ?? null, reason: null };
    }
    return { ok: false, runnerId: record.runnerId, taskStatus, reason: res?.reason || "in-flight", coalesced: true };
  }

  // Reconstruct the SAME terminal message from the retained record and route it
  // to the record's originating session/thread only.
  const recordRunner = {
    runnerId: record.runnerId,
    status: record.status,
    startedAt: record.startedAt ?? record.retainedAt,
    result: record.result,
    error: record.error || undefined,
    outputTail: record.outputTail || undefined,
  };
  const message = buildRunnerTerminalMessage(recordRunner);
  const res = await notifySession(record.sessionId, message, {
    kind: "runner.terminal.replay",
    trackerId: record.runnerId,
    ...(record.threadId ? { threadId: record.threadId } : {}),
  });
  // A confirmed delivery makes the durable copy redundant.
  if (res?.notified) pruneRetainedFindings(record.runnerId, { env });
  return {
    ok: Boolean(res?.notified),
    runnerId: record.runnerId,
    taskStatus,
    via: res?.via ?? null,
    reason: res?.notified ? null : (res?.reason ?? "delivery-failed"),
  };
}


// Registry-bound read for the in-memory complete_task registry used by MCP
// clients and test doubles.
export function readAuthoritativeRunnerResult(runner) {
  return readAuthoritativeResultFromStore(runner, { registry: COMPLETE_TASK_REGISTRY });
}

// Transport backstop: the authoritative result file can appear on any event
// shape, so completion is checked as soon as it validates. Only a running
// runner with a validated transport payload transitions (and the payload must
// satisfy the same cap/binding rules as every other ingestion path), so a
// rejected or over-cap result never authorizes success.
export function checkRunnerTransportBackstop(runner) {
  if (!runner || runner.status !== "running" || !runner.resultFile || !existsSync(runner.resultFile)) return false;
  const loaded = readAuthoritativeRunnerResult(runner);
  if (!loaded.ok) return false;
  runner.status = "completed";
  runner.result = loaded.result;
  runner.activeTool = null;
  cleanupRunnerFiles(runner);
  void notifyTerminal(runner, "runner");
  return true;
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

  // A Pi-harness runner is communication-enabled: the shared runner lifecycle
  // prepares the authoritative record, the private relay, the owner's
  // return-consumer subscription and the validated binding BEFORE anything is
  // spawned. A setup failure is an honest terminal failure — never a silent
  // downgrade to a legacy, unsteerable runner.
  let spawnEnv = process.env;
  let communication = null;
  let prepared = null;
  let launchPlan = null;
  try {
    launchPlan = resolveWorkerLaunchPlan({ role: "runner", env: process.env });
  } catch {
    launchPlan = null; // startRunnerProcess reports the launch failure itself
  }
  if (launchPlan?.harness === "pi") {
    const stateDir = stateDirFor(cwd, process.env);
    const ownerRouting = runner.sessionId
      ?? currentRuntimeIdentity().sessionId
      ?? `unowned-${process.pid}`;
    prepared = await prepareRunnerCommunication({
      stateDir,
      root: cwd,
      env: process.env,
      jobId: runnerId,
      task,
      targetPaths: runner.targetPaths,
      cwd,
      ownerRouting,
      transport: {
        name: "codex-queue",
        deliver: async (notification) => {
          // Per-message attribution comes from the VERIFIED notification (the
          // shared consumer registry routes per job): a second runner's
          // progress is never delivered through the first dispatch's closure.
          const targetId = notification?.jobId ?? runnerId;
          const target = RUNNERS.get(targetId) ?? runner;
          const res = await notifySession(trackerSessionId(target) ?? runner.sessionId, notification.text, {
            kind: "runner.progress",
            trackerId: targetId,
          });
          // Queue acceptance, not confirmed consumption: report the
          // distinction instead of implying the architect saw a turn.
          return {
            state: res?.notified ? "accepted" : "failed",
            reason: res?.reason ?? null,
            via: res?.via ?? null,
            threadId: res?.threadId ?? null,
          };
        },
      },
      journalDir: join(stateDir, "runners"),
      workflowRouting: { sessionKey: ownerRouting, sessionId: runner.sessionId ?? null },
      cap: MCP_NOTIFY_CAP,
      now: Date.now,
    });
    if (!prepared.ok) {
      runner.status = "failed";
      runner.error = { message: `Runner communication setup failed: ${prepared.reason}` };
      cleanupRunnerFiles(runner);
      void notifyTerminal(runner, "runner");
      return { ok: false, runnerId, status: "failed", error: runner.error.message, communication: { enabled: false, attempted: true, failed: prepared.reason } };
    }
    communication = {
      schema: 1,
      enabled: true,
      changeId: prepared.changeId,
      jobId: runnerId,
      attemptId: prepared.attemptId,
      consumerId: prepared.consumerId,
      stateDir,
      runtimeActorId: prepared.binding.runtimeActorId,
      sessionId: runner.sessionId ?? null,
      ownerRouting,
    };
    // The durable compatibility projection (identity, owner routing, result
    // transport, communication identity) is persisted BEFORE any launch so a
    // restarted coordinator reconstructs this runner through normal tools. The
    // change record remains the authority; this record never decides status,
    // cancellation, effective revision or terminal outcome.
    try {
      createJob({
        stateDir,
        id: runnerId,
        role: "runner",
        workflow: { sessionKey: ownerRouting, sessionId: runner.sessionId ?? null, root: cwd },
        cwd,
        task,
        launchPlan,
        now: Date.now(),
      });
      writeJob(stateDir, { ...(readJob(stateDir, runnerId) ?? {}), resultFile: runner.resultFile, communication });
    } catch (err) {
      // Projection failures never block a launch: the authoritative record and
      // the explicit result transport still allow recovery.
      console.error("[qq-workflows] runner projection not persisted:", err?.message);
    }
    RUNNER_CONSUMER_HOLDS.set(runnerId, { release: prepared.release });
    spawnEnv = { ...process.env, ...prepared.bindingEnv };
  }

  startRunnerProcess(runner, { spawnEnv, communication });

  return {
    ok: true,
    runnerId,
    status: "running",
    ...(communication ? { communication: { enabled: true, changeId: communication.changeId, attemptId: communication.attemptId } } : {}),
  };
}

function startRunnerProcess(runner, { spawnEnv = process.env, communication = null } = {}) {
  // The consumer hold belongs to this runner until it terminalizes; set the
  // projection BEFORE any launch so every failure path releases it.
  runner.communication = communication;
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

  // The runner seat launches through the central worker contract. Its bound
  // identity and result transport ride inside that contract (the configured
  // harness decides how its seat receives them); no target-project executable is
  // probed and there is no agy/legacy fallback. The communication binding rides
  // in the same environment and is re-added explicitly by the pi launch.
  let launch;
  try {
    launch = buildCentralWorkerLaunch({
      seat: "runner",
      cwd: runner.cwd,
      prompt,
      env: spawnEnv,
      mcpEnv: {
        QQ_RUNNER_ID: runner.runnerId,
        QQ_RUNNER_RESULT_FILE: runner.resultFile,
        ...(runner.communication?.enabled ? {[COMMUNICATION_BINDING_ENV]:spawnEnv[COMMUNICATION_BINDING_ENV]} : {}),
      },
    });
  } catch (err) {
    runner.status = "failed";
    runner.error = { message: `Runner worker launch rejected: ${err.message}` };
    cleanupRunnerFiles(runner);
    void notifyTerminal(runner, "runner");
    return;
  }
  runner.provider = launch.config.provider;
  runner.model = launch.config.model;
  runner.harness = launch.config.harness;
  runner.workerBin = launch.bin;

  // Explicit test/operator binary override (offline tests and smoke harnesses).
  // The centrally configured provider, model and harness still govern the argv.
  if (process.env.QQ_RUNNER_BIN) launch.bin = process.env.QQ_RUNNER_BIN;

  let child;
  try {
    child = spawn(launch.bin, launch.args, {
      cwd: runner.cwd,
      // stdin is /dev/null: the worker reads its prompt from argv and must never
      // block waiting on an open stdin pipe.
      stdio: ["ignore", "pipe", "pipe"],
      env: launch.env,
    });
  } catch (err) {
    runner.status = "failed";
    runner.error = { message: err.message };
    cleanupRunnerFiles(runner);
    void notifyTerminal(runner, "runner");
    return;
  }
  runner.process = child;
  // Owned process identity is persisted on the durable projection so a
  // restarted coordinator can verify (fingerprint) before ever signalling.
  if (runner.communication?.enabled) {
    try {
      const stateDir = trackerStateDir(runner);
      const current = readJob(stateDir, runner.runnerId);
      if (current) {
        writeJob(stateDir, {
          ...current,
          process: { pid: child.pid ?? null, spawnedAt: Date.now(), fingerprint: processFingerprint({ pid: child.pid }) },
          updatedAt: Date.now(),
        });
      }
    } catch {
      /* projection bookkeeping never blocks the launch */
    }
  }

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
      recordRunnerStdoutLine(runner, trimmed);
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
    // An external SIGTERM/SIGINT is operator cancellation ONLY when the
    // cancellation intent was recorded first (cancelRunner records it before
    // any signal). An unexpected signal is never a cancellation: it falls
    // through to the validated explicit-result check and the honest failure
    // verdict below, with the signal reported.
    if ((signal === "SIGTERM" || signal === "SIGINT") && (runner.cancelRequested === true || authoritativeCancelIntent(runner))) {
      runner.status = "cancelled";
      runner.activeTool = null;
      cleanupRunnerFiles(runner);
      return;
    }
    if (runner.resultFile && existsSync(runner.resultFile)) {
      // Ingestion keeps the pinned complete_task contract (one authoritative
      // character cap) but never discards the only copy of an over-cap report:
      // the full response is spilled to the durable report store.
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
    } else if (code === 0 && !runner.communication?.enabled) {
      runner.status = "completed";
      if (runner.result == null) {
        runner.result = rawOutput.trim();
      }
    } else if (code === 0) {
      // A communication-enabled runner's result comes ONLY from the validated
      // explicit transport (or the existing authority): arbitrary final
      // stdout is never promoted into workflow truth.
      runner.status = "failed";
      runner.error = {
        message: "Runner exited 0 without an authoritative explicit result",
        exitCode: code,
        stderr: sanitizeHeadTail(stderrBuf.trim()),
      };
    } else {
      runner.status = "failed";
      runner.error = {
        message: `Runner process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
        exitCode: code,
        ...(signal ? { signalCode: signal } : {}),
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
          // Terminal transition: retain the outcome durably (completed findings
          // or the bounded failure diagnostic) BEFORE the transient transport
          // file is removed and before the terminal notification is attempted.
          cleanupRunnerFiles(runner);
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
      if (runner.communication?.enabled) {
        // A communication-enabled runner's result must come from the validated
        // explicit transport (or the existing authority): the raw terminal
        // stream event alone is never promoted into workflow truth.
        const loaded = readAuthoritativeRunnerResult(runner);
        if (loaded.ok) {
          runner.status = "completed";
          runner.result = loaded.result;
        } else {
          runner.status = "failed";
          runner.error = {
            message: `Runner completed without an authoritative explicit result: ${loaded.error}`,
          };
        }
      } else {
        runner.status = "completed";
        runner.result = res.response;
      }
    } else {
      runner.status = "failed";
      runner.error = {
        message: res.error || "Runner reported error",
        details: res,
      };
    }
    runner.activeTool = null;
    cleanupRunnerFiles(runner);
    void notifyTerminal(runner, "runner");
  }
}

// Bounded, non-payload diagnostic vocabulary for a raw worker message. The tag
// is drawn from a fixed failure vocabulary (e.g. "429", "quota",
// "ECONNRESET"), or "worker_error" when nothing matched. Because it returns
// only a vocabulary token — never message text — it cannot carry findings even
// when the raw message does. This is deliberately not a length cap.
const WORKER_FAILURE_PATTERN = /(\b(401|402|403|408|429|5\d\d)\b)|unauthorized|forbidden|quota|rate.?limit|insufficient|api[_ ]key|authentication|missing environment variable|stream error|stream disconnected|connection (error|failed|refused|reset)|ECONNREFUSED|ECONNRESET|ETIMEDOUT|model_not_found|no such model|payment|billing|budget/i;

export function workerFailureTag(message) {
  if (typeof message !== "string") return "worker_error";
  const m = message.match(WORKER_FAILURE_PATTERN);
  return m ? String(m[0]).toLowerCase().slice(0, 32) : "worker_error";
}

// Delivery state for check_runner: has the terminal wakeup been confirmed
// delivered, or is it still pending the sweeper's retry? Read-only — sends
// nothing and never touches the findings themselves. "Delivered" here means
// transport acceptance (the wakeup was queued), not confirmed consumption.
export function notificationDeliveryState(tracker) {
  if (!tracker) return null;
  if (tracker.status !== "completed" && tracker.status !== "failed") {
    return { terminal: false, delivered: false, pendingRetry: false };
  }
  const delivered = tracker.notifiedTerminal === true;
  return {
    terminal: true,
    delivered,
    pendingRetry: !delivered,
    inFlight: Boolean(tracker.notifiedTerminalInFlight),
  };
}

// Bounded, payload-free terminal diagnostic for check_runner. Only a stable
// type/reason plus exit/signal/tool metadata — never raw stderr, outputTail, or
// an arbitrary error message (any of which can echo the findings). The full
// diagnostic is preserved on the tracker and delivered by the terminal
// notification, never here.
export function boundedTerminalDiagnostic(tracker) {
  if (!tracker) return null;
  const err = tracker.error && typeof tracker.error === "object" ? tracker.error : {};
  const raw = typeof err.message === "string" ? err.message : "";
  let reason;
  if (/transport error/i.test(raw)) reason = "transport_error";
  else if (/without calling complete_task/i.test(raw)) reason = "no_completion";
  else if (/^Runner (worker|process) exited with code/i.test(raw)) reason = "exit_nonzero";
  else if (/complete_task.*failed/i.test(raw)) reason = "completion_tool_rejected";
  else if (/launch rejected/i.test(raw)) reason = "launch_rejected";
  else if (workerFailureTag(raw) !== "worker_error") reason = workerFailureTag(raw);
  else if (workerFailureTag(tracker.childFailureReason) !== "worker_error") reason = workerFailureTag(tracker.childFailureReason);
  else if (typeof err.exitCode === "number" && err.exitCode !== 0) reason = "exit_nonzero";
  else if (typeof err.signalCode === "string" && err.signalCode) reason = "signalled";
  else reason = "worker_failed";
  const diag = { status: "failed", reason };
  if (typeof err.exitCode === "number") diag.exitCode = err.exitCode;
  if (typeof err.signalCode === "string" && err.signalCode) diag.signalCode = err.signalCode;
  const tool = tracker.activeTool && typeof tracker.activeTool.name === "string" ? tracker.activeTool.name : null;
  if (tool) diag.lastTool = tool;
  return diag;
}

// Rebuild a runner tracker from DURABLE state after a coordinator restart —
// never from the lost in-memory RUNNERS map. Sources, in order: the jobs.json
// compatibility projection (identity, owner routing, result transport, owned
// process identity) and the authoritative change record (validated outcome,
// report reference, launch context). Reload recovery ingests any explicit,
// job-bound, validated result BEFORE interpreting a lost process (exactly like
// the native surface); a cache-less runner is reconstructed from the change
// record alone (the deterministic result transport path derives from the id).
export function reconstructRunnerTracker(runnerId) {
  if (!runnerId || typeof runnerId !== "string") return null;
  const stateDir = stateDirFor(process.cwd(), process.env);
  let record = readJob(stateDir, runnerId);
  let communication = record?.communication ?? null;
  if (!communication) {
    try {
      const state = openChange({ stateDir, changeId: runnerId }).state;
      const job = state.jobs[runnerId];
      const attemptId = job?.attemptOrder?.at(-1) ?? null;
      const attempt = attemptId ? viewsFor(state).attempt(runnerId, attemptId) : null;
      if (job && attempt) {
        communication = {
          schema: 1,
          enabled: true,
          changeId: runnerId,
          jobId: runnerId,
          attemptId,
          consumerId: null,
          stateDir,
          runtimeActorId: "qq-workflows-runtime",
          sessionId: attempt.launchIntent?.owner ?? null,
          ownerRouting: attempt.launchIntent?.owner ?? null,
        };
      }
    } catch {
      communication = null;
    }
  }
  if (!record && !communication) return null;
  if (!record && communication) {
    // The compatibility projection is REBUILDABLE: reconstruct it from the
    // authority so the shared reload recovery can run against it.
    try {
      let launchIntent = null;
      try {
        launchIntent = viewsFor(openChange({ stateDir, changeId: runnerId }).state).attempt(runnerId, communication.attemptId)?.launchIntent ?? null;
      } catch { /* the synthetic record stays minimal */ }
      record = {
        schema: 1,
        id: runnerId,
        role: "runner",
        kind: null,
        workflow: {
          sessionKey: communication.ownerRouting ?? null,
          sessionId: communication.sessionId ?? null,
          ownerAgentId: null,
          root: launchIntent?.cwd ?? null,
        },
        cwd: launchIntent?.cwd ?? process.cwd(),
        task: null,
        status: "running",
        phase: null,
        startedAt: launchIntent?.at ?? Date.now(),
        updatedAt: Date.now(),
        finishedAt: null,
        process: null,
        launchPlan: null,
        cancellation: null,
        terminal: null,
        delivery: null,
        recovery: null,
        events: [],
        resultFile: join(tmpdir(), `qq-runner-result-${runnerId}.json`),
        communication,
      };
      writeJob(stateDir, record);
    } catch {
      return null;
    }
  }
  // Reload recovery FIRST (explicit validated result before process loss),
  // then mirror the authoritative projection onto the rebuilt tracker.
  let recoveredRecord = record;
  try {
    const recovered = reconcileRunnerJob({ stateDir, jobId: runnerId });
    if (recovered.record) recoveredRecord = recovered.record;
  } catch {
    /* the raw record is still a truthful projection */
  }
  const commView = communication
    ? runnerCommunicationView({ stateDir: communication.stateDir ?? stateDir, communication })
    : null;
  const decided = commView?.enabled
    ? (commView.outcome?.status ?? (commView.cancelIntent ? "cancelled" : null))
    : null;
  const status = decided ?? recoveredRecord.status;
  const reportId = recoveredRecord.terminal?.reportId ?? commView?.outcome?.reportId ?? null;
  const retained = loadRetainedFindings(runnerId);
  const tracker = {
    id: runnerId,
    runnerId,
    sessionId: communication?.sessionId ?? recoveredRecord.workflow?.sessionId ?? null,
    cwd: recoveredRecord.cwd ?? process.cwd(),
    task: recoveredRecord.task ?? null,
    status,
    startedAt: recoveredRecord.startedAt ?? Date.now(),
    lastActivityAt: recoveredRecord.telemetry?.lastObservedAt ?? recoveredRecord.startedAt ?? Date.now(),
    activeTool: null,
    trajectory: recoveredRecord.telemetry?.trajectory ?? [],
    result: status === "completed" ? retained?.result ?? null : null,
    error: status === "failed" ? retained?.error ?? (recoveredRecord.terminal?.summary ? { message: recoveredRecord.terminal.summary } : null) ?? { message: "the runner failed before this coordinator started" } : null,
    process: recoveredRecord.process ?? null,
    outputTail: retained?.outputTail ?? "",
    stderrTail: "",
    resultFile: recoveredRecord.resultFile ?? join(tmpdir(), `qq-runner-result-${runnerId}.json`),
    communication,
    recoveredFromRecord: true,
    ...(reportId ? { durableReport: { reportId, chars: recoveredRecord.terminal?.reportChars ?? 0 } } : {}),
  };
  RUNNERS.set(runnerId, tracker);
  return tracker;
}

// Full durable report retrieval through a NORMAL tool (bounded pagination):
// the shared reports.mjs store under the same stateDir convention as the
// native read_report — reachable from a cold-process restart. check_runner
// itself never returns findings.
export function readRunnerReport({ reportId, offset = 0, limit } = {}) {
  if (!reportId || typeof reportId !== "string" || !reportId.trim()) throw new Error("reportId is required");
  const candidates = [stateDirFor(process.cwd(), process.env)];
  for (const tracker of RUNNERS.values()) {
    const dir = tracker?.communication?.stateDir ?? (tracker?.cwd ? trackerStateDir(tracker) : null);
    if (dir && !candidates.includes(dir)) candidates.push(dir);
  }
  let last = null;
  for (const stateDir of candidates) {
    const out = readReport(stateDir, reportId, { offset, ...(limit ? { limit } : {}) });
    if (out.ok) return out;
    last = out;
  }
  return last ?? { ok: false, reportId, error: `no persisted report '${reportId}'` };
}

export async function checkRunner(args = {}) {
  const runnerId = args.runnerId || args.id;
  if (!runnerId) throw new Error("runnerId is required");
  // A restarted coordinator reconstructs the runner from durable state (the
  // jobs.json projection and the authoritative change record); the lost
  // in-memory map is never the only source.
  const runner = RUNNERS.get(runnerId) ?? reconstructRunnerTracker(runnerId);
  if (!runner) throw new Error(`no runner found for id '${runnerId}'`);

  // Dead-process reconcile first: fix the books before reporting.
  reconcileDeadRunner(runner);

  const now = Date.now();
  const elapsedSeconds = Math.round((now - runner.startedAt) / 1000);
  const activeTool = activeToolView(runner.activeTool, now);
  // Rebuilt from the authoritative change record on every read: revision,
  // pending update references (bounded), unresolved revisions, and the
  // attempt's outcome — never the full findings.
  const communication = runner.communication?.enabled
    ? runnerCommunicationView({ stateDir: runner.communication.stateDir ?? trackerStateDir(runner), communication: runner.communication })
    : { enabled: false, supported: false, reason: "no communication binding was prepared for this runner; assignment updates are unsupported and progress is not pushed" };
  // The authoritative outcome wins over any stale tracker projection.
  if (communication.enabled) {
    const decided = communication.outcome?.status ?? (communication.cancelIntent ? "cancelled" : null);
    if (decided && runner.status !== decided) {
      runner.status = decided;
      if (decided !== "completed") runner.result = null;
    }
    if (communication.outcome?.reportId && !runner.durableReport) {
      runner.durableReport = { reportId: communication.outcome.reportId, chars: 0 };
    }
  }

  if (runner.status !== "running") {
    return {
      runnerId: runner.id,
      status: runner.status,
      elapsedSeconds,
      activeTool,
      trajectory: [...runner.trajectory],
      suspicion: null,
      stuckSuspect: false,
      // check_runner reports health, trajectory, and delivery state — NOT
      // findings. The authoritative result stays on the tracker for the
      // terminal notification and its sweeper retries; `notification` surfaces
      // whether that wakeup was confirmed delivered or is still pending.
      notification: notificationDeliveryState(runner),
      findingsRetained: hasRetainedFindings(runner.id),
      // The terminal report reference (never the findings themselves).
      reportId: runner.durableReport?.reportId ?? runner.spilledReport?.reportId ?? communication.outcome?.reportId ?? null,
      communication,
      // Bounded, payload-free failure diagnostic. The full diagnostic (raw
      // stderr/outputTail/message) stays on the tracker for the terminal
      // notification and any retained artifact; check_runner never dumps it.
      ...(runner.status === "failed" ? { error: boundedTerminalDiagnostic(runner) } : {}),
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
    notification: notificationDeliveryState(runner),
    communication,
  };
}

export async function steerRunner(args = {}) {
  const runnerId = args.runnerId || args.id;
  const instruction = args.instruction;
  if (!runnerId) throw new Error("runnerId is required");
  if (!instruction || typeof instruction !== "string") throw new Error("instruction is required");
  const runner = RUNNERS.get(runnerId) ?? reconstructRunnerTracker(runnerId);
  if (!runner) throw new Error(`no runner found for id '${runnerId}'`);
  const communication = runner.communication;
  if (!communication?.enabled || !communication.changeId) {
    // Legacy/non-enabled runner steering: the runner's stdin is /dev/null, so a
    // write there would be ignored delivery theater. Refuse explicitly instead
    // of keeping a false success — and keep the refusal in the trajectory so
    // historical check results identify communication unsupported.
    addTrajectory(runner, {
      action: "steer",
      instruction: String(instruction).slice(0, 500),
      target: "refused: communication unsupported",
      refused: true,
      timestamp: Date.now(),
    });
    return {
      ok: false,
      runnerId,
      status: runner.status,
      supported: false,
      steered: false,
      error: "runner communication is not enabled for this runner; there is no verified receiver to deliver the instruction to, and nothing was sent",
    };
  }
  if (runner.status !== "running") {
    return {
      ok: false,
      runnerId,
      status: runner.status,
      supported: true,
      steered: false,
      error: `cannot steer runner in status '${runner.status}': updates are no longer admitted`,
    };
  }

  const stateDir = communication.stateDir ?? trackerStateDir(runner);
  // The relay push reuses the shared, refcounted relay runtime for this state
  // directory; the hold is dropped as soon as the submission settled.
  const acquired = await acquireRelayRuntime({ stateDir, env: process.env });
  const relay = acquired.ok ? acquired.relay : null;
  let result;
  try {
    result = await steerRunnerLifecycle({
      stateDir,
      changeId: communication.changeId,
      jobId: runnerId,
      message: instruction.trim(),
      relay,
      actor: { kind: "runtime", id: communication.runtimeActorId ?? "qq-workflows-runtime" },
      now: Date.now(),
    });
  } finally {
    if (acquired.ok) void acquired.relay.release();
  }

  addTrajectory(runner, {
    action: "steer",
    instruction: String(instruction).slice(0, 500),
    ...(result.ok ? { target: `revision ${result.revision} (${result.delivery?.status ?? "unknown"})` } : { target: `${result.code}: refused` }),
    timestamp: Date.now(),
  });

  if (!result.ok) {
    return {
      ok: false,
      runnerId,
      status: runner.status,
      supported: true,
      steered: false,
      code: result.code,
      retryable: result.code === "not-bound",
      ...(result.revisionRecorded ? { revisionRecorded: result.revisionRecorded, unresolved: true } : {}),
      error: result.reason,
    };
  }
  // Rebuildable delivery correlation on the in-memory tracker (the
  // authoritative correlation lives in the change record).
  communication.amendments = [
    ...(Array.isArray(communication.amendments) ? communication.amendments : []),
    { amendmentId: result.amendmentId, revision: result.revision, push: { status: result.delivery?.status ?? "unknown", eventId: result.delivery?.eventId ?? null, at: Date.now() } },
  ];
  return {
    ok: true,
    runnerId,
    status: runner.status,
    recorded: true,
    revision: result.revision,
    amendmentId: result.amendmentId,
    delivery: result.delivery,
    acknowledged: false,
    note: "recorded as an assignment update; transport receipt and worker acknowledgement are separate later facts (check_runner)",
  };
}

export async function cancelRunner(args = {}) {
  const runnerId = args.runnerId || args.id;
  if (!runnerId) throw new Error("runnerId is required");
  const runner = RUNNERS.get(runnerId) ?? reconstructRunnerTracker(runnerId);
  if (!runner) throw new Error(`no runner found for id '${runnerId}'`);
  const communication = runner.communication;
  if (communication?.enabled && communication.changeId) {
    // The AUTHORITATIVE change record decides FIRST: an already-validated
    // outcome is never overwritten by a false cancellation, and nothing is
    // signalled before the cancellation intent is durably admitted (a refused
    // or unavailable record fails safely — no tombstone, no signal).
    const stateDir = communication.stateDir ?? trackerStateDir(runner);
    const actor = { kind: "runtime", id: communication.runtimeActorId ?? "qq-workflows-runtime" };
    const readDecided = () => {
      try {
        return viewsFor(openChange({ stateDir, changeId: communication.changeId }).state)
          .attempt(communication.jobId ?? runnerId, communication.attemptId)?.outcome?.status ?? null;
      } catch {
        return null;
      }
    };
    const decided = readDecided();
    if (decided) {
      if (runner.status !== decided) runner.status = decided;
      return {
        ok: decided === "cancelled",
        runnerId,
        status: decided,
        ...(decided === "cancelled" ? {} : { code: "already-decided" }),
        note: `the authoritative change record already holds the validated '${decided}' outcome; nothing was signalled`,
      };
    }
    const intent = recordRunnerCancelIntent({
      stateDir,
      changeId: communication.changeId,
      jobId: runnerId,
      attemptId: communication.attemptId,
      reason: "cancelled by architect",
      actor,
    });
    if (!intent.ok) {
      return {
        ok: false,
        runnerId,
        status: runner.status,
        code: intent.code ?? "refused",
        error: `cancellation refused: ${intent.reason}`,
        note: "no cancellation intent was recorded, no cache tombstone was written, and no process was signalled",
      };
    }
    recordRunnerOutcome({
      stateDir,
      changeId: communication.changeId,
      jobId: runnerId,
      attemptId: communication.attemptId,
      status: "cancelled",
      summary: "cancelled by architect",
      actor,
    });
    const settled = readDecided();
    if (settled !== "cancelled") {
      // The append lost to a validated success (or failed): never signal and
      // never claim an accepted cancellation.
      return {
        ok: false,
        runnerId,
        status: settled ?? runner.status,
        code: "already-decided",
        note: "no accepted authoritative cancellation outcome exists; no process was signalled",
      };
    }
    if (!communication.outcomeRecorded) communication.outcomeRecorded = true;
  }
  if (runner.status === "running") {
    // The cancellation intent is durable BEFORE the owned process is
    // signalled: later output can never become a successful outcome.
    runner.cancelRequested = true;
    runner.status = "cancelled";
    runner.activeTool = null;
    addTrajectory(runner, { action: "cancelled", timestamp: Date.now() });
    // The durable compatibility projection mirrors the tombstone (a no-op for
    // legacy runners without one).
    try {
      recordCancellation(communication?.stateDir ?? trackerStateDir(runner), runnerId, {
        by: runner.sessionId ?? "architect",
        reason: "cancelled by architect",
        now: Date.now(),
      });
    } catch {
      /* legacy runners may have no durable projection */
    }
    if (runner.process && typeof runner.process.kill === "function") {
      try {
        runner.process.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    } else if (runner.process?.pid && runner.process?.fingerprint) {
      // A reconstructed handle has no live ChildProcess: only a
      // fingerprint-matched owned process is ever signalled.
      const live = processFingerprint({ pid: runner.process.pid });
      const recorded = runner.process.fingerprint;
      if (live && recorded && live.startTicks === recorded.startTicks && live.cmdlineHash === recorded.cmdlineHash) {
        try { process.kill(runner.process.pid, "SIGTERM"); } catch { /* already gone */ }
      }
    } else if (!runner.process) {
      cleanupRunnerFiles(runner);
    }
  }

  return { ok: true, runnerId, status: runner.status === "running" ? "cancelled" : runner.status };
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

// Managed (implementer/reviewer) seat launcher. Every worker seat launches
// through the central operator configuration; the per-call `provider` is
// ignored here (and rejected at the public entry points) and is kept only for
// the test-handler signature below.
export async function runChildSubagent(execution, { role, cwd, prompt, provider, roleJobId = null }) {
  // The parent's authoritative cancellation intent is checked BEFORE each role
  // spawn: after an accepted cancellation no further role may start.
  try {
    execution.authority?.assertRoleSpawnAllowed?.({ role });
  } catch (err) {
    return { ok: false, error: { message: `role spawn refused: ${err.message}` } };
  }
  assertExecutionActive(execution);
  if (globalThis.__QQ_TEST_SUBAGENT_HANDLER) {
    try {
      const res = await globalThis.__QQ_TEST_SUBAGENT_HANDLER({ role, cwd, prompt, provider, execution });
      return res;
    } catch (err) {
      return { ok: false, error: { message: err.message } };
    }
  }

  const seatAttemptId=randomUUID();
  const seatJobId=roleJobId ?? randomUUID();
  const seatResultDir=join(trackerStateDir(execution,{cwd}),"seat-results");
  mkdirSync(seatResultDir,{recursive:true,mode:0o700});
  const seatBinding={schema:1,role,jobId:seatJobId,attemptId:seatAttemptId,path:join(seatResultDir,`${seatJobId}-${seatAttemptId}.json`)};
  const attempt={role,jobId:seatJobId,attemptId:seatAttemptId,resultFile:seatBinding.path,startedAt:Date.now(),status:"running"};
  execution.childAttempts ??= [];
  execution.childAttempts.push(attempt);
  // Child role/job/attempt identity and its assignment revision land in the
  // same authoritative change record BEFORE the seat exists (fail closed).
  try {
    const registered = execution.authority?.registerRoleAttempt?.({ role, jobId: seatJobId, attemptId: seatAttemptId, prompt, retryOfJobId: roleJobId, cwd });
    if (registered?.instructions) prompt = registered.instructions;
  } catch (err) {
    attempt.status = "failed";
    return { ok: false, exitCode: 1, error: { message: `role attempt refused by the authoritative record: ${err.message}`, exitCode: 1 } };
  }
  let launch;
  let roleCommunication = null;
  try {
    launch = buildCentralWorkerLaunch({ seat: role, cwd, prompt, env: process.env,mcpEnv:{QQ_WORKER_RESULT_BINDING:JSON.stringify(seatBinding)} });
    if(execution.authority?.recordEvidence) {
      const capability={supported:launch.config.harness==="pi",harness:launch.config.harness,
        reason:launch.config.harness==="pi"?null:`assignment updates and progress push are unsupported for harness '${launch.config.harness}'`};
      const registered=execution.authority.recordEvidence({jobId:seatJobId,attemptId:seatAttemptId,label:"communication-capability",note:JSON.stringify(capability)});
      if(!registered.ok)throw new Error(`role communication capability could not be recorded: ${registered.reason}`);
    }
    if (execution.authority && launch.config.harness === "pi") {
      roleCommunication = await prepareManagedRoleCommunication({stateDir:execution.authority.stateDir,executionId:execution.authority.executionId,
        jobId:seatJobId,attemptId:seatAttemptId,role});
      launch = buildCentralWorkerLaunch({seat:role,cwd,prompt,env:process.env,config:launch.config,
        mcpEnv:{QQ_WORKER_RESULT_BINDING:JSON.stringify(seatBinding),...roleCommunication.bindingEnv}});
    }
  } catch (err) {
    await roleCommunication?.release();
    const report = saveReport(trackerStateDir(execution,{cwd}),{jobId:seatJobId,role,text:`Worker launch rejected: ${err.message}`});
    Object.assign(attempt,{status:"failed",reportId:report.reportId,reportChars:report.chars});
    try {
      const outcome=execution.authority?.recordRoleOutcome?.({jobId:seatJobId,attemptId:seatAttemptId,status:"failed",summary:err.message,reportId:report.reportId});
      if(outcome&&!outcome.ok)attempt.authorityError=outcome.reason;
    } catch(error){attempt.authorityError=String(error?.message??error);}
    return {
      ok: false,
      exitCode: 1,
      reportId:report.reportId,
      error: { message: `Worker launch rejected: ${err.message}`, exitCode: 1 },
    };
  }
  // Explicit test/operator binary override for the offline suites; the centrally
  // configured provider/model/harness still govern the argv.
  if (process.env.QQ_SUBAGENT_BIN) launch.bin = process.env.QQ_SUBAGENT_BIN;

  // Fresh per-child stream state. Structured terminal text wins; accumulated
  // plain-text lines are the fallback when no terminal event is emitted.
  delete execution._cleanOutput;
  delete execution._musePendingTools;

  return new Promise((resolvePromise) => {
    let output = "";
    let stderr = "";
    let child;
    try {
      child = spawn(launch.bin, launch.args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: launch.env,
      });
    } catch (err) {
      resolvePromise({ ok: false, error: { message: err.message } });
      return;
    }
    execution.activeChild = child;
    execution.activeChildFingerprint = processFingerprint({pid:child.pid});

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

    child.on("close", (code, signal) => {
      execution.activeChild = null;
      execution.activeTool = null;
      const finalOutput = finishCleanOutput();
      const cancelled = Boolean(execution.cancellation);
      // Failure diagnostics keep the same durable weight as success findings:
      // a failed or cancelled role stays diagnosable after any restart.
      const failureReport = (text) => {
        try {
          return saveReport(trackerStateDir(execution, { cwd }), {
            jobId: seatJobId,
            role,
            text: text || `# ${role} failure diagnostics\n\n${JSON.stringify({ code, stderr: stderr.trim() }, null, 2)}`,
          });
        } catch { return null; }
      };
      const settleAuthority = (status, { summary = "", reportId = null, claimedRevision = null } = {}) => {
        try {
          const outcome = execution.authority?.recordRoleOutcome?.({
            role, jobId: seatJobId, attemptId: seatAttemptId, status, summary, reportId, claimedRevision,
            identity: { seat: role, resultBinding: { jobId: seatJobId, attemptId: seatAttemptId, role } },
          });
          if (outcome && (!outcome.ok || outcome.status !== status)) throw new Error(outcome.reason ?? `authority retained ${outcome.status}, not ${status}`);
          return outcome ?? {ok:true,status};
        } catch (err) {
          attempt.authorityError = String(err?.message ?? err);
          return {ok:false,reason:attempt.authorityError};
        }
      };
      if (code === 0 && launch.config.harness === "pi") {
        const result=readSeatResult(seatBinding);
        if(!result.ok){
          attempt.status= cancelled ? "cancelled" : "failed";
          const report = failureReport(finalOutput || result.error);
          Object.assign(attempt, { reportId: report?.reportId ?? null, reportChars: report?.chars ?? 0 });
          settleAuthority(cancelled ? "cancelled" : "failed", { summary: result.error, reportId: report?.reportId ?? null });
          resolvePromise({ok:false,output:finalOutput,error:{message:result.error,exitCode:code}});return;
        }
        const report=saveReport(trackerStateDir(execution,{cwd}),{jobId:seatJobId,role,text:result.response});
        Object.assign(attempt,{status: cancelled ? "cancelled" : "completed", revision:result.revision, reportId:report.reportId, reportChars:report.chars});
        // The validated result revision is the acknowledged/pinned revision the
        // record enforces — never whatever revision happens to exist later.
        const accepted = settleAuthority(cancelled ? "cancelled" : "completed", { summary: result.response.slice(0, 400), reportId: report.reportId, claimedRevision: result.revision ?? null });
        if (!accepted.ok || cancelled) {
          attempt.status = cancelled ? "cancelled" : "reconciliation-required";
          resolvePromise({ok:false,status:attempt.status,output:result.response,reportId:report.reportId,error:{message:accepted.reason??"role was cancelled before result publication"}});return;
        }
        resolvePromise({ok:true,output:result.response,reportId:report.reportId,revision:result.revision,jobId:seatJobId,attemptId:seatAttemptId});
      } else if (code === 0) {
        attempt.status= cancelled ? "cancelled" : "completed";
        const report=saveReport(trackerStateDir(execution,{cwd}),{jobId:seatJobId,role,text:finalOutput||`${role} exited with code 0 without a text report.`});
        Object.assign(attempt,{reportId:report.reportId,reportChars:report.chars});
        const accepted=settleAuthority(attempt.status,{summary:cancelled?"cancelled before the seat result settled":finalOutput.slice(0,400),reportId:report.reportId});
        if(!accepted.ok||cancelled) {
          attempt.status=cancelled?"cancelled":"reconciliation-required";
          resolvePromise({ok:false,status:attempt.status,output:finalOutput,reportId:report.reportId,error:{message:accepted.reason??"role was cancelled before result publication"}});return;
        }
        resolvePromise({ ok: true, output: finalOutput, reportId:report.reportId, jobId:seatJobId, attemptId:seatAttemptId });
      } else {
        attempt.status= cancelled ? "cancelled" : "failed";
        // A strict result written before a later adapter failure is useful
        // evidence, not a successful managed attempt. Preserve its full text.
        const durable=launch.config.harness==="pi"?readSeatResult(seatBinding):null;
        const report = failureReport(durable?.ok?durable.response:finalOutput);
        Object.assign(attempt, { reportId: report?.reportId ?? null, reportChars: report?.chars ?? 0 });
        const exitReason=signal?`terminated by ${signal}`:`exited with code ${code}`;
        settleAuthority(cancelled ? "cancelled" : "failed", { summary: exitReason, reportId: report?.reportId ?? null });
        resolvePromise({
          ok: false,
          output: finalOutput,
          error: { message: `Child process ${exitReason}`, exitCode: code, signal, stderr: stderr.trim() },
        });
      }
    });

    child.on("error", (err) => {
      execution.activeChild = null;
      execution.activeTool = null;
      delete execution._cleanOutput;
      delete execution._musePendingTools;
      attempt.status = execution.cancellation ? "cancelled" : "failed";
      try {
        execution.authority?.recordRoleOutcome?.({
          role, jobId: seatJobId, attemptId: seatAttemptId, status: attempt.status, summary: `process error: ${err.message}`,
          identity: { seat: role, resultBinding: { jobId: seatJobId, attemptId: seatAttemptId, role } },
        });
      } catch (recordErr) {
        attempt.authorityError = String(recordErr?.message ?? recordErr);
      }
      resolvePromise({
        ok: false,
        error: { message: err.message, stderr: stderr.trim() },
      });
    });
  }).finally(async()=>{
    try {await roleCommunication?.release();}
    catch(error){attempt.cleanupError=String(error?.message??error);}
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
  const phaseId = execution.phaseId ?? sessionId;

  touchActivity(execution);
  addTrajectory(execution, { action: "provision_worktree", timestamp: Date.now() });
  assertExecutionActive(execution);
  const wt = await createWorktree(root, { kind, sessionId: phaseId, ...(args.baseRef ? { base: args.baseRef } : {}) });
  assertExecutionActive(execution);
  execution.worktree = wt.cwd;
  execution.branch = wt.branch;
  execution.baseSelection = wt.baseSelection ?? {ref:args.baseRef??wt.branch,sha:(await git(wt.cwd,["rev-parse","HEAD"])).trim(),source:wt.reused?"reused-worktree":"local-branch"};
  if(execution.authority?.recordEvidence) {
    const parent=execution.authority.view().execution;
    const recorded=execution.authority.recordEvidence({jobId:parent.jobId,attemptId:parent.attemptId,label:"worktree-base",
      note:JSON.stringify({worktree:wt.cwd,branch:wt.branch,baseSelection:execution.baseSelection})});
    if(!recorded.ok)throw new Error(`worktree base provenance could not be recorded: ${recorded.reason}`);
  }
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

  assertExecutionActive(execution);
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

    assertExecutionActive(execution);
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
        // A retry is a NEW attempt on the same role job: it retains the
        // original constraints and applicable acknowledged instructions;
        // unresolved old-attempt obligations never migrate here.
        roleJobId: execution.childAttempts?.find((entry) => entry.role === "implementer")?.jobId ?? null,
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
        roleJobId: execution.childAttempts?.find((entry) => entry.role === "reviewer")?.jobId ?? null,
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

  assertExecutionActive(execution);
  const hasChanges = await hasImplementationChanges(wt.cwd, wt.branch);
  assertExecutionActive(execution);
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

  // The landing-admission boundary is serialized with cancellation and update
  // state through the authoritative record: an accepted cancellation or a
  // pending unacknowledged update newer than the validated result BLOCKS
  // automatic landing (the obligation stays visible for an explicit decision),
  // and landing evidence is preserved either way. Landing is never implied
  // rolled back once admitted.
  if (execution.authority?.admitLanding) {
    const resultRevision = (execution.childAttempts ?? [])
      .map((entry) => entry.revision ?? null)
      .filter((entry) => Number.isInteger(entry))
      .sort((a, b) => a - b)
      .pop() ?? null;
    const admission = await execution.authority.admitLanding({ resultRevision, note: `landing ${wt.branch}` });
    if (!admission.ok) {
      execution.status = "failed";
      execution.error = {
        phase: "landing",
        status: "landing-refused",
        code: admission.code ?? null,
        message: `Landing refused: ${admission.reason}`,
        pending: admission.pending ?? null,
        landingEvidence: admission.landingEvidence ?? null,
      };
      addTrajectory(execution, { action: "landing_refused", reason: admission.reason, timestamp: Date.now() });
      await notifyTerminal(execution, "execution");
      return;
    }
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
  if (!execution.cancellation) execution.status = "completed";
  execution.result = {
    baseSelection: execution.baseSelection,
    verifiedStory: `Worktree ${wt.branch} successfully verified and landed.`,
    landingOutcome: landResult,
    childAttempts: execution.childAttempts ?? [],
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

function assertExecutionActive(execution) {
  if (execution.cancellation) throw new Error("managed execution cancellation prevents further work or landing");
}

// Internal host cancellation. Intent is set before inspecting or signalling the
// exact child handle; signals are never interpreted as operator intent.
export async function cancelExecution({id,reason="cancelled by architect",interrupted=false}={}) {
  const execution=EXECUTIONS.get(id);
  if (!execution) return {ok:false,reason:"unknown execution"};
  if (execution.status!=="running") return {ok:true,status:execution.status,signalled:false};
  execution.cancellation={at:Date.now(),reason,interrupted};
  execution.status=interrupted ? "interrupted" : "cancelled";
  const child=execution.activeChild;
  const expected=execution.activeChildFingerprint;
  const current=child?.pid ? processFingerprint({pid:child.pid}) : null;
  let signalled=false;
  if (expected && current && expected.startTicks===current.startTicks && expected.cmdlineHash===current.cmdlineHash) {
    try { signalled=child.kill("SIGTERM"); } catch {}
  }
  return {ok:true,status:execution.status,signalled};
}

export async function dispatchExecution(args = {}) {
  const { kind, cwd = process.cwd() } = args;
  if (!kind || (kind !== "bounded" && kind !== "open")) {
    throw new Error("kind is required: 'bounded' | 'open'");
  }
  // The managed pipeline owns worker provider/model selection: a per-call
  // override (or a conflicting legacy provider env) refuses the dispatch before
  // any worktree, implementer, or reviewer is started.
  assertNoProviderOverrides(args);

  if (args.phaseId !== undefined && !args.sessionId && !args.id) throw new Error("phaseId requires an explicit coordinating sessionId; owner is never inferred from the phase ticket");
  const root = await mainRepoRoot(cwd);
  const sessionId = await resolveSessionId(root, args.sessionId || args.id);
  const phaseId = args.phaseId ?? sessionId;
  if (args.phaseId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(phaseId)) throw new Error("phaseId must be a ticket UUID");
  await resolveTicketSource(root, phaseId);
  for (const existing of EXECUTIONS.values()) {
    if (existing.root === root && (existing.phaseId ?? existing.sessionId) === phaseId && existing.status === "running") {
      throw new Error("phase already has a running managed execution");
    }
  }
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
    phaseId,
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
    // The authoritative change-record hooks (supplied by the owned host for
    // host-managed executions). No second authority: these only append to or
    // read the ONE change record.
    authority: args.authority ?? null,
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
  }).finally(() => { execution.pipelineSettled = true; });

  return { ok: true, id, status: "running", phase: "implementing" };
}

// The bounded authoritative projection check_execution exposes. A legacy
// harness execution without workflow communication says so explicitly — it
// never pretends assignment updates or progress are supported.
export function executionAuthorityView(exec) {
  if (exec?.authority?.view) {
    try {
      return exec.authority.view();
    } catch (error) {
      return { enabled: true, supported: true, recordUnavailable: String(error?.message ?? error).slice(0, 200) };
    }
  }
  return {
    enabled: false,
    supported: false,
    reason:
      "no authoritative change record is attached to this execution; assignment updates and progress are unsupported for this legacy harness execution",
  };
}

// Submit an assignment update to the EXACT currently intended active
// implementer/reviewer attempt. The target is bound before submission; a
// phase/attempt change races to a truthful refusal, never a silent retarget.
export async function steerExecutionTool(args = {}) {
  const id = args.id || args.jobId || args.executionId;
  const message = args.message;
  if (!id) throw new Error("id is required");
  if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
  const target = { message, expectAttemptId: args.expectAttemptId ?? null, expectJobId: args.expectJobId ?? null };
  const exec = EXECUTIONS.get(id) ?? null;
  if (exec?.authority?.steer) return exec.authority.steer(target);
  try {
    const root = await mainRepoRoot(args.cwd || process.cwd());
    const stateDir = stateDirFor(root);
    const job = readJob(stateDir, id);
    if (job?.role === "execution") return await steerRoleAttempt({ stateDir, executionId: id, ...target });
  } catch (error) {
    return { ok: false, code: error?.code ?? "refused", status: "unresolved", reason: error.message, supported: false };
  }
  return {
    ok: false,
    code: "unsupported",
    status: "refused",
    supported: false,
    reason:
      "steering requires workflow communication with a recorded receiver binding; this legacy harness execution reports communication as unsupported instead of pretending delivery",
  };
}

// Cancel one managed execution: authoritative cancellation intent BEFORE any
// fingerprint-matched owned-process signal; idempotent; never restarts work;
// a begun landing refuses truthfully and keeps its evidence.
export async function cancelExecutionTool(args = {}) {
  const id = args.id || args.jobId || args.executionId;
  const reason = args.reason || "cancelled by architect";
  if (!id) throw new Error("id is required");
  const exec = EXECUTIONS.get(id) ?? null;
  if (exec?.authority?.recordCancelIntent) {
    const intent = exec.authority.recordCancelIntent({ reason });
    if (!intent.ok) {
      return { ...intent, id, signalled: false, note: "cancellation refused truthfully; landing evidence is preserved and no outcome is relabelled" };
    }
  }
  if (exec) {
    const cancelled = await cancelExecution({ id, reason, interrupted: false });
    return { ok: true, id, ...cancelled, authoritative: Boolean(exec.authority) };
  }
  try {
    const root = await mainRepoRoot(args.cwd || process.cwd());
    const stateDir = stateDirFor(root);
    const job = readJob(stateDir, id);
    if (job?.role === "execution") {
      const cancelled = cancelExecutionHost({ stateDir, jobId: id, by: "mcp", reason });
      return { id, ...cancelled };
    }
  } catch (error) {
    return { ok: false, code: error?.code ?? "refused", reason: error.message, signalled: false };
  }
  return { ok: false, code: "unknown-execution", reason: `no managed execution '${id}' is running here or recorded in the workflow state`, signalled: false };
}

export async function checkExecution(args = {}) {
  const id = args.id || args.executionId;
  if (!id) throw new Error("id is required");
  const exec = EXECUTIONS.get(id);
  if (!exec) throw new Error(`no execution found for id '${id}'`);

  const now = Date.now();
  const elapsedSeconds = Math.round((now - exec.startedAt) / 1000);
  const activeTool = activeToolView(exec.activeTool, now);
  const authority = executionAuthorityView(exec);

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
      pipelineSettled: exec.pipelineSettled === true,
      result: exec.result,
      error: exec.error,
      childAttempts: exec.childAttempts ?? [],
      authority,
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
    authority,
  };
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
      `response exceeds the ${FINAL_RESPONSE_MAX_CHARS_LABEL}-character cap (got ${response.length} chars). Summarize before calling complete_task.`,
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

// Tool exclusion for clients that must not see certain tools. Configured via
// the `--disabled-tools <comma-separated-names>` CLI arg and/or the
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
  if (name === "retry_runner_notification") {
    // Routing is taken ONLY from the retained record; the caller supplies no
    // thread/session and ownership is verified against trusted runtime context.
    return replayRetainedRunnerFindings(args.runnerId);
  }
  if (name === "read_report") return managedExecutionSurface.readReport(args);
  if (name === "dispatch_execution") {
    assertNoProviderOverrides(args);
    return managedExecutionSurface.dispatch(args);
  }
  if (name === "check_execution") {
    return EXECUTIONS.has(args.id??args.jobId) ? checkExecution(args) : managedExecutionSurface.check(args);
  }
  if (name === "steer_execution") {
    return EXECUTIONS.has(args.id??args.jobId) ? steerExecutionTool(args) : managedExecutionSurface.steer(args);
  }
  if (name === "cancel_execution") {
    return EXECUTIONS.has(args.id??args.jobId) ? cancelExecutionTool(args) : managedExecutionSurface.cancel(args);
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
  void managedExecutionSurface.recover().catch(() => {});
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
