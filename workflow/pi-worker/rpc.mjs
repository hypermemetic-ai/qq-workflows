// Minimal, documented client for pi's JSONL RPC mode (`pi --mode rpc`).
//
// Scope: exactly what one worker turn needs - start, one request/response pair
// at a time, streamed events, and an abort that degrades to a process signal.
// The protocol is pi's own (docs/rpc.md): commands are JSON objects on stdin,
// one per line; every line on stdout is either a `response` for a command or a
// streamed event.
//
// Framing is strict JSONL by LF only (`\n`). Node's `readline` is deliberately
// not used: it also splits on U+2028/U+2029, which are legal inside JSON
// strings and therefore inside a valid record (docs/rpc.md "Framing").
import { spawn } from "node:child_process";

/** Serialize one RPC command as a single JSONL record. */
export function encodeCommand(command) {
  return `${JSON.stringify(command)}\n`;
}

/**
 * Split accumulated stdout into complete records plus the trailing partial.
 * Only `\n` delimits records; a trailing `\r` belongs to the wire, not the JSON.
 */
export function splitRecords(buffer) {
  const parts = String(buffer ?? "").split("\n");
  const rest = parts.pop() ?? "";
  const records = [];
  for (const part of parts) {
    const text = part.endsWith("\r") ? part.slice(0, -1) : part;
    if (text.trim() === "") continue;
    records.push(text);
  }
  return { records, rest };
}

/** Bounded, payload-free diagnostic line. */
function diagnostic(sink, message) {
  sink(`pi-rpc: ${String(message).slice(0, 400)}\n`);
}

export class PiRpcError extends Error {
  constructor(message, { command = null, code = null } = {}) {
    super(message);
    this.name = "PiRpcError";
    this.command = command;
    this.code = code;
  }
}

/**
 * One `pi --mode rpc` child process.
 *
 * `request()` resolves the matching `response` record; events are handed to the
 * registered sink in arrival order. A response that reports `success: false`
 * rejects with the runtime's own error message - it is never silently ignored.
 */
export class PiRpcClient {
  #child = null;
  #buffer = "";
  #pending = new Map();
  #events = [];
  #seq = 0;
  #exited = null;
  #resolveExit = null;
  #stderrTail = "";
  #closed = false;

  constructor({ bin, args = [], cwd, env = process.env, spawnImpl = spawn, diagnosticSink = (text) => process.stderr.write(text) } = {}) {
    if (typeof bin !== "string" || !bin.trim()) throw new Error("a pi binary is required");
    this.bin = bin;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.spawnImpl = spawnImpl;
    this.diagnosticSink = diagnosticSink;
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  get stderrTail() {
    return this.#stderrTail;
  }

  get currentEvent() {
    return this.#events.length > 0 ? this.#events[this.#events.length - 1] : null;
  }

  #exitPromise() {
    if (this.#exited === null) {
      this.#exited = new Promise((resolve) => {
        this.#resolveExit = resolve;
      });
    }
    return this.#exited;
  }

  /** Spawn the runtime and start consuming its stdout. Idempotent. */
  start() {
    if (this.#child) return this;
    let child;
    try {
      child = this.spawnImpl(this.bin, this.args, {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: this.env,
      });
    } catch (error) {
      throw new PiRpcError(`could not start '${this.bin}': ${error?.message ?? error}`, { code: "spawn_failed" });
    }
    this.#child = child;
    this.#exitPromise();

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#consume(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-4000);
    });
    child.on("error", (error) => {
      diagnostic(this.diagnosticSink, `child error: ${error?.message ?? error}`);
      for (const entry of this.#pending.values()) entry.reject(new PiRpcError(`pi RPC child failed: ${error?.message ?? error}`, { code: "child_error" }));
      this.#pending.clear();
    });
    child.on("close", (code, signal) => {
      this.#closed = true;
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      for (const entry of this.#pending.values()) {
        entry.reject(new PiRpcError(`pi RPC child ended (${reason}) before '${entry.command}' was answered`, { command: entry.command, code: "child_exit" }));
      }
      this.#pending.clear();
      this.#resolveExit?.({ code, signal, reason });
    });
    return this;
  }

  #consume(chunk) {
    this.#buffer += chunk;
    const { records, rest } = splitRecords(this.#buffer);
    this.#buffer = rest;
    for (const record of records) {
      let parsed;
      try {
        parsed = JSON.parse(record);
      } catch {
        // Unknown non-JSON output is liveness only; it is never interpreted.
        continue;
      }
      if (parsed && parsed.type === "response") this.#settle(parsed);
      else this.#emit(parsed);
    }
  }

  #settle(response) {
    const id = response.id ?? null;
    const entry = this.#pending.get(id) ?? this.#pending.get(null);
    if (!entry) return;
    this.#pending.delete(entry.id);
    if (response.success === false) {
      entry.reject(new PiRpcError(String(response.error ?? `${entry.command} was rejected`), { command: entry.command, code: "command_failed" }));
      return;
    }
    entry.resolve(response.data === undefined ? {} : response.data);
  }

  #emit(event) {
    this.#events.push(event);
    if (this.#events.length > 200) this.#events.shift();
    this.onEvent?.(event);
  }

  /** Send one command without waiting for its response. */
  notify(command) {
    if (!this.#child || !this.#child.stdin.writable) {
      throw new PiRpcError("pi RPC stdin is not writable", { command: command?.type ?? null, code: "closed" });
    }
    this.#child.stdin.write(encodeCommand(command));
  }

  /**
   * Send one command and resolve its `data` (or `{}`). Rejects when the runtime
   * answers `success: false`, when the child exits first, or on timeout.
   */
  request(command, { timeoutMs = 120_000 } = {}) {
    const id = `qq-${++this.#seq}`;
    const entry = { id, command: command.type ?? "request" };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.#pending.set(id, entry);
    let timer = null;
    const guarded = timeoutMs > 0
      ? Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new PiRpcError(`'${entry.command}' did not answer within ${timeoutMs}ms`, { command: entry.command, code: "timeout" })), timeoutMs);
          if (typeof timer.unref === "function") timer.unref();
        }),
      ])
      : promise;
    guarded.catch(() => {}).finally(() => {
      if (timer) clearTimeout(timer);
      this.#pending.delete(id);
    });
    this.notify({ id, ...command });
    return guarded;
  }

  /** Wait for the child to exit. */
  waitForExit() {
    return this.#exitPromise();
  }

  /**
   * Graceful cancellation: ask the runtime to abort the current operation, then
   * terminate the process if it does not come back within the grace window.
   */
  async cancel({ signal = "SIGTERM", graceMs = 5_000 } = {}) {
    try {
      this.notify({ type: "abort" });
    } catch {
      /* the child may already be gone; the signal path below still runs */
    }
    const exit = await Promise.race([
      this.waitForExit(),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), graceMs);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    if (exit) return { aborted: true, forced: false, exit };
    try {
      this.#child?.kill(signal);
    } catch {
      /* ignore */
    }
    const forced = await Promise.race([
      this.waitForExit(),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 5_000);
        if (typeof timer.unref === "function") timer.unref();
      }),
    ]);
    if (forced) return { aborted: true, forced: true, exit: forced };
    try {
      this.#child?.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    const killed = await this.waitForExit().catch(() => null);
    return { aborted: true, forced: true, killed: true, exit: killed };
  }

  /** Forced teardown used on unexpected failures. */
  kill(signal = "SIGKILL") {
    try {
      this.#child?.kill(signal);
    } catch {
      /* ignore */
    }
  }
}
