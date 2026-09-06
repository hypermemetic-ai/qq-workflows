import { execFile as execFileCb, spawn } from "node:child_process";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import { STATE_DIR } from "./store.mjs";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { boundObservation } from "./observations.mjs";
import { ZG_WHITELIST } from "./zg-tools.mjs";

const execFile = promisify(execFileCb);

const DEFAULT_URL = process.env.ZVEC_GREP_SERVER_URL || "http://127.0.0.1:7999/mcp";

export function whitelistZgTools(tools) {
  return (tools ?? []).filter((tool) => ZG_WHITELIST.includes(tool?.name));
}

export async function ensureZgServer({ spawnFn = spawn, url = DEFAULT_URL } = {}) {
  if (await pingMcp(url)) return { url, started: false };
  await new Promise((resolve, reject) => {
    const child = spawnFn("zg", ["server", "on", "--mcp-toolset", "full"], {
      stdio: "ignore",
      detached: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
  for (let i = 0; i < 20; i += 1) {
    if (await pingMcp(url)) return { url, started: true };
    await delay(150);
  }
  throw new Error("zg server did not become ready");
}

export const DEFAULT_INDEX_EMBEDDING = "local/potion-code-16m-v2";

export async function indexWorkspace(root, {
  wait = true,
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

async function pingMcp(url) {
  try {
    const session = await mcpSession(url);
    await session.close();
    return true;
  } catch {
    return false;
  }
}

async function mcpSession(url) {
  const initialized = await mcpPost(url, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "paseo-architect", version: "0.0.0" },
    },
  });
  const sessionId = initialized.sessionId;
  await mcpPost(url, { jsonrpc: "2.0", method: "notifications/initialized" }, sessionId);
  return {
    async call(method, params) {
      const response = await mcpPost(url, { jsonrpc: "2.0", id: Date.now(), method, params }, sessionId);
      if (response.error) throw new Error(response.error.message ?? JSON.stringify(response.error));
      return response.result;
    },
    async close() {},
  };
}

async function mcpPost(url, payload, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const nextSession = response.headers.get("mcp-session-id") ?? sessionId;
  const text = await response.text();
  const parsed = parseMcpBody(text);
  if (!response.ok && !parsed) {
    throw new Error(`zg MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return { ...parsed, sessionId: nextSession };
}

function parseMcpBody(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLine = trimmed.split("\n").find((line) => line.startsWith("data:"));
  if (!dataLine) return {};
  return JSON.parse(dataLine.slice(5).trim());
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
