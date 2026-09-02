#!/usr/bin/env node
import assert from "node:assert/strict";

import { forceStopAgent, retireAgent } from "../src/force-stop.mjs";

const id = "session-10000000-0000-4000-8000-000000000001";
let cancelReason;
let disposeStarted = false;
let releaseDispose;
const disposeGate = new Promise((resolve) => { releaseDispose = resolve; });
const agent = {
  id,
  session: { id },
  cancel(reason) { cancelReason = reason; },
};
const entry = { id, agent, announced: true };
const store = new Map([[id, entry]]);
let detached = 0;
const concrete = {
  store,
  detachEntered(candidate) {
    assert.equal(candidate, entry);
    detached++;
    store.delete(candidate.id);
  },
};
const proxy = { [Symbol.for("cordis.original")]: concrete };
const handle = {
  async dispose() {
    disposeStarted = true;
    await disposeGate;
  },
};

const stopped = forceStopAgent({ agents: proxy, agent, handle });
assert.equal(stopped.cancelled, true);
assert.equal(stopped.detached, true);
assert.deepEqual(cancelReason, { kind: "disposed" });
assert.equal(detached, 1);
assert.equal(store.has(id), false, "live registry detaches before uncooperative disposal drains");
await Promise.resolve();
assert.equal(disposeStarted, true, "owned teardown still drains in the background");
releaseDispose();
assert.equal(await stopped.disposal, true);

// AgentHandle.dispose() drains owned work but does not unregister an idle Agent.
// Normal workflow retirement must perform both lifecycle operations without
// cancelling a child that has already reached the settlement idle boundary.
{
  const retiredId = "session-10000000-0000-4000-8000-000000000002";
  let cancelCount = 0;
  let disposeCount = 0;
  let releaseRetirement;
  const retirementGate = new Promise((resolve) => { releaseRetirement = resolve; });
  const retiredAgent = {
    id: retiredId,
    session: { id: retiredId },
    cancel() { cancelCount++; },
  };
  const retiredEntry = { id: retiredId, agent: retiredAgent, announced: true };
  const live = new Map([[retiredId, retiredAgent]]);
  const entries = new Map([[retiredId, retiredEntry]]);
  const registry = {
    store: entries,
    get(candidateId) { return live.get(candidateId) ?? null; },
    list() { return [...live.values()]; },
    detachEntered(candidate) {
      if (entries.get(candidate.id) !== candidate) return;
      entries.delete(candidate.id);
      live.delete(candidate.id);
    },
  };
  const retirement = retireAgent({
    agents: registry,
    agent: retiredAgent,
    handle: { async dispose() { disposeCount++; await retirementGate; } },
  });
  await Promise.resolve();
  assert.equal(disposeCount, 1);
  assert.equal(registry.get(retiredId), retiredAgent, "normal retirement preserves the live entry while handle disposal drains");
  releaseRetirement();
  const retired = await retirement;
  assert.equal(retired, true);
  assert.equal(disposeCount, 1);
  assert.equal(cancelCount, 0, "idle retirement does not cancel the completed turn");
  assert.equal(registry.get(retiredId), null);
  assert.equal(registry.list().includes(retiredAgent), false);
  assert.equal(entries.has(retiredId), false);
  assert.equal(
    await retireAgent({ agents: registry, agent: retiredAgent, handle: { async dispose() {} } }),
    true,
    "normal retirement is idempotent after registry detachment",
  );

  const replacement = { id: retiredId, session: { id: retiredId } };
  const replacementEntry = { id: retiredId, agent: replacement, announced: true };
  live.set(retiredId, replacement);
  entries.set(retiredId, replacementEntry);
  assert.equal(
    await retireAgent({ agents: registry, agent: retiredAgent, handle: { async dispose() {} } }),
    true,
    "an exact old-agent retry treats a same-session replacement as already retired",
  );
  assert.equal(registry.get(retiredId), replacement, "exact-object gating never detaches a replacement Agent");
  assert.equal(entries.get(retiredId), replacementEntry);
}

// A failed handle drain must not detach and discard the only recoverable live
// capability. A later HMR/stop retry can safely finish the exact teardown.
{
  const retryId = "session-10000000-0000-4000-8000-000000000003";
  const retryAgent = { id: retryId, session: { id: retryId } };
  const retryEntry = { id: retryId, agent: retryAgent, announced: true };
  const retryStore = new Map([[retryId, retryEntry]]);
  const retryLive = new Map([[retryId, retryAgent]]);
  let attempts = 0;
  const retryRegistry = {
    store: retryStore,
    get(candidateId) { return retryLive.get(candidateId) ?? null; },
    list() { return [...retryLive.values()]; },
    detachEntered(candidate) {
      if (retryStore.get(candidate.id) !== candidate) return;
      retryStore.delete(candidate.id);
      retryLive.delete(candidate.id);
    },
  };
  const retryHandle = {
    async dispose() {
      attempts++;
      if (attempts === 1) throw new Error("transient drain failure");
    },
  };
  await assert.rejects(
    retireAgent({ agents: retryRegistry, agent: retryAgent, handle: retryHandle }),
    /transient drain failure/,
  );
  assert.equal(retryRegistry.get(retryId), retryAgent, "failed disposal keeps the exact live session recoverable");
  assert.equal(retryStore.get(retryId), retryEntry);
  assert.equal(await retireAgent({ agents: retryRegistry, agent: retryAgent, handle: retryHandle }), true);
  assert.equal(attempts, 2);
  assert.equal(retryRegistry.get(retryId), null);
}

console.log("force stop: ok");
