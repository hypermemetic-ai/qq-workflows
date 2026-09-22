// qq-workflows worker tools for pi.
//
// This extension is injected only into worker seats
// (`pi --no-extensions --extension <this file>`, one process per runner,
// implementer, and reviewer turn). An ordinary pi session never loads it.
//
// It always contributes the shared, root-bound `zvec_grep_search` gateway. The
// reviewed policy lives in the retained gateway module
// (`prototype/deepseek-minimal/gateway/zvec-grep-tool.mjs`): the model-facing
// schema is re-derived from the pinned upstream snapshot, the three
// caller-controlled fields (`root`, `freshness`, `autoUpdate`) are removed and
// re-injected from the bound worktree, and upstream results are classified with
// the same evidence rules (missing index, freshness, no-matches).
//
// Runner communication (phase 2a): when the adapter validated a communication
// binding and passed it through the environment (`QQ_WORKFLOW_COMMUNICATION`,
// see `workflow/communication.mjs`), this extension additionally registers the
// production relay receiver and the three coordinator-authored workflow tools
// (`workflow_read_assignment`, `workflow_acknowledge_assignment`,
// `workflow_report_progress`) inside this same extension file — the receiver
// seam stays the one reviewed worker extension. An absent binding preserves the
// exact prior surface (search tool only); a malformed binding refuses the whole
// extension (never partially enabled). The fixture-only tools
// (`fixture_acknowledge_amendment`, `fixture_report_progress`) are NOT exposed
// here.
//
// One thing is deliberately local: the stdio transport. The gateway runtime
// module imports the pinned runtime's MCP client package, which is not
// resolvable from the installed integration source the worker session starts
// in. Rather than add a second search implementation or a vendored dependency,
// this file speaks the same `zg server --stdio --mcp-toolset agent` launch over
// the same newline-delimited JSON-RPC framing (initialize + tools/call) and
// keeps every policy decision in the reviewed module above.
//
// Everything else about a worker turn - role instructions, provider, model,
// effort, context policy, completion - belongs to the runtime that starts the
// process, not to this extension.

import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { GATEWAY_ENV_DEFAULTS } from "../prototype/deepseek-minimal/adapter/runtime.mjs";
import {
  DEFAULT_INDEX_TIMEOUT_MS,
  DEFAULT_RECONCILE_ATTEMPTS,
  DEFAULT_RECONCILE_DELAY_MS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_ZG_BIN,
  ENV_BIN,
  ENV_INDEX_TIMEOUT_MS,
  ENV_RECONCILE_ATTEMPTS,
  ENV_RECONCILE_DELAY_MS,
  ENV_ROOT,
  ENV_SEARCH_TIMEOUT_MS,
  ENV_SEAT,
  INJECTED_SEARCH_FIELDS,
  SERVER_COMMAND_ARGS,
  TOOL_NAME,
  boundSearchArguments,
  indexCommand,
  indexMissingEvidence,
  modelFacingTool,
  needsReconcile,
  readSearchToolSnapshot,
  reportedFreshness,
  searchArgumentViolations,
} from "../prototype/deepseek-minimal/gateway/zvec-grep-tool.mjs";
import { COMMUNICATION_TOOL_NAMES, parseCommunicationBinding } from "../workflow/communication.mjs";
import { registerCommunicationReceiver } from "../workflow/communication-receiver.mjs";

export const WORKER_TOOLS_EXTENSION_NAME = "qq-worker-tools";
/** Worker seats that receive the shared search tool: every role, including the
 *  runner: investigation needs the same search access). */
export const WORKER_SEARCH_SEATS = ["runner", "implementer", "reviewer"];
export const WORKER_SEARCH_TOOL_NAME = TOOL_NAME;

function positiveInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

/**
 * Resolve the seat's search binding. Fails closed: an unknown seat, a missing
 * root, or a root that is not an existing directory refuses the binding rather
 * than silently searching something else.
 */
export function resolveWorkerSearchBinding({ seat, root } = {}) {
  if (!WORKER_SEARCH_SEATS.includes(seat)) {
    throw new Error(`${ENV_SEAT} must be one of ${WORKER_SEARCH_SEATS.join(", ")} (got ${JSON.stringify(seat)})`);
  }
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error(`${ENV_ROOT} is required: the worker search tool must be bound to the seat worktree`);
  }
  const resolved = resolve(root.trim());
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`${ENV_ROOT} '${resolved}' is not an existing directory`);
  }
  return { root: resolved, seat };
}

/** The validated search environment for one bound seat. */
export function workerSearchEnv({ seat, root, env = process.env } = {}) {
  const binding = resolveWorkerSearchBinding({ seat, root });
  return Object.freeze({
    root: binding.root,
    seat: binding.seat,
    bin: typeof env[ENV_BIN] === "string" && env[ENV_BIN].trim() !== ""
      ? env[ENV_BIN].trim()
      : (GATEWAY_ENV_DEFAULTS[ENV_BIN] ?? DEFAULT_ZG_BIN),
    searchTimeoutMs: positiveInt(env[ENV_SEARCH_TIMEOUT_MS], DEFAULT_SEARCH_TIMEOUT_MS),
    indexTimeoutMs: positiveInt(env[ENV_INDEX_TIMEOUT_MS], DEFAULT_INDEX_TIMEOUT_MS),
    reconcileAttempts: env[ENV_RECONCILE_ATTEMPTS] === undefined
      ? DEFAULT_RECONCILE_ATTEMPTS
      : nonNegativeInt(env[ENV_RECONCILE_ATTEMPTS], DEFAULT_RECONCILE_ATTEMPTS),
    reconcileDelayMs: env[ENV_RECONCILE_DELAY_MS] === undefined
      ? DEFAULT_RECONCILE_DELAY_MS
      : nonNegativeInt(env[ENV_RECONCILE_DELAY_MS], DEFAULT_RECONCILE_DELAY_MS),
  });
}

/** The model-facing schema, re-derived from the pinned upstream snapshot. */
export function workerSearchToolSchema() {
  return modelFacingTool(readSearchToolSnapshot().tool).inputSchema;
}

function textResult(text, { isError = false } = {}) {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * One stdio session against `zg server --stdio --mcp-toolset agent`, speaking
 * the same JSONL JSON-RPC framing the pinned bridge uses, bounded by
 * `timeoutMs` and cancelled on abort. The caller owns one call per session.
 */
export function zgStdioToolCall({ bin, args, root, callArgs, timeoutMs, signal, spawnImpl = spawn }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnImpl(bin, args, { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({ error: { message: `could not start '${bin}': ${error?.message ?? error}` } });
      return;
    }
    let buffer = "";
    let settled = false;
    let stderrTail = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish({ error: { message: `search exceeded ${timeoutMs}ms` } }), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    if (signal?.aborted) {
      finish({ error: { message: "search cancelled before it was issued" } });
      return;
    }
    signal?.addEventListener?.("abort", () => finish({ error: { message: "search cancelled" } }), { once: true });

    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        finish({ error: { message: `search transport write failed: ${error?.message ?? error}` } });
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/u, "");
        buffer = buffer.slice(index + 1);
        if (line.trim() === "") continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 2) {
          if (message.error) finish({ error: { message: String(message.error.message ?? "zg search failed") } });
          else finish(message.result ?? {});
        } else if (message.id === 1) {
          send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TOOL_NAME, arguments: callArgs } });
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-400);
    });
    child.on("error", (error) => finish({ error: { message: `zg transport error: ${error?.message ?? error}` } }));
    child.on("close", () => {
      if (!settled) finish({ error: { message: `zg closed the session before answering${stderrTail === "" ? "" : `: ${stderrTail}`}` } });
    });

    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "qq-worker-tools", version: "1" } },
    });
  });
}

/** One index creation for the bound root (mirrors the reviewed index CLI). */
export function runIndexOnce({ bin, root, timeoutMs, spawnImpl = spawn }) {
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawnImpl(bin, indexCommand(root), { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolvePromise({ ok: false, error: `could not start '${bin}': ${error?.message ?? error}` });
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      resolvePromise({ ok: false, error: `indexing exceeded ${timeoutMs}ms` });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, error: String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ok: code === 0, code });
    });
  });
}

/**
 * The bound search gateway. All argument policy comes from the reviewed module;
 * the transport is the local stdio bridge above.
 */
export function createWorkerSearchGateway({ binding, env, spawnImpl = spawn } = {}) {
  let indexed = false;
  return {
    async search(args, { signal } = {}) {
      const tool = modelFacingTool(readSearchToolSnapshot().tool);
      const violations = searchArgumentViolations(args ?? {}, tool.inputSchema);
      if (violations.length > 0) {
        return textResult(
          `zvec-grep search refused: ${violations.join("; ")}. This gateway is bound to ${binding.root} for the ${binding.seat} seat; it refuses to query any other root.`,
          { isError: true },
        );
      }
      const callArgs = boundSearchArguments(args ?? {}, binding.root);
      const deadline = Date.now() + env.searchTimeoutMs;
      const attempt = async () => zgStdioToolCall({
        bin: env.bin,
        args: [...SERVER_COMMAND_ARGS],
        root: binding.root,
        callArgs,
        timeoutMs: Math.max(1, deadline - Date.now()),
        signal,
        spawnImpl,
      });

      let result = await attempt();
      let missing = indexMissingEvidence(result);
      let attempts = 0;
      while ((missing || needsReconcile(result)) && attempts < env.reconcileAttempts) {
        attempts += 1;
        if (missing) {
          const index = await runIndexOnce({ bin: env.bin, root: binding.root, timeoutMs: env.indexTimeoutMs, spawnImpl });
          if (!index.ok) {
            return textResult(`zvec-grep index for ${binding.root} could not be built (${index.error ?? `exit ${index.code}`}). Use rg or direct file reads for this worktree.`, { isError: true });
          }
          indexed = true;
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, env.reconcileDelayMs));
        result = await attempt();
        missing = indexMissingEvidence(result);
      }

      if (result?.error) {
        return textResult(`zvec-grep search unavailable (${String(result.error.message ?? result.error).slice(0, 240)}). Use rg or direct file reads for this worktree.`, { isError: true });
      }
      const freshness = reportedFreshness(result);
      const freshText = freshness === "possibly_stale" ? `\nfreshness: possibly_stale` : "";
      return {
        content: [{ type: "text", text: `${textOf(result)}${freshText}` }],
        ...(result?.isError === true ? { isError: true } : {}),
      };
    },
    get indexed() {
      return indexed;
    },
  };
}

function textOf(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
}

/**
 * Build the extension. `options.gateway` is injectable so offline tests can
 * drive the tool without the `zg` binary.
 *
 * Runner communication: when the environment carries a valid communication
 * binding (the adapter validates it structurally before launch and binds the
 * observed session against the change record), the extension ALSO registers
 * the receiver and the three coordinator-authored workflow tools; the shared
 * search tool stays registered exactly as before. An absent binding preserves
 * the exact prior surface. A present-but-malformed binding throws: the
 * extension is never partially enabled.
 */
export function createWorkerToolsExtension(pi, { env = process.env, cwd = process.cwd(), gateway = null, spawnImpl = spawn, communication = undefined } = {}) {
  const binding = resolveWorkerSearchBinding({ seat: env[ENV_SEAT], root: env[ENV_ROOT] || cwd });
  let live = gateway;
  function searchGateway() {
    if (live) return live;
    live = createWorkerSearchGateway({ binding, env: workerSearchEnv({ seat: binding.seat, root: binding.root, env }), spawnImpl });
    return live;
  }

  const communicationBinding = communication === undefined ? parseCommunicationBinding(env) : communication;
  const receiver = communicationBinding.enabled ? registerCommunicationReceiver(pi, { binding: communicationBinding.binding, env }) : null;

  const tool = {
    name: WORKER_SEARCH_TOOL_NAME,
    label: "Zvec grep search",
    description: "Search the indexed worktree for code, symbols, and text. Bound to this seat's own worktree; the search root cannot be changed.",
    parameters: workerSearchToolSchema(),
    async execute(_toolCallId, params, signal) {
      const result = await searchGateway().search(params ?? {}, { signal });
      const text = textOf(result);
      return {
        content: result?.content ?? [{ type: "text", text: "" }],
        details: { root: binding.root, seat: binding.seat, isError: result?.isError === true, chars: text.length },
        ...(result?.isError === true ? { isError: true } : {}),
      };
    },
  };

  async function register() {
    let Type = null;
    try {
      ({ Type } = await import("typebox"));
    } catch {
      Type = null;
    }
    pi.registerTool({ ...tool, parameters: Type ? Type.Unsafe(tool.parameters) : tool.parameters });
    return { registered: receiver ? [tool.name, ...COMMUNICATION_TOOL_NAMES] : [tool.name], binding };
  }

  return {
    register,
    binding,
    communication: receiver,
    seats: WORKER_SEARCH_SEATS,
    injectedFields: [...INJECTED_SEARCH_FIELDS],
    close: async () => {
      if (receiver) await receiver.stop();
    },
  };
}

export default async function qqWorkerTools(pi) {
  const extension = createWorkerToolsExtension(pi);
  await extension.register();
  process.on("exit", () => {
    void extension.close();
  });
  return () => {
    void extension.close();
  };
}
