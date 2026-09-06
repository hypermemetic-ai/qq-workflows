import { execFile as execFileCb, spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { STATE_DIR } from "../config.mjs";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { boundObservation } from "../observations.mjs";
import { ZG_WHITELIST } from "./zg-tools.mjs";

const execFile = promisify(execFileCb);

export const DEFAULT_INDEX_EMBEDDING = "local/potion-code-16m-v2";

export async function indexWorkspace(root, {
  embedding,
  execFileFn = execFile,
} = {}) {
  if (!root) throw new Error("index workspace requires root");
  const model = embedding ?? process.env.ZVEC_GREP_EMBEDDING ?? DEFAULT_INDEX_EMBEDDING;
  const timeout = 120_000;
  const fresh = !existsSync(join(root, ".zvec-grep", "manifest.json"));
  const freshArgs = fresh ? ["--rebuild"] : [];
  try {
    return await execFileFn("zg", ["index", root, "--embedding", model, "--mode", "direct", ...freshArgs], {
      encoding: "utf8",
      timeout,
      maxBuffer: 2 * 1024 * 1024,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/embedding|schema|already|stored|incompatible/i.test(message)) {
      return await execFileFn("zg", ["index", root, "--mode", "direct", ...freshArgs], {
        encoding: "utf8",
        timeout,
        maxBuffer: 2 * 1024 * 1024,
      });
    }
    throw error;
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
