/**
 * JSON-RPC stdio client for the pinned DeepSeek Harness SDK runtime.
 *
 * Mirrors the wire contract implemented by the upstream Python SDK
 * (`python/sdk/src/deepseek_harness/client.py`): newline-delimited JSON-RPC on
 * stdout/stdin, four server-to-client notification methods, and requests
 * `initialize` / `session/prompt` / `shutdown`.
 *
 * Two invariants the prototype depends on:
 *   * the runtime is spawned as its own process-group leader (`detached`), so a
 *     single group signal reaches the harness AND every shell it spawned;
 *   * runtime stderr is captured, bounded, and never echoed to our stdout
 *     (protocol cleanliness) and never mixed into the model transcript.
 *
 * @module adapter/harness-client
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000;
const STDERR_TAIL_BYTES = 8_192;

/**
 * One running harness runtime.
 */
export class HarnessClient {
  #child;
  #pending = new Map();
  #notifications = [];
  #waiters = [];
  #stderr = "";
  #closed = false;
  #cancelJournal = [];

  /**
   * @param options.launch - `{ bin, args, cwd }` for the pinned runtime.
   * @param options.env - complete child environment (never inherited blindly by callers).
   */
  constructor({ launch, env }) {
    this.launch = launch;
    this.env = env;
    this.#child = spawn(launch.bin, launch.args, {
      cwd: launch.cwd,
      env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pid = this.#child.pid;
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    const lines = createInterface({ input: this.#child.stdout });
    lines.on("line", line => this.#onLine(line));
    this.#child.stderr.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-STDERR_TAIL_BYTES);
    });
    this.#child.on("close", (code, signal) => this.#failAll(new Error(`harness exited (code ${code}, signal ${signal})`)));
    this.#child.on("error", error => this.#failAll(error));
  }

  get stderrTail() {
    return this.#stderr;
  }

  get cancelJournal() {
    return this.#cancelJournal;
  }

  get running() {
    return !this.#closed && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  #onLine(line) {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      // A non-JSON stdout line means the protocol is broken; treat it as a
      // transport fault rather than silently skipping bytes.
      this.#failAll(new Error(`harness stdout carried a non-JSON line: ${trimmed.slice(0, 200)}`));
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = this.#pending.get(message.id);
      if (waiter) {
        this.#pending.delete(message.id);
        waiter(message);
      }
      return;
    }
    this.#notifications.push(message);
    for (const waiter of this.#waiters.splice(0)) waiter(message);
  }

  #failAll(error) {
    this.#closed = true;
    for (const [, waiter] of this.#pending) waiter({ error: { message: error.message } });
    this.#pending.clear();
    for (const waiter of this.#waiters.splice(0)) waiter(null);
  }

  async #request(method, params, timeoutMs) {
    const id = randomUUID();
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const answer = new Promise((resolve) => {
      this.#pending.set(id, resolve);
      const timer = setTimeout(() => {
        if (this.#pending.delete(id)) resolve({ error: { message: `harness did not answer ${method} within ${timeoutMs}ms` } });
      }, timeoutMs);
      timer.unref?.();
    });
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    const response = await answer;
    if (response.error !== undefined) {
      throw new Error(`harness ${method} failed: ${response.error.message ?? JSON.stringify(response.error)}`);
    }
    return response.result;
  }

  /** Await the next notification (bounded), returning undefined on timeout/close. */
  async nextNotification(timeoutMs) {
    if (this.#notifications.length > 0) return this.#notifications.shift();
    // The resolver has to exist outside the promise executor so the timeout
    // callback can settle the wait; a bare `resolve` in an arrow-function
    // parameter is out of scope here and would crash the adapter whenever the
    // harness stays quiet for the whole window (e.g. a >30s shell command).
    let settle;
    const pending = new Promise((resolve) => {
      settle = resolve;
      this.#waiters.push(resolve);
    });
    const timer = setTimeout(() => {
      const index = this.#waiters.indexOf(settle);
      if (index !== -1) this.#waiters.splice(index, 1);
      settle(null);
    }, timeoutMs);
    timer.unref?.();
    const notification = await pending;
    clearTimeout(timer);
    return notification ?? undefined;
  }

  initialize({ cwd, provider, model, reasoningEffort, maxTokens }) {
    return this.#request("initialize", {
      cwd,
      provider,
      model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      ...maxTokens === undefined ? {} : { maxTokens },
    }, DEFAULT_INITIALIZE_TIMEOUT_MS);
  }

  prompt({ sessionId, contentBlocks }) {
    return this.#request("session/prompt", { sessionId, contentBlocks }, 30_000);
  }

  /**
   * Bounded, escalating shutdown that always reaps the whole process group.
   * @param options.gracefulMs - window for the JSON-RPC `shutdown` handshake.
   * @param options.signalWaitMs - window for the group to exit after SIGTERM.
   * @returns journal entries recording each escalation step (test evidence).
   */
  async stop({ gracefulMs = 1_500, signalWaitMs = 3_000 } = {}) {
    if (!this.running) return this.#cancelJournal;
    try {
      await Promise.race([
        this.#request("shutdown", undefined, gracefulMs),
        new Promise(resolve => setTimeout(resolve, gracefulMs)),
      ]);
      this.#cancelJournal.push({ step: "shutdown-request", ok: true });
    } catch (error) {
      this.#cancelJournal.push({ step: "shutdown-request", ok: false, message: error.message.slice(0, 400) });
    }
    try {
      this.#child.stdin.end();
    } catch {
      /* stdin already gone */
    }
    if (await this.#waitExit(500)) return this.#cancelJournal;
    // Group signals: the detached harness leads its own group, so its shells
    // and their descendants are addressed by -pid.
    this.#signalGroup("SIGTERM");
    this.#cancelJournal.push({ step: "sigterm-group", pid: this.pid });
    if (await this.#waitExit(signalWaitMs)) return this.#cancelJournal;
    this.#signalGroup("SIGKILL");
    this.#cancelJournal.push({ step: "sigkill-group", pid: this.pid });
    await this.#waitExit(2_000);
    return this.#cancelJournal;
  }

  #signalGroup(signal) {
    try {
      process.kill(-this.pid, signal);
    } catch {
      try {
        this.#child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }

  async #waitExit(timeoutMs) {
    if (!this.running) return true;
    return await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.#child.once("close", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}
