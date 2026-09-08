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
export const TOOLS = [
  {
    name: "prepare_worktree",
    description: "Prepare a git worktree and branch for delegation to an implementer (bounded or open).",
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
    description: "Land changes from an implementer worktree: commit changes, merge PR (or fast-forward main), and retire worktree and branch.",
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
  return (await resolveActiveSessionId(root, explicitId)) || randomUUID();
}

export async function prepareWorktree(args = {}) {
  const { kind, cwd = process.cwd() } = args;
  if (!kind || (kind !== "bounded" && kind !== "open")) {
    throw new Error("kind is required: 'bounded' | 'open'");
  }

  const root = await mainRepoRoot(cwd);
  const sessionId = await resolveSessionId(root, args.sessionId || args.id || args.conversationId);

  const wt = await createWorktree(root, { kind, sessionId });
  const reviewRequired = kind === "open";

  const implementerPrompt = `Implement .architect/ticket.md in the checkout. When finished, report your answer.`;
  const reviewerPrompt = `Follow .architect/ticket.md in the checkout. Follow its testing plan. Do not change project code. Report findings. Empty findings means it passed.`;

  const instructions = reviewRequired
    ? `Worktree ready at ${wt.cwd}.\nBranch: ${wt.branch}\nReview required: true\n\nNext steps:\n1. Invoke implementer subagent with Prompt: "${implementerPrompt}"\n2. When implementation finishes, invoke reviewer subagent with Prompt: "${reviewerPrompt}"\n3. When review passes, call 'land'.`
    : `Worktree ready at ${wt.cwd}.\nBranch: ${wt.branch}\nReview required: false\n\nNext steps:\n1. Invoke implementer subagent with Prompt: "${implementerPrompt}"\n2. When finished, call 'land'.`;

  return {
    ok: true,
    kind,
    branch: wt.branch,
    worktree: wt.cwd,
    reviewRequired,
    implementerPrompt,
    ...(reviewRequired ? { reviewerPrompt } : {}),
    instructions,
  };
}

export async function land(args = {}) {
  const cwd = args.cwd || process.cwd();
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
