#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDelegationStore, defaultDelegationDir, DELEGATION_PHASE_ROLES, DELEGATION_SCHEMA } from "../src/delegation-store.mjs";
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
    taskArtifact: {
      schema: "qq.task-artifact/v1",
      path: "/tmp/worktree/.git/qq-workflows/task.md",
      pointer: ".git/qq-workflows/task.md",
      sha256: "a".repeat(64),
      bytes: 18,
    },
    packet: {
      schema: "qq.delegation-packet/v1",
      brief: "change the product",
      files: [],
      pointers: [],
      mark: null,
    },
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
  const landingMetadata = store.save({
    ...created,
    landedRef: "b".repeat(40),
    publishedRef: "refs/heads/feat/change",
    pullRequest: "https://github.example/owner/repo/pull/77",
    localSyncStatus: "deferred",
    localSyncReason: "primary checkout has local changes; left untouched",
  });
  assert.equal(landingMetadata.localSyncStatus, "deferred");
  assert.equal(store.load(delegationId).landedRef, "b".repeat(40), "landing metadata survives durable normalization");
  assert.equal(store.load(delegationId).localSyncReason, "primary checkout has local changes; left untouched");
  assert.throws(
    () => store.create({ id: "land-not-an-id", delegationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    /authoritative UUID/,
  );

  // Restart adopts the old default directory and then atomically re-keys its
  // legacy machine file, even if the renamed directory was already created empty.
  const defaultParent = join(root, "default-path");
  const dshHome = join(defaultParent, "dsh-home");
  const legacyDir = join(defaultParent, ".qq-workflows-land");
  const currentDir = join(defaultParent, ".qq-workflows-delegations");
  assert.equal(defaultDelegationDir({ DSH_HOME: dshHome }), currentDir, "clean installs use the renamed directory");

  const legacyStore = createDelegationStore(legacyDir);
  const legacyUuid = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const legacySession = "session-44444444-4444-4444-8444-444444444444";
  legacyStore.create({
    delegationId: legacyUuid,
    parentSessionUuid: parentId,
    implementationSession: legacySession,
  });
  const legacyPath = legacyStore.fileFor("land-deadbeef");
  const legacyRaw = JSON.parse(readFileSync(legacyStore.fileFor(legacyUuid), "utf8"));
  legacyRaw.schema = "qq.land-run/v1";
  legacyRaw.id = "land-deadbeef";
  legacyRaw.implementerSession = legacyRaw.implementationSession;
  legacyRaw.originalImplementerSession = legacyRaw.originalImplementationSession;
  delete legacyRaw.implementationSession;
  delete legacyRaw.originalImplementationSession;
  legacyRaw.current.role = "implementer";
  writeFileSync(legacyStore.fileFor(legacyUuid), `${JSON.stringify(legacyRaw, null, 2)}\n`);
  renameSync(legacyStore.fileFor(legacyUuid), legacyPath);
  mkdirSync(currentDir, { recursive: true });

  assert.equal(defaultDelegationDir({ DSH_HOME: dshHome }), legacyDir);
  assert.equal(defaultDelegationDir({ DSH_HOME: dshHome }, { delegationDir: currentDir }), currentDir);
  assert.equal(defaultDelegationDir({ DSH_HOME: dshHome }, { landDir: legacyDir }), legacyDir);
  const restartedStore = createDelegationStore(defaultDelegationDir({ DSH_HOME: dshHome }));
  const migrated = restartedStore.bySession(legacySession);
  assert.equal(migrated.id, legacyUuid);
  assert.equal(migrated.current.role, "implementation");
  assert.equal(existsSync(legacyPath), false);
  assert.equal(restartedStore.load(legacyUuid).schema, DELEGATION_SCHEMA);

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
  assert.equal(terminal.brief, "", "artifact-backed terminal records drop duplicate task bodies");
  assert.equal(Object.hasOwn(terminal.packet, "brief"), false, "terminal packets drop legacy duplicate briefs");
  assert.equal(relayed.length, 1, "stopping reports through the normal completion path");
  assert.equal(relayed[0].to, parentId);
  assert.doesNotMatch(relayed[0].message, /Land run|land run/);
  assert.deepEqual(
    await land.workflowStop({ delegationId, parentSessionUuid: parentId }),
    { status: "ok", delegationId, delegationStatus: "blocked", terminal: true },
    "a blocked stop remains an idempotent child-cleanup operation",
  );

  const wrongParent = land.workflowStatus({ delegationId, parentSessionUuid: "session-33333333-3333-4333-8333-333333333333" });
  assert.equal(wrongParent.status, "refused");
  assert.match(wrongParent.reason, /different parent/);

  const tools = buildArchitectTools({
    delegate: async () => ({ status: "ok" }),
    workflowStatus: () => ({ status: "ok" }),
    workflowSend: async () => ({ status: "sent" }),
    workflowResume: async () => ({ status: "already-live" }),
    workflowStop: async () => ({ status: "ok" }),
  });
  assert.deepEqual(tools.map(({ name }) => name), ["delegate", "workflow_status", "workflow_send", "workflow_resume", "workflow_stop"]);
  assert.deepEqual(tools[0].parameters.kind.enum, ["implementation", "research"]);
  assert.equal(tools.some(({ name }) => name === "research"), false);

  assert.equal(isLandCandidate({ session: { id: parentId, header: {} } }), true);
  assert.equal(isLandCandidate({ session: { id: childId, header: { origin: "subagent", parentSession: parentId } } }), false);

  const source = readFileSync(new URL("../src/land.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /stampFromEvidence|routePacket|oneShot|startFixer|qa-look-|"fixer"/);
  assert.doesNotMatch(source, /message: `Delegation ID \(authoritative\)/, "workflow_send does not prefix model-inert routing metadata");
  assert.match(source, /packet\.mark = "review"/);
  assert.match(source, /land\(current, sessionId\)/, "chair land fallback may retry only a QA-passed delegation");

  await land.dispose();
  console.log("delegation and land: ok");
} finally {
  rmSync(root, { recursive: true, force: true });
}
