#!/usr/bin/env node
import { spawn } from "node:child_process";

const realAgy = process.env.REAL_AGY_BIN || "/home/qqp/.local/bin/agy";
const role = process.env.ARCHITECT_ROLE || process.env.AGY_AGENT;
const incoming = process.argv.slice(2);

// If running informational commands like "models" or "--version", pass through
if (incoming.length === 1 && (incoming[0] === "models" || incoming[0] === "--version" || incoming[0] === "-v")) {
  const child = spawn(realAgy, incoming, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
} else {
  const args = [];
  if (role && !incoming.includes("--agent")) {
    args.push("--agent", role);
  }
  if (!incoming.includes("--dangerously-skip-permissions")) {
    args.push("--dangerously-skip-permissions");
  }
  
  let modelFound = false;
  let effortFound = false;
  for (let i = 0; i < incoming.length; i++) {
    const arg = incoming[i];
    if (arg === "--model" && i + 1 < incoming.length) {
      modelFound = true;
      const modelVal = incoming[i + 1];
      // Normalize model name for agy CLI: "Gemini 3.8 Flash" -> "gemini-3.8-flash-high"
      args.push("--model", "gemini-3.8-flash-high");
      i++;
      continue;
    }
    if (arg === "--effort" && i + 1 < incoming.length) {
      effortFound = true;
      args.push("--effort", "high");
      i++;
      continue;
    }
    args.push(arg);
  }

  if (!modelFound && !incoming.includes("models")) {
    args.unshift("--model", "gemini-3.8-flash-high");
  }
  if (!effortFound && !incoming.includes("models")) {
    args.unshift("--effort", "high");
  }

  const child = spawn(realAgy, args, { stdio: "inherit" });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}
