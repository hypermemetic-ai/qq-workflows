#!/usr/bin/env node
/**
 * DeepSeek Minimal worker adapter: runs one pinned-harness turn for one seat
 * and reports it on the event contract the parent pipeline already consumes.
 *
 * Its output surface is deliberately the parent's:
 *   stdout : newline-delimited parent-contract JSON events only
 *   stderr : bounded, payload-free adapter diagnostics only (never reasoning,
 *            never a credential)
 *   exit 0 : the run reached a `completed` turn with a valid final answer
 *            (and, for the runner seat, complete_task landed the transport)
 *   exit 1 : any non-success terminal, missing terminal, or over-cap answer
 *   exit 2 : a launch/configuration refusal (missing seat, missing runner
 *            identity or transport, unpinned runtime, missing credential)
 *   exit 130/143: cancelled (graceful then forced harness teardown)
 *
 * The parent always selects this adapter through the central operator
 * configuration (`workflow/worker-config.mjs` -> buildWorkerLaunch); the adapter
 * re-reads that same configuration so harness/model/endpoint/effort/output cap
 * cannot diverge, and selects `production` explicitly (`--production`). Mock
 * mode (`--base-url <loopback>`) keeps its dummy-credential, loopback-only
 * guard intact and is what the offline acceptance suite drives.
 *
 * @module adapter/worker
 */
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  COMPLETE_TASK_RESPONSE_MAX,
  completeTask,
  validateRunnerResultPayload,
} from "../../../bin/mcp-server.mjs";
import {
  WORKER_SEATS,
  loadWorkerConfig,
  resolveWorkerApiKey,
} from "../../../workflow/worker-config.mjs";
import { HarnessClient } from "./harness-client.mjs";
import { classifyTerminal, SessionTranslator } from "./translate.mjs";
import { harnessEnv, resolveRuntime } from "./runtime.mjs";

const IGNORED_PARENT_FLAGS = new Set([
  "exec",
  "--json",
  "--ephemeral",
  "--skip-git-repo-check",
  "--dangerously-bypass-approvals-and-sandbox",
  "--ignore-user-config",
  "-c",
  "-m",
]);

/**
 * Parse adapter argv. `--seat` is required for every launch: a seat is never
 * inferred, so a reviewer run can never silently become the implementer, and a
 * retired seat (e.g. `--seat researcher`) is rejected rather than aliased.
 * Production mode additionally requires the parent's explicit `--production`
 * and re-reads the central operator configuration.
 */
export function parseArgs(argv, env = process.env) {
  const args = { seat: undefined, cwd: undefined, prompt: undefined, promptFile: undefined, baseUrl: undefined, sessionId: undefined, maxTokens: undefined, summaryFile: undefined, eventsFile: undefined, production: false, runtimeRoot: undefined };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => argv[++index];
    switch (token) {
      case "--seat": args.seat = value(); break;
      case "--cwd": case "-C": args.cwd = value(); break;
      case "--prompt": args.prompt = value(); break;
      case "--prompt-file": args.promptFile = value(); break;
      case "--base-url": args.baseUrl = value(); break;
      case "--production": args.production = true; break;
      case "--runtime-root": args.runtimeRoot = value(); break;
      case "--session-id": args.sessionId = value(); break;
      case "--max-tokens": args.maxTokens = Number(value()); break;
      case "--summary-file": args.summaryFile = value(); break;
      case "--events-file": args.eventsFile = value(); break;
      default:
        if (IGNORED_PARENT_FLAGS.has(token)) {
          // `-c key=value` / `-m model` carry Codex config the harness pins itself.
          if (token === "-c" || token === "-m") index += 1;
        } else if (token.startsWith("-")) {
          // unknown flag: ignored on purpose, the adapter pins its own inputs
        } else {
          positional.push(token);
        }
    }
  }
  if (args.prompt === undefined && positional.length > 0) args.prompt = positional.at(-1);
  args.cwd ??= process.cwd();
  if (args.prompt === undefined && args.promptFile !== undefined) args.prompt = readFileSync(args.promptFile, "utf8");
  return args;
}

/**
 * Resolve the runner's bound identity and shared transport path. Fails closed
 * with a bounded diagnostic and touches no default marker or `/tmp` fallback:
 * only the existing `os.tmpdir()`-anchored transport that `completeTask` itself
 * uses is accepted.
 */
export function resolveRunnerTransport(env = process.env, { osTmpdir = tmpdir() } = {}) {
  const runnerId = env.QQ_RUNNER_ID;
  if (typeof runnerId !== "string" || runnerId.trim() === "") {
    throw Object.assign(
      new Error("runner seat requires a bound runner identity (QQ_RUNNER_ID is missing)"),
      { code: "runner_identity_required" },
    );
  }
  const provided = env.QQ_RUNNER_RESULT_FILE;
  if (typeof provided !== "string" || provided.trim() === "") {
    throw Object.assign(
      new Error("runner seat requires the explicit QQ_RUNNER_RESULT_FILE transport path; no fallback is used"),
      { code: "runner_transport_required" },
    );
  }
  if (!isAbsolute(provided)) {
    throw Object.assign(
      new Error(`runner transport path '${provided}' must be absolute`),
      { code: "runner_transport_invalid" },
    );
  }
  // The transport must live under the same OS temp root the parent uses (the
  // existing completeTask location). A hand-coded /tmp guess on a host whose
  // tempdir differs, or any path outside it, is refused.
  const tempRoot = resolve(osTmpdir);
  const candidate = resolve(provided);
  if (candidate !== tempRoot && !candidate.startsWith(`${tempRoot}${sep}`)) {
    throw Object.assign(
      new Error(`runner transport path '${provided}' is outside the shared os.tmpdir() transport root '${tempRoot}'`),
      { code: "runner_transport_invalid" },
    );
  }
  return { runnerId, resultFile: provided };
}

function diagnostic(message) {
  process.stderr.write(`prototype-adapter: ${String(message).slice(0, 400)}\n`);
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function runOneTurn(args, env) {
  const mode = args.production ? "production" : "mock";
  if (!WORKER_SEATS.includes(args.seat)) {
    throw Object.assign(
      new Error(`--seat must be one of ${WORKER_SEATS.join(", ")} (got ${JSON.stringify(args.seat)}); the seat is never inferred`),
      { code: "seat_required" },
    );
  }
  if (typeof args.prompt !== "string" || args.prompt.trim() === "") {
    throw Object.assign(new Error("no prompt supplied"), { code: "missing_prompt" });
  }
  if (mode === "mock" && args.runtimeRoot === undefined && args.baseUrl === undefined && env.QQ_PROTO_PROVIDER_URL === undefined) {
    throw Object.assign(new Error("mock mode requires --base-url <loopback origin>"), { code: "missing_base_url" });
  }
  if (mode === "production" && args.baseUrl !== undefined) {
    throw Object.assign(new Error("--base-url is a mock-only flag; production uses the configured Messages endpoint"), { code: "mode_conflict" });
  }
  // Runner identity and transport are validated before any work starts.
  const transport = args.seat === "runner" ? resolveRunnerTransport(env) : null;

  let config = null;
  let apiKey = null;
  if (mode === "production") {
    config = loadWorkerConfig({ env });
    if (config.harness !== "deepseek-minimal") {
      throw Object.assign(
        new Error(`production adapter launched under harness '${config.harness}'; expected 'deepseek-minimal'`),
        { code: "harness_mismatch" },
      );
    }
    const resolvedKey = resolveWorkerApiKey(config, { env });
    if (!resolvedKey.key) {
      throw Object.assign(
        new Error("production harness has no provider credential; refusing to fall back to dummy auth"),
        { code: "provider_credential_required" },
      );
    }
    apiKey = resolvedKey.key;
  }

  const maxTokens = Number.isSafeInteger(args.maxTokens) && args.maxTokens > 0
    ? args.maxTokens
    : (config?.maxOutputTokens ?? undefined);
  const runtime = resolveRuntime({
    seat: args.seat,
    mode,
    baseUrl: args.baseUrl,
    cwd: args.cwd,
    endpoint: mode === "production" ? config.messagesBaseUrl : undefined,
    runtimeRoot: args.runtimeRoot,
    maxTokens,
    env,
  });
  const sessionId = args.sessionId ?? `proto-${randomUUID()}`;
  // Debug/evidence aid: `--events-file` records the accepted session events verbatim.
  const eventLog = args.eventsFile ? [] : null;
  const rawEvents = args.eventsFile ? [] : null;
  const translator = new SessionTranslator({
    sessionId,
    onLine: (event) => {
      if (eventLog) eventLog.push({ at: Date.now(), line: event });
      emit(event);
    },
  });
  const client = new HarnessClient({ launch: runtime.launch, env: harnessEnv({ env, runtime, apiKey }) });

  let cancelled = false;
  const cancel = (signal) => {
    if (cancelled) return;
    cancelled = true;
    diagnostic(`received ${signal}; shutting down harness and its descendants`);
    void client.stop().then((journal) => {
      diagnostic(`cancel teardown: ${JSON.stringify(journal).slice(0, 300)}`);
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
    setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 10_000).unref();
  };
  process.on("SIGTERM", () => cancel("SIGTERM"));
  process.on("SIGINT", () => cancel("SIGINT"));

  const seenSeqs = new Set();
  const summary = {
    sessionId,
    seat: args.seat,
    mode,
    provider: runtime.provider,
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort,
    maxTokens: runtime.maxTokens,
    runtimeRoot: runtime.layout.root,
    runtimeHead: runtime.provenance.head,
    events: 0,
    assistantMessages: 0,
    foreignEvents: 0,
    toolNames: [],
    terminal: null,
    outcome: null,
  };
  try {
    await client.initialize({
      cwd: args.cwd,
      provider: runtime.provider,
      model: runtime.model,
      reasoningEffort: runtime.reasoningEffort,
      maxTokens: runtime.maxTokens ?? undefined,
    });
    await client.prompt({ sessionId, contentBlocks: [{ type: "text", text: args.prompt }] });

    let idle = false;
    let idleDeadline;
    while (!cancelled) {
      const notification = await client.nextNotification(30_000);
      if (notification === undefined) {
        if (!client.running) break;
        continue;
      }
      const method = notification.method;
      const params = notification.params ?? {};
      if (method === "session.event" && rawEvents && translator.owns(params.sessionId)) {
        rawEvents.push({ at: Date.now(), raw: params.event });
      }
      if (method === "session.event") {
        // The runtime delivers some session events twice (log mirror +
        // subscriber). `seq` is unique per session log, so drop repeats.
        const seq = params.event?.seq;
        if (translator.owns(params.sessionId) && seq !== undefined) {
          if (seenSeqs.has(seq)) continue;
          seenSeqs.add(seq);
        }
        translator.handleNotification(notification);
        if (translator.owns(params.sessionId)) {
          summary.events += 1;
          if (params.event?.type === "assistant/message") summary.assistantMessages += 1;
          if (params.event?.type === "tool/call") summary.toolNames.push(params.event.data?.name);
        }
      } else if (method === "session.status") {
        if (translator.owns(params.sessionId) && params.status === "idle") {
          idle = true;
          idleDeadline = Date.now() + 1_000;
        }
      } else if (method === "subagent.started") {
        translator.registerChild(params.parentSessionId, params.childSessionId);
      }
      if (translator.terminal !== undefined) break;
      if (idle && (translator.terminal !== undefined || Date.now() > idleDeadline)) break;
    }
    summary.foreignEvents = translator.foreignEvents;
    summary.terminal = translator.terminal?.kind ?? null;
    if (cancelled) return { ok: false, code: "cancelled" };
    summary.intermediateTexts = translator.drainIntermediateLines();
    const verdict = classifyTerminal({
      terminal: translator.terminal,
      finalText: translator.lastAssistantText,
      cap: COMPLETE_TASK_RESPONSE_MAX,
    });
    if (!verdict.ok) {
      summary.outcome = verdict.code;
      diagnostic(`${verdict.code}: ${verdict.diagnostic}`);
      return { ok: false, code: verdict.code };
    }
    const finalLine = translator.finalAnswerLine();
    if (finalLine === undefined) {
      summary.outcome = "empty_final_answer";
      diagnostic("empty_final_answer: completed turn produced no final assistant text");
      return { ok: false, code: "empty_final_answer" };
    }
    // Runner seat: the ONLY success path is the existing authoritative transport.
    if (args.seat === "runner") {
      await completeTask({ response: finalLine.item.text, data_points: [] });
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(transport.resultFile, "utf8"));
      } catch (error) {
        summary.outcome = "transport_rejected";
        diagnostic(`transport_rejected: transport file '${transport.resultFile}' could not be read: ${error.message}`);
        return { ok: false, code: "transport_rejected" };
      }
      const loaded = validateRunnerResultPayload(parsed, { id: transport.runnerId, resultFile: transport.resultFile });
      if (!loaded.ok) {
        summary.outcome = "transport_rejected";
        diagnostic(`transport_rejected: ${loaded.error}`);
        return { ok: false, code: "transport_rejected" };
      }
      summary.outcome = "completed";
      summary.completeTask = { ok: true, responseLength: finalLine.item.text.length, dataPoints: loaded.result.data_points.length };
    } else {
      summary.outcome = "completed";
    }
    emit(finalLine);
    return { ok: true };
  } finally {
    await client.stop();
    if (args.eventsFile) {
      try {
        writeFileSync(args.eventsFile, [...rawEvents, ...eventLog].map(entry => JSON.stringify(entry)).join("\n") + "\n");
      } catch (error) {
        diagnostic(`events write failed: ${error.message}`);
      }
    }
    if (args.summaryFile) {
      try {
        writeFileSync(args.summaryFile, `${JSON.stringify({ ...summary, cancelJournal: client.cancelJournal }, null, 2)}\n`);
      } catch (error) {
        diagnostic(`summary write failed: ${error.message}`);
      }
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = parseArgs(process.argv.slice(2));
  runOneTurn(args, process.env).then(
    (result) => process.exit(result.ok ? 0 : 1),
    (error) => {
      diagnostic(`${error.code ?? "adapter_error"}: ${error.message}`);
      process.exit(2);
    },
  ).catch((error) => {
    diagnostic(`fatal: ${error.message}`);
    process.exit(2);
  });
}
