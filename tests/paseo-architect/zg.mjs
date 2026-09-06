#!/usr/bin/env node
import assert from "node:assert/strict";
import { DEFAULT_INDEX_EMBEDDING, indexWorkspace } from "../../paseo-plugin/host/zg.mjs";

const ran = [];
await indexWorkspace("/tmp/ws", {
  execFileFn: async (command, args, opts) => {
    ran.push({ command, args, opts });
    return { stdout: "Indexing complete\n", stderr: "" };
  },
});
assert.equal(ran[0].command, "zg");
assert.deepEqual(ran[0].args, ["index", "/tmp/ws", "--embedding", DEFAULT_INDEX_EMBEDDING, "--mode", "direct", "--rebuild"]);
assert.equal(ran[0].opts.timeout, 120_000);
