#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureTicket, ticketPath } from "../workflow/ticket.mjs";

import { createWorktree, landWorktree, retireWorktree } from "../workflow/git.mjs";
import { resolveProvider } from "./mcp-server.mjs";

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
  if (!sessionId) {
    console.error("usage: architect prepare --kind <bounded|open|research> --session <id> [--base <ref>]");
    process.exit(2);
  }
  const result = await createWorktree(process.cwd(), { kind, sessionId, base });
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

if (sessionId) {
  await ensureTicket(process.cwd(), { sessionId });
  console.log(`[architect] Resuming session ticket at ${ticketPath(".", sessionId)}`);
}

// Determine architect seat provider (default: muse, served via muse-architect)
let providerArg;
const finalArgs = [];
for (let i = 0; i < filteredArgs.length; i++) {
  if (filteredArgs[i] === "--provider" && i + 1 < filteredArgs.length) {
    providerArg = filteredArgs[++i];
  } else {
    finalArgs.push(filteredArgs[i]);
  }
}

let provider;
try {
  provider = resolveProvider("architect", {
    arg: providerArg,
    seatEnv: process.env.ARCHITECT_PROVIDER,
  });
} catch (err) {
  console.error(`[architect] ${err.message}`);
  process.exit(1);
}

let child;
if (provider === "gemini") {
  const agyArgs = [
    "--agent", "architect",
    "--dangerously-skip-permissions",
    ...(sessionId ? ["--conversation", sessionId] : []),
    ...finalArgs,
  ];
  child = spawn(realAgy, agyArgs, { stdio: "inherit" });
} else if (provider === "codex" || provider === "astra") {
  const codexArchitectBin = process.env.CODEX_ARCHITECT_BIN || join(homedir(), ".local", "bin", "codex-architect");
  const codexArchitectArgs = [
    ...(sessionId ? ["--session", sessionId] : []),
    ...finalArgs,
  ];
  child = spawn(codexArchitectBin, codexArchitectArgs, { stdio: "inherit" });
} else {
  const museArchitectBin = process.env.MUSE_ARCHITECT_BIN || join(homedir(), ".local", "bin", "muse-architect");
  const museArchitectArgs = [
    ...(sessionId ? ["--session", sessionId] : []),
    ...finalArgs,
  ];
  child = spawn(museArchitectBin, museArchitectArgs, { stdio: "inherit" });
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
