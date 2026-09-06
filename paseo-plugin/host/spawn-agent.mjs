#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPaseoClient } from "@getpaseo/client";

export function isRealCwd(cwd) {
  return typeof cwd === "string" && cwd.trim().length > 0;
}

export async function waitForHandleCwd(handle, { timeoutMs = 30_000, intervalMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isRealCwd(handle?.cwd)) return handle.cwd;
    try {
      await handle.refresh?.();
    } catch {
      /* snapshot may already be present */
    }
    if (isRealCwd(handle?.cwd)) return handle.cwd;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("delegate: worktree cwd did not appear");
}

export function daemonWebSocketUrl({
  env = process.env,
  home = homedir(),
  readFileFn = readFileSync,
} = {}) {
  const explicit = String(env.PASEO_HOST ?? "").trim();
  if (explicit) return hostToWebSocketUrl(explicit);
  const pidPath = join(env.PASEO_HOME || join(home, ".paseo"), "paseo.pid");
  try {
    const pid = JSON.parse(readFileFn(pidPath, "utf8"));
    if (typeof pid?.listen === "string" && pid.listen.trim()) {
      return hostToWebSocketUrl(pid.listen.trim());
    }
  } catch {
    /* fall through */
  }
  return "ws://localhost:6767/ws";
}

export function hostToWebSocketUrl(host) {
  const trimmed = String(host ?? "").trim();
  if (!trimmed) return "ws://localhost:6767/ws";
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  const withoutTcp = trimmed.replace(/^tcp:\/\//, "");
  const endpoint = withoutTcp.includes("/") ? withoutTcp : `${withoutTcp}/ws`;
  return endpoint.startsWith("ws") ? endpoint : `ws://${endpoint}`;
}

export function cliClientId({
  env = process.env,
  home = homedir(),
  readFileFn = readFileSync,
} = {}) {
  const path = join(env.PASEO_HOME || join(home, ".paseo"), "cli-client-id");
  try {
    const id = String(readFileFn(path, "utf8")).trim();
    return id || undefined;
  } catch {
    return undefined;
  }
}

export async function spawnWithSdk(createOptions, {
  clientFactory = createPaseoClient,
  url = daemonWebSocketUrl(),
  clientId = cliClientId(),
  waitForCwd = waitForHandleCwd,
} = {}) {
  const client = clientFactory({ url, ...(clientId ? { clientId } : {}) });
  await client.connect();
  try {
    const handle = await client.agents.create(createOptions);
    if (createOptions.worktree) {
      const cwd = await waitForCwd(handle);
      return {
        id: handle.id,
        workspaceId: handle.workspaceId,
        cwd,
      };
    }
    try {
      await handle.refresh();
    } catch {
      /* snapshot may already be present */
    }
    return {
      id: handle.id,
      workspaceId: handle.workspaceId,
      cwd: isRealCwd(handle.cwd) ? handle.cwd : createOptions.cwd,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

export async function reconcileWithSdk(jobId, { clientFactory = createPaseoClient, url = daemonWebSocketUrl(), clientId = cliClientId(), client: supplied } = {}) {
  if (!jobId) return null;
  const client = supplied ?? clientFactory({ url, ...(clientId ? { clientId } : {}) });
  if (!supplied) await client.connect();
  try {
    const result = await client.agents.list({ scope: 'active', filter: { labels: { job: jobId }, includeArchived: true }, page: { limit: 200 } });
    const matches = result.entries.map(entry => entry.agent).filter(agent => agent.labels?.job === jobId);
    if (matches.length > 1) throw new Error(`Multiple children exist for job ${jobId}; reconciliation requires inspection`);
    const agent = matches[0];
    return agent ? { id: agent.id, cwd: agent.cwd, workspaceId: agent.workspaceId, status: agent.status } : null;
  } finally { if (!supplied) await client.close().catch(() => {}); }
}

export function parseCreatedAgentJson(text) {
  const raw = String(text ?? "").trim();
  let parsed;
  for (const line of raw.split(/\r?\n/).reverse()) {
    try { parsed = JSON.parse(line); break; } catch { /* progress is not a result */ }
  }
  if (!parsed) throw new Error("paseo spawn produced no json");
  const id = parsed.id ?? parsed.agentId;
  if (!id) throw new Error("paseo spawn json missing id");
  return {
    id,
    workspaceId: parsed.workspaceId ?? parsed.workspace_id ?? null,
    cwd: parsed.cwd ?? null,
  };
}

export function defaultSpawnExec(command, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `spawn-agent exited ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}


async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const createOptions = JSON.parse(await readStdin());
  const result = await spawnWithSdk(createOptions);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}
