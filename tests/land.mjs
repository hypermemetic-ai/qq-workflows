#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const reviewModule = await import(pathToFileURL(join(root, "src/routing.mjs")));
const landModule = await import(pathToFileURL(join(root, "src/land.mjs")));
const landStoreModule = await import(pathToFileURL(join(root, "src/land-store.mjs")));
const landToolsModule = await import(pathToFileURL(join(root, "src/land-tools.mjs")));
const childSettlementModule = await import(pathToFileURL(join(root, "src/child-settlement.mjs")));
const architectModule = await import(pathToFileURL(join(root, "src/architect.mjs")));
const toolsModule = await import(pathToFileURL(join(root, "src/tools.mjs")));
const pluginModule = await import(pathToFileURL(join(root, "src/plugin.mjs")));
const officialMiniModule = await import(pathToFileURL(join(root, "src/official-mini.mjs")));
const miniReviewModule = await import(pathToFileURL(join(root, "src/mini-review.mjs")));

const {
  stampFromEvidence,
  routePacket,
  parseRouteStamp,
  ROUTE_PACKET_SCHEMA,
  isTestPath,
} = reviewModule;
const { createLand, LAND_LABEL, isLandCandidate, ROUTE_SYSTEM, runCommand } = landModule;
const { createLandStore, LAND_RUN_SCHEMA } = landStoreModule;
const { buildDoneTool, DONE_TOOL_NAME } = landToolsModule;
const { withChildSettlement } = childSettlementModule;
const { createArchitect, CHILD_ORIGIN } = architectModule;
const { buildArchitectTools } = toolsModule;
const { MINI_KIND, MINI_SWE_COMPLETION_COMMAND, wrapMiniBash } = officialMiniModule;
const { MINI_REVIEW_KIND, MINI_REVIEW_TOOL_NAMES } = miniReviewModule;

const scratch = mkdtempSync(join(tmpdir(), "qq-land."));
const sessionId = (marker) =>
  `session-63a11000-0000-4000-8000-${String(marker).padStart(12, "0")}`;
const architectId = sessionId("000000000001");
const implementerId = sessionId("0000000000aa");

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "land-test",
    GIT_AUTHOR_EMAIL: "land@test",
    GIT_COMMITTER_NAME: "land-test",
    GIT_COMMITTER_EMAIL: "land@test",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
}

function initRepo({ branch = "feat/change" } = {}) {
  const rootDir = mkdtempSync(join(scratch, "git-"));
  const main = join(rootDir, "repo");
  const worktree = join(rootDir, "wt");
  mkdirSync(main);
  git(main, ["init", "-b", "main"]);
  git(main, ["config", "user.name", "land-test"]);
  git(main, ["config", "user.email", "land@test"]);
  git(main, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(main, "README.md"), "hello\n");
  git(main, ["add", "README.md"]);
  git(main, ["commit", "-m", "init"]);
  git(main, ["worktree", "add", "-q", "-b", branch, worktree]);
  return { rootDir, main, worktree, branch, baseRef: git(main, ["rev-parse", "HEAD"]) };
}

function commitFile(worktree, relative, contents, message) {
  const path = join(worktree, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  git(worktree, ["add", relative]);
  git(worktree, ["commit", "-m", message]);
  return git(worktree, ["rev-parse", "HEAD"]);
}

function packet(brief, files) {
  return {
    schema: ROUTE_PACKET_SCHEMA,
    brief,
    files: files.map((path) => ({ path, added: 1, deleted: 0 })),
    pointers: [],
    mark: null,
  };
}

function childAgent({ id, cwd, registered, restricted, followups, listeners, origin = CHILD_ORIGIN, onFollowup, claimFollowup = false }) {
  const inbox = { nextTurn: [], nextStep: [] };
  const sections = [];
  const toolService = {
    register(definition) {
      registered?.push(definition);
      return () => {
        const at = registered?.indexOf(definition) ?? -1;
        if (at >= 0) registered.splice(at, 1);
      };
    },
    restrict(spec) {
      const record = { id, spec, active: true };
      restricted?.push(record);
      return () => { record.active = false; };
    },
    get(name) { return registered?.find((tool) => tool.name === name); },
  };
  const systemPrompt = {
    section(section) {
      sections.push(section);
      return () => {
        const at = sections.indexOf(section);
        if (at >= 0) sections.splice(at, 1);
      };
    },
    suppressRuntimeContext() {},
  };
  const child = {
    status: "idle",
    session: {
      id,
      header: { cwd, origin, parentSession: architectId },
      events: [],
    },
    inbox,
    followup(message) {
      child.status = "running";
      const already = inbox.nextTurn.some((candidate) => candidate?.id === message?.id)
        || child.session.events.some((event) =>
          (event?.type === "user/message" && (event.data?.id === message?.id || event.data?.message?.id === message?.id))
          || (event?.type === "agent/inbox/spliced"
            && (event.data?.inserted ?? []).some((candidate) => candidate?.id === message?.id)));
      if (!already) {
        child.session.events.push({
          type: "agent/inbox/spliced",
          data: { target: "next-turn", start: 0, inserted: [message] },
        });
        followups?.push({ id, message });
        if (claimFollowup) {
          child.session.events.push({
            type: "agent/inbox/spliced",
            data: { target: "next-turn", start: 0, removedCount: 1, inserted: [] },
          });
        } else {
          inbox.nextTurn.push(message);
        }
      }
      onFollowup?.({ child, message });
    },
    ctx: {
      tools: toolService,
      systemPrompt,
      on(type, fn) {
        const record = { type, fn };
        listeners?.push(record);
        return () => {
          const at = listeners?.indexOf(record) ?? -1;
          if (at >= 0) listeners.splice(at, 1);
        };
      },
      get(name) {
        if (name === "tools") return toolService;
        if (name === "systemPrompt") return systemPrompt;
        return undefined;
      },
    },
  };
  return child;
}

function qaTool(record) {
  return record.registered.find((tool) => tool.name === "submit_review");
}

function legacyReviewArgs(land, record, args) {
  if (Array.isArray(args?.findings)) return args;
  if (args?.verdict === "pass") return { findings: [] };
  const state = land.bySession(record.child.session.id);
  const diff = git(record.child.session.header.cwd, ["diff", "-U0", "--no-color", `${state.baseRef}...${state.ref}`, "--"]);
  let path = "";
  let headLine = 0;
  let fallback;
  for (const row of diff.split("\n")) {
    const file = row.match(/^\+\+\+ (?:b\/)?(.*)$/);
    if (file) {
      path = file[1] === "/dev/null" ? "" : file[1];
      continue;
    }
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      headLine = Number(hunk[1]);
      if (path && Number(hunk[2]) === 0) fallback ??= { path, line: headLine };
      continue;
    }
    if (row.startsWith("+") && !row.startsWith("+++") && path) {
      fallback = { path, line: headLine };
      break;
    }
    if (row.startsWith(" ")) headLine++;
  }
  assert.ok(fallback, "QA failure fixture needs a changed HEAD line");
  return { findings: [{ ...fallback, body: args?.feedback || args?.summary || "concrete defect" }] };
}

function assertMiniReviewMounted(record, { owned = true } = {}) {
  assert.deepEqual(record.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
  const types = record.listeners.map((item) => item.type);
  assert.ok(types.includes("agent/turn-stopping"), "mini-review format recovery remains mounted");
  assert.ok(types.includes("session/event"), "mini-review observes assistant tool calls");
  if (owned) assert.ok(types.includes("agent/status"), "Land owns the live reviewer lifecycle");
}

let qaCallSequence = 0;

async function executeQaTool(land, record, args, { isError = false, duplicateResults = 0, tool = qaTool(record) } = {}) {
  const callId = `qa-call-${++qaCallSequence}`;
  let concluded = 0;
  const result = await tool.execute(legacyReviewArgs(land, record, args), {
    agent: record.child,
    callId,
    concludeTurn() {
      concluded++;
      record.child.status = "idle";
      for (const listener of [...record.listeners].filter((item) => item.type === "agent/status")) {
        listener.fn({ status: "idle" });
      }
    },
  });
  if (result.status === "refused") return result;
  assert.equal(concluded, 1);
  const event = {
    type: "tool/result",
    data: {
      message: {
        source: { kind: "tool", callId },
        content: [{ type: "tool-result", toolCallId: callId, isError }],
      },
    },
  };
  for (let delivery = 0; delivery <= duplicateResults; delivery += 1) {
    record.child.session.events.push(event);
    for (const listener of [...record.listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(record.child.session, event);
    }
  }
  await land.whenSettled(record.child.session.id);
  return result;
}

function createHarness({ complete, worktree, tasks, parentHeader = {}, run, store: suppliedStore, onCreate, onChildFollowup, onHang, claimFollowup = false } = {}) {
  const sent = [];
  const created = [];
  const followups = [];
  const restricted = [];
  const disposed = [];
  const hung = [];
  const cleared = [];
  const labelBags = new Map();
  const children = new Map();
  const parentInbox = { nextTurn: [], nextStep: [] };
  const parent = {
    session: { id: architectId, header: { cwd: worktree ?? scratch, ...parentHeader }, events: [] },
    inbox: parentInbox,
    steer(message) {
      parentInbox.nextStep.push(message);
      const text = (message?.content ?? []).filter((block) => block?.type === "text").map((block) => block.text).join("");
      sent.push({ to: architectId, delivery: "direct", message: text });
    },
  };
  const store = suppliedStore ?? createLandStore(mkdtempSync(join(scratch, "runs-")));
  const relay = {
    hang(id, label) {
      hung.push({ id, label });
      if (!labelBags.has(id)) labelBags.set(id, new Set());
      labelBags.get(id).add(label);
      onHang?.({ id, label });
    },
    clear(id, label) {
      cleared.push({ id, label });
      const removed = labelBags.get(id)?.delete(label) ?? false;
      if (labelBags.get(id)?.size === 0) labelBags.delete(id);
      return removed;
    },
    release(id) { return labelBags.delete(id); },
    labelsFor(id) { return [...(labelBags.get(id) ?? [])].sort(); },
    alias: (id) => (id === architectId ? "1" : "80"),
    send: async (payload) => {
      if (payload.messageId && !parentInbox.nextStep.some((message) => message.id === payload.messageId)
        && !parent.session.events.some((event) => event.data?.id === payload.messageId)) {
        parentInbox.nextStep.push({
          id: payload.messageId,
          role: "user",
          content: [{ type: "text", text: payload.message }],
          source: { kind: "plugin", plugin: "qq-relay", form: "relay" },
        });
      }
      sent.push(payload);
      return { status: "sent", message_id: payload.messageId };
    },
  };
  const agentService = {
    get: (id) => (id === architectId ? parent : children.get(id)?.live === false ? undefined : children.get(id)?.child),
    list: () => [parent, ...[...children.values()].filter((record) => record.live !== false).map((record) => record.child)],
    create: async (options) => {
      onCreate?.(options);
      created.push(options);
      const registered = [];
      const listeners = [];
      const child = childAgent({
        id: options.sessionId,
        cwd: options.meta?.cwd ?? worktree,
        registered,
        restricted,
        followups,
        listeners,
        onFollowup: onChildFollowup,
        claimFollowup,
      });
      Object.assign(child.session.header, {
        landRole: options.meta?.landRole,
        landWorkflowRole: options.meta?.landWorkflowRole,
        landRun: options.meta?.landRun,
        landDelegation: options.meta?.landDelegation,
        landPhaseEpoch: options.meta?.landPhaseEpoch,
        kind: options.meta?.kind,
        agentPreset: options.meta?.agentPreset,
      });
      if (options.meta?.kind === MINI_REVIEW_KIND) options.setup?.(child.ctx);
      const record = { child, registered, options, listeners, live: true };
      children.set(options.sessionId, record);
      return {
        agent: child,
        async dispose() {
          if (!record.live) return;
          record.live = false;
          disposed.push(options.sessionId);
        },
      };
    },
  };
  const harnessCtx = {
    get(name) {
      if (name === "qq-relay") return relay;
      return null;
    },
  };
  const harnessSettings = {
    get: (role) => ({ provider: "test", model: role || "land" }),
  };
  const land = createLand({
    ctx: harnessCtx,
    store,
    settings: harnessSettings,
    tasks,
    complete,
    agents: agentService,
    run,
  });
  return {
    land, store, sent, created, followups, restricted, children, disposed, parent,
    hung, cleared, relay, ctx: harnessCtx, settings: harnessSettings, agents: agentService,
  };
}

try {
  assert.equal(LAND_LABEL, "workflows:land");
  assert.equal(LAND_RUN_SCHEMA, "qq.land-run/v1");
  assert.match(ROUTE_SYSTEM, /exactly land or review/);
  assert.equal(isLandCandidate({ session: { id: architectId, header: {} } }), true);
  assert.equal(isLandCandidate({ session: { id: implementerId, header: { origin: CHILD_ORIGIN } } }), false);
  assert.equal(isLandCandidate({ session: { id: implementerId, header: { parentSession: architectId } } }), false);
  assert.deepEqual(
    buildArchitectTools({}).map((tool) => tool.name).sort(),
    ["delegate", "workflow_send", "workflow_status"],
  );
  assert.ok(!buildArchitectTools({}).some((tool) => ["done", "qa_verdict", "submit_review", "land"].includes(tool.name)));
  assert.equal(isTestPath("tests/test-qq-land.mjs"), true);
  assert.equal(isTestPath("core/src/session.mjs"), false);

  // Child settlement must be armed before conclude can synchronously emit idle.
  {
    async function verifyOrder(name, build, args) {
      const order = [];
      const tool = build(async () => withChildSettlement({ status: "ok" }, {
        arm() { order.push("arm"); },
      }));
      const result = await tool.execute(args, {
        agent: { session: { id: implementerId } },
        callId: `${name}-call`,
        concludeTurn() { order.push("conclude"); },
      });
      assert.equal(result.status, "ok");
      assert.deepEqual(order, ["arm", "conclude"], `${name} must arm before conclude`);
    }
    await verifyOrder("done", (submit) => buildDoneTool({ submit }), {});
  }

  // ---------------------------------------------------------------- route stamp land vs review
  {
    assert.equal(
      stampFromEvidence(packet("tweak the css color", ["qq-ui/assets/console.css"])),
      "land",
    );
    assert.equal(
      stampFromEvidence(packet("copy on the empty state", ["copy.txt"])),
      "review",
    );
    assert.equal(
      stampFromEvidence(packet("tweak the css color", ["core/src/session.mjs"])),
      "review",
    );
    assert.equal(
      stampFromEvidence(packet("wire qq-relay default steer", ["qq-ui/assets/console.css"])),
      "review",
    );
    assert.equal(
      stampFromEvidence(packet("small comment", ["bin/lib/review.mjs"])),
      "review",
    );
    assert.equal(
      stampFromEvidence(packet("unspecified change", ["src/foo.mjs"])),
      "review",
    );
  }

  // ---------------------------------------------------------------- old records gain one durable delegation identity safely
  {
    const legacyDir = mkdtempSync(join(scratch, "legacy-delegation-"));
    const legacyFile = join(legacyDir, "land-legacy01.json");
    writeFileSync(legacyFile, `${JSON.stringify({
      schema: LAND_RUN_SCHEMA,
      version: 1,
      id: "land-legacy01",
      status: "running",
      look: 0,
      architectSession: architectId,
      implementerSession: implementerId,
      originalImplementerSession: implementerId,
    }, null, 2)}\n`);
    const legacyStore = createLandStore(legacyDir);
    const first = legacyStore.load("land-legacy01");
    assert.match(first.delegationId, /^[0-9a-f-]{36}$/);
    assert.equal(first.parentSessionUuid, architectId);
    assert.equal(first.phaseEpoch, 1);
    assert.deepEqual(first.current, {
      sessionUuid: implementerId,
      role: "implementer",
      phaseEpoch: 1,
    });
    const persisted = JSON.parse(readFileSync(legacyFile, "utf8"));
    assert.equal(persisted.delegationId, first.delegationId);
    assert.equal(legacyStore.load("land-legacy01").delegationId, first.delegationId);
    assert.equal(legacyStore.byDelegation(first.delegationId).id, first.id);
    assert.throws(
      () => legacyStore.save({ ...first, delegationId: "81000000-0000-4000-8000-000000000010" }),
      /delegation id is immutable/,
    );
    assert.throws(
      () => legacyStore.save({ ...first, parentSessionUuid: sessionId("000000000098") }),
      /parent session is immutable/,
    );
    assert.throws(
      () => legacyStore.save({ ...first, phaseEpoch: 0, current: null }),
      /phase epoch cannot regress/,
    );

    const pending = legacyStore.save({
      ...first,
      transitioning: true,
      pendingPhase: {
        sessionUuid: sessionId("000000000097"),
        role: "qa-look-1",
        phaseEpoch: 2,
        messageId: "81000000-0000-4000-8000-000000000097",
        message: "durable QA packet",
        messageDelivered: false,
      },
    });
    assert.throws(
      () => legacyStore.save({
        ...pending,
        pendingPhase: { ...pending.pendingPhase, message: "rewritten packet" },
      }),
      /pending phase is immutable/,
    );
    assert.throws(
      () => legacyStore.save({
        ...pending,
        phaseEpoch: 2,
        current: {
          sessionUuid: pending.pendingPhase.sessionUuid,
          role: pending.pendingPhase.role,
          phaseEpoch: 2,
        },
        transitioning: false,
        pendingPhase: null,
      }),
      /cannot promote an unseeded pending phase/,
    );
    const delivered = legacyStore.save({
      ...pending,
      pendingPhase: { ...pending.pendingPhase, messageDelivered: true },
    });
    assert.throws(
      () => legacyStore.save({
        ...delivered,
        pendingPhase: { ...delivered.pendingPhase, messageDelivered: false },
      }),
      /delivery cannot be retracted/,
    );
    const promoted = legacyStore.save({
      ...delivered,
      phaseEpoch: 2,
      current: {
        sessionUuid: delivered.pendingPhase.sessionUuid,
        role: delivered.pendingPhase.role,
        phaseEpoch: 2,
      },
      transitioning: false,
      pendingPhase: null,
    });
    assert.equal(promoted.current.sessionUuid, delivered.pendingPhase.sessionUuid);
  }

  // ---------------------------------------------------------------- durable delegation routes every phase and refuses moving-target hazards
  {
    const delegationId = "81000000-0000-4000-8000-000000000001";
    const missingDelegation = "81000000-0000-4000-8000-000000000002";
    const foreignParent = sessionId("000000000099");
    const repo = initRepo({ branch: "feat/delegation-facade" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const facade = 1;\n", "delegation facade");
    const harness = createHarness({ complete: async () => "review", worktree: repo.worktree });
    const registered = [];
    const listeners = [];
    const implementer = childAgent({
      id: implementerId,
      cwd: repo.worktree,
      registered,
      restricted: harness.restricted,
      listeners,
    });
    const implementerRecord = { child: implementer, registered, listeners, live: true };
    harness.children.set(implementerId, implementerRecord);
    const adopted = await harness.land.adoptImplementer(implementer, {
      delegationId,
      handle: {
        agent: implementer,
        async dispose() { implementerRecord.live = false; },
      },
      packet: "keep one delegation identity across every physical role",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    assert.equal(adopted.delegationId, delegationId);
    assert.equal(adopted.phaseEpoch, 1);

    const status = () => harness.land.workflowStatus({ delegationId, parentSessionUuid: architectId });
    const send = (args = {}) => harness.land.workflowSend({
      delegationId,
      message: "phase-specific steering",
      parentSessionUuid: architectId,
      ...args,
    });
    assert.deepEqual({
      role: status().role,
      phaseEpoch: status().phaseEpoch,
      sessionUuid: status().sessionUuid,
      transitioning: status().transitioning,
    }, { role: "implementer", phaseEpoch: 1, sessionUuid: implementerId, transitioning: false });
    const sentImplementer = await send({ expectedRole: "implementer", expectedEpoch: 1 });
    assert.equal(sentImplementer.status, "sent");
    assert.equal(sentImplementer.delegationId, delegationId);
    assert.equal(sentImplementer.sessionUuid, implementerId);
    assert.equal(harness.sent.at(-1).to, implementerId);
    assert.match(harness.sent.at(-1).message, new RegExp(delegationId));

    const sentBeforeStale = harness.sent.length;
    assert.match((await send({ expectedRole: "qa-look-1" })).reason, /stale workflow role/);
    assert.match((await send({ expectedEpoch: 9 })).reason, /stale phase epoch/);
    assert.equal(harness.sent.length, sentBeforeStale);
    assert.match(harness.land.workflowStatus({ delegationId, parentSessionUuid: foreignParent }).reason, /different parent/);
    assert.match(harness.land.workflowStatus({ delegationId: missingDelegation, parentSessionUuid: architectId }).reason, /not found/);

    // Accepted done is durable but not routable until its exact result commits.
    const doneCall = "delegation-implementer-done";
    implementer.status = "running";
    const submitted = await registered[0].execute({ ref: "HEAD" }, {
      agent: implementer,
      callId: doneCall,
      concludeTurn() {
        implementer.status = "idle";
        for (const listener of [...listeners].filter((item) => item.type === "agent/status")) {
          listener.fn({ status: "idle" });
        }
      },
    });
    assert.equal(submitted.mark, "review");
    assert.equal(status().transitioning, true);
    assert.match((await send()).reason, /transitioning/);
    const doneEvent = {
      type: "tool/result",
      data: { message: {
        source: { kind: "tool", callId: doneCall },
        content: [{ type: "tool-result", toolCallId: doneCall, isError: false }],
      } },
    };
    implementer.session.events.push(doneEvent);
    for (const listener of [...listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(implementer.session, doneEvent);
    }
    await harness.land.whenSettled(implementerId);

    let current = status();
    assert.equal(current.role, "qa-look-1");
    assert.equal(current.phaseEpoch, 2);
    assert.notEqual(current.sessionUuid, implementerId);
    const qa1Id = current.sessionUuid;
    assert.equal((await send({ expectedRole: "qa-look-1", expectedEpoch: 2 })).sessionUuid, qa1Id);

    const qa1 = harness.children.get(qa1Id);
    const fail1 = await executeQaTool(harness.land, qa1, {
      verdict: "fail",
      summary: "needs one fix",
      feedback: "apply the bounded correction",
      tests_modified: false,
    });
    current = status();
    assert.equal(current.role, "fixer");
    assert.equal(current.phaseEpoch, 3);
    assert.equal(current.sessionUuid, fail1.implementer);
    const fixerId = current.sessionUuid;
    assert.equal((await send({ expectedRole: "fixer", expectedEpoch: 3 })).sessionUuid, fixerId);
    assert.match((await send({ expectedRole: "qa-look-1", expectedEpoch: 2 })).reason, /stale workflow role/);

    const fixer = harness.children.get(fixerId);
    const look2 = await harness.land.done({ agent: fixer.child, ref: "HEAD" });
    current = status();
    assert.equal(current.role, "qa-look-2");
    assert.equal(current.phaseEpoch, 4);
    assert.equal(current.sessionUuid, look2.qa);
    assert.equal((await send({ expectedRole: "qa-look-2", expectedEpoch: 4 })).sessionUuid, look2.qa);
    assert.equal(new Set([implementerId, qa1Id, fixerId, look2.qa]).size, 4);

    for (const row of harness.followups) {
      const text = row.message?.content?.[0]?.text ?? "";
      assert.match(text, new RegExp(delegationId));
      assert.match(text, new RegExp(adopted.run));
    }

    const reportsBefore = harness.sent.filter((row) => row.to === architectId && /Blocked:/.test(row.message)).length;
    const qa2 = harness.children.get(look2.qa);
    await executeQaTool(harness.land, qa2, {
      verdict: "fail",
      summary: "still wrong",
      feedback: "terminal evidence",
      tests_modified: false,
    }, { duplicateResults: 1 });
    const terminal = status();
    assert.equal(terminal.runStatus, "blocked");
    assert.equal(terminal.terminal, true);
    assert.equal(terminal.sessionUuid, "");
    assert.equal(terminal.phaseEpoch, 4);
    assert.match((await send()).reason, /terminal \(blocked\)/);
    assert.match((await harness.land.workflowSend({
      delegationId: missingDelegation,
      message: "must not route",
      parentSessionUuid: architectId,
    })).reason, /not found/);
    const reports = harness.sent.filter((row) => row.to === architectId && /Blocked:/.test(row.message));
    assert.equal(reports.length - reportsBefore, 1, "automatic terminal return is exactly once");
    assert.equal(reports.at(-1).message.startsWith(`Delegation ID (authoritative): ${delegationId}`), true);
    assert.match(reports.at(-1).message, new RegExp(adopted.run));
  }

  // ---------------------------------------------------------------- terminal report retry reuses one durable envelope after send/clear crash
  {
    const repo = initRepo({ branch: "feat/report-envelope-crash" });
    commitFile(repo.worktree, "qq-ui/assets/console.css", ".report { color: green; }\n", "paint report");
    const durableStore = createLandStore(mkdtempSync(join(scratch, "report-crash-runs-")));
    let crashOnAckClear = true;
    const crashStore = {
      ...durableStore,
      save(record) {
        const previous = durableStore.load(record?.id);
        if (crashOnAckClear && previous?.reportPending && record?.reportPending === false) {
          crashOnAckClear = false;
          throw new Error("simulated crash after report insertion before pending clear");
        }
        return durableStore.save(record);
      },
    };
    const harness = createHarness({
      complete: async () => "land",
      worktree: repo.worktree,
      store: crashStore,
    });
    const registered = [];
    const listeners = [];
    const implementer = childAgent({
      id: implementerId,
      cwd: repo.worktree,
      registered,
      restricted: harness.restricted,
      listeners,
    });
    const record = { child: implementer, registered, listeners, live: true };
    harness.children.set(implementerId, record);
    const handle = {
      agent: implementer,
      async dispose() {
        if (!record.live) return;
        record.live = false;
        harness.disposed.push(implementerId);
      },
    };
    const adopted = await harness.land.adoptImplementer(implementer, {
      handle,
      packet: "persist one terminal report envelope",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    assert.equal(adopted.status, "ok");
    await assert.rejects(
      () => harness.land.done({ agent: implementer, ref: "HEAD" }),
      /simulated crash after report insertion before pending clear/,
    );
    let pending = durableStore.load(adopted.run);
    assert.equal(pending.status, "landed");
    assert.equal(pending.reportPending, true);
    assert.match(pending.reportEnvelopeId, /^[0-9a-f-]{36}$/);
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].messageId, pending.reportEnvelopeId);
    assert.deepEqual(
      harness.parent.inbox.nextStep.map((message) => message.id),
      [pending.reportEnvelopeId],
      "the first send durably inserts one parent envelope",
    );

    await harness.land.dispose();
    assert.equal(record.live, true, "controller teardown retains the reporting child handle");
    const landB = createLand({
      ctx: harness.ctx,
      store: crashStore,
      settings: harness.settings,
      agents: harness.agents,
      complete: async () => "land",
    });
    assert.equal(pluginModule.internals.syncLiveLandChild(landB, implementer), true);
    for (let attempt = 0; attempt < 20 && durableStore.load(adopted.run).reportPending; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    pending = durableStore.load(adopted.run);
    assert.equal(pending.reportPending, false);
    assert.equal(pending.reportEnvelopeId, harness.sent[0].messageId, "report identity remains durable after ack");
    assert.equal(harness.sent.length, 1, "recovery does not invoke a second relay insertion");
    assert.deepEqual(harness.parent.inbox.nextStep.map((message) => message.id), [pending.reportEnvelopeId]);
    assert.equal(record.live, false, "the recovered report disposes its physical child once");
    assert.deepEqual(landB.ownedChildren(), []);
    await landB.dispose();
  }

  // ---------------------------------------------------------------- model failure and garbage default to review
  {
    const paint = packet("tweak the css color", ["qq-ui/assets/console.css"]);
    assert.equal(await routePacket(paint), "land");
    assert.equal(await routePacket(paint, { complete: async () => { throw new Error("down"); } }), "land");
    assert.equal(await routePacket(paint, { complete: async () => "nope" }), "land");
    assert.equal(parseRouteStamp("REVIEW please"), "review");
    assert.equal(parseRouteStamp("land\n"), "land");
    const control = packet("session store identity", ["core/src/session.mjs"]);
    assert.equal(await routePacket(control, { complete: async () => "land" }), "land");
    assert.equal(await routePacket(control, { complete: async () => { throw new Error("down"); } }), "review");
    assert.equal(await routePacket(control, { complete: async () => "maybe" }), "review");
  }

  // ---------------------------------------------------------------- a child can never parent another land child
  {
    const repo = initRepo({ branch: "feat/no-grandchild" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const x = 1;\n", "session tweak");
    const { land, created } = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
      parentHeader: { origin: CHILD_ORIGIN, parentSession: sessionId("9") },
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await land.adoptImplementer(implementer, {
      packet: "tighten session identity handling",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const refused = await land.done({ agent: implementer, ref: "HEAD" });
    assert.equal(refused.status, "refused");
    assert.match(refused.reason, /chair parent/);
    assert.equal(created.length, 0);
  }

  // ---------------------------------------------------------------- paint-only pass lands and packets architect
  {
    const repo = initRepo({ branch: "feat/paint" });
    commitFile(repo.worktree, "qq-ui/assets/console.css", "body{color:red}\n", "paint css");
    const archived = [];
    const { land, sent, created, store } = createHarness({
      complete: async () => "land",
      worktree: repo.worktree,
      tasks: { archive(id) { archived.push(id); return id; } },
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    const adopted = await land.adoptImplementer(implementer, {
      packet: "tweak the css color on the empty state",
      taskId: "280",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    assert.equal(adopted.status, "ok");
    const result = await land.done({ agent: implementer, ref: "HEAD" });
    assert.equal(result.status, "ok");
    assert.equal(result.mark, "land");
    assert.equal(created.length, 0);
    assert.match(result.outcome, /Landed on main/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, architectId);
    assert.equal(sent[0].delivery, "default");
    assert.match(sent[0].message, /Landed on main/);
    assert.match(sent[0].message, /console\.css/);
    assert.equal(existsSync(repo.worktree), false);
    const run = store.load(adopted.run);
    assert.equal(run.status, "landed");
    assert.equal(run.packet.schema, ROUTE_PACKET_SCHEMA);
    assert.equal(run.packet.mark, "land");
    assert.equal(run.taskId, "280");
    assert.equal(run.archivedTaskId, "280");
    assert.deepEqual(archived, ["280"]);
    assert.match(git(repo.main, ["log", "-1", "--pretty=%s"]), /paint css|Merge/);
  }

  // ---------------------------------------------------------------- done accepts a proposal whose unified diff exceeds 2 MB
  {
    const repo = initRepo({ branch: "feat/large-packet" });
    commitFile(
      repo.worktree,
      "qq-ui/assets/large.css",
      `${"x".repeat(2_100_000)}\n`,
      "large generated stylesheet",
    );
    const { land, store } = createHarness({
      complete: async () => "land",
      worktree: repo.worktree,
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    const adopted = await land.adoptImplementer(implementer, {
      packet: "paint css generated stylesheet",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const result = await land.done({ agent: implementer, ref: "HEAD" });
    assert.equal(result.status, "ok");
    assert.equal(result.mark, "land");
    const settled = store.load(adopted.run);
    assert.deepEqual(settled.packet.files, [
      { path: "qq-ui/assets/large.css", added: 1, deleted: 0 },
    ]);
    assert.deepEqual(settled.packet.pointers, ["qq-ui/assets/large.css:1"]);
  }

  // ---------------------------------------------------------------- control path → review → QA pass lands
  {
    const repo = initRepo({ branch: "feat/session" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const x = 1;\n", "session tweak");
    const { land, sent, created, children, restricted } = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await land.adoptImplementer(implementer, {
      packet: "tighten session identity handling",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const submitted = await land.done({ agent: implementer, ref: "HEAD" });
    assert.equal(submitted.status, "ok");
    assert.equal(submitted.mark, "review");
    assert.equal(submitted.look, 1);
    assert.equal(created.length, 1);
    assert.equal(created[0].meta.origin, CHILD_ORIGIN);
    assert.equal(created[0].meta.landRole, "qa");
    const qa = children.get(submitted.qa);
    assert.ok(qa);
    assert.deepEqual(qa.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
    assert.deepEqual(
      restricted.filter((row) => row.id === submitted.qa && row.active).map((row) => row.spec.allow),
      [[]],
    );
    const passed = await executeQaTool(land, qa, {
      verdict: "pass",
      summary: "session change is covered",
      feedback: "",
      tests_modified: false,
    });
    assert.equal(passed.status, "ok");
    assert.equal(passed.verdict, "pass");
    assert.equal(land.run(submitted.run).status, "landed");
    assert.equal(sent.length, 1);
    assert.match(sent[0].message, /Landed on main/);
    assert.equal(existsSync(repo.worktree), false);
  }

  // ---------------------------------------------------------------- QA pass closes before a blocked merge and remains idempotent
  {
    const repo = initRepo({ branch: "feat/qa-pass-blocked-merge" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const closer = 1;\n", "closer lifecycle");
    const mergeStarted = Promise.withResolvers();
    const releaseMerge = Promise.withResolvers();
    const identityRun = async (command, args, options) => {
      if (command === "git" && args?.[0] === "merge") {
        mergeStarted.resolve();
        await releaseMerge.promise;
        return {
          code: 128,
          stdout: "",
          stderr: "Author identity unknown\n\n*** Please tell me who you are.\n",
        };
      }
      return runCommand(command, args, options);
    };
    const harness = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
      run: identityRun,
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await harness.land.adoptImplementer(implementer, {
      packet: "close QA before attempting the host merge",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const submitted = await harness.land.done({ agent: implementer, ref: "HEAD" });
    const qa = harness.children.get(submitted.qa);
    const tool = qaTool(qa);
    const firstCallId = "qa-pass-before-blocked-merge";
    let concluded = 0;
    const executing = tool.execute({ findings: [] }, {
      agent: qa.child,
      callId: firstCallId,
      concludeTurn() { concluded++; },
    });
    const firstPhase = await Promise.race([
      executing.then(() => "returned"),
      mergeStarted.promise.then(() => "merge-started"),
    ]);
    if (firstPhase === "merge-started") releaseMerge.resolve();
    const result = await executing;
    assert.equal(firstPhase, "returned", "submit_review execute must not await or start the merge");
    assert.equal(result.status, "ok");
    assert.equal(result.verdict, "pass");
    assert.equal(concluded, 1);
    assert.equal(harness.land.run(submitted.run).qaVerdict.verdict, "pass");
    let formatSteers = 0;
    qa.child.steer = () => { formatSteers++; };
    for (const listener of qa.listeners.filter((item) => item.type === "agent/turn-stopping")) {
      listener.fn({ agent: qa.child });
    }
    assert.equal(formatSteers, 0, "persisted verdict must not trigger another mini-review turn");

    let concludedAgain = 0;
    const again = await tool.execute({ findings: [] }, {
      agent: qa.child,
      callId: "qa-pass-idempotent-close",
      concludeTurn() { concludedAgain++; },
    });
    assert.equal(again.status, "ok");
    assert.equal(again.verdict, "pass");
    assert.equal(again.alreadySubmitted, true);
    assert.equal(concludedAgain, 1);

    const resultEvent = {
      type: "tool/result",
      data: { message: {
        source: { kind: "tool", callId: firstCallId },
        content: [{ type: "tool-result", toolCallId: firstCallId, isError: false }],
      } },
    };
    qa.child.session.events.push(resultEvent);
    for (const listener of [...qa.listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(qa.child.session, resultEvent);
    }
    for (const listener of [...qa.listeners].filter((item) => item.type === "agent/status")) {
      listener.fn({ status: "idle" });
    }
    await mergeStarted.promise;
    releaseMerge.resolve();
    await harness.land.whenSettled(qa.child.session.id);

    const blocked = harness.land.run(submitted.run);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.blockedReason, /Author identity unknown/);
    assert.equal(blocked.qaVerdict.verdict, "pass");
    assert.equal(harness.sent.length, 1);
    assert.match(harness.sent[0].message, /Blocked/);
    assert.match(harness.sent[0].message, /Author identity unknown/);
  }

  // ---------------------------------------------------------------- QA followup claimed before user/message still starts
  {
    const repo = initRepo({ branch: "feat/claimed-packet" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const x = 1;\n", "session tweak");
    const { land, created, children, followups } = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
      claimFollowup: true,
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await land.adoptImplementer(implementer, {
      packet: "tighten session identity handling",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const submitted = await land.done({ agent: implementer, ref: "HEAD" });
    assert.equal(submitted.status, "ok");
    assert.equal(submitted.mark, "review");
    assert.equal(submitted.look, 1);
    assert.equal(created.length, 1);
    const qa = children.get(submitted.qa);
    assert.ok(qa);
    const packet = followups.find((row) => row.id === submitted.qa)?.message;
    assert.ok(packet?.id);
    assert.deepEqual(qa.child.inbox.nextTurn, []);
    assert.deepEqual(qa.child.inbox.nextStep, []);
    assert.equal(qa.child.session.events.some((event) => event?.type === "user/message"), false);
    assert.ok(qa.child.session.events.some((event) =>
      event?.type === "agent/inbox/spliced"
      && (event.data?.inserted ?? []).some((message) => message?.id === packet.id)));
    const run = land.bySession(submitted.qa);
    assert.equal(run.status, "reviewing");
    assert.equal(run.look, 1);
    assertMiniReviewMounted(qa);
  }

  // ---------------------------------------------------------------- look-1 fail starts a fresh implementer, not the original
  {
    const repo = initRepo({ branch: "feat/fix-once" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const x = 1;\n", "session tweak");
    const { land, created, children, followups, disposed, relay } = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await land.adoptImplementer(implementer, {
      packet: "tighten session identity handling",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const submitted = await land.done({ agent: implementer, ref: "HEAD" });
    const qa = children.get(submitted.qa);
    assert.deepEqual(relay.labelsFor(qa.child.session.id), [
      `workflows:land-role/qa-look-1`,
      `workflows:land-run/${submitted.run}`,
    ]);
    const failed = await executeQaTool(land, qa, {
      verdict: "fail",
      summary: "missing the identity proof",
      feedback: "add a test for the session id",
      tests_modified: false,
    }, { duplicateResults: 2 });
    assert.equal(failed.status, "ok");
    assert.equal(failed.look, 1);
    assert.equal(created.length, 2);
    assert.equal(created[1].meta.landRole, "implementer");
    assert.notEqual(created[1].sessionId, implementerId);
    assert.notEqual(created[1].sessionId, submitted.qa);
    assert.equal(failed.implementer, created[1].sessionId);
    assert.equal(created[1].meta.landWorkflowRole, "fixer");
    assert.deepEqual(disposed.filter((id) => id === submitted.qa), [submitted.qa]);
    assert.deepEqual(relay.labelsFor(submitted.qa), []);
    assert.deepEqual(relay.labelsFor(failed.implementer), [
      "workflows:land-role/fixer",
      `workflows:land-run/${submitted.run}`,
    ]);
    const fixer = children.get(failed.implementer);
    assert.equal(fixer.child.session.header.kind, MINI_KIND);
    assert.ok(!fixer.registered.some((tool) => tool.name === DONE_TOOL_NAME));
    const fixerPacket = followups.find((row) => row.id === failed.implementer)?.message?.content?.[0]?.text ?? "";
    assert.match(fixerPacket, /look 1 rejected/);
    assert.match(fixerPacket, /add a test for the session id/);
    const originalDone = await land.done({ agent: implementer, ref: "HEAD" });
    assert.equal(originalDone.status, "refused");
    assert.match(originalDone.reason, /owned implementer/);
  }

  // ---------------------------------------------------------------- look-2 fail is terminal; no third implementer; packet to architect
  {
    const repo = initRepo({ branch: "feat/final" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const x = 1;\n", "session tweak");
    const { land, sent, created, children, followups } = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await land.adoptImplementer(implementer, {
      packet: "tighten session identity handling",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const look1 = await land.done({ agent: implementer, ref: "HEAD" });
    const qa1 = children.get(look1.qa);
    const fail1 = await executeQaTool(land, qa1, {
      verdict: "fail",
      summary: "missing proof",
      feedback: "add the identity test",
      tests_modified: false,
    });
    const fixer = children.get(fail1.implementer);
    const look2 = await land.done({ agent: fixer.child, ref: "HEAD" });
    assert.equal(look2.status, "ok");
    assert.equal(look2.look, 2);
    const qa2 = children.get(look2.qa);
    const look2Packet = followups.find((row) => row.id === look2.qa)?.message?.content?.[0]?.text ?? "";
    assert.match(look2Packet, /Look 2, the final look/);
    assert.match(look2Packet, /Prior look-1 rejection:/);
    assert.match(look2Packet, /add the identity test/);
    const qa2Tool = qaTool(qa2);
    const fail2 = await executeQaTool(land, qa2, {
      verdict: "fail",
      summary: "still missing proof",
      feedback: "the identity test is still wrong",
      tests_modified: false,
    });
    assert.equal(fail2.status, "ok");
    assert.equal(fail2.look, 2);
    assert.match(fail2.outcome, /Blocked/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, architectId);
    assert.equal(sent[0].delivery, "default");
    assert.match(sent[0].message, /Blocked/);
    const implementers = created.filter((row) => row.meta.landRole === "implementer");
    const qas = created.filter((row) => row.meta.landRole === "qa");
    assert.equal(implementers.length, 1);
    assert.equal(qas.length, 2);
    const third = await land.done({ agent: fixer.child, ref: "HEAD" });
    assert.equal(third.status, "refused");
    const again = await executeQaTool(land, qa2, {
      verdict: "pass",
      summary: "too late",
      feedback: "",
      tests_modified: false,
    }, { tool: qa2Tool });
    assert.equal(again.status, "refused");
  }

  // ---------------------------------------------------------------- defense in depth: production commit during QA still fails the look
  {
    const repo = initRepo({ branch: "feat/qa-prod" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const x = 1;\n", "session tweak");
    const { land, children, created } = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await land.adoptImplementer(implementer, {
      packet: "tighten session identity handling",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const submitted = await land.done({ agent: implementer, ref: "HEAD" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const x = 2;\n", "qa rewrote production");
    const qa = children.get(submitted.qa);
    const result = await executeQaTool(land, qa, {
      verdict: "pass",
      summary: "looks good",
      feedback: "",
      tests_modified: false,
    });
    assert.equal(result.status, "ok");
    assert.equal(result.verdict, "fail");
    assert.match(result.outcome, /fresh implementer/);
    assert.equal(created.filter((row) => row.meta.landRole === "implementer").length, 1);
    const run = land.bySession(result.implementer);
    assert.match(run.qaVerdict.feedback, /production-code changes/);
    assert.equal(run.status, "waiting_fix");
    assert.equal(existsSync(repo.worktree), true);
  }

  // ---------------------------------------------------------------- QA turn without verdict is fail; look 1 gets a fresh implementer
  {
    const repo = initRepo({ branch: "feat/no-verdict" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const x = 1;\n", "session tweak");
    const { land, sent, created, children, followups } = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await land.adoptImplementer(implementer, {
      packet: "tighten session identity handling",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const submitted = await land.done({ agent: implementer, ref: "HEAD" });
    assert.ok(followups.some((row) => /<diff>[\s\S]*<\/diff>/.test(row.message?.content?.[0]?.text ?? "")));
    assert.ok(followups.some((row) => /session\.mjs/.test(row.message?.content?.[0]?.text ?? "")));
    const qa = children.get(submitted.qa);
    const listeners = qa.listeners.filter((item) => item.type === "session/event");
    assert.ok(listeners.length > 0);
    for (const listener of listeners) {
      await listener.fn({}, { type: "turn/end", seq: 3, data: { turn: 1 } });
    }
    assert.equal(created.filter((row) => row.meta.landRole === "implementer").length, 1);
    assert.notEqual(created.at(-1).sessionId, implementerId);
    assert.equal(sent.length, 0);
    const run = land.bySession(created.at(-1).sessionId);
    assert.equal(run.status, "waiting_fix");
    assert.match(run.qaVerdict.feedback, /without a structured verdict/);
  }

  // ---------------------------------------------------------------- look-2 missing verdict is terminal and packets architect
  {
    const repo = initRepo({ branch: "feat/no-verdict-2" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const x = 1;\n", "session tweak");
    const { land, sent, children } = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await land.adoptImplementer(implementer, {
      packet: "tighten session identity handling",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const look1 = await land.done({ agent: implementer, ref: "HEAD" });
    const qa1 = children.get(look1.qa);
    const fail1 = await executeQaTool(land, qa1, {
      verdict: "fail",
      summary: "missing proof",
      feedback: "add the identity test",
      tests_modified: false,
    });
    const fixer = children.get(fail1.implementer);
    const look2 = await land.done({ agent: fixer.child, ref: "HEAD" });
    const qa2 = children.get(look2.qa);
    const listeners = qa2.listeners.filter((item) => item.type === "session/event");
    for (const listener of listeners) {
      await listener.fn({}, { type: "turn/end", seq: 3, data: { turn: 1 } });
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, architectId);
    assert.equal(sent[0].delivery, "default");
    assert.match(sent[0].message, /Blocked/);
    const run = land.run(look2.run);
    assert.equal(run.status, "blocked");
  }

  // ---------------------------------------------------------------- saved QA verdict survives a failed tool result with exact evidence
  {
    const repo = initRepo({ branch: "feat/result-error-evidence" });
    const ref = commitFile(repo.worktree, "core/src/session.mjs", "export const exact = 1;\n", "identity settlement");
    const { land, sent, created, children, disposed, relay } = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await land.adoptImplementer(implementer, {
      packet: "preserve the exact QA finding",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const submitted = await land.done({ agent: implementer, ref: "HEAD" });
    const qa = children.get(submitted.qa);
    const failedResult = await executeQaTool(land, qa, {
      verdict: "fail",
      summary: "captured identity regression",
      feedback: "captured UUID must refuse after alias reassignment",
      tests_modified: false,
    }, { isError: true, duplicateResults: 2 });
    assert.equal(failedResult.status, "ok");
    const run = land.run(submitted.run);
    assert.equal(run.status, "blocked");
    assert.equal(run.ref, ref);
    assert.equal(run.look, 1);
    assert.equal(run.qaVerdict.summary, "captured UUID must refuse after alias reassignment");
    assert.equal(run.qaVerdict.feedback, "core/src/session.mjs:1: captured UUID must refuse after alias reassignment");
    assert.equal(created.length, 1, "a failed result must not silently spawn a fixer");
    assert.deepEqual(disposed.filter((id) => id === submitted.qa), [submitted.qa]);
    assert.deepEqual(relay.labelsFor(submitted.qa), []);
    assert.equal(sent.length, 1, "failed-result recovery reports exactly once");
    for (const evidence of [
      `Land run: ${submitted.run}`,
      "Workflow role: qa-look-1",
      "QA look: 1",
      `Ref: ${ref}`,
      "Summary: captured UUID must refuse after alias reassignment",
      "Feedback: core/src/session.mjs:1: captured UUID must refuse after alias reassignment",
    ]) assert.match(sent[0].message, new RegExp(evidence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  // ---------------------------------------------------------------- workflow HMR preserves and rebinds an active Land Mini
  {
    const repo = initRepo({ branch: "feat/hmr-active-land-mini" });
    const ref = commitFile(repo.worktree, "core/src/session.mjs", "export const miniHmr = 1;\n", "active Mini HMR");
    const harness = createHarness({ complete: async () => "review", worktree: repo.worktree });
    const registered = [];
    const listeners = [];
    const mini = childAgent({ id: implementerId, cwd: repo.worktree, registered, listeners });
    mini.session.header.kind = MINI_KIND;
    mini.session.header.agentPreset = MINI_KIND;
    let mountedBash = { name: "bash", async execute() {} };
    mini.ctx.systemPrompt = {
      section() { return () => {}; },
      suppressRuntimeContext() {},
    };
    mini.ctx.effect = (effect) => effect();
    mini.ctx.tools = {
      get(name) { return name === "bash" ? mountedBash : undefined; },
      register(tool) {
        const previous = mountedBash;
        mountedBash = tool;
        return () => { if (mountedBash === tool) mountedBash = previous; };
      },
      restrict() { return () => {}; },
    };
    const record = { child: mini, registered, listeners, live: true };
    harness.children.set(implementerId, record);
    let disposals = 0;
    const handle = {
      agent: mini,
      async dispose() {
        if (!record.live) return;
        record.live = false;
        disposals++;
      },
    };
    const adopted = await harness.land.adoptImplementer(mini, {
      handle,
      packet: "preserve active Land Mini through HMR",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    assert.equal(adopted.status, "ok");
    assert.deepEqual(registered, [], "Mini completion remains hidden behind bash");
    assert.deepEqual(listeners.map((item) => item.type).sort(), ["agent/status", "session/event", "session/event"]);
    assert.deepEqual(harness.relay.labelsFor(implementerId), [
      "workflows:land-role/implementer",
      `workflows:land-run/${adopted.run}`,
    ]);

    await harness.land.dispose();
    assert.equal(disposals, 0);
    assert.equal(record.live, true);
    assert.deepEqual(harness.land.ownedChildren(), []);
    assert.deepEqual(registered, []);
    assert.deepEqual(listeners, []);
    assert.deepEqual(harness.relay.labelsFor(implementerId), []);

    const landB = createLand({
      ctx: harness.ctx,
      store: harness.store,
      settings: harness.settings,
      agents: harness.agents,
      complete: async () => "review",
    });
    const syncLive = () => harness.agents.list()
      .filter((agent) => pluginModule.internals.syncLiveLandChild(landB, agent)).length;
    assert.equal(syncLive(), 1);
    assert.equal(syncLive(), 1);
    assert.deepEqual(landB.ownedChildren(), [implementerId]);
    assert.deepEqual(registered, []);
    assert.deepEqual(listeners.map((item) => item.type).sort(), [
      "agent/status",
      "agent/turn-stopping",
      "session/event",
      "session/event",
      "session/event",
    ]);
    const resumed = landB.bySession(implementerId);
    assert.equal(resumed.id, adopted.run);
    assert.equal(resumed.ref, "");
    assert.equal(resumed.baseRef, repo.baseRef);
    assert.equal(mini.session.header.landRun, adopted.run);
    assert.equal(mini.session.header.landWorkflowRole, "implementer");

    const wrapped = wrapMiniBash({ name: "bash", async execute() { assert.fail("sentinel must not reach bash"); } });
    const callId = "hmr-active-mini-completion";
    mini.status = "running";
    let concluded = 0;
    const completion = await wrapped.execute({ command: MINI_SWE_COMPLETION_COMMAND }, {
      agent: mini,
      callId,
      concludeTurn() {
        concluded++;
        mini.status = "idle";
        for (const listener of [...listeners].filter((item) => item.type === "agent/status")) {
          listener.fn({ status: "idle" });
        }
      },
    });
    assert.equal(completion.exitCode, 0);
    assert.equal(concluded, 1);
    let pending = landB.run(adopted.run);
    assert.equal(pending.status, "reviewing");
    assert.equal(pending.ref, ref);
    assert.equal(pending.settlementSession, implementerId);
    assert.equal(pending.settlementCallId, callId);
    assert.equal(pending.settlementTransition, "start_qa");
    assert.equal(harness.created.length, 0);

    const event = {
      type: "tool/result",
      data: { message: {
        source: { kind: "tool", callId },
        content: [{ type: "tool-result", toolCallId: callId, isError: false }],
      } },
    };
    mini.session.events.push(event);
    for (const listener of [...listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(mini.session, event);
    }
    await landB.whenSettled(implementerId);
    pending = landB.run(adopted.run);
    assert.ok(pending.qaSession);
    assert.equal(harness.created.length, 1);
    assert.equal(disposals, 1, "exact completion result disposes the Mini once");
    assert.deepEqual(landB.ownedChildren(), [pending.qaSession]);
    for (const listener of [...listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(mini.session, event);
    }
    assert.equal(harness.created.length, 1);
    await landB.dispose();
  }

  // ---------------------------------------------------------------- workflow HMR detaches, reapplies, and resumes exact child ownership
  {
    const repo = initRepo({ branch: "feat/hmr-land-resume" });
    const ref = commitFile(repo.worktree, "core/src/session.mjs", "export const resume = 1;\n", "resume land child");
    const harness = createHarness({ complete: async () => "review", worktree: repo.worktree });
    const registered = [];
    const listeners = [];
    const implementer = childAgent({
      id: implementerId,
      cwd: repo.worktree,
      registered,
      restricted: harness.restricted,
      listeners,
    });
    const implementerRecord = { child: implementer, registered, listeners, live: true };
    harness.children.set(implementerId, implementerRecord);
    let implementerDisposals = 0;
    const handle = {
      agent: implementer,
      async dispose() {
        if (!implementerRecord.live) return;
        implementerRecord.live = false;
        implementerDisposals++;
      },
    };
    const adopted = await harness.land.adoptImplementer(implementer, {
      handle,
      packet: "retain recoverable topology",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    assert.equal(adopted.status, "ok");
    const adoptedRun = harness.land.run(adopted.run);
    const identity = {
      run: adoptedRun.id,
      ref: adoptedRun.ref,
      baseRef: adoptedRun.baseRef,
      head: git(repo.worktree, ["rev-parse", "HEAD"]),
      session: implementer.session.id,
      landRun: implementer.session.header.landRun,
      role: implementer.session.header.landWorkflowRole,
    };
    assert.equal(identity.head, ref);
    assert.deepEqual(harness.land.ownedChildren(), [implementerId]);
    assert.deepEqual(registered.map((tool) => tool.name), [DONE_TOOL_NAME]);
    assert.deepEqual(listeners.map((item) => item.type).sort(), ["agent/status", "session/event", "session/event"]);
    assert.deepEqual(harness.relay.labelsFor(implementerId), [
      "workflows:land-role/implementer",
      `workflows:land-run/${adopted.run}`,
    ]);

    // Actual ordering: A releases all plugin ownership before B exists.
    await harness.land.dispose();
    assert.equal(implementerDisposals, 0, "plugin replacement must preserve the live AgentHandle");
    assert.equal(implementerRecord.live, true);
    assert.equal(harness.land.run(adopted.run).status, "running");
    assert.deepEqual(harness.land.ownedChildren(), []);
    assert.deepEqual(registered, []);
    assert.deepEqual(listeners, []);
    assert.deepEqual(harness.relay.labelsFor(implementerId), []);

    const controller = () => createLand({
      ctx: harness.ctx,
      store: harness.store,
      settings: harness.settings,
      agents: harness.agents,
      complete: async () => "review",
    });
    const syncLive = (land) => harness.agents.list()
      .filter((agent) => pluginModule.internals.syncLiveLandChild(land, agent)).length;
    const landB = controller();
    assert.equal(syncLive(landB), 1, "plugin reapply must discover the one live workflow child");
    assert.deepEqual(landB.ownedChildren(), [implementerId]);
    assert.deepEqual(registered.map((tool) => tool.name), [DONE_TOOL_NAME]);
    assert.deepEqual(listeners.map((item) => item.type).sort(), ["agent/status", "session/event", "session/event"]);
    assert.equal(syncLive(landB), 1, "repeat live sync must reuse the same owner");
    assert.deepEqual(landB.ownedChildren(), [implementerId]);
    assert.deepEqual(registered.map((tool) => tool.name), [DONE_TOOL_NAME]);
    assert.deepEqual(listeners.map((item) => item.type).sort(), ["agent/status", "session/event", "session/event"]);
    const hmrStatus = landB.workflowStatus({
      delegationId: adopted.delegationId,
      parentSessionUuid: architectId,
    });
    assert.equal(hmrStatus.sessionUuid, implementerId);
    assert.equal(hmrStatus.role, "implementer");
    assert.equal(hmrStatus.phaseEpoch, 1);
    const hmrSent = await landB.workflowSend({
      delegationId: adopted.delegationId,
      message: "route after HMR reconstruction",
      expectedRole: "implementer",
      expectedEpoch: 1,
      parentSessionUuid: architectId,
    });
    assert.equal(hmrSent.sessionUuid, implementerId);
    assert.equal(harness.sent.pop().to, implementerId);
    const resumedRun = landB.bySession(implementerId);
    assert.deepEqual({
      run: resumedRun.id,
      ref: resumedRun.ref,
      baseRef: resumedRun.baseRef,
      head: git(repo.worktree, ["rev-parse", "HEAD"]),
      session: implementer.session.id,
      landRun: implementer.session.header.landRun,
      role: implementer.session.header.landWorkflowRole,
    }, identity);
    assert.deepEqual(harness.relay.labelsFor(implementerId), [
      "workflows:land-role/implementer",
      `workflows:land-run/${adopted.run}`,
    ]);

    // The resumed implementer submits once through the reinstalled done tool.
    const doneCall = "hmr-done-call";
    implementer.status = "running";
    let doneConcluded = 0;
    const submitted = await registered[0].execute({ ref: "HEAD" }, {
      agent: implementer,
      callId: doneCall,
      concludeTurn() {
        doneConcluded++;
        implementer.status = "idle";
        for (const listener of [...listeners].filter((item) => item.type === "agent/status")) {
          listener.fn({ status: "idle" });
        }
      },
    });
    assert.equal(doneConcluded, 1);
    const doneEvent = {
      type: "tool/result",
      data: { message: {
        source: { kind: "tool", callId: doneCall },
        content: [{ type: "tool-result", toolCallId: doneCall, isError: false }],
      } },
    };
    implementer.session.events.push(doneEvent);
    for (const listener of [...listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(implementer.session, doneEvent);
    }
    await landB.whenSettled(implementerId);
    assert.equal(submitted.mark, "review");
    assert.equal(implementerDisposals, 1, "settled submission, not HMR, disposes the implementer once");
    assert.equal(harness.created.length, 1, "one QA child starts after the exact done result");
    assert.equal(submitted.qa, harness.created[0].sessionId);
    const duplicateDone = await landB.done({ agent: implementer, ref: "HEAD" });
    assert.equal(duplicateDone.status, "refused");

    // QA is also detached and resumed with exactly one verdict/listener set.
    const qa = harness.children.get(submitted.qa);
    assert.ok(qa?.live);
    assert.deepEqual(qa.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
    assertMiniReviewMounted(qa);
    assert.equal(harness.restricted.filter((item) => item.id === submitted.qa && item.active).length, 1);
    await landB.dispose();
    assert.equal(qa.live, true);
    assert.equal(harness.disposed.includes(submitted.qa), false);
    assertMiniReviewMounted(qa, { owned: false });
    assert.equal(harness.restricted.filter((item) => item.id === submitted.qa && item.active).length, 1);
    assert.deepEqual(harness.relay.labelsFor(submitted.qa), []);

    const landC = controller();
    assert.equal(syncLive(landC), 1);
    assert.deepEqual(landC.ownedChildren(), [submitted.qa]);
    assert.deepEqual(qa.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
    assertMiniReviewMounted(qa);
    assert.equal(harness.restricted.filter((item) => item.id === submitted.qa && item.active).length, 1);
    assert.equal(syncLive(landC), 1);
    assert.deepEqual(qa.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
    assertMiniReviewMounted(qa);
    assert.equal(harness.restricted.filter((item) => item.id === submitted.qa && item.active).length, 1);
    assert.deepEqual(harness.relay.labelsFor(submitted.qa), [
      "workflows:land-role/qa-look-1",
      `workflows:land-run/${adopted.run}`,
    ]);

    // Replace the controller after verdict acceptance but before tool/result.
    const qaCall = "hmr-qa-pending";
    qa.child.status = "running";
    let qaConcluded = 0;
    const qaResult = await qaTool(qa).execute(legacyReviewArgs(landC, qa, {
      verdict: "fail",
      summary: "pending HMR proof",
      feedback: "resume the exact pending settlement",
      tests_modified: false,
    }), {
      agent: qa.child,
      callId: qaCall,
      concludeTurn() {
        qaConcluded++;
        qa.child.status = "idle";
        for (const listener of [...qa.listeners].filter((item) => item.type === "agent/status")) {
          listener.fn({ status: "idle" });
        }
      },
    });
    assert.equal(qaResult.status, "ok");
    assert.equal(qaConcluded, 1);
    let pending = landC.run(adopted.run);
    assert.equal(pending.status, "waiting_fix");
    assert.equal(pending.settlementSession, submitted.qa);
    assert.equal(pending.settlementCallId, qaCall);
    assert.equal(pending.settlementTransition, "start_fixer");
    assert.equal(harness.created.length, 1);
    assert.equal(harness.sent.length, 0);

    await landC.dispose();
    pending = landC.run(adopted.run);
    assert.equal(qa.live, true);
    assert.equal(pending.status, "waiting_fix", "HMR must not route pending settlement through generic failure");
    assert.equal(pending.qaVerdict.summary, "resume the exact pending settlement");
    assert.equal(harness.created.length, 1);
    assert.equal(harness.sent.length, 0);
    assertMiniReviewMounted(qa, { owned: false });

    const landD = controller();
    assert.equal(syncLive(landD), 1);
    assert.deepEqual(landD.ownedChildren(), [submitted.qa]);
    assertMiniReviewMounted(qa, { owned: false });
    assertMiniReviewMounted(qa);
    const qaEvent = {
      type: "tool/result",
      data: { message: {
        source: { kind: "tool", callId: qaCall },
        content: [{ type: "tool-result", toolCallId: qaCall, isError: false }],
      } },
    };
    qa.child.session.events.push(qaEvent);
    for (const listener of [...qa.listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(qa.child.session, qaEvent);
    }
    await landD.whenSettled(submitted.qa);
    const fixing = landD.run(adopted.run);
    assert.equal(fixing.status, "waiting_fix");
    assert.ok(fixing.implementerSession);
    assert.equal(fixing.qaVerdict.summary, "resume the exact pending settlement");
    assert.equal(fixing.settlementSession, "");
    assert.equal(fixing.settlementCallId, "");
    assert.equal(fixing.settlementTransition, "");
    assert.equal(harness.created.length, 2, "pending result starts exactly one fixer");
    assert.deepEqual(harness.disposed.filter((id) => id === submitted.qa), [submitted.qa]);
    assert.deepEqual(landD.ownedChildren(), [fixing.implementerSession]);
    for (const listener of [...qa.listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(qa.child.session, qaEvent);
    }
    assert.equal(harness.created.length, 2, "duplicate result cannot duplicate the fixer");
    await landD.dispose();
  }

  // ---------------------------------------------------------------- HMR teardown drains done before its durable settlement is armed
  {
    const repo = initRepo({ branch: "feat/hmr-pre-arm-done" });
    const ref = commitFile(repo.worktree, "core/src/session.mjs", "export const preArm = 1;\n", "pre-arm done race");
    const gitEntered = Promise.withResolvers();
    const releaseGit = Promise.withResolvers();
    let paused = false;
    const deferredRun = async (command, args, options) => {
      if (!paused && command === "git" && args?.[0] === "rev-parse"
        && args?.[1] === "--verify" && args?.[2] === "HEAD^{commit}") {
        paused = true;
        gitEntered.resolve();
        await releaseGit.promise;
      }
      return runCommand(command, args, options);
    };
    const harness = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
      run: deferredRun,
    });
    const registered = [];
    const listeners = [];
    const implementer = childAgent({
      id: implementerId,
      cwd: repo.worktree,
      registered,
      restricted: harness.restricted,
      listeners,
    });
    const implementerRecord = { child: implementer, registered, listeners, live: true };
    harness.children.set(implementerId, implementerRecord);
    let implementerDisposals = 0;
    const adopted = await harness.land.adoptImplementer(implementer, {
      handle: {
        agent: implementer,
        async dispose() {
          if (!implementerRecord.live) return;
          implementerRecord.live = false;
          implementerDisposals++;
        },
      },
      packet: "drain done before settlement arm",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    assert.equal(adopted.status, "ok");
    const identity = {
      run: adopted.run,
      ref,
      baseRef: harness.land.run(adopted.run).baseRef,
      session: implementer.session.id,
      landRun: implementer.session.header.landRun,
      role: implementer.session.header.landWorkflowRole,
    };
    const oldDone = registered[0];
    const doneCall = "hmr-pre-arm-done";
    implementer.status = "running";
    let concluded = 0;
    const submitting = oldDone.execute({ ref: "HEAD" }, {
      agent: implementer,
      callId: doneCall,
      concludeTurn() {
        concluded++;
        implementer.status = "idle";
        for (const listener of [...listeners].filter((item) => item.type === "agent/status")) {
          listener.fn({ status: "idle" });
        }
      },
    });
    await gitEntered.promise;

    const disposingA = harness.land.dispose();
    let aReturned = false;
    void disposingA.then(() => { aReturned = true; });
    await Promise.resolve();
    assert.equal(aReturned, false, "controller A waits for done to arm its durable settlement");
    assert.deepEqual(harness.land.ownedChildren(), [implementerId]);
    releaseGit.resolve();
    const [submitted, disposedA] = await Promise.all([submitting, disposingA]);

    assert.equal(submitted.status, "ok");
    assert.equal(submitted.mark, "review");
    assert.equal(submitted.qa, "");
    assert.equal(concluded, 1);
    assert.equal(disposedA.detached, 1);
    assert.equal(implementerDisposals, 0, "pre-arm HMR must preserve the live implementer handle");
    assert.equal(implementerRecord.live, true);
    assert.deepEqual(harness.land.ownedChildren(), []);
    assert.deepEqual(registered, []);
    assert.deepEqual(listeners, []);
    assert.deepEqual(harness.relay.labelsFor(implementerId), []);
    assert.equal(harness.created.length, 0, "controller A cannot start QA before the exact result");
    const pending = harness.land.run(adopted.run);
    assert.deepEqual({
      run: pending.id,
      ref: pending.ref,
      baseRef: pending.baseRef,
      session: pending.implementerSession,
      landRun: implementer.session.header.landRun,
      role: implementer.session.header.landWorkflowRole,
    }, identity);
    assert.equal(pending.status, "reviewing");
    assert.equal(pending.qaSession, "");
    assert.equal(pending.settlementSession, implementerId);
    assert.equal(pending.settlementCallId, doneCall);
    assert.equal(pending.settlementTransition, "start_qa");

    const stale = await oldDone.execute({ ref: "HEAD" }, {
      agent: implementer,
      callId: "hmr-pre-arm-done-stale",
      concludeTurn() { assert.fail("detached controller must not conclude a stale tool"); },
    });
    assert.equal(stale.status, "refused");
    assert.match(stale.reason, /no longer owned/);
    assert.equal(harness.created.length, 0, "controller A cannot spawn after dispose returns");

    const landB = createLand({
      ctx: harness.ctx,
      store: harness.store,
      settings: harness.settings,
      agents: harness.agents,
      complete: async () => "review",
      run: deferredRun,
    });
    const syncLive = () => harness.agents.list()
      .filter((agent) => pluginModule.internals.syncLiveLandChild(landB, agent)).length;
    assert.equal(syncLive(), 1);
    assert.equal(syncLive(), 1, "repeat sync must reuse the pre-arm submission owner");
    assert.deepEqual(landB.ownedChildren(), [implementerId]);
    assert.deepEqual(registered, [], "an accepted done cannot be registered a second time");
    assert.deepEqual(listeners.map((item) => item.type).sort(), ["agent/status", "session/event"]);
    assert.deepEqual(harness.relay.labelsFor(implementerId), [
      "workflows:land-role/implementer",
      `workflows:land-run/${adopted.run}`,
    ]);

    const doneEvent = {
      type: "tool/result",
      data: { message: {
        source: { kind: "tool", callId: doneCall },
        content: [{ type: "tool-result", toolCallId: doneCall, isError: false }],
      } },
    };
    implementer.session.events.push(doneEvent);
    for (const listener of [...listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(implementer.session, doneEvent);
    }
    await landB.whenSettled(implementerId);
    const reviewing = landB.run(adopted.run);
    assert.equal(reviewing.status, "reviewing");
    assert.equal(reviewing.ref, ref);
    assert.ok(reviewing.qaSession);
    assert.equal(harness.created.length, 1, "controller B starts one QA from the exact result");
    assert.equal(implementerDisposals, 1);
    const qa = harness.children.get(reviewing.qaSession);
    assert.ok(qa?.live);
    assert.deepEqual(qa.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
    assert.deepEqual(landB.ownedChildren(), [reviewing.qaSession]);
    for (const listener of [...listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(implementer.session, doneEvent);
    }
    assert.equal(harness.created.length, 1, "duplicate done result cannot duplicate QA");
    await landB.dispose();
  }

  // ---------------------------------------------------------------- HMR teardown drains submit_review before its durable settlement is armed
  {
    const repo = initRepo({ branch: "feat/hmr-pre-arm-verdict" });
    const ref = commitFile(repo.worktree, "core/src/session.mjs", "export const verdictRace = 1;\n", "pre-arm verdict race");
    const enforcementEntered = Promise.withResolvers();
    const releaseEnforcement = Promise.withResolvers();
    let pauseVerdict = false;
    let paused = false;
    const deferredRun = async (command, args, options) => {
      if (pauseVerdict && !paused && command === "git" && args?.[0] === "status") {
        paused = true;
        enforcementEntered.resolve();
        await releaseEnforcement.promise;
      }
      return runCommand(command, args, options);
    };
    const harness = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
      run: deferredRun,
    });
    const registered = [];
    const listeners = [];
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered, listeners });
    const implementerRecord = { child: implementer, registered, listeners, live: true };
    harness.children.set(implementerId, implementerRecord);
    const adopted = await harness.land.adoptImplementer(implementer, {
      handle: {
        agent: implementer,
        async dispose() { implementerRecord.live = false; },
      },
      packet: "drain verdict before settlement arm",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    assert.equal(adopted.status, "ok");
    const submitted = await harness.land.done({ agent: implementer, ref: "HEAD" });
    assert.equal(submitted.mark, "review");
    assert.equal(submitted.qa, harness.created[0].sessionId);
    const qa = harness.children.get(submitted.qa);
    assert.ok(qa?.live);
    const oldVerdict = qaTool(qa);
    const qaCall = "hmr-pre-arm-verdict";
    qa.child.status = "running";
    let concluded = 0;
    pauseVerdict = true;
    const submitting = oldVerdict.execute(legacyReviewArgs(harness.land, qa, {
      verdict: "fail",
      summary: "deferred verdict survives HMR",
      feedback: "resume one exact fixer transition",
      tests_modified: false,
    }), {
      agent: qa.child,
      callId: qaCall,
      concludeTurn() {
        concluded++;
        qa.child.status = "idle";
        for (const listener of [...qa.listeners].filter((item) => item.type === "agent/status")) {
          listener.fn({ status: "idle" });
        }
      },
    });
    await enforcementEntered.promise;

    const disposingA = harness.land.dispose();
    let aReturned = false;
    void disposingA.then(() => { aReturned = true; });
    await Promise.resolve();
    assert.equal(aReturned, false, "controller A waits for submit_review to arm its durable settlement");
    assert.deepEqual(harness.land.ownedChildren(), [submitted.qa]);
    releaseEnforcement.resolve();
    const [verdictResult, disposedA] = await Promise.all([submitting, disposingA]);

    assert.equal(verdictResult.status, "ok");
    assert.equal(verdictResult.verdict, "fail");
    assert.equal(verdictResult.implementer, "");
    assert.equal(concluded, 1);
    assert.equal(disposedA.detached, 1);
    assert.equal(qa.live, true, "pre-arm HMR must preserve the live QA handle");
    assert.deepEqual(harness.land.ownedChildren(), []);
    assertMiniReviewMounted(qa, { owned: false });
    assert.equal(harness.restricted.filter((item) => item.id === submitted.qa && item.active).length, 1);
    assert.deepEqual(harness.relay.labelsFor(submitted.qa), []);
    assert.equal(harness.created.length, 1, "controller A cannot start a fixer before the exact result");
    const pending = harness.land.run(adopted.run);
    assert.equal(pending.status, "waiting_fix");
    assert.equal(pending.id, adopted.run);
    assert.equal(pending.ref, ref);
    assert.equal(pending.qaSession, submitted.qa);
    assert.equal(pending.qaVerdict.summary, "resume one exact fixer transition");
    assert.equal(pending.settlementSession, submitted.qa);
    assert.equal(pending.settlementCallId, qaCall);
    assert.equal(pending.settlementTransition, "start_fixer");

    const stale = await oldVerdict.execute(legacyReviewArgs(harness.land, qa, {
      verdict: "fail",
      summary: "stale verdict",
      feedback: "must refuse",
      tests_modified: false,
    }), {
      agent: qa.child,
      callId: "hmr-pre-arm-verdict-stale",
      concludeTurn() { assert.fail("detached controller must not conclude a stale verdict"); },
    });
    assert.equal(stale.status, "refused");
    assert.match(stale.reason, /submit_review is unavailable/);
    assert.equal(harness.created.length, 1, "controller A cannot spawn a fixer after dispose returns");

    const landB = createLand({
      ctx: harness.ctx,
      store: harness.store,
      settings: harness.settings,
      agents: harness.agents,
      complete: async () => "review",
      run: deferredRun,
    });
    const syncLive = () => harness.agents.list()
      .filter((agent) => pluginModule.internals.syncLiveLandChild(landB, agent)).length;
    assert.equal(syncLive(), 1);
    assert.equal(syncLive(), 1);
    assert.deepEqual(landB.ownedChildren(), [submitted.qa]);
    assertMiniReviewMounted(qa, { owned: false });
    assertMiniReviewMounted(qa);
    assert.equal(harness.restricted.filter((item) => item.id === submitted.qa && item.active).length, 1);
    assert.deepEqual(harness.relay.labelsFor(submitted.qa), [
      "workflows:land-role/qa-look-1",
      `workflows:land-run/${adopted.run}`,
    ]);

    const qaEvent = {
      type: "tool/result",
      data: { message: {
        source: { kind: "tool", callId: qaCall },
        content: [{ type: "tool-result", toolCallId: qaCall, isError: false }],
      } },
    };
    qa.child.session.events.push(qaEvent);
    for (const listener of [...qa.listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(qa.child.session, qaEvent);
    }
    await landB.whenSettled(submitted.qa);
    const fixing = landB.run(adopted.run);
    assert.equal(fixing.status, "waiting_fix");
    assert.ok(fixing.implementerSession);
    assert.equal(fixing.qaVerdict.summary, "resume one exact fixer transition");
    assert.equal(harness.created.length, 2, "controller B starts one fixer from the exact result");
    assert.deepEqual(landB.ownedChildren(), [fixing.implementerSession]);
    for (const listener of [...qa.listeners].filter((item) => item.type === "session/event")) {
      await listener.fn(qa.child.session, qaEvent);
    }
    assert.equal(harness.created.length, 2, "duplicate verdict result cannot duplicate the fixer");
    await landB.dispose();
  }

  // ---------------------------------------------------------------- HMR teardown drains a successor retained by an in-flight transition
  {
    const repo = initRepo({ branch: "feat/hmr-transition-fixed-point" });
    const ref = commitFile(repo.worktree, "core/src/session.mjs", "export const transition = 1;\n", "race HMR transition");
    const gapReached = Promise.withResolvers();
    const releaseGap = Promise.withResolvers();
    let pauseAfterOldDisposal = false;
    const gapRun = async (command, args, options) => {
      if (pauseAfterOldDisposal && command === "git" && args?.[0] === "diff" && args?.includes("-U0")) {
        pauseAfterOldDisposal = false;
        gapReached.resolve();
        await releaseGap.promise;
      }
      return runCommand(command, args, options);
    };
    const harness = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
      run: gapRun,
    });
    const registered = [];
    const listeners = [];
    const implementer = childAgent({
      id: implementerId,
      cwd: repo.worktree,
      registered,
      restricted: harness.restricted,
      listeners,
    });
    const implementerRecord = { child: implementer, registered, listeners, live: true };
    harness.children.set(implementerId, implementerRecord);
    let implementerDisposals = 0;
    const adopted = await harness.land.adoptImplementer(implementer, {
      handle: {
        agent: implementer,
        async dispose() {
          implementerDisposals++;
          implementerRecord.live = false;
        },
      },
      packet: "drain transition successor at HMR fixed point",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    assert.equal(adopted.status, "ok");

    const doneCall = "hmr-transition-done";
    implementer.status = "running";
    let doneConcluded = 0;
    const submitted = await registered[0].execute({ ref: "HEAD" }, {
      agent: implementer,
      callId: doneCall,
      concludeTurn() {
        doneConcluded++;
        implementer.status = "idle";
        for (const listener of [...listeners].filter((item) => item.type === "agent/status")) {
          listener.fn({ status: "idle" });
        }
      },
    });
    assert.equal(submitted.mark, "review");
    assert.equal(doneConcluded, 1);
    const doneEvent = {
      type: "tool/result",
      data: { message: {
        source: { kind: "tool", callId: doneCall },
        content: [{ type: "tool-result", toolCallId: doneCall, isError: false }],
      } },
    };
    pauseAfterOldDisposal = true;
    implementer.session.events.push(doneEvent);
    for (const listener of [...listeners].filter((item) => item.type === "session/event")) {
      listener.fn(implementer.session, doneEvent);
    }
    await gapReached.promise;
    assert.equal(implementerRecord.live, false, "old-child disposal fully completed before the pause");
    assert.deepEqual(harness.land.ownedChildren(), [], "the old owner is already absent in the exact gap");
    assert.equal(harness.created.length, 0, "successor agents.create has not begun in the exact gap");

    const disposingA = harness.land.dispose();
    let aReturned = false;
    void disposingA.then(() => { aReturned = true; });
    await Promise.resolve();
    assert.equal(aReturned, false, "controller A waits for the committed transition");
    releaseGap.resolve();
    await disposingA;

    assert.equal(implementerDisposals, 1, "the committed transition disposes only its old implementer");
    assert.equal(implementerRecord.live, false);
    assert.equal(harness.created.length, 1, "the committed transition retains one QA successor");
    assert.equal(submitted.qa, harness.created[0].sessionId);
    const qa = harness.children.get(submitted.qa);
    assert.ok(qa?.live, "HMR preserves the successor AgentHandle");
    const reviewing = harness.land.run(adopted.run);
    assert.equal(reviewing.status, "reviewing");
    assert.equal(reviewing.ref, ref);
    assert.equal(reviewing.qaSession, submitted.qa);
    const qaIdentity = {
      run: reviewing.id,
      ref: reviewing.ref,
      baseRef: reviewing.baseRef,
      session: qa.child.session.id,
      landRun: qa.child.session.header.landRun,
      role: qa.child.session.header.landWorkflowRole,
    };
    assert.deepEqual(harness.land.ownedChildren(), [], "controller A drains owners created while it awaited");
    assert.deepEqual(registered, []);
    assert.deepEqual(listeners, []);
    assert.deepEqual(harness.relay.labelsFor(implementerId), []);
    assertMiniReviewMounted(qa, { owned: false });
    assert.equal(harness.restricted.filter((item) => item.id === submitted.qa && item.active).length, 1);
    assert.deepEqual(harness.relay.labelsFor(submitted.qa), []);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(harness.land.ownedChildren(), [], "controller A cannot retain after dispose returns");
    assert.equal(harness.created.length, 1, "controller A cannot create after dispose returns");

    const landB = createLand({
      ctx: harness.ctx,
      store: harness.store,
      settings: harness.settings,
      agents: harness.agents,
      complete: async () => "review",
    });
    const syncLive = () => harness.agents.list()
      .filter((agent) => pluginModule.internals.syncLiveLandChild(landB, agent)).length;
    assert.equal(syncLive(), 1, "controller B resumes the one live QA successor");
    assert.equal(syncLive(), 1, "repeat live sync reuses that exact owner");
    assert.deepEqual(landB.ownedChildren(), [submitted.qa]);
    const resumedQa = landB.bySession(submitted.qa);
    assert.deepEqual({
      run: resumedQa.id,
      ref: resumedQa.ref,
      baseRef: resumedQa.baseRef,
      session: qa.child.session.id,
      landRun: qa.child.session.header.landRun,
      role: qa.child.session.header.landWorkflowRole,
    }, qaIdentity);
    assert.deepEqual(qa.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
    assertMiniReviewMounted(qa);
    assert.equal(harness.restricted.filter((item) => item.id === submitted.qa && item.active).length, 1);
    assert.deepEqual(harness.relay.labelsFor(submitted.qa), [
      "workflows:land-role/qa-look-1",
      `workflows:land-run/${adopted.run}`,
    ]);

    const qaResult = await executeQaTool(landB, qa, {
      verdict: "fail",
      summary: "fixed-point successor resumed",
      feedback: "continue exactly once in the resumed controller",
      tests_modified: true,
    }, { duplicateResults: 1 });
    assert.equal(qaResult.status, "ok");
    const fixing = landB.run(adopted.run);
    assert.equal(fixing.status, "waiting_fix");
    assert.ok(fixing.implementerSession);
    assert.equal(harness.created.length, 2, "the resumed QA submits and starts one fixer");
    assert.deepEqual(landB.ownedChildren(), [fixing.implementerSession]);
    await landB.dispose();
  }

  // ---------------------------------------------------------------- HMR seeds a retained pending successor before promotion
  {
    const repo = initRepo({ branch: "feat/hmr-unseeded-pending-successor" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const planned = 1;\n", "preplan QA packet");
    let harness;
    let stopAfterRetain = false;
    let disposingA;
    const disposeStarted = Promise.withResolvers();
    harness = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
      onHang({ id }) {
        if (!stopAfterRetain || id === implementerId) return;
        stopAfterRetain = false;
        queueMicrotask(() => {
          disposingA = harness.land.dispose();
          disposeStarted.resolve();
        });
      },
    });
    const registered = [];
    const listeners = [];
    const implementer = childAgent({
      id: implementerId,
      cwd: repo.worktree,
      registered,
      restricted: harness.restricted,
      listeners,
    });
    const implementerRecord = { child: implementer, registered, listeners, live: true };
    harness.children.set(implementerId, implementerRecord);
    const adopted = await harness.land.adoptImplementer(implementer, {
      handle: {
        agent: implementer,
        async dispose() {
          if (!implementerRecord.live) return;
          implementerRecord.live = false;
          harness.disposed.push(implementerId);
        },
      },
      packet: "recover a successor that never received its packet",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    assert.equal(adopted.status, "ok");

    stopAfterRetain = true;
    const submitted = await harness.land.done({ agent: implementer, ref: "HEAD" });
    assert.equal(submitted.status, "ok");
    assert.equal(submitted.mark, "review");
    await disposeStarted.promise;
    await disposingA;

    const pendingState = harness.store.load(adopted.run);
    const pending = pendingState.pendingPhase;
    assert.equal(pendingState.transitioning, true);
    assert.equal(pendingState.current.sessionUuid, implementerId);
    assert.equal(pending.role, "qa-look-1");
    assert.equal(pending.phaseEpoch, 2);
    assert.match(pending.messageId, /^[0-9a-f-]{36}$/);
    assert.match(pending.message, /^Please review this change:/);
    assert.match(pending.message, /<diff>[\s\S]*<\/diff>/);
    assert.match(pending.message, /submit_review/);
    assert.equal(pending.messageDelivered, false);
    assert.equal(harness.created.length, 1);
    assert.equal(implementerRecord.live, false);
    const qa = harness.children.get(pending.sessionUuid);
    assert.ok(qa?.live);
    assert.deepEqual(qa.child.inbox.nextTurn, [], "the interrupted child genuinely has no work packet");
    assert.equal(harness.followups.length, 0, "controller A stopped before followup");
    assert.deepEqual(harness.land.ownedChildren(), []);
    assertMiniReviewMounted(qa, { owned: false });
    assert.deepEqual(harness.relay.labelsFor(pending.sessionUuid), []);

    const landB = createLand({
      ctx: harness.ctx,
      store: harness.store,
      settings: harness.settings,
      agents: harness.agents,
      complete: async () => "review",
    });
    const beforeActivation = await landB.workflowSend({
      delegationId: adopted.delegationId,
      message: "must not reach the unseeded child",
      expectedRole: "qa-look-1",
      expectedEpoch: 2,
      parentSessionUuid: architectId,
    });
    assert.equal(beforeActivation.status, "refused");
    assert.match(beforeActivation.reason, /transitioning/);
    const syncLive = () => harness.agents.list()
      .filter((agent) => pluginModule.internals.syncLiveLandChild(landB, agent)).length;
    assert.equal(syncLive(), 1, "controller B recovers the retained unseeded successor");
    assert.equal(syncLive(), 1, "repeat HMR sync does not duplicate activation");

    const recovered = harness.store.load(adopted.run);
    assert.equal(recovered.transitioning, false);
    assert.equal(recovered.pendingPhase, null);
    assert.equal(recovered.phaseEpoch, 2);
    assert.deepEqual(recovered.current, {
      sessionUuid: pending.sessionUuid,
      role: "qa-look-1",
      phaseEpoch: 2,
    });
    assert.equal(recovered.qaSession, pending.sessionUuid);
    assert.equal(harness.followups.length, 1);
    assert.equal(harness.followups[0].message.id, pending.messageId);
    assert.equal(qa.child.inbox.nextTurn.length, 1);
    assert.equal(qa.child.inbox.nextTurn[0].id, pending.messageId);
    assert.equal(qa.child.inbox.nextTurn[0].content[0].text, pending.message);
    assert.deepEqual(landB.ownedChildren(), [pending.sessionUuid]);
    assert.deepEqual(qa.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
    assertMiniReviewMounted(qa);
    assert.equal(harness.restricted.filter((item) => item.id === pending.sessionUuid && item.active).length, 1);
    assert.deepEqual(harness.relay.labelsFor(pending.sessionUuid), [
      "workflows:land-role/qa-look-1",
      `workflows:land-run/${adopted.run}`,
    ]);
    const routed = await landB.workflowSend({
      delegationId: adopted.delegationId,
      message: "continue on the recovered QA owner",
      expectedRole: "qa-look-1",
      expectedEpoch: 2,
      parentSessionUuid: architectId,
    });
    assert.equal(routed.status, "sent");
    assert.equal(routed.sessionUuid, pending.sessionUuid);
    await landB.dispose();
  }

  // ---------------------------------------------------------------- restart recovers a durable pending phase with no live child
  {
    const repo = initRepo({ branch: "feat/restart-missing-pending-child" });
    const ref = commitFile(repo.worktree, "core/src/session.mjs", "export const recovered = 1;\n", "recover missing QA child");
    const store = createLandStore(mkdtempSync(join(scratch, "runs-restart-gap-")));
    const intendedQa = sessionId("0000000000bb");
    const messageId = "63a11000-0000-4000-8000-0000000000bb";
    const message = [
      "Delegation ID (authoritative): 63a11000-0000-4000-8000-0000000000cc.",
      `Workflow phase: role qa-look-1; epoch 2; child session ${intendedQa}.`,
      "Recover this exact persisted QA packet once.",
    ].join(" ");
    const planned = store.create({
      id: "land-restart-gap",
      delegationId: "63a11000-0000-4000-8000-0000000000cc",
      parentSessionUuid: architectId,
      architectSession: architectId,
      status: "reviewing",
      look: 1,
      phaseEpoch: 1,
      current: { sessionUuid: implementerId, role: "implementer", phaseEpoch: 1 },
      transitioning: true,
      pendingPhase: {
        sessionUuid: intendedQa,
        role: "qa-look-1",
        phaseEpoch: 2,
        messageId,
        message,
        messageDelivered: false,
      },
      implementerSession: implementerId,
      originalImplementerSession: implementerId,
      qaSession: "",
      worktree: repo.worktree,
      mainRoot: repo.main,
      branch: repo.branch,
      baseBranch: "main",
      baseRef: repo.baseRef,
      ref,
      brief: "recover a pending successor after process loss",
      packet: packet("recover pending child", ["core/src/session.mjs"]),
      settlementSession: implementerId,
      settlementCallId: "crashed-start-qa-result",
      settlementTransition: "start_qa",
    });
    assert.equal(planned.pendingPhase.sessionUuid, intendedQa);

    const harness = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
      store,
    });
    assert.equal(harness.agents.get(intendedQa), undefined, "the crashed process left no intended live endpoint");
    assert.deepEqual(harness.land.ownedChildren(), []);

    await Promise.all([
      harness.land.recoverPendingPhases(),
      harness.land.recoverPendingPhases(),
    ]);
    assert.equal(harness.created.length, 1, "serialized recovery creates the intended endpoint once");
    assert.equal(harness.created[0].sessionId, intendedQa, "recovery uses the durable fixed UUID");
    assert.equal(harness.agents.list().filter((agent) => agent.session?.id === intendedQa).length, 1);
    const qa = harness.children.get(intendedQa);
    assert.ok(qa?.live);
    assert.equal(harness.followups.length, 1, "the persisted packet is inserted once");
    assert.equal(qa.child.inbox.nextTurn.length, 1);
    assert.equal(qa.child.inbox.nextTurn[0].id, messageId);
    assert.equal(qa.child.inbox.nextTurn[0].content[0].text, message);

    const recovered = store.load(planned.id);
    assert.equal(recovered.transitioning, false);
    assert.equal(recovered.pendingPhase, null);
    assert.equal(recovered.phaseEpoch, 2);
    assert.deepEqual(recovered.current, {
      sessionUuid: intendedQa,
      role: "qa-look-1",
      phaseEpoch: 2,
    });
    assert.equal(recovered.qaSession, intendedQa);
    assert.equal(recovered.settlementSession, "");
    assert.equal(recovered.settlementCallId, "");
    assert.equal(recovered.settlementTransition, "");
    assert.deepEqual(harness.land.ownedChildren(), [intendedQa]);
    assert.deepEqual(qa.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
    assertMiniReviewMounted(qa);
    assert.equal(harness.restricted.filter((item) => item.id === intendedQa && item.active).length, 1);
    assert.deepEqual(harness.relay.labelsFor(intendedQa), [
      "workflows:land-role/qa-look-1",
      `workflows:land-run/${planned.id}`,
    ]);

    await harness.land.recoverPendingPhases();
    assert.equal(harness.created.length, 1, "repeat recovery cannot create a second endpoint");
    assert.equal(harness.followups.length, 1, "repeat recovery cannot insert the packet twice");
    assert.deepEqual(store.load(planned.id), recovered, "repeat recovery cannot promote a second time");

    await harness.land.dispose();
    assert.deepEqual(harness.land.ownedChildren(), []);
    assert.ok(qa.live, "controller disposal preserves the recovered endpoint for HMR");
    assertMiniReviewMounted(qa, { owned: false });
    assert.deepEqual(harness.relay.labelsFor(intendedQa), []);
    const workflowHandle = Symbol.for("@hypermemetic-ai/qq-workflows/child-agent-handle");
    const coreHandle = Symbol.for("@hypermemetic-ai/qq/agent-handle");
    assert.ok(qa.child[coreHandle], "the host retains its restart-adoptable AgentHandle");
    delete qa.child[workflowHandle];
    assert.equal(qa.child[workflowHandle], undefined, "reapply cannot rely on the old controller marker");

    const landB = createLand({
      ctx: harness.ctx,
      store,
      settings: harness.settings,
      agents: harness.agents,
      complete: async () => "review",
    });
    const syncLive = () => harness.agents.list()
      .filter((agent) => pluginModule.internals.syncLiveLandChild(landB, agent)).length;
    assert.equal(syncLive(), 1, "reapply resumes the one recovered endpoint");
    assert.equal(syncLive(), 1, "repeat reapply sync reuses the same owner");
    await landB.recoverPendingPhases();
    assert.equal(harness.created.length, 1);
    assert.equal(harness.followups.length, 1);
    assert.equal(harness.agents.list().filter((agent) => agent.session?.id === intendedQa).length, 1);
    assert.deepEqual(landB.ownedChildren(), [intendedQa]);
    assert.deepEqual(qa.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
    assertMiniReviewMounted(qa);
    assert.equal(harness.restricted.filter((item) => item.id === intendedQa && item.active).length, 1);
    assert.deepEqual(harness.relay.labelsFor(intendedQa), [
      "workflows:land-role/qa-look-1",
      `workflows:land-run/${planned.id}`,
    ]);
    await landB.dispose();
  }

  // ---------------------------------------------------------------- HMR dedupes insertion after delivery-before-marker crash
  {
    const repo = initRepo({ branch: "feat/hmr-pending-packet-marker" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const inserted = 1;\n", "insert QA packet");
    let harness;
    let stopAfterInsertion = false;
    let disposingA;
    harness = createHarness({
      complete: async () => "review",
      worktree: repo.worktree,
      onChildFollowup() {
        if (!stopAfterInsertion) return;
        stopAfterInsertion = false;
        disposingA = harness.land.dispose();
      },
    });
    const registered = [];
    const listeners = [];
    const implementer = childAgent({
      id: implementerId,
      cwd: repo.worktree,
      registered,
      restricted: harness.restricted,
      listeners,
    });
    const implementerRecord = { child: implementer, registered, listeners, live: true };
    harness.children.set(implementerId, implementerRecord);
    const adopted = await harness.land.adoptImplementer(implementer, {
      handle: {
        agent: implementer,
        async dispose() { implementerRecord.live = false; },
      },
      packet: "dedupe a packet inserted immediately before controller loss",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    assert.equal(adopted.status, "ok");

    stopAfterInsertion = true;
    const submitted = await harness.land.done({ agent: implementer, ref: "HEAD" });
    assert.equal(submitted.status, "ok");
    await disposingA;

    const pendingState = harness.store.load(adopted.run);
    const pending = pendingState.pendingPhase;
    assert.equal(pendingState.transitioning, true);
    assert.equal(pending.messageDelivered, false, "controller stopped before the durable delivery marker");
    const qa = harness.children.get(pending.sessionUuid);
    assert.ok(qa?.live);
    assert.equal(harness.followups.length, 1);
    assert.equal(qa.child.inbox.nextTurn.length, 1);
    assert.equal(qa.child.inbox.nextTurn[0].id, pending.messageId);
    assert.deepEqual(harness.land.ownedChildren(), []);

    const landB = createLand({
      ctx: harness.ctx,
      store: harness.store,
      settings: harness.settings,
      agents: harness.agents,
      complete: async () => "review",
    });
    assert.equal(pluginModule.internals.syncLiveLandChild(landB, qa.child), true);
    const recovered = harness.store.load(adopted.run);
    assert.equal(recovered.pendingPhase, null);
    assert.deepEqual(recovered.current, {
      sessionUuid: pending.sessionUuid,
      role: "qa-look-1",
      phaseEpoch: 2,
    });
    assert.equal(harness.followups.length, 1, "recovery observes the stable ID and does not insert twice");
    assert.equal(qa.child.inbox.nextTurn.length, 1);
    assert.equal(qa.child.inbox.nextTurn[0].id, pending.messageId);
    assert.deepEqual(qa.registered.map((tool) => tool.name), MINI_REVIEW_TOOL_NAMES);
    await landB.dispose();
  }

  // ---------------------------------------------------------------- real external agent disposal remains terminal and reports
  {
    const repo = initRepo({ branch: "feat/external-disposal" });
    commitFile(repo.worktree, "core/src/session.mjs", "export const cancelled = 1;\n", "external disposal");
    const harness = createHarness({ complete: async () => "review", worktree: repo.worktree });
    const registered = [];
    const listeners = [];
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered, listeners });
    const record = { child: implementer, registered, listeners, live: true };
    harness.children.set(implementerId, record);
    let handleDisposals = 0;
    const adopted = await harness.land.adoptImplementer(implementer, {
      handle: { agent: implementer, async dispose() { handleDisposals++; } },
      packet: "report real child cancellation",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    record.live = false; // agent/disposed means the external owner already closed it
    assert.equal(await harness.land.releaseChild(implementer), true);
    const blocked = harness.land.run(adopted.run);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.blockedReason, /implementer child closed before completion/);
    assert.equal(handleDisposals, 0, "releaseChild must not redispose an externally closed handle");
    assert.deepEqual(harness.land.ownedChildren(), []);
    assert.deepEqual(registered, []);
    assert.deepEqual(listeners, []);
    assert.deepEqual(harness.relay.labelsFor(implementerId), []);
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].delivery, "direct");
    assert.match(harness.sent[0].message, /Blocked/);
    assert.match(harness.sent[0].message, /implementer child closed before completion/);
  }

  // ---------------------------------------------------------------- land merge failure packets architect and keeps the worktree
  {
    const repo = initRepo({ branch: "feat/blocked-land" });
    commitFile(repo.worktree, "qq-ui/assets/console.css", "body{color:red}\n", "paint css");
    writeFileSync(join(repo.main, "DIRTY"), "uncommitted\n");
    const archived = [];
    const { land, sent } = createHarness({
      complete: async () => "land",
      worktree: repo.worktree,
      tasks: { archive(id) { archived.push(id); return id; } },
    });
    const implementer = childAgent({ id: implementerId, cwd: repo.worktree, registered: [] });
    await land.adoptImplementer(implementer, {
      packet: "tweak the css color on the empty state",
      taskId: "280",
      parentSession: architectId,
      cwd: repo.worktree,
    });
    const result = await land.done({ agent: implementer, ref: "HEAD" });
    assert.equal(result.status, "ok");
    assert.equal(result.mark, "fail");
    assert.match(result.outcome, /Blocked/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, architectId);
    assert.match(sent[0].message, /Blocked/);
    assert.equal(existsSync(repo.worktree), true);
    assert.deepEqual(archived, []);
  }

  // ---------------------------------------------------------------- valid architect delegation isolates and completes its Land Mini
  {
    const repo = initRepo({ branch: "feat/invoke" });
    const registered = [];
    const childListeners = [];
    const reports = [];
    const relay = {
      hang() {},
      clear() {},
      alias: () => "1",
      async send(payload) { reports.push(payload); return { status: "sent" }; },
    };
    const store = createLandStore(mkdtempSync(join(scratch, "invoke-land-")));
    const land = createLand({
      ctx: { get: (name) => name === "qq-relay" ? relay : null },
      store,
      complete: async () => "land",
      tasks: { archive: async (id) => id },
    });
    const created = [];
    let child;
    let childDisposals = 0;
    let consumed = false;
    const architect = createArchitect({
      ctx: { get: (name) => name === "qq-relay" ? relay : null },
      cases: {
        open() {},
        ensure() {},
        load() { return { text: "# Implement\n\nChange the branch, then call done.\n" }; },
        taskId() { return "230"; },
        consume() { consumed = true; return "230"; },
      },
      folder: { pending: () => undefined, decide: () => ({ action: "keep" }) },
      agents: {
        create: async (options) => {
          created.push(options);
          child = childAgent({
            id: options.sessionId,
            cwd: options.meta.cwd,
            registered,
            listeners: childListeners,
          });
          Object.assign(child.session.header, options.meta);
          return {
            agent: child,
            async dispose() { childDisposals++; },
          };
        },
      },
      onInvokeChild: (next, info) => land.adoptImplementer(next, info),
    });
    const parent = {
      session: { id: architectId, events: [], header: { cwd: repo.main } },
      ctx: { on() { return () => {}; } },
    };
    architect.attach(parent);
    const delegated = await architect.delegate({ agent: parent });
    assert.equal(delegated.status, "ok");
    assert.equal(created.length, 1);
    assert.notEqual(created[0].meta.cwd, repo.main);
    assert.notEqual(created[0].meta.cwd, repo.worktree);
    assert.equal(git(created[0].meta.cwd, ["rev-parse", "--show-toplevel"]), created[0].meta.cwd);
    assert.deepEqual(registered, [], "Mini completion is hidden behind its bash sentinel");
    assert.equal(consumed, true);
    const adopted = land.bySession(created[0].sessionId);
    assert.equal(adopted.architectSession, architectId);
    assert.equal(adopted.taskId, "230");
    assert.equal(adopted.worktree, created[0].meta.cwd);
    assert.equal(adopted.implementerSession, created[0].sessionId);
    assert.equal(
      adopted.brief,
      `Delegation ID (authoritative): ${adopted.delegationId}.\nAuthoritative parent session UUID: ${architectId}. Alias 1 is informational and ephemeral; never use it as relay identity. Workflow completion is returned automatically; do not manually relay a duplicate report.\n\n# Implement\n\nChange the branch, then call done.`,
    );

    const wrapped = wrapMiniBash({ name: "bash", async execute() { assert.fail("sentinel must not reach bash"); } });
    const callId = "isolated-delegate-completion";
    let concluded = 0;
    const completion = await wrapped.execute({ command: MINI_SWE_COMPLETION_COMMAND }, {
      agent: child,
      callId,
      concludeTurn() {
        concluded++;
        child.status = "idle";
        for (const listener of [...childListeners].filter((item) => item.type === "agent/status")) {
          listener.fn({ status: "idle" });
        }
      },
    });
    assert.equal(completion.exitCode, 0);
    assert.equal(concluded, 1);
    let landed = land.run(adopted.id);
    assert.equal(landed.status, "landed");
    assert.equal(landed.settlementSession, child.session.id);
    assert.equal(landed.settlementCallId, callId);
    assert.equal(landed.settlementTransition, "dispose");
    assert.equal(existsSync(adopted.worktree), false, "successful completion cleans the isolated worktree");
    assert.equal(reports.length, 1);
    assert.match(reports[0].message, /Landed on main/);

    const resultEvent = {
      type: "tool/result",
      data: { message: {
        source: { kind: "tool", callId },
        content: [{ type: "tool-result", toolCallId: callId, isError: false }],
      } },
    };
    child.session.events.push(resultEvent);
    for (const listener of [...childListeners].filter((item) => item.type === "session/event")) {
      await listener.fn(child.session, resultEvent);
    }
    await land.whenSettled(child.session.id);
    landed = land.run(adopted.id);
    assert.equal(landed.status, "landed");
    assert.equal(landed.settlementSession, "");
    assert.equal(childDisposals, 1);
    assert.deepEqual(land.ownedChildren(), []);
  }

  // ---------------------------------------------------------------- plugin: land is an internal chair service with hang/label
  {
    const dir = join(scratch, "plugin-land");
    const selectedDir = join(scratch, "plugin-land-selected");
    const hung = [];
    const commands = [];
    const fakeAgent = {
      id: architectId,
      session: { id: architectId, events: [], header: {} },
      ctx: { on() { return () => {}; }, get() { return undefined; } },
    };
    const provided = {};
    pluginModule.apply({
      get(name) {
        if (name === "agents") {
          return { list: () => [fakeAgent], get: () => fakeAgent };
        }
        if (name === "sessions") return {};
        if (name === "commands") {
          return { register(definition) { commands.push(definition); return () => {}; } };
        }
        if (name === "qq-relay") {
          return { hang(id, label) { hung.push({ id, label }); }, clear() {}, alias: () => "1" };
        }
        return provided[name];
      },
      provide(name, value) { provided[name] = value; },
      effect(fn) { fn(); return () => {}; },
      on() { return () => {}; },
    }, {
      indexDir: join(dir, "index"),
      selectionDir: selectedDir,
      journalDir: join(dir, "journals"),
      wikiDir: join(dir, "wiki"),
      landDir: join(dir, "land"),
      caseDir: join(dir, "cases"),
    });
    const service = provided["qq-workflows"];
    assert.ok(service.land);
    assert.equal(service.workflows.names().includes("land"), false);
    const workflowsCommand = commands.find((item) => item.name === "workflows");
    const listed = workflowsCommand.handler({ agent: fakeAgent, rawInput: "" });
    assert.doesNotMatch(listed.text, /(^|\s)land($|\s)/);
    const selected = workflowsCommand.handler({ agent: fakeAgent, rawInput: "land" });
    assert.equal(selected.kind, "error");
    service.land.attach(fakeAgent);
    assert.ok(hung.some((row) => row.id === architectId && row.label === LAND_LABEL));
    assert.ok(service.land.attached(architectId));
  }

  console.log("test-qq-land: ok");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
