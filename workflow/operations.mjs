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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  reconcileJob,
  recordCancellation,
  recordTerminal,
  RUNNING,
  TERMINAL_STATUSES,
  updateRunningJob,
  writeJob,
} from "./jobs.mjs";
import { reconcileManagedExecution, readLaunchMetadata, reconstructOwnedExecutions, pendingRoleProgress, forwardRoleProgress } from "./execution-authority.mjs";
import {changeRecordPath,openChange,viewsFor} from "./change-record.mjs";
import { cancelExecutionHost } from "./execution-supervisor.mjs";
import {steerManagedRoleCommunication} from "./execution-communication.mjs";
import {recoverRunnerProgress} from "./runner-lifecycle.mjs";
import { acknowledgeDelivery, defaultCompletionText, deliverCompletion, readNotification, recoverPendingDeliveries } from "./notify.mjs";
import { readReport, saveReport } from "./reports.mjs";
import { acceptRunnerResult, cleanupRunnerFiles, renderRunnerFindings } from "./results.mjs";
import { COMMUNICATION_BINDING_ENV } from "./communication.mjs";
import {
  acquireRelayRuntime,
  acquireRunnerConsumer,
  prepareRunnerCommunication,
  reconcileRunnerJob,
  recordRunnerCancelIntent,
  recordRunnerOutcome,
  releaseAllRunnerConsumers,
  retryPendingRunnerAmendments,
  runnerCommunicationView,
  steerRunnerLifecycle,
} from "./runner-lifecycle.mjs";
import { ensureAssociation, resolveSessionKey, stateDirFor } from "./session.mjs";
import { extractSection, listSections, loadPackagedTemplate, replaceSection, ticketPath } from "./ticket.mjs";
import { PI_HARNESS, planFingerprint, planToSpawn, resolveWorkerLaunchPlan } from "./worker-launch.mjs";

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
  "steer_execution",
  "cancel_execution",
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
    description: "Delegate research, inspection, reproduction, or diagnostics to a runner. Returns a job ID for tracking. Communication-enabled runners can receive assignment updates and push progress; completion arrives through the existing notification path.",
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
    description: "Read a runner's current status, assignment revision, pending updates, and report reference. Transport receipt and worker acknowledgement are separate; neither proves the requested outcome succeeded. This tool does not return the full findings.",
    parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false },
  },
  {
    name: "steer_runner",
    label: "Steer runner",
    description: "Submit an additional instruction to a runner as an assignment update. The result distinguishes recording, transport receipt, and worker acknowledgement. Pending or refused delivery does not mean the worker incorporated the update.",
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
    description: "Record cancellation intent and stop the owned runner process. Cancellation prevents later output from becoming a successful outcome and does not automatically restart the runner.",
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
    description:
      "Point-in-time status of a managed execution: its phase and report references plus bounded role/job/attempt/revision/update/report state rebuilt from the authoritative change record. Update states stay distinct — submitted (recorded), transport-received (the attempt's receiver accepted delivery), worker-acknowledged (incorporated), fulfilled (an acknowledged update covered by a successful result). The outcome is reported known or unknown; a disappeared execution is never a known failed outcome.",
    parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false },
  },
  {
    name: "steer_execution",
    label: "Steer execution",
    description:
      "Submit an additional instruction as an assignment update to the exact currently intended active implementer/reviewer attempt of a managed execution. The target is bound before submission; a phase or attempt change races to a truthful refusal and is never silently retargeted. The response reports the update as recorded (submitted); transport-received, worker-acknowledged and fulfilled are later separate facts reported by check_execution.",
    parameters: {
      type: "object",
      properties: {
        jobId: { type: "string" },
        message: { type: "string" },
        expectAttemptId: { type: "string", description: "The attempt id you believe is currently active; a mismatch refuses instead of retargeting." },
        expectJobId: { type: "string", description: "The role job id you believe is currently active; a mismatch refuses instead of retargeting." },
      },
      required: ["jobId", "message"],
      additionalProperties: false,
    },
  },
  {
    name: "cancel_execution",
    label: "Cancel execution",
    description:
      "Cancel a managed execution. The authoritative cancellation intent is recorded before any fingerprint-matched owned process is signalled; repeated cancellation is idempotent and never restarts work. If irreversible landing has already been admitted the call refuses truthfully and preserves the landing evidence; a cancelled execution is never relabelled as success.",
    parameters: {
      type: "object",
      properties: { jobId: { type: "string" }, reason: { type: "string" } },
      required: ["jobId"],
      additionalProperties: false,
    },
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
  runtimeContext = {},
} = {}) {
  if (!root) throw new Error("repository root is required");
  const stateDir = stateDirFor(root, env);
  const live = new Map(); // jobId -> { child, outputTail, activeTool, trajectory, stderr }
  // jobId -> { release } — one hold per job on the OWNER's shared progress
  // consumer (the consumer and its relay runtime are shared and refcounted;
  // each job releases its own hold when it terminalizes).
  const communicationConsumerHolds = new Map();

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
    let record = readJob(stateDir, jobId);
    const association = session();
    if(existsSync(changeRecordPath(stateDir,jobId))) {
      let metadata;
      try{metadata=readLaunchMetadata({stateDir,executionId:jobId});}
      catch(error){if(!record)throw error;}
      if(metadata?.launch) {
        const recovered=reconcileManagedExecution({stateDir,executionId:jobId,expectedOwner:association.sessionKey,expectedRoot:root,now:now()});
        if(!recovered.ok)throw new Error(recovered.reason);
        record=recovered.projection;
      }
    }
    if (!record) throw new Error(`unknown job '${jobId}'`);
    if (record.workflow?.sessionKey !== association.sessionKey) {
      throw new Error(`job '${jobId}' belongs to another workflow session; refusing to operate on it`);
    }
    if (record.workflow?.root && record.workflow.root !== root) {
      throw new Error(`job '${jobId}' belongs to another workflow repository; refusing to operate on it`);
    }
    return record;
  }

  function ownsJob(record) {
    const owner=session().sessionKey;
    try {
      const metadata=existsSync(changeRecordPath(stateDir,record.id))?readLaunchMetadata({stateDir,executionId:record.id}):null;
      if(metadata?.launch)return metadata.launch.owner===owner&&metadata.launch.root===root;
      return record.workflow?.sessionKey===owner&&(!record.workflow?.root||record.workflow.root===root);
    }catch{return false;}
  }

  // Persist the complete report + record the AUTHORITATIVE outcome + terminal
  // outcome BEFORE notifying, then hand a bounded summary to the transport. A
  // failed delivery leaves the record inspectable and retryable; the report is
  // never the thing that gets dropped. The change record's validated outcome is
  // recorded (and its acceptance checked) BEFORE the compatibility terminal is
  // written, so a stale jobs.json projection can never claim a success the
  // record refused (e.g. output that arrived after a cancellation intent).
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
    // The change record is the authoritative outcome for a communication-enabled
    // runner: the validated outcome (pinned to the revision the attempt actually
    // worked against, so an unacknowledged update never silently re-pins a
    // result) is recorded and its acceptance checked BEFORE the compatibility
    // terminal exists.
    let finalStatus = status;
    let outcomeSuffix = "";
    const currentRecord = readJob(stateDir, record.id) ?? record;
    if (currentRecord.communication?.enabled && currentRecord.communication.changeId) {
      const outcome = recordRunnerOutcome({
        stateDir: currentRecord.communication.stateDir ?? stateDir,
        changeId: currentRecord.communication.changeId,
        jobId: currentRecord.id,
        attemptId: currentRecord.communication.attemptId,
        status,
        summary,
        reportId: saved?.reportId ?? null,
        actor: { kind: "runtime", id: currentRecord.communication.runtimeActorId ?? "qq-workflows-runtime" },
        now: now(),
      });
      if (!outcome.ok && outcome.code === "cancelled") {
        // Cancellation intent forbids success: record the honest cancelled
        // outcome and never let late output become a completed result.
        finalStatus = "cancelled";
        outcomeSuffix = `\n[late output rejected: ${outcome.reason}]`;
        recordRunnerOutcome({
          stateDir: currentRecord.communication.stateDir ?? stateDir,
          changeId: currentRecord.communication.changeId,
          jobId: currentRecord.id,
          attemptId: currentRecord.communication.attemptId,
          status: "cancelled",
          summary: outcome.reason,
          actor: { kind: "runtime", id: currentRecord.communication.runtimeActorId ?? "qq-workflows-runtime" },
          now: now(),
        });
      } else if (outcome.ok && outcome.status && outcome.status !== status) {
        // The record already holds a different validated outcome (e.g. an
        // operator cancellation): the compatibility projection mirrors the
        // record, never the other way around.
        finalStatus = outcome.status === "completed" ? "completed" : outcome.status === "cancelled" ? "cancelled" : "failed";
        outcomeSuffix = `\n[authoritative change-record outcome '${outcome.status}' supersedes the attempted '${status}']`;
      } else if (!outcome.ok) {
        // The record refused the attempted outcome (invalid transition,
        // unavailable record, identity refusal): the compatibility projection
        // must never publish a success the authority did not accept. A refused
        // completion becomes an explicit reconciliation-required terminal; a
        // refused failure stays a failure, with the refusal kept for review.
        outcomeSuffix = `\n[change record refused the outcome: ${outcome.reason ?? outcome.code}]`;
        if (finalStatus === "completed") finalStatus = "reconciliation-required";
      }
    }
    const settled = recordTerminal(stateDir, record.id, {
      status: finalStatus,
      summary: `${summary}${outcomeSuffix}`,
      reportId: saved?.reportId ?? null,
      reportChars: saved?.chars ?? 0,
      error,
      phase,
      now: now(),
    });
    // The job is terminal: release its consumer/relay hold. The last hold
    // drains bounded (delivering progress obligations already accepted by the
    // notification journal) and never deletes pending work.
    void Promise.resolve(releaseRunnerConsumerForJob(currentRecord)).catch(() => {});
    let delivery = null;
    if (finalStatus !== "cancelled" && notifierTransport) {
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

  // Release this job's hold on the shared consumer for its owner. Idempotent
  // per job; the shared consumer survives while other holders remain.
  function releaseRunnerConsumerForJob(record) {
    const communication = record?.communication;
    if (!communication?.enabled || !communication.consumerId || communication.consumerReleased) return null;
    const held = communicationConsumerHolds.get(record.id);
    if (!held) return null;
    communicationConsumerHolds.delete(record.id);
    return held.release();
  }

  function completionText(record) {
    return defaultCompletionText(record);
  }

  function jobsView({ role = null, scope = "session" } = {}) {
    const association = session();
    reconstructOwnedExecutions({stateDir,owner:association.sessionKey,root,now:now()});
    return listJobs(stateDir, { sessionKey: scope === "all" ? null : association.sessionKey, role }).filter(record=>scope==="all"||ownsJob(record)).map(record => {
      if (record.role === "execution" && record.workflow?.sessionKey === association.sessionKey && (!record.workflow?.root || record.workflow.root === root)) {
        if (!live.has(record.id)) reconcileJob(stateDir, record.id);
        record = reconcileManagedExecution({stateDir,executionId:record.id,now:now()}).projection ?? record;
      }
      return jobSummary(record);
    });
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
    // Durable, private result transport location: the explicit result survives
    // a coordinator reload inside this workflow's own state directory.
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

    // Never leak a parent's binding into another job/seat: an inherited
    // QQ_WORKFLOW_COMMUNICATION names an exact attempt in an exact state dir.
    const spawnEnv = { ...env };
    delete spawnEnv[COMMUNICATION_BINDING_ENV];

    if (launchPlan.harness !== PI_HARNESS) {
      // Legacy (non-Pi) dispatch: unchanged and fully synchronous. Steering
      // such a runner is explicitly refused later — never a silent stdin write
      // pretending delivery.
      return launchRunnerProcess({ id, record, association, launchPlan, prompt, cwd, spawnEnv, communication: null, resultFile, reportFile });
    }

    // A Pi-harness runner is communication-enabled: the shared runner lifecycle
    // prepares the authoritative record, the private relay, the owner's
    // return-consumer subscription and the validated binding BEFORE anything is
    // spawned (the preparation is asynchronous; its ORDER is fixed). The
    // dispatch returns synchronously with the durable job id and a `ready`
    // promise the tool surface awaits — a returned job ID never means the
    // receiver binding is ready (the adapter records the observed binding after
    // get_state; check_runner reports it). A setup failure records an honest
    // terminal failure and releases exactly what was acquired — it never
    // silently downgrades the runner to legacy (unsteerable) dispatch.
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    void (async () => {
      try {
        const prepared = await prepareRunnerCommunication({
          stateDir,
          root,
          env,
          jobId: id,
          task,
          targetPaths,
          cwd,
          ownerRouting: association.sessionKey,
          transport: notifierTransport,
          workflowRouting: { sessionKey: association.sessionKey, sessionId: association.sessionId },
          now: now(),
        });
        if (!prepared.ok) {
          void finishJob(record, { status: "failed", error: { message: `runner communication setup failed: ${prepared.reason}` } }).catch(() => {});
          resolveReady({
            ok: false,
            jobId: id,
            runnerId: id,
            status: "failed",
            error: prepared.reason,
            launchPlan: record.launchPlan,
            communication: { enabled: false, attempted: true, failed: prepared.reason },
          });
          return;
        }
        const communication = {
          schema: 1,
          enabled: true,
          changeId: prepared.changeId,
          jobId: id,
          attemptId: prepared.attemptId,
          consumerId: prepared.consumerId,
          stateDir,
          runtimeActorId: prepared.binding.runtimeActorId,
        };
        spawnEnv[COMMUNICATION_BINDING_ENV] = prepared.bindingEnv[COMMUNICATION_BINDING_ENV];
        // The consumer hold belongs to this job until it terminalizes; every
        // later failure path releases it through finishJob.
        communicationConsumerHolds.set(id, { release: prepared.release });
        // Persist the projection BEFORE any launch so every later failure path
        // finds the authoritative record and reports an honest outcome there.
        writeJob(stateDir, { ...(readJob(stateDir, id) ?? record), resultFile, communication });
        resolveReady(launchRunnerProcess({ id, record, association, launchPlan, prompt, cwd, spawnEnv, communication, resultFile, reportFile }));
      } catch (error) {
        void finishJob(record, { status: "failed", error: { message: `runner dispatch failed: ${String(error?.message ?? error)}` } }).catch(() => {});
        resolveReady({ ok: false, jobId: id, runnerId: id, status: "failed", error: String(error?.message ?? error), launchPlan: record.launchPlan });
      }
    })();

    return {
      ok: true,
      jobId: id,
      runnerId: id,
      status: "launching",
      sessionKey: association.sessionKey,
      launchPlan: record.launchPlan,
      ready,
      note: "communication setup and spawn are in progress; a returned job ID does not mean the receiver binding is ready (check_runner reports it)",
    };
  }

  // Spawn one dispatched runner through the existing canonical worker launcher
  // and wire its lifecycle. Shared verbatim by the synchronous legacy path and
  // the communication continuation above — never implemented twice.
  function launchRunnerProcess({ id, record, association, launchPlan, prompt, cwd, spawnEnv, communication, resultFile, reportFile }) {

    // The runner's bound identity and result transport are the caller's, and
    // they reach the worker only through the central launch contract: the
    // configured harness owns how its seat receives them. The target project is
    // the working directory (`cwd`) and nothing else.
    let launched;
    try {
      launched = planToSpawn(launchPlan, {
        prompt,
        env: spawnEnv,
        cwd,
        mcpEnv: { QQ_RUNNER_ID: id, QQ_RUNNER_RESULT_FILE: resultFile,
          ...(communication?.enabled ? {[COMMUNICATION_BINDING_ENV]:spawnEnv[COMMUNICATION_BINDING_ENV]} : {}) },
      });
    } catch (err) {
      // finishJob records the honest terminal failure in BOTH the compatibility
      // record and the authoritative change record, then releases the acquired
      // consumer hold (the relay journal keeps pending work).
      void finishJob(record, { status: "failed", error: { message: `runner launch rejected: ${err.message}` } }).catch(() => {});
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
      void finishJob(record, { status: "failed", error: { message: `runner spawn failed: ${err.message}` } }).catch(() => {});
      return { ok: false, jobId: id, status: "failed", error: err.message, launchPlan: record.launchPlan };
    }

    const liveState = { child, outputTail: "", activeTool: null, trajectory: [], stderr: "", lastObservedAt: now() };
    live.set(id, liveState);
    const pid = child.pid ?? null;
    const current = readJob(stateDir, id);
    writeJob(stateDir, {
      ...current,
      resultFile,
      process: { pid, spawnedAt: now(), fingerprint: processFingerprint({ pid }) },
      launchPlan: record.launchPlan,
      ...(communication ? { communication } : {}),
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
          // Durable telemetry so a RECOVERED handle (a coordinator reload) still
          // reports honest activity without any live callback owning settlement.
          liveState.lastObservedAt = now();
          const telemetryRecord = readJob(stateDir, id);
          if (telemetryRecord && !telemetryRecord.terminal) {
            writeJob(stateDir, {
              ...telemetryRecord,
              telemetry: { lastObservedAt: liveState.lastObservedAt, activeTool: liveState.activeTool, trajectory: liveState.trajectory },
              updatedAt: now(),
            });
          }
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
      }).catch(() => {});
    });
    child.on("close", (code, signal) => {
      const finished = readJob(stateDir, id);
      live.delete(id);
      // A recorded cancellation intent is terminal, before anything else: later
      // output can never become a successful outcome.
      if (finished?.cancellation) {
        void Promise.resolve(releaseRunnerConsumerForJob(finished)).catch(() => {});
        cleanupRunnerFiles(runner);
        return;
      }
      if (!finished || finished.terminal) {
        void Promise.resolve(releaseRunnerConsumerForJob(finished)).catch(() => {});
        cleanupRunnerFiles(runner);
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
        // Record/report durable BEFORE the transient transport is deleted.
        void finishJob(finished, { status: "completed", findings: withReport, report: authoritative.report ?? null })
          .catch(() => {})
          .finally(() => cleanupRunnerFiles(runner));
        return;
      }
      // An external SIGTERM/SIGINT is not operator cancellation: the honest
      // terminal state is a failure, with the signal reported. Cleanup runs
      // only AFTER record/report/authoritative-outcome registration (the
      // `.finally` below) so the explicit result is never the thing dropped.
      void finishJob(finished, {
        status: "failed",
        error: {
          message:
            code === 0
              ? `runner exited 0 without an authoritative complete_task result: ${authoritative.error}`
              : `runner process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
          ...(liveState.stderr.trim() ? { stderr: clamp(liveState.stderr.trim(), 1000) } : {}),
        },
      })
        .catch(() => {})
        .finally(() => cleanupRunnerFiles(runner));
    });

    return {
      ok: true,
      jobId: id,
      runnerId: id,
      status: RUNNING,
      sessionKey: association.sessionKey,
      launchPlan: record.launchPlan,
      pid,
      ...(communication ? { communication: { enabled: true, changeId: communication.changeId, attemptId: communication.attemptId } } : {}),
    };
  }

  function checkRunnerOp({ jobId } = {}) {
    let record = requireJob(jobId);
    const state = live.get(jobId) ?? null;
    // Live child callbacks own settlement until exit. Recovered handles have no
    // callback, so reload recovery ingests any explicit, job-bound result
    // (communication-enabled jobs included) and mirrors the settled outcome
    // into the authoritative change record BEFORE any lost process is
    // reconciled. Identity/owner/assignment/cwd are reconstructed from the
    // durable record here — never from an in-memory cache.
    if (!state && record.role === "runner") {
      const recovered = reconcileRunnerJob({ stateDir, jobId, now: now() });
      if (recovered.record) record = recovered.record;
    }
    const telemetry = state?.execution ? record.telemetry ?? null : state ?? record.telemetry ?? null;
    const lastObservedAt = telemetry?.lastObservedAt ?? null;
    // The TOP-LEVEL status and report reference are reconstructed from the
    // authoritative change record for communication-enabled runners: a stale
    // compatibility cache (including a corrupted one) can never override the
    // record's validated outcome or accepted cancellation.
    const communication = runnerCommunicationView({ stateDir, communication: record.communication ?? null });
    let status = record.status;
    if (communication.enabled) {
      if (communication.outcome?.status) status = communication.outcome.status;
      else if (communication.cancelIntent) status = "cancelled";
    }
    const reportId = record.terminal?.reportId ?? communication.outcome?.reportId ?? null;
    return {
      ...jobSummary(record),
      status,
      jobId: record.id,
      reportId,
      telemetry: { source: state && !state.execution ? "live" : record.telemetry ? "durable" : "unavailable",
        state: record.terminal ? "terminal" : !lastObservedAt ? "unavailable"
          : now() - lastObservedAt > 30_000 ? "stale" : telemetry?.activeTool ? "active" : "idle",
        lastObservedAt, observedAt: now(), idleMeaning: "no tool currently observed; model activity may continue" },
      activeTool: telemetry?.activeTool ?? null,
      trajectory: telemetry?.trajectory ?? [],
      outputTail: state?.outputTail ? clamp(state.outputTail, 2000) : null,
      reportHint: reportId
        ? `Full report '${reportId}' (${record.terminal?.reportChars ?? 0} chars) via read_report.`
        : null,
      // Rebuilt from the authoritative change record on every read: revision,
      // pending update references (bounded), unresolved revisions, and the
      // attempt's outcome — never the full findings.
      communication,
    };
  }

  async function steerRunnerOp({ jobId, message } = {}) {
    const record = requireJob(jobId);
    if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
    const communication = record.communication;
    if (!communication?.enabled || !communication.changeId) {
      // Legacy/non-enabled runner steering: no verified receiver exists, so a
      // stdin write would be ignored delivery theater. Refuse explicitly and
      // keep the refusal in the job history so check results identify
      // communication unsupported.
      appendJobEvent(stateDir, jobId, { action: "steer_refused", code: "unsupported", reason: "communication unsupported" }, { now: now() });
      return {
        ok: false,
        jobId,
        status: record.status,
        supported: false,
        steered: false,
        error: "runner communication is not enabled for this job; there is no verified receiver to deliver the instruction to, and nothing was sent",
      };
    }
    if (record.status !== RUNNING) {
      return {
        ok: false,
        jobId,
        status: record.status,
        supported: true,
        steered: false,
        error: `runner is ${record.status}; updates are no longer admitted`,
      };
    }
    // The relay push reuses the shared, refcounted relay runtime for this state
    // directory; the hold is dropped as soon as the submission settled.
    const acquired = await acquireRelayRuntime({ stateDir, env });
    const relay = acquired.ok ? acquired.relay : null;
    let result;
    try {
      result = await steerRunnerLifecycle({
        stateDir,
        changeId: communication.changeId,
        jobId,
        message: message.trim(),
        relay,
        actor: { kind: "runtime", id: communication.runtimeActorId ?? "qq-workflows-runtime" },
        now: now(),
      });
    } finally {
      if (acquired.ok) void Promise.resolve(acquired.relay.release()).catch(() => {});
    }
    if (result.ok) {
      // Rebuildable delivery correlation on the compatibility record (the
      // authoritative correlation lives in the change record).
      const current = readJob(stateDir, jobId);
      if (current) {
        writeJob(stateDir, {
          ...current,
          communication: {
            ...communication,
            amendments: [
              ...(Array.isArray(current.communication?.amendments) ? current.communication.amendments : []),
              { amendmentId: result.amendmentId, revision: result.revision, push: { status: result.delivery?.status ?? "unknown", eventId: result.delivery?.eventId ?? null, at: now() } },
            ],
          },
        });
      }
      appendJobEvent(stateDir, jobId, { action: "steer", revision: result.revision, delivery: result.delivery?.status ?? "unknown", message: clamp(message.trim(), 400) }, { now: now() });
      return {
        ok: true,
        jobId,
        status: record.status,
        recorded: true,
        revision: result.revision,
        amendmentId: result.amendmentId,
        delivery: result.delivery,
        acknowledged: false,
        note: "recorded as an assignment update; transport receipt and worker acknowledgement are separate later facts (check_runner)",
      };
    }
    appendJobEvent(stateDir, jobId, { action: "steer_refused", code: result.code, reason: clamp(result.reason ?? "", 200) }, { now: now() });
    return {
      ok: false,
      jobId,
      status: record.status,
      supported: true,
      steered: false,
      code: result.code,
      retryable: result.code === "not-bound",
      ...(result.revisionRecorded ? { revisionRecorded: result.revisionRecorded, unresolved: true } : {}),
      error: result.reason,
    };
  }

  function cancelRunnerOp({ jobId, reason = "cancelled by architect" } = {}) {
    const record = requireJob(jobId);
    const communication = record.communication;
    if (communication?.enabled && communication.changeId) {
      // The AUTHORITATIVE change record decides FIRST. A stale compatibility
      // cache can neither invent a cancellation nor let one overwrite an
      // already-validated outcome; a refused or unavailable authority means NO
      // cache tombstone and NO signal — and an accepted intent is durable
      // BEFORE the owned process is signalled.
      const commStateDir = communication.stateDir ?? stateDir;
      const actor = { kind: "runtime", id: communication.runtimeActorId ?? "qq-workflows-runtime" };
      const readAttempt = () => {
        try {
          return viewsFor(openChange({ stateDir: commStateDir, changeId: communication.changeId }).state).attempt(jobId, communication.attemptId);
        } catch {
          return null;
        }
      };
      let attempt = readAttempt();
      const decided = attempt?.outcome?.status ?? null;
      if (decided) {
        // The validated outcome is authoritative and terminal: cancellation
        // never overwrites it and never signals its process.
        return {
          ok: decided === "cancelled",
          jobId,
          status: decided,
          signalled: false,
          ...(decided === "cancelled" ? {} : { code: "already-decided" }),
          note: `the authoritative change record already holds the validated '${decided}' outcome; nothing was signalled`,
        };
      }
      const intent = recordRunnerCancelIntent({
        stateDir: commStateDir,
        changeId: communication.changeId,
        jobId,
        attemptId: communication.attemptId,
        reason,
        actor,
        now: now(),
      });
      if (!intent.ok) {
        return {
          ok: false,
          jobId,
          status: record.status,
          signalled: false,
          code: intent.code ?? "refused",
          error: `cancellation refused: ${intent.reason}`,
          note: "no cancellation intent was recorded, no cache tombstone was written, and no owned process was signalled",
        };
      }
      const outcome = recordRunnerOutcome({
        stateDir: commStateDir,
        changeId: communication.changeId,
        jobId,
        attemptId: communication.attemptId,
        status: "cancelled",
        summary: clamp(reason, 500),
        actor,
        now: now(),
      });
      attempt = readAttempt();
      const settled = attempt?.outcome?.status ?? null;
      if (settled !== "cancelled") {
        // The outcome append lost to a validated success (or failed): never
        // signal and never claim an accepted cancellation.
        return {
          ok: false,
          jobId,
          status: settled ?? record.status,
          signalled: false,
          code: outcome.ok ? "already-decided" : (outcome.code ?? "refused"),
          ...(outcome.ok ? {} : { error: `cancellation refused: ${outcome.reason}` }),
          note: "no accepted authoritative cancellation outcome exists; no owned process was signalled",
        };
      }
      void Promise.resolve(releaseRunnerConsumerForJob(record)).catch(() => {});
    } else if (TERMINAL_STATUSES.includes(record.status)) {
      return { ok: true, jobId, status: record.status, note: "already terminal" };
    }
    // The cache tombstone is written AFTER the authority admitted the
    // cancellation (and is a no-op for an already-terminal cache).
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
          stateDir,
          sessionId: association.sessionId,
          phaseId: targetPhase,
          baseRef,
          workflow: association,
          onPhase: (phase, detail = null) => {
            // Guarded telemetry only: the host owns phase publication and a
            // stale parent write can never revive running state or erase a
            // cancellation or terminal outcome.
            updateRunningJob(stateDir, id, (fresh) => ({ ...fresh, phase: phase ?? fresh.phase }));
            appendJobEvent(stateDir, id, { action: "phase", phase: phase ?? null, detail: detail ? clamp(String(detail), 200) : null }, { now: now() });
            const state = live.get(id);
            if (state) state.phase = phase ?? state.phase;
          },
        });
        const current = readJob(stateDir, id);
        if (!current || current.terminal) return;
        if (current.executionHost?.authority || current.communication?.enabled) {
          // The owned host publishes through the change record. A launcher
          // returning (including interrupted/unknown) is not another result.
          reconcileManagedExecution({stateDir,executionId:id,now:now()});
          return;
        }
        const failed = result?.ok === false || result?.status === "failed" || result?.status === "cancelled";
        const findings = typeof result === "string" ? result : JSON.stringify(result ?? {}, null, 2);
        void finishJob(current, {
          status: failed ? (result?.status === "cancelled" ? "cancelled" : "failed") : "completed",
          findings,
          phase: result?.phase ?? "completed",
          error: failed
            ? { message: result?.error?.message ?? `managed execution ${result?.status ?? "failed"}`, phase: result?.error?.phase ?? null }
            : null,
        }).catch(() => {});
      } catch (err) {
        const current = readJob(stateDir, id);
        if (!current || current.terminal) return;
        if (current.executionHost?.authority || current.communication?.enabled) {
          reconcileJob(stateDir,id);
          reconcileManagedExecution({stateDir,executionId:id,now:now()});
          return;
        }
        void finishJob(current, {
          status: "failed",
          phase: current.phase,
          error: { message: err?.message || String(err), phase: current.phase },
        }).catch(() => {});
      } finally {
        live.delete(id);
      }
    })();
    return { ok: true, jobId: id, executionId: id, status: RUNNING, kind, phaseId: targetPhase, sessionKey: association.sessionKey };
  }

  function checkExecutionOp({ jobId } = {}) {
    const record = requireJob(jobId);
    if (record.role !== "execution") throw new Error(`job '${jobId}' is not a managed execution`);
    // Process reconciliation first (a disappeared host is interrupted with an
    // UNKNOWN outcome, never a known failure), then reconstruction from the
    // ONE append-only record: a stale cross-process cache write can never
    // revive running/success after a recorded cancellation or validated
    // outcome.
    if (!live.has(jobId)) reconcileJob(stateDir, jobId);
    const reconstructed = reconcileManagedExecution({ stateDir, executionId: jobId, now: now() });
    const authority = reconstructed.ok ? reconstructed.view : {enabled:true,recordUnavailable:reconstructed.reason};
    const fresh = readJob(stateDir, jobId) ?? record;
    const base = checkRunnerOp({ jobId });
    const terminal = fresh.terminal ?? null;
    return {
      ...base,
      ...(reconstructed.ok ? {} : {ok:false,status:"reconciliation-required"}),
      authority,
      // Gap contract: disappearance is outcome-UNKNOWN, never a known failed
      // outcome. Known outcomes come from the authoritative record.
      outcomeKnown: !reconstructed.ok ? false : authority?.execution ? authority.execution.outcomeKnown : Boolean(terminal && terminal.status !== "interrupted"),
      outcomeSource: authority?.execution ? "change-record" : terminal ? "compatibility-record" : null,
    };
  }

  async function steerExecutionOp({ jobId, message, expectAttemptId = null, expectJobId = null } = {}) {
    const record = requireJob(jobId);
    if (record.role !== "execution") throw new Error(`job '${jobId}' is not a managed execution`);
    if (typeof message !== "string" || !message.trim()) throw new Error("message is required");
    if (record.terminal || record.cancellation) {
      return { ok: false, jobId, code: "refused", status: "unresolved", reason: "the execution is settled or cancelled; updates are no longer admitted" };
    }
    try {
      return { jobId, ...(await steerManagedRoleCommunication({ stateDir, executionId: jobId, message, expectAttemptId, expectJobId, env, now: now() })) };
    } catch (error) {
      return { ok: false, jobId, code: error?.code ?? "refused", status: "unresolved", reason: error.message };
    }
  }

  function cancelExecutionOp({ jobId, reason = "cancelled by architect" } = {}) {
    const record = requireJob(jobId);
    if (record.role !== "execution") throw new Error(`job '${jobId}' is not a managed execution`);
    return { jobId, ...cancelExecutionHost({ stateDir, jobId, by: session().sessionKey, reason, now: now() }) };
  }

  function readReportOp({ reportId, offset = 0, limit } = {}) {
    return readReport(stateDir, reportId, { offset, ...(limit ? { limit } : {}) });
  }

  function reconcileOp() {
    // Reconstruct owned execution authority after process reconciliation.
    // Merely observing another session never mutates its records.
    const association=session();
    for(const record of listJobs(stateDir,{sessionKey:association.sessionKey})) {
      if(record.workflow?.root && record.workflow.root !== root) continue;
      if(!live.has(record.id)) reconcileJob(stateDir,record.id);
    }
    return { jobs: jobsView() };
  }

  async function recoverDeliveriesOp({ transport = notifierTransport, evidence = null, allowUnverified = false } = {}) {
    const association = session();
    const reconstruction=reconstructOwnedExecutions({stateDir,owner:association.sessionKey,root,now:now()});
    const progress = {recovered:[],errors:[]};
    for (const record of listJobs(stateDir,{sessionKey:association.sessionKey})) {
      if(!ownsJob(record))continue;
      if(record.role==="runner"&&record.communication?.enabled) {
        try {progress.recovered.push(...await recoverRunnerProgress({stateDir,communication:record.communication,workflow:record.workflow,transport,evidence,now:now()}));}
        catch(error){progress.errors.push({jobId:record.id,error:String(error?.message??error)});}
      }
      if (record.role !== "execution") continue;
      const reconstructed = reconcileManagedExecution({stateDir,executionId:record.id,expectedOwner:association.sessionKey,expectedRoot:root,now:now()});
      if (reconstructed.ok && reconstructed.view) {
        for (const entry of pendingRoleProgress({stateDir,executionId:record.id})) {
          if (entry.forwarded === "delivered") continue;
          await forwardRoleProgress({stateDir,executionId:record.id,...entry,transport,workflow:record.workflow,owner:association.sessionKey,evidence,now:now()});
        }
      }
    }
    const jobs = listJobs(stateDir, { sessionKey: association.sessionKey }).filter(ownsJob).map((record) =>
      live.has(record.id) ? record : record.role === "runner" ? reconcileRunnerJob({stateDir,jobId:record.id,now:now()}).record : reconcileJob(stateDir, record.id)).filter(Boolean).map(jobSummary);
    const delivery = await recoverPendingDeliveries({
      stateDir,
      sessionKey: association.sessionKey,
      transport,
      now: now(),
      evidence,
      allowUnverified,
      ownsJob,
    });
    // Runner communication recovery: recorded-but-unsent assignment updates for
    // this session's runners are re-pushed here (never re-recorded), and a
    // bounded consumer drain delivers progress obligations the notification
    // journal already accepted. A restarted parent for the same owner recovers
    // the same consumer address, so nothing is lost and nothing is duplicated.
    const communication = await recoverRunnerCommunicationForSession(association);
    return {
      ok: true,
      sessionKey: association.sessionKey,
      runtime: { operationsModule: import.meta.url, pid: process.pid, ...runtimeContext },
      progress,
      reconstruction,
      jobs,
      delivery,
      communication,
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

  // Recover the communication lifecycle for one session's runner jobs:
  // re-push recorded-but-unsent assignment updates (the explicit safe retry
  // path — never a re-record, never a worker relaunch) through a bounded
  // consumer hold that also drains pending progress obligations.
  async function recoverRunnerCommunicationForSession(association) {
    const runnerRecords = listJobs(stateDir, { sessionKey: association.sessionKey, role: "runner" }).filter(
      (record) => record.communication?.enabled && record.communication.changeId,
    );
    if (runnerRecords.length === 0) return { recovered: 0, pushed: [], unresolved: [], errors: [] };
    const consumer = await acquireRunnerConsumer({
      stateDir,
      root,
      ownerRouting: association.sessionKey,
      env,
      transport: notifierTransport,
      workflowRouting: { sessionKey: association.sessionKey, sessionId: association.sessionId },
    });
    if (!consumer.ok) {
      return { recovered: runnerRecords.length, pushed: [], unresolved: [], errors: [{ jobId: null, reason: consumer.reason }] };
    }
    const out = { recovered: runnerRecords.length, pushed: [], unresolved: [], errors: [] };
    try {
      for (const record of runnerRecords) {
        try {
          const retry = await retryPendingRunnerAmendments({
            stateDir,
            changeId: record.communication.changeId,
            jobId: record.id,
            relay: consumer.relay,
            actor: { kind: "runtime", id: record.communication.runtimeActorId ?? "qq-workflows-runtime" },
            now: now(),
          });
          out.pushed.push(...retry.pushed.map((entry) => ({ jobId: record.id, ...entry })));
          out.unresolved.push(...retry.unresolved.map((entry) => ({ jobId: record.id, ...entry })));
          out.errors.push(...retry.errors.map((entry) => ({ jobId: record.id, ...entry })));
        } catch (error) {
          out.errors.push({ jobId: record.id, reason: clamp(String(error?.message ?? error), 200) });
        }
      }
    } finally {
      // The bounded drain on the last hold delivers progress obligations the
      // notification journal already accepted.
      void Promise.resolve(consumer.release()).catch(() => {});
    }
    return out;
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
      case "dispatch_runner": {
        const dispatched = dispatchRunnerOp(args ?? {});
        // The tool surface awaits the communication setup + spawn so the
        // model-facing result reports the launched state; the direct API keeps
        // its synchronous job id (a returned job ID never means the receiver
        // binding is ready).
        return dispatched?.ready ? await dispatched.ready : dispatched;
      }
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
      case "steer_execution":
        return steerExecutionOp(args ?? {});
      case "cancel_execution":
        return cancelExecutionOp(args ?? {});
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
    // Test/shutdown seam: drop every consumer/relay hold this workflow still
    // owns (each also drains bounded before the transport stops).
    releaseCommunication: releaseAllRunnerConsumers,
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
    steerExecution: steerExecutionOp,
    cancelExecution: cancelExecutionOp,
    _live: live,
  };
}
