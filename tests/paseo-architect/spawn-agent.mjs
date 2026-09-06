#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  cliClientId,
  daemonWebSocketUrl,
  hostToWebSocketUrl,
  spawnWithSdk,
} from "../../paseo-plugin/host/spawn-agent.mjs";

assert.equal(hostToWebSocketUrl("127.0.0.1:3082"), "ws://127.0.0.1:3082/ws");
assert.equal(hostToWebSocketUrl("tcp://127.0.0.1:3082"), "ws://127.0.0.1:3082/ws");
assert.equal(hostToWebSocketUrl("ws://127.0.0.1:9/ws"), "ws://127.0.0.1:9/ws");
assert.equal(
  daemonWebSocketUrl({
    env: {},
    home: "/tmp",
    readFileFn: () => JSON.stringify({ listen: "127.0.0.1:3082" }),
  }),
  "ws://127.0.0.1:3082/ws",
);
assert.equal(
  daemonWebSocketUrl({ env: { PASEO_HOST: "127.0.0.1:1" }, readFileFn: () => { throw new Error("no"); } }),
  "ws://127.0.0.1:1/ws",
);
assert.equal(
  cliClientId({ env: {}, home: "/tmp", readFileFn: () => "cid_abc\n" }),
  "cid_abc",
);

const created = [];
const closed = [];
const result = await spawnWithSdk({
  config: { provider: "grok/grok-4.6", featureValues: { auto_accept: true } },
  cwd: "/tmp/ws",
  worktree: { mode: "branch-off", newBranch: "architect/bounded/1" },
}, {
  url: "ws://127.0.0.1:9/ws",
  clientId: "cid_test",
  waitForCwd: async (handle) => handle.cwd,
  clientFactory: (config) => {
    assert.equal(config.url, "ws://127.0.0.1:9/ws");
    assert.equal(config.clientId, "cid_test");
    return {
      connect: async () => {},
      close: async () => { closed.push(true); },
      agents: {
        create: async (options) => {
          created.push(options);
          return { id: "agent-1", workspaceId: "w1", cwd: "/tmp/wt" };
        },
      },
    };
  },
});
assert.equal(result.id, "agent-1");
assert.equal(result.cwd, "/tmp/wt");
assert.equal(closed.length, 1);
assert.equal(created[0].config.featureValues.auto_accept, true);
