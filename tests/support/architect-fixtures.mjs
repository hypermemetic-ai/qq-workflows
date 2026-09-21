// Shared fixtures for the Architect test files.
//
// Everything here is hermetic: temporary repositories, temporary state
// directories, fake child processes, and fake pi/Paseo surfaces. No test touches
// the operator's real home, Paseo config, pi settings, or worker configuration.

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPackagedTemplate } from "../../workflow/ticket.mjs";
import { jobSummary, readJob } from "../../workflow/jobs.mjs";

export function tempDir(prefix = "qq-architect-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

// The central worker configuration a test run resolves, plus a per-test pinned
// runtime root. It carries the operator's production pins (DeepSeek Flash, the
// pinned Messages root, `max` effort, the deepseek-minimal harness) so tests
// exercise the ACTUAL central contract; the loopback Messages root keeps any
// accidental provider contact off the network, and the runtime root only has to
// exist for the launch preflight (the worker binaries are test doubles).
export function centralWorkerConfig(root, extra = {}) {
  const runtimeRoot = join(root, "deepseek-minimal-runtime");
  mkdirSync(join(runtimeRoot, "upstream"), { recursive: true });
  writeFileSync(join(runtimeRoot, "provenance.json"), `${JSON.stringify({
    preparedBy: "test fixture",
    runtimeRoot,
    upstreamRoot: join(runtimeRoot, "upstream"),
    head: "ddefc45fbc7f8e46dd73185e68295696d1297887",
    version: "0.1.6-alpha.2",
    globalDshUsed: false,
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(runtimeRoot, "upstream", "package.json"), `${JSON.stringify({ name: "deepseek-harness", version: "0.1.6-alpha.2" }, null, 2)}\n`, "utf8");
  const file = join(root, "worker-config.json");
  writeFileSync(file, `${JSON.stringify({
    provider: "deepseek",
    model: "deepseek-flash",
    base_url: "https://api.deepseek.com",
    wire_api: "responses",
    env_key: "DEEPSEEK_API_KEY",
    api_key_file: join(root, "deepseek-api-key"),
    harness: "deepseek-minimal",
    reasoning_effort: "max",
    messages_base_url: "http://127.0.0.1:9",
    ...extra,
  }, null, 2)}\n`, "utf8");
  return { file, runtimeRoot, env: { QQ_WORKER_CONFIG_FILE: file, QQ_DEEPSEEK_RUNTIME_ROOT: runtimeRoot } };
}

// A throwaway repository root with the packaged ticket template installed.
export async function tempRepo({ agents = null, prompt = null, extraFiles = {} } = {}) {
  const root = tempDir("qq-architect-repo-");
  mkdirSync(join(root, ".architect", "tickets"), { recursive: true });
  writeFileSync(join(root, ".architect", "template.md"), await loadPackagedTemplate(), "utf8");
  if (agents) writeFileSync(join(root, "AGENTS.md"), agents, "utf8");
  for (const [name, content] of Object.entries(extraFiles)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  // Isolated environment: never read the operator's live central worker config
  // or the operator's live pi settings. The Architect profile OBSERVES the
  // runtime's compaction settings through pi's documented config directory, so
  // that directory is a fixture path too, not the real ~/.pi/agent.
  const agentDir = join(root, ".pi-agent");
  mkdirSync(agentDir, { recursive: true });
  // Isolated environment: never read the operator's live central worker config
  // or the operator's live pi settings. The worker seats resolve the same
  // central contract as production, from this repository's own config file.
  const central = centralWorkerConfig(root);
  const env = {
    ...central.env,
    PI_CODING_AGENT_DIR: agentDir,
  };
  return { root, env, prompt, agentDir, central };
}

// Deterministic scheduler double for the extension's deferred readiness tick.
// Production schedules it with setTimeout(0); tests run it only when they ask, so
// a session that is still opening cannot reconcile an unrelated in-flight job.
export function tickQueue() {
  const tasks = [];
  return {
    tasks,
    schedule(fn) {
      tasks.push(fn);
      return () => {};
    },
    async flush() {
      while (tasks.length > 0) {
        const task = tasks.shift();
        await task();
      }
    },
  };
}

// Minimal child-process double with the stream surface the workflow layer uses.
export function fakeChild({ pid = 424242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.written = [];
  const originalWrite = child.stdin.write.bind(child.stdin);
  child.stdin.write = (chunk, ...rest) => {
    child.written.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  child.killedWith = null;
  child.kill = (signal = "SIGTERM") => {
    child.killedWith = signal;
    setImmediate(() => child.emit("close", null, signal));
    return true;
  };
  return child;
}

// Spawner double: writes the authoritative complete_task transport file, emits a
// stream line, then closes with the requested exit code.
export function runnerSpawner({
  response = "findings",
  dataPoints = ["point-1"],
  exitCode = 0,
  resultWriter = null,
  record = [],
  onSpawn = null,
} = {}) {
  return (command, args, options) => {
    const child = fakeChild();
    record.push({ command, args, options, child });
    setImmediate(() => {
      try {
        if (resultWriter) resultWriter({ command, args, options, child });
        else if (options?.env?.QQ_RUNNER_RESULT_FILE) {
          writeFileSync(
            options.env.QQ_RUNNER_RESULT_FILE,
            JSON.stringify({ runnerId: options.env.QQ_RUNNER_ID, response, data_points: dataPoints }),
            "utf8",
          );
        }
        child.stdout.write(`${JSON.stringify({ step_update: { step_type: "tool", tool_name: "view_file", state: "ACTIVE" } })}\n`);
      } catch (err) {
        child.emit("error", err);
        return;
      }
      if (onSpawn) onSpawn({ command, args, options, child });
      child.emit("close", exitCode, null);
    });
    return child;
  };
}

// Notification transport double that behaves like a live agent session: idle
// starts a turn, busy queues/steers without interrupting.
export function agentTransport({ name = "fake-agent", idle = true } = {}) {
  const delivered = [];
  return {
    name,
    delivered,
    set idle(value) {
      this._idle = value;
    },
    get idle() {
      return this._idle ?? idle;
    },
    async deliver(notification) {
      const state = this.idle ? "delivered" : "queued";
      delivered.push({ ...notification, state });
      return { state, messageId: `msg-${delivered.length}`, via: name };
    },
  };
}

// Fake pi extension API surface.
export function fakePi({ existingTools = [] } = {}) {
  const handlers = new Map();
  const registered = [];
  const sent = [];
  const commands = {};
  const activeHistory = [];
  const pi = {
    handlers,
    registered,
    sent,
    commands,
    activeHistory,
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerTool(definition) {
      registered.push(definition);
    },
    registerCommand(name, definition) {
      commands[name] = definition;
    },
    getActiveTools() {
      return [...existingTools, ...registered.map((tool) => tool.name)].map((name) => ({ name }));
    },
    getAllTools() {
      return [...existingTools, ...registered.map((tool) => tool.name)].map((name) => ({ name }));
    },
    setActiveTools(names) {
      activeHistory.push(names);
      pi.activeTools = names;
    },
    sendMessage(message, options) {
      sent.push({ kind: "message", message, options });
    },
    sendUserMessage(content, options) {
      sent.push({ kind: "user", content, options });
    },
  };
  return pi;
}

export function fakeContext({ idle = true, tokens = 100, contextWindow = 1_000_000, notifications = [] } = {}) {
  const ctx = {
    notifications,
    compactCalls: [],
    statuses: [],
    idle,
    isIdle() {
      return ctx.idle;
    },
    getContextUsage() {
      return { tokens: ctx.tokens, contextWindow: ctx.contextWindow };
    },
    compact(options) {
      ctx.compactCalls.push(options ?? {});
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(key, value) {
        ctx.statuses.push({ key, value });
      },
    },
  };
  ctx.tokens = tokens;
  ctx.contextWindow = contextWindow;
  return ctx;
}

export async function callHandlers(pi, name, event, ctx) {
  const results = [];
  for (const handler of pi.handlers.get(name) ?? []) {
    results.push(await handler(event, ctx));
  }
  return results;
}

// Invoke handlers synchronously. An async handler still runs its whole body up
// to the first `await` before returning, which is what a runtime that drains a
// queued message inside the send call actually does to the extension.
export function callHandlersSync(pi, name, event, ctx) {
  for (const handler of pi.handlers.get(name) ?? []) {
    handler(event, ctx);
  }
}

// Minimal double of the pi 0.84.1 session runtime that the Architect completion
// path is written against. Its ordering follows the installed source:
//
//   * `sendMessage({customType, details}, {deliverAs:"steer"})` queues the
//     message on the agent (`agent.steer`) and returns immediately;
//   * when the loop drains the queue it emits `message_start` then `message_end`
//     and only THEN does agent-session persist the entry
//     (`appendCustomMessageEntry` runs after the extension handlers returned);
//   * `sendUserMessage` (the idle wakeup) raises a regular user message entry.
//
// `consume: "sync"` drains the queue inside the send call — the early-consumption
// race — while the default queues the drain for the caller to run explicitly.
export function piRuntimeDouble({ idle = true, sessionFile = "/tmp/pi-session.jsonl", persist = true, consume = "manual", ui = null } = {}) {
  const handlers = new Map();
  const sent = [];
  const entries = [];
  const commands = {};
  const queue = [];
  const runtime = {
    handlers,
    sent,
    entries,
    commands,
    queue,
    consume,
    persisted: [],
  };
  let drainPromise = null;

  const ctx = {
    ui: ui ?? { notifications: [], notify(message, level) { ctx.ui.notifications.push({ message, level }); }, setStatus() {} },
    // Mutable: `pi.ctx.idle = false` models the operator's turn starting.
    isIdle: () => ctx.idle,
    // Faithful to pi 0.84.1: `hasPendingMessages()` reports the session's
    // `pendingMessageCount`, which counts only queued *user prompt*
    // steers/follow-ups. A custom message steered by an extension goes into the
    // agent's own steering queue and is invisible here, so tests model a queued
    // user prompt by setting `pi.ctx.pendingUserMessages`.
    hasPendingMessages: () => (ctx.pendingUserMessages ?? 0) > 0,
    pendingUserMessages: 0,
    getContextUsage: () => ({ tokens: 10, contextWindow: 1_000_000 }),
    compact() {},
    // ReadonlySessionManager surface the extension is allowed to read.
    sessionManager: {
      getEntries: () => [...entries],
      getSessionFile: () => sessionFile,
      getLeafId: () => entries.at(-1)?.id ?? null,
    },
  };
  runtime.ctx = ctx;
  ctx.idle = idle;

  function appendEntry(entry) {
    const record = { id: `entry-${entries.length + 1}`, parentId: entries.at(-1)?.id ?? null, timestamp: new Date().toISOString(), ...entry };
    if (persist) entries.push(record);
    runtime.persisted.push(record);
    return record;
  }

  // Drain one pending custom message exactly as the pi agent loop does.
  async function drain({ sync = false } = {}) {
    const message = queue.shift();
    if (!message) return null;
    const startEvent = { type: "message_start", message };
    const endEvent = { type: "message_end", message };
    if (sync) {
      callHandlersSync(runtime.pi, "message_start", startEvent, ctx);
      callHandlersSync(runtime.pi, "message_end", endEvent, ctx);
    } else {
      await callHandlers(runtime.pi, "message_start", startEvent, ctx);
      await callHandlers(runtime.pi, "message_end", endEvent, ctx);
    }
    if (message.role === "custom") {
      appendEntry({
        type: "custom_message",
        customType: message.customType,
        content: message.content,
        display: message.display,
        details: message.details,
      });
    }
    return message;
  }

  async function wakeUser(text) {
    const message = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    await callHandlers(runtime.pi, "message_start", { type: "message_start", message }, ctx);
    await callHandlers(runtime.pi, "message_end", { type: "message_end", message }, ctx);
    appendEntry({ type: "message", message });
    return message;
  }

  const pi = {
    handlers,
    sent,
    commands,
    entries,
    queue,
    persisted: runtime.persisted,
    on(name, handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      return () => {};
    },
    registerTool() {},
    registerCommand(name, definition) {
      commands[name] = definition;
    },
    getAllTools: () => [],
    setActiveTools() {},
    sendMessage(message, options) {
      sent.push({ kind: "message", message, options });
      if (options?.deliverAs === "steer") {
        queue.push({ role: "custom", ...message, timestamp: Date.now() });
        if (consume === "sync") {
          drainPromise = drain({ sync: true });
        }
      }
    },
    sendUserMessage(content, options) {
      sent.push({ kind: "user", content, options });
      if (consume === "sync") {
        drainPromise = wakeUser(typeof content === "string" ? content : "");
      }
    },
  };
  // The double IS the pi surface an extension is constructed with; the runtime
  // hooks (ctx, entries, drain, wakeUser, queue) hang off the same object so a
  // test can drive the session and inspect it in one place.
  pi.ctx = ctx;
  pi.drain = drain;
  pi.wakeUser = wakeUser;
  pi.pendingDrain = () => drainPromise;
  runtime.pi = pi;
  return pi;
}

// Wait for a dispatched job to reach its durable terminal record, then return
// the same bounded summary view `list_jobs`/`check_runner` report.
//
// There is deliberately no wait tool in the workflow surface any more: an
// Architect yields after dispatch and is woken by the completion notification.
// Tests have no session to wake, so they read the durable record the same way
// `check_runner` does - never by parking an await on the job.
export async function waitForJobTerminal(stateDir, jobId, {
  timeoutMs = 10_000,
  requireDelivery = false,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = readJob(stateDir, jobId);
    if (record?.terminal && (!requireDelivery || record.delivery !== undefined)) {
      return { settled: true, ...jobSummary(record) };
    }
    if (Date.now() > deadline) {
      return {
        settled: false,
        ...(record ? jobSummary(record) : { id: jobId, status: null, terminal: null }),
        note: `timed out after ${timeoutMs}ms waiting for the durable terminal record of '${jobId}'`,
      };
    }
    await sleep(10);
  }
}
