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
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
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
import {
  COMMUNICATION_ROLE_PARAGRAPH,
  COMMUNICATION_TOOL_NAMES,
  bindAttemptReceiver,
  closeReceiverAdmission,
  parseCommunicationBinding,
  assertPiSessionId,
} from "../communication.mjs";
import { openChange } from "../change-record.mjs";
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
export function buildPiArgs({ seat, config, extension, tools, roleInstructions, sessionPath }) {
  if (!WORKER_SEATS.includes(seat)) throw new Error(`unknown worker seat '${seat}'`);
  const args = [
    "--mode", "rpc",
    "--provider", config.provider,
    "--model", config.model,
  ];
  if (config.reasoningEffort) args.push("--thinking", config.reasoningEffort);
  args.push(
    // One worker turn per process; the operator's session store is never used.
    // Production workers record the attempt's native session by default in the
    // dedicated private worker-session directory; an explicit absolute
    // QQ_WORKER_SESSION_DIR overrides that directory. A recording-disabled
    // launch passes --no-session exactly as before.
    ...(sessionPath ? ["--session", sessionPath] : ["--no-session"]),
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

/**
 * The dedicated private worker-session directory under the user's local state:
 * `$XDG_STATE_HOME/qq-workflows/worker-sessions`, defaulting to
 * `~/.local/state/qq-workflows/worker-sessions`. Stable across launches, never
 * inside a checkout, and per-user private.
 */
export function defaultNativeSessionDir(env = process.env) {
  const base = env.XDG_STATE_HOME && String(env.XDG_STATE_HOME).trim()
    ? String(env.XDG_STATE_HOME)
    : join(env.HOME && String(env.HOME).trim() ? String(env.HOME) : homedir(), ".local", "state");
  return join(base, "qq-workflows", "worker-sessions");
}

/**
 * Allocate the durable native session file for ONE attempt, plus the private
 * metadata sidecar that associates it with this attempt.
 *
 * Enabled by default for production workers (`production: true`): the session
 * is recorded under `defaultNativeSessionDir(env)`. An explicit absolute
 * `QQ_WORKER_SESSION_DIR` overrides that directory; unset (or blank) with a
 * non-production launch records nothing and returns null (the exact prior
 * `--no-session` behavior).
 *
 * The directory is created with mode 0700 (missing components only - an
 * existing directory is never chmodded) and then verified with lstat: it must
 * be a real directory (never a symlink or other non-regular entry), owned by
 * this user, and exactly owner-rwx (0700). Anything else is a refusal, never a
 * silent recording into an unsafe location and never a permission "repair" of
 * an unrelated path.
 *
 * The file itself is created exclusively (`wx`, 0o600) with a
 * timestamp+pid+random name, so no launch can resume, reuse, or collide with
 * another attempt's session, and the file's permissions never widen. A
 * collision retries with a fresh random name; an exclusive create can never
 * follow a preexisting symlink (O_EXCL fails it with EEXIST).
 *
 * Next to the session file a sidecar `<session>.meta.json` (exclusively
 * created, 0o600) durably records the per-attempt association: seat, cwd,
 * adapter pid, the available QQ runner identity (QQ_RUNNER_ID when bound, else
 * null) and the start time. It never contains the prompt, environment, or
 * credentials. If the sidecar cannot be written the just-created session file
 * is removed and the failure is thrown - a half-associated recording is never
 * left behind.
 */
export function resolveNativeSessionPath({
  env = process.env,
  seat,
  production = false,
  cwd = null,
  runnerId = null,
  now = new Date(),
  random = randomBytes,
  mkdir = mkdirSync,
  lstat = lstatSync,
  open = openSync,
  write = writeFileSync,
  close = closeSync,
  unlink = unlinkSync,
} = {}) {
  const override = env.QQ_WORKER_SESSION_DIR;
  const root = typeof override === "string" && override.trim() !== ""
    ? override
    : production
      ? defaultNativeSessionDir(env)
      : null;
  if (root === null) return null;
  if (!isAbsolute(root)) {
    throw Object.assign(new Error(`native_session_dir_invalid: native session trace dir '${root}' must be absolute`), { code: "native_session_dir_invalid" });
  }
  // Every directory-initialization problem is one named refusal: a raw mkdir
  // or lstat error (EEXIST on a non-directory leaf, EACCES, a vanished entry)
  // is reported as native_session_dir_invalid with its cause, never as a
  // silent fallback and never as an unnamed crash.
  try {
    mkdir(root, { recursive: true, mode: 0o700 });
    var dir = lstat(root);
  } catch (error) {
    throw Object.assign(new Error(`native_session_dir_invalid: native session trace dir '${root}' could not be initialized as a private directory: ${error?.message ?? error}`), { code: "native_session_dir_invalid" });
  }
  if (!dir.isDirectory() || dir.isSymbolicLink()) {
    throw Object.assign(new Error(`native_session_dir_invalid: native session trace dir '${root}' is not a real directory (symlink or other entry)`), { code: "native_session_dir_invalid" });
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null && dir.uid !== uid) {
    throw Object.assign(new Error(`native_session_dir_unsafe: native session trace dir '${root}' is not owned by this user (uid ${dir.uid} != ${uid})`), { code: "native_session_dir_unsafe" });
  }
  if ((dir.mode & 0o777) !== 0o700) {
    throw Object.assign(new Error(`native_session_dir_unsafe: native session trace dir '${root}' must be private (0700), got mode ${(dir.mode & 0o777).toString(8)}`), { code: "native_session_dir_unsafe" });
  }
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // A fresh random suffix is drawn per retry so a collision can never loop
    // on one name; the exclusive `wx` create is the actual collision guard.
    const path = join(root, `pi-${seat}-${stamp}-${process.pid}-${random(6).toString("hex")}.jsonl`);
    let fd;
    try {
      fd = open(path, "wx", 0o600);
    } catch (error) {
      if (error?.code === "EEXIST") continue; // never resume or reuse another attempt's file
      throw error;
    }
    close(fd);
    const metaPath = `${path}.meta.json`;
    try {
      write(metaPath, `${JSON.stringify({
        schema: "qq-worker-session-meta/1",
        sessionFile: path,
        seat,
        pid: process.pid,
        cwd: cwd ?? null,
        runnerId: runnerId ?? null,
        startedAt: now.toISOString(),
      }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      // Never leave a session file without its association: remove the
      // just-created file and refuse the launch with a clear failure.
      try { unlink(path); } catch { /* best effort */ }
      throw Object.assign(new Error(`native_session_meta_failed: could not write the native session metadata sidecar '${metaPath}': ${error?.message ?? error}`), { code: "native_session_meta_failed" });
    }
    return path;
  }
  throw Object.assign(new Error("native_session_collision: could not allocate a unique native session file after 5 attempts"), { code: "native_session_collision" });
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
    // Communication drain bookkeeping: how many agent runs started and settled.
    // An idle receiver injection starts a NEW run after a settle, so
    // `turnStarts > settles` means a turn is in flight and final-result
    // selection must wait for it (never report the earlier final message as the
    // outcome of the updated assignment).
    turnStarts: 0,
    settles: 0,
    activity: 0,
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
        case "agent_start": {
          state.turnStarts += 1;
          state.activity += 1;
          return;
        }
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
          state.activity += 1;
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
          state.settles += 1;
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

/**
 * Resolve the runner communication launch context. Absent binding -> disabled
 * (the exact prior behavior). A binding on a seat other than the runner, or a
 * structurally malformed binding, refuses before any process is spawned; a
 * binding whose record does not name the attempt (or names it in a phase that
 * cannot be started) refuses before any provider traffic.
 */
function resolveCommunicationLaunch({ seat, env }) {
  const parsed = parseCommunicationBinding(env);
  if (!parsed.enabled) return { enabled: false };
  if (seat !== "runner") {
    throw Object.assign(
      new Error(`a communication binding is only valid for the runner seat (got '${seat}'); refusing instead of partially enabling communication`),
      { code: "binding_invalid_seat" },
    );
  }
  const binding = parsed.binding;
  // Record-side preflight: the binding must name a real attempt that a launch
  // intent created and that has not already ended, so the observed session can
  // be bound against it before any delivery admission.
  let handle;
  try {
    handle = openChange({ stateDir: binding.stateDir, changeId: binding.changeId });
  } catch (error) {
    throw Object.assign(new Error(`communication binding record is unavailable: ${error.message}`), { code: "binding_record_unavailable" });
  }
  const attempt = handle.state.jobs[binding.jobId]?.attempts[binding.attemptId];
  if (!attempt) {
    throw Object.assign(
      new Error(`communication binding names attempt '${binding.attemptId}' on job '${binding.jobId}', which does not exist in change '${binding.changeId}'`),
      { code: "binding_attempt_unknown" },
    );
  }
  if (attempt.phase !== "launched" && attempt.phase !== "started") {
    throw Object.assign(
      new Error(`communication binding names attempt '${binding.attemptId}' in phase '${attempt.phase}'; only an unresolved launch intent (or a matching started attempt) can be bound`),
      { code: "binding_attempt_not_launchable" },
    );
  }
  return { enabled: true, binding };
}

/** Drain-loop cadence: how often the in-flight/exit state is re-evaluated. */
const DRAIN_POLL_MS = 100;

const drainSleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  if (typeof timer.unref === "function") timer.unref();
});

/**
 * Wait until the translator has observed `target` agent runs settle, the child
 * exits first, or an optional timeout elapses. The settle/exit race preserves
 * the exact pre-communication semantics (same 25ms poll, same exit precedence):
 * an exit before the run settled is still classified honestly downstream.
 */
function waitForSettle(client, translator, target, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    let poll = null;
    let timer = null;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    poll = setInterval(() => {
      if (translator.state.settles >= target) finish({ reason: "settled" });
    }, 25);
    if (typeof poll.unref === "function") poll.unref();
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish({ reason: "timeout" }), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    }
    if (translator.state.settles >= target) finish({ reason: "settled" });
    client.waitForExit().then((result) => finish({ reason: "exit", result }));
  });
}

/**
 * Bounded drain window after the admission closure: keep the runtime alive so
 * deliveries admitted BEFORE the closure can still land (the record-level
 * barrier is closed; the receiver keeps polling), while never letting a drain
 * turn mask the run's outcome.
 *
 * An idle injection that starts another agent run postpones final-result
 * selection: this loop waits until THAT run settles, so the classifier below
 * sees the post-update final message instead of the stale pre-injection one.
 * There is deliberately no quiet-based early exit: returning between "a
 * delivery was received" and "its agent_start became visible" would report the
 * stale final message as the outcome of the updated assignment.
 *
 * At the deadline a still-in-flight turn is refused honestly: the run's error
 * is set (classification fails, exit 1) rather than reporting the pre-injection
 * final message as success - a cut-off incorporation must never look complete.
 * The still-pending amendment stays pending in the record for the coordinator.
 */
async function drainReceiverWindow({ client, translator, drainMs }) {
  const started = Date.now();
  const settlesBefore = translator.state.settles;
  const report = (extra = {}) => ({
    reason: "deadline",
    ms: Date.now() - started,
    injectedTurns: translator.state.settles - settlesBefore,
    ...extra,
  });
  const exitReport = (result) => {
    // An exit while a drain-injected turn is in flight must not read as
    // success: the classifier would otherwise see the stale pre-injection
    // final message. Conservatively fail; the record stays honest.
    if (translator.state.turnStarts > translator.state.settles) {
      translator.state.error = {
        code: "runtime_exit",
        message: `the pi runtime ended (${result?.reason ?? "unknown"}) while a drain-injected turn was still in flight`,
      };
      return report({ reason: "exit", interruptedTurn: true });
    }
    return report({ reason: "exit" });
  };
  while (Date.now() - started < drainMs) {
    if (translator.state.turnStarts > translator.state.settles) {
      const remaining = Math.max(drainMs - (Date.now() - started), 1);
      await waitForSettle(client, translator, translator.state.settles + 1, { timeoutMs: remaining });
      continue;
    }
    const winner = await Promise.race([
      drainSleep(DRAIN_POLL_MS).then(() => null),
      client.waitForExit().then((result) => ({ result })),
    ]);
    if (winner) return exitReport(winner.result);
  }
  if (translator.state.turnStarts > translator.state.settles) {
    translator.state.error = {
      code: "drain_turn_interrupted",
      message: "the communication drain window ended while an injected turn was still in flight; refusing to report the pre-injection final message as the outcome",
    };
    return report({ interruptedTurn: true });
  }
  return report();
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
      // Recorded when the validated communication paragraph was appended.
      ...(instructions.communicationRoleParagraph === true ? { communicationRoleParagraph: true } : {}),
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
  // Runner communication is enabled ONLY by an explicit, structurally valid
  // binding, and only for the runner seat. Validation happens here, before any
  // process is spawned: a malformed binding is a refusal, never a partial
  // enable, and an absent binding preserves the exact prior behavior.
  const communication = resolveCommunicationLaunch({ seat: args.seat, env });
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

  const tools = communication.enabled
    ? [...workerPiAllowedTools(args.seat), ...COMMUNICATION_TOOL_NAMES]
    : workerPiAllowedTools(args.seat);
  // The instruction surface must describe THIS runtime: the shared contract is
  // adapted (no MCP completion tool, the ZG tool's real name) and a reference
  // that cannot resolve refuses the launch before any work starts. A validated
  // communication-enabled runner additionally carries the coordinator-authored
  // communication paragraph, verbatim.
  const seatInstructions = loadPiSeatInstructions(args.seat, { tools });
  const instructions = communication.enabled
    ? {
      ...seatInstructions,
      body: `${seatInstructions.body}\n\n${COMMUNICATION_ROLE_PARAGRAPH}`,
      communicationRoleParagraph: true,
    }
    : seatInstructions;
  const extension = WORKER_PI_EXTENSION;
  const sessionPath = resolveNativeSessionPath({
    env,
    seat: args.seat,
    production: args.production === true,
    cwd: args.cwd,
    runnerId: typeof env.QQ_RUNNER_ID === "string" && env.QQ_RUNNER_ID.trim() !== "" ? env.QQ_RUNNER_ID : null,
  });
  if (sessionPath) diagnostic(`native session file: ${sessionPath}`);
  const piArgs = buildPiArgs({ seat: args.seat, config, extension, tools, roleInstructions: instructions.body, sessionPath });
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
  if (sessionPath) summary.sessionFile = sessionPath;
  summary.effectiveSettings = effective;
  summary.communication = communication.enabled
    ? {
      enabled: true,
      changeId: communication.binding.changeId,
      jobId: communication.binding.jobId,
      attemptId: communication.binding.attemptId,
      role: communication.binding.role,
      recipientAgent: communication.binding.recipientAgent,
      drainMs: communication.binding.drainMs,
    }
    : { enabled: false };

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
    if (communication.enabled) {
      // The observed runtime session is the ONLY receiver identity: a bare Pi
      // session UUID, bound against the exact started attempt in the change
      // record BEFORE any delivery admission. A non-UUID session id, an unknown
      // attempt, or a mismatched recorded binding refuses here — before the
      // prompt, before inference, never partially enabled.
      assertPiSessionId(initState?.sessionId, "the runtime's observed session id");
      const bound = bindAttemptReceiver({
        stateDir: communication.binding.stateDir,
        changeId: communication.binding.changeId,
        jobId: communication.binding.jobId,
        attemptId: communication.binding.attemptId,
        sessionId: initState.sessionId,
        seat: args.seat,
        runtimeActorId: communication.binding.runtimeActorId,
      });
      summary.communication.bound = { recorded: bound.recorded, dedupe: bound.dedupe, seq: bound.seq, recipient: bound.identity.recipient };
      diagnostic(`communication bound: ${communication.binding.changeId}/${communication.binding.jobId}/${communication.binding.attemptId} -> agents/${initState.sessionId}`);
    }
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
    const firstSettle = await waitForSettle(client, translator, 1, { timeoutMs: 0 });
    if (firstSettle.reason === "exit" && !translator.state.settled && !translator.state.error) {
      translator.state.error = { code: "runtime_exit", message: `the pi runtime ended (${firstSettle.result?.reason ?? "unknown"}) before the run settled` };
    }

    // Communication settle/drain/close handshake (enabled runners only): the
    // admission closure is durable and serialized with amendment submissions in
    // the change record; the bounded drain window then lets already-admitted
    // deliveries land. An idle injection that starts another turn postpones
    // final-result selection until that turn settles — the earlier final
    // message is never reported as the outcome of the updated assignment.
    if (communication.enabled && firstSettle.reason === "settled") {
      try {
        const closed = closeReceiverAdmission({
          stateDir: communication.binding.stateDir,
          changeId: communication.binding.changeId,
          jobId: communication.binding.jobId,
          attemptId: communication.binding.attemptId,
          runtimeActorId: communication.binding.runtimeActorId,
        });
        summary.communication.admissionClosed = { seq: closed.seq, dedupe: closed.dedupe };
      } catch (error) {
        // Bookkeeping failure is reported honestly; it never fabricates a
        // delivery and never promotes unacknowledged work.
        summary.communication.admissionClosed = { error: String(error?.message ?? error).slice(0, 200) };
        diagnostic(`admission closure failed: ${error?.message ?? error}`);
      }
      summary.communication.drain = await drainReceiverWindow({ client, translator, drainMs: communication.binding.drainMs });
    } else if (communication.enabled) {
      summary.communication.drain = { skipped: true, reason: firstSettle.reason };
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
