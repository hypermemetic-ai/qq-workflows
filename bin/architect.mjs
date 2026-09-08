#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ensureTicket, ticketPath } from "../workflow/ticket.mjs";

import { createWorktree, landWorktree, retireWorktree } from "../workflow/git.mjs";

const realAgy = process.env.REAL_AGY_BIN || "/home/qqp/.local/bin/agy";
const args = process.argv.slice(2);

// Handle subcommands
const sub = args[0];
if (sub === "prepare") {
  let kind = "bounded";
  let sessionId = null;
  let base = "HEAD";
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--kind" && i + 1 < args.length) { kind = args[++i]; }
    else if ((args[i] === "--session" || args[i] === "-c" || args[i] === "--conversation") && i + 1 < args.length) { sessionId = args[++i]; }
    else if (args[i] === "--base" && i + 1 < args.length) { base = args[++i]; }
  }
  const result = await createWorktree(process.cwd(), { kind, sessionId: sessionId || randomUUID(), base });
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (sub === "land") {
  let worktree = null;
  let branch = null;
  let message = null;
  let title = null;
  let body = null;
  let deleteBranch = true;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--worktree" && i + 1 < args.length) { worktree = args[++i]; }
    else if (args[i] === "--branch" && i + 1 < args.length) { branch = args[++i]; }
    else if (args[i] === "--message" && i + 1 < args.length) { message = args[++i]; }
    else if (args[i] === "--title" && i + 1 < args.length) { title = args[++i]; }
    else if (args[i] === "--body" && i + 1 < args.length) { body = args[++i]; }
    else if (args[i] === "--no-delete-branch") { deleteBranch = false; }
  }
  const result = await landWorktree(process.cwd(), { worktree, branch, message, title, body, deleteBranch });
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (sub === "retire") {
  let worktree = null;
  let branch = null;
  let force = true;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--worktree" && i + 1 < args.length) { worktree = args[++i]; }
    else if (args[i] === "--branch" && i + 1 < args.length) { branch = args[++i]; }
    else if (args[i] === "--no-force") { force = false; }
  }
  const result = await retireWorktree(process.cwd(), { worktree, branch, force });
  console.log(JSON.stringify(result));
  process.exit(0);
}

// Check if a conversation ID or session was provided
let sessionId = null;
const filteredArgs = [];
for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--conversation" || args[i] === "--session" || args[i] === "-c") && i + 1 < args.length) {
    sessionId = args[i + 1];
    i++;
    continue;
  }
  filteredArgs.push(args[i]);
}

if (!sessionId) {
  sessionId = randomUUID();
}

// 1. Ensure ticket is created on disk before launching agy
const { path } = await ensureTicket(process.cwd(), { sessionId });
console.log(`[architect] Session ticket created at ${ticketPath(".", sessionId)}`);

// 2. Launch agy with concrete conversation ID and agent
const agyArgs = [
  "--agent", "architect",
  "--conversation", sessionId,
  "--dangerously-skip-permissions",
  ...filteredArgs,
];

const child = spawn(realAgy, agyArgs, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
