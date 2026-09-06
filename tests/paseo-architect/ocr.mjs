#!/usr/bin/env node
import assert from "node:assert/strict";
import { mapOcrJson, runOcrReview } from "../../paseo-plugin/host/ocr.mjs";

assert.deepEqual(mapOcrJson({ comments: [] }), []);
assert.deepEqual(
  mapOcrJson({
    comments: [{ path: "src/a.ts", start_line: 3, content: "off-by-one" }],
  }),
  [{ path: "src/a.ts", line: 3, body: "off-by-one" }],
);
assert.deepEqual(
  mapOcrJson({
    comments: [{ file_path: "src/a.ts", start_line: 4, content: "null deref" }],
  }),
  [{ path: "src/a.ts", line: 4, body: "null deref" }],
);
assert.throws(() => mapOcrJson({}), /comments array/);
assert.throws(() => mapOcrJson({ summary: "ok" }), /comments array/);

const ran = [];
const findings = await runOcrReview("/repo", {
  from: "abc",
  to: "HEAD",
  env: { OCR_LLM_TOKEN: "tok" },
  execFileFn: async (command, args, opts) => {
    ran.push({ command, args, opts });
    return {
      stdout: JSON.stringify({
        comments: [{ path: "src/a.ts", start_line: 3, content: "off-by-one" }],
      }),
    };
  },
});
assert.deepEqual(findings, [{ path: "src/a.ts", line: 3, body: "off-by-one" }]);
assert.equal(ran[0].command, "ocr");
assert.deepEqual(ran[0].args, [
  "review",
  "--audience", "agent",
  "--format", "json",
  "--effort", "high",
  "--from", "abc",
  "--to", "HEAD",
  "--repo", "/repo",
]);
assert.equal(ran[0].opts.env.OCR_LLM_MODEL, "grok-4.6");
assert.equal(ran[0].opts.env.OCR_LLM_URL, "https://api.x.ai");
