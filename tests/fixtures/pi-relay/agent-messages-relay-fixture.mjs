/**
 * Relay compatibility fixture: the ORIGINAL Pi agent-messages receiver
 * (qq-monolith `extensions/agent-messages.ts`), adapted for the qq-workflows
 * change-record boundary.
 *
 * Source revision (provenance):
 *   repository /home/qqp/projects/.archive/qq-monolith
 *   commit     2b4b9898605144530cf385a60eca30d86bb23178
 *              ("fix: prove agent receipts from durable entries")
 *   file       extensions/agent-messages.ts (557 lines)
 *
 * The receiver mechanics are preserved from that revision: the receiver poll
 * loop, the receiveOne ordering (parse -> durable-receipt check -> dedup
 * marker -> immediate claim/abort discipline -> injection options ->
 * acknowledge only after the durable session entry is observable),
 * receiptEntryMatches, deliveryGuard, statusName, and the sendMessage option
 * selection ({triggerTurn:true} when idle / {triggerTurn:true,
 * deliverAs:"steer"} when busy) are carried over line-for-line where
 * possible. TypeScript annotations are stripped because the fixture loads as
 * plain ESM.
 *
 * Declared adaptations (deviations from the source revision; the dispatch
 * forbids restoring machine-wide presence/role discovery and requires
 * workflow-owned recipient/job/attempt identity):
 *
 *   A1. Relay client: the historical bin/lib/qq-relay-client.mjs shim (which
 *       re-exported the INSTALLED artifact) is replaced by direct resolution
 *       of the installed client at
 *       `$QQ_RELAY_INSTALL_ROOT || $HOME/.local/lib/qq/relay/client.mjs`,
 *       validating the same export set. The client is constructed lazily
 *       (async) because the installed path is only resolvable at runtime;
 *       every transport call site keeps the original operation sequence.
 *   A2. bin/lib/roles.mjs is NOT restored: the valid workflow role set is the
 *       change-record JOB_ROLES (imported from the repository's
 *       workflow/change-record.mjs, the sole workflow authority). The
 *       .pi/agent-messages.json project config file and the machine-wide
 *       repository role discovery (roleForRepository) are dropped; the role
 *       comes from QQ_AGENT_ROLE only and must be a change-record job role.
 *   A3. The machine-wide presence subsystem is NOT restored (no presence
 *       files, lease renewal, presence listing/card, busy-state bookkeeping,
 *       `list` tool action, or `agent-tasks` command). Delivery decisions use
 *       ctx.isIdle() exactly as the source revision does; the `status`
 *       action's presence card is replaced by an empty string.
 *   A4. Workflow identity mapping: `project` metadata = change-record id
 *       (QQ_AGENT_PROJECT), `role` metadata = the TARGETED job's role
 *       (QQ_RELAY_FIXTURE_TARGET_ROLE, falling back to the registered role),
 *       and `tasks` metadata carries the workflow job/attempt references.
 *       `send` accepts an optional structured `tasks` parameter so the
 *       workflow can attach amendment/revision references; without it the
 *       original session-tasks behavior is unchanged.
 *   A5. Fixture-only additions (NOT production surface, isolated at the end
 *       of this file): `fixture_acknowledge_amendment` appends
 *       worker.acknowledged to the change record after validating the pending
 *       amendment against this session's workflow identity, and
 *       `fixture_report_progress` appends worker.progress and then pushes the
 *       return-direction notification. Both refuse when the workflow
 *       environment is absent. No production tool or prompt is defined or
 *       modified here.
 *
 * The historical model-facing wrapper text of the `agent_messages` tool is
 * preserved from the source revision (minus the removed `list` clause) to
 * exercise original behavior; it is historical test provenance, not approved
 * production copy. The fixture-only model-facing strings are the dispatch's
 * fixture copy; all other text is factual status text.
 */
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { JOB_ROLES, openChange, viewsFor } from "../../../workflow/change-record.mjs";

const MESSAGE_SCHEMA = "qq.agent-message/v2";
const CUSTOM_TYPE = "qq-agent-message";
const RELAY_PRODUCT = "agents";
const MESSAGE_KIND = "agent.message";
const RECEIVE_WAIT_MS = 30_000;
const RECONNECT_MS = 500;
const IMMEDIATE_IDLE_POLL_MS = 50;
const IMMEDIATE_IDLE_TIMEOUT_MS = 5_000;
const PI_SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DSH_SESSION_ID = /^session-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SIMPLE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DELIVERY = new Set(["default", "immediate"]);
const BOUNDED_TEXT_MAX = 4096;

// Ticket fixture-only copy (not approved production prompts).
const FIXTURE_PROGRESS_NOTIFICATION =
  "Workflow progress available. Read the referenced change-record view.";

function stateHome(env = process.env) {
  const value = env.XDG_STATE_HOME;
  return value ? resolve(value) : join(resolve(env.HOME || homedir()), ".local", "state");
}

function statePaths(env = process.env) {
  const relayRoot = join(stateHome(env), "qq-relay");
  return {
    relayRoot,
    socket: join(relayRoot, "qq-relay.sock"),
    // A3: the source revision also resolved a presence directory here; the
    // fixture never reads or writes it.
    presence: join(stateHome(env), "qq", "agent-messages", "presence"),
  };
}

function slug(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  const result = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  if (!SIMPLE.test(result)) throw new Error(`${label} cannot form a readable identifier`);
  return result;
}

function bounded(value, label, maximum = BOUNDED_TEXT_MAX) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value.includes("\0")) {
    throw new Error(`${label} is malformed`);
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeTasks(value, label = "tasks") {
  if (value === undefined || value === null || value === "") return [];
  const values = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(values) || values.length > 32) throw new Error(`${label} must contain at most 32 entries`);
  const result = [];
  for (const entry of values) {
    if (typeof entry !== "string") throw new Error(`${label} entries must be strings`);
    const task = bounded(entry.trim(), `${label} entry`, 191);
    if (!result.includes(task)) result.push(task);
  }
  return result;
}

function projectFromCwd(cwd, env = process.env) {
  return slug(env.QQ_AGENT_PROJECT || basename(resolve(cwd)), "project");
}

function configuredRole(env = process.env) {
  const value = env.QQ_AGENT_ROLE;
  return value ? slug(value, "role") : undefined;
}

function validSessionId(value) {
  return PI_SESSION_ID.test(value ?? "") || DSH_SESSION_ID.test(value ?? "");
}

function relayAgentId(sessionId) {
  if (!validSessionId(sessionId)) throw new Error("session_id must be a canonical Pi or DSH session ID");
  return `${RELAY_PRODUCT}/${sessionId}`;
}

function sessionIdFromRelayAgent(value) {
  const prefix = `${RELAY_PRODUCT}/`;
  if (typeof value !== "string" || !value.startsWith(prefix)) return undefined;
  const sessionId = value.slice(prefix.length);
  return validSessionId(sessionId) ? sessionId : undefined;
}

// A2: the source revision validated the message role against bin/lib/roles.mjs
// ROLE_SET; the fixture validates against the change-record JOB_ROLES.
function validWorkflowRole(value) {
  return JOB_ROLES.includes(value);
}

function parseMessage(record) {
  const payload = record?.envelope?.payload;
  const message = payload?.message;
  if (payload?.schema !== MESSAGE_SCHEMA || typeof message !== "object" || message === null) return undefined;
  if (!validSessionId(message.from) || !sessionIdFromRelayAgent(record.recipient_id)) return undefined;
  if (!SIMPLE.test(message.project ?? "") || !validWorkflowRole(message.role)) return undefined;
  if (message.pane !== null && (typeof message.pane !== "string" || message.pane.length > 128 || message.pane.includes("\0"))) return undefined;
  if (typeof message.content !== "string" || message.content.length === 0 || message.content.length > 65_536) return undefined;
  if (!DELIVERY.has(message.delivery)) return undefined;
  let tasks;
  try { tasks = normalizeTasks(message.tasks); } catch { return undefined; }
  if (JSON.stringify(tasks) !== JSON.stringify(message.tasks)) return undefined;
  return { ...message, tasks, event_id: record.event_id, accepted_at: record.accepted_at, content_hash: sha256(message.content) };
}

function receiptDetails(message) {
  return {
    schema: MESSAGE_SCHEMA,
    event_id: message.event_id,
    content_hash: message.content_hash,
    from: message.from,
    delivery: message.delivery,
  };
}

function injectedMessageContent(message) {
  return `[message ${message.event_id} from ${message.from} — ${message.project} / ${message.role}${message.tasks.length ? ` — tasks: ${message.tasks.join(", ")}` : ""}]\n${message.content}`;
}

function receiptEntryMatches(entry, message) {
  if (entry?.type === "custom_message") {
    return entry.customType === CUSTOM_TYPE
      && entry.details?.event_id === message.event_id
      && entry.details?.content_hash === message.content_hash;
  }
  const blocks = entry?.message?.content;
  return entry?.type === "message"
    && entry.message?.role === "user"
    && Array.isArray(blocks)
    && blocks.length === 1
    && blocks[0]?.type === "text"
    && blocks[0]?.text === injectedMessageContent(message);
}

function deliveryGuard(delivery) {
  return {
    obligation_id: delivery.obligation.obligation_id,
    event_id: delivery.record.event_id,
    consumer_type: delivery.obligation.consumer_type,
    consumer_id: delivery.obligation.consumer_id,
    generation: delivery.obligation.generation,
    attempt_token: delivery.attempt_token,
    endpoint_token: delivery.endpoint_token,
    expected_high_water: delivery.guard.expected_high_water,
    expected_gap_token: delivery.guard.expected_gap_token,
  };
}

function statusName(result) {
  const statuses = (result?.obligations ?? []).map((item) => item.status);
  if (statuses.includes("in_flight")) return "delivering";
  if (statuses.includes("pending")) return "queued";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.length && statuses.every((value) => value === "acknowledged")) return "delivered";
  if (statuses.includes("expired")) return "expired";
  if (statuses.some((value) => value === "disposed" || value === "abandoned")) return "failed";
  return result?.terminal_failure ? "failed" : "queued";
}

export { normalizeTasks, parseMessage, relayAgentId, statePaths, statusName };

// A1: resolve the INSTALLED relay client the way the historical
// bin/lib/qq-relay-install-root.mjs shim did (env root, else $HOME default),
// then validate the same export set bin/lib/qq-relay-client.mjs validated.
async function loadInstalledRelayClient(env = process.env) {
  const configured = env.QQ_RELAY_INSTALL_ROOT;
  if (configured !== undefined && (typeof configured !== "string" || configured.length === 0 || !configured.startsWith("/"))) {
    throw new Error("QQ_RELAY_INSTALL_ROOT must be an absolute path");
  }
  const home = env.HOME;
  if (typeof home !== "string" || home.length === 0 || !home.startsWith("/")) {
    throw new Error("HOME must be an absolute path when QQ_RELAY_INSTALL_ROOT is unset");
  }
  const root = configured || join(home, ".local", "lib", "qq", "relay");
  const clientPath = join(root, "client.mjs");
  const client = await import(pathToFileURL(clientPath).href);
  for (const name of ["QQ_RELAY_PROTOCOL", "RelayClient", "RelayError", "canonicalRelayJson"]) {
    if (!(name in client)) throw new Error(`qq-relay installed client does not export ${name}: ${clientPath}`);
  }
  return client;
}

export default function register(pi, deps = {}) {
  const env = deps.env ?? process.env;
  const paths = deps.paths ?? statePaths(env);
  const now = deps.now ?? (() => Date.now()); // preserved dependency seam from the source revision
  const sleep = deps.sleep ?? ((milliseconds) => new Promise((done) => setTimeout(done, milliseconds)));
  let active = false;
  let epoch = 0;
  let current;
  let currentContext;
  let tasks = [];
  const injectedMessages = deps.injectedMessages ?? new Set();
  // A1: the client is resolved lazily from the installed artifact; deps.client
  // keeps the historical injection seam for tests.
  let clientInstance = deps.client ?? null;
  let clientPromise = null;
  async function getClient() {
    if (clientInstance) return clientInstance;
    if (!clientPromise) {
      clientPromise = loadInstalledRelayClient(env).then((module) => {
        clientInstance = new module.RelayClient(paths.socket);
        return clientInstance;
      });
      clientPromise.catch(() => {});
    }
    return clientPromise;
  }

  function receiptExists(message) {
    let entries;
    try { entries = currentContext?.sessionManager?.getEntries?.(); }
    catch { return false; }
    return Array.isArray(entries) && entries.some((entry) => receiptEntryMatches(entry, message));
  }

  async function claimImmediate(message) {
    const client = await getClient();
    const result = await client.publish({
      producer_id: relayAgentId(message.from),
      request_id: `immediate_${message.event_id}`,
      origin_id: relayAgentId(message.from),
      product_id: RELAY_PRODUCT,
      kind: "agent.immediate-claim",
      schema_version: 1,
      correlation_id: message.event_id,
      payload: { schema: MESSAGE_SCHEMA, event_id: message.event_id, content_hash: message.content_hash },
    });
    return result.idempotent !== true;
  }

  async function waitUntilIdle(context) {
    for (let waited = 0; waited < IMMEDIATE_IDLE_TIMEOUT_MS; waited += IMMEDIATE_IDLE_POLL_MS) {
      if (context.isIdle?.() !== false) return true;
      await sleep(IMMEDIATE_IDLE_POLL_MS);
    }
    return context.isIdle?.() !== false;
  }

  async function receiveOne(delivery, localEpoch) {
    const message = parseMessage(delivery.record);
    if (!message) {
      const client = await getClient();
      await client.block({ ...deliveryGuard(delivery), reason: "unsupported agent message payload" });
      return;
    }
    const injectionKey = `${message.event_id}:${message.content_hash}`;
    if (receiptExists(message)) {
      const client = await getClient();
      await client.acknowledge(deliveryGuard(delivery));
      injectedMessages.delete(injectionKey);
      return;
    }
    if (injectedMessages.has(injectionKey)) {
      const client = await getClient();
      await client.retry({ ...deliveryGuard(delivery), reason: "durable session entry not yet observable" });
      return;
    }
    if (!active || localEpoch !== epoch || !currentContext) return;
    const context = currentContext;
    injectedMessages.add(injectionKey);
    let waitedForImmediateIdle = false;
    if (message.delivery === "immediate" && context.isIdle?.() === false) {
      const claimed = await claimImmediate(message);
      if (claimed) {
        try { context.abort?.(); } catch {}
      }
      waitedForImmediateIdle = await waitUntilIdle(context);
      if (!waitedForImmediateIdle) {
        injectedMessages.delete(injectionKey);
        const client = await getClient();
        await client.retry({ ...deliveryGuard(delivery), reason: "Pi did not become idle after immediate abort" });
        return;
      }
    }
    const options = waitedForImmediateIdle || context.isIdle?.() !== false
      ? { triggerTurn: true }
      : { triggerTurn: true, deliverAs: "steer" };
    try {
      await (deps.sendMessage ?? pi.sendMessage.bind(pi))({
        customType: CUSTOM_TYPE,
        content: injectedMessageContent(message),
        display: true,
        details: receiptDetails(message),
      }, options);
    } catch (error) {
      injectedMessages.delete(injectionKey);
      throw error;
    }
    if (receiptExists(message)) {
      const client = await getClient();
      await client.acknowledge(deliveryGuard(delivery));
      injectedMessages.delete(injectionKey);
    } else {
      const client = await getClient();
      await client.retry({ ...deliveryGuard(delivery), reason: "durable session entry not yet observable" });
    }
  }

  async function receiver(localEpoch) {
    const endpoint = `agent-messages/${randomUUID()}`;
    while (active && localEpoch === epoch && current) {
      try {
        const client = await getClient();
        const result = await client.next({ consumer_type: "recipient", consumer_id: relayAgentId(current.session_id), generation: 0, endpoint_token: endpoint, wait_ms: RECEIVE_WAIT_MS });
        if (result?.delivery) await receiveOne(result.delivery, localEpoch);
      } catch {
        if (active && localEpoch === epoch) await sleep(RECONNECT_MS);
      }
    }
  }

  // A4: workflow job/attempt references as structured message metadata.
  function workflowTaskRefs(env) {
    const refs = [];
    for (const [key, prefix] of [["QQ_RELAY_FIXTURE_JOB_ID", "job"], ["QQ_RELAY_FIXTURE_ATTEMPT_ID", "attempt"]]) {
      const value = env[key];
      if (typeof value === "string" && value.trim() !== "") refs.push(`${prefix}:${value.trim()}`);
    }
    return refs;
  }

  async function start(_event, ctx) {
    currentContext = ctx;
    // A2: the source revision read .pi/agent-messages.json and resolved the
    // role through machine-wide repository discovery; the workflow supplies
    // the job role directly through the environment.
    const role = configuredRole(env);
    if (!role) return;
    if (!validWorkflowRole(role)) throw new Error(`QQ_AGENT_ROLE '${role}' is not a change-record job role`);
    const sessionId = ctx.sessionManager?.getSessionId?.();
    if (typeof sessionId !== "string" || sessionId === "") return;
    const project = projectFromCwd(ctx.cwd, env);
    if (!validSessionId(sessionId)) throw new Error("host supplied a non-canonical session ID");
    current = { session_id: sessionId, project, role, pane: null };
    active = true;
    epoch += 1;
    const localEpoch = epoch;
    tasks = workflowTaskRefs(env);
    void receiver(localEpoch);
  }

  async function stop() {
    active = false;
    epoch += 1;
    injectedMessages.clear();
    current = undefined;
    currentContext = undefined;
    tasks = [];
  }

  pi.registerTool({
    name: "agent_messages",
    // Historical wrapper text from the source revision, minus the removed
    // `list` action sentence (A3). Historical test provenance, not approved
    // production copy.
    label: "Agent messages",
    description: "Send one durable message to another live messaging session, or inspect delivery status. A recipient is identified only by its canonical host session_id. Project, role, and optional tasks are workflow identity metadata: for example, 'the qq runner on T-12' means project qq, role runner, and task T-12. If multiple candidates remain, ask rather than guess. Copy the complete session_id unchanged. Use immediate delivery only when the recipient must see the message now; it interrupts their current run.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        action: { type: "string", enum: ["send", "status"] },
        to: { type: "string", description: "Recipient's complete canonical host session_id, for example 019ff7b9-2fcd-78cd-bc16-c770a9ccff11 or session-4b70f906-ce0a-4135-bc9e-b231db9b98b1. Copy it unchanged; project and role are not part of this ID." },
        message: { type: "string" },
        delivery: { type: "string", enum: ["default", "immediate"] },
        message_id: { type: "string" },
        // A4: optional structured workflow references attached to the message
        // metadata (additive; absent keeps the original behavior).
        tasks: { type: "array", items: { type: "string" }, description: "Optional workflow reference labels attached as message metadata." },
      },
      required: ["action"],
    },
    async execute(_id, params) {
      try {
        if (params.action === "send") {
          if (!current) throw new Error("this session is not registered; set QQ_AGENT_ROLE before starting Pi");
          if (!validSessionId(params.to)) throw new Error("send requires the complete session_id returned by list");
          const content = bounded(params.message, "message", 65_536);
          const delivery = params.delivery ?? "default";
          if (!DELIVERY.has(delivery)) throw new Error("delivery must be default or immediate");
          const messageTasks = params.tasks === undefined ? tasks : normalizeTasks(params.tasks);
          // A4: the metadata role names the TARGETED job's role when the
          // workflow provides one; otherwise the registered role is kept.
          const role = env.QQ_RELAY_FIXTURE_TARGET_ROLE ? slug(env.QQ_RELAY_FIXTURE_TARGET_ROLE, "target role") : current.role;
          if (!validWorkflowRole(role)) throw new Error("target role is not a change-record job role");
          const requestId = `msg_${randomUUID()}`;
          const client = await getClient();
          const result = await client.send({
            producer_id: relayAgentId(current.session_id), request_id: requestId, origin_id: relayAgentId(current.session_id),
            recipient_id: relayAgentId(params.to), product_id: RELAY_PRODUCT, kind: MESSAGE_KIND, schema_version: 1,
            payload: { schema: MESSAGE_SCHEMA, message: { from: current.session_id, project: current.project, role, tasks: messageTasks, pane: current.pane, content, delivery } },
          });
          const messageId = result.record.event_id;
          const state = statusName(await client.status({ event_id: messageId, wait_ms: 0 }));
          return { content: [{ type: "text", text: `message sent: ${messageId}` }], details: { status: state, message_id: messageId, to: params.to, delivery, tasks: messageTasks } };
        }
        if (params.action === "status") {
          bounded(params.message_id, "message_id", 128);
          const client = await getClient();
          const result = await client.status({ event_id: params.message_id, wait_ms: 0 });
          const state = statusName(result);
          const reasons = (result.obligations ?? []).map((item) => item.last_reason).filter(Boolean);
          const showReasons = ["blocked", "expired", "failed"].includes(state);
          // A3: the source revision attached a presence card here; the fixture
          // has no presence subsystem and reports transport status only.
          const card = "";
          const text = [`Message ${params.message_id} is ${state}${showReasons && reasons.length ? `: ${reasons.join("; ")}` : ""}.`, card].filter(Boolean).join("\n");
          return { content: [{ type: "text", text }], details: { status: state, message_id: params.message_id, card, result } };
        }
        throw new Error("action must be send or status");
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Agent messages refused: ${reason}` }], details: { status: "refused", reason } };
      }
    },
  });

  pi.on("session_start", start);
  pi.on("session_shutdown", stop);

  registerFixtureTools(pi, { env, getClient, currentRef: () => current, workflowTaskRefs });

  // A3: the source revision also tracked busy state (agent_start /
  // agent_settled / tool_execution_start / tool_execution_end) and the
  // qq:role-selected event for presence cards and discovery; the fixture does
  // not restore that machine-wide surface.
}

// ---------------------------------------------------------------------------
// Fixture-only tools (A5). These are NOT production surface: they exist so a
// deterministic test provider can drive change-record acknowledgements and the
// return-direction proof without any production tool or prompt change. They
// refuse when the workflow environment is absent.
// ---------------------------------------------------------------------------

function fixtureContext(env) {
  let changeId;
  try {
    changeId = env.QQ_AGENT_PROJECT ? slug(env.QQ_AGENT_PROJECT, "change id") : undefined;
  } catch {
    return null;
  }
  const stateDir = env.QQ_RELAY_FIXTURE_STATE_DIR;
  const jobId = env.QQ_RELAY_FIXTURE_JOB_ID;
  const attemptId = env.QQ_RELAY_FIXTURE_ATTEMPT_ID;
  if (!stateDir || !changeId || !jobId || !attemptId) return null;
  return { stateDir, changeId, jobId, attemptId };
}

function fixtureRefusal(reason) {
  return { content: [{ type: "text", text: `Fixture action refused: ${reason}` }], details: { status: "refused", reason } };
}

function registerFixtureTools(pi, { env, getClient, currentRef, workflowTaskRefs }) {
  const actorId = env.QQ_RELAY_FIXTURE_ACTOR_ID && env.QQ_RELAY_FIXTURE_ACTOR_ID.length <= 200
    ? env.QQ_RELAY_FIXTURE_ACTOR_ID
    : null;

  pi.registerTool({
    name: "fixture_acknowledge_amendment",
    label: "Acknowledge amendment (fixture)",
    description: "Fixture-only test action. Acknowledge one pending assignment amendment for this session's workflow job and attempt, after reading its exact revision. Refuses when the amendment is not pending for this job and attempt or the revision does not match.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        amendment_id: { type: "string", description: "The amendment reference from the envelope metadata." },
        revision: { type: "integer", description: "The exact assignment revision read from the referenced envelope." },
      },
      required: ["amendment_id", "revision"],
    },
    async execute(_id, params) {
      const fx = fixtureContext(env);
      if (!fx) return fixtureRefusal("the fixture workflow environment (QQ_RELAY_FIXTURE_*) is not configured");
      if (!actorId) return fixtureRefusal("no fixture actor identity is configured");
      if (typeof params.amendment_id !== "string" || params.amendment_id.trim() === "") {
        return fixtureRefusal("amendment_id is required");
      }
      if (!Number.isInteger(params.revision)) return fixtureRefusal("revision must be an integer");
      const amendmentId = params.amendment_id.trim();
      try {
        const handle = openChange({ stateDir: fx.stateDir, changeId: fx.changeId });
        const job = viewsFor(handle.state).job(fx.jobId);
        const amendment = job.amendments.find((entry) => entry.amendmentId === amendmentId);
        if (!amendment) {
          return fixtureRefusal(`amendment '${amendmentId}' is not submitted on job '${fx.jobId}'`);
        }
        if (amendment.targetedAttemptId !== fx.attemptId) {
          return fixtureRefusal(`amendment '${amendmentId}' targets attempt '${amendment.targetedAttemptId}', not this session's attempt '${fx.attemptId}'`);
        }
        if (amendment.revision !== params.revision) {
          return fixtureRefusal(`amendment '${amendmentId}' targets revision ${amendment.revision}, not ${params.revision}`);
        }
        // Idempotent by construction: the deterministic command ID makes a
        // duplicate acknowledgement a change-record dedupe, never a second
        // semantic event.
        const result = handle.append(
          "worker.acknowledged",
          { revision: params.revision, note: `acknowledged amendment ${amendmentId} (revision ${params.revision})` },
          {
            context: { actor: { kind: "worker", id: actorId }, jobId: fx.jobId, attemptId: fx.attemptId },
            commandId: `ack-${amendmentId}-rev${params.revision}`,
          },
        );
        const after = viewsFor(handle.state).job(fx.jobId).amendments.find((entry) => entry.amendmentId === amendmentId);
        return {
          content: [{ type: "text", text: `Amendment ${amendmentId} (revision ${params.revision}) ${result.dedupe ? "already acknowledged" : "acknowledged"} at record seq ${after?.acknowledged?.seq ?? result.seq}.` }],
          details: { status: "ok", committed: result.committed, dedupe: result.dedupe, seq: result.seq, amendment: after },
        };
      } catch (error) {
        return fixtureRefusal(error instanceof Error ? error.message : String(error));
      }
    },
  });

  pi.registerTool({
    name: "fixture_report_progress",
    label: "Report progress (fixture)",
    description: "Fixture-only test action. Commit one worker.progress entry to this session's change record and then push one progress notification to the workflow-recipient session. The change-record commit happens before the push.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        note: { type: "string", description: "Bounded progress note committed to the change record." },
      },
      required: ["note"],
    },
    async execute(_id, params) {
      const fx = fixtureContext(env);
      if (!fx) return fixtureRefusal("the fixture workflow environment (QQ_RELAY_FIXTURE_*) is not configured");
      if (!actorId) return fixtureRefusal("no fixture actor identity is configured");
      if (typeof params.note !== "string" || params.note.length === 0 || params.note.length > 512 || params.note.includes("\0")) {
        return fixtureRefusal("note must be a string of at most 512 characters");
      }
      const sender = currentRef();
      if (!sender) return fixtureRefusal("this session is not registered; the notification push has no sender identity");
      const recipient = env.QQ_RELAY_FIXTURE_RECIPIENT_AGENT;
      if (typeof recipient !== "string" || recipient.trim() === "") {
        return fixtureRefusal("no workflow recipient is configured for the return direction");
      }
      const recipientSession = sessionIdFromRelayAgent(recipient.trim()) ?? (validSessionId(recipient.trim()) ? recipient.trim() : undefined);
      if (!recipientSession) return fixtureRefusal("the configured workflow recipient is not a canonical session id");
      try {
        // The change record is the sole workflow authority: the progress
        // event is committed BEFORE any notification is pushed.
        const handle = openChange({ stateDir: fx.stateDir, changeId: fx.changeId });
        const progress = handle.append(
          "worker.progress",
          { note: params.note },
          { context: { actor: { kind: "worker", id: actorId }, jobId: fx.jobId, attemptId: fx.attemptId } },
        );
        const role = env.QQ_RELAY_FIXTURE_TARGET_ROLE ? slug(env.QQ_RELAY_FIXTURE_TARGET_ROLE, "target role") : sender.role;
        if (!validWorkflowRole(role)) return fixtureRefusal("target role is not a change-record job role");
        const tasks = [...workflowTaskRefs(env), `progress:${progress.seq}`];
        const client = await getClient();
        const sent = await client.send({
          producer_id: relayAgentId(sender.session_id), request_id: `msg_${randomUUID()}`, origin_id: relayAgentId(sender.session_id),
          recipient_id: relayAgentId(recipientSession), product_id: RELAY_PRODUCT, kind: MESSAGE_KIND, schema_version: 1,
          payload: { schema: MESSAGE_SCHEMA, message: { from: sender.session_id, project: sender.project, role, tasks, pane: null, content: FIXTURE_PROGRESS_NOTIFICATION, delivery: "default" } },
        });
        const messageId = sent.record.event_id;
        const state = statusName(await client.status({ event_id: messageId, wait_ms: 0 }));
        return {
          content: [{ type: "text", text: `Progress committed at record seq ${progress.seq}; notification ${messageId} is ${state}.` }],
          details: { status: "ok", progress: { seq: progress.seq, eventId: progress.eventId }, notification: { message_id: messageId, status: state, tasks } },
        };
      } catch (error) {
        return fixtureRefusal(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
