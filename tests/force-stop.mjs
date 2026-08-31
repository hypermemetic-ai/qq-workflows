#!/usr/bin/env node
import assert from "node:assert/strict";

import { forceStopAgent } from "../src/force-stop.mjs";

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

console.log("force stop: ok");
