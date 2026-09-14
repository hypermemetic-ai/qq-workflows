#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
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
import { resolveTicketSource } from "../workflow/ticket.mjs";
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
          enum: ["muse", "gemini", "deepseek"],
          description: "Optional global provider default: 'muse' (default), 'gemini', or 'deepseek'. Per-seat providers override it.",
        },
        implementerProvider: {
          type: "string",
          enum: ["muse", "gemini", "deepseek"],
          description: "Optional implementer seat provider: 'muse', 'gemini', or 'deepseek'. Overrides the global provider.",
        },
        reviewerProvider: {
          type: "string",
          enum: ["muse", "gemini", "deepseek"],
          description: "Optional reviewer seat provider: 'muse' or 'gemini' ('deepseek' does not serve this seat). Overrides the global provider.",
        },
        researcherProvider: {
          type: "string",
          enum: ["muse", "gemini", "deepseek"],
          description: "Optional researcher seat provider: 'muse' or 'gemini' ('deepseek' does not serve this seat). Overrides the global provider.",
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
];

export async function resolveActiveSessionId(root, explicitId) {
  if (explicitId) return explicitId;
  const ticketsDir = join(root, ".architect", "tickets");
  if (existsSync(ticketsDir)) {
    try {
      const entries = readdirSync(ticketsDir)
        .filter((f) => f.endsWith(".md"))
        .map((f) => {
          const full = join(ticketsDir, f);
          const stat = statSync(full);
          return { name: f, mtime: stat.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      if (entries.length > 0) {
        return basename(entries[0].name, ".md");
      }
    } catch {
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

// Canonical providers. Only these strings are accepted; there are no
// aliases (e.g. 'agy' for gemini, 'dsh' for deepseek).
export const PROVIDERS = ["muse", "gemini", "deepseek"];

// Which providers serve which seat. Wiring a provider into another seat
// later is additive: extend the seat's list and add its template below.
export const SEAT_PROVIDERS = {
  implementer: ["muse", "gemini", "deepseek"],
  reviewer: ["muse", "gemini"],
  researcher: ["muse", "gemini"],
  architect: ["muse", "gemini"],
};

export function assertKnownProvider(value) {
  if (!PROVIDERS.includes(value)) {
    throw new Error(`unknown provider '${value}': expected 'muse' | 'gemini' | 'deepseek'`);
  }
  return value;
}

// Resolve which provider serves a seat. Precedence:
// seat arg > seat env > global arg > global env > 'muse'.
// Unknown strings always throw; a known provider that does not serve the
// seat throws with no silent fallback.
export function resolveProvider(seat, { arg, seatEnv, globalArg, globalEnv } = {}) {
  for (const value of [arg, seatEnv, globalArg, globalEnv]) {
    if (value !== undefined && value !== null) assertKnownProvider(value);
  }
  const raw = arg ?? seatEnv ?? globalArg ?? globalEnv ?? "muse";
  if (!SEAT_PROVIDERS[seat].includes(raw)) {
    throw new Error(`provider '${raw}' does not support seat '${seat}'`);
  }
  return raw;
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
};

const REVIEWER_TEMPLATES = {
  muse: (cwd, prompt) => `invoke reviewer via run_command (with Cwd: ${cwd}): 'muse exec --preset reviewer --yolo "${prompt} Do not commit, push, or land."'`,
  gemini: (cwd, prompt, conversationId) =>
    `invoke reviewer via run_command (with Cwd: ${cwd}) using a fresh conversation: 'agy --agent reviewer --conversation ${conversationId} --print-timeout 60m --print "${prompt} Do not commit, push, or land."'\nDo NOT pass '--new-project'.`,
};

const RESEARCHER_TEMPLATES = {
  muse: (cwd, prompt) => `Delegate via run_command (with Cwd: ${cwd}): 'muse exec --preset researcher --yolo "${prompt} Leave files uncommitted. Do not commit, push, or land."'`,
  gemini: (cwd, prompt) => `Invoke research subagent with ticket path ${cwd}/.architect/ticket.md and worktree cwd via run_command (with Cwd: ${cwd}) using Prompt: "${prompt} Leave files uncommitted. Do not commit, push, or land."`,
};

export function buildImplementerStep(cwd, prompt, provider, conversationId) {
  return IMPLEMENTER_TEMPLATES[provider](cwd, prompt, conversationId);
}

export function buildReviewerStep(cwd, prompt, provider, conversationId) {
  return REVIEWER_TEMPLATES[provider](cwd, prompt, conversationId);
}

export function buildResearcherStep(cwd, prompt, provider) {
  return RESEARCHER_TEMPLATES[provider](cwd, prompt);
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
  });

  return {
    ok: true,
    ...result,
  };
}

export async function callTool(name, args = {}) {
  if (name === "prepare_worktree") {
    return prepareWorktree(args);
  }
  if (name === "land") {
    return land(args);
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
