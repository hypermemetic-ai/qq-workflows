#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  CHILD_WORKFLOW_SEND_TOOL_NAME,
  bindChildWorkflowSend,
  buildChildWorkflowSendTool,
  installChildWorkflowSend,
} from "../src/child-workflow-send.mjs";

const SESSION = "session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ctx = Object.preventExtensions({});
const session = Object.preventExtensions({ id: SESSION });
const agent = Object.preventExtensions({ session, ctx });
const foreign = { session: { id: SESSION }, ctx };

const unboundTool = buildChildWorkflowSendTool();
assert.equal(unboundTool.name, CHILD_WORKFLOW_SEND_TOOL_NAME);
assert.deepEqual(Object.keys(unboundTool.parameters), ["message"]);
assert.equal(unboundTool.output.schema.additionalProperties, false);
for (const forbidden of ["to", "fromId", "delegationId", "sessionUuid", "role", "epoch", "delivery", "alias"]) {
  assert.equal(forbidden in unboundTool.parameters, false, `${forbidden} is not model-visible`);
  assert.equal(forbidden in unboundTool.output.schema.properties, false, `${forbidden} is not returned`);
}
assert.match((await unboundTool.execute({ message: "hello" }, { agent })).reason, /unowned or stale/);
assert.match((await unboundTool.execute({ message: " " }, { agent })).reason, /non-empty/);
assert.match((await unboundTool.execute({ message: "hello", delegationId: "route" }, { agent })).reason, /accepts only message/);

const calls = [];
const firstDispose = bindChildWorkflowSend(agent, {
  async send(request) {
    calls.push(["first", request]);
    return {
      status: "sent",
      message_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      to: "session-private-parent",
      to_alias: "private-alias",
      delegationId: "private-delegation",
      sessionUuid: SESSION,
      role: "qa",
      phaseEpoch: 7,
      delivery: "default",
    };
  },
});

// A tool from a true second module generation sees the global weak binding even
// though Agent, Session, and Context cannot receive symbol properties.
const nextGeneration = await import(`../src/child-workflow-send.mjs?hmr=${Date.now()}`);
const nextTool = nextGeneration.buildChildWorkflowSendTool();
const sent = await nextTool.execute({ message: "status update" }, { agent });
assert.deepEqual(sent, {
  status: "sent",
  message_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
});
assert.deepEqual(calls, [["first", { agent, message: "status update" }]]);
assert.match((await nextTool.execute({ message: "foreign" }, { agent: foreign })).reason, /unowned or stale/);

// Replacement is visible to old and new tool generations. A delayed old
// disposer cannot erase it.
const secondDispose = nextGeneration.bindChildWorkflowSend(agent, {
  async send(request) {
    calls.push(["second", request]);
    return { status: "sent", message_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" };
  },
});
firstDispose();
assert.deepEqual(await unboundTool.execute({ message: "replacement" }, { agent }), {
  status: "sent",
  message_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
});
assert.equal(calls.at(-1)[0], "second");
secondDispose();
assert.match((await nextTool.execute({ message: "after disposal" }, { agent })).reason, /unowned or stale/);

const controllerRefusalOff = bindChildWorkflowSend(agent, {
  async send() { return { status: "refused", reason: "durable phase changed" }; },
});
assert.deepEqual(await nextTool.execute({ message: "late" }, { agent }), {
  status: "refused",
  reason: "durable phase changed",
});
controllerRefusalOff();

const installed = [];
const installCtx = {
  tools: {
    register(tool) {
      installed.push(tool);
      return () => installed.splice(installed.indexOf(tool), 1);
    },
  },
};
const uninstall = installChildWorkflowSend(installCtx);
assert.deepEqual(installed.map(({ name }) => name), ["workflow_send"]);
uninstall();
assert.deepEqual(installed, []);

console.log("child workflow send: ok");
