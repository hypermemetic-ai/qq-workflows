import { createServer } from "node:http";
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createSupervisor } from "./supervisor.mjs";
import { hostVersion } from "./version.mjs";
import { reconcileWithSdk } from "./spawn-agent.mjs";
import { createStore, persistentMap, STATE_DIR } from "./store.mjs";
import { architectTools } from "./tools.mjs";

const execFile = promisify(execFileCb);
import { ticketRead, ticketWrite, parseKind } from "./ticket.mjs";
import { validateDelegateArgs, validateTeacherArgs } from "./tools.mjs";
import { formatResearcherWake, formatReviewerWake, formatTeacherWake, normalizeFindings, routeDone } from "./done.mjs";
import {
  classifyFailure,
  createCircuit,
  createLedger,
  formatRecoveryWake,
  operationKey,
  retryProviderOperation,
} from "./recovery.mjs";
import { callZgTool, indexWorkspace } from "./zg.mjs";
import { ZG_WHITELIST } from "./zg-tools.mjs";
import {
  implementerCreateOptions,
  teacherCreateOptions,
} from "./children.mjs";
import { applyDaemonPatch, architectProfile, ARCHITECT_MODEL_ID, ARCHITECT_PROVIDER_ID, SPAWN_ENTRY } from "./config.mjs";
import { buildReviewPacket, commitIfDirty, createAndMergePr, fastForwardMain, hasRemote, isGitRepo } from "./git.mjs";
import { braveSearch, exaSearch, visitWebpage } from "./web.mjs";
import { runOcrReview } from "./ocr.mjs";
import { runMiniResearcher } from "./researcher.mjs";
import { createImplementerWorktree, implementerBranchName } from "./worktree.mjs";

export const HOST_STATE_DIR = STATE_DIR;
export const HOST_META_PATH = join(HOST_STATE_DIR, "host.json");

export function isRealCwd(cwd) {
  return typeof cwd === "string" && cwd.trim().length > 0;
}

export function parseCreatedAgentJson(text) {
  const raw = String(text ?? "").trim();
  let parsed;
  for (const line of raw.split(/\r?\n/).reverse()) {
    try { parsed = JSON.parse(line); break; } catch { /* progress is not a result */ }
  }
  if (!parsed) throw new Error("paseo spawn produced no json");
  const id = parsed.id ?? parsed.agentId;
  if (!id) throw new Error("paseo spawn json missing id");
  return {
    id,
    workspaceId: parsed.workspaceId ?? parsed.workspace_id ?? null,
    cwd: parsed.cwd ?? null,
  };
}

export function defaultSpawnExec(command, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `spawn-agent exited ${code}`));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

export async function waitForHandleCwd(handle, { timeoutMs = 30_000, intervalMs = 50 } = {}) {
  const current = () => (isRealCwd(handle?.cwd) ? handle.cwd : null);
  if (current()) return current();
  const deadline = Date.now() + timeoutMs;
  let unsubscribe = () => {};
  const fromSubscribe = new Promise((resolve) => {
    if (typeof handle?.subscribe !== "function") return;
    try {
      unsubscribe = handle.subscribe(() => {
        const cwd = current();
        if (cwd) resolve(cwd);
      }) ?? (() => {});
    } catch {
      /* snapshot may arrive via refresh */
    }
  });
  const fromRefresh = (async () => {
    while (Date.now() < deadline) {
      try {
        await handle.refresh?.();
      } catch {
        /* snapshot may already be present */
      }
      const cwd = current();
      if (cwd) return cwd;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return null;
  })();
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs));
  try {
    const cwd = await Promise.race([fromSubscribe, fromRefresh, timeout]);
    if (!isRealCwd(cwd)) throw new Error("delegate: worktree cwd did not appear");
    return cwd;
  } finally {
    try {
      unsubscribe();
    } catch {
      /* ignore */
    }
  }
}

export function createRuntime(options = {}) {
  const store = options.store ?? createStore(options.storePath ?? ":memory:");
  const jobs = persistentMap(store, "job");
  const save = job => store.put("job", job.id, job);
  const wakeWaiters = new Map();
  const pending = new Set();
  let paseo = options.paseo ?? null;
  let server = null;
  let hostUrl = options.hostUrl ?? null;
  const version = hostVersion();
  let draining = false;
  const ocrReview = options.ocrReview ?? runOcrReview;
  const runResearch = options.runResearch ?? runMiniResearcher;
  const waitForCwd = options.waitForHandleCwd ?? waitForHandleCwd;
  const spawnExec = options.spawnExec ?? defaultSpawnExec;
  const indexWorkspaceFn = options.indexWorkspace ?? indexWorkspace;
  const circuit = options.circuit ?? createCircuit({ store });
  const operations = options.operations ?? persistentMap(store, "operation");
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const supervise = createSupervisor({ store, jobs, circuit, random, wake: queueWake });
  const reconcileChild = options.reconcileSpawn ?? (jobId => reconcileWithSdk(jobId, paseo ? { client: paseo } : {}));
  const git = {
    isGitRepo: options.isGitRepo ?? isGitRepo,
    commitIfDirty: options.commitIfDirty ?? commitIfDirty,
    createAndMergePr: options.createAndMergePr ?? createAndMergePr,
    buildReviewPacket: options.buildReviewPacket ?? buildReviewPacket,
    hasRemote: options.hasRemote ?? hasRemote,
    fastForwardMain: options.fastForwardMain ?? fastForwardMain,
  };

  function setPaseo(next) {
    paseo = next;
  }

  function hasPaseo() {
    return paseo != null;
  }

  async function persistMeta() {
    if (!options.storePath || options.storePath === ":memory:") return;
    await mkdir(HOST_STATE_DIR, { recursive: true });
    await writeFile(HOST_META_PATH, `${JSON.stringify({ url: hostUrl, pid: process.pid }, null, 2)}\n`);
  }

  async function handleTool(name, args, context = {}) {
    const key = context.requestId;
    if (!key) return executeHostTool(name, args, context);
    const prior = store.get("tool_result", key);
    if (prior) return prior.value;
    if (store.get("tool_pending", key) && ["delegate", "teacher", "ticket_write"].includes(name)) throw new Error("Tool outcome is uncertain; inspect persisted operation before retrying");
    store.put("tool_pending", key, { name, args, context });
    const value = await executeHostTool(name, args, context);
    store.put("tool_result", key, { value });
    return value;
  }

  async function executeHostTool(name, args, context = {}) {
    const child = jobByIdOrAgent(context.jobId, context.agentId);
    if (context.jobId && !child) throw new Error("unknown child");
    if (child && child.status !== "running" && name !== "done") throw new Error("stale child cannot execute tools");
    const role = child?.role ?? context.role ?? "architect";
    const allowed = {
      architect: architectTools().map(tool => tool.name),
      teacher: ["ticket_read", "ticket_write", "done", "zvec_grep_search", "zvec_grep_rg"],
      implementer: ["done"],
      reviewer: ["done"],
      researcher: ["done", "brave_search", "exa_search", "visit_webpage", "zvec_grep_search", "zvec_grep_rg"],
    }[role] ?? [];
    if (!allowed.includes(name)) throw new Error(`${role} cannot execute ${name}`);
    const cwd = child?.worktreeCwd ?? child?.cwd ?? context.cwd;
    if (!isRealCwd(cwd)) throw new Error("workspace is required");
    if (args?.root && args.root !== cwd) throw new Error("tool root must match the workspace");
    switch (name) {
      case "ticket_read":
        return ticketRead(cwd);
      case "ticket_write": {
        const result = await ticketWrite(cwd, args);
        const snapshot = await ticketRead(cwd);
        store.put("ticket_revision", operationKey(cwd, "ticket", snapshot.text), { ...snapshot, cwd, createdAt: Date.now() });
        return result;
      }
      case "teacher":
        return startTeacher({ cwd, args, parent: context.agentId, paseoParent: context.paseoAgentId });
      case "delegate":
        return startDelegate({ cwd, args, parent: context.agentId, paseoParent: context.paseoAgentId });
      case "done":
        return finishChild({ ...args, ...context });
      case "brave_search":
        return braveSearch(args?.query ?? "");
      case "exa_search":
        return exaSearch(args?.query ?? "");
      case "visit_webpage":
        return visitWebpage(args?.url ?? args?.query ?? "");
      default:
        if (ZG_WHITELIST.includes(name)) {
          return callZgTool(name, { ...args, root: cwd });
        }
        throw new Error(`unknown tool: ${name}`);
    }
  }

  async function startTeacher({ cwd, args, parent, paseoParent }) {
    if (draining) throw new Error("Host upgrade is waiting for existing work to finish; retry after it completes");
    const parsed = validateTeacherArgs(args);
    const existing = [...jobs.values()].find(job => job.role === "teacher" && job.cwd === cwd && job.parked_question === parsed.parked_question && ["running", "uncertain"].includes(job.status));
    if (existing) return { started: false, jobId: existing.id, agentId: existing.agentId, message: "The existing Teacher session is preserved." };
    const job = createJob({
      role: "teacher",
      cwd,
      parent,
      paseoParent,
      parked_question: parsed.parked_question,
    });
    const created = await spawnAgent(teacherCreateOptions({
      jobId: job.id,
      hostUrl,
      workspace: cwd,
      args: parsed,
      parent: paseoParent,
    }));
    job.agentId = created.id;
    job.workspaceId = created.workspaceId;
    job.phase = "working";
    save(job);
    return {
      started: true,
      agentId: created.id,
      message: "Teacher started. Tell the operator to open that session.",
    };
  }

  async function prepareImplementerWorkspace({ cwd, branch }) {
    const created = typeof options.createWorktree === "function"
      ? await options.createWorktree({ cwd, branch })
      : await createImplementerWorktree({ cwd, branch, paseo });
    if (!isRealCwd(created?.cwd)) throw new Error("delegate: worktree cwd did not appear");
    await indexWorkspaceFn(created.cwd, { wait: true });
    return created;
  }

  async function startDelegate({ cwd, args, parent, paseoParent }) {
    if (draining) throw new Error("Host upgrade is waiting for existing work to finish; retry after it completes");
    const ticket = await ticketRead(cwd);
    const ticketRevision = operationKey(cwd, "ticket", ticket.text);
    store.put("ticket_revision", ticketRevision, { ...ticket, cwd, createdAt: Date.now() });
    const kind = parseKind(ticket.text);
    const parsed = validateDelegateArgs(args, kind);
    const existing = [...jobs.values()].find(job => job.cwd === cwd && job.role === parsed.to && ["running", "awaiting_correction", "uncertain"].includes(job.status) && (parsed.to === "researcher" ? job.question === parsed.question : job.ticketRevision === ticketRevision));
    if (existing) return { started: false, jobId: existing.id, agentId: existing.agentId, to: parsed.to, status: existing.status };
    if (parsed.to === "researcher") {
      const opKey = operationKey(cwd, "research", parsed.question);
      const prior = operations.get(opKey);
      if (prior?.status === "exhausted") {
        queueWake(parent, prior.wake);
        return { started: false, jobId: prior.jobId, to: "researcher", exhausted: true };
      }
      if (circuit.isOpen("research")) {
        const wake = formatRecoveryWake(Object.assign(new Error("provider circuit open"), { circuitOpen: true }), {
          role: "research",
          details: opKey.slice(0, 12),
        });
        queueWake(parent, wake);
        return { started: false, to: "researcher", blocked: true };
      }
      const job = createJob({
        role: "researcher",
        cwd,
        parent,
        question: parsed.question,
        operationKey: opKey,
        ledger: createLedger(),
      });
      runResearcherJob(job);
      return { started: true, jobId: job.id, to: "researcher" };
    }
    const job = createJob({
      role: "implementer",
      kind: parsed.kind,
      cwd,
      parent,
      paseoParent,
      reviewerAttempt: 0,
      task: ticket.text,
      ticketRevision,
      ledger: createLedger(),
    });
    const branchName = implementerBranchName(parsed.kind, job.id);
    job.phase = "preparing"; save(job);
    let prepared;
    try { prepared = await prepareImplementerWorkspace({ cwd, branch: branchName }); }
    catch (error) { job.status = "failed"; job.error = `Workspace preparation failed: ${error.message}`; save(job); throw error; }
    job.worktreeCwd = prepared.cwd;
    job.workspaceId = prepared.workspaceId;
    job.phase = "spawning";
    save(job);
    const created = await spawnAgent(implementerCreateOptions({
      jobId: job.id,
      hostUrl,
      workspace: prepared.cwd,
      workspaceId: prepared.workspaceId,
      task: ticket.text,
      kind: parsed.kind,
      parent: paseoParent,
      branch: true,
    }));
    job.agentId = created.id;
    job.workspaceId = created.workspaceId ?? prepared.workspaceId;
    if (!isRealCwd(job.worktreeCwd)) {
      throw new Error("delegate: worktree cwd did not appear");
    }
    job.phase = "working";
    save(job);
    return { started: true, agentId: created.id, to: "implementer", kind: parsed.kind };
  }

  function runResearcherJob(job) {
    const running = Promise.resolve()
      .then(() => runResearch(job.question, { cwd: job.cwd, hostUrl, jobId: job.id, restart: () => supervise({ jobId: job.id, event: "restart" }) }))
      .then((answer) => {
        const text = String(answer ?? "").trim();
        store.receive(job, { answer: text });
        job.status = "succeeded";
        job.phase = "completed";
        job.answer = text;
        job.decision = routeDone({ role: "researcher" });
        if (job.operationKey) operations.delete(job.operationKey);
        circuit.recordSuccess("research");
        queueWake(job.parent, formatResearcherWake({ answer: text }), `${job.id}:completion`);
        return { ok: true, action: "wake_architect", answer: text };
      })
      .catch((error) => {
        error.failureClass = error.failureClass ?? classifyFailure(error);
        const wake = formatRecoveryWake(error, { role: "research", details: job.id });
        job.status = error.failureClass === "cancelled" ? "cancelled" : "failed";
        job.error = wake;
        if (error.failureClass === "transient") {
          const n = Array.isArray(error.attempts) && error.attempts.length ? error.attempts.length : 1;
          circuit.recordFailure("research", "transient", { newRequest: true });
          for (let i = 1; i < n; i++) circuit.recordFailure("research", "transient", { newRequest: false });
        }
        if (job.operationKey && (error.exhausted || error.failureClass === "transient" || error.failureClass === "degeneration")) {
          operations.set(job.operationKey, { status: "exhausted", wake, jobId: job.id });
        }
        queueWake(job.parent, wake, `${job.id}:failure`);
        return { ok: false, action: "wake_architect", error: wake };
      });
    track(running.finally(() => save(job)));
    return running;
  }

  async function finishChild(input) {
    const job = jobByIdOrAgent(input.jobId, input.agentId);
    if (!job) throw new Error("done: unknown child");
    const prior = store.get("receipt", job.id);
    if (prior) return prior;
    if (job.status !== "running") throw new Error("done: stale child");
    if ((job.role === "teacher" || job.role === "researcher") && (typeof input.answer !== "string" || !input.answer.trim())) throw new Error("done requires a nonempty answer");
    if (job.role === "reviewer") normalizeFindings(input.findings);
    const receipt = store.receive(job, input);
    job.phase = "completion_received";
    // The child receives its durable receipt before review or publication begins.
    track(new Promise(resolve => setImmediate(resolve)).then(async () => {
      job.result = await finishChildOnce(job, input);
      save(job);
      if (job.delegationId && job.delegationId !== job.id) {
        const original = jobs.get(job.delegationId);
        if (original) { original.status = job.status; original.phase = job.phase; original.result = job.result; save(original); }
      }
    }));
    return receipt;
  }

  async function finishChildOnce(job, input) {
    if (job.role === "reviewer" && !Array.isArray(input.findings)) {
      throw new Error("reviewer done requires findings array");
    }
    const findings = Array.isArray(input.findings) ? normalizeFindings(input.findings) : [];
    const answer = String(input.answer ?? "").trim();
    const decision = routeDone({
      role: job.role,
      kind: job.kind,
      reviewRound: job.reviewerAttempt ?? 0,
      findings,
    });
    job.phase = "settling";
    job.decision = decision;
    job.answer = answer;
    job.findings = findings;
    save(job);

    try {
      if (decision.action === "wake_architect") {
        const text = wakeText(job, decision, answer, findings);
        queueWake(job.parent, text, `${job.id}:completion`);
        job.status = "succeeded";
        return { ok: true, action: decision.action };
      }
      if (decision.action === "commit_pr_merge") {
        return settleOrWake(job, { pr: true, message: "architect implementer (bounded)", action: decision.action });
      }
      if (decision.action === "commit_spawn_reviewer") {
        const settled = await settleOrWake(job, {
          pr: false,
          message: "architect implementer (open)",
          action: decision.action,
        });
        if (settled.action === "wake_architect") return settled;
        return reviewOpenImplementer(job);
      }
      if (decision.action === "pr_merge") {
        return settleOrWake(job, { pr: true, message: "architect implementer", action: decision.action });
      }
      if (decision.action === "spawn_implementer_same_worktree") {
        return spawnFixImplementer(job, findings);
      }
      return { ok: true, action: decision.action };
    } catch (error) {
      const wake = formatRecoveryWake(error, {
        role: job.role === "implementer" ? "review" : "research",
        details: job.id,
        headSha: job.packet?.headSha,
        worktree: job.worktreeCwd ?? job.cwd,
      });
      job.status = "failed";
      job.error = wake;
      queueWake(job.parent, wake, `${job.id}:failure`);
      return { ok: true, action: "wake_architect", error: wake };
    }
  }

  async function reviewOpenImplementer(job) {
    const cwd = job.worktreeCwd ?? job.cwd;
    job.phase = "reviewing";
    save(job);
    try {
      const packet = await git.buildReviewPacket(cwd);
      job.packet = packet;
      save(job);
      const from = packet.baseSha;
      if (!from) throw new Error("review packet missing merge-base");
      const review = () => ocrReview(cwd, { from, to: packet.headSha, supervision: { store, jobId: job.id, delegationId: job.delegationId ?? job.id, circuit, sleep, random } });
      // Production retries occur at OCR's HTTP boundary, never around the whole review.
      const findings = options.ocrReview ? await retryProviderOperation(review, { ledger: job.ledger ?? createLedger(), circuit, scope: "review", sleep, random }) : await review();
      job.reviewFindings = normalizeFindings(findings);
      job.phase = "reviewed";
      save(job);
      return applyReviewerDecision(job, findings, packet);
    } catch (error) {
      error.failureClass = error.failureClass ?? classifyFailure(error);
      const wake = formatRecoveryWake(error, {
        role: "review",
        details: job.id,
        headSha: job.packet?.headSha,
        worktree: cwd,
      });
      job.status = "failed";
      job.error = wake;
      queueWake(job.parent, wake, `${job.id}:failure`);
      return { ok: true, action: "wake_architect", error: wake, findings: [] };
    }
  }

  async function applyReviewerDecision(implementerJob, findings, packet) {
    const list = normalizeFindings(findings);
    const reviewRound = (implementerJob.reviewerAttempt ?? 0) + 1;
    const decision = routeDone({
      role: "reviewer",
      kind: implementerJob.kind,
      reviewRound,
      findings: list,
    });
    implementerJob.reviewDecision = decision;
    implementerJob.findings = list;
    if (decision.action === "pr_merge") {
      const settled = await settleOrWake(implementerJob, {
        pr: true,
        message: "architect implementer",
        action: decision.action,
      });
      return { ...settled, findings: list };
    }
    if (decision.action === "spawn_implementer_same_worktree") {
      return spawnFixImplementer(implementerJob, list, packet, reviewRound);
    }
    if (decision.action === "wake_architect") {
      implementerJob.status = "findings"; implementerJob.phase = "findings"; save(implementerJob);
      queueWake(implementerJob.parent, formatReviewerWake({ findings: list, packet }), `${implementerJob.id}:findings`);
      return { ok: true, action: decision.action, findings: list };
    }
    return { ok: true, action: decision.action, findings: list };
  }

  async function spawnFixImplementer(job, findings, packet = job.packet, reviewRound = job.reviewerAttempt ?? 1) {
    const cwd = job.worktreeCwd ?? job.cwd;
    if (!isRealCwd(cwd)) throw new Error("delegate: worktree cwd did not appear");
    await indexWorkspaceFn(cwd, { wait: true });
    if (job.correctionJobId) {
      const existing = jobs.get(job.correctionJobId);
      if (!existing?.agentId) throw new Error("Correction creation outcome is uncertain; inspect the existing job");
      return { ok: true, action: "spawn_implementer_same_worktree", implementerId: existing.agentId };
    }
    const implementer = createJob({
      role: "implementer",
      kind: job.kind ?? "open",
      cwd: job.cwd,
      parent: job.parent,
      paseoParent: job.paseoParent,
      reviewerAttempt: reviewRound,
      worktreeCwd: cwd,
      packet,
      ledger: job.ledger ?? createLedger(),
      task: job.task,
      delegationId: job.delegationId ?? job.id,
    });
    job.correctionJobId = implementer.id;
    job.phase = "awaiting_correction";
    job.status = "awaiting_correction";
    save(job);
    try {
      const created = await spawnAgent(implementerCreateOptions({
        jobId: implementer.id,
        hostUrl,
        workspace: cwd,
        task: implementer.task,
        kind: implementer.kind,
        parent: job.paseoParent,
        branch: true,
        findings,
      }));
      implementer.agentId = created.id;
      implementer.worktreeCwd = cwd;
      save(implementer);
      return { ok: true, action: "spawn_implementer_same_worktree", implementerId: created.id };
    } catch (error) {
      // A failed response does not prove creation failed. Never create a second worker here.
      implementer.status = "uncertain";
      implementer.error = `Child creation outcome is uncertain: ${error.message}`;
      save(implementer);
      throw error;
    }
  }

  function wakeText(job, decision, answer, findings) {
    if (decision.wake === "teacher") {
      return formatTeacherWake({ parked_question: job.parked_question, answer });
    }
    if (decision.wake === "researcher") {
      return formatResearcherWake({ answer });
    }
    if (decision.wake === "reviewer") {
      return formatReviewerWake({ findings, packet: job.packet });
    }
    return answer;
  }

  function notifyWaiters(agentId) {
    const waiters = wakeWaiters.get(agentId) ?? [];
    wakeWaiters.delete(agentId);
    for (const waiter of waiters) waiter();
  }

  function queueWake(agentId, text, id) {
    if (!agentId) return;
    const wakeId = store.wake(agentId, text, id);
    notifyWaiters(agentId);
    return wakeId;
  }

  // Reading is non-destructive. Only an explicit acknowledgement removes a wake.
  function takeWakes(agentId) { return peekWakes(agentId); }
  function peekWakes(agentId) { return store.wakes(agentId); }
  function requeueWakes(agentId, messages) {
    for (const message of messages ?? []) queueWake(agentId, message.text ?? message, message.id);
  }

  function waitForWakes(agentId, { timeoutMs = 25_000 } = {}) {
    const existing = peekWakes(agentId);
    if (existing.length) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        remove();
        resolve(peekWakes(agentId));
      }, timeoutMs);
      const waiter = () => {
        clearTimeout(timer);
        remove();
        resolve(peekWakes(agentId));
      };
      function remove() {
        const list = wakeWaiters.get(agentId) ?? [];
        wakeWaiters.set(agentId, list.filter((item) => item !== waiter));
      }
      const list = wakeWaiters.get(agentId) ?? [];
      list.push(waiter);
      wakeWaiters.set(agentId, list);
    });
  }

  function createJob(fields) {
    const job = { id: randomUUID(), status: "running", phase: "created", createdAt: Date.now(), ledger: createLedger(), ...fields };
    job.delegationId ??= job.id;
    jobs.set(job.id, job);
    return job;
  }

  function jobByIdOrAgent(jobId, agentId) {
    if (jobId && jobs.has(jobId)) return jobs.get(jobId);
    if (!agentId) return null;
    return [...jobs.values()].find((job) => job.agentId === agentId) ?? null;
  }

  function track(promise) {
    pending.add(promise);
    promise.then(() => pending.delete(promise), error => { pending.delete(promise); console.error("Host operation failed", error); });
    return promise;
  }

  async function flush() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  async function spawnViaHelper(createOptions) {
    const { stdout } = await spawnExec(process.execPath, [SPAWN_ENTRY], {
      input: JSON.stringify(createOptions),
    });
    const parsed = parseCreatedAgentJson(stdout);
    return {
      id: parsed.id,
      workspaceId: parsed.workspaceId,
      cwd: parsed.cwd ?? createOptions.cwd,
    };
  }

  async function spawnAgent(createOptions) {
    const job = jobs.get(createOptions.labels?.job);
    if (job) { job.createOptions = createOptions; job.phase = "spawning"; save(job); }
    try { return await createAgent(createOptions); }
    catch (error) {
      let existing;
      try { existing = await reconcileChild(createOptions.labels?.job); } catch { /* Reconciliation failure never authorizes replacement. */ }
      if (existing && existing.cwd === createOptions.cwd) return existing;
      const uncertain = Object.assign(new Error(`Child creation outcome is uncertain for job ${createOptions.labels?.job}: ${error.message}`, { cause: error }), { failureClass: "uncertain" });
      if (job) { job.status = "uncertain"; job.error = uncertain.message; save(job); queueWake(job.parent, job.error, `spawn:${job.id}`); }
      throw uncertain;
    }
  }

  async function createAgent(createOptions) {
    if (!paseo && typeof options.ensurePaseo === "function") {
      await options.ensurePaseo();
    }
    if (paseo) {
      let handle;
      if (createOptions.workspaceId && typeof paseo.workspaces?.ref === "function") {
        handle = await paseo.workspaces.ref(createOptions.workspaceId).agents.create(createOptions);
      } else {
        handle = await paseo.agents.create(createOptions);
      }
      if (createOptions.worktree) {
        const cwd = await waitForCwd(handle);
        return {
          id: handle.id,
          workspaceId: handle.workspaceId,
          cwd,
        };
      }
      try {
        await handle.refresh();
      } catch {
        /* snapshot may already be present */
      }
      return {
        id: handle.id,
        workspaceId: handle.workspaceId,
        cwd: isRealCwd(handle.cwd) ? handle.cwd : createOptions.cwd,
      };
    }
    return spawnViaHelper(createOptions);
  }

  async function settleOrWake(job, { pr, message, action }) {
    const cwd = job.worktreeCwd ?? job.cwd;
    job.phase = pr ? "landing" : "committing";
    save(job);
    try {
      if (typeof options.settleWork === "function") {
        await options.settleWork(cwd, { pr, message, parent: job.parent });
        job.status = "succeeded";
        return { ok: true, action };
      }
      if (!(await git.isGitRepo(cwd))) {
        job.status = "succeeded";
        return { ok: true, action };
      }
      try {
        job.commit = await git.commitIfDirty(cwd, message);
        save(job);
      } catch (error) {
        return settlementFailure(job, "Commit", error);
      }
      if (pr) {
        const remote = await git.hasRemote(cwd);
        const label = remote ? "PR merge" : "local merge";
        try {
          if (remote) {
            job.landing = await git.createAndMergePr(cwd, { title: message, body: message, expectedHead: job.packet?.headSha ?? job.commit?.sha, checkpoint: async (phase, value) => { job.publication = { phase, ...value }; store.put("publication", `${job.id}:${phase}`, value); save(job); } });
          } else {
            job.landing = await git.fastForwardMain(cwd);
          }
        } catch (error) {
          return settlementFailure(job, label, error);
        }
      }
      job.status = pr ? "succeeded" : "running";
      job.phase = pr ? "landed" : "committed";
      save(job);
      if (pr) queueWake(job.parent, `Implementation landed at ${job.landing?.mergeSha ?? job.landing?.sha ?? job.commit?.sha ?? "the selected workspace"}${job.landing?.pr ? ` (${job.landing.pr})` : ""}.`, `${job.id}:landed`);
      return { ok: true, action };
    } catch (error) {
      return settlementFailure(job, "Commit", error);
    }
  }

  function settlementFailure(job, label, error) {
    const text = error instanceof Error ? error.message : String(error);
    const wake = `${label} failed: ${text}`;
    job.status = error.failureClass === "uncertain" ? "uncertain" : "failed";
    job.error = wake;
    save(job);
    queueWake(job.parent, wake, `${job.id}:failure`);
    return { ok: true, action: "wake_architect", error: text };
  }

  async function startArchitectSession({ cwd, title = "Architect" }) {
    await ticketRead(cwd);
    try {
      await indexWorkspace(cwd, { wait: false });
    } catch (error) {
      console.error("zg index failed", error);
    }
    const handle = await spawnAgent({
      config: {
        provider: `${ARCHITECT_PROVIDER_ID}/${ARCHITECT_MODEL_ID}`,
        thinkingOptionId: "high",
      },
      cwd,
      title,
      prompt: "Fill `.architect/ticket.md` with the operator, then delegate.",
      labels: { role: "architect" },
    });
    return { agentId: handle.id, workspaceId: handle.workspaceId };
  }

  async function ensureDaemonConfig() {
    if (!paseo?.config?.get || !paseo?.config?.patch) return { patched: false };
    const current = await paseo.config.get();
    const config = current.config ?? current;
    const profiles = Array.isArray(config.agentProfiles) ? config.agentProfiles : [];
    const profile = architectProfile();
    const mergedProfiles = profiles.some((item) => item?.id === profile.id)
      ? profiles.map((item) => (item?.id === profile.id ? { ...item, ...profile } : item))
      : [profile, ...profiles];
    await paseo.config.patch({
      providers: applyDaemonPatch({ agents: { providers: config.providers ?? {} } }).agents.providers,
      agentProfiles: mergedProfiles,
    });
    return { patched: true };
  }

  async function reconcile() {
    for (const job of jobs.values()) {
      if (job.status !== "running") continue;
      const active = store.active().filter(attempt => attempt.value.jobId === job.id);
      if (!store.get("receipt", job.id) && job.agentId) {
        let child;
        try { child = await reconcileChild(job.id); } catch {}
        if (child?.status === "running" && child.cwd === (job.worktreeCwd ?? job.cwd)) {
          job.liveness = "reconciled"; save(job); continue;
        }
      }
      if (active.some(attempt => attempt.value.kind === "command") || job.phase === "landing" || job.phase === "committing") {
        job.status = "uncertain";
        job.error = `Interrupted operation has an unknown outcome. Inspect ${job.worktreeCwd ?? job.cwd}; no command or publication was replayed.`;
        save(job); queueWake(job.parent, job.error, `reconcile:${job.id}`); continue;
      }
      if (job.phase === "completion_received") {
        track(finishChildOnce(job, store.get("completion", job.id)).then(result => { job.result = result; save(job); }));
      } else if (job.phase === "committed") {
        track(reviewOpenImplementer(job).then(result => { job.result = result; save(job); }));
      } else if (job.phase === "reviewed") {
        track(applyReviewerDecision(job, job.reviewFindings, job.packet).then(result => { job.result = result; save(job); }));
      } else {
        let child;
        try { child = await reconcileChild(job.id); } catch { /* Preserve uncertainty if the daemon is disconnected. */ }
        if (child && child.cwd === (job.worktreeCwd ?? job.cwd) && ["running", "idle", "initializing"].includes(child.status)) {
          job.agentId = child.id; job.workspaceId = child.workspaceId; job.phase = "working";
          job.liveness = "reconciled"; save(job); continue;
        }
        // A saved PID/session is evidence to investigate, never proof that replacement is safe.
        job.liveness = "uncertain"; job.status = "uncertain"; save(job);
        queueWake(job.parent, `Runner liveness is uncertain for ${job.role} ${job.id}. Existing session ${job.agentId ?? "unknown"} and work in ${job.worktreeCwd ?? job.cwd} are preserved; no replacement was started.`, `reconcile:${job.id}`);
      }
    }
  }

  let monitor;
  async function listen(port = 0) {
    server = createServer(async (req, res) => {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString("utf8");
        const payload = body ? JSON.parse(body) : {};
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname === "/jobs") { json(res, 200, { children: [...jobs.values()].filter(job => job.cwd === payload.cwd && (!payload.parentId || job.parent === payload.parentId)).map(({ id, role, agentId, status, kind, error }) => ({ id, role, agentId, status, kind, error })) }); return; }
        if (url.pathname === "/start") { json(res, 200, await startArchitectSession(payload)); return; }
        if (url.pathname === "/runner") { json(res, 200, await supervise(payload)); return; }
        if (url.pathname === "/tool-result") {
          const result = store.get("tool_result", payload.requestId);
          json(res, 200, result ? { known: true, value: result.value } : { known: false }); return;
        }
        if (url.pathname === "/health") {
          json(res, 200, { ok: true, url: hostUrl, version, draining });
          return;
        }
        if (url.pathname === "/upgrade") { draining = true; json(res, 200, { draining: true }); return; }
        if (url.pathname === "/wakes") {
          if (payload.ack) store.ack(payload.agentId, payload.ack);
          const agentId = payload.agentId ?? url.searchParams.get("agentId");
          if (Array.isArray(payload.requeue) && payload.requeue.length) {
            requeueWakes(agentId, payload.requeue);
            json(res, 200, { wakes: peekWakes(agentId) });
            return;
          }
          const wait = payload.wait === true || url.searchParams.get("wait") === "true";
          const take = payload.take !== false && url.searchParams.get("take") !== "false";
          if (wait) {
            const list = await waitForWakes(agentId);
            json(res, 200, { wakes: take ? takeWakes(agentId) : list });
            return;
          }
          json(res, 200, { wakes: take ? takeWakes(agentId) : peekWakes(agentId) });
          return;
        }
        if (url.pathname === "/ticket") {
          const cwd = payload.cwd ?? url.searchParams.get("cwd");
          json(res, 200, await ticketRead(cwd));
          return;
        }
        if (url.pathname === "/tool") {
          const result = await handleTool(payload.name, payload.arguments ?? {}, payload.context ?? {});
          json(res, 200, { result });
          return;
        }
        json(res, 404, { error: "not found" });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error), failureClass: error.failureClass ?? classifyFailure(error), attempts: error.attempts, exhausted: error.exhausted });
      }
    });
    await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    const address = server.address();
    hostUrl = `http://127.0.0.1:${address.port}`;
    await persistMeta();
    monitor = setInterval(() => {
      if (draining && !pending.size && ![...jobs.values()].some(job => ["running", "awaiting_correction"].includes(job.status))) { options.onIdleUpgrade?.(); return; }
      for (const job of jobs.values()) {
        if (job.status !== "running" || store.get("receipt", job.id) || Date.now() - (job.heartbeatAt ?? job.createdAt ?? Date.now()) < 30_000 || job.liveness === "uncertain") continue;
        let alive = false;
        try { if (job.pid) { process.kill(job.pid, 0); alive = true; } } catch {}
        job.liveness = "uncertain";
        job.diagnosis = { pidExists: alive, activity: job.activity, checkedAt: Date.now() };
        save(job);
        queueWake(job.parent, `Runner liveness is uncertain for ${job.role} while waiting on ${job.activity}. PID ${job.pid} ${alive ? "still exists" : "was not found"}; no replacement was started.`, `liveness:${job.id}`);
      }
    }, 10_000);
    monitor.unref();
    return hostUrl;
  }

  async function close() {
    clearInterval(monitor);
    for (const waiters of wakeWaiters.values()) {
      for (const waiter of waiters) waiter();
    }
    wakeWaiters.clear();
    if (!server) return;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 1000);
      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    });
  }

  return {
    setPaseo,
    hasPaseo,
    reconcile,
    listen,
    close,
    handleTool,
    startArchitectSession,
    ensureDaemonConfig,
    takeWakes,
    peekWakes,
    queueWake,
    waitForWakes,
    flush,
    jobs,
    store,
    get hostUrl() {
      return hostUrl;
    },
  };
}

export async function readHostMeta() {
  try {
    return JSON.parse(await readFile(HOST_META_PATH, "utf8"));
  } catch {
    return null;
  }
}

export async function callHost(path, payload, { signal, hostUrl } = {}) {
  const meta = { url: hostUrl ?? process.env.ARCHITECT_HOST ?? (await readHostMeta())?.url };
  if (!meta?.url) throw new Error("architect host is not listening");
  const response = await fetch(`${meta.url}${path}`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const json = await response.json();
  if (!response.ok) throw Object.assign(new Error(json.error ?? JSON.stringify(json)), { failureClass: json.failureClass, attempts: json.attempts, exhausted: json.exhausted });
  return json;
}

function json(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}
