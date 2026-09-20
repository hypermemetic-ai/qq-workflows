#!/usr/bin/env node
/**
 * Root-bound zvec-grep search gateway (MCP stdio server + MCP stdio client).
 *
 * dsh's pinned `@deepseek-ai/dsh-mcp-client` spawns this process for the
 * implementer and reviewer seats only (a seat-scoped `--patch` overlay), and
 * publishes the single tool it advertises as `mcp__zvec_grep__zvec_grep_search`
 * through the upstream bridge. The gateway then:
 *
 *   * binds ONE root - the worktree cwd the adapter initialized this seat with,
 *     passed in `QQ_ZVEC_GREP_ROOT` - and rejects any caller-supplied `root`,
 *     `freshness`, `autoUpdate`, or unknown option before it queries anything;
 *   * forwards each accepted search to `zg server --stdio --mcp-toolset agent`
 *     (the reviewed stdio bridge to the shared daemon, no port/PID hardcoding)
 *     with `root` set to the bound worktree and `freshness: wait_for_fresh`,
 *     `autoUpdate: true` injected, so the backend reconciles before answering;
 *   * on the FIRST search that reports `INDEX_MISSING` for the bound root,
 *     creates the index once with `zg index <root>` (existing operator local
 *     embedding configuration, existing ignore rules, no rebuild/drop/ignore
 *     flags) and retries; concurrent first searches share that one creation;
 *   * re-runs a bounded number of `wait_for_fresh` searches while the reply is
 *     still `possibly_stale` (watcher gap / daemon restart), and if it remains
 *     stale, returns the results with an explicit freshness warning instead of
 *     pretending they are current;
 *   * never creates an index when no search happens, never queries another
 *     root, and never treats a failure as an empty result set: unavailable
 *     search (missing zg, failed index creation, timeout, cancellation) is an
 *     explicit error result, while only an upstream "No matches." reply means
 *     the worktree has no matching content.
 *
 * Everything the model can influence is bounded: search and index phases have
 * independent timeouts, the upstream connection has a bounded connect timeout,
 * diagnostics are payload-bounded and written to stderr only (stdout carries
 * the MCP protocol exclusively), and the process exits - reaping the upstream
 * zg child - when its client closes stdin or signals it.
 *
 * Pure decision logic lives in `./zvec-grep-tool.mjs`; this file is the
 * executable wiring and is exercised by the prototype acceptance suite against
 * stub MCP servers and a fake `zg`.
 *
 * @module gateway/zvec-grep-gateway
 */
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  SERVER_NAME,
  INJECTED_SEARCH_FIELDS,
  boundSearchArguments,
  indexCommand,
  indexMissingEvidence,
  modelFacingTool,
  needsReconcile,
  readSearchToolSnapshot,
  searchArgumentViolations,
  searchGatewayEnv,
  serverCommandArgs,
} from "./zvec-grep-tool.mjs";

/** Gateway package identity reported over MCP. */
export const GATEWAY_VERSION = "0.0.0-prototype";

/** Bounded stderr diagnostics; never a payload echo. */
const DIAGNOSTIC_LIMIT = 400;
/** Bounded upstream child stderr kept for truthful error messages. */
const CHILD_STDERR_LIMIT = 1_200;
/** Grace for the upstream child to exit after a cancel signal. */
const CHILD_KILL_GRACE_MS = 2_000;
/** Bound on establishing the upstream MCP connection. */
const CONNECT_TIMEOUT_MS = 30_000;
/** Grace before the gateway exits after its own stdin closes. */
const SHUTDOWN_GRACE_MS = 250;

/** Env names this gateway owns; they are never forwarded to the zg child. */
const CONTROL_ENV = new Set([
  "QQ_ZVEC_GREP_ROOT",
  "QQ_ZVEC_GREP_SEAT",
  "QQ_ZVEC_GREP_BIN",
  "QQ_ZVEC_GREP_SEARCH_TIMEOUT_MS",
  "QQ_ZVEC_GREP_INDEX_TIMEOUT_MS",
  "QQ_ZVEC_GREP_RECONCILE_ATTEMPTS",
  "QQ_ZVEC_GREP_RECONCILE_DELAY_MS",
]);

function diagnostic(line) {
  process.stderr.write(`zvec-grep-gateway: ${String(line).slice(0, DIAGNOSTIC_LIMIT)}\n`);
}

/** Child environment for zg: the permitted inherited environment, ours removed. */
export function zgChildEnv(env) {
  const child = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CONTROL_ENV.has(key)) continue;
    child[key] = value;
  }
  return child;
}

function tailOf(buffer) {
  const text = String(buffer).trim();
  return text.length <= CHILD_STDERR_LIMIT ? text : `…${text.slice(-CHILD_STDERR_LIMIT)}`;
}

function isCancellation(error) {
  return /\b(abort|cancel)/iu.test(String(error?.message ?? "")) || error?.name === "AbortError";
}

function isTimeout(error) {
  return /timeout|timed out/iu.test(String(error?.message ?? ""));
}

/** One bounded MCP tool result; text blocks only, error flag preserved. */
function resultPayload(result) {
  const content = Array.isArray(result?.content)
    ? result.content
      .filter(block => block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
      .map(block => ({ type: "text", text: block.text }))
    : [];
  const payload = { content };
  if (result?.isError === true) payload.isError = true;
  return payload;
}

/** An explicit gateway error result (never an empty result set). */
function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * The upstream `zg server --stdio --mcp-toolset agent` connection: lazily
 * connected, reused across calls, reconnected once after a lost transport.
 */
export class ZvecGrepUpstream {
  #bin;
  #root;
  #childEnv;
  #client;
  #transport;
  #connecting;
  #stderr = "";
  #generation = 0;

  constructor({ bin, root, env, diagnosticSink = diagnostic }) {
    this.#bin = bin;
    this.#root = root;
    this.#childEnv = zgChildEnv(env);
    this.diagnosticSink = diagnosticSink;
  }

  get generation() {
    return this.#generation;
  }

  get stderrTail() {
    return tailOf(this.#stderr);
  }

  get connected() {
    return this.#client !== undefined;
  }

  async #ensureConnected() {
    if (this.#client !== undefined) return this.#client;
    if (this.#connecting === undefined) {
      const generation = ++this.#generation;
      this.#connecting = (async () => {
        const transport = new StdioClientTransport({
          command: this.#bin,
          args: serverCommandArgs(),
          cwd: this.#root,
          env: this.#childEnv,
          stderr: "pipe",
        });
        transport.stderr?.on("data", (chunk) => {
          this.#stderr = `${this.#stderr}${chunk}`;
          if (this.#stderr.length > CHILD_STDERR_LIMIT * 4) this.#stderr = this.#stderr.slice(-CHILD_STDERR_LIMIT * 2);
        });
        const client = new Client({ name: SERVER_NAME, version: GATEWAY_VERSION });
        client.onclose = () => {
          if (this.#client === client) this.#client = undefined;
        };
        await client.connect(transport);
        if (generation !== this.#generation) {
          await client.close().catch(() => {});
          throw new Error("upstream connection superseded by a newer generation");
        }
        this.#transport = transport;
        this.#client = client;
        return client;
      })().finally(() => {
        this.#connecting = undefined;
      });
    }
    return await this.#connecting;
  }

  async #dispose() {
    const client = this.#client;
    const transport = this.#transport;
    this.#client = undefined;
    this.#transport = undefined;
    if (client === undefined) return;
    // Prefer the negotiated close, then reap the child: the SDK transport owns
    // the spawn, so a close is what guarantees no orphan zg bridge survives.
    await Promise.race([
      client.close().catch(() => {}),
      new Promise(resolve => setTimeout(resolve, CHILD_KILL_GRACE_MS).unref?.()),
    ]);
    transport?.close?.().catch(() => {});
  }

  /** Close the current generation without touching future ones. */
  async reset() {
    await this.#dispose();
  }

  /**
   * One bounded upstream tool call. A lost transport is reconnected once; a
   * timeout or cancellation is never retried.
   * @param name - upstream tool name.
   * @param args - upstream arguments.
   * @param options.signal - cancellation signal for this call.
   * @param options.timeoutMs - bound for the call.
   */
  async call(name, args, { signal, timeoutMs } = {}) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const client = await this.#ensureConnected();
        return await client.callTool({ name, arguments: args }, {
          ...(signal === undefined ? {} : { signal }),
          ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
        });
      } catch (error) {
        lastError = error;
        await this.#dispose();
        if (signal?.aborted || isCancellation(error) || isTimeout(error)) throw error;
      }
    }
    throw lastError;
  }

  async close() {
    await this.#dispose();
  }
}

/**
 * One bounded `zg index <root>` run. The exact reviewed invocation: no
 * `--rebuild`, no `--drop`, no `--no-ignore`, no embedding guess.
 * @returns `{ok: true}` or `{ok: false, reason}` with a bounded diagnostic.
 */
export function runIndexCli({ bin, root, env, timeoutMs, signal, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, indexCommand(root), { cwd: root, env: zgChildEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, reason: `could not start '${bin} index': ${String(error.message).slice(0, 200)}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch { /* already gone */ }
      }, CHILD_KILL_GRACE_MS);
      killTimer.unref?.();
      finish({ ok: false, cancelled: true, reason: "index creation was cancelled" });
    };
    child.stdout?.on("data", (chunk) => { stdout = `${stdout}${chunk}`; });
    child.stderr?.on("data", (chunk) => { stderr = `${stderr}${chunk}`; });
    child.on("error", (error) => finish({ ok: false, reason: `index command failed to start: ${String(error.message).slice(0, 200)}` }));
    child.on("close", (code, termSignal) => {
      if (code === 0) {
        finish({ ok: true, output: tailOf(stdout) });
      } else {
        const detail = tailOf(stderr) || tailOf(stdout);
        finish({
          ok: false,
          reason: `index command exited ${code === null ? `on ${termSignal}` : `with code ${code}`}${detail === "" ? "" : `: ${detail}`}`,
        });
      }
    });
    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
      finish({ ok: false, reason: `index creation exceeded ${timeoutMs}ms and was terminated` });
    }, timeoutMs);
    timer.unref?.();
  });
}

/**
 * The gateway's one search decision path. Separated from process wiring so the
 * acceptance suite can drive it against a stub upstream.
 */
export class SearchGateway {
  #env;
  #tool;
  #upstream;
  #indexRun;
  #indexState;
  #sleep;
  #now;

  /**
   * @param options.env - resolved gateway environment (see `searchGatewayEnv`).
   * @param options.upstream - upstream client (defaults to the real zg bridge).
   * @param options.sleep - injectable delay (tests use a no-op/short delay).
   * @param options.now - injectable clock (tests).
   */
  constructor({ env, upstream, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
    this.#env = env;
    this.#upstream = upstream ?? new ZvecGrepUpstream({ bin: env.bin, root: env.root, env: process.env });
    this.#tool = modelFacingTool(readSearchToolSnapshot().tool);
    this.#sleep = sleep;
    this.#now = now;
  }

  get tool() {
    return this.#tool;
  }

  get env() {
    return this.#env;
  }

  get upstream() {
    return this.#upstream;
  }

  /** The first (and only) index creation of this gateway's lifetime. */
  #indexOnce(signal) {
    if (this.#indexState !== undefined) return Promise.resolve(this.#indexState);
    if (this.#indexRun === undefined) {
      this.#indexRun = runIndexCli({
        bin: this.#env.bin,
        root: this.#env.root,
        env: process.env,
        timeoutMs: this.#env.indexTimeoutMs,
        signal,
      }).then((outcome) => {
        this.#indexState = outcome;
        this.#indexRun = undefined;
        return outcome;
      });
    }
    return this.#indexRun;
  }

  async #searchOnce(args, { signal, deadline }) {
    const remaining = deadline - this.#now();
    if (remaining <= 0) throw new Error(`search exceeded the ${this.#env.searchTimeoutMs}ms budget before it was issued`);
    const result = await this.#upstream.call(this.#tool.name, args, { signal, timeoutMs: remaining });
    return resultPayload(result);
  }

  /**
   * Run one search for the bound worktree.
   * @param args - caller arguments (validated here).
   * @param options.signal - cancellation from the harness tool dispatch.
   * @returns an MCP tool result: upstream content, or an explicit error.
   */
  async search(args, { signal } = {}) {
    const violations = searchArgumentViolations(args, this.#tool.inputSchema);
    if (violations.length > 0) {
      return errorResult(`zvec-grep search refused: ${violations.join("; ")}. This gateway is bound to ${this.#env.root} for the ${this.#env.seat} seat; it refuses to query any other root.`);
    }
    const forwarded = boundSearchArguments(args, this.#env.root);
    const deadline = this.#now() + this.#env.searchTimeoutMs;
    let result;
    try {
      result = await this.#searchOnce(forwarded, { signal, deadline });
    } catch (error) {
      return this.#failure(error);
    }
    if (indexMissingEvidence(result)) {
      const outcome = await this.#indexOnce(signal);
      if (outcome.cancelled) return errorResult("zvec-grep search cancelled while creating the worktree index.");
      if (!outcome.ok) {
        return errorResult(
          `zvec-grep search unavailable: this worktree has no index and creating one failed (${outcome.reason}). `
          + "Use rg or direct file reads for this worktree; the index was not created and no other root was queried.",
        );
      }
      this.#indexState = outcome;
      try {
        result = await this.#searchOnce(forwarded, { signal, deadline });
      } catch (error) {
        return this.#failure(error);
      }
      if (indexMissingEvidence(result)) {
        return errorResult(
          `zvec-grep search unavailable: the index for ${this.#env.root} was reported missing again after a successful creation. `
          + "Use rg or direct file reads; the gateway will not rebuild or drop an index automatically.",
        );
      }
    }
    let attempts = 0;
    while (needsReconcile(result) && attempts < this.#env.reconcileAttempts && this.#now() < deadline && signal?.aborted !== true) {
      attempts += 1;
      await this.#sleep(this.#env.reconcileDelayMs);
      if (signal?.aborted === true) break;
      try {
        result = await this.#searchOnce(forwarded, { signal, deadline });
      } catch (error) {
        return this.#failure(error);
      }
    }
    if (needsReconcile(result)) {
      // Truthful labelling only: results are returned, but never as current.
      const note = `note: the index for ${this.#env.root} is still possibly_stale after ${attempts} reconcile search${attempts === 1 ? "" : "es"}; `
        + "treat these results as possibly stale and re-read the cited files or use rg before acting on them.";
      return { content: [{ type: "text", text: note }, ...result.content], ...(result.isError === true ? { isError: true } : {}) };
    }
    return result;
  }

  /** Map a thrown upstream error to a truthful, bounded error result. */
  #failure(error) {
    if (isCancellation(error)) {
      return errorResult(`zvec-grep search cancelled: ${String(error?.message ?? "cancelled").slice(0, 200)}`);
    }
    if (isTimeout(error)) {
      return errorResult(
        `zvec-grep search timed out within ${this.#env.searchTimeoutMs}ms for ${this.#env.root} (the index may be mid-update). `
        + "Use rg or direct file reads, or retry the search once the update settles.",
      );
    }
    const tail = this.#upstream.stderrTail ?? "";
    const detail = tail === "" ? "" : ` — zg said: ${tail}`;
    return errorResult(
      `zvec-grep search unavailable (${String(error?.message ?? error).slice(0, 240)})${detail}. `
      + "Use rg or direct file reads for this worktree.",
    );
  }

  async close() {
    await this.#upstream.close();
  }
}

/**
 * Build the MCP server that fronts one bound gateway.
 * @param gateway - a `SearchGateway`.
 * @param options.diagnosticSink - bounded diagnostic sink (defaults to stderr).
 */
export function createGatewayServer(gateway, { diagnosticSink = diagnostic } = {}) {
  const server = new Server({ name: SERVER_NAME, version: GATEWAY_VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({ tools: [gateway.tool] }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args } = request.params ?? {};
    if (name !== gateway.tool.name) {
      return errorResult(`unknown tool '${String(name).slice(0, 80)}'; this gateway exposes only ${gateway.tool.name}`);
    }
    try {
      return await gateway.search(args, { signal: ctx?.mcpReq?.signal });
    } catch (error) {
      diagnosticSink(`search failed: ${String(error?.message ?? error)}`);
      return errorResult(
        `zvec-grep search failed unexpectedly (${String(error?.message ?? error).slice(0, 240)}). Use rg or direct file reads for this worktree.`,
      );
    }
  });
  return server;
}

/**
 * Boot the gateway on stdio. Returns a `{ shutdown }` handle for tests.
 * @param options.env - environment (defaults to `process.env`).
 */
export async function main({ env = process.env, stdin = process.stdin, diagnosticSink = diagnostic } = {}) {
  let resolved;
  try {
    resolved = searchGatewayEnv(env);
  } catch (error) {
    // Fail closed at startup: no bound root, no seat, or no bounded budget
    // means the tool must not be published at all. dsh's mcp-client reports a
    // failed startup loudly (`failOnStartupError`), so this is never silent.
    diagnosticSink(`startup refused: ${String(error?.message ?? error).slice(0, 240)}`);
    process.exitCode = 2;
    return { shutdown: async () => {}, ready: Promise.reject(error), env: undefined };
  }
  const gateway = new SearchGateway({ env: resolved });
  const server = createGatewayServer(gateway, { diagnosticSink });
  const transport = new StdioServerTransport();
  let closing;
  const shutdown = async (code) => {
    closing ??= (async () => {
      try {
        await server.close();
      } catch { /* already closed */ }
      await gateway.close();
    })().then(() => {
      if (code !== undefined) process.exit(code);
    });
    return await closing;
  };
  server.onclose = () => {
    void shutdown(0);
  };
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      diagnosticSink(`received ${signal}; closing the zg bridge`);
      void shutdown(0);
      setTimeout(() => process.exit(0), CHILD_KILL_GRACE_MS).unref?.();
    });
  }
  stdin.on("end", () => void shutdown(0));
  stdin.on("close", () => void shutdown(0));
  await server.connect(transport);
  return { shutdown, ready: Promise.resolve(), env: resolved, gateway, server };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    diagnostic(`fatal: ${String(error?.message ?? error)}`);
    process.exit(2);
  });
}
