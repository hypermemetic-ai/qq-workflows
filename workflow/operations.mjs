// Transport-independent workflow operations.
//
// Every operation takes an explicit workflow identity (stable session key), an
// explicit repository root, and an explicit notification transport. The native
// pi Architect drives these operations directly; the MCP server keeps its own
// compatibility adapter over the same durable state, report store, and worker
// result contract.

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  appendJobEvent,
  createJob,
  deliveryPending,
  jobSummary,
  listJobs,
  processFingerprint,
  readJob,
  reconcileAll,
  reconcileJob,
  recordCancellation,
  recordTerminal,
  RUNNING,
  TERMINAL_STATUSES,
  writeJob,
} from "./jobs.mjs";
import { acknowledgeDelivery, defaultCompletionText, deliverCompletion, readNotification, recoverPendingDeliveries } from "./notify.mjs";
import { readReport, saveReport } from "./reports.mjs";
import { acceptRunnerResult, cleanupRunnerFiles, renderRunnerFindings } from "./results.mjs";
import { ensureAssociation, resolveSessionKey, stateDirFor } from "./session.mjs";
import { extractSection, listSections, loadPackagedTemplate, replaceSection, ticketPath } from "./ticket.mjs";
import { planFingerprint, planToSpawn, resolveWorkerLaunchPlan } from "./worker-launch.mjs";

// Native tool surface for the Architect. Local inspection stays read-only
// (read/grep/find/ls); workflow capabilities are scoped ticket updates and
// managed delegation. No shell, no editor/write tool, and no direct
// land/branch mutation that would bypass the managed pipeline.
export const WORKFLOW_TOOL_NAMES = [
  "read_ticket",
  "update_ticket",
  "dispatch_runner",
  "check_runner",
  "steer_runner",
  "cancel_runner",
  "read_report",
  "list_jobs",
  "recover_deliveries",
  "dispatch_execution",
  "check_execution",
];

export const WORKFLOW_TOOLS = [
  {
    name: "read_ticket",
    label: "Read ticket",
    description: "Read the workflow ticket for this session, list its sections, or read one section.",
    parameters: {
      type: "object",
      properties: {
        section: { type: "string", description: "Optional section heading to read." },
        sectionsOnly: { type: "boolean", description: "Return only the section headings." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "update_ticket",
    label: "Update ticket",
    description: "Update the workflow ticket: replace the whole file or one named section.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Replacement markdown content." },
        section: { type: "string", description: "Optional section heading to replace." },
      },
      required: ["content"],
      additionalProperties: false,
    },
  },
  {
    name: "dispatch_runner",
    label: "Dispatch runner",
    description:
      "Delegate research, inspection, reproduction, or diagnostics to a runner worker and return its durable job id. The runner investigates and reports; implementation and landing stay with the managed pipeline.",
    parameters: {
      type: "object",
      properties: {
        task: { type: "string", description: "What the runner must find out." },
        targetPaths: { type: "array", items: { type: "string" }, description: "Optional paths to inspect." },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "check_runner",
    label: "Check runner",
    description: "Point-in-time status of a runner job, including its report reference.",
    parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false },
  },
  {
    name: "steer_runner",
    label: "Steer runner",
    description: "Send an additional instruction to a running runner without restarting it.",
    parameters: {
      type: "object",
      properties: { jobId: { type: "string" }, message: { type: "string" } },
      required: ["jobId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_runner",
    label: "Cancel runner",
    description: "Cancel a runner job. Cancellation is tombstoned so recovery can never restart it.",
    parameters: {
      type: "object",
      properties: { jobId: { type: "string" }, reason: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "dispatch_execution",
    label: "Dispatch execution",
    description:
      "Delegate the approved ticket to the managed execution pipeline (worktree, implementer, reviewer, landing). Only call this after the operator approves the ticket.",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", description: "'bounded' or 'open'." },
        phaseId: { type: "string", description: "Approved phase ticket identity; defaults to this coordinator. Notifications remain owned by this session." },
        baseRef: { type: "string", description: "Explicit Git base for a new worktree; for a preserved worktree, it must be an ancestor of its HEAD." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  {
    name: "check_execution",
    label: "Check execution",
    description: "Point-in-time status of a managed execution, including its phase and report reference.",
    parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false },
  },
  {
    name: "read_report",
    label: "Read report",
    description:
      "Read a persisted terminal report in bounded chunks. Continue with nextOffset; complete=true means the whole report was returned.",
    parameters: {
      type: "object",
      properties: {
        reportId: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
      required: ["reportId"],
      additionalProperties: false,
    },
  },
  {
    name: "list_jobs",
    label: "List jobs",
    description:
      "List durable runner/execution jobs for this workflow session, including interrupted, undelivered, and reconciliation-required ones.",
    parameters: {
      type: "object",
      properties: {
        role: { type: "string" },
        scope: { type: "string", description: "'session' (default) or 'all'." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "recover_deliveries",
    label: "Recover deliveries",
    description:
      "Reconcile durable job records with live processes and replay completion notifications that were never delivered to this session.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
];

export function isWorkflowTool(name) {
  return WORKFLOW_TOOL_NAMES.includes(name);
}

function clamp(text, max) {
  const value = typeof text === "string" ? text : text == null ? "" : String(text);
  return value.length <= max ? value : `${value.slice(0, max)}… [${value.length - max} chars omitted]`;
}

// Interpret the worker's stream-json line protocol: liveness, active tool, and
// complete_task detection. Unknown lines are liveness only.
export function interpretRunnerEvent(event) {
  const out = { activeTool: undefined, completeTask: false, step: null };
  const stepUpdate = event?.step_update;
  if (stepUpdate && typeof stepUpdate === "object") {
    if (stepUpdate.step_type === "tool") {
      const name = stepUpdate.tool_name || stepUpdate.tool || stepUpdate.name || "tool";
      out.activeTool = stepUpdate.state === "ACTIVE" ? { name, startedAt: Date.now() } : null;
      out.step = { action: "tool", target: name };
    } else if (stepUpdate.step_type) {
      out.step = { action: stepUpdate.step_type, target: clamp(stepUpdate.text ?? "", 200) || null };
    }
  }
  const toolName = event?.tool_name || event?.tool || event?.toolCall?.name;
  if (typeof toolName === "string" && toolName.includes("complete_task")) out.completeTask = true;
  return out;
}

export function createWorkflow({
  root,
  sessionKey = null,
  env = process.env,
  spawnFn = nodeSpawn,
  notifierTransport = null,
  now = () => Date.now(),
  registry = new Map(),
  executionLauncher = null,
} = {}) {
  if (!root) throw new Error("repository root is required");
  const stateDir = stateDirFor(root, env);
  const live = new Map(); // jobId -> { child, outputTail, activeTool, trajectory, stderr }

  function session() {
    const key = resolveSessionKey({ explicit: sessionKey, env });
    if (!key) {
      throw new Error(
        "no workflow session identity: pass a session key or set QQ_WORKFLOW_SESSION_ID (the Architect binds it from the Paseo agent ID)",
      );
    }
    return ensureAssociation({
      stateDir,
      key,
      root,
      ownerAgentId: env?.QQ_ARCHITECT_OWNER_AGENT_ID ?? env?.PASEO_AGENT_ID ?? null,
      now: now(),
    });
  }

  function requireJob(jobId) {
    if (!jobId) throw new Error("jobId is required");
    const record = readJob(stateDir, jobId);
    if (!record) throw new Error(`unknown job '${jobId}'`);
    const association = session();
    if (record.workflow?.sessionKey !== association.sessionKey) {
      throw new Error(`job '${jobId}' belongs to another workflow session; refusing to operate on it`);
    }
    return record;
  }

  // Persist the complete report + terminal outcome BEFORE notifying, then hand a
  // bounded summary to the transport. A failed delivery leaves the record
  // inspectable and retryable; the report is never the thing that gets dropped.
  async function finishJob(record, { status, findings = "", error = null, phase = null, report = null }) {
    const summary = error ? `${error.message}${error.stderr ? `\n${clamp(error.stderr, 500)}` : ""}` : clamp(findings, 2000);
    // A report produced earlier in the pipeline (e.g. an over-cap complete_task
    // response spilled verbatim by the ingestion path) is authoritative: keep
    // pointing at it instead of saving a shortened copy.
    // Failure diagnostics are persisted with the same weight as success
    // findings: a failed job must stay diagnosable after a restart.
    const durableText = findings || (error ? `# terminal failure diagnostics\n\n${JSON.stringify(error, null, 2)}` : "");
    const saved = report
      ? { reportId: report.reportId, chars: report.chars }
      : durableText
        ? saveReport(stateDir, { jobId: record.id, role: record.role, text: durableText, now: now() })
        : null;
    const settled = recordTerminal(stateDir, record.id, {
      status,
      summary,
      reportId: saved?.reportId ?? null,
      reportChars: saved?.chars ?? 0,
      error,
      phase,
      now: now(),
    });
    let delivery = null;
    if (status !== "cancelled" && notifierTransport) {
      delivery = await deliverCompletion({
        stateDir,
        job: settled,
        transport: notifierTransport,
        text: completionText(settled),
        reportText: findings || summary,
        now: now(),
      });
    }
    // Report the final record so a caller sees the delivery state that was
    // actually achieved, not the state before delivery.
    const finalRecord = readJob(stateDir, record.id) ?? settled;
    return { record: finalRecord, delivery };
  }

  function completionText(record) {
    return defaultCompletionText(record);
  }

  function jobsView({ role = null, scope = "session" } = {}) {
    const association = session();
    return listJobs(stateDir, { sessionKey: scope === "all" ? null : association.sessionKey, role }).map(jobSummary);
  }

  // ------------------------------------------------------------------ tickets
  async function readTicketOp({ section, sectionsOnly } = {}) {
    const association = session();
    const path = ticketPath(root, association.sessionId);
    let content;
    try {
      content = readFileSync(path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") {
        return { ok: false, error: `no ticket at ${path}`, path, sessionId: association.sessionId, sessionKey: association.sessionKey };
      }
      throw err;
    }
    const sections = listSections(content);
    if (sectionsOnly) return { ok: true, sessionId: association.sessionId, path, sections };
    if (section) {
      const selected = extractSection(content, section);
      if (selected === null) {
        return {
          ok: false,
          sessionId: association.sessionId,
          path,
          section,
          error: `Section '${section}' not found in ticket. Available sections: ${sections.join(", ")}`,
          sections,
        };
      }
      return { ok: true, sessionId: association.sessionId, path, section, content: selected, sections };
    }
    return { ok: true, sessionId: association.sessionId, path, content, sections };
  }

  async function updateTicketOp({ content, section } = {}) {
    if (typeof content !== "string") throw new Error("content is required and must be a string");
    const association = session();
    const path = ticketPath(root, association.sessionId);
    let next = content;
    if (section) {
      let current;
      try {
        current = readFileSync(path, "utf8");
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
        try {
          current = readFileSync(join(root, ".architect", "template.md"), "utf8");
        } catch {
          current = await loadPackagedTemplate();
        }
      }
      next = replaceSection(current, section, content);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next, "utf8");
    return { ok: true, sessionId: association.sessionId, sessionKey: association.sessionKey, path, ...(section ? { section } : {}) };
  }

  // ------------------------------------------------------------------ runners
  function dispatchRunnerOp({ task, targetPaths = [], cwd = root, plan = undefined } = {}) {
    if (typeof task !== "string" || !task.trim()) throw new Error("task is required");
    const association = session();
    const id = randomUUID();
    const resultFile = join(stateDir, "runner-results", `${id}.json`);
    mkdirSync(dirname(resultFile), { recursive: true, mode: 0o700 });
    const reportFile = join(tmpdir(), `qq-runner-report-${id}.md`);
    try {
      rmSync(resultFile, { force: true });
      rmSync(reportFile, { force: true });
    } catch {}

    const launchPlan = plan ?? resolveWorkerLaunchPlan({ role: "runner", env });
    const record = createJob({
      stateDir,
      id,
      role: "runner",
      workflow: {
        sessionKey: association.sessionKey,
        sessionId: association.sessionId,
        ownerAgentId: association.ownerAgentId,
        root,
      },
      cwd,
      task,
      launchPlan: { ...launchPlan, fingerprint: planFingerprint(launchPlan) },
      now: now(),
    });

    let prompt = task;
    if (Array.isArray(targetPaths) && targetPaths.length > 0) {
      prompt += `\n\nTarget paths to inspect:\n${targetPaths.join("\n")}`;
    }
    // The runner's bound identity and result transport are the caller's, and
    // they reach the worker only through the central launch contract: the
    // configured harness owns how its seat receives them. The target project is
    // the working directory (`cwd`) and nothing else.
    let launched;
    try {
      launched = planToSpawn(launchPlan, {
        prompt,
        env,
        cwd,
        mcpEnv: { QQ_RUNNER_ID: id, QQ_RUNNER_RESULT_FILE: resultFile },
      });
    } catch (err) {
      void finishJob(record, { status: "failed", error: { message: `runner launch rejected: ${err.message}` } });
      return { ok: false, jobId: id, status: "failed", error: err.message, launchPlan: record.launchPlan };
    }

    const runner = { id, runnerId: id, sessionId: association.sessionId, sessionKey: association.sessionKey, resultFile, reportFile, cwd, status: RUNNING };

    let child;
    try {
      child = spawnFn(launched.command, launched.args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: launched.env,
      });
    } catch (err) {
      void finishJob(record, { status: "failed", error: { message: `runner spawn failed: ${err.message}` } });
      return { ok: false, jobId: id, status: "failed", error: err.message, launchPlan: record.launchPlan };
    }

    const liveState = { child, outputTail: "", activeTool: null, trajectory: [], stderr: "" };
    live.set(id, liveState);
    const pid = child.pid ?? null;
    const current = readJob(stateDir, id);
    writeJob(stateDir, {
      ...current,
      resultFile,
      process: { pid, spawnedAt: now(), fingerprint: processFingerprint({ pid }) },
      launchPlan: record.launchPlan,
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      rl.on("line", (line) => {
        if (!line.trim()) return;
        liveState.outputTail = clamp(`${liveState.outputTail}${line}\n`, 4000);
        try {
          const interpreted = interpretRunnerEvent(JSON.parse(line));
          if (interpreted.step) liveState.trajectory = [...liveState.trajectory.slice(-8), { at: now(), ...interpreted.step }];
          if (interpreted.activeTool !== undefined) liveState.activeTool = interpreted.activeTool;
          const current = readJob(stateDir, id);
          liveState.lastObservedAt = now();
          if (current && !current.terminal) writeJob(stateDir, { ...current,
            telemetry: { lastObservedAt: now(), activeTool: liveState.activeTool,
              trajectory: liveState.trajectory }, updatedAt: now() });
          if (interpreted.completeTask) liveState.completeTaskSeen = true;
        } catch {
          /* non-JSON progress lines are liveness only */
        }
      });
    }
    child.stderr?.on("data", (chunk) => {
      liveState.stderr = `${liveState.stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("error", (err) => {
      void finishJob(readJob(stateDir, id) ?? record, {
        status: "failed",
        error: { message: `runner process error: ${err.message}` },
      });
    });
    child.on("close", (code, signal) => {
      const finished = readJob(stateDir, id);
      if (!finished || finished.terminal) {
        cleanupRunnerFiles(runner);
        live.delete(id);
        return;
      }
      // The authoritative transport wins over the exit signal: a complete_task
      // result that arrived before termination is a completed run.
      const authoritative = acceptRunnerResult(runner, {
        registry,
        stateDir,
        saveReport: (dir, options) => saveReport(dir, options),
      });
      if (authoritative.ok) {
        const findings = renderRunnerFindings(authoritative.result);
        const withReport = authoritative.report
          ? `${findings}\n\n[complete findings spilled to durable report '${authoritative.report.reportId}' (${authoritative.report.chars} chars): the worker result exceeded the transport cap]`
          : findings;
        cleanupRunnerFiles(runner);
        live.delete(id);
        void finishJob(finished, { status: "completed", findings: withReport, report: authoritative.report ?? null });
        return;
      }
      if (finished.cancellation) {
        cleanupRunnerFiles(runner);
        live.delete(id);
        return;
      }
      cleanupRunnerFiles(runner);
      live.delete(id);
      void finishJob(finished, {
        status: "failed",
        error: {
          message:
            code === 0
              ? `runner exited 0 without an authoritative complete_task result: ${authoritative.error}`
              : `runner process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
          ...(liveState.stderr.trim() ? { stderr: clamp(liveState.stderr.trim(), 1000) } : {}),
        },
      });
    });

    return {
      ok: true,
      jobId: id,
      runnerId: id,
      status: RUNNING,
      sessionKey: association.sessionKey,
      launchPlan: record.launchPlan,
      pid,
    };
  }

  function checkRunnerOp({ jobId } = {}) {
    let record = requireJob(jobId);
    const state = live.get(jobId) ?? null;
    // Live child callbacks own settlement until exit. Recovered handles have no
    // callback, so inspect the result transport and process on every read.
    if (!state && record.role === "runner") record = reconcileJob(stateDir, jobId) ?? record;
    const telemetry = state ?? record.telemetry ?? null;
    const lastObservedAt = telemetry?.lastObservedAt ?? null;
    return {
      ...jobSummary(record),
      jobId: record.id,
      telemetry: { source: state ? "live" : record.telemetry ? "durable" : "unavailable",
        state: record.terminal ? "terminal" : !lastObservedAt ? "unavailable"
          : now() - lastObservedAt > 30_000 ? "stale" : telemetry?.activeTool ? "active" : "idle",
        lastObservedAt, observedAt: now(), idleMeaning: "no tool currently observed; model activity may continue" },
      activeTool: telemetry?.activeTool ?? null,
      trajectory: telemetry?.trajectory ?? [],
      outputTail: state?.outputTail ? clamp(state.outputTail, 2000) : null,
      reportHint: record.terminal?.reportId
        ? `Full report '${record.terminal.reportId}' (${record.terminal.reportChars} chars) via read_report.`
        : null,
    };
  }

  function steerRunnerOp({ jobId, message } = {}) {
    const record = requireJob(jobId);
    if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
    const state = live.get(jobId) ?? null;
    if (record.status !== RUNNING || !state?.child?.stdin) {
      return { ok: false, jobId, status: record.status, error: "runner is not running; nothing to steer" };
    }
    state.child.stdin.write(`${message.trim()}\n`);
    appendJobEvent(stateDir, jobId, { action: "steer", message: clamp(message.trim(), 400) }, { now: now() });
    return { ok: true, jobId, status: RUNNING, delivered: true };
  }

  function cancelRunnerOp({ jobId, reason = "cancelled by architect" } = {}) {
    const record = requireJob(jobId);
    if (TERMINAL_STATUSES.includes(record.status)) {
      return { ok: true, jobId, status: record.status, note: "already terminal" };
    }
    const cancelled = recordCancellation(stateDir, jobId, { by: session().sessionKey, reason, now: now() });
    const state = live.get(jobId) ?? null;
    const recordedFingerprint = cancelled.process?.fingerprint ?? null;
    const pid = cancelled.process?.pid ?? null;
    const livePrint = pid ? processFingerprint({ pid }) : null;
    const owned =
      Boolean(livePrint && recordedFingerprint) &&
      livePrint.startTicks === recordedFingerprint.startTicks &&
      livePrint.cmdlineHash === recordedFingerprint.cmdlineHash;
    let signalled = false;
    if (state?.child && typeof state.child.kill === "function") {
      try {
        state.child.kill("SIGTERM");
        signalled = true;
      } catch {}
    } else if (pid && owned) {
      try {
        process.kill(pid, "SIGTERM");
        signalled = true;
      } catch {}
    }
    return {
      ok: true,
      jobId,
      status: "cancelled",
      signalled,
      tombstoned: true,
      note: signalled
        ? "cancellation recorded and the owned process was signalled"
        : "cancellation recorded; no owned live process was signalled (pid mismatch, already gone, or no live handle after restart)",
    };
  }

  // --------------------------------------------------------------- executions
  // Implementations go through the managed pipeline. This layer owns the durable
  // execution record (identity, kind, phase, cancellation, terminal result) and
  // never exposes a direct land/branch mutation path: without the managed
  // launcher the tool reports that truthfully instead of doing something else.
  function dispatchExecutionOp({ kind, phaseId = null, baseRef = undefined, cwd = root, plan = undefined } = {}) {
    if (!kind || (kind !== "bounded" && kind !== "open")) {
      throw new Error("kind is required: 'bounded' | 'open'");
    }
    if (typeof executionLauncher !== "function") {
      return {
        ok: false,
        error:
          "the managed execution pipeline is not configured for this profile; implementation must run through it, and no direct mutation path is exposed",
      };
    }
    const association = session();
    const targetPhase = phaseId ?? association.sessionId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetPhase)) throw new Error("phaseId must be a ticket UUID");
    const id = randomUUID();
    const record = createJob({
      stateDir,
      id,
      role: "execution",
      kind,
      workflow: {
        sessionKey: association.sessionKey,
        sessionId: association.sessionId,
        ownerAgentId: association.ownerAgentId,
        root,
      },
      cwd,
      task: `managed execution (${kind})`,
      launchPlan: plan ?? null,
      now: now(),
    });
    writeJob(stateDir, { ...record, phaseId: targetPhase, baseRef: baseRef ?? null });
    live.set(id, { execution: true, phase: record.phase });
    void (async () => {
      try {
        const result = await executionLauncher({
          kind,
          cwd,
          jobId: id,
          sessionId: association.sessionId,
          phaseId: targetPhase,
          baseRef,
          workflow: association,
          onPhase: (phase, detail = null) => {
            const current = readJob(stateDir, id);
            if (!current || current.terminal) return;
            writeJob(stateDir, { ...current, phase: phase ?? current.phase, updatedAt: now() });
            appendJobEvent(stateDir, id, { action: "phase", phase: phase ?? null, detail: detail ? clamp(String(detail), 200) : null }, { now: now() });
            const state = live.get(id);
            if (state) state.phase = phase ?? state.phase;
          },
        });
        const current = readJob(stateDir, id);
        if (!current || current.terminal) return;
        const failed = result?.ok === false || result?.status === "failed" || result?.status === "cancelled";
        const findings = typeof result === "string" ? result : JSON.stringify(result ?? {}, null, 2);
        void finishJob(current, {
          status: failed ? (result?.status === "cancelled" ? "cancelled" : "failed") : "completed",
          findings,
          phase: result?.phase ?? "completed",
          error: failed
            ? { message: result?.error?.message ?? `managed execution ${result?.status ?? "failed"}`, phase: result?.error?.phase ?? null }
            : null,
        });
      } catch (err) {
        const current = readJob(stateDir, id);
        if (!current || current.terminal) return;
        void finishJob(current, {
          status: "failed",
          phase: current.phase,
          error: { message: err?.message || String(err), phase: current.phase },
        });
      }
    })();
    return { ok: true, jobId: id, executionId: id, status: RUNNING, kind, phaseId: targetPhase, sessionKey: association.sessionKey };
  }

  function checkExecutionOp({ jobId } = {}) {
    const record = requireJob(jobId);
    if (record.role !== "execution") throw new Error(`job '${jobId}' is not a managed execution`);
    return checkRunnerOp({ jobId });
  }

  function readReportOp({ reportId, offset = 0, limit } = {}) {
    return readReport(stateDir, reportId, { offset, ...(limit ? { limit } : {}) });
  }

  function reconcileOp() {
    return { jobs: reconcileAll(stateDir).map(jobSummary) };
  }

  async function recoverDeliveriesOp({ transport = notifierTransport, evidence = null, allowUnverified = false } = {}) {
    const association = session();
    const jobs = listJobs(stateDir, { sessionKey: association.sessionKey }).map((record) =>
      live.has(record.id) ? record : reconcileJob(stateDir, record.id)).map(jobSummary);
    const delivery = await recoverPendingDeliveries({
      stateDir,
      sessionKey: association.sessionKey,
      transport,
      now: now(),
      evidence,
      allowUnverified,
    });
    return {
      ok: true,
      sessionKey: association.sessionKey,
      jobs,
      delivery,
      pendingDelivery: jobs.filter((job) => job.terminal && !job.delivery).map((job) => job.id),
      awaitingExplicitRetry: jobs.filter((job) => deliveryPending(stateDir, job.id)).map((job) => job.id),
      reconciled: delivery.reconciled.map((entry) => entry.jobId),
      deferred: delivery.deferred.map((entry) => entry.jobId),
      uncertain: delivery.uncertain.map((entry) => entry.jobId),
      // Events whose durable records could not be written (or read) at all. They
      // are neither delivered nor replayed: `delivery.errors` names the exact
      // reason, and the next pass retries the reconciliation.
      unreconciled: delivery.errors.map((entry) => entry.jobId),
      note:
        "recovery replays completion notifications only for this session and never restarts work: an event the session already retained is acknowledged from its receipt (or, for a completion a previous release steered without the identity metadata, from an exact unique content correspondence) instead of being resent, a receipt whose journal record was lost or corrupted is rebuilt from the owner-bound job record first, an event whose receipt cannot be proven is retained as outcome-unknown (an explicit /qq_recover retries it), an event whose records could not be written is reported as unreconciled rather than delivered, and interrupted or reconciliation-required jobs stay inspectable for an explicit decision",
    };
  }

  // Durable receipt path for the pi transport: consumption of the exact event is
  // observed in the owning session, so the completion is acknowledged instead of
  // being left queued (and instead of being sent twice). Ownership is checked
  // first: a receipt from another session is refused.
  function acknowledgeDeliveryOp({ eventId, jobId = null, receipt = null } = {}) {
    if (!eventId) throw new Error("eventId is required");
    const association = session();
    let targetJob = jobId;
    if (!targetJob) {
      const notification = readNotification(stateDir, eventId);
      targetJob = notification?.jobId ?? null;
    }
    if (targetJob) {
      const record = readJob(stateDir, targetJob);
      if (!record) throw new Error(`unknown job '${targetJob}'`);
      if (record.workflow?.sessionKey !== association.sessionKey) {
        return { ok: false, acknowledged: false, eventId, jobId: targetJob, error: "job belongs to another workflow session; refusing to acknowledge it" };
      }
    }
    return acknowledgeDelivery({ stateDir, eventId, jobId: targetJob, receipt, now: now() });
  }

  async function callTool(name, args = {}) {
    switch (name) {
      case "read_ticket":
        return readTicketOp(args ?? {});
      case "update_ticket":
        return updateTicketOp(args ?? {});
      case "dispatch_runner":
        return dispatchRunnerOp(args ?? {});
      case "check_runner":
        return checkRunnerOp(args ?? {});
      case "steer_runner":
        return steerRunnerOp(args ?? {});
      case "cancel_runner":
        return cancelRunnerOp(args ?? {});
      case "read_report":
        return readReportOp(args ?? {});
      case "dispatch_execution":
        return dispatchExecutionOp(args ?? {});
      case "check_execution":
        return checkExecutionOp(args ?? {});
      case "list_jobs":
        return { jobs: jobsView({ role: args?.role ?? null, scope: args?.scope === "all" ? "all" : "session" }) };
      case "recover_deliveries":
        return recoverDeliveriesOp({});
      default:
        throw new Error(`unknown workflow tool '${name}'`);
    }
  }

  return {
    root,
    stateDir,
    session,
    jobsView,
    reconcile: reconcileOp,
    recoverDeliveries: recoverDeliveriesOp,
    acknowledgeDelivery: acknowledgeDeliveryOp,
    callTool,
    readTicket: readTicketOp,
    updateTicket: updateTicketOp,
    dispatchRunner: dispatchRunnerOp,
    checkRunner: checkRunnerOp,
    steerRunner: steerRunnerOp,
    cancelRunner: cancelRunnerOp,
    readReport: readReportOp,
    dispatchExecution: dispatchExecutionOp,
    checkExecution: checkExecutionOp,
    _live: live,
  };
}
