#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  implementerBranchName,
  parseWorkspaceJson,
} from "../../paseo-plugin/host/worktree.mjs";

assert.equal(implementerBranchName("bounded", "abcdef12-xxxx"), "architect/bounded/abcdef12");
assert.deepEqual(
  parseWorkspaceJson('ok\n{"workspaceId":"w1","cwd":"/tmp/wt"}\n'),
  { cwd: "/tmp/wt", workspaceId: "w1" },
);
assert.throws(() => parseWorkspaceJson("{}"), /missing cwd/);
