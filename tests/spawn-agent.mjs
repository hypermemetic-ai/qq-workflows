#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  cliClientId,
  daemonWebSocketUrl,
  ensureDaemonProviders,
  hostToWebSocketUrl,
  reconcileWithSdk,
  spawnWithSdk,
} from "../paseo-plugin/host/spawn-agent.mjs";

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

// Test provider auto-patching in spawnWithSdk
let patchedConfig = null;
const patchedClient = {
  connect: async () => {},
  close: async () => {},
  config: {
    get: async () => ({ config: { providers: {} } }),
    patch: async (patch) => { patchedConfig = patch; return { config: patch }; },
  },
  agents: {
    create: async (opts) => ({ id: "mini-1", workspaceId: "w-mini", cwd: opts.cwd }),
  },
};
const miniResult = await spawnWithSdk({
  config: { provider: "architect-mini/grok-4.6" },
  cwd: "/tmp/mini",
}, {
  clientFactory: () => patchedClient,
});
assert.equal(miniResult.id, "mini-1");
assert.ok(patchedConfig?.providers?.["architect-mini"]);
assert.ok(patchedConfig?.providers?.["architect-teacher"]);

// Test reconcileWithSdk across multiple pages
const pageRequests = [];
const multiPageClient = {
  connect: async () => {},
  close: async () => {},
  agents: {
    list: async (opts) => {
      pageRequests.push(opts);
      if (!opts.page?.cursor) {
        return {
          entries: [
            { agent: { id: "other-1", labels: { job: "other" }, cwd: "/tmp/other", workspaceId: "w0", status: "running" } },
          ],
          pageInfo: { hasMore: true, nextCursor: "cursor-page-2" },
        };
      }
      if (opts.page?.cursor === "cursor-page-2") {
        return {
          entries: [
            { agent: { id: "matched-child", labels: { job: "target-job" }, cwd: "/tmp/matched", workspaceId: "w1", status: "idle" } },
          ],
          pageInfo: { hasMore: false, nextCursor: null },
        };
      }
      return { entries: [], pageInfo: { hasMore: false, nextCursor: null } };
    },
  },
};

const reconciled = await reconcileWithSdk("target-job", { client: multiPageClient });
assert.equal(reconciled?.id, "matched-child");
assert.equal(reconciled?.status, "idle");
assert.equal(pageRequests.length, 2);
assert.equal(pageRequests[0].page?.cursor, undefined);
assert.equal(pageRequests[1].page?.cursor, "cursor-page-2");

// Test reconcileWithSdk returns null when no matching agent exists on any page
const notFound = await reconcileWithSdk("non-existent-job", { client: multiPageClient });
assert.equal(notFound, null);

// Test reconcileWithSdk rejects on duplicate children across pages
const dupClient = {
  connect: async () => {},
  close: async () => {},
  agents: {
    list: async (opts) => {
      if (!opts.page?.cursor) {
        return {
          entries: [{ agent: { id: "dup-1", labels: { job: "dup-job" } } }],
          pageInfo: { hasMore: true, nextCursor: "p2" },
        };
      }
      return {
        entries: [{ agent: { id: "dup-2", labels: { job: "dup-job" } } }],
        pageInfo: { hasMore: false, nextCursor: null },
      };
    },
  },
};
await assert.rejects(() => reconcileWithSdk("dup-job", { client: dupClient }), /Multiple children/);
