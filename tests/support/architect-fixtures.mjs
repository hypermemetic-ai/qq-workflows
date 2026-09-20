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

export function tempDir(prefix = "qq-architect-") {
  return mkdtempSync(join(tmpdir(), prefix));
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
  // Isolated environment: never read the operator's live central worker config.
  const env = { QQ_WORKER_CONFIG_FILE: join(root, "no-central-worker-config.json") };
  return { root, env, prompt };
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
