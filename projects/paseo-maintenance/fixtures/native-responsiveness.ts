// Copy to packages/server/src/.dev/ in the audited Paseo checkout; run with its tsx.
// This helper only owns synthetic state under PASEO_NATIVE_FIXTURE_OUTPUT/STATE.
import { execFileSync } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type {
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../server/agent/agent-sdk-types.js";
import { MockLoadTestAgentClient } from "../server/agent/providers/mock-load-test-agent.js";
import { DaemonClient } from "../server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../server/test-utils/paseo-daemon.js";

function bounded(
  value: unknown,
  fallback: number,
  low: number,
  high: number
): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < low || number > high) {
    throw new Error(`Expected an integer between ${low} and ${high}`);
  }
  return number;
}

const output = process.env.PASEO_NATIVE_FIXTURE_OUTPUT;
if (!output || !path.isAbsolute(output))
  throw new Error("Set a private absolute fixture output");
const stateInput =
  process.env.PASEO_NATIVE_FIXTURE_STATE ??
  path.join(output, "synthetic-state");
const state = path.resolve(stateInput);
if (
  !path.isAbsolute(stateInput) ||
  !state.startsWith(path.resolve(output) + path.sep)
) {
  throw new Error("Fixture state must be a dedicated absolute child directory");
}
const port = bounded(process.env.PASEO_NATIVE_FIXTURE_PORT, 0, 0, 65535);
if (port === 6767 || port === 6769)
  throw new Error("Production daemon ports are prohibited");
const projectCount = bounded(
  process.env.PASEO_NATIVE_FIXTURE_PROJECTS,
  18,
  2,
  30
);
const workspaceCount = bounded(
  process.env.PASEO_NATIVE_FIXTURE_WORKSPACES,
  16,
  2,
  projectCount
);
const historyTurns = bounded(
  process.env.PASEO_NATIVE_FIXTURE_TURNS,
  60,
  0,
  200
);
const owner = "paseo-native-responsiveness-synthetic-v1\n";
await mkdir(output, { recursive: true, mode: 0o700 });
await chmod(output, 0o700);
await mkdir(state, { recursive: true, mode: 0o700 });
await chmod(state, 0o700);
const ownerPath = path.join(state, "fixture-owner");
try {
  if ((await readFile(ownerPath, "utf8")) !== owner)
    throw new Error("State owner mismatch");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  if ((await readdir(state)).length)
    throw new Error("Refusing to adopt nonempty unowned state");
  // wx prevents a concurrent helper from adopting another owner's directory.
  await writeFile(ownerPath, owner, { flag: "wx", mode: 0o600 });
}

// Additional events use the normal provider subscription path, not a WebSocket test hook.
class SyntheticClient extends MockLoadTestAgentClient {
  readonly emitters = new Map<string, (event: AgentStreamEvent) => void>();
  private decorate(session: AgentSession): AgentSession {
    const listeners = new Set<(event: AgentStreamEvent) => void>();
    const extraHistory: AgentStreamEvent[] = [];
    const subscribe = session.subscribe.bind(session);
    const history = session.streamHistory.bind(session);
    session.subscribe = (callback) => {
      listeners.add(callback);
      const unsubscribe = subscribe(callback);
      return () => {
        listeners.delete(callback);
        unsubscribe();
      };
    };
    session.streamHistory = async function* () {
      yield* history();
      yield* extraHistory;
    };
    this.emitters.set(session.id!, (event) => {
      if (extraHistory.length >= 5000)
        throw new Error("Synthetic provider history limit reached");
      extraHistory.push(event);
      for (const listener of listeners) listener(event);
    });
    return session;
  }
  override async createSession(
    config: AgentSessionConfig,
    context?: AgentLaunchContext
  ) {
    return this.decorate(await super.createSession(config, context));
  }
  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    context?: AgentLaunchContext
  ) {
    return this.decorate(await super.resumeSession(handle, overrides, context));
  }
}

const synthetic = new SyntheticClient();
await writeFile(
  path.join(output, "fixture-ready-private.json"),
  JSON.stringify({ ready: false, pid: process.pid }) + "\n",
  { mode: 0o600 }
);
const { version } = JSON.parse(
  await readFile(new URL("../../../app/package.json", import.meta.url), "utf8")
) as { version: string };
const daemon = await createTestPaseoDaemon({
  listen: "127.0.0.1",
  listenPort: port,
  paseoHomeRoot: path.join(state, "daemon"),
  staticDir: path.join(state, "static"),
  cleanup: false,
  isDev: true,
  daemonVersion: version,
  mcpEnabled: false,
  relayEnabled: false,
  agentClients: { mock: synthetic },
});
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: version,
});
async function waitForIdle(agentId: string, timeout: number): Promise<void> {
  const result = await client.waitForFinish(agentId, timeout);
  if (result.status !== "idle" || result.error) {
    throw new Error(
      `Synthetic turn did not finish idle: ${result.status}; ${
        result.error ?? "no error detail"
      }`
    );
  }
}
type FixtureAgent = {
  id: string;
  title: string;
  workspaceId: string;
  cwd: string;
};
type Manifest = {
  agents: FixtureAgent[];
  projects: number;
  workspaces: { id: string; title: string }[];
  turns: number;
};
let manifest: Manifest;
let writes = Promise.resolve();
let removeState = false;
let cleanupPromise: Promise<void> | undefined;
const log = (record: Record<string, unknown>) => {
  const line = JSON.stringify({ timeMs: Date.now(), ...record });
  console.log(line);
  writes = writes.then(() =>
    appendFile(path.join(output, "fixture-events.jsonl"), line + "\n", {
      mode: 0o600,
    })
  );
};
const cleanup = () => {
  cleanupPromise ??= (async () => {
    await writeFile(
      path.join(output, "fixture-ready-private.json"),
      JSON.stringify({ ready: false, pid: process.pid }) + "\n",
      { mode: 0o600 }
    );
    await client.close().catch(() => undefined);
    await daemon.close();
    await writes;
    if (removeState && (await readFile(ownerPath, "utf8")) === owner) {
      await rm(state, { recursive: true });
    }
  })();
  return cleanupPromise;
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(0)));
}

try {
  await client.connect();
  const snapshot = await client.fetchAgents({
    filter: { includeArchived: true },
    subscribe: {},
  });
  const manifestPath = path.join(state, "manifest.json");
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
    const known = new Set(snapshot.entries.map(({ agent }) => agent.id));
    if (!manifest.agents.every(({ id }) => known.has(id)))
      throw new Error("Stored fixture agents were not restored");
    log({ op: "restored", agents: manifest.agents.length });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    manifest = {
      agents: [],
      projects: projectCount,
      workspaces: [],
      turns: historyTurns,
    };
    for (let project = 1; project <= projectCount; project++) {
      const number = String(project).padStart(2, "0");
      const cwd = path.join(state, "repos", `project-${number}`);
      await mkdir(cwd, { recursive: true });
      await writeFile(
        path.join(cwd, "README.md"),
        "Synthetic Android responsiveness fixture.\n"
      );
      execFileSync("git", ["init", "-q", cwd]);
      execFileSync("git", ["-C", cwd, "add", "README.md"]);
      execFileSync("git", [
        "-C",
        cwd,
        "-c",
        "user.name=Native fixture",
        "-c",
        "user.email=native-fixture@example.invalid",
        "commit",
        "-qm",
        "Synthetic fixture",
      ]);
      if (project > workspaceCount) {
        await client.addProject(cwd);
        log({ op: "seed-project", project, workspace: false });
        continue;
      }
      const result = await client.createWorkspace({
        source: { kind: "directory", path: cwd },
        title: `Workspace ${number}`,
      });
      if (!result.workspace || result.error)
        throw new Error(result.error ?? "Missing workspace");
      manifest.workspaces.push({
        id: result.workspace.id,
        title: `Workspace ${number}`,
      });
      const sessions = project === 1 ? 7 : 3;
      for (let session = 1; session <= sessions; session++) {
        const title = `Session ${number}.${session}`;
        const agent = await client.createAgent({
          provider: "mock",
          cwd,
          workspaceId: result.workspace.id,
          title,
          modeId: "load-test",
          model: "thirty-minute-stream",
        });
        manifest.agents.push({
          id: agent.id,
          title,
          workspaceId: result.workspace.id,
          cwd,
        });
      }
      log({ op: "seed-project", project, agents: manifest.agents.length });
    }
    for (let turn = 0; turn < historyTurns; turn++) {
      await client.sendAgentMessage(
        manifest.agents[0].id,
        `native-history-${turn}: emit 1 coalesced agent stream updates`
      );
      await waitForIdle(manifest.agents[0].id, 15000);
      if ((turn + 1) % 10 === 0) log({ op: "seed-history", turns: turn + 1 });
    }
    // Default shape: 52 stored sessions, 18 nonarchived, 12 active, 34 archived.
    for (let index = 12; index < manifest.agents.length; index++) {
      log({ op: "seed-lifecycle-start", index });
      if (index >= 18) await client.archiveAgent(manifest.agents[index].id);
      else
        await daemon.daemon.agentManager.closeAgent(manifest.agents[index].id);
      await daemon.daemon.agentManager.flush();
      log({ op: "seed-lifecycle-finish", index });
    }
    await writeFile(manifestPath, JSON.stringify(manifest) + "\n", {
      mode: 0o600,
    });
  }
  const ready = {
    ready: true,
    serverId: daemon.daemon.getServerId(),
    port: daemon.port,
    pid: process.pid,
    state,
    ...manifest,
  };
  let timeline = await client.fetchAgentTimeline(manifest.agents[0].id, {
    limit: 200,
  });
  // Mock persistence retains session identity/configuration, not provider history.
  // Restore the deterministic long history before the next native QA window.
  if (timeline.window.maxSeq === 0 && manifest.turns > 0) {
    for (let turn = 0; turn < manifest.turns; turn++) {
      await client.sendAgentMessage(
        manifest.agents[0].id,
        `native-history-${turn}: emit 1 coalesced agent stream updates`
      );
      await waitForIdle(manifest.agents[0].id, 15000);
    }
    log({ op: "history-reseed", turns: manifest.turns });
    timeline = await client.fetchAgentTimeline(manifest.agents[0].id, {
      limit: 200,
    });
  }
  const seededUserRowsInTail = timeline.entries.filter(
    ({ item }) =>
      item.type === "user_message" && item.text.startsWith("native-history-")
  ).length;
  const expectedTailRows = Math.min(manifest.turns, 100);
  if (
    timeline.window.maxSeq < manifest.turns * 2 ||
    seededUserRowsInTail < expectedTailRows ||
    timeline.entries.length < expectedTailRows * 2
  ) {
    throw new Error("Synthetic history verification failed before readiness");
  }
  log({
    op: "history-check",
    entries: timeline.entries.length,
    minSeq: timeline.window.minSeq,
    maxSeq: timeline.window.maxSeq,
    hasOlder: timeline.hasOlder,
    seededUserRowsInTail,
  });
  // Daemon shutdown closes loaded sessions. Restore the intended idle group
  // through normal turns before publishing a comparable restart window.
  const beforeIdleRestore = await client.fetchAgents({
    filter: { includeArchived: true },
  });
  const idleStates = new Map(
    beforeIdleRestore.entries.map(({ agent }) => [agent.id, agent.status])
  );
  let restoredIdle = 0;
  for (let index = 0; index < Math.min(12, manifest.agents.length); index++) {
    const agent = manifest.agents[index];
    if (idleStates.get(agent.id) === "idle") continue;
    if (index === 0)
      throw new Error("Primary history session did not remain idle");
    await client.sendAgentMessage(
      agent.id,
      "native-idle-restore: emit 1 coalesced agent stream updates"
    );
    await waitForIdle(agent.id, 15000);
    await daemon.daemon.agentManager.flush();
    restoredIdle++;
  }
  const readyStates = await client.fetchAgents({
    filter: { includeArchived: true },
  });
  const counts = readyStates.entries.reduce<Record<string, number>>(
    (result, { agent }) => {
      result[agent.status] = (result[agent.status] ?? 0) + 1;
      return result;
    },
    {}
  );
  if (
    (counts.idle ?? 0) !== Math.min(12, manifest.agents.length) ||
    (counts.closed ?? 0) !== Math.max(0, manifest.agents.length - 12)
  ) {
    throw new Error(
      "Synthetic idle/closed status shape failed before readiness"
    );
  }
  log({ op: "idle-shape-check", restoredIdle, counts });
  client.subscribe((event) => {
    if (event.type === "agent_update" && event.payload.kind === "upsert") {
      log({
        op: "agent-state",
        agentId: event.agentId,
        status: event.payload.agent.status,
      });
    }
  });
  await writeFile(
    path.join(output, "fixture-ready-private.json"),
    JSON.stringify(ready) + "\n",
    { mode: 0o600 }
  );
  log({ op: "ready", ...ready });

  for await (const line of createInterface({ input: process.stdin })) {
    const startedMs = Date.now();
    let requestId: string | null = null;
    let operation: string | null = null;
    try {
      const command = JSON.parse(line);
      requestId =
        typeof command.requestId === "string" ? command.requestId : null;
      operation = typeof command.op === "string" ? command.op : null;
      if (command.op === "quit") {
        removeState = command.cleanup === true;
        log({ ok: true, op: "quit", cleanup: removeState, requestId });
        break;
      }
      if (command.op === "status") {
        const current = await client.fetchAgents({
          filter: { includeArchived: true },
        });
        log({
          ok: true,
          op: "status",
          requestId,
          startedMs,
          durationMs: Date.now() - startedMs,
          states: current.entries.map(({ agent }) => ({
            id: agent.id,
            status: agent.status,
            archived: agent.archivedAt != null,
          })),
        });
        continue;
      }
      const index = bounded(command.index, 0, 0, manifest.agents.length - 1);
      const agent = manifest.agents[index];
      if (command.op === "send") {
        await client.sendAgentMessage(
          agent.id,
          command.text ?? "native controlled streaming workload"
        );
      } else if (command.op === "cancel") {
        await client.cancelAgent(agent.id);
      } else if (command.op === "wait") {
        const result = await client.waitForFinish(agent.id, 20000);
        if (
          result.status === "timeout" ||
          result.status === "error" ||
          result.error
        ) {
          throw new Error(
            `Synthetic wait failed: ${result.status}; ${
              result.error ?? "no error detail"
            }`
          );
        }
        log({
          op: "wait-result",
          status: result.status,
          finalStatus: result.final?.status,
          requestId,
        });
      } else if (command.op === "children") {
        const managed = daemon.daemon.agentManager.getAgent(agent.id);
        if (!managed || !("session" in managed))
          throw new Error(
            "Start/resume this fixture agent before child events"
          );
        const emit = synthetic.emitters.get(managed.session.id!);
        if (!emit) throw new Error("Missing synthetic session emitter");
        const children = bounded(command.children, 8, 1, 100);
        const items = bounded(command.items, 120, 1, 1000);
        const gapMs = bounded(command.gapMs, 250, 0, 1000);
        const burst = String(command.burstId ?? requestId ?? startedMs);
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(burst))
          throw new Error("Use a short synthetic burstId");
        for (let child = 0; child < children; child++) {
          emit({
            type: "provider_subagent",
            provider: "mock",
            event: {
              type: "upsert",
              id: `native-child-${burst}-${child}`,
              title: `Synthetic child ${child}`,
              status: "running",
            },
          });
        }
        for (let item = 0; item < items; item++) {
          emit({
            type: "provider_subagent",
            provider: "mock",
            event: {
              type: "timeline",
              id: `native-child-${burst}-${item % children}`,
              item: {
                type: "tool_call",
                callId: `native-call-${burst}-${item}`,
                name: "exec_command",
                status: "running",
                error: null,
                detail: {
                  type: "shell",
                  command: "echo synthetic",
                  output: `synthetic output ${item}`,
                },
              },
            },
          });
          if (gapMs) await new Promise((resolve) => setTimeout(resolve, gapMs));
        }
        log({
          op: "child-workload",
          children,
          items,
          gapMs,
          burstId: burst,
          emittedEvents: children + items,
        });
      } else if (command.op === "large") {
        const bytes = bounded(command.bytes, 65536, 1024, 1000000);
        const count = bounded(command.count, 4, 1, 16);
        const current = await client.fetchAgent(agent.id);
        if (current?.agent.status !== "idle")
          throw new Error(
            "Cancel/wait for this fixture agent before large turns"
          );
        const payloadBytes: number[] = [];
        for (let item = 0; item < count; item++) {
          await client.sendAgentMessage(
            agent.id,
            `emit ${bytes} byte large diff agent stream payload`
          );
          await waitForIdle(agent.id, 20000);
          const page = await client.fetchAgentTimeline(agent.id, { limit: 2 });
          const latest = page.entries.at(-1)?.item;
          if (
            latest?.type !== "tool_call" ||
            latest.detail?.type !== "edit" ||
            typeof latest.detail.unifiedDiff !== "string"
          )
            throw new Error("Expected normal mock large diff timeline item");
          payloadBytes.push(
            Buffer.byteLength(latest.detail.unifiedDiff, "utf8")
          );
        }
        log({
          op: "large-workload",
          requestedBodyBytes: bytes,
          actualDiffBytesPerItem: payloadBytes,
          count,
          generator: "normal-mock-turn",
        });
      } else {
        throw new Error("Unknown fixture operation");
      }
      log({
        ok: true,
        op: command.op,
        index,
        startedMs,
        durationMs: Date.now() - startedMs,
        requestId,
      });
    } catch (error) {
      log({
        ok: false,
        op: operation,
        requestId,
        startedMs,
        durationMs: Date.now() - startedMs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
} finally {
  await cleanup();
  // The named service owns any remaining harness worker handles.
  process.exit(0);
}
