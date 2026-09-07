#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createPaseoClient } from "@getpaseo/client";
import { daemonConfigPatch } from "./config.mjs";

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

export async function ensureDaemonProviders(client, createOptions) {
  if (typeof client?.config?.get !== "function" || typeof client?.config?.patch !== "function") return;
  const requestedProvider = createOptions?.config?.provider?.split("/")?.[0];
  if (!requestedProvider) return;
  if (!["architect-mini", "architect-teacher", "architect", "agy"].includes(requestedProvider)) return;

  const current = await client.config.get();
  const providers = current?.config?.providers ?? {};
  if (!providers[requestedProvider]) {
    await client.config.patch(daemonConfigPatch(current?.config));
  }
}

export async function sendAgentWake(agentId, text, {
  clientFactory = createPaseoClient,
  url = daemonWebSocketUrl(),
  clientId = cliClientId(),
} = {}) {
  if (!agentId || !text) return;
  const client = clientFactory({ url, ...(clientId ? { clientId } : {}) });
  await client.connect();
  try {
    const agent = client.agents?.ref?.(agentId);
    if (typeof agent?.send === "function") {
      await agent.send(text);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

export async function spawnWithSdk(createOptions, {
  clientFactory = createPaseoClient,
  url = daemonWebSocketUrl(),
  clientId = cliClientId(),
  waitForCwd = waitForHandleCwd,
  ensureProviders = ensureDaemonProviders,
} = {}) {
  const client = clientFactory({ url, ...(clientId ? { clientId } : {}) });
  await client.connect();
  try {
    if (typeof ensureProviders === "function") {
      await ensureProviders(client, createOptions);
    }
    const handle = await createPlacedAgent(client, createOptions);
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

// With a parent, Paseo defaults to the parent's workspace even when cwd is
// supplied. Register the already prepared checkout and explicitly place the
// child there; ownership and placement are separate SDK concepts.
export async function createPlacedAgent(client, options) {
  let workspace;
  if (options.workspaceId) {
    workspace = client.workspaces.ref(options.workspaceId);
    await workspace.refresh?.();
  } else if (options.parent && options.labels?.role === "implementer" && !options.worktree) {
    workspace = await client.workspaces.create({
      title: options.title,
      source: { kind: "directory", path: options.cwd },
    });
  }
  if (workspace) {
    if (workspace.directory !== options.cwd) {
      throw new Error(`delegate: workspace directory ${workspace.directory} does not match prepared checkout ${options.cwd}`);
    }
    return workspace.agents.create(options);
  }
  return client.agents.create(options);
}

export async function reconcileWithSdk(jobId, { clientFactory = createPaseoClient, url = daemonWebSocketUrl(), clientId = cliClientId(), client: supplied } = {}) {
  if (!jobId) return null;
  const client = supplied ?? clientFactory({ url, ...(clientId ? { clientId } : {}) });
  if (!supplied) await client.connect();
  try {
    let cursor = undefined;
    const matches = [];
    while (true) {
      const result = await client.agents.list({
        scope: "active",
        filter: { labels: { job: jobId }, includeArchived: true },
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      const entries = result?.entries ?? [];
      for (const entry of entries) {
        if (entry?.agent?.labels?.job === jobId) {
          matches.push(entry.agent);
        }
      }
      if (!result?.pageInfo?.hasMore || !result?.pageInfo?.nextCursor) break;
      cursor = result.pageInfo.nextCursor;
    }
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
