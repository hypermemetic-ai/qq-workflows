#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  createWorktree,
  currentBranch,
  git,
  landWorktree,
  mainRepoRoot,
  parseWorktreePorcelain,
} from "../workflow/git.mjs";
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

export { CANONICAL_PROVIDERS, PROVIDERS, assertKnownProvider, normalizeProvider };

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
          description: "Narrative findings/outcome. Hard cap of 3,500 characters.",
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
    `Delegate via run_command (with Cwd: ${cwd}) using a fresh conversation: 'agy --agent implementer --conversation ${conversationId} --print-timeout 60m --print "${prompt} Leave changes uncommitted. Do not commit, push, review, or land."'\nDo NOT pass '--new-project'.`,
  deepseek: (cwd, prompt) => `Delegate via run_command (with Cwd: ${cwd}): 'dsh --profile implementer "${prompt} Leave changes uncommitted. Do not commit, push, review, or land."'`,
  codex: (cwd, prompt) => `Delegate via run_command (with Cwd: ${cwd}): 'codex exec --profile implementer "${prompt} Leave changes uncommitted. Do not commit, push, review, or land."'`,
};
IMPLEMENTER_TEMPLATES.astra = IMPLEMENTER_TEMPLATES.codex;

const REVIEWER_TEMPLATES = {
  muse: (cwd, prompt) => `invoke reviewer via run_command (with Cwd: ${cwd}): 'muse exec --preset reviewer --yolo "${prompt} Do not commit, push, or land."'`,
  gemini: (cwd, prompt, conversationId) =>
    `invoke reviewer via run_command (with Cwd: ${cwd}) using a fresh conversation: 'agy --agent reviewer --conversation ${conversationId} --print-timeout 60m --print "${prompt} Do not commit, push, or land."'\nDo NOT pass '--new-project'.`,
  codex: (cwd, prompt) => `invoke reviewer via run_command (with Cwd: ${cwd}): 'codex exec --profile reviewer "${prompt} Do not commit, push, or land."'`,
};
REVIEWER_TEMPLATES.astra = REVIEWER_TEMPLATES.codex;

const RESEARCHER_TEMPLATES = {
  muse: (cwd, prompt) => `Delegate via run_command (with Cwd: ${cwd}): 'muse exec --preset researcher --yolo "${prompt} Leave files uncommitted. Do not commit, push, or land."'`,
  gemini: (cwd, prompt) => `Invoke research subagent with ticket path ${cwd}/.architect/ticket.md and worktree cwd via run_command (with Cwd: ${cwd}) using Prompt: "${prompt} Leave files uncommitted. Do not commit, push, or land."`,
  codex: (cwd, prompt) => `Delegate via run_command (with Cwd: ${cwd}): 'codex exec --profile researcher "${prompt} Leave files uncommitted. Do not commit, push, or land."'`,
};
RESEARCHER_TEMPLATES.astra = RESEARCHER_TEMPLATES.codex;

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
    const researcherPrompt = "Investigate .architect/ticket.md in the checkout. Report findings.";
    const step = buildResearcherStep(wt.cwd, researcherPrompt, researcherProvider);
    const instructions = `Worktree ready at ${wt.cwd}.\nBranch: ${wt.branch}\nReview required: false\n\nNext steps:\n1. ${step}\n2. When finished, call 'land'.`;

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
  const implementerPrompt = `Implement .architect/ticket.md in the checkout. When finished, report your answer.`;
  const reviewerPrompt = `Follow .architect/ticket.md in the checkout. Follow its testing plan. Do not change project code. Report findings. Empty findings means it passed.`;
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
    return { reconciled: true, status: "cancelled", signalCode };
  }
  if (exitCode === 0) {
    runner.status = "completed";
    if (runner.result == null) {
      const tail = (runner.outputTail || "").trim();
      runner.result = tail || "";
    }
    runner.activeTool = null;
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
  return { reconciled: true, status: "failed", exitCode };
}

// ============================================================================
// Runner helper implementation
// ============================================================================

export const RUNNERS = new Map();

export async function dispatchRunner(args = {}) {
  const { task, targetPaths, cwd = process.cwd() } = args;
  if (!task || typeof task !== "string" || !task.trim()) {
    throw new Error("task is required");
  }

  const runnerId = randomUUID();
  const startedAt = Date.now();
  const runner = {
    id: runnerId,
    runnerId,
    task,
    targetPaths: Array.isArray(targetPaths) ? targetPaths : [],
    cwd,
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
  };
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
      env: { ...process.env },
    });
  } catch (err) {
    runner.status = "failed";
    runner.error = { message: err.message };
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
      return;
    }
    touchActivity(runner);
    if (signal === "SIGTERM" || signal === "SIGINT") {
      runner.status = "cancelled";
      runner.activeTool = null;
      return;
    }
    if (code === 0) {
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
  });

  child.on("error", (err) => {
    if (runner.status !== "running") return;
    runner.status = "failed";
    runner.error = {
      message: err.message,
      stderr: sanitizeHeadTail(stderrBuf.trim()),
    };
    runner.activeTool = null;
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
        if (su.tool_name === "complete_task" && runner.status === "running") {
          const key = process.env.GEMINI_CONVERSATION_ID || process.env.ASTRA_CONVERSATION_ID || "default";
          const recorded = COMPLETE_TASK_REGISTRY.get(key);
          const params = su.tool_info?.parameters;
          const response = recorded?.response ?? params?.response ?? null;
          const data_points = recorded?.data_points ?? params?.data_points ?? [];
          runner.status = "completed";
          runner.result = { response, data_points };
          runner.activeTool = null;
          if (runner.process) {
            try { runner.process.kill("SIGTERM"); } catch {}
          }
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
      // Note: result is intentionally omitted from checkRunner even when completed.
      // Use await_runner to retrieve the final result.
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

export function evaluateReviewPassed(output) {
  if (!output || !output.trim()) return true;
  const text = output.trim();
  if (/verdict:\s*pass\b/i.test(text)) return true;
  if (/verdict:\s*fail\b/i.test(text)) return false;
  if (/defect|failed|error|regression/i.test(text) && !/no defects|all tests pass|0 defects|passed/i.test(text)) {
    return false;
  }
  return true;
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

  const implementerPrompt = "Implement .architect/ticket.md in the checkout. When finished, report your answer.";
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

    const reviewerPrompt = "Follow .architect/ticket.md in the checkout. Follow its testing plan. Do not change project code. Report findings. Empty findings means it passed.";
    let reviewRes = await runChildSubagent(execution, {
      role: "reviewer",
      cwd: wt.cwd,
      prompt: reviewerPrompt,
      provider: reviewerProvider,
    });
    touchActivity(execution);

    if (reviewRes.error) {
      execution.status = "failed";
      execution.error = {
        phase: "reviewing",
        message: reviewRes.error.message || "Reviewer failed",
        exitCode: reviewRes.error.exitCode,
        stderr: reviewRes.error.stderr,
      };
      return;
    }

    let reviewPassed = evaluateReviewPassed(reviewRes.output);
    reviewerSummary = reviewRes.output;

    if (!reviewPassed) {
      execution.phase = "retrying";
      addTrajectory(execution, {
        action: "review_failed_retrying",
        findings: reviewRes.output,
        timestamp: Date.now(),
      });

      const retryPrompt = `Implement .architect/ticket.md in the checkout. The reviewer found defects:\n${reviewRes.output}\nPlease resolve these defects. When finished, report your answer.`;
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

      if (reviewRes.error) {
        execution.status = "failed";
        execution.error = {
          phase: "reviewing",
          message: reviewRes.error.message || "Second reviewer invocation failed",
          exitCode: reviewRes.error.exitCode,
          stderr: reviewRes.error.stderr,
        };
        return;
      }

      reviewPassed = evaluateReviewPassed(reviewRes.output);
      reviewerSummary = reviewRes.output;

      if (!reviewPassed) {
        execution.status = "failed";
        execution.error = {
          phase: "reviewing",
          message: `Review failed after retry: ${reviewRes.output}`,
          findings: reviewRes.output,
        };
        return;
      }
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
}

export async function dispatchExecution(args = {}) {
  const { kind, cwd = process.cwd() } = args;
  if (!kind || (kind !== "bounded" && kind !== "open")) {
    throw new Error("kind is required: 'bounded' | 'open'");
  }

  const root = await mainRepoRoot(cwd);
  const sessionId = await resolveSessionId(root, args.sessionId || args.id);
  await resolveTicketSource(root, sessionId);

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

  runExecutionPipeline(execution).catch((err) => {
    if (execution.status === "running") {
      execution.status = "failed";
      execution.error = {
        phase: execution.phase,
        message: err.message,
        stack: err.stack,
      };
    }
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

// Per-runner complete_task state: tracks whether each runner called complete_task.
// Keyed by runnerId. Also used by the Stop hook for sub-agent tracking.
export const COMPLETE_TASK_REGISTRY = new Map();

const COMPLETE_TASK_RESPONSE_MAX = 3500;
const COMPLETE_TASK_DATA_POINTS_MAX = 20;
const COMPLETE_TASK_DATA_POINT_LEN_MAX = 100;

export async function completeTask(args = {}) {
  const { response, data_points } = args;
  if (!response || typeof response !== "string") {
    throw new Error("response is required and must be a string");
  }
  if (response.length > COMPLETE_TASK_RESPONSE_MAX) {
    throw new Error(
      `response exceeds the 3,500-character cap (got ${response.length} chars). Summarize before calling complete_task.`,
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

  // Mark that complete_task was called for this process/conversation.
  // The Stop hook checks this registry to decide whether to allow termination.
  const key = process.env.GEMINI_CONVERSATION_ID || process.env.ASTRA_CONVERSATION_ID || "default";
  COMPLETE_TASK_REGISTRY.set(key, { calledAt: Date.now(), response, data_points });

  // Write a marker file to tmpdir so the Stop hook subprocess can detect the call
  // across process boundaries (hook runs as a separate Node.js process).
  try {
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const markerPath = joinPath(tmpdir(), `qq-complete-task-${key}.json`);
    await writeFile(markerPath, JSON.stringify({ calledAt: Date.now(), key }), "utf8");
  } catch {
    // Best-effort: marker file failure must never block the tool response.
  }

  return {
    ok: true,
    recorded: true,
    responseLength: response.length,
    dataPointsCount: data_points ? data_points.length : 0,
  };
}

export async function callTool(name, args = {}) {
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
  if (name === "complete_task") {
    return completeTask(args);
  }
  throw new Error(`Unknown tool: ${name}`);
}

export async function handleRpc(method, params = {}) {
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
    return { tools: TOOLS };
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const toolArgs = params?.arguments ?? {};
    try {
      const result = await callTool(toolName, toolArgs);
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

export function startMcpServer({ stdin = process.stdin, stdout = process.stdout } = {}) {
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
      const result = await handleRpc(method, params);
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
