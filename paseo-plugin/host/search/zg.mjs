import { execFile as execFileCb, spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { STATE_DIR } from "../config.mjs";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { boundObservation } from "../observations.mjs";
import { ZG_WHITELIST } from "./zg-tools.mjs";

const execFile = promisify(execFileCb);

export const DEFAULT_INDEX_EMBEDDING = "local/potion-code-16m-v2";

export async function indexWorkspace(root, {
  embedding,
  execFileFn = execFile,
  home = join(STATE_DIR, "zg"),
  waitForLock = true,
  timeout = 120_000,
  now = Date.now,
  sleep = delay,
} = {}) {
  if (!root) throw new Error("index workspace requires root");
  const model = embedding ?? process.env.ZVEC_GREP_EMBEDDING ?? DEFAULT_INDEX_EMBEDDING;
  const fresh = !existsSync(join(root, ".zvec-grep", "manifest.json"));
  const freshArgs = fresh ? ["--rebuild"] : [];
  const deadline = now() + timeout;
  let useEmbedding = true;
  for (;;) {
    try {
      return await execFileFn("zg", ["index", root, ...(useEmbedding ? ["--embedding", model] : []), "--mode", "direct", ...freshArgs], {
        encoding: "utf8", timeout: Math.max(1, deadline - now()), maxBuffer: 2 * 1024 * 1024,
        // Match the MCP search server, without contending with unrelated global indexes.
        env: { ...process.env, ZVEC_GREP_HOME: home },
      });
    } catch (error) {
      // execFile's message includes the command's --embedding argument. Diagnose
      // stderr and explicit engine codes, never a word in the failed command.
      const diagnostic = String(error.stderr ?? error.message ?? error);
      if (diagnostic.includes("ZVEC_GREP.ENGINE.LOCK.BUSY")) {
        if (!waitForLock) throw error;
        const remaining = deadline - now();
        if (remaining <= 0) throw error;
        await sleep(Math.min(1000, remaining));
        if (now() >= deadline) throw error;
        continue;
      }
      if (useEmbedding && /ZVEC_GREP\.ENGINE\.(?:SERVICE\.EMBEDDING_SCHEMA_CHANGE_REQUIRES_REBUILD|WORKSPACE_INDEX\.EMBEDDING_(?:PROVIDER|MODEL|DIMENSION|METRIC)_MISMATCH)/.test(diagnostic) && now() < deadline) {
        useEmbedding = false;
        continue;
      }
      throw error;
    }
  }
}

export async function callZgTool(name, args, { spawnFn = spawn, signal } = {}) {
  if (!ZG_WHITELIST.includes(name)) throw new Error(`zg tool not whitelisted: ${name}`);
  const listen = process.env.ARCHITECT_ZG_LISTEN || await new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(`127.0.0.1:${port}`)); });
  });
  const child = spawnFn("zg", ["server", "--stdio", "--mcp-toolset", "full", "--home", join(STATE_DIR, "zg"), "--listen", listen], { stdio: ["pipe", "pipe", "pipe"], signal });
  let nextId = 1;
  const pending = new Map();
  let diagnostics = "";
  child.stderr.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  });
  const fail = error => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.on("error", fail);
  child.on("exit", code => fail(new Error(`ZG stdio exited ${code}: ${diagnostics}`)));
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "paseo-architect", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    return await boundObservation(await call("tools/call", { name, arguments: args }));
  } finally { child.stdin.end(); child.kill("SIGTERM"); lines.close(); }
}
