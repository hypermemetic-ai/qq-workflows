#!/usr/bin/env node
/**
 * Pi worker adapter: runs one seat turn through ONE documented runtime interface
 * (`pi --mode rpc`, see workflow/pi-worker/rpc.mjs) and reports it on the event
 * contract the parent pipeline already consumes.
 *
 * Output surface (deliberately the parent's, never the model's):
 *   stdout : newline-delimited parent-contract JSON events only
 *   stderr : bounded, payload-free adapter diagnostics only (never reasoning,
 *            never a credential)
 *   exit 0 : the run settled as completed with a valid final answer (for the
 *            runner seat the adapter bridges that closing message through
 *            complete_task, which writes the authoritative transport)
 *   exit 1 : any non-success terminal - missing settle, a failed/aborted/
 *            truncated run, an empty answer, or an over-cap answer
 *   exit 2 : a launch/configuration/capability refusal (missing seat, missing
 *            runner identity or transport, wrong harness, unusable context
 *            policy, a runtime that selected a different provider/model than
 *            the central configuration, an effort level the model does not
 *            offer, or seat instructions naming a tool this runtime cannot
 *            expose)
 *   exit 130/143: cancelled (abort sent, then a signal if the runtime did not
 *            come back)
 *
 * Contract notes:
 *   * Effort is requested verbatim and validated against the model's real
 *     capability (`get_available_thinking_levels`): an unavailable level is a
 *     refusal, never a silent downgrade to `high`.
 *   * Provider, model, endpoint and credentials belong to pi's registry; this
 *     adapter only passes the operator's selection and the credential
 *     *reference* through the environment, then verifies the runtime's own
 *     report of the selected provider/model against that selection: a different
 *     one is refused, never silently run.
 *   * Success requires a settled run whose final assistant message did not end
 *     in `error`, `aborted`, or `length` (truncated at the output cap) - the
 *     same discipline the legacy runtime applies to its turn-end reason. Partial
 *     text from a failed request is never delivered as an authoritative result.
 *   * The runner's success path is the existing authoritative completion module
 *     (`completeTask` + `validateRunnerResultPayload`), not a second transport:
 *     the model is never told to call a completion tool, the adapter bridges the
 *     closing assistant message into that module.
 *   * Seat instructions are the shared role contract ADAPTED to this runtime
 *     (`./instructions.mjs`): this session exposes no MCP server and therefore no
 *     completion tool, so the contract's completion section is rewritten to the
 *     closing-message transport it actually implements, the workspace-search
 *     section names the tool this runtime registers, and a reference to any tool
 *     the seat's allowlist cannot resolve refuses the launch (exit 2).
 *
 * @module pi-worker/adapter
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  COMPLETE_TASK_RESPONSE_MAX,
  completeTask,
  validateRunnerResultPayload,
} from "../../bin/mcp-server.mjs";
import {
  WORKER_PI_EXTENSION,
  WORKER_SEATS,
  ensurePiWorkerSettings,
  loadWorkerConfig,
  readPiWorkerSettings,
  resolveWorkerApiKey,
  workerCompactionBudget,
  workerPiAllowedTools,
  workerPiBin,
} from "../worker-config.mjs";
import { loadPiSeatInstructions } from "./instructions.mjs";
import { PiRpcClient, PiRpcError } from "./rpc.mjs";

export const ADAPTER_EXIT = Object.freeze({ ok: 0, failed: 1, refused: 2, interrupted: 130, terminated: 143 });

/** Parse adapter argv. `--seat` and a prompt are always explicit. */
export function parseArgs(argv, env = process.env) {
  const args = { seat: undefined, cwd: undefined, prompt: undefined, promptFile: undefined, production: false, summaryFile: undefined };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => argv[++index];
    switch (token) {
      case "--seat": args.seat = value(); break;
      case "--cwd": case "-C": args.cwd = value(); break;
      case "--prompt": args.prompt = value(); break;
      case "--prompt-file": args.promptFile = value(); break;
      case "--production": args.production = true; break;
      case "--summary-file": args.summaryFile = value(); break;
      default:
        if (!String(token).startsWith("-")) positional.push(token);
    }
  }
  if (args.prompt === undefined && positional.length > 0) args.prompt = positional.at(-1);
  args.cwd ??= process.cwd();
  if (args.prompt === undefined && args.promptFile !== undefined) args.prompt = readFileSync(args.promptFile, "utf8");
  return args;
}

/**
 * Resolve the runner's bound identity and shared transport path. Fails closed:
 * only the existing `os.tmpdir()`-anchored transport `completeTask` itself uses
 * is accepted, and no default identity is ever invented.
 */
export function resolveRunnerTransport(env = process.env, { osTmpdir = tmpdir() } = {}) {
  const runnerId = env.QQ_RUNNER_ID;
  if (typeof runnerId !== "string" || runnerId.trim() === "") {
    throw Object.assign(new Error("runner seat requires a bound runner identity (QQ_RUNNER_ID is missing)"), { code: "runner_identity_required" });
  }
  const provided = env.QQ_RUNNER_RESULT_FILE;
  if (typeof provided !== "string" || provided.trim() === "") {
    throw Object.assign(new Error("runner seat requires the explicit QQ_RUNNER_RESULT_FILE transport path; no fallback is used"), { code: "runner_transport_required" });
  }
  if (!isAbsolute(provided)) {
    throw Object.assign(new Error(`runner transport path '${provided}' must be absolute`), { code: "runner_transport_invalid" });
  }
  const tempRoot = resolve(osTmpdir);
  const candidate = resolve(provided);
  if (candidate !== tempRoot && !candidate.startsWith(`${tempRoot}${sep}`)) {
    throw Object.assign(new Error(`runner transport path '${provided}' is outside the shared os.tmpdir() transport root '${tempRoot}'`), { code: "runner_transport_invalid" });
  }
  return { runnerId, resultFile: provided };
}

/** The `pi --mode rpc` argv for one seat turn. */
export function buildPiArgs({ seat, config, extension, tools, roleInstructions }) {
  if (!WORKER_SEATS.includes(seat)) throw new Error(`unknown worker seat '${seat}'`);
  const args = [
    "--mode", "rpc",
    "--provider", config.provider,
    "--model", config.model,
  ];
  if (config.reasoningEffort) args.push("--thinking", config.reasoningEffort);
  args.push(
    // One worker turn per process; no session file is written into the
    // operator's session store.
    "--no-session",
    // Only the reviewed worker extension loads; project-local extensions and
    // target-repo resources are never trusted by a worker session.
    "--no-extensions",
    "--extension", extension,
    "--no-approve",
    "--tools", tools.join(","),
    "--append-system-prompt", roleInstructions,
  );
  return args;
}

export function diagnostic(message) {
  process.stderr.write(`pi-worker-adapter: ${String(message).replace(/\s+/gu, " ").slice(0, 400)}\n`);
}

export function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function assistantText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("");
}

function toolTarget(args) {
  if (args === undefined || args === null) return undefined;
  const pick = (value) => (typeof value === "string" ? value.slice(0, 120) : undefined);
  try {
    const parsed = typeof args === "string" ? JSON.parse(args) : args;
    return pick(parsed?.command) ?? pick(parsed?.path) ?? pick(parsed?.file_path) ?? pick(parsed?.pattern);
  } catch {
    return undefined;
  }
}

/**
 * Assistant stop reasons that never authorize success. `error`/`aborted` mean
 * the request failed or was aborted (pi keeps any text streamed before the
 * failure in the message), and `length` means the output cap cut the answer
 * short. The legacy runtime fails closed on the same conditions (only a
 * `completed` turn-end reason may deliver), and a partial answer must never
 * become the runner's authoritative result or a seat's final report.
 */
export const BAD_STOP_REASONS = Object.freeze({
  error: "message_error",
  aborted: "run_aborted",
  length: "final_answer_truncated",
});

/**
 * Terminal gate: a settled run whose final assistant message completed normally,
 * with a non-empty final answer inside the parent's cap, is success; everything
 * else is a named failure. Never truncates a result into a pass.
 */
export function classifyPiTerminal({ settled, error, finalText, stopReason, errorMessage, cap = COMPLETE_TASK_RESPONSE_MAX } = {}) {
  if (error) return { ok: false, code: error.code ?? "runtime_error", diagnostic: String(error.message ?? "runtime error").slice(0, 300) };
  if (!settled) return { ok: false, code: "missing_terminal", diagnostic: "the pi run never settled (no agent_settled before the child ended)" };
  if (typeof stopReason === "string" && Object.hasOwn(BAD_STOP_REASONS, stopReason)) {
    const detail = typeof errorMessage === "string" && errorMessage.trim() !== "" ? ` (${errorMessage.trim().slice(0, 240)})` : "";
    return {
      ok: false,
      code: BAD_STOP_REASONS[stopReason],
      diagnostic: `the final assistant message ended with stopReason '${stopReason}'${detail}; a run that did not complete normally is never a pass`,
    };
  }
  if (typeof finalText !== "string" || finalText.trim() === "") {
    return { ok: false, code: "empty_final_answer", diagnostic: "the settled run produced no final assistant text" };
  }
  if (finalText.length > cap) {
    return { ok: false, code: "final_answer_over_cap", diagnostic: `final answer is ${finalText.length} chars, above the ${cap}-char transport cap; failing closed instead of truncating` };
  }
  return { ok: true };
}

/**
 * Translate one pi RPC event into the parent contract. Returns the terminal
 * state when the event settles the run.
 */
export function createTranslator({ seat, onLine }) {
  const state = {
    settled: false,
    error: null,
    finalText: "",
    // The latest assistant message's own terminal fields. pi reports a failed or
    // aborted request as an assistant message with `stopReason` `error`/
    // `aborted` (plus `errorMessage`) that still carries any text streamed
    // before the failure, so text alone cannot authorize success.
    stopReason: null,
    errorMessage: null,
    toolNames: new Map(),
    intermediate: 0,
  };
  const line = (event) => onLine(event);

  function stepUpdate({ toolName, state: stepState, durationSeconds, parameters }) {
    line({
      event: "step_update",
      step_update: {
        step_type: "tool",
        state: stepState,
        tool_name: toolName,
        ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
        ...(parameters === undefined ? {} : { tool_info: { parameters } }),
      },
    });
  }

  return {
    state,
    handle(event) {
      if (!event || typeof event !== "object") return;
      switch (event.type) {
        case "tool_execution_start": {
          const name = event.toolName ?? event.tool_name ?? "tool";
          const callId = event.toolCallId ?? event.toolCallIdStr ?? null;
          const target = toolTarget(event.args ?? event.arguments);
          if (callId) state.toolNames.set(callId, name);
          stepUpdate({ toolName: name, state: "ACTIVE" });
          line({ type: "item.started", item: { type: "tool_call", tool: name, ...(target === undefined ? {} : { path: target }) } });
          return;
        }
        case "tool_execution_end": {
          const callId = event.toolCallId ?? event.toolCallIdStr ?? null;
          const name = event.toolName ?? (callId ? state.toolNames.get(callId) : undefined) ?? "tool";
          const failed = event.isError === true || event.error !== undefined;
          stepUpdate({ toolName: name, state: "DONE", durationSeconds: typeof event.durationMs === "number" ? Math.round(event.durationMs / 100) / 10 : undefined });
          line({ type: "item.completed", item: { type: "tool_call", tool: name, ...(failed ? { status: "error" } : {}) } });
          return;
        }
        case "message_end": {
          const message = event.message ?? {};
          if (message.role !== "assistant") return;
          state.stopReason = typeof message.stopReason === "string" ? message.stopReason : null;
          state.errorMessage = typeof message.errorMessage === "string" ? message.errorMessage : null;
          const text = assistantText(message);
          if (text.trim() !== "") {
            if (state.finalText !== "" && state.finalText !== text) {
              // Superseded text is trajectory only: the parent must never read
              // intermediate prose as the final answer.
              state.intermediate += 1;
              line({ type: "item.completed", item: { type: "worker_intermediate_text", text: text.slice(0, 600) } });
            }
            state.finalText = text;
          }
          return;
        }
        case "agent_end": {
          if (event.willRetry === true) return;
          if (event.error) state.error = { code: "agent_error", message: String(event.error?.message ?? event.error) };
          return;
        }
        case "auto_retry_end": {
          if (event.success === false) state.error = { code: "auto_retry_failed", message: String(event.finalError ?? "runtime exhausted automatic retries") };
          return;
        }
        case "extension_error": {
          state.error = { code: "extension_error", message: String(event.error?.message ?? event.error ?? "worker extension failed") };
          return;
        }
        case "agent_settled": {
          state.settled = true;
          return;
        }
        default:
          return;
      }
    },
  };
}

/**
 * The runtime's own report of the selected model is the only evidence that the
 * centrally configured selection is what will actually serve this turn. A
 * provider/model swap is a config change, and this is where the swap is
 * confirmed: a differing report is a refusal (exit 2), never a silent run on
 * another provider, model, or billing route.
 *
 * The comparison is deliberately tolerant of how the runtime resolves the
 * selection (registry id or display name, any case) and refuses only on a
 * concrete mismatch - an unreported field is recorded, not invented.
 */
export function assertSelectedModel({ config, selected } = {}) {
  const provider = typeof selected?.provider === "string" ? selected.provider.trim() : "";
  if (provider !== "" && provider.toLowerCase() !== String(config.provider).trim().toLowerCase()) {
    throw Object.assign(
      new Error(`the pi runtime selected provider '${provider}' but the central worker configuration selects '${config.provider}'; refusing instead of running on a different provider`),
      { code: "provider_mismatch" },
    );
  }
  const reported = [selected?.id, selected?.name].filter((value) => typeof value === "string" && value.trim() !== "");
  if (reported.length === 0) return { provider: provider || null, model: null, confirmed: false };
  const wanted = String(config.model).trim().toLowerCase();
  if (!reported.some((value) => value.trim().toLowerCase() === wanted)) {
    throw Object.assign(
      new Error(`the pi runtime selected model '${reported.join("' / '")}' but the central worker configuration selects '${config.model}'; refusing instead of running on a different model`),
      { code: "model_mismatch" },
    );
  }
  return { provider: provider || null, model: reported[0], confirmed: true };
}

function selectedModelView(model) {
  return {
    provider: typeof model?.provider === "string" ? model.provider : null,
    id: typeof model?.id === "string" ? model.id : (typeof model?.modelId === "string" ? model.modelId : null),
    name: typeof model?.name === "string" ? model.name : null,
  };
}

function summaryShape({ seat, args, config, runtime, settings, transport, client, instructions }) {
  return {
    seat,
    id: args.sessionId ?? null,
    cwd: args.cwd,
    harness: config.harness,
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    context: config.context,
    piAgentDir: settings.dir,
    piSettings: settings.settings,
    piRegistry: { source: settings.source, linked: settings.linked, absent: settings.absent },
    piBin: runtime.bin,
    piArgs: runtime.args,
    allowedTools: runtime.tools,
    instructions: {
      source: instructions.source,
      adaptedSections: instructions.adaptedSections,
      namedTools: instructions.namedTools,
    },
    runnerBound: transport !== null,
    sessionId: args.sessionId ?? null,
    pid: client?.pid ?? null,
  };
}

async function runOneTurn(args, env) {
  if (!WORKER_SEATS.includes(args.seat)) {
    throw Object.assign(new Error(`--seat must be one of ${WORKER_SEATS.join(", ")} (got ${JSON.stringify(args.seat)}); the seat is never inferred`), { code: "seat_required" });
  }
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw Object.assign(new Error("no prompt supplied"), { code: "missing_prompt" });
  }
  const config = loadWorkerConfig({ env });
  if (config.harness !== "pi") {
    throw Object.assign(new Error(`the pi worker adapter was launched under harness '${config.harness}'; expected 'pi'`), { code: "harness_mismatch" });
  }
  // Runner identity and transport are validated before any work starts.
  const transport = args.seat === "runner" ? resolveRunnerTransport(env) : null;

  // The materialized worker settings must match the configured context policy:
  // a divergence would mean the runtime compacts under different rules than the
  // operator configured, so it is refused instead of reported as a guess.
  const settings = ensurePiWorkerSettings(env, config);
  const effective = readPiWorkerSettings(env);
  if (
    effective.enabled !== config.context.enabled
    || effective.reserveTokens !== config.context.reserveTokens
    || effective.keepRecentTokens !== config.context.keepRecentTokens
  ) {
    throw Object.assign(new Error(`worker pi settings at '${effective.file}' do not match the configured context policy`), { code: "context_policy_mismatch" });
  }

  const tools = workerPiAllowedTools(args.seat);
  // The instruction surface must describe THIS runtime: the shared contract is
  // adapted (no MCP completion tool, the ZG tool's real name) and a reference
  // that cannot resolve refuses the launch before any work starts.
  const instructions = loadPiSeatInstructions(args.seat, { tools });
  const extension = WORKER_PI_EXTENSION;
  const piArgs = buildPiArgs({ seat: args.seat, config, extension, tools, roleInstructions: instructions.body });
  const bin = workerPiBin(env);
  const client = new PiRpcClient({ bin, args: piArgs, cwd: args.cwd, env });
  client.start();

  const summary = summaryShape({
    seat: args.seat,
    args,
    config,
    runtime: { bin, args: piArgs, tools },
    settings,
    transport,
    client,
    instructions,
  });
  summary.effectiveSettings = effective;

  const translator = createTranslator({ seat: args.seat, onLine: (event) => emit(event) });
  client.onEvent = (event) => translator.handle(event);

  let cancelled = null;
  const cancel = (signal) => {
    if (cancelled) return;
    cancelled = { signal };
    diagnostic(`received ${signal}; aborting the pi run`);
    void client.cancel({ signal }).then((result) => {
      diagnostic(`cancel teardown: ${JSON.stringify(result)}`);
      process.exit(signal === "SIGINT" ? ADAPTER_EXIT.interrupted : ADAPTER_EXIT.terminated);
    });
    setTimeout(() => process.exit(signal === "SIGINT" ? ADAPTER_EXIT.interrupted : ADAPTER_EXIT.terminated), 15_000).unref();
  };
  process.on("SIGTERM", () => cancel("SIGTERM"));
  process.on("SIGINT", () => cancel("SIGINT"));

  try {
    const initState = await client.request({ type: "get_state" }, { timeoutMs: 60_000 });
    // No provider call has happened yet: confirming the selection here refuses a
    // substituted provider/model before any (billable) turn is sent.
    summary.selectedModel = assertSelectedModel({ config, selected: selectedModelView(initState?.model) });
    summary.sessionId = initState?.sessionId ?? null;
    summary.capacity = {
      note: "contextWindow is registry metadata for the selected model, not an enforced hard input bound",
      contextWindow: typeof initState?.model?.contextWindow === "number" ? initState.model.contextWindow : null,
      modelId: initState?.model?.id ?? initState?.model?.modelId ?? null,
      provider: initState?.model?.provider ?? null,
    };
    if (summary.capacity.contextWindow && config.context.reserveTokens) {
      summary.compaction = workerCompactionBudget({ contextWindow: summary.capacity.contextWindow, reserveTokens: config.context.reserveTokens });
    }

    // Capability validation: the requested effort must exist for this model.
    const levels = (await client.request({ type: "get_available_thinking_levels" }, { timeoutMs: 30_000 }))?.levels ?? [];
    summary.availableThinkingLevels = levels;
    if (config.reasoningEffort && !levels.includes(config.reasoningEffort)) {
      throw Object.assign(
        new Error(`configured reasoning_effort '${config.reasoningEffort}' is not offered by model '${config.model}' (available: ${levels.join(", ") || "none"}); refusing instead of silently reducing the level`),
        { code: "effort_unsupported" },
      );
    }

    // Context policy: enable auto-compaction explicitly and verify the runtime
    // accepted it (a claim from metadata is not evidence of enforcement).
    if (config.context.enabled && initState?.autoCompactionEnabled !== true) {
      await client.request({ type: "set_auto_compaction", enabled: true }, { timeoutMs: 30_000 });
    }
    const afterPolicy = await client.request({ type: "get_state" }, { timeoutMs: 30_000 });
    summary.autoCompactionEnabled = afterPolicy?.autoCompactionEnabled === true;
    if (config.context.enabled && summary.autoCompactionEnabled !== true) {
      throw Object.assign(new Error("the runtime did not enable automatic compaction for the configured worker context policy"), { code: "compaction_unavailable" });
    }

    await client.request({ type: "prompt", message: args.prompt }, { timeoutMs: 60_000 });

    // Wait for the run to settle (or for the child to end first).
    const exit = await new Promise((resolveSettled) => {
      const timer = setInterval(() => {
        if (translator.state.settled) {
          clearInterval(timer);
          resolveSettled({ reason: "settled" });
        }
      }, 25);
      if (typeof timer.unref === "function") timer.unref();
      client.waitForExit().then((result) => {
        clearInterval(timer);
        resolveSettled({ reason: "exit", result });
      });
    });
    if (exit.reason === "exit" && !translator.state.settled && !translator.state.error) {
      translator.state.error = { code: "runtime_exit", message: `the pi runtime ended (${exit.result?.reason ?? "unknown"}) before the run settled` };
    }

    const verdict = classifyPiTerminal({
      settled: translator.state.settled,
      error: translator.state.error,
      finalText: translator.state.finalText,
      stopReason: translator.state.stopReason,
      errorMessage: translator.state.errorMessage,
      cap: COMPLETE_TASK_RESPONSE_MAX,
    });
    if (!verdict.ok) {
      summary.outcome = verdict.code;
      summary.intermediateTexts = translator.state.intermediate;
      diagnostic(`${verdict.code}: ${verdict.diagnostic}`);
      if (client.stderrTail.trim() !== "") diagnostic(`runtime stderr tail: ${client.stderrTail.trim().slice(-400)}`);
      return { ok: false, code: verdict.code, summary };
    }

    // Measured usage, never capacity: reported for the record only.
    try {
      const stats = await client.request({ type: "get_session_stats" }, { timeoutMs: 30_000 });
      summary.contextUsage = stats?.contextUsage ?? null;
      summary.tokens = stats?.tokens ?? null;
      summary.assistantMessages = stats?.assistantMessages ?? null;
      summary.toolCalls = stats?.toolCalls ?? null;
    } catch (error) {
      summary.contextUsage = { unavailable: String(error?.message ?? error).slice(0, 120) };
    }

    const finalText = translator.state.finalText;
    emit({ type: "item.completed", item: { type: "agent_message", text: finalText } });
    summary.outcome = "completed";

    if (args.seat === "runner") {
      await completeTask({ response: finalText, data_points: [] });
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(transport.resultFile, "utf8"));
      } catch (error) {
        summary.outcome = "transport_rejected";
        diagnostic(`transport_rejected: transport file '${transport.resultFile}' could not be read: ${error.message}`);
        return { ok: false, code: "transport_rejected", summary };
      }
      const loaded = validateRunnerResultPayload(parsed, { id: transport.runnerId, resultFile: transport.resultFile });
      if (!loaded.ok) {
        summary.outcome = "transport_rejected";
        diagnostic(`transport_rejected: ${loaded.error}`);
        return { ok: false, code: "transport_rejected", summary };
      }
      summary.resultChars = finalText.length;
    }
    await client.cancel({ signal: "SIGTERM", graceMs: 3_000 });
    return { ok: true, code: "completed", summary };
  } finally {
    try {
      client.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let args;
  try {
    args = parseArgs(argv, env);
  } catch (error) {
    diagnostic(`argument error: ${error.message}`);
    return ADAPTER_EXIT.refused;
  }
  if (args.production !== true) {
    diagnostic("refused: workers run only with an explicit --production (no mock/dummy-credential path exists for the pi runtime)");
    return ADAPTER_EXIT.refused;
  }
  let outcome;
  try {
    outcome = await runOneTurn(args, env);
  } catch (error) {
    diagnostic(`refused: ${error?.message ?? error}`);
    if (args.summaryFile) {
      try {
        writeFileSync(args.summaryFile, `${JSON.stringify({ ok: false, code: error?.code ?? "refused", seat: args.seat }, null, 2)}\n`, "utf8");
      } catch {
        /* ignore */
      }
    }
    return ADAPTER_EXIT.refused;
  }
  if (args.summaryFile) {
    try {
      writeFileSync(args.summaryFile, `${JSON.stringify(outcome.summary, null, 2)}\n`, "utf8");
    } catch {
      /* ignore */
    }
  }
  return outcome.ok ? ADAPTER_EXIT.ok : ADAPTER_EXIT.failed;
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isDirectRun) {
  main().then((code) => process.exit(code)).catch((error) => {
    diagnostic(`unexpected failure: ${error?.message ?? error}`);
    process.exit(ADAPTER_EXIT.failed);
  });
}
