#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildPacket, parseDiffHunks, renderPacket } from "../paseo-plugin/host/workflow/packet.mjs";

const diff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -10,0 +11,2 @@ export function add",
  "+return 1",
  "+return 2",
].join("\n");

const files = parseDiffHunks(diff);
assert.equal(files[0].path, "src/a.ts");
assert.equal(files[0].hunks[0].newStart, 11);
assert.equal(files[0].hunks[0].newCount, 2);
const packet = buildPacket({ baseSha: "aaa", headSha: "bbb", files: [{ ...files[0], sha: "ccc" }] });
assert.equal(packet.files[0].sha, "ccc");
assert.doesNotMatch(renderPacket(packet), /\+return 1/);
assert.match(renderPacket(packet), /@@ -10,0 \+11,2 @@/);
