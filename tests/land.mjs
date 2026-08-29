#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDelegationStore, DELEGATION_PHASE_ROLES, DELEGATION_SCHEMA } from "../src/delegation-store.mjs";
import { createLand, isLandCandidate } from "../src/land.mjs";
import { buildArchitectTools } from "../src/tools.mjs";
import { MINI_KIND } from "../src/official-mini.mjs";
import { MINI_QA_KIND } from "../src/mini-qa.mjs";

const parentId = "session-11111111-1111-4111-8111-111111111111";
const childId = "session-22222222-2222-4222-8222-222222222222";
const delegationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const root = mkdtempSync(join(tmpdir(), "qq-delegation-land."));

try {
  assert.deepEqual(DELEGATION_PHASE_ROLES, ["implementation", "qa"]);
  assert.equal(MINI_KIND, "mini-code");
  assert.equal(MINI_QA_KIND, "mini-qa");

  const store = createDelegationStore(root);
  const created = store.create({
    delegationId,
    parentSessionUuid: parentId,
    architectSession: parentId,
    implementationSession: childId,
    originalImplementationSession: childId,
    brief: "change the product",
    worktree: "/tmp/worktree",
    mainRoot: "/tmp/main",
    branch: "feat/change",
    baseBranch: "main",
    baseRef: "a".repeat(40),
  });
  assert.equal(created.schema, DELEGATION_SCHEMA);
  assert.equal(created.id, delegationId, "the delegation UUID is the only durable machine id");
  assert.equal(created.delegationId, delegationId);
  assert.deepEqual(created.current, { sessionUuid: childId, role: "implementation", phaseEpoch: 1 });
  assert.equal(store.byDelegation(delegationId).id, delegationId);
  assert.throws(
    () => store.create({ id: "land-not-an-id", delegationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    /authoritative UUID/,
  );

  // A legacy machine-keyed file is atomically re-keyed to its generated UUID.
  const legacyUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const legacySession = "session-44444444-4444-4444-8444-444444444444";
  const legacyCurrent = store.create({
    delegationId: legacyUuid,
    parentSessionUuid: parentId,
    implementationSession: legacySession,
  });
  const legacyPath = store.fileFor("land-deadbeef");
  const legacyRaw = JSON.parse(readFileSync(store.fileFor(legacyUuid), "utf8"));
  legacyRaw.schema = "qq.land-run/v1";
  legacyRaw.id = "land-deadbeef";
  legacyRaw.implementerSession = legacyRaw.implementationSession;
  legacyRaw.originalImplementerSession = legacyRaw.originalImplementationSession;
  delete legacyRaw.implementationSession;
  delete legacyRaw.originalImplementationSession;
  legacyRaw.current.role = "implementer";
  writeFileSync(store.fileFor(legacyUuid), `${JSON.stringify(legacyRaw, null, 2)}\n`);
  renameSync(store.fileFor(legacyUuid), legacyPath);
  const migrated = store.load("land-deadbeef");
  assert.equal(migrated.id, legacyUuid);
  assert.equal(migrated.current.role, "implementation");
  assert.equal(existsSync(legacyPath), false);
  assert.equal(store.load(legacyUuid).schema, DELEGATION_SCHEMA);

  const relayed = [];
  const agentsById = new Map();
  const ctx = {
    get(name) {
      if (name === "qq-relay") return {
        async send(message) { relayed.push(message); return { status: "sent" }; },
        alias(id) { return id === childId ? "ephemeral" : undefined; },
      };
      return null;
    },
    logger: { info() {}, warn() {} },
  };
  const land = createLand({
    ctx,
    store,
    agents: { get: (id) => agentsById.get(id), list: () => [...agentsById.values()] },
  });
  const status = land.workflowStatus({ delegationId, parentSessionUuid: parentId });
  assert.equal(status.status, "ok");
  assert.equal(status.kind, "implementation");
  assert.equal(status.delegationStatus, "running");
  assert.equal(status.role, "implementation");
  assert.equal(status.recordId, undefined);

  const stopped = await land.workflowStop({ delegationId, parentSessionUuid: parentId, reason: "operator cancelled" });
  assert.deepEqual(stopped, { status: "ok", delegationId, delegationStatus: "blocked", terminal: true });
  const terminal = store.load(delegationId);
  assert.equal(terminal.status, "blocked");
  assert.equal(terminal.blockedReason, "operator cancelled");
  assert.equal(terminal.current, null);
  assert.equal(relayed.length, 1, "stopping reports through the normal completion path");
  assert.equal(relayed[0].to, parentId);
  assert.doesNotMatch(relayed[0].message, /Land run|land run/);

  const wrongParent = land.workflowStatus({ delegationId, parentSessionUuid: "session-33333333-3333-4333-8333-333333333333" });
  assert.equal(wrongParent.status, "refused");
  assert.match(wrongParent.reason, /different parent/);

  const tools = buildArchitectTools({
    delegate: async () => ({ status: "ok" }),
    workflowStatus: () => ({ status: "ok" }),
    workflowSend: async () => ({ status: "sent" }),
    workflowStop: async () => ({ status: "ok" }),
  });
  assert.deepEqual(tools.map(({ name }) => name), ["delegate", "workflow_status", "workflow_send", "workflow_stop"]);
  assert.deepEqual(tools[0].parameters.kind.enum, ["implementation", "research", "docs"]);
  assert.equal(tools.some(({ name }) => name === "research"), false);

  assert.equal(isLandCandidate({ session: { id: parentId, header: {} } }), true);
  assert.equal(isLandCandidate({ session: { id: childId, header: { origin: "subagent", parentSession: parentId } } }), false);

  const source = readFileSync(new URL("../src/land.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /stampFromEvidence|routePacket|oneShot|startFixer|qa-look-|"fixer"/);
  assert.match(source, /packet\.mark = "review"/);
  assert.match(source, /land\(current, sessionId\)/, "chair land fallback may retry only a QA-passed delegation");

  await land.dispose();
  console.log("delegation and land: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
