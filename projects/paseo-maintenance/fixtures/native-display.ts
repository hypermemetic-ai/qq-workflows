// Copy into the target Paseo checkout's packages/server/src/.dev/ before running
// with npx tsx. Relative imports intentionally resolve against that checkout.
// PASEO_NATIVE_FIXTURE_OUTPUT must name a private absolute output directory.
// PASEO_NATIVE_FIXTURE_PORT defaults to 0 (an OS-assigned isolated port).
import { execFileSync } from "node:child_process";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { DaemonClient } from "../server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../server/test-utils/paseo-daemon.js";
import { MockLoadTestAgentClient } from "../server/agent/providers/mock-load-test-agent.js";

const output = process.env.PASEO_NATIVE_FIXTURE_OUTPUT;
if (!output || !path.isAbsolute(output)) {
  throw new Error("Set PASEO_NATIVE_FIXTURE_OUTPUT to a private absolute directory");
}
const port = Number(process.env.PASEO_NATIVE_FIXTURE_PORT ?? "0");
if (!Number.isInteger(port) || port < 0 || port > 65535 || port === 6767) {
  throw new Error("Fixture port must be 0 or an isolated port other than 6767");
}
await mkdir(output, { recursive: true, mode: 0o700 });
await chmod(output, 0o700);
const { version } = JSON.parse(
  await readFile(new URL("../../../app/package.json", import.meta.url), "utf8"),
) as { version: string };
const daemon = await createTestPaseoDaemon({
  listen: "127.0.0.1",
  listenPort: port,
  isDev: true,
  daemonVersion: version,
  mcpEnabled: false,
  agentClients: { mock: new MockLoadTestAgentClient() },
});
const client = new DaemonClient({
  url: `ws://127.0.0.1:${daemon.port}/ws`,
  appVersion: version,
});
const repo = await mkdtemp(path.join(tmpdir(), "paseo-native-display-"));
const agents: { id: string; title: string; workspaceId: string }[] = [];
let eventWrites = Promise.resolve();
let cleanupPromise: Promise<void> | undefined;
const cleanup = () => {
  cleanupPromise ??= (async () => {
    await client.close().catch(() => undefined);
    try {
      await daemon.close();
    } finally {
      await eventWrites;
      await rm(repo, { recursive: true, force: true });
    }
  })();
  return cleanupPromise;
};
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => void cleanup().finally(() => process.exit(0)));
}

try {
  await writeFile(path.join(repo, "README.md"), "Synthetic native display fixture only.\n");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "add", "README.md"]);
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Native fixture",
    "-c",
    "user.email=native-fixture@example.invalid",
    "commit",
    "-qm",
    "Synthetic fixture",
  ]);
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  const result = await client.createWorkspace({
    source: { kind: "directory", path: repo },
    title: "Native display workload",
  });
  if (!result.workspace || result.error) {
    throw new Error(result.error ?? "Missing fixture workspace");
  }
  for (let index = 0; index < 3; index++) {
    const title = `Native check ${index + 1}`;
    const agent = await client.createAgent({
      provider: "mock",
      cwd: repo,
      workspaceId: result.workspace.id,
      title,
      modeId: "load-test",
      model: index === 0 ? "ten-second-stream" : "thirty-minute-stream",
    });
    agents.push({ id: agent.id, title, workspaceId: result.workspace.id });
  }
  for (let index = 0; index < 60; index++) {
    await client.sendAgentMessage(
      agents[0].id,
      `native-history-${index}: emit 1 coalesced agent stream updates`,
    );
    await client.waitForFinish(agents[0].id, 15000);
  }
  client.subscribe((event) => {
    if (event.type !== "agent_update" || event.payload.kind !== "upsert") return;
    const record = {
      timeMs: Date.now(),
      agentId: event.agentId,
      status: event.payload.agent.status,
    };
    eventWrites = eventWrites
      .then(() =>
        appendFile(path.join(output, "fixture-events.jsonl"), `${JSON.stringify(record)}\n`, {
          mode: 0o600,
        }),
      )
      .catch(() => console.error("Could not write a fixture event"));
  });
  const ready = { ready: true, port: daemon.port, pid: process.pid, agents, turns: 60 };
  await writeFile(path.join(output, "fixture-ready-private.json"), `${JSON.stringify(ready)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(ready));
  for await (const line of createInterface({ input: process.stdin })) {
    try {
      const command = JSON.parse(line);
      if (command.op === "quit") break;
      const index = command.index ?? 0;
      if (!Number.isInteger(index) || !agents[index]) throw new Error("Unknown agent index");
      const agent = agents[index];
      if (command.op === "send") {
        await client.sendAgentMessage(
          agent.id,
          command.text ?? "native controlled streaming workload",
        );
      } else if (command.op === "cancel") {
        await client.cancelAgent(agent.id);
      } else if (command.op === "wait") {
        await client.waitForFinish(agent.id, 20000);
      } else if (command.op === "status") {
        const snapshot = await client.fetchAgents({ subscribe: {} });
        console.log(
          JSON.stringify({
            states: snapshot.entries.map(({ agent: entry }) => ({
              id: entry.id,
              status: entry.status,
            })),
          }),
        );
      } else {
        throw new Error("Unknown operation");
      }
      console.log(JSON.stringify({ ok: true, op: command.op, index }));
    } catch (error) {
      console.log(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
} finally {
  await cleanup();
}
